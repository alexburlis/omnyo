import type { QueryClient } from "@tanstack/react-query";
import type {
  ThreadTimelineResponse,
  TimelineRow,
} from "@omnyo/server-contract";
import {
  getPendingSentMessages,
  withPendingSentMessages,
} from "@/hooks/cache-owners/pending-sent-messages";
import type { threadTimelineQueryKey } from "@/hooks/queries/query-keys";

export function displayedTimelineRows(
  queryClient: QueryClient,
  timelineKey: ReturnType<typeof threadTimelineQueryKey>,
): TimelineRow[] | undefined {
  const timeline =
    queryClient.getQueryData<ThreadTimelineResponse>(timelineKey);

  if (timeline === undefined) return undefined;
  const threadId = timelineKey[1];

  return withPendingSentMessages({
    maxSeq: timeline.maxSeq,
    pending: getPendingSentMessages(queryClient, threadId),
    rows: timeline.rows,
    threadId,
  });
}
