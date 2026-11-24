import {
  getThread,
  getLatestThreadSequence,
  countThreadsWithUpdateActivity,
  isThreadQueueAutoSendPaused,
  listEvents,
  listQueuedThreadMessages,
  listThreadsWithUpdateActivity,
} from "@omnyo/db";
import {
  encodeClientTurnRequestIdNumber,
  turnRequestEventDataSchema,
  turnScope,
  type ResolvedThreadExecutionOptions,
} from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import { stopRunningWorkForAppUpdate } from "../../src/services/server-move/stop-work.js";
import {
  reserveHostUpdateDrain,
  setServerUpdateDraining,
} from "../../src/services/system/server-update-drain.js";
import {
  createThreadStartup,
  saveThreadProvisionContext,
} from "../../src/services/threads/thread-startup-store.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  reportQueuedCommandSuccess,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedQueuedMessage,
  seedStoredEvent,
  seedThreadFixture,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedRunningThread(
  harness: TestAppHarness,
  status: "active" | "idle" = "active",
) {
  const fixture = seedThreadFixture(harness, {
    thread: { status },
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: "provider-app-update-turn",
    inputText: "Refactor the parser",
    model: "gpt-5",
    permissionMode: "auto",
    reasoningLevel: "high",
    serviceTier: "default",
  });
  seedTurnStarted(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: "provider-app-update-turn",
    turnId: "app-update-turn",
  });

  return fixture;
}

async function stopAllForUpdate(harness: TestAppHarness, threadId: string) {
  const stopping = stopRunningWorkForAppUpdate(harness.deps, {
    pollMs: 10,
    shouldContinue: () => true,
    timeoutMs: 5_000,
  });

  const stop = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.stop" && command.threadId === threadId,
  );

  await reportQueuedCommandSuccess(harness, stop, {
    providerCheckpointId: null,
  });
  await stopping;
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

describe("stopping running chats for an Omnyo update", () => {
  it.each([false, true])(
    "pauses an unattached startup on its intended machine and replays its original input before queued follow-ups %s",
    async (withFollowUp) => {
      await withTestHarness(async (harness) => {
        const selected = seedThreadFixture(harness, {
          session: { id: "cli-startup-selected" },
        });

        const unrelated = seedThreadFixture(harness, {
          session: { id: "cli-startup-unrelated" },
        });

        const input = [
          {
            type: "text" as const,
            text: "The original startup request",
            mentions: [],
          },
        ];

        const execution = {
          model: "gpt-5",
          permissionMode: "auto",
          reasoningLevel: "high",
          serviceTier: "default",
          source: "client/turn/requested",
        } satisfies ResolvedThreadExecutionOptions;

        const starters = [selected, unrelated].map((fixture, index) => {
          const thread = seedThread(harness.deps, {
            projectId: fixture.project.id,
            status: "starting",
          });

          saveThreadProvisionContext({
            db: harness.db,
            replace: true,
            threadId: thread.id,
            context: createThreadStartup({
              clientRequestId: encodeClientTurnRequestIdNumber({
                value: index + 1,
              }),
              environmentIntent: {
                type: "reuse",
                environmentId: fixture.environment.id,
              },
              execution,
              fork: null,
              input,
              titleProvided: true,
              seedWithoutRun: false,
              initiator: "user",
            }),
          });

          return thread;
        });

        const selectedThread = starters[0]!;
        const unrelatedThread = starters[1]!;

        const followUp = withFollowUp
          ? seedQueuedMessage(harness.deps, {
              threadId: selectedThread.id,
              content: [
                { type: "text", text: "The queued follow-up", mentions: [] },
              ],
            })
          : null;

        const release = reserveHostUpdateDrain(harness.db, selected.host.id);

        await stopRunningWorkForAppUpdate(harness.deps, {
          hostId: selected.host.id,
          pollMs: 10,
          timeoutMs: 1_000,
          shouldContinue: () => true,
        });
        expect(getThread(harness.db, selectedThread.id)?.status).toBe("idle");
        expect(getThread(harness.db, unrelatedThread.id)?.status).toBe(
          "starting",
        );
        const queued = listQueuedThreadMessages(harness.db, selectedThread.id);
        expect(queued).toHaveLength(withFollowUp ? 2 : 1);
        expect(JSON.parse(queued[0]!.content)).toEqual(input);
        expect(queued[0]).toMatchObject({
          model: execution.model,
          permissionMode: execution.permissionMode,
          reasoningLevel: execution.reasoningLevel,
          serviceTier: execution.serviceTier,
        });

        if (followUp !== null) expect(queued.at(-1)?.id).toBe(followUp.id);

        await stopRunningWorkForAppUpdate(harness.deps, {
          hostId: selected.host.id,
          pollMs: 10,
          timeoutMs: 1_000,
          shouldContinue: () => true,
        });
        expect(
          listQueuedThreadMessages(harness.db, selectedThread.id),
        ).toHaveLength(withFollowUp ? 2 : 1);
        release();
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        expect(turnRequests(harness, selectedThread.id).at(-1)).toMatchObject({
          input,
          execution: {
            model: execution.model,
            permissionMode: execution.permissionMode,
            reasoningLevel: execution.reasoningLevel,
            serviceTier: execution.serviceTier,
          },
        });
        expect(
          listQueuedThreadMessages(harness.db, unrelatedThread.id),
        ).toEqual([]);
      });
    },
  );

  it("selects update activity only on the requested machine", async () => {
    await withTestHarness(async (harness) => {
      const selected = seedThreadFixture(harness, {
        session: { id: "cli-update-selected" },
        thread: { status: "active" },
      });

      seedThreadFixture(harness, {
        session: { id: "cli-update-unrelated" },
        thread: { status: "active" },
      });

      expect(
        listThreadsWithUpdateActivity(harness.db, {
          hostId: selected.host.id,
        }),
      ).toEqual([{ id: selected.thread.id, hostId: selected.host.id }]);
    });
  });

  it("ignores historical idle background work without an execution environment", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);

      const thread = seedThread(harness.deps, {
        projectId: fixture.project.id,
      });

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        type: "item/started",
        scope: { kind: "thread" },
        sequence: 1,
        itemId: "historical-background-task",
        itemKind: "backgroundTask",
        data: {
          item: {
            type: "backgroundTask",
            id: "historical-background-task",
            taskType: "local_agent",
            description: "Historical task",
            status: "pending",
            taskStatus: "running",
            skipTranscript: false,
          },
        },
      });
      expect(countThreadsWithUpdateActivity(harness.db)).toBe(0);
      expect(listThreadsWithUpdateActivity(harness.db)).toEqual([]);
      await stopRunningWorkForAppUpdate(harness.deps, {
        pollMs: 10,
        shouldContinue: () => true,
        timeoutMs: 1_000,
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });
  it.each(
    ["backgroundTask", "delegation", "childTurn"].flatMap((kind) =>
      ["resume", "paused", "failed"].map((outcome) => ({ kind, outcome })),
    ),
  )(
    "stops idle $kind work with $outcome outcome without duplicate resumes",
    async ({ kind, outcome }) => {
      await withTestHarness(async (harness) => {
        const { thread, environment } = seedRunningThread(harness, "idle");

        const sequence =
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1;

        if (kind === "childTurn") {
          seedStoredEvent(harness.deps, {
            threadId: thread.id,
            environmentId: environment.id,
            type: "turn/started",
            scope: turnScope("update-child-turn"),
            parentToolCallId: "update-parent-call",
            sequence,
            data: {
              providerThreadId: "provider-child",
              parentToolCallId: "update-parent-call",
            },
          });
        } else {
          seedStoredEvent(harness.deps, {
            threadId: thread.id,
            environmentId: environment.id,
            type: "item/started",
            scope:
              kind === "delegation"
                ? turnScope("app-update-turn")
                : { kind: "thread" },
            itemId: "update-background-task",
            itemKind: kind === "delegation" ? "delegation" : "backgroundTask",
            sequence,
            data: {
              providerThreadId: "provider-app-update-turn",
              item:
                kind === "delegation"
                  ? {
                      id: "update-background-task",
                      type: "delegation",
                      childRef: "provider-child",
                      label: "Update fixture",
                      status: "pending",
                      background: true,
                    }
                  : {
                      id: "update-background-task",
                      type: "backgroundTask",
                      taskType: "local_agent",
                      description: "Update fixture",
                      status: "pending",
                      taskStatus: "running",
                      skipTranscript: false,
                    },
            },
          });
        }

        if (outcome === "paused") {
          seedStoredEvent(harness.deps, {
            threadId: thread.id,
            type: "system/thread/interrupted",
            scope: { kind: "thread" },
            sequence:
              getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
            data: { reason: "manual-stop" },
          });
        }

        expect(countThreadsWithUpdateActivity(harness.db)).toBe(1);
        setServerUpdateDraining(harness.db, true);

        if (outcome === "failed") {
          const stopping = stopRunningWorkForAppUpdate(harness.deps, {
            pollMs: 10,
            shouldContinue: () => true,
            timeoutMs: 5_000,
          });

          const failed = expect(stopping).rejects.toThrow("Stop failed");

          const command = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.stop" && command.threadId === thread.id,
          );

          await reportQueuedCommandError(harness, command, {
            errorCode: "invalid_request",
            errorMessage: "Stop failed",
          });
          await failed;
          expect(countThreadsWithUpdateActivity(harness.db)).toBe(1);
          expect(
            listEvents(harness.db, { threadId: thread.id }).filter(
              (event) =>
                event.type === "item/backgroundTask/completed" ||
                event.type === "item/delegation/completed" ||
                event.type === "turn/completed",
            ),
          ).toHaveLength(0);
          expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
          setServerUpdateDraining(harness.db, false);
          await runQueuedMessageDispatch(harness.deps, {
            kind: "idle-recovery",
            now: Date.now(),
          });
          expect(turnRequests(harness, thread.id)).toHaveLength(1);

          return;
        }

        await stopAllForUpdate(harness, thread.id);
        expect(countThreadsWithUpdateActivity(harness.db)).toBe(0);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
          outcome === "paused" ? 0 : 1,
        );
        await stopRunningWorkForAppUpdate(harness.deps, {
          pollMs: 10,
          shouldContinue: () => true,
          timeoutMs: 1_000,
        });
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
          outcome === "paused" ? 0 : 1,
        );
        setServerUpdateDraining(harness.db, false);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        expect(turnRequests(harness, thread.id)).toHaveLength(
          outcome === "paused" ? 1 : 2,
        );
      });
    },
  );

  it("stops a running chat and resumes it with its own settings once new turns are allowed again", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunningThread(harness);
      setServerUpdateDraining(harness.db, true);

      await stopAllForUpdate(harness, thread.id);

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(isThreadQueueAutoSendPaused(harness.db, thread.id)).toBe(false);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      expect(turnRequests(harness, thread.id)).toHaveLength(1);

      setServerUpdateDraining(harness.db, false);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });

      const requests = turnRequests(harness, thread.id);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        input: [{ visibility: "agent-only" }],
        execution: {
          model: "gpt-5",
          permissionMode: "auto",
          reasoningLevel: "high",
        },
      });
      expect(requests[1]?.input[0]).toMatchObject({
        text: expect.stringContaining("update"),
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });

  it("lets a message the user already queued drive the resume instead of adding a continuation", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunningThread(harness);

      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Also add tests", mentions: [] }],
      });

      setServerUpdateDraining(harness.db, true);

      await stopAllForUpdate(harness, thread.id);

      expect(
        listQueuedThreadMessages(harness.db, thread.id).map(
          (message) => message.id,
        ),
      ).toEqual([queued.id]);

      setServerUpdateDraining(harness.db, false);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });

      expect(turnRequests(harness, thread.id).at(-1)?.input).toMatchObject([
        { text: "Also add tests" },
      ]);
    });
  });
});
