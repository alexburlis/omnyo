import { and, asc, inArray, ne, sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { threadFailures } from "../schema.js";

export function listRetryingFailures(
  db: DbConnection,
  ids: readonly string[],
): Map<string, { id: string; reason: string }> {
  const latest = new Map<
    string,
    { id: string; reason: string; state: string }
  >();

  for (let offset = 0; offset < ids.length; offset += 400) {
    for (const row of db
      .select({
        id: threadFailures.id,
        threadId: threadFailures.threadId,
        state: threadFailures.state,
        reason: threadFailures.reason,
      })
      .from(threadFailures)
      .where(
        and(
          inArray(threadFailures.threadId, ids.slice(offset, offset + 400)),
          ne(threadFailures.state, "resolved"),
        ),
      )
      .orderBy(asc(threadFailures.createdAt), asc(sql`rowid`))
      .all())
      latest.set(row.threadId, row);
  }

  return new Map(
    [...latest]
      .filter(([, row]) => row.state === "held" || row.state === "deciding")
      .map(([threadId, row]) => [threadId, { id: row.id, reason: row.reason }]),
  );
}
