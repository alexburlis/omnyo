import { getQueuedThreadMessage, getThread, listEvents } from "@omnyo/db";
import type { PromptInput } from "@omnyo/domain";
import { afterEach, expect, it, vi } from "vitest";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import { dispatchTurnDuringReprovision } from "../../src/services/threads/thread-turn-dispatch.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import { buildExecutionOptions } from "../../src/services/threads/thread-commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => vi.restoreAllMocks());

function seedReprovisionThread(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    status: "error",
    path: "/tmp/queued-reprovision",
    environmentProviderId: "personal-workspace",
    environmentProviderPluginId: "omnyo-plugin-environment-personal-workspace",
    isGitRepo: false,
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });

  return { environment, thread };
}

it("leaves reprovision unstarted when dispatch admission rejects the request", async () => {
  await withTestHarness(async (harness) => {
    const { environment, thread } = seedReprovisionThread(harness);

    const execution = await buildExecutionOptions(
      harness.deps,
      {
        model: "gpt-5",
        reasoningLevel: "medium",
        serviceTier: "default",
        permissionMode: "full",
      },
      { threadId: thread.id },
    );

    const eventsBefore = listEvents(harness.db, { threadId: thread.id });
    const notifyThread = vi.spyOn(harness.deps.hub, "notifyThread");
    const rejected = new Error("Dispatch admission rejected");
    let admissionStatus: string | undefined;

    await expect(
      dispatchTurnDuringReprovision({
        deps: harness.deps,
        environment,
        execution,
        initiator: "user",
        input: textInput("must remain undelivered"),
        senderThreadId: null,
        thread,
        beforeRequestAppendInTransaction: ({ tx }) => {
          admissionStatus = getThread(tx, thread.id)?.status;
          throw rejected;
        },
      }),
    ).rejects.toBe(rejected);

    expect(admissionStatus).toBe("idle");
    expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(readThreadProvisionContext(harness.db, thread.id)).toBeNull();
    expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
      eventsBefore,
    );
    expect(notifyThread).not.toHaveBeenCalled();
  });
});

it("publishes queue consumption after the workspace reprovision is committed", async () => {
  await withTestHarness(async (harness) => {
    const { environment, thread } = seedReprovisionThread(harness);
    const input = textInput("Run after workspace recovery");
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-queued-reprovision",
      threadId: thread.id,
    });

    const queued = seedQueuedMessage(harness.deps, {
      threadId: thread.id,
      content: input,
      waitingOn: { kind: "thread-busy" },
    });

    const snapshots: {
      inTransaction: boolean;
      provisionInput: PromptInput[] | undefined;
    }[] = [];

    const stopObserving = harness.hub.onThreadChanged((id, changes) => {
      if (
        id === thread.id &&
        changes.includes("queue-changed") &&
        getQueuedThreadMessage(harness.db, queued.id) === null
      ) {
        snapshots.push({
          inTransaction: harness.db.$client.inTransaction,
          provisionInput: readThreadProvisionContext(harness.db, id)?.request
            .input,
        });
      }
    });

    try {
      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: thread.id,
      });
      expect(snapshots).toEqual([
        { inTransaction: false, provisionInput: input },
      ]);
    } finally {
      stopObserving();
    }
  });
});
