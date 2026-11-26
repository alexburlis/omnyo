import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import {
  type PendingSentMessage,
  getPendingSentMessages,
  subscribePendingSentMessages,
} from "@/hooks/cache-owners/pending-sent-messages";
import type {
  ThreadQueuedMessage,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import type { ThreadResponse } from "@omnyo/server-contract";
import {
  pendingTimelineSubmissions,
  queuedSubmissionIds,
} from "@/lib/send-outbox/timeline-submissions";
import {
  readSendOutboxSnapshot,
  subscribeSendOutbox,
} from "@/lib/send-outbox/send-outbox";
import {
  readStagingFollowUps,
  subscribeStagingFollowUps,
} from "@/lib/send-outbox/staging-follow-ups";

export function usePendingTimelineMessages(threadId: string) {
  const queryClient = useQueryClient();

  const pendingSentMessages = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        subscribePendingSentMessages(queryClient, listener),
      [queryClient],
    ),
    () => getPendingSentMessages(queryClient, threadId),
  );

  const entries = useSyncExternalStore(
    subscribeSendOutbox,
    readSendOutboxSnapshot,
  );

  const { data: queue } = useQuery<ThreadQueuedMessage[]>({
    queryKey: threadQueuedMessagesQueryKey(threadId),
    enabled: false,
  });

  const { data: status } = useQuery<
    ThreadResponse,
    Error,
    ThreadRuntimeDisplayStatus
  >({
    queryKey: threadQueryKey(threadId),
    enabled: false,
    select: (thread) => thread.runtime.displayStatus,
  });

  const staging = useSyncExternalStore(
    subscribeStagingFollowUps,
    readStagingFollowUps,
  );

  const stagingRows = useMemo(
    () => pendingTimelineSubmissions(threadId, status, staging, [], []),
    [threadId, status, staging],
  );

  const submissions = useMemo(
    () =>
      pendingTimelineSubmissions(threadId, status, [], entries, queue ?? []),
    [threadId, status, entries, queue],
  );

  const [retained, setRetained] = useState<readonly PendingSentMessage[]>([]);
  useEffect(() => {
    let current = true;

    const missing = retained.some(
      (entry) =>
        entry.row.threadId === threadId &&
        !submissions.some((item) => item.row.id === entry.row.id),
    );

    if (!missing) {
      setRetained(submissions);
    } else {
      void queryClient
        .invalidateQueries(
          { queryKey: threadQueuedMessagesQueryKey(threadId) },
          { throwOnError: true },
        )
        .then(() =>
          queryClient.invalidateQueries(
            { queryKey: threadTimelineQueryKey(threadId) },
            { throwOnError: true },
          ),
        )
        .then(() => {
          if (current) setRetained(submissions);
        })
        .catch((error: unknown) =>
          console.warn(
            "Could not refresh the chat after background delivery",
            error,
          ),
        );
    }

    return () => {
      current = false;
    };
  }, [queryClient, retained, submissions, threadId]);

  const inQueue = useMemo(
    () => queuedSubmissionIds(threadId, status, staging, entries, queue ?? []),
    [threadId, status, staging, entries, queue],
  );

  return useMemo(() => {
    if (!retained.length && !submissions.length && !stagingRows.length)
      return pendingSentMessages;
    const rows = new Map<string, PendingSentMessage>();

    for (const item of [
      ...retained,
      ...pendingSentMessages,
      ...stagingRows,
      ...submissions,
    ]) {
      const { submissionId } = item.row.turnRequest;

      if (
        item.row.threadId === threadId &&
        (submissionId == null || !inQueue.has(submissionId)) &&
        !entries.some(
          (entry) =>
            entry.submissionId === item.row.turnRequest.submissionId &&
            entry.state.kind === "paused",
        )
      )
        rows.set(item.row.id, item);
    }

    return [...rows.values()].sort((a, b) => a.row.createdAt - b.row.createdAt);
  }, [
    entries,
    inQueue,
    pendingSentMessages,
    retained,
    stagingRows,
    submissions,
    threadId,
  ]);
}
