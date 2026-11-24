import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  threadQueuedMessagesQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import {
  type PendingSentMessage,
  getPendingSentMessages,
  subscribePendingSentMessages,
} from "@/hooks/cache-owners/pending-sent-messages";
import type { ThreadQueuedMessage } from "@omnyo/domain";
import { pendingTimelineSubmissions } from "@/lib/send-outbox/timeline-submissions";
import {
  readSendOutboxSnapshot,
  subscribeSendOutbox,
} from "@/lib/send-outbox/send-outbox";

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

  const submissions = useMemo(
    () => pendingTimelineSubmissions(threadId, entries, queue ?? []),
    [threadId, entries, queue],
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

  return useMemo(() => {
    if (!retained.length && !submissions.length) return pendingSentMessages;
    const rows = new Map<string, PendingSentMessage>();

    for (const item of [...retained, ...pendingSentMessages, ...submissions]) {
      if (
        item.row.threadId === threadId &&
        !entries.some(
          (entry) =>
            entry.submissionId === item.row.turnRequest.submissionId &&
            entry.state.kind === "paused",
        )
      )
        rows.set(item.row.id, item);
    }

    return [...rows.values()].sort((a, b) => a.row.createdAt - b.row.createdAt);
  }, [entries, pendingSentMessages, retained, submissions, threadId]);
}
