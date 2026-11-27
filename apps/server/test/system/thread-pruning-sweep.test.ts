import { purgeCompactedThreadHistories } from "../../src/services/threads/history-compaction.js";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { pruneThreadEventHistoryBestEffort } from "../../src/services/system/event-pruning.js";
import {
  runCompletedEventOutputMigrationSweep,
  runRetainedEventOutputExpirySweep,
} from "../../src/services/system/periodic-sweeps.js";
import {
  ensureHistoryCache,
  persistHistoryCache,
  closeHistoryCacheWriter,
  historyCacheCommandSchema,
} from "../../src/services/threads/history-cache-writer.js";
import { performance } from "node:perf_hooks";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  getThreadHistoryState,
  historySourceIdentity,
  historyCachePath,
  openHistoryCache,
  retainedEventOutputs,
  advanceThreadPruning,
  events,
  insertEvents,
  noopNotifier,
  getNextThreadPruningPolicy,
  getThreadEventRewriteGeneration,
  threadPruningCursors,
  threads,
} from "@omnyo/db";
import {
  threadTimelineResponseSchema,
  type ThreadTimelineResponse,
} from "@omnyo/server-contract";
import {
  nextThreadPruningBatchSize,
  runThreadPruningSweep,
  THREAD_PRUNING_SWEEP_BATCH_SIZE,
  THREAD_PRUNING_SWEEP_LIMITS,
  type ThreadPruningSweepLimits,
} from "../../src/services/system/thread-pruning-sweep.js";
import {
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { readJson } from "../helpers/json.js";
import {
  createTestAppHarness,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

function seed(harness: TestAppHarness, count: number) {
  const host = seedHost(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const thread = seedThread(harness.deps, { projectId: project.id });
  insertEvents(
    harness.db,
    noopNotifier,
    Array.from({ length: count }, (_, index) => ({
      threadId: thread.id,
      sequence: index + 1,
      scope: { kind: "turn", turnId: "turn" },
      type: "turn/diff/updated",
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: '{"diff":"unused"}',
      createdAt: 1,
    })),
  );

  return thread;
}

async function getTimeline(
  harness: TestAppHarness,
  threadId: string,
  afterSequence?: number,
): Promise<ThreadTimelineResponse> {
  const query =
    afterSequence === undefined ? "" : `?afterSequence=${afterSequence}`;

  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/timeline${query}`,
  );

  expect(response.status).toBe(200);

  return threadTimelineResponseSchema.parse(await readJson(response));
}

function removedEvents(fields: unknown): boolean {
  return (
    typeof fields === "object" &&
    fields !== null &&
    "removed" in fields &&
    fields.removed !== 0
  );
}

const UNTIMED_SWEEP_LIMITS: ThreadPruningSweepLimits = {
  elapsedBudgetMs: Number.POSITIVE_INFINITY,
  maxAdvances: THREAD_PRUNING_SWEEP_LIMITS.maxAdvances,
};

describe("thread pruning batch size", () => {
  it.each([
    ["shrinks to fit the target after a slow advance", 64, 64, 100, 16],
    ["shrinks in proportion to the overrun", 64, 64, 50, 32],
    ["never drops below the minimum", 64, 64, 10_000, 16],
    ["grows by a quarter while advances stay fast", 16, 16, 5, 20],
    ["never grows above the sweep batch size", 60, 60, 5, 64],
    ["keeps its size when nothing was scanned", 40, 0, 500, 40],
  ])("%s", (_label, current, scanned, elapsedMs, expected) => {
    expect(nextThreadPruningBatchSize(current, scanned, elapsedMs)).toBe(
      expected,
    );
  });
});

describe("thread pruning sweep", () => {
  it("skips busy work and rechecks activity after a committed advance", async () => {
    await withTestHarness(async (harness) => {
      const thread = seed(harness, 1200);
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, thread.id))
        .run();
      await runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS);
      expect(harness.db.select().from(threadPruningCursors).all()).toEqual([]);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();
      const generation = getThreadEventRewriteGeneration(thread.id);

      const notify = vi
        .spyOn(harness.deps.hub, "notifyThread")
        .mockImplementation(() => {});

      const debug = vi
        .spyOn(harness.deps.logger, "debug")
        .mockImplementation((fields, message) => {
          if (
            message === "Thread pruning policy advanced" &&
            removedEvents(fields)
          ) {
            expect(getThreadEventRewriteGeneration(thread.id)).toBeGreaterThan(
              generation,
            );
            expect(harness.db.select().from(events).all()).toHaveLength(
              1200 - THREAD_PRUNING_SWEEP_BATCH_SIZE,
            );
            harness.db
              .update(threads)
              .set({ status: "active" })
              .where(eq(threads.id, thread.id))
              .run();
          }
        });

      await runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS);
      expect(notify).toHaveBeenCalledExactlyOnceWith(thread.id, [
        "history-compacted",
      ]);
      expect(harness.db.select().from(events).all()).toHaveLength(
        1200 - THREAD_PRUNING_SWEEP_BATCH_SIZE,
      );
      notify.mockRestore();
      debug.mockRestore();
    });
  });

  it("keeps notifications for earlier commits when the next transaction fails, then resumes", async () => {
    await withTestHarness(async (harness) => {
      const thread = seed(harness, 1200);

      const notify = vi
        .spyOn(harness.deps.hub, "notifyThread")
        .mockImplementation(() => {});

      const debug = vi
        .spyOn(harness.deps.logger, "debug")
        .mockImplementation((fields, message) => {
          if (
            message === "Thread pruning policy advanced" &&
            removedEvents(fields)
          )
            harness.db.run(
              sql`CREATE TRIGGER fail_next_prune BEFORE UPDATE ON thread_pruning_cursors BEGIN SELECT RAISE(ABORT, 'next batch failed'); END`,
            );
        });

      await expect(
        runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS),
      ).rejects.toThrow("next batch failed");
      debug.mockRestore();
      expect(notify).toHaveBeenCalledExactlyOnceWith(thread.id, [
        "history-compacted",
      ]);
      expect(harness.db.select().from(events).all()).toHaveLength(
        1200 - THREAD_PRUNING_SWEEP_BATCH_SIZE,
      );
      harness.db.run(sql`DROP TRIGGER fail_next_prune`);
      notify.mockRestore();

      for (let i = 0; i < 3; i++)
        await runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS);
      expect(
        harness.db
          .select()
          .from(events)
          .all()
          .map((row) => row.sequence),
      ).toEqual([1200]);
    });
  });

  it("notifies one history compaction per thread and answers every earlier viewer with a full timeline", async () => {
    await withTestHarness(async (harness) => {
      const thread = seed(harness, 2400);
      harness.db
        .insert(events)
        .values({
          id: `${thread.id}-message`,
          threadId: thread.id,
          sequence: 2401,
          scopeKind: "turn",
          turnId: "turn",
          type: "item/completed",
          data: JSON.stringify({
            item: { type: "agentMessage", id: "assistant-1", text: "Done." },
          }),
          createdAt: 1,
        })
        .run();
      const before = await getTimeline(harness, thread.id);
      expect(before.maxSeq).toBe(2401);
      const notify = vi.spyOn(harness.deps.hub, "notifyThread");
      const debug = vi.spyOn(harness.deps.logger, "debug");

      await runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS);

      expect(
        debug.mock.calls.filter(
          ([fields, message]) =>
            message === "Thread pruning policy advanced" &&
            removedEvents(fields),
        ).length,
      ).toBeGreaterThan(1);
      expect(notify).toHaveBeenCalledExactlyOnceWith(thread.id, [
        "history-compacted",
      ]);
      expect(harness.db.select().from(events).all().length).toBeLessThan(2401);
      const cold = await getTimeline(harness, thread.id);
      const firstViewer = await getTimeline(harness, thread.id, before.maxSeq);
      const secondViewer = await getTimeline(harness, thread.id, before.maxSeq);

      for (const after of [firstViewer, secondViewer]) {
        expect(after.maxSeq).toBe(before.maxSeq);
        expect(after.delta).toBeUndefined();
        expect(after.rows).toEqual(cold.rows);
      }

      harness.db
        .insert(events)
        .values({
          id: `${thread.id}-follow-up`,
          threadId: thread.id,
          sequence: 2402,
          scopeKind: "turn",
          turnId: "turn",
          type: "item/completed",
          data: JSON.stringify({
            item: { type: "agentMessage", id: "assistant-2", text: "More." },
          }),
          createdAt: 2,
        })
        .run();
      const caughtUp = await getTimeline(harness, thread.id, before.maxSeq);
      expect(caughtUp.delta).toBeUndefined();
      expect(caughtUp.maxSeq).toBe(2402);
      const next = await getTimeline(harness, thread.id, caughtUp.maxSeq);
      expect(next.delta).toEqual({ upsertRows: [] });
      notify.mockRestore();
      debug.mockRestore();
    });
  });

  it("stops at the elapsed budget between advances", async () => {
    await withTestHarness(async (harness) => {
      seed(harness, 1200);
      let elapsed = 0;

      const now = vi
        .spyOn(performance, "now")
        .mockImplementation(() => elapsed);

      const debug = vi
        .spyOn(harness.deps.logger, "debug")
        .mockImplementation((_fields, message) => {
          if (message === "Thread pruning policy advanced")
            elapsed = THREAD_PRUNING_SWEEP_LIMITS.elapsedBudgetMs + 1;
        });

      try {
        await runThreadPruningSweep(harness.deps, THREAD_PRUNING_SWEEP_LIMITS);
        expect(
          debug.mock.calls.filter(
            (call) => call[1] === "Thread pruning policy advanced",
          ),
        ).toHaveLength(1);
      } finally {
        now.mockRestore();
        debug.mockRestore();
      }
    });
  });

  it("reports an advance that overruns the elapsed budget and then yields", async () => {
    await withTestHarness(async (harness) => {
      seed(harness, 1200);

      const now = vi
        .spyOn(performance, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValue(THREAD_PRUNING_SWEEP_LIMITS.elapsedBudgetMs + 25);

      const warn = vi.spyOn(harness.deps.logger, "warn");
      const debug = vi.spyOn(harness.deps.logger, "debug");

      try {
        await runThreadPruningSweep(harness.deps, THREAD_PRUNING_SWEEP_LIMITS);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            advanceElapsedMs: THREAD_PRUNING_SWEEP_LIMITS.elapsedBudgetMs + 25,
          }),
          "Slow thread pruning advance",
        );
        expect(debug).toHaveBeenCalledWith(
          expect.objectContaining({
            advances: 1,
            maxAdvanceMs: THREAD_PRUNING_SWEEP_LIMITS.elapsedBudgetMs + 25,
            reason: "budget",
          }),
          "Thread pruning sweep finished",
        );
      } finally {
        now.mockRestore();
        warn.mockRestore();
        debug.mockRestore();
      }
    });
  });

  it("rotates durable policy progress and honors the advance budget", async () => {
    await withTestHarness(async (harness) => {
      seed(harness, 1);

      for (let i = 0; i < 100; i++) seed(harness, 1);
      const debug = vi.spyOn(harness.deps.logger, "debug");
      await runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS);

      const steps = debug.mock.calls.filter(
        (call) => call[1] === "Thread pruning policy advanced",
      );

      expect(steps.length).toBeLessThanOrEqual(64);
      expect(harness.db.select().from(threadPruningCursors).all()).toHaveLength(
        4,
      );
      const before = getNextThreadPruningPolicy(harness.db, new Set());
      expect(before).not.toBeNull();

      if (before === null) throw new Error("Missing next policy");
      advanceThreadPruning(harness.db, before);
      expect(getNextThreadPruningPolicy(harness.db, new Set())).not.toBe(
        before,
      );
      debug.mockRestore();
    });
  });
});

async function withPersistentHistory(
  run: (fixture: {
    harness: TestAppHarness;
    thread: ReturnType<typeof seed>;
    write: (index: number) => Promise<unknown>;
    cache: ReturnType<typeof openHistoryCache>;
    purges: string[][];
  }) => Promise<void>,
) {
  const root = join(homedir(), "scratch", "omnyo");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "event-upload-pruning-test-"));

  const harness = await createTestAppHarness({
    databaseSource: join(directory, "app.db"),
  });

  const thread = seed(harness, 100);
  await ensureHistoryCache(harness.db);

  const write = (index: number) => {
    const state = getThreadHistoryState(harness.db, thread.id);

    return persistHistoryCache(harness.db, {
      threadId: thread.id,
      historyEpoch: state.epoch,
      rewriteEpoch: state.rewriteEpoch,
      records: [
        {
          key: `${thread.id}-${index}`,
          threadId: thread.id,
          sourceIdentity: historySourceIdentity(harness.db.$client.name),
          rewriteEpoch: state.rewriteEpoch,
          kind: "page",
          body: "{}",
          createdAt: Date.now(),
          expiresAt: null,
          sequence: 0,
        },
      ],
    });
  };

  await write(0);

  const cache = openHistoryCache(historyCachePath(harness.db.$client.name), {
    readonly: true,
  });

  const purges: string[][] = [];
  const original = Worker.prototype.postMessage;

  const post = vi
    .spyOn(Worker.prototype, "postMessage")
    .mockImplementation(function (this: Worker, message: unknown, ...args) {
      const parsed = historyCacheCommandSchema.safeParse(message);

      if (parsed.success && parsed.data.kind === "purge")
        purges.push(parsed.data.threadIds);

      return original.call(this, message, ...args);
    });

  try {
    await run({ harness, thread, write, cache, purges });
  } finally {
    post.mockRestore();
    cache.close();
    await closeHistoryCacheWriter(harness.db);
    await harness.cleanup();
    harness.db.$client.close();
    await rm(directory, { recursive: true });
  }
}

describe("persistent compaction ownership", () => {
  it("dispatches one worker purge for a pruning sweep", async () => {
    await withPersistentHistory(async ({ harness, thread, cache, purges }) => {
      const notify = vi.spyOn(harness.hub, "notifyThread");
      await runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS);
      expect(purges).toEqual([[thread.id]]);
      expect(cache.storageUsage().records).toBe(0);
      expect(notify).toHaveBeenCalledExactlyOnceWith(thread.id, [
        "history-compacted",
      ]);
      expect(harness.db.select().from(events).all()).toHaveLength(1);
      notify.mockRestore();
    });
  });

  it.each(["expiry", "migration"] as const)(
    "dispatches one worker purge for output %s",
    async (kind) => {
      await withPersistentHistory(
        async ({ harness, thread, cache, purges }) => {
          const now = Date.now();
          const id = `${thread.id}-${kind}`;
          harness.db
            .insert(events)
            .values({
              id,
              threadId: thread.id,
              scopeKind: "turn",
              turnId: "output-turn",
              sequence: 101,
              type: "item/completed",
              itemId: id,
              itemKind: "commandExecution",
              createdAt:
                kind === "expiry"
                  ? now - COMPLETED_EVENT_OUTPUT_RETENTION_MS - 1
                  : now - 1,
              data: JSON.stringify({
                item: {
                  id,
                  type: "commandExecution",
                  aggregatedOutput:
                    kind === "expiry" ? "preview" : "x".repeat(40_000),
                },
              }),
            })
            .run();

          if (kind === "expiry")
            harness.db
              .insert(retainedEventOutputs)
              .values({
                eventId: id,
                outputPath: "aggregatedOutput",
                value: JSON.stringify("x".repeat(40_000)),
                expiresAt: now - 1,
              })
              .run();

          if (kind === "expiry")
            await runRetainedEventOutputExpirySweep(harness.deps, now);
          else await runCompletedEventOutputMigrationSweep(harness.deps, now);
          expect(purges).toEqual([[thread.id]]);
          expect(cache.storageUsage().records).toBe(0);
          expect(
            harness.db.select().from(retainedEventOutputs).all(),
          ).toHaveLength(kind === "expiry" ? 0 : 1);
        },
      );
    },
  );

  it.each(["history-rewritten", "thread-deleted"] as const)(
    "keeps route-owned invalidation for %s",
    async (change) => {
      await withPersistentHistory(
        async ({ harness, thread, cache, purges }) => {
          harness.hub.notifyThread(thread.id, [change]);
          await vi.waitFor(() => expect(cache.storageUsage().records).toBe(0));
          expect(purges).toEqual([[thread.id]]);
        },
      );
    },
  );

  it("keeps active pruning synchronous and purges its cache once", async () => {
    await withPersistentHistory(async ({ harness, thread, cache, purges }) => {
      harness.db
        .update(events)
        .set({ type: "provider/rateLimits/updated" })
        .where(eq(events.threadId, thread.id))
        .run();

      const result = pruneThreadEventHistoryBestEffort(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });

      expect(result?.totalRemoved).toBeGreaterThan(0);
      await vi.waitFor(() => expect(cache.storageUsage().records).toBe(0));
      expect(purges).toEqual([[thread.id]]);
    });
  });

  it("awaits a worker failure and preserves the sweep failure diagnostic", async () => {
    await withPersistentHistory(async ({ harness, cache, purges }) => {
      const blocker = new Database(historyCachePath(harness.db.$client.name));
      const debug = vi.spyOn(harness.deps.logger, "debug");
      const error = vi.spyOn(harness.deps.logger, "error");

      try {
        blocker.exec(
          "CREATE TRIGGER fail_purge BEFORE DELETE ON history_cache_records BEGIN SELECT RAISE(ABORT, 'test purge failed'); END",
        );
        await expect(
          runThreadPruningSweep(harness.deps, UNTIMED_SWEEP_LIMITS),
        ).rejects.toBeInstanceOf(AggregateError);
        expect(purges).toHaveLength(1);
        expect(cache.storageUsage().records).toBe(1);
        expect(debug).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "failed" }),
          "Thread pruning sweep finished",
        );
        expect(error).not.toHaveBeenCalled();
      } finally {
        blocker.close();
        debug.mockRestore();
        error.mockRestore();
      }
    });
  });
});

describe("compaction publisher ordering", () => {
  it("publishes every thread before awaiting its one persistent purge", async () => {
    await withPersistentHistory(async ({ harness, thread, cache, purges }) => {
      const ids = new Set([
        thread.id,
        ...Array.from({ length: 3 }, () => seed(harness, 1).id),
      ]);

      const notify = vi.spyOn(harness.hub, "notifyThread");
      const work = purgeCompactedThreadHistories(harness.deps, ids);
      expect(notify.mock.calls.map(([id]) => id)).toEqual([...ids]);
      await work;
      expect(purges.flat()).toEqual([...ids]);
      expect(cache.storageUsage().records).toBe(0);
      notify.mockRestore();
    });
  });

  it("keeps overlapping compactions distinct and cancels an intervening queued write", async () => {
    await withPersistentHistory(
      async ({ harness, thread, cache, purges, write }) => {
        const blocker = new Database(historyCachePath(harness.db.$client.name));
        blocker.exec("BEGIN IMMEDIATE");
        const ids = new Set([thread.id]);
        let completed = false;

        const first = purgeCompactedThreadHistories(harness.deps, ids).then(
          () => {
            completed = true;
          },
        );

        try {
          await vi.waitFor(() => expect(purges).toHaveLength(1));
          expect(completed).toBe(false);
          expect(cache.storageUsage().records).toBe(1);
          const queued = write(1);
          const second = purgeCompactedThreadHistories(harness.deps, ids);
          blocker.exec("ROLLBACK");
          await Promise.all([first, queued, second]);
          expect(purges).toEqual([[thread.id], [thread.id]]);
          expect(cache.storageUsage().records).toBe(0);
          await write(2);
          expect(cache.storageUsage().records).toBe(1);
          await purgeCompactedThreadHistories(harness.deps, ids);
          expect(purges).toEqual([[thread.id], [thread.id], [thread.id]]);
          expect(cache.storageUsage().records).toBe(0);
        } finally {
          if (blocker.inTransaction) blocker.exec("ROLLBACK");
          blocker.close();
          await first;
        }
      },
    );
  });
});
