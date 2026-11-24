import type { QueryKey } from "@tanstack/react-query";
import type { Environment, Host } from "@omnyo/domain";
import type {
  SystemConfigResponse,
  SystemProviderCatalogEntry,
} from "@omnyo/server-contract";
import {
  allEnvironmentDiffFilesQueryKeyPrefix,
  allEnvironmentDiffPatchQueryKeyPrefix,
  allEnvironmentFilePreviewQueryKeyPrefix,
  allEnvironmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentQueryKeyPrefix,
  allEnvironmentWorkStatusQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allMachineEnvironmentQueryKeyPrefix,
  allProjectPathsQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemMachineProvidersQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  allSystemThemesQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  allThreadConversationOutlineQueryKeyPrefix,
  allThreadDetailBootstrapQueryKeyPrefix,
  allThreadPluginBootstrapQueryKeyPrefix,
  allThreadHostFilePreviewQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueuedMessagesQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  allThreadTimelineTurnSummaryDetailsQueryKeyPrefix,
  environmentQueryKey,
  hostPathExistenceQueryKeyPrefix,
  hostsQueryKey,
  projectsQueryKey,
  serverMoveStatusQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  systemProviderCatalogQueryKey,
  threadPromptHistoryQueryKeyPrefix,
  threadOpenRuntimeIdentityQueryKey,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { allThreadDefaultExecutionOptionsQueryKeyPrefix } from "../queries/thread-default-execution-options-query";
import type { QueryClientArg } from "../cache-effect-types";
import { clearCachedModelCatalogs } from "@/lib/model-catalog-cache";
import { bumpAllDiffPatchEvictionGenerations } from "./environment-diff-patch-cache-owner";
import { invalidateAppUpdateStatus } from "./app-update-cache-owner";
import { invalidatePluginList } from "./plugin-cache-owner";
import { invalidateSystemVersion } from "./system-version-cache-owner";
import { INBOX_SNAPSHOT_QUERY_KEY } from "./inbox-snapshot-cache-owner";
import {
  invalidateQueryKeys,
  refetchFailedActiveQueryKeys,
} from "./cache-effect-utils";

interface SystemExecutionOptionsInvalidationArgs extends QueryClientArg {
  hostId: string;
}

interface ServerReconnectInvalidationArgs extends QueryClientArg {
  disconnectedAt: number;
}

export function invalidateRealtimeQueriesAfterServerReconnect({
  disconnectedAt,
  queryClient,
}: ServerReconnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    void queryClient.cancelQueries({ queryKey });
    void queryClient.invalidateQueries({
      queryKey,
      predicate: (query) =>
        query.isActive() || query.state.dataUpdatedAt < disconnectedAt,
    });
  }

  invalidateSystemVersion({ queryClient });
  invalidateAppUpdateStatus({ queryClient });
  bumpAllDiffPatchEvictionGenerations();
  queryClient.removeQueries({
    queryKey: allEnvironmentDiffPatchQueryKeyPrefix(),
  });
}

export function refetchErroredRealtimeQueriesOnInitialConnect({
  queryClient,
}: QueryClientArg): void {
  refetchFailedActiveQueryKeys({
    queryClient,
    queryKeys: getServerReconnectInvalidationQueryKeys(),
  });
}

interface InitialConnectInvalidationArgs extends QueryClientArg {
  connectedAt: number;
}

export function invalidateRealtimeQueriesFetchedBeforeInitialConnect({
  connectedAt,
  queryClient,
}: InitialConnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    void queryClient.cancelQueries({ queryKey });
    queryClient.invalidateQueries({
      queryKey,
      predicate: (query) =>
        query.isActive() ||
        (query.state.dataUpdatedAt !== 0 &&
          query.state.dataUpdatedAt < connectedAt),
    });
  }
}

export function refetchActiveRealtimeQueriesOnResume({
  queryClient,
}: QueryClientArg): void {
  refetchFailedActiveQueryKeys({
    queryClient,
    queryKeys: [
      allThreadDetailBootstrapQueryKeyPrefix(),
      allThreadPluginBootstrapQueryKeyPrefix(),
    ],
  });

  for (const queryKey of [
    INBOX_SNAPSHOT_QUERY_KEY,
    allThreadTimelineQueryKeyPrefix(),
    allThreadQueryKeyPrefix(),
    sidebarNavigationQueryKey(),
  ]) {
    void queryClient.refetchQueries(
      { queryKey, type: "active" },
      { cancelRefetch: false },
    );
  }
}

export function invalidateSystemConfig({ queryClient }: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [systemConfigQueryKey(), allSystemThemesQueryKeyPrefix()],
  });
}

export function invalidateMachineEnvironment({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [allMachineEnvironmentQueryKeyPrefix()],
  });
}

export async function applyProviderAvailabilityChange({
  queryClient,
  catalog,
}: QueryClientArg & { catalog: SystemProviderCatalogEntry[] }): Promise<void> {
  queryClient.setQueryData(systemProviderCatalogQueryKey(), catalog);
  await Promise.all([
    invalidateSystemProviders({ queryClient }),
    queryClient.invalidateQueries({
      queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    }),
    queryClient.invalidateQueries({ queryKey: systemConfigQueryKey() }),
    invalidatePluginList({ queryClient }),
  ]);
}

export async function invalidateSystemProviders({
  queryClient,
}: QueryClientArg): Promise<void> {
  await Promise.all(
    [allSystemProvidersQueryKeyPrefix(), systemProviderCatalogQueryKey()].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

export function invalidateMachineProviders({
  queryClient,
}: QueryClientArg): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemMachineProvidersQueryKeyPrefix(),
  });
}

export function invalidateSystemExecutionOptions({
  hostId,
  queryClient,
}: SystemExecutionOptionsInvalidationArgs): Promise<void> {
  const primaryHostId =
    queryClient.getQueryData<SystemConfigResponse>(systemConfigQueryKey())
      ?.primaryHostId ?? null;

  return queryClient.invalidateQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    predicate: (query) => {
      const [, environmentId, routedHostId] = query.queryKey;

      if (typeof routedHostId === "string") return routedHostId === hostId;

      if (typeof environmentId === "string") {
        const environment = queryClient.getQueryData<Environment>(
          environmentQueryKey(environmentId),
        );

        return environment === undefined || environment.hostId === hostId;
      }

      return primaryHostId === null || primaryHostId === hostId;
    },
  });
}

export function invalidateGeneralSettingsDependencies({
  includeSystemConfig,
  queryClient,
}: QueryClientArg & { includeSystemConfig: boolean }): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [
      ...(includeSystemConfig ? [systemConfigQueryKey()] : []),
      allThreadTimelineQueryKeyPrefix(),
      allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    ],
  });
}

export function resetModelCatalogsAfterStreamerModeChange({
  queryClient,
}: QueryClientArg): Promise<void> {
  clearCachedModelCatalogs();

  return queryClient.resetQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
  });
}

function getServerReconnectInvalidationQueryKeys(): QueryKey[] {
  return [
    INBOX_SNAPSHOT_QUERY_KEY,
    threadOpenRuntimeIdentityQueryKey(),
    hostsQueryKey(),
    allHostQueryKeyPrefix(),
    projectsQueryKey(),
    sidebarNavigationQueryKey(),
    allProjectPathsQueryKeyPrefix(),
    threadsQueryKey(),
    threadSearchQueryKeyPrefix(),
    allThreadQueryKeyPrefix(),
    allThreadDetailBootstrapQueryKeyPrefix(),
    allThreadPluginBootstrapQueryKeyPrefix(),
    allThreadTimelineQueryKeyPrefix(),
    allThreadConversationOutlineQueryKeyPrefix(),
    allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    allThreadQueuedMessagesQueryKeyPrefix(),
    threadPromptHistoryQueryKeyPrefix(),
    allThreadPendingInteractionsQueryKeyPrefix(),
    allThreadDefaultExecutionOptionsQueryKeyPrefix(),
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageLocationsQueryKeyPrefix(),
    allThreadStoragePathsQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
    allThreadHostFilePreviewQueryKeyPrefix(),
    allTerminalsQueryKeyPrefix(),
    allEnvironmentQueryKeyPrefix(),
    allEnvironmentWorkStatusQueryKeyPrefix(),
    allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
    allEnvironmentDiffFilesQueryKeyPrefix(),
    allEnvironmentFilePreviewQueryKeyPrefix(),
    hostPathExistenceQueryKeyPrefix(),
    allSystemProvidersQueryKeyPrefix(),
    systemProviderCatalogQueryKey(),
    allSystemExecutionOptionsQueryKeyPrefix(),
    serverMoveStatusQueryKey(),
  ];
}

export function applyHostRenameResult({
  host,
  queryClient,
}: QueryClientArg & { host: Host }): void {
  queryClient.setQueryData<Host[]>(hostsQueryKey(), (hosts) =>
    hosts?.map((current) => (current.id === host.id ? host : current)),
  );
}
