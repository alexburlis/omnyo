import { sql } from "drizzle-orm";
import type { DbQueryConnection } from "@omnyo/db";
import {
  systemThreadInterruptedEventDataSchema,
  threadEventTokenUsageBreakdownSchema,
  threadMaintenanceKindSchema,
  type ThreadLifecycleEvent,
} from "@omnyo/domain";
import { z } from "zod";
import {
  getLatestMaintenanceRequest,
  readAutoCompactionMetadata,
  writeAutoCompactionMetadata,
  type AutoCompactionOutcome,
  type AutoCompactionOutcomeState,
  type MaintenanceRequest,
} from "./maintenance-run.js";

const tokenUsageDataSchema = z.object({
  tokenUsage: z.object({ last: threadEventTokenUsageBreakdownSchema }),
});

const errorDataSchema = z.object({ message: z.string().min(1) });

export interface MaintenanceRunEndHint {
  outcome: "completed" | "failed" | "stopped" | "suspended";
  reason: string | null;
}

export function isMaintenanceTurnRequest(
  db: DbQueryConnection,
  args: { threadId: string; requestId: string },
): boolean {
  const row = db.get<{ maintenance: string | null }>(sql`
    SELECT json_extract(data, '$.maintenance') AS maintenance
    FROM events INDEXED BY events_thread_type_sequence_idx
    WHERE thread_id = ${args.threadId}
      AND type = 'client/turn/requested'
      AND json_extract(data, '$.requestId') = ${args.requestId}
    ORDER BY sequence DESC
    LIMIT 1
  `);

  return threadMaintenanceKindSchema.safeParse(row?.maintenance).success;
}

export function maintenanceLifecycleEvent(
  event: ThreadLifecycleEvent,
): ThreadLifecycleEvent {
  return event.type === "run.failed" ? { type: "run.succeeded" } : event;
}

function latestInterruptionReason(
  db: DbQueryConnection,
  args: { threadId: string; afterSequence: number },
): string | null {
  const row = db.get<{ data: string }>(sql`
    SELECT data
    FROM events INDEXED BY events_thread_type_sequence_idx
    WHERE thread_id = ${args.threadId}
      AND type = 'system/thread/interrupted'
      AND sequence > ${args.afterSequence}
    ORDER BY sequence DESC
    LIMIT 1
  `);

  if (row === undefined) return null;

  const parsed = systemThreadInterruptedEventDataSchema.safeParse(
    JSON.parse(row.data),
  );

  return parsed.success ? parsed.data.reason : "interrupted";
}

function latestErrorMessage(
  db: DbQueryConnection,
  args: { threadId: string; afterSequence: number },
): string | null {
  const row = db.get<{ data: string }>(sql`
    SELECT data
    FROM events
    WHERE thread_id = ${args.threadId}
      AND type IN ('provider/error', 'system/error')
      AND sequence > ${args.afterSequence}
    ORDER BY sequence DESC
    LIMIT 1
  `);

  if (row === undefined) return null;

  return errorDataSchema.safeParse(JSON.parse(row.data)).data?.message ?? null;
}

export function maintenanceCacheReadShare(
  db: DbQueryConnection,
  args: { threadId: string; request: MaintenanceRequest },
): number | null {
  const turnFilter =
    args.request.turnId === null
      ? sql``
      : sql`AND usage.turn_id = ${args.request.turnId}`;

  const row = db.get<{ data: string }>(sql`
    SELECT usage.data AS data
    FROM events AS usage INDEXED BY events_thread_type_sequence_idx
    WHERE usage.thread_id = ${args.threadId}
      AND usage.type = 'thread/tokenUsage/updated'
      AND usage.sequence > ${args.request.sequence}
      ${turnFilter}
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
  `);

  if (row === undefined) return null;
  const parsed = tokenUsageDataSchema.safeParse(JSON.parse(row.data));

  if (!parsed.success) return null;
  const usage = parsed.data.tokenUsage.last;
  const cacheRead = usage.cacheReadInputTokens ?? 0;

  const input =
    usage.inputTokens + cacheRead + (usage.cacheWriteInputTokens ?? 0);

  return input > 0 ? cacheRead / input : null;
}

function maintenanceOutcomeState(
  db: DbQueryConnection,
  args: {
    threadId: string;
    request: MaintenanceRequest;
    event: ThreadLifecycleEvent;
    hint: MaintenanceRunEndHint | undefined;
  },
): { state: AutoCompactionOutcomeState; reason: string | null } {
  const interruption = latestInterruptionReason(db, {
    threadId: args.threadId,
    afterSequence: args.request.sequence,
  });

  if (
    args.event.type === "stop.settled" ||
    args.hint?.outcome === "stopped" ||
    args.hint?.outcome === "suspended" ||
    (args.event.type === "run.failed" && interruption !== null)
  )
    return { state: "stopped", reason: interruption };

  if (args.event.type === "run.failed" || args.hint?.outcome === "failed")
    return {
      state: "failed",
      reason:
        args.hint?.reason ??
        latestErrorMessage(db, {
          threadId: args.threadId,
          afterSequence: args.request.sequence,
        }),
    };

  return { state: "done", reason: null };
}

export function recordMaintenanceRunEnd(
  db: DbQueryConnection,
  args: {
    threadId: string;
    request: MaintenanceRequest;
    event: ThreadLifecycleEvent;
    hint: MaintenanceRunEndHint | undefined;
    now: number;
  },
): AutoCompactionOutcome {
  const { state, reason } = maintenanceOutcomeState(db, args);

  const lastOutcome: AutoCompactionOutcome = {
    requestSequence: args.request.sequence,
    state,
    reason,
    cacheReadShare: maintenanceCacheReadShare(db, args),
    at: new Date(args.now).toISOString(),
  };

  writeAutoCompactionMetadata(db, args.threadId, {
    ...readAutoCompactionMetadata(db, args.threadId),
    lastOutcome,
  });

  return lastOutcome;
}

export function refreshMaintenanceCacheReadShare(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  const request = getLatestMaintenanceRequest(db, threadId);

  if (request === null) return false;
  const metadata = readAutoCompactionMetadata(db, threadId);
  const outcome = metadata.lastOutcome;

  if (
    outcome === null ||
    outcome.requestSequence !== request.sequence ||
    outcome.cacheReadShare !== null
  )
    return false;

  const cacheReadShare = maintenanceCacheReadShare(db, { threadId, request });

  if (cacheReadShare === null) return false;

  writeAutoCompactionMetadata(db, threadId, {
    ...metadata,
    lastOutcome: { ...outcome, cacheReadShare },
  });

  return true;
}
