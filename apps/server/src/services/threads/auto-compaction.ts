import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  environments,
  getEnvironment,
  getExperiments,
  getLastStoredTurnRequestEvent,
  getLatestCompletedThreadContextClearSequence,
  getLatestStoredRateLimitsEvent,
  getLatestRequestTokenUsageRow,
  getThread,
  isThreadQueueAutoSendPaused,
  pendingInteractions,
  queuedThreadMessages,
  threadProducers,
  threads,
  threadWaits,
  type DbConnection,
  type DbQueryConnection,
} from "@omnyo/db";
import {
  providerRateLimitStateSchema,
  type ProviderRateLimitStatus,
  type ThreadWorkLabel,
} from "@omnyo/domain";
import type {
  ThreadAutoCompaction,
  ThreadContextWindowUsage,
} from "@omnyo/server-contract";
import { z } from "zod";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { hasPausedQueue } from "../inbox/engine.js";
import { isHostConnected } from "../lib/entity-lookup.js";
import { isServerUpdateDraining } from "../system/server-update-drain.js";
import { isLatestRequestStandaloneCompaction } from "./compaction-offer.js";
import { readThreadContextWindowUsage } from "./context-window-usage.js";
import {
  compactThreadContext,
  type MaintenanceCompactionOptions,
} from "./dispatch-attempt.js";
import {
  countActiveMaintenanceRuns,
  getLatestMaintenanceRequest,
  readAutoCompactionMetadata,
} from "./maintenance-run.js";
import { isThreadContinuationInFlight } from "./thread-continuation-admission.js";
import { parseStoredEvent } from "./thread-data.js";
import { parseStoredTurnRequestEvent } from "./thread-events.js";
import {
  hasLiveThreadStartInFlight,
  hasLiveThreadStopInFlight,
} from "./thread-lifecycle.js";
import { buildThreadListEntry } from "./thread-runtime-display.js";

export const AUTO_COMPACTION_PROVIDER_IDS: readonly string[] = ["claude-code"];

export const AUTO_COMPACTION_MIN_CONTEXT_TOKENS = 200_000;

export const AUTO_COMPACTION_MIN_PROMPT_CACHE_TTL_MS = 3_600_000;

export const AUTO_COMPACTION_DUE_BEFORE_EXPIRY_MS = 10 * 60_000;

export const AUTO_COMPACTION_LAPSE_BEFORE_EXPIRY_MS = 5 * 60_000;

export const AUTO_COMPACTION_MAX_ACTIVE_RUNS = 2;

const ELIGIBLE_WORK_LABELS: ReadonlySet<ThreadWorkLabel> = new Set([
  "open",
  "external",
  "needs-you",
]);

const LIVE_WAIT_STATUSES = ["live", "evaluating", "dispatched"] as const;

const LIVE_INTERACTION_STATUSES = ["pending", "resolving"] as const;

const WITHIN_PLAN_RATE_LIMIT_STATUSES: ReadonlySet<ProviderRateLimitStatus> =
  new Set(["allowed", "warning"]);

const rateLimitsDataSchema = z.object({
  rateLimits: providerRateLimitStateSchema,
});

type AutoCompactionThread = typeof threads.$inferSelect;

type AutoCompactionReadDeps = Pick<
  AppDeps,
  "config" | "db" | "hub" | "providerRegistry"
>;

export interface AutoCompactionTiming {
  anchorAt: number;
  ttlMs: number;
  dueAt: number;
  lapseAt: number;
  usageSequence: number;
  sequenceStart: number;
}

interface PlannedAutoCompaction {
  kind: "planned";
  timing: AutoCompactionTiming;
  latestRequestSequence: number;
  execution: MaintenanceCompactionOptions["execution"];
  optedOut: boolean;
}

type AutoCompactionPlan =
  | PlannedAutoCompaction
  | { kind: "ineligible"; reason: string };

export class AutoCompactionSupersededError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Automatic compaction was superseded: ${reason}`);
    this.name = "AutoCompactionSupersededError";
    this.reason = reason;
  }
}

function ineligible(reason: string): AutoCompactionPlan {
  return { kind: "ineligible", reason };
}

function isAutoCompactionProvider(
  deps: Pick<AppDeps, "providerRegistry">,
  providerId: string,
): boolean {
  return (
    AUTO_COMPACTION_PROVIDER_IDS.includes(providerId) &&
    deps.providerRegistry.supportsManualCompaction(providerId)
  );
}

function threadFlagReason(thread: AutoCompactionThread): string | null {
  if (thread.deletedAt !== null) return "deleted";

  if (thread.archivedAt !== null) return "archived";

  if (thread.shelvedAt !== null) return "shelved";

  if (thread.visibility !== "visible") return "hidden";

  if (thread.parentThreadId !== null) return "child-chat";

  if (thread.launchedByThreadId !== null) return "agent-launched";

  if (thread.originPluginId !== null) return "plugin-created";

  return null;
}

function readAutoCompactionTiming(
  db: DbConnection,
  args: { threadId: string; sequenceStart: number },
): AutoCompactionTiming | { reason: string } {
  const row = getLatestRequestTokenUsageRow(db, args);

  if (row === null) return { reason: "no-usage" };
  const event = parseStoredEvent(row);

  if (event.type !== "thread/tokenUsage/updated") return { reason: "no-usage" };
  const ttlMs = event.tokenUsage.promptCacheTtlMs;

  if (ttlMs === undefined) return { reason: "no-cache-ttl" };

  if (ttlMs < AUTO_COMPACTION_MIN_PROMPT_CACHE_TTL_MS)
    return { reason: "short-cache-ttl" };

  return {
    anchorAt: row.createdAt,
    ttlMs,
    dueAt: row.createdAt + ttlMs - AUTO_COMPACTION_DUE_BEFORE_EXPIRY_MS,
    lapseAt: row.createdAt + ttlMs - AUTO_COMPACTION_LAPSE_BEFORE_EXPIRY_MS,
    usageSequence: row.sequence,
    sequenceStart: args.sequenceStart,
  };
}

function isLatestRequestOwnerDriven(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  const latest = db.get<{
    initiator: string | null;
    systemMessageKind: string | null;
  }>(sql`
    SELECT json_extract(data, '$.initiator') AS initiator,
      json_extract(data, '$.systemMessageKind') AS systemMessageKind
    FROM events INDEXED BY events_thread_type_sequence_idx
    WHERE thread_id = ${threadId}
      AND type = 'client/turn/requested'
      AND json_extract(data, '$.initiator') <> 'system'
    ORDER BY sequence DESC
    LIMIT 1
  `);

  return latest?.initiator === "user" && latest.systemMessageKind === null;
}

function planAutoCompaction(
  deps: AutoCompactionReadDeps,
  thread: AutoCompactionThread,
  usage: ThreadContextWindowUsage | null,
  sequenceStart: number,
  options: { includeOptedOut: boolean },
): AutoCompactionPlan {
  if (!getExperiments(deps.db).autoCompactBeforeCacheExpiry)
    return ineligible("experiment-off");
  const optedOut = readAutoCompactionMetadata(deps.db, thread.id).disabled;

  if (optedOut && !options.includeOptedOut) return ineligible("opted-out");

  if (!isAutoCompactionProvider(deps, thread.providerId))
    return ineligible("provider-unsupported");
  const flag = threadFlagReason(thread);

  if (flag !== null) return ineligible(flag);

  if (usage === null) return ineligible("no-context-usage");

  if (usage.usedTokens < AUTO_COMPACTION_MIN_CONTEXT_TOKENS)
    return ineligible("small-context");

  const timing = readAutoCompactionTiming(deps.db, {
    threadId: thread.id,
    sequenceStart,
  });

  if ("reason" in timing) return ineligible(timing.reason);
  const latestRequest = getLastStoredTurnRequestEvent(deps.db, thread.id);

  if (latestRequest === null) return ineligible("no-request");

  if (isLatestRequestStandaloneCompaction(deps.db, thread.id))
    return ineligible("already-compacted");

  if (!isLatestRequestOwnerDriven(deps.db, thread.id))
    return ineligible("not-owner-driven");
  const { execution } = parseStoredTurnRequestEvent(latestRequest);

  return {
    kind: "planned",
    timing,
    latestRequestSequence: latestRequest.sequence,
    execution: {
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: execution.serviceTier,
    },
    optedOut,
  };
}

function planAutoCompactionFromStoredUsage(
  deps: AutoCompactionReadDeps,
  thread: AutoCompactionThread,
): AutoCompactionPlan {
  const { sequenceStart, usage } = readThreadContextWindowUsage(
    deps.db,
    thread.id,
  );

  return planAutoCompaction(deps, thread, usage, sequenceStart, {
    includeOptedOut: false,
  });
}

function rateLimitReason(db: DbConnection, threadId: string): string | null {
  const row = getLatestStoredRateLimitsEvent(db, { threadId });

  if (row === null) return null;
  let data: unknown;

  try {
    data = JSON.parse(row.data);
  } catch {
    return "rate-limit-unreadable";
  }

  const parsed = rateLimitsDataSchema.safeParse(data);

  if (!parsed.success) return "rate-limit-unreadable";
  const state = parsed.data.rateLimits;

  if (state.kind === "credits") return "using-credits";

  if (state.windows.some((window) => window.providerKey === "overage"))
    return "using-credits";

  if (
    !WITHIN_PLAN_RATE_LIMIT_STATUSES.has(state.status) ||
    state.windows.some(
      (window) => !WITHIN_PLAN_RATE_LIMIT_STATUSES.has(window.status),
    )
  )
    return "rate-limited";

  return null;
}

function hasQueuedMessage(db: DbConnection, threadId: string): boolean {
  return (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .limit(1)
      .get() !== undefined
  );
}

function hasLiveInboxWait(db: DbConnection, threadId: string): boolean {
  return (
    db
      .select({ id: threadWaits.id })
      .from(threadWaits)
      .where(
        and(
          eq(threadWaits.threadId, threadId),
          inArray(threadWaits.status, [...LIVE_WAIT_STATUSES]),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasActiveProducer(db: DbConnection, threadId: string): boolean {
  return (
    db
      .select({ id: threadProducers.id })
      .from(threadProducers)
      .where(
        and(
          eq(threadProducers.threadId, threadId),
          eq(threadProducers.status, "active"),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasTurnBoundInteraction(db: DbConnection, threadId: string): boolean {
  return (
    db
      .select({ id: pendingInteractions.id })
      .from(pendingInteractions)
      .where(
        and(
          eq(pendingInteractions.threadId, threadId),
          inArray(pendingInteractions.status, [...LIVE_INTERACTION_STATUSES]),
          isNotNull(pendingInteractions.turnId),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function findAutoCompactionBlocker(
  deps: AutoCompactionReadDeps,
  thread: AutoCompactionThread,
  options: { includeTransient: boolean },
): string | null {
  if (options.includeTransient && thread.status !== "idle") return "not-idle";

  const environment =
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId);

  if (environment === null || environment.status !== "ready")
    return "environment-not-ready";

  if (!isHostConnected(deps, environment.hostId)) return "host-disconnected";

  if (isServerUpdateDraining(deps, environment.hostId)) return "update-drain";

  if (
    options.includeTransient &&
    (hasLiveThreadStartInFlight(thread.id) ||
      hasLiveThreadStopInFlight(thread.id) ||
      isThreadContinuationInFlight(thread.id))
  )
    return "lifecycle-in-flight";

  if (hasQueuedMessage(deps.db, thread.id)) return "queued-message";

  if (
    isThreadQueueAutoSendPaused(deps.db, thread.id) ||
    hasPausedQueue(deps.db, thread.id)
  )
    return "queue-paused";

  if (hasLiveInboxWait(deps.db, thread.id)) return "inbox-wait";

  if (hasActiveProducer(deps.db, thread.id)) return "inbox-producer";

  if (hasTurnBoundInteraction(deps.db, thread.id)) return "pending-interaction";
  const label = buildThreadListEntry(deps, thread.id)?.work?.primary.label;

  if (label === undefined) return "work-unavailable";

  if (!ELIGIBLE_WORK_LABELS.has(label)) return `work-${label}`;
  const rateLimits = rateLimitReason(deps.db, thread.id);

  if (rateLimits !== null) return rateLimits;

  if (
    options.includeTransient &&
    countActiveMaintenanceRuns(deps.db) >= AUTO_COMPACTION_MAX_ACTIVE_RUNS
  )
    return "capacity";

  return null;
}

function latestUsageSequence(
  db: DbQueryConnection,
  args: { threadId: string; sequenceStart: number },
): number | null {
  return (
    db.get<{ sequence: number }>(sql`
      SELECT usage.sequence AS sequence
      FROM events AS usage INDEXED BY events_thread_type_sequence_idx
      WHERE usage.thread_id = ${args.threadId}
        AND usage.type = 'thread/tokenUsage/updated'
        AND usage.sequence >= ${args.sequenceStart}
        AND (
          COALESCE(json_extract(usage.data, '$.tokenUsage.last.inputTokens'), 0)
          + COALESCE(json_extract(usage.data, '$.tokenUsage.last.cachedInputTokens'), 0)
          + COALESCE(json_extract(usage.data, '$.tokenUsage.last.cacheReadInputTokens'), 0)
          + COALESCE(json_extract(usage.data, '$.tokenUsage.last.cacheWriteInputTokens'), 0)
        ) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM events AS nested_turn_started
          WHERE nested_turn_started.thread_id = usage.thread_id
            AND nested_turn_started.turn_id = usage.turn_id
            AND nested_turn_started.type = 'turn/started'
            AND nested_turn_started.parent_tool_call_id IS NOT NULL
        )
      ORDER BY usage.sequence DESC
      LIMIT 1
    `)?.sequence ?? null
  );
}

function assertAutoCompactionCurrent(
  tx: DbQueryConnection,
  args: {
    thread: AutoCompactionThread;
    plan: PlannedAutoCompaction;
    now: number;
  },
): void {
  const { thread, plan } = args;

  if (getThread(tx, thread.id)?.status !== "idle")
    throw new AutoCompactionSupersededError("not-idle");

  const environment =
    thread.environmentId === null
      ? null
      : getEnvironment(tx, thread.environmentId);

  if (environment?.status !== "ready")
    throw new AutoCompactionSupersededError("environment-not-ready");

  if (
    getLastStoredTurnRequestEvent(tx, thread.id)?.sequence !==
    plan.latestRequestSequence
  )
    throw new AutoCompactionSupersededError("new-request");

  if (
    latestUsageSequence(tx, {
      threadId: thread.id,
      sequenceStart: plan.timing.sequenceStart,
    }) !== plan.timing.usageSequence
  )
    throw new AutoCompactionSupersededError("new-usage");

  if (args.now >= plan.timing.lapseAt)
    throw new AutoCompactionSupersededError("lapsed");

  if (readAutoCompactionMetadata(tx, thread.id).disabled)
    throw new AutoCompactionSupersededError("opted-out");
}

function listAutoCompactionCandidateIds(db: DbConnection): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        isNull(threads.archivedAt),
        eq(threads.status, "idle"),
        inArray(threads.providerId, [...AUTO_COMPACTION_PROVIDER_IDS]),
        eq(threads.visibility, "visible"),
        isNull(threads.deletedAt),
        isNull(threads.shelvedAt),
        isNull(threads.parentThreadId),
        isNull(threads.launchedByThreadId),
        isNull(threads.originPluginId),
        eq(environments.status, "ready"),
      ),
    )
    .all()
    .map((row) => row.id);
}

export interface AutoCompactionSweep {
  run(
    deps: LoggedPendingInteractionWorkSessionDeps,
    now: number,
  ): Promise<void>;
}

interface WatchedAutoCompaction {
  usageSequence: number;
  blocker: string | null;
}

export function createAutoCompactionSweep(): AutoCompactionSweep {
  const attemptedUsageSequences = new Map<string, number>();
  const watched = new Map<string, WatchedAutoCompaction>();

  return {
    async run(deps, now) {
      if (!getExperiments(deps.db).autoCompactBeforeCacheExpiry) {
        attemptedUsageSequences.clear();
        watched.clear();

        return;
      }

      const startedAt = Date.now();
      const clock = () => now + (Date.now() - startedAt);
      const candidateIds = listAutoCompactionCandidateIds(deps.db);
      const candidates = new Set(candidateIds);

      for (const threadId of attemptedUsageSequences.keys())
        if (!candidates.has(threadId)) attemptedUsageSequences.delete(threadId);

      for (const threadId of watched.keys())
        if (!candidates.has(threadId)) watched.delete(threadId);

      for (const threadId of candidateIds) {
        const thread = getThread(deps.db, threadId);

        if (thread === null) continue;

        const timing = readAutoCompactionTiming(deps.db, {
          threadId,
          sequenceStart:
            getLatestCompletedThreadContextClearSequence(deps.db, {
              threadId,
            }) ?? 0,
        });

        if (
          "reason" in timing ||
          attemptedUsageSequences.get(threadId) === timing.usageSequence
        ) {
          watched.delete(threadId);

          continue;
        }

        const watch = watched.get(threadId);
        const watching = watch?.usageSequence === timing.usageSequence;

        if (clock() >= timing.lapseAt) {
          if (!watching) continue;
          watched.delete(threadId);
          const plan = planAutoCompactionFromStoredUsage(deps, thread);

          if (
            plan.kind === "planned" &&
            plan.timing.usageSequence === timing.usageSequence
          ) {
            deps.logger.info(
              {
                threadId,
                usageSequence: timing.usageSequence,
                reason: watch.blocker ?? "lapsed",
              },
              "Automatic compaction lapsed before the prompt cache expired",
            );
          }

          continue;
        }

        if (!watching)
          watched.set(threadId, {
            usageSequence: timing.usageSequence,
            blocker: null,
          });

        if (clock() < timing.dueAt) continue;
        const plan = planAutoCompactionFromStoredUsage(deps, thread);

        if (
          plan.kind !== "planned" ||
          plan.timing.usageSequence !== timing.usageSequence
        ) {
          watched.delete(threadId);

          continue;
        }

        const blocker = findAutoCompactionBlocker(deps, thread, {
          includeTransient: true,
        });

        if (blocker !== null) {
          watched.set(threadId, {
            usageSequence: timing.usageSequence,
            blocker,
          });
          deps.logger.debug(
            { threadId, reason: blocker },
            "Skipped automatic compaction before the prompt cache expires",
          );

          continue;
        }

        watched.delete(threadId);
        attemptedUsageSequences.set(threadId, plan.timing.usageSequence);

        try {
          await compactThreadContext(deps, thread, {
            maintenance: "auto-compaction",
            execution: plan.execution,
            beforeAppendInTransaction: ({ tx }) =>
              assertAutoCompactionCurrent(tx, { thread, plan, now: clock() }),
          });
          deps.logger.info(
            { threadId, usageSequence: plan.timing.usageSequence },
            "Started automatic compaction before the prompt cache expires",
          );
        } catch (error) {
          if (error instanceof AutoCompactionSupersededError) {
            deps.logger.debug(
              { threadId, reason: error.reason },
              "Automatic compaction was superseded before it started",
            );
          } else {
            deps.logger.warn(
              { err: error, threadId },
              "Automatic compaction could not start",
            );
          }
        }
      }
    },
  };
}

function disabledState(reason: string): ThreadAutoCompaction {
  return { state: "disabled", at: null, reason, cacheReadShare: null };
}

export function getAutoCompactionState(
  deps: AutoCompactionReadDeps,
  thread: AutoCompactionThread,
  now: number,
): ThreadAutoCompaction {
  const metadata = readAutoCompactionMetadata(deps.db, thread.id);

  if (metadata.disabled) return disabledState("opted-out");
  const maintenance = getLatestMaintenanceRequest(deps.db, thread.id);

  if (maintenance !== null) {
    const outcome = metadata.lastOutcome;

    if (outcome !== null && outcome.requestSequence === maintenance.sequence) {
      return {
        state: outcome.state,
        at: outcome.at,
        reason: outcome.reason,
        cacheReadShare: outcome.cacheReadShare,
      };
    }

    if (thread.status !== "idle" && thread.status !== "error")
      return {
        state: "scheduled",
        at: null,
        reason: "running",
        cacheReadShare: null,
      };
  }

  const plan = planAutoCompactionFromStoredUsage(deps, thread);

  if (plan.kind === "ineligible") return disabledState(plan.reason);
  const dueAt = new Date(plan.timing.dueAt).toISOString();

  if (now >= plan.timing.lapseAt)
    return {
      state: "skipped",
      at: dueAt,
      reason: "lapsed",
      cacheReadShare: null,
    };

  const blocker = findAutoCompactionBlocker(deps, thread, {
    includeTransient: true,
  });

  if (blocker !== null) return disabledState(blocker);

  return { state: "scheduled", at: dueAt, reason: null, cacheReadShare: null };
}

export function withAutoCompactionAt(
  deps: AutoCompactionReadDeps,
  args: {
    thread: AutoCompactionThread;
    usage: ThreadContextWindowUsage;
    sequenceStart: number;
    now: number;
  },
): ThreadContextWindowUsage {
  if (
    args.usage.usedTokens < AUTO_COMPACTION_MIN_CONTEXT_TOKENS ||
    !isAutoCompactionProvider(deps, args.thread.providerId)
  )
    return args.usage;

  const plan = planAutoCompaction(
    deps,
    args.thread,
    args.usage,
    args.sequenceStart,
    { includeOptedOut: true },
  );

  if (
    plan.kind !== "planned" ||
    args.now >= plan.timing.lapseAt ||
    findAutoCompactionBlocker(deps, args.thread, {
      includeTransient: false,
    }) !== null
  )
    return args.usage;

  return {
    ...args.usage,
    autoCompactionAt: new Date(plan.timing.dueAt).toISOString(),
    ...(plan.optedOut ? { autoCompactionOptedOut: true } : {}),
  };
}
