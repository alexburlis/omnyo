import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  prepareCachedQuery,
  type DbConnection,
  type DbQueryConnection,
} from "../connection.js";
import { threadTimelineRecords } from "../schema.js";

export interface ThreadTimelineRecordInput {
  key: string;
  threadId: string;
  body: string;
  kind: "page" | "root";
  createdAt: number;
  expiresAt: number | null;
}

export interface ThreadTimelineRecordLimits {
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
}

function recordQuery(db: DbQueryConnection) {
  return db
    .select()
    .from(threadTimelineRecords)
    .where(
      and(
        eq(threadTimelineRecords.key, sql.placeholder("key")),
        lte(threadTimelineRecords.createdAt, sql.placeholder("now")),
        or(
          isNull(threadTimelineRecords.expiresAt),
          gt(threadTimelineRecords.expiresAt, sql.placeholder("now")),
        ),
      ),
    )
    .prepare();
}

export function getThreadTimelineRecord(
  db: DbQueryConnection,
  args: { key: string; now: number },
) {
  return prepareCachedQuery(db, recordQuery).get(args) ?? null;
}

export function putThreadTimelineRecord(
  db: DbConnection,
  args: ThreadTimelineRecordInput,
  limits: ThreadTimelineRecordLimits,
): void {
  const byteSize = Buffer.byteLength(args.body, "utf8");
  db.transaction(
    (tx) => {
      tx.delete(threadTimelineRecords)
        .where(eq(threadTimelineRecords.key, args.key))
        .run();

      if (
        byteSize > limits.maxEntryBytes ||
        byteSize > limits.maxBytes ||
        limits.maxEntries < 1
      )
        return;
      tx.insert(threadTimelineRecords)
        .values({ ...args, byteSize })
        .run();
      tx.run(sql`
      DELETE FROM thread_timeline_records WHERE key IN (
        SELECT key FROM (
          SELECT key,
            SUM(byte_size) OVER (ORDER BY created_at DESC, key DESC ROWS UNBOUNDED PRECEDING) AS retained_bytes,
            ROW_NUMBER() OVER (ORDER BY created_at DESC, key DESC) AS retained_count
          FROM thread_timeline_records
        ) WHERE retained_bytes > ${limits.maxBytes} OR retained_count > ${limits.maxEntries}
      )
    `);
    },
    { behavior: "immediate" },
  );
}
