import { useQuery } from "@tanstack/react-query";
import {
  threadTabsResponseSchema,
  type ThreadTabsResponse,
} from "@omnyo/server-contract";
import { sdk } from "@/lib/sdk";
import { newerThreadTabs } from "@/hooks/cache-owners/thread-tabs-cache-owner";
import { threadTabsQueryKey } from "./query-keys";
import { RESUME_REFETCH_QUERY_POLICY } from "./query-policies";

interface ThreadTabsQueryOptions {
  enabled?: boolean;
}

export function useThreadTabs(
  threadId: string,
  options?: ThreadTabsQueryOptions,
) {
  const enabled = (options?.enabled ?? true) && threadId.length > 0;

  return useQuery<ThreadTabsResponse>({
    queryKey: threadTabsQueryKey(threadId),
    queryFn: ({ signal }) => sdk.threads.tabs.get({ threadId, signal }),
    structuralSharing: (cached, response) => {
      const incoming = threadTabsResponseSchema.parse(response);
      const previous = threadTabsResponseSchema.safeParse(cached);

      return newerThreadTabs(
        previous.success ? previous.data : undefined,
        incoming,
      );
    },
    enabled,
    ...RESUME_REFETCH_QUERY_POLICY,
  });
}
