import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { QueuedMessageWaitingOn } from "@omnyo/domain";
import {
  threadDispatchReadinessSchema,
  type ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import {
  allThreadPluginBootstrapQueryKeyPrefix,
  threadPluginBootstrapQueryKey,
} from "../queries/query-keys";

export function readCachedThreadDispatchWait({
  queryClient,
  threadId,
}: {
  queryClient: QueryClient;
  threadId: string;
}): QueuedMessageWaitingOn | undefined {
  const queryKey = threadPluginBootstrapQueryKey(threadId);

  if (queryClient.getQueryState(queryKey)?.isInvalidated) return undefined;

  const bootstrap =
    queryClient.getQueryData<ThreadWithIncludesResponse>(queryKey);

  for (const entry of bootstrap?.experimental_pluginData ?? []) {
    if (entry.dispatchReadiness !== true || !entry.outcome.ok) continue;

    const readiness = threadDispatchReadinessSchema.safeParse(
      entry.outcome.result,
    );

    if (readiness.success && readiness.data.action === "wait")
      return {
        kind: "plugin",
        pluginId: entry.pluginId,
        reason: readiness.data.reason,
      };
  }

  return undefined;
}

export function getCachedDispatchReadinessQueryKeys({
  queryClient,
  pluginId,
  includeAll,
}: {
  queryClient: QueryClient;
  pluginId: string | null;
  includeAll: boolean;
}): QueryKey[] {
  return queryClient
    .getQueriesData<ThreadWithIncludesResponse>({
      queryKey: allThreadPluginBootstrapQueryKeyPrefix(),
    })
    .filter(
      ([queryKey, bootstrap]) =>
        includeAll ||
        (bootstrap === undefined &&
          queryClient.getQueryState(queryKey)?.fetchStatus === "fetching") ||
        bootstrap?.experimental_pluginData?.some(
          (entry) =>
            entry.dispatchReadiness === true &&
            (pluginId === null || entry.pluginId === pluginId),
        ),
    )
    .map(([queryKey]) => queryKey);
}
