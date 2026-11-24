import { listQueuedThreadMessages } from "@omnyo/db";
import { queuedMessageWaitingOnSchema } from "@omnyo/domain";
import { sendMessageResponseSchema } from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { setServerUpdateDraining } from "../../src/services/system/server-update-drain.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const input = [
  { type: "text" as const, text: "Sent during the update", mentions: [] },
];

function seedConnectedThread(
  harness: TestAppHarness,
  status: "idle" | "active",
): string {
  const { host } = seedHostSession(harness.deps, {
    id: `host-drain-${status}`,
    name: "M5",
  });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/server-update-drain-${status}`,
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status,
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: `provider-drain-${status}`,
  });

  if (status === "active") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      providerThreadId: `provider-drain-${status}`,
      threadId: thread.id,
      turnId: "turn-current",
    });
  }

  return thread.id;
}

async function send(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input,
        mode: "steer-if-active",
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    },
  );

  expect(response.status).toBe(200);

  return sendMessageResponseSchema.parse(await readJson(response));
}

describe("server update drain", () => {
  it("queues a message to an idle chat while the server update drains instead of rejecting it", async () => {
    await withTestHarness(async (harness) => {
      const threadId = seedConnectedThread(harness, "idle");
      setServerUpdateDraining(harness.db, true);

      const body = await send(harness, threadId);

      expect(body).toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "server-update" } },
      });

      const queued = listQueuedThreadMessages(harness.db, threadId);
      expect(queued).toHaveLength(1);
      expect(
        queuedMessageWaitingOnSchema.parse(JSON.parse(queued[0]!.waitingOn!)),
      ).toEqual({ kind: "server-update" });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      expect(listQueuedThreadMessages(harness.db, threadId)).toHaveLength(1);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", threadId),
      ).toEqual([]);
    });
  });

  it("still delivers a follow-up to a running chat while the server update drains", async () => {
    await withTestHarness(async (harness) => {
      const threadId = seedConnectedThread(harness, "active");
      setServerUpdateDraining(harness.db, true);

      const body = await send(harness, threadId);

      expect(body.delivery).not.toBe("queued");

      const steered = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === threadId,
      );

      expect(steered.command.type).toBe("turn.submit");
      expect(listQueuedThreadMessages(harness.db, threadId)).toEqual([]);
    });
  });

  it("dispatches messages that waited for the update once the drain ends", async () => {
    await withTestHarness(async (harness) => {
      const threadId = seedConnectedThread(harness, "idle");
      setServerUpdateDraining(harness.db, true);
      expect((await send(harness, threadId)).delivery).toBe("queued");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        listQueuedThreadCommands(harness, "turn.submit", threadId),
      ).toEqual([]);

      setServerUpdateDraining(harness.db, false);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });

      const dispatched = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === threadId,
      );

      expect(dispatched.command).toMatchObject({
        threadId,
        input,
        target: { mode: "start" },
      });
      expect(listQueuedThreadMessages(harness.db, threadId)).toEqual([]);
    });
  });
});
