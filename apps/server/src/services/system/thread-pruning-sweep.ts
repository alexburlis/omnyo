import { performance } from "node:perf_hooks";
import {
  advanceThreadPruning,
  getNextThreadPruningPolicy,
  getDatabaseMaintenanceActivity,
  isDatabaseMaintenanceIdle,
  THREAD_PRUNING_POLICIES,
  type DbConnection,
} from "@omnyo/db";
import type { AppDeps } from "../../types.js";
import { purgeHistoryCacheThread } from "../threads/history-cache-writer.js";

export interface ThreadPruningSweepLimits {
  elapsedBudgetMs: number;
  maxAdvances: number;
}

export const THREAD_PRUNING_SWEEP_LIMITS: ThreadPruningSweepLimits = {
  elapsedBudgetMs: 250,
  maxAdvances: 64,
};

export const THREAD_PRUNING_ADVANCE_TARGET_MS = 25;

export const THREAD_PRUNING_SWEEP_BATCH_SIZE = 64;

const MIN_BATCH_SIZE = 16;

type ThreadPruningPolicy = (typeof THREAD_PRUNING_POLICIES)[number];

const batchSizesByConnection = new WeakMap<
  DbConnection,
  Map<ThreadPruningPolicy, number>
>();

export function nextThreadPruningBatchSize(
  current: number,
  scanned: number,
  elapsedMs: number,
): number {
  if (scanned === 0) return current;

  if (elapsedMs > THREAD_PRUNING_ADVANCE_TARGET_MS)
    return Math.max(
      MIN_BATCH_SIZE,
      Math.floor((scanned * THREAD_PRUNING_ADVANCE_TARGET_MS) / elapsedMs),
    );

  return Math.min(THREAD_PRUNING_SWEEP_BATCH_SIZE, Math.ceil(current * 1.25));
}

export async function runThreadPruningSweep(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  limits: ThreadPruningSweepLimits,
): Promise<void> {
  const startedAt = performance.now();
  const completed = new Set<string>();
  const compactedThreadIds = new Set<string>();
  let advances = 0;
  let removed = 0;
  let scanned = 0;
  let removedBytes = 0;
  let maxAdvanceMs = 0;
  let reason = "budget";

  const batchSizes =
    batchSizesByConnection.get(deps.db) ??
    new Map<ThreadPruningPolicy, number>();

  batchSizesByConnection.set(deps.db, batchSizes);

  try {
    while (
      advances < limits.maxAdvances &&
      performance.now() - startedAt < limits.elapsedBudgetMs &&
      completed.size < THREAD_PRUNING_POLICIES.length
    ) {
      const activity = getDatabaseMaintenanceActivity(deps.db);

      if (!isDatabaseMaintenanceIdle(activity)) {
        reason = "busy";
        deps.logger.debug(
          { activity, advances },
          "Thread pruning skipped while app work is active",
        );
        break;
      }

      const policy = getNextThreadPruningPolicy(deps.db, completed);

      if (policy === null) break;

      const batchSize =
        batchSizes.get(policy) ?? THREAD_PRUNING_SWEEP_BATCH_SIZE;

      const advanceStartedAt = performance.now();
      const result = advanceThreadPruning(deps.db, policy, batchSize);
      const advanceElapsedMs = performance.now() - advanceStartedAt;
      maxAdvanceMs = Math.max(maxAdvanceMs, advanceElapsedMs);
      batchSizes.set(
        policy,
        nextThreadPruningBatchSize(batchSize, result.scanned, advanceElapsedMs),
      );

      if (advanceElapsedMs >= 50)
        deps.logger.warn(
          { ...result, advanceElapsedMs, batchSize },
          "Slow thread pruning advance",
        );
      advances += 1;
      scanned += result.scanned;
      removed += result.removed;
      removedBytes += result.removedBytes;

      if (result.removed > 0 && result.threadId !== null)
        compactedThreadIds.add(result.threadId);
      deps.logger.debug(
        { ...result, advanceElapsedMs, batchSize },
        "Thread pruning policy advanced",
      );

      if (result.action === "cycle-complete") completed.add(policy);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (completed.size === THREAD_PRUNING_POLICIES.length)
      reason = "cycle-complete";
  } catch (error) {
    reason = "failed";
    throw error;
  } finally {
    for (const threadId of compactedThreadIds)
      deps.hub.notifyThread(threadId, ["history-compacted"]);
    const purgeFailures: unknown[] = [];

    for (const threadId of compactedThreadIds) {
      try {
        await purgeHistoryCacheThread(deps.db, threadId);
      } catch (error) {
        purgeFailures.push(error);
      }
    }

    if (purgeFailures.length > 0) reason = "failed";
    deps.logger.debug(
      {
        advances,
        removed,
        scanned,
        removedBytes,
        maxAdvanceMs,
        reason,
        elapsedMs: performance.now() - startedAt,
      },
      "Thread pruning sweep finished",
    );

    if (purgeFailures.length > 0)
      throw new AggregateError(
        purgeFailures,
        "Pruned history cache cleanup failed",
      );
  }
}
