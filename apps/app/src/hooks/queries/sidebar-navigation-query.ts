import {
  hashKey,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  listSidebarNavigationThreads,
  readSidebarNavigation,
} from "@/hooks/cache-owners/query-cache";
import { apiClient } from "@/lib/api-server";
import { request, requestOptions } from "@/lib/api";
import {
  useEnvironmentListRealtimeSubscription,
  useHostListRealtimeSubscription,
  useProjectListRealtimeSubscription,
  useThreadListRealtimeSubscription,
} from "@/hooks/useRealtimeSubscription";
import type { QueryOptions } from "./query-helpers";
import { sidebarNavigationQueryKey } from "./query-keys";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import {
  readCachedSidebarBootstrap,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";

function fetchSidebarNavigation(
  queryClient: QueryClient,
  signal?: AbortSignal,
): Promise<SidebarBootstrapResponse> {
  return readSidebarNavigation(queryClient, () =>
    request<SidebarBootstrapResponse>(
      apiClient["sidebar-bootstrap"].$get(undefined, requestOptions(signal)),
    ),
  );
}

export function useSidebarNavigation(options?: QueryOptions) {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  useEnvironmentListRealtimeSubscription({ enabled });
  useHostListRealtimeSubscription({ enabled });
  useProjectListRealtimeSubscription({ enabled });
  useThreadListRealtimeSubscription({ enabled });

  const query = useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: async ({ signal }) => {
      const response = await fetchSidebarNavigation(queryClient, signal);
      writeCachedSidebarBootstrap(response);

      return response;
    },
    enabled,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    placeholderData: () => readCachedSidebarBootstrap() ?? undefined,
  });

  return query;
}

const SIDEBAR_NAVIGATION_QUERY_HASH = hashKey(sidebarNavigationQueryKey());

export function useImmediateSidebarNavigation(options?: QueryOptions) {
  const queryClient = useQueryClient();

  const subscribe = useCallback(
    (onWrite: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.query.queryHash === SIDEBAR_NAVIGATION_QUERY_HASH
        ) {
          onWrite();
        }
      }),
    [queryClient],
  );

  const readWriteCount = useCallback(
    () =>
      queryClient.getQueryState(sidebarNavigationQueryKey())?.dataUpdateCount ??
      0,
    [queryClient],
  );

  useSyncExternalStore(subscribe, readWriteCount, readWriteCount);

  return useSidebarNavigation(options);
}

export function useProjectDisplayName(
  projectId: string | undefined,
): string | undefined {
  const queryClient = useQueryClient();

  const { data } = useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: ({ signal }) => fetchSidebarNavigation(queryClient, signal),
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    enabled: Boolean(projectId),
  });

  if (!data || !projectId) {
    return undefined;
  }

  if (projectId === PERSONAL_PROJECT_ID) {
    return data.personalProject.name;
  }

  return data.projects.find((project) => project.id === projectId)?.name;
}

interface SidebarNavigationThreadSelection<T> {
  data: T | undefined;
  isBootstrapPending: boolean;
}

export function useSidebarNavigationThreadSelection<T>(
  select: (threads: ThreadListEntry[]) => T,
): SidebarNavigationThreadSelection<T> {
  const result = useSidebarNavigation({ enabled: false });

  const data = useMemo(
    () =>
      result.data === undefined
        ? undefined
        : select(listSidebarNavigationThreads(result.data)),
    [result.data, select],
  );

  return {
    data,
    isBootstrapPending: data === undefined && result.isFetching,
  };
}
