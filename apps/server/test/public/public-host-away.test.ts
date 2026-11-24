import { getHost, getThread, listQueuedThreadMessages } from "@omnyo/db";
import { hostSchema } from "@omnyo/domain";
import { sendMessageResponseSchema } from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { handleHostSessionOpened } from "../../src/internal/session-owner-side-effects.js";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import {
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedConnectedThread(
  harness: TestAppHarness,
  args: { hostId: string; status: "idle" | "active" },
) {
  const host = seedHost(harness.deps, { id: args.hostId, name: "5080" });
  const session = seedSession(harness.deps, host.id);

  const socket = registerTestHostRpcCapture(harness.deps, {
    hostId: host.id,
    sessionId: session.id,
  });

  onDaemonSocketOpen(harness.deps, {
    hostId: host.id,
    sessionId: session.id,
    socket,
  });

  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${args.hostId}`,
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: args.status,
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: `provider-${args.hostId}`,
  });

  if (args.status === "active") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      providerThreadId: `provider-${args.hostId}`,
      threadId: thread.id,
      turnId: "turn-current",
    });
  }

  return { environment, host, session, thread };
}

async function setAvailability(
  harness: TestAppHarness,
  hostId: string,
  availability: "available" | "away",
) {
  const response = await harness.app.request(
    `/api/v1/hosts/${hostId}/availability`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ availability }),
    },
  );

  expect(response.status).toBe(200);

  return hostSchema.parse(await readJson(response));
}

function sendText(harness: TestAppHarness, threadId: string, text: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text, mentions: [] }],
      mode: "steer-if-active",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
    }),
  });
}

describe("machine Away mode", () => {
  it("holds new turns while Away and sends them once Available", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedConnectedThread(harness, {
        hostId: "host-away-hold",
        status: "idle",
      });

      expect(await setAvailability(harness, host.id, "away")).toMatchObject({
        availability: "away",
      });
      expect(getHost(harness.db, host.id)?.availability).toBe("away");

      const response = await sendText(harness, thread.id, "Wait for Away");
      expect(response.status).toBe(200);
      expect(
        sendMessageResponseSchema.parse(await readJson(response)),
      ).toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "host-away", hostName: "5080" } },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);

      expect(
        await setAvailability(harness, host.id, "available"),
      ).toMatchObject({ availability: "available" });

      const dispatched = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );

      expect(dispatched.command.type).toBe("turn.submit");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("stops running work and ends agent processes when set Away", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedConnectedThread(harness, {
        hostId: "host-away-stop",
        status: "active",
      });

      await setAvailability(harness, host.id, "away");

      await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.agent_processes.terminate",
      );
      expect(getThread(harness.db, thread.id)?.status).not.toBe("active");
    });
  });

  it("ends agent processes again when an Away machine reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedConnectedThread(harness, {
        hostId: "host-away-reconnect",
        status: "idle",
      });

      await setAvailability(harness, host.id, "away");
      await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.agent_processes.terminate",
      );

      const reconnected = seedSession(harness.deps, host.id);

      const socket = registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: reconnected.id,
      });

      onDaemonSocketOpen(harness.deps, {
        hostId: host.id,
        sessionId: reconnected.id,
        socket,
      });
      await handleHostSessionOpened(harness.deps, {
        activeThreads: [],
        openThreadWork: null,
        hostId: host.id,
        openedSession: reconnected,
        previousSession: session,
        undeliveredEventThreadIds: [],
      });

      await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.agent_processes.terminate",
      );
    });
  });
});
