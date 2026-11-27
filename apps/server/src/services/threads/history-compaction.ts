import type { AppDeps } from "../../types.js";
import { purgeHistoryCacheThread } from "./history-cache-writer.js";

export async function purgeCompactedThreadHistories(
  deps: Pick<AppDeps, "db" | "hub">,
  threadIds: ReadonlySet<string>,
  failureMessage = "Compacted history cache cleanup failed",
): Promise<void> {
  const failures: unknown[] = [];

  for (const threadId of threadIds)
    deps.hub.notifyThread(threadId, ["history-compacted"]);

  for (const threadId of threadIds) {
    try {
      await purgeHistoryCacheThread(deps.db, threadId);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) throw new AggregateError(failures, failureMessage);
}
