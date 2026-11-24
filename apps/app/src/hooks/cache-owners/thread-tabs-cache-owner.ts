import type { QueryClient } from "@tanstack/react-query";
import type { ThreadTabsResponse } from "@omnyo/server-contract";
import { threadTabsQueryKey } from "../queries/query-keys";

export function getCachedThreadTabs(
  queryClient: QueryClient,
  threadId: string,
): ThreadTabsResponse | undefined {
  return queryClient.getQueryData<ThreadTabsResponse>(
    threadTabsQueryKey(threadId),
  );
}

export function newerThreadTabs(
  cached: ThreadTabsResponse | undefined,
  response: ThreadTabsResponse,
): ThreadTabsResponse {
  return cached !== undefined && cached.revision > response.revision
    ? cached
    : response;
}

export function setCachedThreadTabs(
  queryClient: QueryClient,
  threadId: string,
  response: ThreadTabsResponse,
): void {
  queryClient.setQueryData<ThreadTabsResponse>(
    threadTabsQueryKey(threadId),
    (cached) => newerThreadTabs(cached, response),
  );
}

export function invalidateCachedThreadTabs(
  queryClient: QueryClient,
  threadId: string,
): void {
  queryClient.invalidateQueries({ queryKey: threadTabsQueryKey(threadId) });
}
