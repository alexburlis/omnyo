import { and, desc, eq, sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { events } from "../schema.js";

export function listRecentCompletedCommandHeaders(
  db: DbConnection,
  args: { threadId: string; completedEventLimit: number },
) {
  const completed = db
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, "item/completed"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(args.completedEventLimit)
    .as("completed_window");

  return db
    .select({
      sequence: events.sequence,
      command: sql<string>`json_extract(${events.data}, '$.item.command')`,
    })
    .from(events)
    .innerJoin(completed, eq(events.sequence, completed.sequence))
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, "item/completed"),
        eq(events.itemKind, "commandExecution"),
      ),
    )
    .orderBy(desc(events.sequence))
    .all();
}
