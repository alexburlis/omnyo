import { and, eq, sql } from "drizzle-orm";
import {
  getThreadConversationSequences,
  threadPluginMetadata,
  type DbQueryConnection,
  type ThreadConversationSequences,
} from "@omnyo/db";
import {
  parsePersistedPluginMetadata,
  threadMaintenanceKindSchema,
  type Thread,
  type ThreadMaintenanceKind,
} from "@omnyo/domain";
import { z } from "zod";

export const AUTO_COMPACTION_METADATA_NAMESPACE = "omnyo-core-auto-compaction";

const AUTO_COMPACTION_METADATA_KEY = "autoCompaction";

const LAST_OUTCOME_REQUEST_SEQUENCE_PATH = `$.${AUTO_COMPACTION_METADATA_KEY}.lastOutcome.requestSequence`;

const sequenceSchema = z.number().int().nonnegative();

const autoCompactionBasisSnapshotSchema = z.object({
  requestSequence: sequenceSchema,
  lastInput: sequenceSchema,
  lastStarted: sequenceSchema,
  lastCompleted: sequenceSchema,
});

export type AutoCompactionBasisSnapshot = z.infer<
  typeof autoCompactionBasisSnapshotSchema
>;

export const autoCompactionOutcomeStateSchema = z.enum([
  "done",
  "failed",
  "stopped",
]);

export type AutoCompactionOutcomeState = z.infer<
  typeof autoCompactionOutcomeStateSchema
>;

const autoCompactionOutcomeSchema = z.object({
  requestSequence: sequenceSchema,
  state: autoCompactionOutcomeStateSchema,
  reason: z.string().nullable(),
  cacheReadShare: z.number().min(0).max(1).nullable(),
  at: z.iso.datetime(),
});

export type AutoCompactionOutcome = z.infer<typeof autoCompactionOutcomeSchema>;

const autoCompactionMetadataSchema = z.object({
  disabled: z.boolean(),
  basisSnapshot: autoCompactionBasisSnapshotSchema.nullable(),
  lastOutcome: autoCompactionOutcomeSchema.nullable(),
});

export type AutoCompactionMetadata = z.infer<
  typeof autoCompactionMetadataSchema
>;

const defaultAutoCompactionMetadata: AutoCompactionMetadata = {
  disabled: false,
  basisSnapshot: null,
  lastOutcome: null,
};

const unreadableAutoCompactionMetadata: AutoCompactionMetadata = {
  disabled: true,
  basisSnapshot: null,
  lastOutcome: null,
};

export interface MaintenanceRequest {
  sequence: number;
  kind: ThreadMaintenanceKind;
  turnId: string | null;
}

export function getLatestMaintenanceRequest(
  db: DbQueryConnection,
  threadId: string,
): MaintenanceRequest | null {
  const latest = db.get<{
    sequence: number;
    requestId: string | null;
    maintenance: string | null;
  }>(sql`
    SELECT sequence,
      json_extract(data, '$.requestId') AS requestId,
      json_extract(data, '$.maintenance') AS maintenance
    FROM events INDEXED BY events_thread_type_sequence_idx
    WHERE thread_id = ${threadId} AND type = 'client/turn/requested'
    ORDER BY sequence DESC
    LIMIT 1
  `);

  if (latest === undefined) return null;
  const kind = threadMaintenanceKindSchema.safeParse(latest.maintenance);

  if (!kind.success) return null;

  const accepted =
    latest.requestId === null
      ? undefined
      : db.get<{ turnId: string | null }>(sql`
          SELECT turn_id AS turnId
          FROM events INDEXED BY events_thread_type_sequence_idx
          WHERE thread_id = ${threadId}
            AND type = 'turn/input/accepted'
            AND sequence > ${latest.sequence}
            AND json_extract(data, '$.clientRequestId') = ${latest.requestId}
          ORDER BY sequence ASC
          LIMIT 1
        `);

  return {
    sequence: latest.sequence,
    kind: kind.data,
    turnId: accepted?.turnId ?? null,
  };
}

export function getOpenMaintenanceRequest(
  db: DbQueryConnection,
  threadId: string,
): MaintenanceRequest | null {
  const request = getLatestMaintenanceRequest(db, threadId);

  if (request === null) return null;

  return readAutoCompactionMetadata(db, threadId).lastOutcome
    ?.requestSequence === request.sequence
    ? null
    : request;
}

export function activeMaintenanceKind(
  db: DbQueryConnection,
  thread: Pick<Thread, "id" | "status">,
): ThreadMaintenanceKind | null {
  if (thread.status === "idle" || thread.status === "error") return null;

  return getOpenMaintenanceRequest(db, thread.id)?.kind ?? null;
}

export function isMaintenanceRunActive(
  db: DbQueryConnection,
  thread: Pick<Thread, "id" | "status">,
): boolean {
  return activeMaintenanceKind(db, thread) !== null;
}

export function countActiveMaintenanceRuns(db: DbQueryConnection): number {
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(*) AS count
    FROM (
      SELECT threads.id AS thread_id,
        (
          SELECT events.sequence
          FROM events INDEXED BY events_thread_type_sequence_idx
          WHERE events.thread_id = threads.id
            AND events.type = 'client/turn/requested'
          ORDER BY events.sequence DESC
          LIMIT 1
        ) AS request_sequence,
        (
          SELECT json_extract(events.data, '$.maintenance')
          FROM events INDEXED BY events_thread_type_sequence_idx
          WHERE events.thread_id = threads.id
            AND events.type = 'client/turn/requested'
          ORDER BY events.sequence DESC
          LIMIT 1
        ) AS maintenance
      FROM threads
      WHERE threads.status NOT IN ('idle', 'error')
    ) AS running
    WHERE running.maintenance IN (${sql.join(
      threadMaintenanceKindSchema.options.map((kind) => sql`${kind}`),
      sql`, `,
    )})
      AND NOT EXISTS (
        SELECT 1
        FROM thread_plugin_metadata AS metadata
        WHERE metadata.thread_id = running.thread_id
          AND metadata.plugin_id = ${AUTO_COMPACTION_METADATA_NAMESPACE}
          AND json_extract(
            metadata.metadata_json,
            ${LAST_OUTCOME_REQUEST_SEQUENCE_PATH}
          ) = running.request_sequence
      )
  `);

  return row?.count ?? 0;
}

export function readAutoCompactionMetadata(
  db: DbQueryConnection,
  threadId: string,
): AutoCompactionMetadata {
  const row = db
    .select({ metadataJson: threadPluginMetadata.metadataJson })
    .from(threadPluginMetadata)
    .where(
      and(
        eq(threadPluginMetadata.threadId, threadId),
        eq(threadPluginMetadata.pluginId, AUTO_COMPACTION_METADATA_NAMESPACE),
      ),
    )
    .get();

  if (row === undefined) return defaultAutoCompactionMetadata;
  const metadata = parsePersistedPluginMetadata(row.metadataJson);
  const stored = metadata?.[AUTO_COMPACTION_METADATA_KEY];

  if (stored === undefined) {
    return metadata === undefined
      ? unreadableAutoCompactionMetadata
      : defaultAutoCompactionMetadata;
  }

  const parsed = autoCompactionMetadataSchema.safeParse(stored);

  return parsed.success ? parsed.data : unreadableAutoCompactionMetadata;
}

export function writeAutoCompactionMetadata(
  db: DbQueryConnection,
  threadId: string,
  value: AutoCompactionMetadata,
): void {
  const metadataJson = JSON.stringify({
    [AUTO_COMPACTION_METADATA_KEY]: autoCompactionMetadataSchema.parse(value),
  });

  db.insert(threadPluginMetadata)
    .values({
      threadId,
      pluginId: AUTO_COMPACTION_METADATA_NAMESPACE,
      metadataJson,
    })
    .onConflictDoUpdate({
      target: [threadPluginMetadata.threadId, threadPluginMetadata.pluginId],
      set: { metadataJson },
    })
    .run();
}

export function readAutoCompactionBasis(
  db: DbQueryConnection,
  threadId: string,
): ThreadConversationSequences {
  return (
    getThreadConversationSequences(db, [threadId])[threadId] ?? {
      lastInput: 0,
      lastStarted: 0,
      lastCompleted: 0,
    }
  );
}

export function recordAutoCompactionBasisSnapshot(
  db: DbQueryConnection,
  args: {
    threadId: string;
    requestSequence: number;
    conversation: ThreadConversationSequences;
  },
): AutoCompactionBasisSnapshot {
  const basisSnapshot: AutoCompactionBasisSnapshot = {
    requestSequence: args.requestSequence,
    lastInput: args.conversation.lastInput,
    lastStarted: args.conversation.lastStarted,
    lastCompleted: args.conversation.lastCompleted,
  };

  writeAutoCompactionMetadata(db, args.threadId, {
    ...readAutoCompactionMetadata(db, args.threadId),
    basisSnapshot,
  });

  return basisSnapshot;
}
