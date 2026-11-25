import { createSnapshotInvalidator } from "./snapshot-invalidation";
import { markInboxSnapshotDirty } from "./inbox-snapshot-cache-owner";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  EnvironmentChangeKind,
  HostChangeKind,
  ProjectChangeKind,
  SystemChangeKind,
  ThreadChangeKind,
  ThreadEventType,
  ThreadListEntry,
  ThreadStatusChangeMetadata,
  ThreadWithRuntime,
} from "@omnyo/domain";
import {
  getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys,
  getCachedGlobalThreadListInvalidationQueryKeys,
  getCachedProjectThreadListInvalidationQueryKeys,
  getCachedSidebarNavigationThreads,
  getCachedThreadListPlaceholder,
  getCachedThreadListQueryKeys,
  getEnvironmentBranchListInvalidationQueryKeys,
  getEnvironmentRecordInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
  getFetchingThreadListQueryKeys,
  isPagedThreadListQueryKey,
  isCachedThreadListPlacementCurrent,
  replaceCachedThreadListEntry,
  updateCachedThreadListPendingInteractionState,
  updateCachedThreadListStatusState,
  updateCachedThreadStatusState,
} from "./query-cache";
import { bumpDiffPatchFreshnessGeneration } from "./environment-diff-patch-cache-owner";
import { invalidateSystemExecutionOptions } from "./system-cache-effects";
import { markThreadTimelineUnseenEvents } from "./thread-timeline-unseen-events";
import { purgeThreadOpenHistoryCache } from "./thread-open-cache-owner";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import {
  allHostQueryKeyPrefix,
  allMachineEnvironmentQueryKeyPrefix,
  allPluginCatalogSearchQueryKeyPrefix,
  allPluginContributionsQueryKeyPrefix,
  allPluginListQueryKeyPrefix,
  allPluginSettingsQueryKeyPrefix,
  allPluginSettingsViewQueryKeyPrefix,
  allPluginSourceQueryKeyPrefix,
  pluginSafeModeQueryKey,
  allProjectCommandCatalogQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemThemesQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  environmentDiffFilesQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  environmentPullRequestQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  hostsQueryKey,
  serverMoveStatusQueryKey,
  systemAppUpdateQueryKey,
  pluginInstallJobsQueryKey,
  pluginUpdateJobsQueryKey,
  sidebarNavigationQueryKey,
  systemAiServicesQueryKey,
  systemConfigQueryKey,
  systemProviderCatalogQueryKey,
  uiPreferencesQueryKey,
  allSystemProvidersQueryKeyPrefix,
  threadDefaultExecutionOptionsQueryKey,
  threadQueryKey,
  threadContinuationsQueryKey,
  threadTabsQueryKey,
  threadSearchQueryKeyPrefix,
  terminalsQueryKey,
  threadsQueryKey,
  threadStorageFilePreviewQueryKeyPrefix,
  threadStorageFilesForThreadQueryKeyPrefix,
  threadStorageLocationQueryKey,
  threadStoragePathsForThreadQueryKeyPrefix,
  threadTimelineQueryKeyPrefix,
} from "../queries/query-keys";
import { systemEnvironmentProvidersQueryKey } from "../queries/environment-provider-queries";
import { schedulePluginFrontendReconcile } from "../../lib/plugin-frontend-lazy";
import {
  getProjectListInvalidationQueryKeys,
  getProjectPromptHistoryInvalidationQueryKeys,
  getProjectSourceDependentInvalidationQueryKeys,
  resetProjectCommandCatalogQueries,
  getThreadConversationOutlineInvalidationQueryKeys,
  getThreadDetailInvalidationQueryKeys,
  getThreadPendingInteractionInvalidationQueryKeys,
  getThreadPromptHistoryInvalidationQueryKeys,
  getThreadQueueContentInvalidationQueryKeys,
  getThreadTimelineInvalidationQueryKeys,
  getThreadCompactedHistoryInvalidationQueryKeys,
  getThreadTimelineWindowInvalidationQueryKeys,
} from "./cache-invalidation-groups";

interface CollectCachedThreadIdsForEnvironmentArgs {
  environmentId: string;
  queryClient: QueryClient;
}

interface TimelineInvalidationQueryKeysArgs {
  queryClient: QueryClient;
  queryKeys: readonly QueryKey[];
}

interface ScheduleTrailingActiveRefetchArgs {
  includeInactive?: boolean;
  exact: boolean;
  queryClient: QueryClient;
  queryKey: QueryKey;
}

interface CancelTrailingActiveRefetchArgs {
  queryClient: QueryClient;
  queryKey: QueryKey;
}

const trailingActiveRefetchUnsubscribers = new WeakMap<
  QueryClient,
  Map<string, () => void>
>();

interface ThrottledActiveRefetchEntry {
  lastRunAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const throttledActiveRefetchEntries = new WeakMap<
  QueryClient,
  Map<string, ThrottledActiveRefetchEntry>
>();

interface ThrottledActiveRefetchArgs {
  exact: boolean;
  minIntervalMs: number;
  queryClient: QueryClient;
  queryKey: QueryKey;
}

const WORK_STATUS_REFETCH_MIN_INTERVAL_MS = 1_000;

const THREAD_LIST_REFETCH_MIN_INTERVAL_MS = 1_000;

const TRAILING_REFETCH_MIN_INTERVAL_MS = 50;

const TRAILING_REFETCH_MAX_INTERVAL_MS = 1_000;

export function resolveTrailingRefetchDelayMs(
  observedFetchDurationMs: number,
): number {
  return Math.min(
    TRAILING_REFETCH_MAX_INTERVAL_MS,
    Math.max(TRAILING_REFETCH_MIN_INTERVAL_MS, observedFetchDurationMs),
  );
}

function timelineInvalidationKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}

function hasFetchingQueries(
  queryClient: QueryClient,
  queryKey: QueryKey,
  exact: boolean,
  includeInactive = false,
): boolean {
  return queryClient
    .getQueryCache()
    .findAll({ exact, queryKey, type: includeInactive ? "all" : "active" })
    .some((query) => query.state.fetchStatus !== "idle");
}

function hasActiveQueries(
  queryClient: QueryClient,
  queryKey: QueryKey,
): boolean {
  return (
    queryClient.getQueryCache().findAll({ queryKey, type: "active" }).length > 0
  );
}

function refetchActiveQueriesWithoutCanceling({
  exact,
  includeInactive = false,
  queryClient,
  queryKey,
}: ScheduleTrailingActiveRefetchArgs): void {
  const hadActiveFetch = hasFetchingQueries(
    queryClient,
    queryKey,
    exact,
    includeInactive,
  );

  void queryClient
    .refetchQueries(
      { exact, queryKey, type: "active" },
      { cancelRefetch: false },
    )
    .catch(() => {});

  if (hadActiveFetch) {
    scheduleTrailingActiveRefetch({
      exact,
      includeInactive,
      queryClient,
      queryKey,
    });
  }
}

function invalidateQueryKeyWithThrottledActiveRefetch({
  exact,
  minIntervalMs,
  queryClient,
  queryKey,
}: ThrottledActiveRefetchArgs): void {
  queryClient.invalidateQueries({ exact, queryKey, refetchType: "none" });

  const scheduleKey = timelineInvalidationKey(queryKey);
  let entries = throttledActiveRefetchEntries.get(queryClient);

  if (!entries) {
    entries = new Map();
    throttledActiveRefetchEntries.set(queryClient, entries);
  }

  const entry = entries.get(scheduleKey);

  if (entry?.timer) {
    return;
  }

  const run = () => {
    entries.set(scheduleKey, { lastRunAt: Date.now(), timer: null });
    refetchActiveQueriesWithoutCanceling({ exact, queryClient, queryKey });
  };

  const lastRunAt = entry?.lastRunAt ?? Number.NEGATIVE_INFINITY;
  const delayMs = Math.max(0, lastRunAt + minIntervalMs - Date.now());

  if (delayMs === 0) {
    run();

    return;
  }

  entries.set(scheduleKey, { lastRunAt, timer: setTimeout(run, delayMs) });
}

function scheduleTrailingActiveRefetch({
  exact,
  includeInactive = false,
  queryClient,
  queryKey,
}: ScheduleTrailingActiveRefetchArgs): void {
  const scheduleKey = timelineInvalidationKey(queryKey);
  let unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);

  if (!unsubscribers) {
    unsubscribers = new Map();
    trailingActiveRefetchUnsubscribers.set(queryClient, unsubscribers);
  }

  if (unsubscribers.has(scheduleKey)) {
    if (!includeInactive) return;
    unsubscribers.get(scheduleKey)?.();
  }

  const waitingSince = Date.now();

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (hasFetchingQueries(queryClient, queryKey, exact, includeInactive)) {
      return;
    }

    unsubscribe();
    unsubscribers.delete(scheduleKey);

    if (includeInactive)
      void queryClient.invalidateQueries({
        exact,
        queryKey,
        refetchType: "none",
      });
    const delayMs = resolveTrailingRefetchDelayMs(Date.now() - waitingSince);

    const timer = setTimeout(() => {
      unsubscribers.delete(scheduleKey);
      void queryClient
        .refetchQueries(
          { exact, queryKey, type: "active" },
          { cancelRefetch: false },
        )
        .catch(() => {});
    }, delayMs);

    unsubscribers.set(scheduleKey, () => {
      clearTimeout(timer);
    });
  });

  unsubscribers.set(scheduleKey, unsubscribe);
}

function cancelTrailingActiveRefetch({
  queryClient,
  queryKey,
}: CancelTrailingActiveRefetchArgs): void {
  const unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);

  if (!unsubscribers) {
    return;
  }

  const scheduleKey = timelineInvalidationKey(queryKey);
  unsubscribers.get(scheduleKey)?.();
  unsubscribers.delete(scheduleKey);

  if (unsubscribers.size === 0) {
    trailingActiveRefetchUnsubscribers.delete(queryClient);
  }
}

export function invalidateQueryKeysWithoutRefetch({
  queryClient,
  queryKeys,
}: TimelineInvalidationQueryKeysArgs): void {
  for (const queryKey of queryKeys)
    void queryClient.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: "none",
    });
}

export function invalidateQueryKeysWithoutCancelingActiveFetches({
  queryClient,
  queryKeys,
  includeInactive = false,
}: TimelineInvalidationQueryKeysArgs & { includeInactive?: boolean }): void {
  for (const queryKey of queryKeys) {
    const hadActiveFetch = hasFetchingQueries(
      queryClient,
      queryKey,
      false,
      includeInactive,
    );

    queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });

    if (hadActiveFetch) {
      scheduleTrailingActiveRefetch({
        exact: false,
        includeInactive,
        queryClient,
        queryKey,
      });
    }
  }
}

function invalidateTerminalTimelineQueryKeys({
  queryClient,
  queryKeys,
}: TimelineInvalidationQueryKeysArgs): void {
  for (const queryKey of queryKeys) {
    cancelTrailingActiveRefetch({ queryClient, queryKey });
    void queryClient.cancelQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey });
  }
}

export function disposeTrailingActiveRefetches(queryClient: QueryClient): void {
  sidebarMembershipRefresh.dispose(queryClient);
  const throttled = throttledActiveRefetchEntries.get(queryClient);

  if (throttled) {
    for (const entry of throttled.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }

    throttledActiveRefetchEntries.delete(queryClient);
  }

  const unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);

  if (!unsubscribers) {
    return;
  }

  for (const unsubscribe of unsubscribers.values()) {
    unsubscribe();
  }

  trailingActiveRefetchUnsubscribers.delete(queryClient);
}

export const REALTIME_THREAD_CHANGE_REGISTRY = {
  "thread-created": {
    flush: "debounced",
    patch: [refreshSidebarMembership],
    dirty: [
      dirtyInboxSnapshot,
      dirtyThreadMembershipQueries,
      dirtyThreadDetailQueries,
      dirtyThreadTimelineQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "thread-deleted": {
    flush: "debounced",
    patch: [refreshSidebarMembership],
    dirty: [
      dirtyInboxSnapshot,
      purgeDeletedThreadTimelineDisplay,
      dirtyThreadMembershipQueries,
      dirtyThreadDetailQueries,
      dirtyThreadTimelineQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "execution-changed": {
    flush: "immediate",
    dirty: [
      dirtyThreadDetailQueries,
      dirtyThreadDefaultExecutionOptionsQueries,
    ],
  },
  "events-appended": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueriesForBackgroundActivity,
      dirtyThreadDetailQueriesForBackgroundActivity,
      dirtyThreadSearchQueriesForCompletedTurn,
      dirtyThreadTimelineQueries,
      dirtyThreadPullRequestQueryForCompletedTurn,
      dirtyThreadTurnRequestQueries,
    ],
  },
  "history-rewritten": {
    flush: "immediate",
    dirty: [
      dirtyInboxSnapshot,
      purgeThreadTimelineHistoryDisplay,
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadSearchQueries,
      getThreadTimelineInvalidationQueryKeys,
      getThreadQueueContentInvalidationQueryKeys,
      dirtyProjectPromptHistoryQueries,
      getThreadPendingInteractionInvalidationQueryKeys,
    ],
  },
  "history-compacted": {
    flush: "debounced",
    dirty: [
      purgeThreadTimelineHistoryDisplay,
      getThreadCompactedHistoryInvalidationQueryKeys,
    ],
  },
  "interactions-changed": {
    flush: "debounced",
    patch: [patchThreadListPendingInteractionState],
    dirty: [
      dirtyInboxSnapshot,
      refreshThreadListEntryOrThreadLists,
      dirtyThreadSearchQueries,
      getThreadPendingInteractionInvalidationQueryKeys,
      dirtyThreadTimelineQueries,
    ],
  },
  "work-changed": {
    flush: "immediate",
    dirty: [
      dirtyInboxSnapshot,
      refreshThreadListEntryOrActiveLists,
      dirtyThreadDetailQueries,
      dirtyThreadSearchQueries,
    ],
  },
  "status-changed": {
    flush: "immediate",
    patch: [patchThreadStatusState],
    dirty: [
      dirtyInboxSnapshot,
      refreshThreadListStatusState,
      dirtyThreadDetailQueries,
      dirtyThreadContinuationQueries,
      dirtyInactiveThreadTimelineQueries,
    ],
  },
  "title-changed": {
    flush: "debounced",
    dirty: [
      dirtyInboxSnapshot,
      refreshThreadListEntryOrActiveLists,
      dirtyThreadDetailQueries,
    ],
  },
  "queue-changed": {
    flush: "debounced",
    dirty: [
      dirtyInboxSnapshot,
      getThreadQueueContentInvalidationQueryKeys,
      refreshThreadListEntryOrActiveLists,
      dirtyThreadContinuationQueries,
    ],
  },
  "archived-changed": {
    flush: "debounced",
    patch: [refreshSidebarMembership],
    dirty: [
      dirtyInboxSnapshot,
      dirtyThreadMembershipQueries,
      dirtyThreadDetailQueries,
      dirtyProjectPromptHistoryQueries,
      dirtyThreadContinuationQueries,
    ],
  },
  "pin-state-changed": {
    flush: "debounced",
    patch: [refreshSidebarMembership],
    dirty: [
      dirtyInboxSnapshot,
      dirtyThreadMembershipQueries,
      dirtyThreadDetailQueries,
    ],
  },
  "shelf-state-changed": {
    flush: "debounced",
    patch: [refreshSidebarMembership],
    dirty: [
      dirtyInboxSnapshot,
      dirtyThreadMembershipQueries,
      dirtyThreadDetailQueries,
    ],
  },
  "parent-changed": {
    flush: "debounced",
    patch: [refreshSidebarMembership],
    dirty: [
      dirtyInboxSnapshot,
      dirtyThreadMembershipQueries,
      dirtyThreadDetailQueries,
    ],
  },
  "environment-changed": {
    flush: "immediate",
    dirty: [
      dirtyInboxSnapshot,
      refreshThreadListEntryOrActiveLists,
      dirtyThreadDetailQueries,
      dirtyThreadDefaultExecutionOptionsQueries,
      dirtyThreadStorageQueriesForThread,
      dirtyThreadContinuationQueries,
    ],
  },
  "read-state-changed": {
    flush: "debounced",
    dirty: [
      dirtyInboxSnapshot,
      markThreadDetailQueryStale,
      refreshThreadListEntryOrMarkStale,
    ],
  },
  "tabs-changed": {
    flush: "immediate",
    dirty: [dirtyInboxSnapshot, dirtyThreadTabsQueries],
  },
  "terminals-changed": {
    flush: "debounced",
    dirty: [dirtyInboxSnapshot, dirtyThreadTerminalQueries],
  },
} satisfies ThreadChangeRegistry;

export const REALTIME_ENVIRONMENT_CHANGE_REGISTRY = {
  "environment-created": {
    dirty: [
      resetEnvironmentCommandCatalogQueries,
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "environment-deleted": {
    dirty: [
      resetEnvironmentCommandCatalogQueries,
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "metadata-changed": {
    dirty: [
      resetEnvironmentCommandCatalogQueries,
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
      dirtyEnvironmentThreadListQueries,
      dirtyThreadSearchQueries,
    ],
  },
  "status-changed": {
    dirty: [
      resetEnvironmentCommandCatalogQueries,
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "work-status-changed": {
    dirty: [dirtyEnvironmentLiveWorkspaceStateQueries],
  },
  "git-refs-changed": {
    dirty: [
      dirtyEnvironmentRefDerivedWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "thread-storage-changed": {
    dirty: [dirtyThreadStorageQueriesForEnvironment],
  },
} satisfies EnvironmentChangeRegistry;

export const REALTIME_PROJECT_CHANGE_REGISTRY = {
  "project-created": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-updated": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-deleted": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-sources-changed": {
    dirty: [
      resetProjectCommandCatalogQueries,
      getProjectSourceDependentInvalidationQueryKeys,
    ],
  },
  "threads-changed": {
    dirty: [
      getProjectListInvalidationQueryKeys,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "project-order-changed": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
} satisfies ProjectChangeRegistry;

const HOST_CONNECTION_DIRTY_HANDLERS = [
  dirtyProjectCommandCatalogQueries,
  dirtyHostAvailabilityQueries,
  getProjectListInvalidationQueryKeys,
  dirtySystemProviderQueries,
] satisfies readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];

export const REALTIME_HOST_CHANGE_REGISTRY = {
  "host-connected": {
    dirty: [
      ...HOST_CONNECTION_DIRTY_HANDLERS,
      dirtyHostSystemExecutionOptionQueries,
      dirtyAllThreadStorageQueries,
    ],
  },
  "host-disconnected": {
    dirty: HOST_CONNECTION_DIRTY_HANDLERS,
  },
  "provider-model-catalog-changed": {
    dirty: [dirtyHostSystemExecutionOptionQueries],
  },
} satisfies HostChangeRegistry;

export const REALTIME_SYSTEM_CHANGE_REGISTRY = {
  "command-catalog-changed": { dirty: [dirtyProjectCommandCatalogQueries] },
  "config-changed": {
    dirty: [
      dirtySystemConfigQueries,
      dirtyMachineEnvironmentQueries,
      dirtyAllThreadTimelineQueries,
      dirtySystemProviderQueries,
      dirtySystemExecutionOptionQueries,
      dirtyEnvironmentProviderQueries,
    ],
  },
  "plugins-changed": {
    dirty: [
      dirtySystemConfigQueries,
      dirtyPluginContributionQueries,
      dirtyProjectCommandCatalogQueries,
      dirtyPluginManagementQueries,
      dirtyEnvironmentProviderQueries,
      reconcilePluginFrontendBundles,
    ],
  },
  "plugin-update-jobs-changed": {
    dirty: [() => [pluginUpdateJobsQueryKey()]],
  },
  "plugin-install-jobs-changed": {
    dirty: [dirtyPluginInstallJobQueries],
  },
  "provider-registrations-changed": {
    dirty: [
      dirtySystemProviderQueries,
      dirtySystemExecutionOptionQueries,
      dirtyProjectCommandCatalogQueries,
    ],
  },
  "environment-availability-changed": {
    dirty: [dirtyEnvironmentProviderQueries],
  },
  "ui-preferences-changed": {
    dirty: [dirtyUiPreferencesQueries],
  },
  "server-move-changed": {
    dirty: [dirtyServerMoveStatusQueries],
  },
  "app-update-changed": {
    dirty: [dirtyAppUpdateStatusQueries],
  },
  "web-generation-changed": { dirty: [] },
} satisfies SystemChangeRegistry;

type ThreadChangeFlushPriority = "debounced" | "immediate";

interface RealtimeDirtyContext {
  queryClient: QueryClient;
}

interface ThreadRealtimeDirtyContext extends RealtimeDirtyContext {
  backgroundActivityChanged: boolean | undefined;
  eventTypes: readonly ThreadEventType[] | undefined;
  timelineSequence: number | undefined;
  flushOnce: (key: string) => boolean;
  hasPendingInteraction: boolean | undefined;
  listEntry: ThreadListEntry | undefined;
  projectId: string | undefined;
  statusChange: ThreadStatusChangeMetadata | undefined;
  threadId: string | undefined;
}

export function createFlushOncePredicate(): (key: string) => boolean {
  const seen = new Set<string>();

  return (key) => {
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  };
}

interface EnvironmentRealtimeDirtyContext extends RealtimeDirtyContext {
  environmentId: string;
  getCachedThreadIdsForEnvironment: () => string[];
}

interface ProjectRealtimeDirtyContext extends RealtimeDirtyContext {
  projectId: string | undefined;
}

interface HostRealtimeDirtyContext extends RealtimeDirtyContext {
  hostId: string | undefined;
}

type RealtimeDirtyHandler<Context extends RealtimeDirtyContext> = (
  context: Context,
) => readonly QueryKey[] | void;

interface ExecuteRealtimeDirtyHandlersArgs<
  Context extends RealtimeDirtyContext,
> {
  context: Context;
  handlers: readonly RealtimeDirtyHandler<Context>[];
}

interface ThreadRealtimePatchContext {
  hasPendingInteraction: boolean | undefined;
  listEntry: ThreadListEntry | undefined;
  queryClient: QueryClient;
  statusChange: ThreadStatusChangeMetadata | undefined;
  threadId: string;
}

interface ThreadChangeRule {
  patch?: readonly ((context: ThreadRealtimePatchContext) => void)[];
  dirty: readonly RealtimeDirtyHandler<ThreadRealtimeDirtyContext>[];
  flush: ThreadChangeFlushPriority;
}

type ThreadChangeRegistry = Record<ThreadChangeKind, ThreadChangeRule>;

interface EnvironmentChangeRule {
  dirty: readonly RealtimeDirtyHandler<EnvironmentRealtimeDirtyContext>[];
}

type EnvironmentChangeRegistry = Record<
  EnvironmentChangeKind,
  EnvironmentChangeRule
>;

interface ProjectChangeRule {
  dirty: readonly RealtimeDirtyHandler<ProjectRealtimeDirtyContext>[];
}

type ProjectChangeRegistry = Record<ProjectChangeKind, ProjectChangeRule>;

interface HostChangeRule {
  dirty: readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];
}

type HostChangeRegistry = Record<HostChangeKind, HostChangeRule>;

interface SystemChangeRule {
  dirty: readonly RealtimeDirtyHandler<RealtimeDirtyContext>[];
}

type SystemChangeRegistry = Partial<Record<SystemChangeKind, SystemChangeRule>>;

export function executeRealtimeDirtyHandlers<
  Context extends RealtimeDirtyContext,
>({ context, handlers }: ExecuteRealtimeDirtyHandlersArgs<Context>): void {
  for (const handler of handlers) {
    const queryKeys = handler(context);

    if (!queryKeys) {
      continue;
    }

    for (const queryKey of queryKeys) {
      context.queryClient.invalidateQueries({ queryKey });
    }
  }
}

export function applyRealtimeThreadPatches(
  changes: readonly ThreadChangeKind[],
  context: ThreadRealtimePatchContext,
): void {
  for (const changeKind of changes) {
    const rule: ThreadChangeRule = REALTIME_THREAD_CHANGE_REGISTRY[changeKind];

    for (const patch of rule.patch ?? []) {
      patch(context);
    }
  }

  if (context.listEntry) {
    replaceCachedThreadListEntry(context.queryClient, context.listEntry);
  }
}

export interface ThreadChangesByFlushPriority {
  debounced: ThreadChangeKind[] | null;
  immediate: ThreadChangeKind[] | null;
}

export function partitionThreadChangesByFlushPriority(
  changes: readonly ThreadChangeKind[],
): ThreadChangesByFlushPriority {
  let debounced: ThreadChangeKind[] | null = null;
  let immediate: ThreadChangeKind[] | null = null;

  for (const change of changes) {
    if (REALTIME_THREAD_CHANGE_REGISTRY[change].flush === "immediate") {
      (immediate ??= []).push(change);
    } else {
      (debounced ??= []).push(change);
    }
  }

  return { debounced, immediate };
}

export function collectCachedThreadIdsForEnvironment({
  environmentId,
  queryClient,
}: CollectCachedThreadIdsForEnvironmentArgs): string[] {
  const threadIds = new Set<string>();

  for (const [, thread] of queryClient.getQueriesData<ThreadWithRuntime>({
    queryKey: allThreadQueryKeyPrefix(),
  })) {
    if (thread?.environmentId === environmentId) {
      threadIds.add(thread.id);
    }
  }

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.environmentId === environmentId) {
        threadIds.add(thread.id);
      }
    }
  }

  return Array.from(threadIds);
}

const sidebarMembershipRefresh = createSnapshotInvalidator(
  sidebarNavigationQueryKey(),
);

function refreshSidebarMembership({ queryClient }: RealtimeDirtyContext): void {
  sidebarMembershipRefresh.invalidate(queryClient);
}

function dirtyThreadMembershipQueries(
  context: ThreadRealtimeDirtyContext,
): void {
  if (context.threadId === undefined) refreshSidebarMembership(context);
  invalidateThreadListQueries(context, true, false);
}

function dirtyThreadListQueries(context: ThreadRealtimeDirtyContext): void {
  invalidateThreadListQueries(context, true);
}

function dirtyThreadContinuationQueries(): QueryKey[] {
  return [threadContinuationsQueryKey()];
}

function dirtyActiveThreadListQueries(
  context: ThreadRealtimeDirtyContext,
): void {
  invalidateThreadListQueries(context, false);
}

function invalidateThreadListQueries(
  { projectId, queryClient }: ThreadRealtimeDirtyContext,
  includePaged: boolean,
  includeSidebar = true,
): void {
  const listQueryKeys = projectId
    ? [
        ...getCachedProjectThreadListInvalidationQueryKeys({
          projectId,
          queryClient,
        }),
        ...getCachedGlobalThreadListInvalidationQueryKeys({ queryClient }),
      ]
    : getCachedThreadListQueryKeys(queryClient);

  for (const queryKey of listQueryKeys) {
    if (!includePaged && isPagedThreadListQueryKey(queryKey)) {
      queryClient.invalidateQueries({
        exact: true,
        queryKey,
        refetchType: "none",
      });
      continue;
    }

    invalidateQueryKeyWithThrottledActiveRefetch({
      exact: true,
      minIntervalMs: THREAD_LIST_REFETCH_MIN_INTERVAL_MS,
      queryClient,
      queryKey,
    });
  }

  for (const queryKey of [
    ...(includeSidebar ? [sidebarNavigationQueryKey()] : []),
    threadSearchQueryKeyPrefix(),
  ]) {
    invalidateQueryKeyWithThrottledActiveRefetch({
      exact: false,
      minIntervalMs: THREAD_LIST_REFETCH_MIN_INTERVAL_MS,
      queryClient,
      queryKey,
    });
  }
}

function dirtyThreadListQueriesForBackgroundActivity(
  context: ThreadRealtimeDirtyContext,
): readonly QueryKey[] | void {
  if (context.backgroundActivityChanged !== true) {
    return [];
  }

  return refreshThreadListEntryOrActiveLists(context);
}

function hasCurrentThreadListEntry({
  listEntry,
  queryClient,
}: ThreadRealtimeDirtyContext): boolean {
  return (
    listEntry !== undefined &&
    isCachedThreadListPlacementCurrent(queryClient, listEntry)
  );
}

function invalidateFetchingThreadListQueries(queryClient: QueryClient): void {
  for (const queryKey of getFetchingThreadListQueryKeys(queryClient)) {
    queryClient.invalidateQueries({ exact: true, queryKey });
  }
}

function refreshThreadListEntryOrActiveLists(
  context: ThreadRealtimeDirtyContext,
): readonly QueryKey[] | void {
  if (!hasCurrentThreadListEntry(context)) {
    return dirtyActiveThreadListQueries(context);
  }

  invalidateFetchingThreadListQueries(context.queryClient);

  return [threadSearchQueryKeyPrefix()];
}

function refreshThreadListEntryOrMarkStale(
  context: ThreadRealtimeDirtyContext,
): void {
  if (!hasCurrentThreadListEntry(context)) {
    markThreadListQueriesStale(context);

    return;
  }

  invalidateFetchingThreadListQueries(context.queryClient);
}

function refreshThreadListEntryOrThreadLists(
  context: ThreadRealtimeDirtyContext,
): readonly QueryKey[] | void {
  if (!hasCurrentThreadListEntry(context)) {
    return dirtyThreadListQueries(context);
  }

  invalidateFetchingThreadListQueries(context.queryClient);

  return [threadSearchQueryKeyPrefix()];
}

function dirtyThreadDetailQueriesForBackgroundActivity(
  context: ThreadRealtimeDirtyContext,
): QueryKey[] {
  if (context.backgroundActivityChanged !== true) {
    return [];
  }

  return dirtyThreadDetailQueries(context);
}

function dirtyThreadDetailQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return getThreadDetailInvalidationQueryKeys({ threadId });
}

function dirtyThreadDefaultExecutionOptionsQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId ? [threadDefaultExecutionOptionsQueryKey(threadId)] : [];
}

function dirtyThreadTabsQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId ? [threadTabsQueryKey(threadId)] : [];
}

function purgeThreadTimelineHistoryDisplay({
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  if (!threadId) return;
  purgeThreadOpenHistoryCache(queryClient, threadId);
}

function purgeDeletedThreadTimelineDisplay({
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  if (!threadId) return;
  purgeThreadOpenHistoryCache(queryClient, threadId, { removeTimeline: true });
}

function dirtyThreadSearchQueries(): QueryKey[] {
  return [threadSearchQueryKeyPrefix()];
}

function dirtyThreadSearchQueriesForCompletedTurn({
  eventTypes,
  flushOnce,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  if (!eventTypes?.includes("turn/completed")) {
    return;
  }

  if (!flushOnce("thread-search:turn-completed")) {
    return;
  }

  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [threadSearchQueryKeyPrefix()],
  });
}

function dirtyInactiveThreadTimelineQueries(
  context: ThreadRealtimeDirtyContext,
): void {
  if (
    context.threadId !== undefined &&
    hasActiveQueries(
      context.queryClient,
      threadTimelineQueryKeyPrefix(context.threadId),
    )
  )
    return;

  dirtyThreadTimelineQueries(context);
}

function dirtyThreadTimelineQueries({
  eventTypes,
  timelineSequence,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  const timelineQueryKeys = getThreadTimelineWindowInvalidationQueryKeys({
    threadId,
  });

  const outlineQueryKeys = getThreadConversationOutlineInvalidationQueryKeys({
    threadId,
  });

  const turnMayHaveCompleted =
    eventTypes === undefined || eventTypes.includes("turn/completed");

  if (threadId !== undefined) {
    markThreadTimelineUnseenEvents(
      queryClient,
      threadId,
      timelineSequence,
      turnMayHaveCompleted,
    );
  }

  if (
    threadId !== undefined &&
    !hasActiveQueries(queryClient, threadTimelineQueryKeyPrefix(threadId))
  ) {
    if (turnMayHaveCompleted || timelineSequence === undefined) {
      for (const queryKey of [...timelineQueryKeys, ...outlineQueryKeys]) {
        queryClient.invalidateQueries({ queryKey, refetchType: "none" });
      }
    }

    return;
  }

  if (eventTypes?.includes("turn/completed")) {
    invalidateTerminalTimelineQueryKeys({
      queryClient,
      queryKeys: [...timelineQueryKeys, ...outlineQueryKeys],
    });

    return;
  }

  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: timelineQueryKeys,
  });

  if (turnMayHaveCompleted) {
    invalidateQueryKeysWithoutCancelingActiveFetches({
      queryClient,
      queryKeys: outlineQueryKeys,
    });
  }
}

function dirtyThreadTurnRequestQueries({
  eventTypes,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId || !eventTypes?.includes("client/turn/requested")) return [];
  const queryKey = threadDefaultExecutionOptionsQueryKey(threadId);
  void queryClient.cancelQueries({ queryKey });

  return [
    queryKey,
    ...getThreadPromptHistoryInvalidationQueryKeys({ threadId }),
  ];
}

function dirtyThreadPullRequestQueryForCompletedTurn({
  eventTypes,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId || !eventTypes?.includes("turn/completed")) {
    return [];
  }

  const cachedThread =
    queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId)) ??
    getCachedThreadListPlaceholder(queryClient, threadId) ??
    getCachedSidebarNavigationThreads(queryClient).find(
      (thread) => thread.id === threadId,
    );

  const environmentId = cachedThread?.environmentId;

  return environmentId ? [environmentPullRequestQueryKey(environmentId)] : [];
}

function dirtyThreadTerminalQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [terminalsQueryKey({ kind: "thread", threadId })]
    : [allTerminalsQueryKeyPrefix()];
}

function dirtyThreadStorageQueriesForThread({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId) {
    return dirtyAllThreadStorageQueries();
  }

  return [
    threadStorageFilesForThreadQueryKeyPrefix(threadId),
    threadStorageLocationQueryKey(threadId),
    threadStoragePathsForThreadQueryKeyPrefix(threadId),
    threadStorageFilePreviewQueryKeyPrefix(threadId),
  ];
}

function dirtyProjectPromptHistoryQueries({
  projectId,
}: ProjectRealtimeDirtyContext | ThreadRealtimeDirtyContext): QueryKey[] {
  return getProjectPromptHistoryInvalidationQueryKeys({ projectId });
}

function markThreadDetailQueryStale({
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  if (!threadId) {
    return;
  }

  queryClient.invalidateQueries({
    queryKey: threadQueryKey(threadId),
    refetchType: "none",
  });
}

function markThreadListQueriesStale({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  queryClient.invalidateQueries({
    queryKey: sidebarNavigationQueryKey(),
    refetchType: "none",
  });

  if (!projectId) {
    queryClient.invalidateQueries({
      queryKey: threadsQueryKey(),
      refetchType: "none",
    });

    return;
  }

  for (const queryKey of getCachedProjectThreadListInvalidationQueryKeys({
    projectId,
    queryClient,
  })) {
    queryClient.invalidateQueries({
      queryKey,
      refetchType: "none",
    });
  }

  for (const queryKey of getCachedGlobalThreadListInvalidationQueryKeys({
    queryClient,
  })) {
    queryClient.invalidateQueries({
      exact: true,
      queryKey,
      refetchType: "none",
    });
  }
}

function patchThreadListPendingInteractionState({
  hasPendingInteraction,
  queryClient,
  threadId,
}: ThreadRealtimePatchContext): void {
  if (hasPendingInteraction === undefined) {
    return;
  }

  updateCachedThreadListPendingInteractionState(
    queryClient,
    threadId,
    hasPendingInteraction,
  );
}

function patchThreadStatusState({
  queryClient,
  statusChange,
  threadId,
}: ThreadRealtimePatchContext): void {
  if (!statusChange) return;
  updateCachedThreadListStatusState(queryClient, threadId, statusChange);
  updateCachedThreadStatusState(queryClient, threadId, statusChange);
}

function refreshThreadListStatusState(
  context: ThreadRealtimeDirtyContext,
): void {
  const { flushOnce, queryClient, statusChange, threadId } = context;

  if (
    !threadId ||
    (statusChange === undefined && !hasCurrentThreadListEntry(context))
  ) {
    dirtyActiveThreadListQueries(context);

    return;
  }

  invalidateFetchingThreadListQueries(queryClient);

  if (flushOnce("thread-search:status-changed")) {
    invalidateQueryKeysWithoutCancelingActiveFetches({
      queryClient,
      queryKeys: [threadSearchQueryKeyPrefix()],
    });
  }
}

function dirtyEnvironmentRecordQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentRecordInvalidationQueryKeys(context);
}

function resetEnvironmentCommandCatalogQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): void {
  void queryClient.resetQueries({
    queryKey: allProjectCommandCatalogQueryKeyPrefix(),
    predicate: ({ queryKey }) => queryKey[3] === environmentId,
  });
}

function dirtyEnvironmentWorkspaceStateQueries(
  context: EnvironmentRealtimeDirtyContext,
): void {
  bumpDiffPatchFreshnessGeneration(context.environmentId);

  for (const queryKey of getEnvironmentWorkspaceStateInvalidationQueryKeys(
    context,
  )) {
    context.queryClient.invalidateQueries({ queryKey });
  }
}

function dirtyEnvironmentLiveWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): void {
  bumpDiffPatchFreshnessGeneration(environmentId);
  invalidateQueryKeyWithThrottledActiveRefetch({
    exact: false,
    minIntervalMs: WORK_STATUS_REFETCH_MIN_INTERVAL_MS,
    queryClient,
    queryKey: environmentWorkStatusQueryKeyPrefix(environmentId),
  });
  queryClient.invalidateQueries({
    queryKey: environmentFilePreviewQueryKeyPrefix(environmentId),
  });
  queryClient.invalidateQueries({
    queryKey: environmentDiffFilesQueryKeyPrefix(environmentId),
  });
}

function dirtyEnvironmentRefDerivedWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): void {
  bumpDiffPatchFreshnessGeneration(environmentId);

  for (const queryKey of getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(
    queryClient,
    { environmentId },
  )) {
    queryClient.invalidateQueries({ queryKey });
  }
}

function dirtyEnvironmentBranchListQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentBranchListInvalidationQueryKeys(context);
}

function dirtyEnvironmentThreadListQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  const queryKeys: QueryKey[] = [];

  for (const { data, queryKey } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.environmentId !== environmentId) {
        continue;
      }

      queryKeys.push(queryKey);
      break;
    }
  }

  const sidebarContainsEnvironment = getCachedSidebarNavigationThreads(
    queryClient,
  ).some((thread) => thread.environmentId === environmentId);

  if (sidebarContainsEnvironment) {
    queryKeys.push(sidebarNavigationQueryKey());
  }

  return queryKeys;
}

function dirtyThreadStorageQueriesForEnvironment({
  getCachedThreadIdsForEnvironment,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  const queryKeys: QueryKey[] = [];

  for (const threadId of getCachedThreadIdsForEnvironment()) {
    queryKeys.push(threadStorageFilesForThreadQueryKeyPrefix(threadId));
    queryKeys.push(threadStoragePathsForThreadQueryKeyPrefix(threadId));
    queryKeys.push(threadStorageFilePreviewQueryKeyPrefix(threadId));
  }

  return queryKeys;
}

function dirtyAllThreadStorageQueries(): QueryKey[] {
  return [
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageLocationsQueryKeyPrefix(),
    allThreadStoragePathsQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
  ];
}

function dirtyHostAvailabilityQueries(): QueryKey[] {
  return [hostsQueryKey(), allHostQueryKeyPrefix()];
}

function dirtySystemConfigQueries({ queryClient }: RealtimeDirtyContext): void {
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [
      systemConfigQueryKey(),
      systemAiServicesQueryKey(),
      allSystemThemesQueryKeyPrefix(),
    ],
  });
}

function dirtyMachineEnvironmentQueries({
  queryClient,
}: RealtimeDirtyContext): void {
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [allMachineEnvironmentQueryKeyPrefix()],
  });
}

function dirtyUiPreferencesQueries({
  queryClient,
}: RealtimeDirtyContext): void {
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [uiPreferencesQueryKey()],
  });
}

function dirtyServerMoveStatusQueries(): QueryKey[] {
  return [serverMoveStatusQueryKey()];
}

function dirtyAppUpdateStatusQueries(): QueryKey[] {
  return [systemAppUpdateQueryKey()];
}

function dirtyPluginInstallJobQueries(): QueryKey[] {
  return [pluginInstallJobsQueryKey()];
}

function dirtyAllThreadTimelineQueries(): QueryKey[] {
  return getThreadTimelineInvalidationQueryKeys({ threadId: undefined });
}

function dirtySystemProviderQueries(): QueryKey[] {
  return [allSystemProvidersQueryKeyPrefix(), systemProviderCatalogQueryKey()];
}

function dirtySystemExecutionOptionQueries(): QueryKey[] {
  return [allSystemExecutionOptionsQueryKeyPrefix()];
}

function dirtyHostSystemExecutionOptionQueries({
  hostId,
  queryClient,
}: HostRealtimeDirtyContext): QueryKey[] | void {
  if (hostId === undefined) return [allSystemExecutionOptionsQueryKeyPrefix()];
  void invalidateSystemExecutionOptions({ hostId, queryClient });
}

function dirtyPluginContributionQueries(): QueryKey[] {
  return [allPluginContributionsQueryKeyPrefix()];
}

function dirtyProjectCommandCatalogQueries({
  queryClient,
}: RealtimeDirtyContext): void {
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [allProjectCommandCatalogQueryKeyPrefix()],
  });
}

function dirtyPluginManagementQueries(): QueryKey[] {
  return [
    allPluginListQueryKeyPrefix(),
    allPluginSettingsViewQueryKeyPrefix(),
    allPluginSettingsQueryKeyPrefix(),
    allPluginSourceQueryKeyPrefix(),
    allPluginCatalogSearchQueryKeyPrefix(),
    pluginSafeModeQueryKey(),
  ];
}

function dirtyEnvironmentProviderQueries(): QueryKey[] {
  return [systemEnvironmentProvidersQueryKey()];
}

function reconcilePluginFrontendBundles(): void {
  schedulePluginFrontendReconcile();
}

function dirtyInboxSnapshot({ queryClient }: RealtimeDirtyContext): QueryKey[] {
  markInboxSnapshotDirty(queryClient);

  return [];
}
