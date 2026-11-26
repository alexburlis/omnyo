import { eq } from "drizzle-orm";
import {
  events,
  getThread,
  getHighWaterMarks,
  getLastStoredProviderThreadId,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@omnyo/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@omnyo/domain";
import {
  groupHostDaemonEvents,
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventEnvelope,
} from "@omnyo/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import type { ServerChangedMessage } from "../../src/ws/hub.js";
import {
  internalAuthHeaders,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  createCommandApprovalPayload,
  createUserQuestionPayload,
} from "../helpers/pending-interactions.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

interface PostEventBatchArgs {
  harness: TestAppHarness;
  sessionId: string;
  events: HostDaemonEventEnvelope[];
  firstEventIndex?: number;
  sourceInstanceId?: string;
}

async function postEventBatch(args: PostEventBatchArgs): Promise<Response> {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
      ...(args.firstEventIndex === undefined
        ? {}
        : { firstEventIndex: args.firstEventIndex }),
      ...(args.sourceInstanceId === undefined
        ? {}
        : { sourceInstanceId: args.sourceInstanceId }),
    }),
  });
}

function setupEventRoute() {
  return createTestAppHarness().then((harness) => {
    const { host, session } = seedHostSession(harness.deps);

    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });

    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });

    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      status: "active",
    });

    return {
      environment,
      harness,
      host,
      project,
      session,
      thread,
    };
  });
}

function captureAppendedNotifications(harness: TestAppHarness) {
  const notifications: Extract<ServerChangedMessage, { entity: "thread" }>[] =
    [];

  harness.hub.onChangedMessage((message) => {
    if (
      message.entity === "thread" &&
      message.changes.includes("events-appended")
    ) {
      notifications.push(message);
    }
  });

  return notifications;
}

describe("internal event append ownership", () => {
  it("skips diffs using the existing batch response while retaining edits and provider identity", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-diff",
        sequence: 1,
      });
      const providerThreadId = "provider-diff";

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/identity",
              threadId: thread.id,
              providerThreadId,
              scope: threadScope(),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/diff/updated",
              threadId: thread.id,
              providerThreadId,
              scope: turnScope("turn-diff"),
              diff: "discard this snapshot",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "item/completed",
              threadId: thread.id,
              providerThreadId,
              scope: turnScope("turn-diff"),
              item: {
                id: "edit-diff",
                type: "fileChange",
                status: "completed",
                approvalStatus: null,
                changes: [
                  {
                    path: "example.ts",
                    kind: "update",
                    diff: "+const value = 2;",
                  },
                ],
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "thread/identity",
              threadId: thread.id,
              providerThreadId: "provider-latest",
              scope: threadScope(),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/diff/updated",
              threadId: thread.id,
              providerThreadId: "provider-latest",
              scope: turnScope("turn-diff"),
              diff: "discard the final snapshot too",
            },
          },
        ],
      });

      expect(response.status).toBe(200);

      const accepted = hostDaemonEventBatchResponseSchema.parse(
        await response.json(),
      );

      expect(accepted.acceptedEvents.map((event) => event.sequence)).toEqual([
        2, 3, 4,
      ]);
      expect(accepted.acceptedEvents.map((event) => event.eventIndex)).toEqual([
        0, 2, 3,
      ]);

      const skipped = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/diff/updated",
              threadId: thread.id,
              providerThreadId: "provider-latest",
              scope: turnScope("turn-diff"),
              diff: "skip the entire batch",
            },
          },
        ],
      });

      expect(skipped.status).toBe(200);
      expect(
        hostDaemonEventBatchResponseSchema.parse(await skipped.json())
          .acceptedEvents,
      ).toEqual([]);
      const stored = listEvents(harness.db, { threadId: thread.id });
      expect(stored.some((event) => event.type === "turn/diff/updated")).toBe(
        false,
      );
      expect(
        stored.find((event) => event.type === "item/completed")?.sequence,
      ).toBe(3);
      expect(getHighWaterMarks(harness.db, [thread.id])[thread.id]).toBe(4);
      expect(getLastStoredProviderThreadId(harness.db, thread.id)).toBe(
        "provider-latest",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps late provisioning output terminal after setup has failed", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();

    try {
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/thread-provisioning",
        scope: threadScope(),
        data: {
          provisioningId: "tpv-terminal",
          environmentId: environment.id,
          status: "failed",
          entries: [],
        },
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "system/thread-provisioning",
              threadId: thread.id,
              scope: threadScope(),
              provisioningId: "tpv-terminal",
              environmentId: environment.id,
              status: "active",
              entries: [
                {
                  type: "output",
                  key: "setup-output",
                  text: "late buffered setup output",
                },
              ],
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        listEvents(harness.db, { threadId: thread.id }).map((row) =>
          JSON.parse(row.data),
        ),
      ).toMatchObject([
        { status: "failed" },
        {
          status: "failed",
          entries: [{ text: "late buffered setup output" }],
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("stores thread-scoped ACP context usage for the timeline display", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/contextWindowUsage/updated",
              threadId: thread.id,
              providerThreadId: "acp-session-1",
              scope: threadScope(),
              contextWindowUsage: {
                usedTokens: 24_000,
                modelContextWindow: 128_000,
                estimated: false,
              },
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        buildThreadTimelineWithProfile(harness.db, thread, {
          completedTurnDisplay: "collapse",
          eventBudget: 1_000_000,
          includeClearedContextHistory: false,
          includeDiagnosticOperations: true,
          compactionOfferEnabled: false,
          maxInlineOutputChars: null,
          maxSeq: 1,
          page: {
            kind: "latest",
            segmentLimit: Number.MAX_SAFE_INTEGER,
          },
        }).response.contextWindowUsage,
      ).toEqual({
        usedTokens: 24_000,
        modelContextWindow: 128_000,
        estimated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("announces committed sequences and event types across interleaved batches and indexed retries", async () => {
    const { environment, harness, project, session, thread } =
      await setupEventRoute();

    try {
      const secondThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        type: "system/error",
        scope: threadScope(),
        data: { message: "existing" },
      });
      seedEvent(harness.deps, {
        threadId: secondThread.id,
        environmentId: environment.id,
        sequence: 7,
        type: "system/error",
        scope: threadScope(),
        data: { message: "existing on second thread" },
      });

      const notifications = captureAppendedNotifications(harness);

      const batch: HostDaemonEventEnvelope[] = [
        {
          threadId: thread.id,
          event: {
            type: "system/error",
            threadId: thread.id,
            scope: threadScope(),
            message: "first daemon",
          },
        },
        {
          threadId: secondThread.id,
          event: {
            type: "thread/identity",
            threadId: secondThread.id,
            providerThreadId: "provider-second",
            scope: threadScope(),
          },
        },
        {
          threadId: thread.id,
          event: {
            type: "thread/identity",
            threadId: thread.id,
            providerThreadId: "provider-first",
            scope: threadScope(),
          },
        },
        {
          threadId: secondThread.id,
          event: {
            type: "system/error",
            threadId: secondThread.id,
            scope: threadScope(),
            message: "second thread daemon",
          },
        },
        {
          threadId: thread.id,
          event: {
            type: "system/error",
            threadId: thread.id,
            scope: threadScope(),
            message: "second daemon",
          },
        },
      ];

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        firstEventIndex: 1,
        events: batch,
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: thread.id,
            sequence: 4,
          },
          {
            eventIndex: 1,
            threadId: secondThread.id,
            sequence: 8,
          },
          {
            eventIndex: 2,
            threadId: thread.id,
            sequence: 5,
          },
          {
            eventIndex: 3,
            threadId: secondThread.id,
            sequence: 9,
          },
          {
            eventIndex: 4,
            threadId: thread.id,
            sequence: 6,
          },
        ],
        rejectedEvents: [],
        duplicateEvents: 0,
      });
      expect(notifications).toMatchObject([
        {
          id: thread.id,
          metadata: {
            timelineSequence: 6,
            eventTypes: ["system/error", "thread/identity"],
          },
        },
        {
          id: secondThread.id,
          metadata: {
            timelineSequence: 9,
            eventTypes: ["thread/identity", "system/error"],
          },
        },
      ]);
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        { sequence: 3 },
        {
          sequence: 4,
        },
        {
          sequence: 5,
        },
        {
          sequence: 6,
        },
      ]);

      notifications.length = 0;
      batch.push({
        threadId: thread.id,
        event: {
          type: "system/error",
          threadId: thread.id,
          scope: threadScope(),
          message: "new after retry",
        },
      });

      const overlap = await postEventBatch({
        harness,
        sessionId: session.id,
        firstEventIndex: 1,
        events: batch,
      });

      expect(overlap.status).toBe(200);
      await expect(readJson(overlap)).resolves.toEqual({
        acceptedEvents: [{ eventIndex: 5, threadId: thread.id, sequence: 7 }],
        rejectedEvents: [],
        duplicateEvents: 5,
      });
      expect(notifications).toMatchObject([
        {
          id: thread.id,
          metadata: {
            timelineSequence: 7,
            eventTypes: ["system/error"],
          },
        },
      ]);

      notifications.length = 0;

      const duplicate = await postEventBatch({
        harness,
        sessionId: session.id,
        firstEventIndex: 1,
        events: batch,
      });

      expect(duplicate.status).toBe(200);
      await expect(readJson(duplicate)).resolves.toEqual({
        acceptedEvents: [],
        rejectedEvents: [],
        duplicateEvents: 6,
      });
      expect(notifications).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns original event indexes after dropping orphan turn snapshots", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      const notifications = captureAppendedNotifications(harness);

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/tokenUsage/updated",
              threadId: thread.id,
              scope: turnScope("turn-from-source-thread"),
              providerThreadId: "provider-fork-session",
              tokenUsage: {
                total: {
                  totalTokens: 42,
                  inputTokens: 20,
                  cachedInputTokens: 5,
                  outputTokens: 12,
                  reasoningOutputTokens: 5,
                },
                last: {
                  totalTokens: 42,
                  inputTokens: 20,
                  cachedInputTokens: 5,
                  outputTokens: 12,
                  reasoningOutputTokens: 5,
                },
                modelContextWindow: 200_000,
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "accepted after skipped",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(notifications).toMatchObject([
        {
          id: thread.id,
          metadata: {
            timelineSequence: 1,
            eventTypes: ["system/error"],
          },
        },
      ]);
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        {
          sequence: 1,
          type: "system/error",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("assigns distinct sequences for simultaneous requests on the same thread", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      const [firstResponse, secondResponse] = await Promise.all([
        postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                message: "first simultaneous daemon",
              },
            },
          ],
        }),
        postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                message: "second simultaneous daemon",
              },
            },
          ],
        }),
      ]);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);

      const firstBody = hostDaemonEventBatchResponseSchema.parse(
        await readJson(firstResponse),
      );

      const secondBody = hostDaemonEventBatchResponseSchema.parse(
        await readJson(secondResponse),
      );

      expect(
        [...firstBody.acceptedEvents, ...secondBody.acceptedEvents]
          .map((event) => event.sequence)
          .sort((left, right) => left - right),
      ).toEqual([1, 2]);

      const storedRows = harness.db
        .select({
          sequence: events.sequence,
        })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all();

      expect(storedRows).toHaveLength(2);
      expect(
        storedRows
          .map((row) => row.sequence)
          .sort((left, right) => left - right),
      ).toEqual([1, 2]);
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends a queued message after a zero-work turn completes", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();

    try {
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "/clear",
        providerThreadId: "provider-zero-work",
        threadId: thread.id,
      });
      seedQueuedMessage(harness.deps, {
        content: [
          {
            type: "text",
            text: "queued behind zero-work turn",
            mentions: [],
          },
        ],
        threadId: thread.id,
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-zero-work",
              scope: turnScope("turn-zero-work"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-zero-work",
              scope: turnScope("turn-zero-work"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);

      const queuedTurn = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );

      expect(queuedTurn.command).toMatchObject({
        type: "turn.submit",
        input: [
          {
            type: "text",
            text: "queued behind zero-work turn",
            mentions: [],
          },
        ],
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps owned event indexes aligned around an unowned middle row", async () => {
    const { environment, harness, project, session, thread } =
      await setupEventRoute();

    const secondThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "active",
      title: "Second Thread",
    });

    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/name/updated",
              threadId: thread.id,
              providerThreadId: "provider-owned-first",
              scope: threadScope(),
              threadName: "First owned rename",
            },
          },
          {
            threadId: "thr_missing",
            event: {
              type: "thread/name/updated",
              threadId: "thr_missing",
              providerThreadId: "provider-unowned-middle",
              scope: threadScope(),
              threadName: "Rejected rename",
            },
          },
          {
            threadId: secondThread.id,
            event: {
              type: "thread/name/updated",
              threadId: secondThread.id,
              providerThreadId: "provider-owned-second",
              scope: threadScope(),
              threadName: "Second owned rename",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: thread.id,
            sequence: 1,
          },
          {
            eventIndex: 2,
            threadId: secondThread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            eventIndex: 1,
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(getThread(harness.db, thread.id)?.title).not.toBe(
        "First owned rename",
      );
      expect(getThread(harness.db, secondThread.id)?.title).toBe(
        "Second Thread",
      );
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, "thr_missing"))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("notifies a parent when a child provider process exits", async () => {
    const { environment, harness, project, session } = await setupEventRoute();

    const parentThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
      title: "Project coordinator",
    });

    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      inputText: "Coordinate child work",
      providerThreadId: "provider-parent-provider-exit",
      threadId: parentThread.id,
    });

    const childThread = seedThread(harness.deps, {
      environmentId: environment.id,
      parentThreadId: parentThread.id,
      projectId: project.id,
      status: "active",
      title: "Child provider exit worker",
    });

    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "system/error",
              threadId: childThread.id,
              scope: threadScope(),
              code: "provider_process_exited",
              message: "Provider process exited",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: childThread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");

      const parentTurnCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === parentThread.id,
        3_000,
      );

      if (parentTurnCommand.command.type !== "turn.submit") {
        throw new Error(
          `Expected parent turn command, got ${parentTurnCommand.command.type}`,
        );
      }

      const [input] = parentTurnCommand.command.input;

      if (!input || input.type !== "text") {
        throw new Error("Expected parent notification text input");
      }

      const threadMention = `@thread:${childThread.id}`;
      expect(input.text).toContain(
        [
          `${threadMention} failed.`,
          "",
          "Review the thread before deciding next steps.",
        ].join("\n"),
      );
      expect(input.text).not.toContain("No failure output was recorded.");
      expect(input.mentions).toEqual([
        {
          start: input.text.indexOf(threadMention),
          end: input.text.indexOf(threadMention) + threadMention.length,
          resource: {
            kind: "thread",
            label: "Child provider exit worker",
            projectId: project.id,
            threadId: childThread.id,
          },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not notify a parent when a side-chat child provider process exits", async () => {
    const { environment, harness, project, session } = await setupEventRoute();

    const parentThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
    });

    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      inputText: "Coordinate side chat child work",
      providerThreadId: "provider-side-chat-parent-provider-exit",
      threadId: parentThread.id,
    });

    const childThread = seedThread(harness.deps, {
      environmentId: environment.id,
      originKind: "fork",
      originPluginId: "side-chat",
      parentThreadId: parentThread.id,
      projectId: project.id,
      status: "active",
      visibility: "hidden",
    });

    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "system/error",
              threadId: childThread.id,
              scope: threadScope(),
              code: "provider_process_exited",
              message: "Provider process exited",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === parentThread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("interaction lifecycle records from the daemon", () => {
  async function postLifecycle(args: {
    harness: TestAppHarness;
    sessionId: string;
    threadId: string;
    interactionId: string;
  }): Promise<Response> {
    return postEventBatch({
      harness: args.harness,
      sessionId: args.sessionId,
      events: [
        {
          threadId: args.threadId,
          event: {
            type: "system/interaction/lifecycle",
            threadId: args.threadId,
            scope: threadScope(),
            interaction: {
              id: args.interactionId,
              status: "resolved",
              statusReason: null,
              origin: {
                kind: "provider",
                providerId: "codex",
                providerRequestId: "request-forged",
              },
              payload: {
                kind: "approval",
                subject: {
                  kind: "command",
                  itemId: "item-forged",
                  command: "rm -rf /",
                  cwd: "/tmp/project",
                  actions: [{ type: "unknown", command: "rm -rf /" }],
                  sessionGrant: null,
                },
                reason: null,
              },
              resolution: { decision: "allow_once", grantedPermissions: null },
            },
          },
        },
      ],
    });
  }

  function storedLifecycleRows(harness: TestAppHarness, threadId: string) {
    return harness.deps.db
      .select({ type: events.type })
      .from(events)
      .where(eq(events.threadId, threadId))
      .all()
      .filter((row) => row.type === "system/interaction/lifecycle");
  }

  it("drops a lifecycle record that names no interaction on the thread", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      const response = await postLifecycle({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        interactionId: "pi_forged",
      });

      expect(response.status).toBe(200);

      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );

      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedLifecycleRows(harness, thread.id)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("drops a lifecycle record even for an interaction the server registered on that thread", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-lifecycle-1",
        providerThreadId: "provider-thread-lifecycle",
      });

      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-lifecycle-1",
            providerId: "codex",
            providerThreadId: "provider-thread-lifecycle",
            providerRequestId: "request-real",
            payload: createCommandApprovalPayload({
              itemId: "item-real",
              reason: "Approve command",
              command: "git status",
              cwd: "/tmp/project",
            }),
          },
        });

      if (registered.outcome === "rejected") {
        throw new Error(`Expected registration: ${registered.reason}`);
      }

      const before = storedLifecycleRows(harness, thread.id).length;

      const response = await postLifecycle({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        interactionId: registered.interaction.id,
      });

      expect(response.status).toBe(200);

      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );

      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedLifecycleRows(harness, thread.id)).toHaveLength(before);

      const interaction = harness.deps.pendingInteractions.getThreadInteraction(
        {
          threadId: thread.id,
          interactionId: registered.interaction.id,
        },
      );

      expect(interaction.status).toBe("pending");
      expect(interaction.resolution).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a forged answer for a real pending user question in every lifecycle event shape and leaves it pending and unanswered", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-lifecycle-2",
        providerThreadId: "provider-thread-question",
      });

      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-lifecycle-2",
            providerId: "codex",
            providerThreadId: "provider-thread-question",
            providerRequestId: "request-question",
            payload: createUserQuestionPayload({
              prompt: "Which deployment target should I use?",
            }),
          },
        });

      if (registered.outcome === "rejected") {
        throw new Error(`Expected registration: ${registered.reason}`);
      }

      const interactionId = registered.interaction.id;

      const storedRows = () =>
        harness.deps.db
          .select({ type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .map((row) => row.type);

      const before = storedRows();

      const forgedAnswers = {
        "question-1": {
          selected: ["production"],
          freeText: "ship it straight to production",
        },
      };

      const forgedQuestion = createUserQuestionPayload({
        prompt: "Forged prompt the user never saw",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "system/interaction/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interaction: {
                id: interactionId,
                status: "resolved",
                statusReason: null,
                origin: {
                  kind: "provider",
                  providerId: "codex",
                  providerRequestId: "request-question",
                },
                payload: forgedQuestion,
                resolution: { kind: "user_answer", answers: forgedAnswers },
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/userQuestion/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interactionId,
              providerId: "codex",
              providerRequestId: "request-question",
              status: "resolved",
              statusReason: null,
              resolution: { kind: "user_answer", answers: forgedAnswers },
              payload: forgedQuestion,
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/permissionGrant/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interactionId,
              providerId: "codex",
              providerRequestId: "request-question",
              status: "resolved",
              statusReason: null,
              resolution: {
                decision: "allow_for_session",
                grantedPermissions: null,
              },
              subject: {
                kind: "permission_grant",
                itemId: "item-forged-grant",
                toolName: "Bash",
                permissions: { network: null, fileSystem: null },
              },
            },
          },
        ],
      });

      expect(response.status).toBe(200);

      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );

      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedRows()).toEqual(before);

      const interaction = harness.deps.pendingInteractions.getThreadInteraction(
        {
          threadId: thread.id,
          interactionId,
        },
      );

      expect(interaction.status).toBe("pending");
      expect(interaction.resolution).toBeNull();
      expect(
        harness.deps.pendingInteractions
          .listPendingThreadInteractions(thread.id)
          .map((pending) => pending.id),
      ).toEqual([interactionId]);

      const maxSeq = Math.max(
        ...harness.deps.db
          .select({ sequence: events.sequence })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .map((row) => row.sequence),
      );

      const questionRows = buildThreadTimelineWithProfile(harness.db, thread, {
        completedTurnDisplay: "collapse",
        eventBudget: 1_000_000,
        includeClearedContextHistory: false,
        includeDiagnosticOperations: true,
        compactionOfferEnabled: false,
        maxInlineOutputChars: null,
        maxSeq,
        page: { kind: "latest", segmentLimit: Number.MAX_SAFE_INTEGER },
      }).response.rows.flatMap((row) =>
        row.kind === "work" && row.workKind === "question" ? [row] : [],
      );

      expect(questionRows).toHaveLength(1);
      expect(questionRows[0]).toMatchObject({
        interactionId,
        lifecycle: "pending",
        answers: null,
      });
      expect(questionRows[0]?.questions[0]?.prompt).toBe(
        "Which deployment target should I use?",
      );
    } finally {
      await harness.cleanup();
    }
  });
});

describe("retained event delivery", () => {
  it.each([
    ["provider_process_exited", "stale", false, "starting"],
    ["provider_process_exited", "current", false, "error"],
    ["provider_process_exited", "stale", true, "starting"],
    ["provider_process_exited", "current", true, "error"],
    ["provider_process_exited", "missing", false, "starting"],
    ["provider_turn_start_failed", "stale", false, "starting"],
    ["provider_turn_start_failed", "current", true, "error"],
    ["provider_turn_start_failed", "missing", false, "starting"],
  ] as const)(
    "matches retained pending-start error %s identity %s with prior root %s",
    async (code, identity, priorRoot, expected) => {
      const { harness, session, thread, environment } = await setupEventRoute();

      try {
        if (priorRoot) {
          seedTurnStarted(harness.deps, {
            threadId: thread.id,
            turnId: "turn-retained-completed",
            sequence: 1,
          });
          seedEvent(harness.deps, {
            threadId: thread.id,
            sequence: 2,
            type: "turn/completed",
            scope: turnScope("turn-retained-completed"),
            data: {
              providerThreadId: "provider-completed",
              status: "completed",
            },
          });
        }

        seedThreadRuntimeState(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-pending-current",
          sequenceStart: 10,
        });
        harness.db
          .update(threads)
          .set({ status: "starting" })
          .where(eq(threads.id, thread.id))
          .run();

        const requestId =
          identity === "current"
            ? encodeClientTurnRequestIdNumber({ value: 10 })
            : encodeClientTurnRequestIdNumber({ value: 9 });

        const exitEvent = {
          type: "system/error",
          threadId: thread.id,
          scope: threadScope(),
          code,
          message: "provider failed before turn/started",
          ...(identity === "missing" ? {} : { requestId }),
        } as const;

        const response = await postEventBatch({
          harness,
          sessionId: session.id,
          firstEventIndex: 1,
          sourceInstanceId: "instance-retained-exited",
          events: [
            {
              threadId: thread.id,
              event: exitEvent,
            },
          ],
        });

        expect(response.status).toBe(200);
        expect(getThread(harness.db, thread.id)?.status).toBe(expected);
        expect(
          listEvents(harness.db, { threadId: thread.id }).filter(
            (event) => event.type === "client/turn/rejected",
          ),
        ).toHaveLength(expected === "error" ? 1 : 0);
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("does not apply delayed terminal events to a newer turn", async () => {
    const { harness, session, thread } = await setupEventRoute();

    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-retained-old",
        providerThreadId: "provider-old",
        sequence: 1,
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-retained-new",
        providerThreadId: "provider-new",
        sequence: 2,
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        firstEventIndex: 1,
        sourceInstanceId: "instance-retained-exited",
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-old",
              scope: turnScope("turn-retained-old"),
              status: "failed",
              error: { message: "old provider exited" },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: turnScope("turn-retained-old"),
              code: "provider_process_exited",
              message: "old provider exited",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(4);
    } finally {
      await harness.cleanup();
    }
  });
});
