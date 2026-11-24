import { eq, sql } from "drizzle-orm";
import { prepareCachedQuery, type DbQueryConnection } from "../connection.js";
import { threadHistoryEpochs } from "../schema.js";

function historyStateQuery(db: DbQueryConnection) {
  return db
    .select({
      epoch: threadHistoryEpochs.epoch,
      rewriteEpoch: threadHistoryEpochs.rewriteEpoch,
      highWaterSequence: threadHistoryEpochs.highWaterSequence,
    })
    .from(threadHistoryEpochs)
    .where(eq(threadHistoryEpochs.threadId, sql.placeholder("threadId")))
    .prepare();
}

export function getThreadHistoryState(
  db: DbQueryConnection,
  threadId: string,
): { epoch: string; rewriteEpoch: string; highWaterSequence: number } {
  const row = prepareCachedQuery(db, historyStateQuery).get({ threadId });

  if (row === undefined) throw new Error("Missing timeline history epoch");

  return row;
}

export function getThreadHistoryEpoch(
  db: DbQueryConnection,
  threadId: string,
): string {
  return getThreadHistoryState(db, threadId).epoch;
}
