import type { InboxSnapshot } from "@omnyo/domain";
import {
  isThreadListRelevantChange,
  type NotificationHub,
} from "../../ws/hub.js";

export const SHARED_INBOX_SNAPSHOT_MAX_AGE_MS = 2_000;

export function createSharedInboxSnapshot(args: {
  hub: Pick<NotificationHub, "onThreadChanged">;
  collect: (now: number) => InboxSnapshot;
  now?: () => number;
}): () => InboxSnapshot {
  const clock = args.now ?? Date.now;
  let shared: { snapshot: InboxSnapshot; at: number } | null = null;

  args.hub.onThreadChanged((_threadId, changes, metadata) => {
    if (isThreadListRelevantChange({ changes, metadata })) shared = null;
  });

  return () => {
    const now = clock();

    if (
      shared !== null &&
      now >= shared.at &&
      now - shared.at < SHARED_INBOX_SNAPSHOT_MAX_AGE_MS
    )
      return shared.snapshot;

    const snapshot = args.collect(now);
    shared = { snapshot, at: now };

    return snapshot;
  };
}
