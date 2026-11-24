import {
  getLatestCompletedThreadContextClearSequence,
  listContextWindowUsageRows,
  type DbConnection,
} from "@omnyo/db";
import type { ThreadContextWindowUsage } from "@omnyo/server-contract";
import { extractThreadContextWindowUsage } from "@omnyo/thread-view";
import { toThreadEventWithMeta } from "./timeline.js";

export interface ThreadContextWindowUsageReading {
  sequenceStart: number;
  usage: ThreadContextWindowUsage | null;
}

export function readThreadContextWindowUsage(
  db: DbConnection,
  threadId: string,
): ThreadContextWindowUsageReading {
  const sequenceStart =
    getLatestCompletedThreadContextClearSequence(db, { threadId }) ?? 0;

  const rows = listContextWindowUsageRows(db, { threadId, sequenceStart });

  return {
    sequenceStart,
    usage: extractThreadContextWindowUsage(rows.map(toThreadEventWithMeta)),
  };
}
