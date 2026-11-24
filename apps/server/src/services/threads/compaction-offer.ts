import { sql } from "drizzle-orm";
import {
  getAppSettings,
  getLastStoredTurnRequestEvent,
  getLatestRequestTokenUsageRow,
  type DbConnection,
  type DbQueryConnection,
} from "@omnyo/db";
import {
  isStandaloneBuiltinCompactCommand,
  parseStoredThreadEvent,
  threadScope,
} from "@omnyo/domain";
import type { ThreadContextWindowUsage } from "@omnyo/server-contract";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { readAutoCompactionMetadata } from "./maintenance-run.js";
import { parseStoredEvent, parseStoredEventPayload } from "./thread-data.js";

const COMPACTION_OFFER_MIN_TOKENS = 100_000;

interface CompactionOfferDeps {
  db: DbConnection;
  providerRegistry: Pick<ProviderRegistryService, "supportsManualCompaction">;
}

export function isCompactionOfferEnabled(
  deps: CompactionOfferDeps,
  providerId: string,
): boolean {
  return (
    getAppSettings(deps.db).compactExpiredCache &&
    deps.providerRegistry.supportsManualCompaction(providerId)
  );
}

function latestStandaloneCompactionSequence(
  db: DbQueryConnection,
  threadId: string,
): number | null {
  const row = getLastStoredTurnRequestEvent(db, threadId);

  if (row === null) return null;

  const event = parseStoredThreadEvent({
    type: row.type,
    data: parseStoredEventPayload(row),
    threadId: row.threadId,
    scope: threadScope(),
  });

  return event.type === "client/turn/requested" &&
    isStandaloneBuiltinCompactCommand(event.input)
    ? row.sequence
    : null;
}

export function isLatestRequestStandaloneCompaction(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return latestStandaloneCompactionSequence(db, threadId) !== null;
}

function latestEventTypeAfter(
  db: DbQueryConnection,
  args: { threadId: string; afterSequence: number },
): string | null {
  return (
    db.get<{ type: string }>(sql`
      SELECT type
      FROM events INDEXED BY events_thread_type_sequence_idx
      WHERE thread_id = ${args.threadId}
        AND type IN ('thread/compacted', 'turn/completed')
        AND sequence > ${args.afterSequence}
      ORDER BY CASE type WHEN 'thread/compacted' THEN 0 ELSE 1 END
      LIMIT 1
    `)?.type ?? null
  );
}

function latestCompactionKeptFullHistory(
  db: DbQueryConnection,
  args: { threadId: string; requestSequence: number },
): boolean {
  const ended = latestEventTypeAfter(db, {
    threadId: args.threadId,
    afterSequence: args.requestSequence,
  });

  if (ended === "thread/compacted") return false;

  if (ended === "turn/completed") return true;

  const outcome = readAutoCompactionMetadata(db, args.threadId).lastOutcome;

  return (
    outcome !== null &&
    outcome.requestSequence === args.requestSequence &&
    outcome.state !== "done"
  );
}

function suppressesCompactionOffer(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  const requestSequence = latestStandaloneCompactionSequence(db, threadId);

  if (requestSequence === null) return false;

  return !latestCompactionKeptFullHistory(db, { threadId, requestSequence });
}

interface WithCompactionOfferArgs {
  enabled: boolean;
  sequenceStart: number;
  threadId: string;
  usage: ThreadContextWindowUsage;
}

export function withCompactionOffer(
  db: DbConnection,
  args: WithCompactionOfferArgs,
): ThreadContextWindowUsage {
  if (!args.enabled || args.usage.usedTokens < COMPACTION_OFFER_MIN_TOKENS) {
    return args.usage;
  }

  const row = getLatestRequestTokenUsageRow(db, {
    sequenceStart: args.sequenceStart,
    threadId: args.threadId,
  });

  if (row === null) return args.usage;
  const event = parseStoredEvent(row);

  if (
    event.type !== "thread/tokenUsage/updated" ||
    event.tokenUsage.promptCacheTtlMs === undefined ||
    suppressesCompactionOffer(db, args.threadId)
  ) {
    return args.usage;
  }

  return {
    ...args.usage,
    compactionOfferAt: new Date(
      row.createdAt + event.tokenUsage.promptCacheTtlMs,
    ).toISOString(),
  };
}
