import { useCallback } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  PluginResourceOptions,
  PluginResourceState,
} from "../plugin-resource-contract.js";

/** Host-owned identity includes the plugin generation; QueryClient owns the session. */
export function usePluginResourceQuery<T>(
  options: PluginResourceOptions<T>,
  identity: readonly string[],
  queryClient: QueryClient,
): PluginResourceState<T> {
  const queryKey = ["plugin-resource", ...identity, options.key];
  const enabled = options.enabled !== false;

  const query = useQuery(
    {
      queryKey,
      queryFn: options.load,
      enabled,
      staleTime: options.staleTime ?? Infinity,
      gcTime: 5 * 60 * 1000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    queryClient,
  );

  const { refetch } = query;

  const refresh = useCallback(async () => {
    if (!enabled) return undefined;
    const result = await refetch({ cancelRefetch: false });

    if (result.isError) throw result.error;

    return result.data;
  }, [enabled, refetch]);

  const invalidate = () => {
    // Discard pre-invalidation requests, including a first read with no cached data.
    // Loaders need not support AbortSignal: QueryClient still rejects their late results.
    void queryClient
      .cancelQueries({ queryKey, exact: true })
      .then(() => queryClient.invalidateQueries({ queryKey, exact: true }));
  };

  return {
    data: query.data,
    error: query.error,
    status:
      !enabled && query.isPending
        ? "idle"
        : query.status === "pending"
          ? "loading"
          : query.status,
    isRefreshing: query.isFetching && query.data !== undefined,
    refresh,
    invalidate,
  };
}
