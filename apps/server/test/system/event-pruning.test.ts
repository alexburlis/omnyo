import { createConnection, getThread, listEvents } from "@omnyo/db";
import { turnScope } from "@omnyo/domain";
import { groupHostDaemonEvents } from "@omnyo/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import {
  applyTurnCompletedEvent,
  readTurnCompletion,
} from "../../src/internal/turn-completed-events.js";
import {
  maybePruneActiveThreadEventHistory,
  resetActiveThreadEventPruningState,
  pruneThreadEventHistoryBestEffort,
} from "../../src/services/system/event-pruning.js";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import {
  createTestDaemonEventEnvelope,
  internalAuthHeaders,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  createTestDb,
  withTestHarness,
} from "../helpers/test-app.js";

interface SeedNoiseRowsArgs {
  endingSequence: number;
  startingSequence?: number;
  threadId: string;
}

interface CreateTokenUsageDataArgs {
  modelContextWindow: number | null;
  totalTokens: number;
}

interface CreateContextWindowUsageDataArgs {
  estimated?: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

function createTokenUsageData(
  args: CreateTokenUsageDataArgs,
): Record<string, unknown> {
  return {
    tokenUsage: {
      total: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: args.modelContextWindow,
    },
  };
}

function createContextWindowUsageData(
  args: CreateContextWindowUsageDataArgs,
): Record<string, unknown> {
  return {
    contextWindowUsage: {
      usedTokens: args.usedTokens,
      modelContextWindow: args.modelContextWindow,
      estimated: args.estimated ?? false,
    },
  };
}

function listEventSequencesForType(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: { itemId?: string; threadId: string; type: string },
): number[] {
  return listEvents(harness.db, {
    threadId: args.threadId,
  })
    .filter(
      (event) =>
        event.type === args.type &&
        (args.itemId === undefined || event.itemId === args.itemId),
    )
    .map((event) => event.sequence);
}

function drainLivePruning(
  deps: Parameters<typeof pruneThreadEventHistoryBestEffort>[0],
  args: Parameters<typeof pruneThreadEventHistoryBestEffort>[1],
) {
  let totalRemoved = 0;
  let passesSinceRemoval = 0;

  for (let i = 0; i < 1000 && passesSinceRemoval < 256; i++) {
    const result = pruneThreadEventHistoryBestEffort(deps, args);

    if (result === null) throw new Error("Live cleanup failed");
    expect(result.scanned).toBeLessThanOrEqual(32);
    totalRemoved += result.totalRemoved;
    passesSinceRemoval = result.totalRemoved > 0 ? 0 : passesSinceRemoval + 1;
  }

  return { totalRemoved };
}

function seedNoiseRows(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: SeedNoiseRowsArgs,
): void {
  const startingSequence = args.startingSequence ?? 1;

  for (
    let sequence = startingSequence;
    sequence <= args.endingSequence;
    sequence += 1
  ) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      providerThreadId: "provider-thread-1",
      sequence,
      scope: turnScope(`turn-${sequence}`),
      type: "thread/tokenUsage/updated",
      itemId: null,
      itemKind: null,
      data: createTokenUsageData({
        totalTokens: sequence,
        modelContextWindow: null,
      }),
    });
  }
}

function seedResolvedAssistantMessage(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: {
    completedSequence: number;
    deltaSequences: readonly number[];
    itemId: string;
    threadId: string;
    turnId?: string;
  },
): void {
  const turnId = args.turnId ?? "turn-1";

  for (const sequence of args.deltaSequences) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      sequence,
      type: "item/agentMessage/delta",
      scope: turnScope(turnId),
      itemId: args.itemId,
      itemKind: null,
      data: {
        itemId: args.itemId,
        delta: `chunk-${sequence}`,
      },
    });
  }

  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    sequence: args.completedSequence,
    type: "item/completed",
    scope: turnScope(turnId),
    itemId: args.itemId,
    itemKind: "agentMessage",
    data: {
      item: {
        id: args.itemId,
        type: "agentMessage",
        text: "Final answer",
      },
    },
  });
}

describe("thread event pruning", () => {
  it("preserves context window usage when idle pruning removes old context-usage rows", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

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
      });

      for (let sequence = 1; sequence <= 305; sequence += 1) {
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          sequence,
          scope: turnScope(`turn-${sequence}`),
          type: "thread/contextWindowUsage/updated",
          itemId: null,
          itemKind: null,
          data: createContextWindowUsageData({
            usedTokens: sequence,
            modelContextWindow: sequence === 1 ? 200_000 : null,
            estimated: sequence !== 1,
          }),
        });
      }

      const result = drainLivePruning(harness.deps, {
        mode: "idle",
        threadId: thread.id,
      });

      const timeline = buildThreadTimelineWithProfile(harness.db, thread, {
        completedTurnDisplay: "collapse",
        eventBudget: 1_000_000,
        includeClearedContextHistory: false,
        includeDiagnosticOperations: true,
        compactionOfferEnabled: false,
        maxInlineOutputChars: null,
        page: {
          kind: "latest",
          segmentLimit: Number.MAX_SAFE_INTEGER,
        },
      }).response;

      expect(result.totalRemoved).toBe(303);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/contextWindowUsage/updated",
        }),
      ).toEqual([1, 305]);
      expect(timeline.contextWindowUsage).toEqual({
        usedTokens: 305,
        modelContextWindow: 200_000,
        estimated: true,
      });
    });
  });

  it("prunes thread history when turn completion returns the thread to idle", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

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

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 305,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 306,
        type: "turn/started",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [307, 308],
        completedSequence: 309,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 310,
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        data: {
          status: "completed",
        },
      });

      applyTurnCompletedEvent(harness.deps, {
        afterIdle: null,
        payload: {
          type: "turn/completed",
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          scope: turnScope("turn-1"),
          status: "completed",
        },
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      drainLivePruning(harness.deps, { threadId: thread.id, mode: "idle" });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(305);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([307]);
    });
  });

  it("identifies root completions even when the thread is already settled", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

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
        status: "idle",
      });

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        data: {
          status: "completed",
        },
      });

      const payload = {
        type: "turn/completed" as const,
        threadId: thread.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        status: "completed" as const,
      };

      expect(
        readTurnCompletion(harness.deps, payload).isRootTurnCompletion,
      ).toBe(true);
      expect(
        applyTurnCompletedEvent(harness.deps, { afterIdle: null, payload }),
      ).toEqual({ kind: "settled", nextStatus: null });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });

  it("prunes thread history on archive using the same usage retention rule", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

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
        status: "idle",
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 130,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [131, 132],
        completedSequence: 133,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-all`,
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      drainLivePruning(harness.deps, { threadId: thread.id, mode: "archived" });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(130);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([131]);
    });
  });

  it("notifies only after a committed live advance and reports its bounded work", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

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
      });

      for (let sequence = 1; sequence <= 100; sequence++)
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-thread",
          sequence,
          scope: turnScope("turn"),
          type: "provider/rateLimits/updated",
          itemId: null,
          itemKind: null,
          data: {},
        });

      const notify = vi
        .spyOn(harness.deps.hub, "notifyThread")
        .mockImplementation(() => {});

      const first = pruneThreadEventHistoryBestEffort(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });

      expect(first).toMatchObject({
        policy: "rate-limits",
        scanned: 32,
        totalRemoved: 32,
      });
      expect(notify).toHaveBeenCalledExactlyOnceWith(thread.id, [
        "history-compacted",
      ]);

      const second = pruneThreadEventHistoryBestEffort(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });

      expect(second).toMatchObject({ policy: "usage", totalRemoved: 0 });
      expect(notify).toHaveBeenCalledTimes(1);
      notify.mockRestore();
    });
  });

  it("logs and returns null when best-effort pruning cannot run", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

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
      });

      const loggerWarn = vi.fn();
      harness.deps.logger.warn = loggerWarn;

      const closedDb = createTestDb();

      closedDb.$client.close();

      expect(
        pruneThreadEventHistoryBestEffort(
          {
            db: closedDb,
            logger: harness.deps.logger,
            hub: harness.deps.hub,
          },
          {
            mode: "idle",
            threadId: thread.id,
          },
        ),
      ).toBeNull();
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
        }),
        "Failed to prune thread event history",
      );
    });
  });

  it("prunes active-thread noise rows after ingest without dropping unresolved deltas", async () => {
    await withTestHarness(async (harness) => {
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

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 1_000,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-completed",
        deltaSequences: [1_001, 1_002],
        completedSequence: 1_003,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 1_006,
        type: "turn/started",
        providerThreadId: "provider-thread-1",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });

      for (const sequence of [1_004, 1_005]) {
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          scope: turnScope("turn-active"),
          sequence,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
          itemKind: null,
          data: {
            itemId: "msg-active",
            delta: `chunk-${sequence}`,
          },
        });
      }

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            createTestDaemonEventEnvelope({
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: "provider-thread-1",
                scope: turnScope("turn-1"),
                tokenUsage: {
                  total: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  last: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  modelContextWindow: 200_000,
                },
              },
            }),
          ]),
        }),
      });

      expect(response.status).toBe(200);
      drainLivePruning(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(1007);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-completed",
        }),
      ).toEqual([1_001]);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
        }),
      ).toEqual([1_004, 1_005]);
    });
  });
});

describe("active pruning admission", () => {
  it.each(["active", "idle"] as const)(
    "skips actual lookups before both gates and admits %s threads",
    async (status) => {
      await withTestHarness(async (harness) => {
        const host = seedHost(harness.deps);

        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });

        const thread = seedThread(harness.deps, {
          projectId: project.id,
          status,
        });

        let lookups = 0;
        let threadLookupSql = "";
        let clock = 1_000_000;
        let lookupAdvance = 0;

        const db = createConnection(harness.db.$client.serialize(), {
          slowQueryThresholdMs: 0,
          slowQueryLogger: {
            info(fields) {
              if (
                fields.operation === "get" &&
                fields.sql.includes('from "threads"') &&
                (threadLookupSql === "" || fields.sql === threadLookupSql)
              ) {
                threadLookupSql = fields.sql;
                lookups += 1;
                clock += lookupAdvance;
              }
            },
          },
        });

        const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
        const deps = { ...harness.deps, db };

        const prune = (sequence: number) =>
          maybePruneActiveThreadEventHistory(deps, {
            threadId: thread.id,
            latestPrunableSequence: sequence,
          });

        try {
          expect(prune(249)).toBeNull();
          expect(lookups).toBe(0);
          lookupAdvance = 10;
          expect(prune(250)).not.toBeNull();
          expect(lookups).toBe(1);
          clock = 1_030_009;
          lookupAdvance = 1;
          expect(prune(500)).toBeNull();
          expect(lookups).toBe(1);
          clock = 1_030_010;
          expect(prune(500)).not.toBeNull();
          expect(lookups).toBe(2);
          clock += 60_000;
          expect(prune(749)).toBeNull();
          expect(lookups).toBe(2);
          resetActiveThreadEventPruningState(thread.id);
          expect(prune(250)).not.toBeNull();
          expect(lookups).toBe(3);
        } finally {
          resetActiveThreadEventPruningState(thread.id);
          now.mockRestore();
          db.$client.close();
        }
      });
    },
  );
});
