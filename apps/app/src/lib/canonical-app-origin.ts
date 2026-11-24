import type { QueryClient } from "@tanstack/react-query";
import type { SystemConfigResponse } from "@omnyo/server-contract";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { appQueryClient } from "./app-query-client";

export function canonicalAppOrigin(
  queryClient: QueryClient = appQueryClient,
  currentOrigin: string = window.location.origin,
): string {
  const config = queryClient.getQueryData<SystemConfigResponse>(
    systemConfigQueryKey(),
  );

  return config === undefined
    ? currentOrigin
    : new URL(config.serverUrl).origin;
}

export function appLinkOrigins(
  queryClient: QueryClient = appQueryClient,
  currentOrigin: string = window.location.origin,
): readonly string[] {
  return [
    ...new Set([canonicalAppOrigin(queryClient, currentOrigin), currentOrigin]),
  ];
}
