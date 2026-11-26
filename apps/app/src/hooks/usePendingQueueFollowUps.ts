import { useMemo, useSyncExternalStore } from "react";
import type {
  ThreadQueuedMessage,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import {
  readSendOutboxSnapshot,
  subscribeSendOutbox,
} from "@/lib/send-outbox/send-outbox";
import {
  readStagingFollowUps,
  subscribeStagingFollowUps,
} from "@/lib/send-outbox/staging-follow-ups";
import { pendingQueueFollowUps } from "@/lib/send-outbox/timeline-submissions";

export function usePendingQueueFollowUps(
  threadId: string,
  status: ThreadRuntimeDisplayStatus,
  queue: readonly ThreadQueuedMessage[],
): readonly ThreadQueuedMessage[] {
  const staging = useSyncExternalStore(
    subscribeStagingFollowUps,
    readStagingFollowUps,
    readStagingFollowUps,
  );

  const entries = useSyncExternalStore(
    subscribeSendOutbox,
    readSendOutboxSnapshot,
    readSendOutboxSnapshot,
  );

  return useMemo(
    () => pendingQueueFollowUps(threadId, status, staging, entries, queue),
    [threadId, status, staging, entries, queue],
  );
}
