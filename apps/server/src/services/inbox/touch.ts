import { desc, eq, max } from "drizzle-orm";
import { threadMoves, threadOwnerInputs, type DbQueryConnection } from "@omnyo/db";
import { inboxRootOf } from "./family.js";

export function lastOwnerTouchAt(
  db: DbQueryConnection,
  threadId: string,
): number | null {
  const input = db
    .select({ at: max(threadOwnerInputs.createdAt) })
    .from(threadOwnerInputs)
    .where(eq(threadOwnerInputs.threadId, threadId))
    .get();

  const rootId = inboxRootOf(db, threadId)?.id ?? threadId;

  const move = db
    .select({ at: threadMoves.createdAt })
    .from(threadMoves)
    .where(eq(threadMoves.rootThreadId, rootId))
    .orderBy(desc(threadMoves.createdAt))
    .limit(1)
    .get();

  const values = [input?.at ?? null, move?.at ?? null].filter(
    (value): value is number => value !== null,
  );

  return values.length === 0 ? null : Math.max(...values);
}
