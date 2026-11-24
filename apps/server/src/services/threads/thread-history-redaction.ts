import {
  getThreadEventTypeWatermark,
  getThreadHistoryState,
  listStoredEventRows,
  type DbConnection,
} from "@omnyo/db";
import {
  buildThreadEvent,
  buildThreadEventRow,
  CredentialRedactionError,
  isCredentialField,
  maskProviderEnvironmentEvent,
  redactCredentialPayload,
  type CredentialRedactionOptions,
  type ThreadEventRow,
} from "@omnyo/domain";
import { ApiError } from "../../errors.js";
import { parseStoredEvent } from "./thread-data.js";
import type { TimelineRow } from "@omnyo/server-contract";

export function historyRedactionLimitError(): ApiError {
  return new ApiError(
    413,
    "history_redaction_limit",
    "History could not be safely redacted; content withheld",
  );
}

interface CredentialValuesCacheEntry {
  count: number;
  maxSequence: number | null;
  rewriteEpoch: string;
  values: readonly string[];
}

const CREDENTIAL_VALUES_CACHE_THREADS = 256;

const credentialValuesByConnection = new WeakMap<
  DbConnection,
  Map<string, CredentialValuesCacheEntry>
>();

export function loadThreadHistoryCredentialValues(
  db: DbConnection,
  threadId: string,
): readonly string[] {
  const watermark = {
    ...getThreadEventTypeWatermark(db, {
      threadId,
      type: "provider.env-resolved",
    }),
    rewriteEpoch: getThreadHistoryState(db, threadId).rewriteEpoch,
  };

  if (watermark.count > 1024) throw historyRedactionLimitError();

  const cache =
    credentialValuesByConnection.get(db) ??
    new Map<string, CredentialValuesCacheEntry>();

  credentialValuesByConnection.set(db, cache);
  const cached = cache.get(threadId);
  cache.delete(threadId);

  const entry =
    cached !== undefined &&
    cached.count === watermark.count &&
    cached.maxSequence === watermark.maxSequence &&
    cached.rewriteEpoch === watermark.rewriteEpoch
      ? cached
      : {
          ...watermark,
          values: Object.freeze(
            readThreadHistoryCredentialValues(db, threadId),
          ),
        };

  cache.set(threadId, entry);

  const [oldestThreadId] = cache.keys();

  if (
    cache.size > CREDENTIAL_VALUES_CACHE_THREADS &&
    oldestThreadId !== undefined
  ) {
    cache.delete(oldestThreadId);
  }

  return entry.values;
}

function readThreadHistoryCredentialValues(
  db: DbConnection,
  threadId: string,
): string[] {
  const rows = listStoredEventRows(db, {
    threadId,
    types: ["provider.env-resolved"],
    limit: 1025,
  });

  if (rows.length > 1024) throw historyRedactionLimitError();

  return rows.flatMap((row) => {
    const event = parseStoredEvent(row);

    if (event.type !== "provider.env-resolved") return [];

    return event.entries.flatMap((entry) =>
      isCredentialField(entry.name) && typeof entry.value === "string"
        ? [entry.value]
        : [],
    );
  });
}

export function redactThreadHistory<T extends object>(
  db: DbConnection,
  threadId: string,
  value: T,
  options: CredentialRedactionOptions = {},
): T {
  try {
    return redactCredentialPayload(
      value,
      loadThreadHistoryCredentialValues(db, threadId),
      options,
    );
  } catch (error) {
    if (error instanceof CredentialRedactionError) throw historyRedactionLimitError();
    throw error;
  }
}

export function redactThreadHistoryTimelineRows(
  db: DbConnection,
  threadId: string,
  rows: readonly TimelineRow[],
): TimelineRow[] {
  const values = loadThreadHistoryCredentialValues(db, threadId);

  const visit = (row: TimelineRow, depth: number): TimelineRow => {
    if (depth > 64) throw historyRedactionLimitError();

    if (row.kind === "turn" && row.children !== null) {
      const { children, ...envelope } = row;

      return {
        ...redactCredentialPayload(envelope, values, {
          invalidJsonText: "withhold",
        }),
        children: children.map((child) => visit(child, depth + 2)),
      };
    }

    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.childRows !== null
    ) {
      const { childRows, ...envelope } = row;

      return {
        ...redactCredentialPayload(envelope, values, {
          invalidJsonText: "withhold",
        }),
        childRows: childRows.map((child) => visit(child, depth + 2)),
      };
    }

    return redactCredentialPayload(row, values, {
      invalidJsonText: "withhold",
    });
  };

  try {
    return rows.map((row) => visit(row, 0));
  } catch (error) {
    if (error instanceof CredentialRedactionError) throw historyRedactionLimitError();
    throw error;
  }
}

export function redactThreadHistoryEvent(row: ThreadEventRow): ThreadEventRow {
  return buildThreadEventRow({
    id: row.id,
    scope: row.scope,
    threadId: row.threadId,
    seq: row.seq,
    createdAt: row.createdAt,
    event: maskProviderEnvironmentEvent(buildThreadEvent(row)),
  });
}
