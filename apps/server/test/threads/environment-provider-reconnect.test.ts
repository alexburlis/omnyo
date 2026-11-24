import { getThread, listEvents } from "@omnyo/db";
import { expect, it, vi } from "vitest";
import {
  advanceThreadProvisioning,
  requestThreadProvision,
} from "../../src/services/threads/thread-provisioning.js";
import {
  reportNextEnvironmentAttachSuccess,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { installFakeEnvironmentProvider } from "../helpers/environment-provider.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const WAITING_STEP = "Waiting for Mac Pro to reconnect";

function waitingSteps(db: Parameters<typeof listEvents>[0], threadId: string) {
  return listEvents(db, { threadId })
    .filter((event) => event.type === "system/thread-provisioning")
    .flatMap(
      (event) =>
        (
          JSON.parse(event.data) as {
            entries: Array<{ text: string; status?: string }>;
          }
        ).entries,
    )
    .filter((entry) => entry.text === WAITING_STEP);
}

it("waits for a disconnected machine to reconnect before creating its workspace", async () => {
  await withTestHarness(async (harness) => {
    const host = seedHost(harness.deps, {
      id: "host-provider-reconnect",
      name: "Mac Pro",
    });

    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/tmp/environment-provider-reconnect",
    });

    const provider = installFakeEnvironmentProvider({
      id: "container",
      pluginId: "sandbox",
      displayName: "Fake container",
      requires: {
        projectCheckout: false,
        gitCheckout: false,
        gitRemote: false,
        projectless: false,
      },
      decide: (context) =>
        harness.hub.getDaemonSessionIdForHost(context.host.id)
          ? {
              action: "ready",
              environment: {
                type: "host",
                hostId: host.id,
                path: "/tmp/environment-provider-reconnect",
              },
            }
          : { action: "reject", message: "Host is not connected" },
    });

    const thread = seedThread(harness.deps, {
      projectId: project.id,
      status: "starting",
    });

    requestThreadProvision(harness.deps, {
      author: { initiator: "user", senderThreadId: null },
      thread,
      environmentIntent: {
        type: "provider",
        environmentProviderId: "container",
        machine: { type: "existing", hostId: host.id },
        inputs: null,
        selectionResolved: true,
      },
      execution: {
        model: "requested-model",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
        source: "client/turn/requested",
      },
      fork: null,
      input: textInput("Released after the server restart"),
      startedOnBehalfOf: null,
      titleProvided: true,
    });
    await advanceThreadProvisioning(harness.deps, { threadId: thread.id });

    await vi.waitFor(() => {
      expect(waitingSteps(harness.db, thread.id)).toContainEqual(
        expect.objectContaining({ status: "started" }),
      );
    });
    expect(getThread(harness.db, thread.id)?.status).toBe("starting");
    expect(provider.contexts).toHaveLength(0);

    seedSession(harness.deps, host.id);
    await vi.waitFor(
      () => {
        expect(getThread(harness.db, thread.id)?.environmentId).not.toBeNull();
      },
      { timeout: 5_000 },
    );
    expect(provider.contexts).toHaveLength(1);
    expect(
      waitingSteps(harness.db, thread.id).filter(
        (entry) => entry.status === "started",
      ),
    ).toHaveLength(1);
    await reportNextEnvironmentAttachSuccess(harness, thread.id);

    const start = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.start" && command.threadId === thread.id,
    );

    expect(getThread(harness.db, thread.id)?.status).toBe("starting");
    await reportQueuedCommandError(harness, start, {
      errorCode: "test_cleanup",
      errorMessage: "test cleanup",
    });
  });
});
