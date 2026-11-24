import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  Thread,
  ThreadListEntry,
  ThreadStatusChangeMetadata,
} from "@omnyo/domain";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import { bumpDiffPatchEvictionGeneration } from "./environment-diff-patch-cache-owner";
import { patchCachedQueryData } from "./cache-effect-utils";
import { readCachedSidebarBootstrap } from "@/lib/sidebar-bootstrap-cache";
import {
  getComposerThreadStateGeneration,
  getComposerStateGeneration,
  hasPendingComposerThreadState,
  reconcileComposerThreadState,
} from "./pending-composer-cache-owner";
import type {
  SidebarBootstrapResponse,
  ThreadResponse,
  ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import {
  ARCHIVED_THREADS_LIST_KIND,
  SHELVED_THREADS_LIST_KIND,
  ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  environmentDiffFilesQueryKeyPrefix,
  environmentDiffPatchQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentPullRequestQueryKey,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  SIDEBAR_NAVIGATION_QUERY_KEY,
  sidebarNavigationQueryKey,
  THREADS_QUERY_KEY,
  threadQueryKey,
  threadsQueryKey,
  type EnvironmentWorkStatusQueryKey,
  type ArchivedThreadsListFilters,
  type ThreadListQueryFilters,
} from "../queries/query-keys";

interface EnvironmentInvalidationParams {
  environmentId: string;
}

interface EnvironmentDiffPatchRemovalParams {
  environmentId: string;
  queryClient: QueryClient;
}

interface ProjectThreadListInvalidationParams {
  projectId: string;
  queryClient: QueryClient;
}

interface CachedGlobalThreadListInvalidationParams {
  queryClient: QueryClient;
}

type SidebarNavigationProject = SidebarBootstrapResponse["projects"][number];

export type CachedThreadListsAndSidebarNavigationMapper = (
  threads: ThreadListEntry[],
) => ThreadListEntry[];

type SidebarNavigationThreadMapper = (
  threads: ThreadListEntry[],
  projectId: string,
) => ThreadListEntry[];

interface ApplyToCachedSidebarNavigationThreadsArgs {
  mapper: SidebarNavigationThreadMapper;
  queryClient: QueryClient;
}

export type CachedSidebarNavigationSnapshot =
  | SidebarBootstrapResponse
  | undefined;

function getThreadListFiltersFromQueryKey(
  queryKey: QueryKey,
): ThreadListQueryFilters | undefined {
  if (queryKey[0] !== THREADS_QUERY_KEY) {
    return undefined;
  }

  const candidate = queryKey[1];

  if (candidate === undefined) {
    return undefined;
  }

  if (!isThreadListQueryFilters(candidate)) {
    return undefined;
  }

  return candidate;
}

function isThreadListQueryFilters(
  candidate: unknown,
): candidate is ThreadListQueryFilters {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return false;
  }

  if (!("archived" in candidate) || typeof candidate.archived !== "boolean") {
    return false;
  }

  if (
    "projectId" in candidate &&
    candidate.projectId !== undefined &&
    typeof candidate.projectId !== "string"
  ) {
    return false;
  }

  if (
    "parentThreadId" in candidate &&
    candidate.parentThreadId !== undefined &&
    typeof candidate.parentThreadId !== "string"
  ) {
    return false;
  }

  if (
    "limit" in candidate &&
    candidate.limit !== undefined &&
    typeof candidate.limit !== "number"
  ) {
    return false;
  }

  return true;
}

function isPagedThreadListFilters(
  candidate: unknown,
): candidate is ArchivedThreadsListFilters {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return false;
  }

  for (const key of Object.keys(candidate)) {
    if (key !== "projectId" && key !== "kind") {
      return false;
    }
  }

  if ("projectId" in candidate && candidate.projectId !== undefined) {
    if (typeof candidate.projectId !== "string") {
      return false;
    }
  }

  if (
    "kind" in candidate &&
    candidate.kind !== undefined &&
    candidate.kind !== "all" &&
    candidate.kind !== "root" &&
    candidate.kind !== "child"
  ) {
    return false;
  }

  return true;
}

const PAGED_THREAD_LIST_KINDS: ReadonlySet<unknown> = new Set([
  ARCHIVED_THREADS_LIST_KIND,
  SHELVED_THREADS_LIST_KIND,
]);

function getPagedThreadListFiltersFromQueryKey(
  queryKey: QueryKey,
): ArchivedThreadsListFilters | undefined {
  if (
    queryKey[0] !== THREADS_QUERY_KEY ||
    !PAGED_THREAD_LIST_KINDS.has(queryKey[1])
  ) {
    return undefined;
  }

  const filters = queryKey[2];

  if (!isPagedThreadListFilters(filters)) {
    return undefined;
  }

  return filters;
}

export function isPagedThreadListQueryKey(queryKey: QueryKey): boolean {
  return getPagedThreadListFiltersFromQueryKey(queryKey) !== undefined;
}

export function getCachedThreadListQueryKeys(
  queryClient: QueryClient,
): QueryKey[] {
  const queryKeys: QueryKey[] = [];

  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadsQueryKey(),
  })) {
    if (
      getThreadListFiltersFromQueryKey(queryKey) !== undefined ||
      getPagedThreadListFiltersFromQueryKey(queryKey) !== undefined
    ) {
      queryKeys.push(queryKey);
    }
  }

  return queryKeys;
}

function getThreadListProjectIdFromQueryKey(
  queryKey: QueryKey,
): string | undefined {
  const pagedFilters = getPagedThreadListFiltersFromQueryKey(queryKey);

  if (pagedFilters) {
    return pagedFilters.projectId;
  }

  if (queryKey[0] !== THREADS_QUERY_KEY) {
    return undefined;
  }

  return getThreadListFiltersFromQueryKey(queryKey)?.projectId;
}

export function getCachedProjectThreadListInvalidationQueryKeys({
  projectId,
  queryClient,
}: ProjectThreadListInvalidationParams): QueryKey[] {
  const queryKeys: QueryKey[] = [];

  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadsQueryKey(),
  })) {
    if (getThreadListProjectIdFromQueryKey(queryKey) === projectId) {
      queryKeys.push(queryKey);
    }
  }

  return queryKeys;
}

export function getCachedGlobalThreadListInvalidationQueryKeys({
  queryClient,
}: CachedGlobalThreadListInvalidationParams): QueryKey[] {
  const queryKeys: QueryKey[] = [];

  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadsQueryKey(),
  })) {
    const pagedFilters = getPagedThreadListFiltersFromQueryKey(queryKey);

    if (pagedFilters !== undefined && pagedFilters.projectId === undefined) {
      queryKeys.push(queryKey);
      continue;
    }

    const filters = getThreadListFiltersFromQueryKey(queryKey);

    if (filters !== undefined && filters.projectId === undefined) {
      queryKeys.push(queryKey);
    }
  }

  return queryKeys;
}

function mapSidebarNavigationProjectThreads(
  project: SidebarNavigationProject,
  mapper: SidebarNavigationThreadMapper,
): SidebarNavigationProject {
  return {
    ...project,
    threads: mapper(project.threads, project.id),
  };
}

export function applyToCachedSidebarNavigationThreads({
  mapper,
  queryClient,
}: ApplyToCachedSidebarNavigationThreadsArgs): void {
  patchCachedQueryData<SidebarBootstrapResponse>(
    queryClient,
    sidebarNavigationQueryKey(),
    (currentNavigation) => {
      if (!currentNavigation) {
        return currentNavigation;
      }

      return {
        ...currentNavigation,
        projects: currentNavigation.projects.map((project) =>
          mapSidebarNavigationProjectThreads(project, mapper),
        ),
        personalProject: mapSidebarNavigationProjectThreads(
          currentNavigation.personalProject,
          mapper,
        ),
      };
    },
  );
}

export function applyToCachedThreadListsAndSidebarNavigation(
  queryClient: QueryClient,
  mapper: CachedThreadListsAndSidebarNavigationMapper,
): void {
  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper,
  });
  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper,
  });
}

export function listSidebarNavigationThreads(
  navigation: SidebarBootstrapResponse,
): ThreadListEntry[] {
  return [
    ...navigation.projects.flatMap((project) => project.threads),
    ...navigation.personalProject.threads,
  ];
}

export function getCachedSidebarNavigationThreads(
  queryClient: QueryClient,
): ThreadListEntry[] {
  const navigation = queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  );

  if (!navigation) {
    return [];
  }

  return listSidebarNavigationThreads(navigation);
}

export function findSidebarNavigationThreadPlaceholder(
  queryClient: QueryClient,
  threadId: string,
): ThreadListEntry | undefined {
  if (!threadId) {
    return undefined;
  }

  const cached = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );

  if (cached !== undefined) {
    return cached;
  }

  const persisted = readCachedSidebarBootstrap();

  return persisted === null
    ? undefined
    : listSidebarNavigationThreads(persisted).find(
        (thread) => thread.id === threadId,
      );
}

export function snapshotCachedSidebarNavigation(
  queryClient: QueryClient,
): CachedSidebarNavigationSnapshot {
  return queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  );
}

export function restoreCachedSidebarNavigation(
  queryClient: QueryClient,
  snapshot: CachedSidebarNavigationSnapshot,
): void {
  patchCachedQueryData(queryClient, sidebarNavigationQueryKey(), snapshot);
}

export function getEnvironmentRecordInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [environmentQueryKey(environmentId)];
}

export function getEnvironmentWorkspaceStateInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [
    environmentWorkStatusQueryKeyPrefix(environmentId),
    environmentPullRequestQueryKey(environmentId),
    environmentDiffFilesQueryKeyPrefix(environmentId),
    environmentFilePreviewQueryKeyPrefix(environmentId),
  ];
}

export function removeEnvironmentDiffPatchQueries({
  environmentId,
  queryClient,
}: EnvironmentDiffPatchRemovalParams): void {
  bumpDiffPatchEvictionGeneration(environmentId);
  queryClient.removeQueries({
    queryKey: environmentDiffPatchQueryKeyPrefix(environmentId),
  });
}

export function getEnvironmentBranchListInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [environmentMergeBaseBranchesQueryKeyPrefix(environmentId)];
}

function isEnvironmentWorkStatusQueryKeyForEnvironment(
  queryKey: QueryKey,
  environmentId: string,
): queryKey is EnvironmentWorkStatusQueryKey {
  return (
    queryKey[0] === ENVIRONMENT_WORK_STATUS_QUERY_KEY &&
    queryKey[1] === environmentId &&
    (typeof queryKey[2] === "string" || queryKey[2] === null)
  );
}

function isMergeBaseEnvironmentWorkStatusQueryKey(
  queryKey: QueryKey,
  environmentId: string,
): queryKey is EnvironmentWorkStatusQueryKey {
  return (
    isEnvironmentWorkStatusQueryKeyForEnvironment(queryKey, environmentId) &&
    typeof queryKey[2] === "string"
  );
}

export function getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(
  queryClient: QueryClient,
  { environmentId }: EnvironmentInvalidationParams,
): QueryKey[] {
  const queryKeys: QueryKey[] = [];

  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: environmentWorkStatusQueryKeyPrefix(environmentId),
  })) {
    if (isMergeBaseEnvironmentWorkStatusQueryKey(queryKey, environmentId)) {
      queryKeys.push(environmentWorkStatusQueryKey(environmentId, queryKey[2]));
    }
  }

  queryKeys.push(environmentDiffFilesQueryKeyPrefix(environmentId));

  return queryKeys;
}

export function getEnvironmentActionInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [
    ...getEnvironmentWorkspaceStateInvalidationQueryKeys({ environmentId }),
    ...getEnvironmentBranchListInvalidationQueryKeys({ environmentId }),
    threadsQueryKey(),
  ];
}

export function getCachedThreadListPlaceholder(
  queryClient: QueryClient,
  threadId: string,
): ThreadListEntry | undefined {
  if (!threadId) {
    return undefined;
  }

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.id === threadId) {
        return thread;
      }
    }
  }

  return undefined;
}

export function updateCachedThread(
  queryClient: QueryClient,
  threadId: string,
  updater: (thread: ThreadResponse) => ThreadResponse,
): void {
  queryClient.setQueryData<ThreadResponse>(
    threadQueryKey(threadId),
    (thread) => {
      if (!thread) {
        return thread;
      }

      return updater(thread);
    },
  );
}

function threadMatchesListFilters(
  thread: Thread,
  filters: ThreadListQueryFilters | undefined,
): boolean {
  if (!filters) {
    return false;
  }

  if (filters.archived && thread.archivedAt == null) {
    return false;
  }

  if (!filters.archived && thread.archivedAt != null) {
    return false;
  }

  if (filters?.projectId && thread.projectId !== filters.projectId) {
    return false;
  }

  if (
    filters?.hasParent !== undefined &&
    (thread.parentThreadId !== null) !== filters.hasParent
  ) {
    return false;
  }

  if (
    filters?.parentThreadId !== undefined &&
    thread.parentThreadId !== filters.parentThreadId
  ) {
    return false;
  }

  if (
    filters?.sourceThreadId !== undefined &&
    thread.sourceThreadId !== filters.sourceThreadId
  ) {
    return false;
  }

  if (
    filters?.originKind !== undefined &&
    thread.originKind !== filters.originKind
  ) {
    return false;
  }

  if (thread.visibility === "hidden" || thread.pluginHome) {
    return false;
  }

  return true;
}

export function optimisticallyInsertThread(
  queryClient: QueryClient,
  thread: ThreadResponse,
  environmentHostId: string | null = null,
): void {
  const queuedWork = thread.queuedMessageCount > 0 ? "waiting" : "none";

  const insertedThread: ThreadListEntry = {
    ...thread,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
      activeSubagentCount: 0,
    },
    environmentBranchName: null,
    environmentHostId,
    environmentName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentWorkspaceDisplayKind: "other",
    runtime: thread.runtime,
    hasPendingInteraction: false,
    pinSortKey: null,
    shelfSortKey: null,
    queuedWork,
  };

  const upsertThread = (threads: ThreadListEntry[]): ThreadListEntry[] => {
    const existingIndex = threads.findIndex(
      (candidate) => candidate.id === thread.id,
    );

    if (existingIndex === -1) {
      return [insertedThread, ...threads];
    }

    return threads.map((candidate, index) =>
      index === existingIndex
        ? {
            ...candidate,
            queuedWork:
              candidate.queuedWork === "none"
                ? queuedWork
                : candidate.queuedWork,
          }
        : candidate,
    );
  };

  for (const { queryKey, data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    if (!Array.isArray(data)) {
      continue;
    }

    const filters = getThreadListFiltersFromQueryKey(queryKey);

    if (!threadMatchesListFilters(thread, filters)) {
      continue;
    }

    patchCachedQueryData<ThreadListEntry[]>(
      queryClient,
      queryKey,
      upsertThread(data),
    );
  }

  if (
    thread.visibility === "hidden" ||
    thread.pluginHome ||
    thread.archivedAt !== null
  ) {
    return;
  }

  patchCachedQueryData<SidebarBootstrapResponse>(
    queryClient,
    sidebarNavigationQueryKey(),
    (navigation) => {
      if (!navigation) {
        return navigation;
      }

      const updateProject = (
        project: SidebarNavigationProject,
      ): SidebarNavigationProject =>
        project.id === thread.projectId
          ? mapSidebarNavigationProjectThreads(project, upsertThread)
          : project;

      return {
        ...navigation,
        projects: navigation.projects.map(updateProject),
        personalProject: updateProject(navigation.personalProject),
      };
    },
  );
}

export function updateCachedThreadListPendingInteractionState(
  queryClient: QueryClient,
  threadId: string,
  hasPendingInteraction: boolean,
): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) => {
    if (!list.some((thread) => thread.id === threadId)) {
      return list;
    }

    return list.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            hasPendingInteraction,
            work:
              thread.hasPendingInteraction === hasPendingInteraction
                ? thread.work
                : null,
          }
        : thread,
    );
  });
}

const THREAD_LIST_PLACEMENT_FIELDS = [
  "projectId",
  "parentThreadId",
  "sourceThreadId",
  "originKind",
  "visibility",
  "archivedAt",
  "shelvedAt",
  "shelfSortKey",
  "sectionId",
  "pinnedAt",
  "pinSortKey",
  "environmentHostId",
] as const satisfies readonly (keyof ThreadListEntry)[];

function findCachedThreadListEntry(
  queryClient: QueryClient,
  threadId: string,
): ThreadListEntry | undefined {
  const sidebarEntry = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );

  if (sidebarEntry) {
    return sidebarEntry;
  }

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.id === threadId) {
        return thread;
      }
    }
  }

  return undefined;
}

export function isCachedThreadListPlacementCurrent(
  queryClient: QueryClient,
  entry: ThreadListEntry,
): boolean {
  const cached = findCachedThreadListEntry(queryClient, entry.id);

  return (
    cached !== undefined &&
    THREAD_LIST_PLACEMENT_FIELDS.every(
      (field) => cached[field] === entry[field],
    )
  );
}

export function replaceCachedThreadListEntry(
  queryClient: QueryClient,
  entry: ThreadListEntry,
): void {
  updateCachedThread(queryClient, entry.id, (thread) =>
    entry.updatedAt < thread.updatedAt
      ? thread
      : { ...thread, work: entry.work },
  );

  const placementCurrent = isCachedThreadListPlacementCurrent(
    queryClient,
    entry,
  );

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.some((thread) => thread.id === entry.id)
      ? list.map((thread) =>
          thread.id !== entry.id
            ? thread
            : placementCurrent
              ? reconcileComposerThreadState(
                  queryClient,
                  entry.id,
                  thread,
                  entry,
                )
              : entry.updatedAt < thread.updatedAt
                ? thread
                : reconcileComposerThreadState(queryClient, entry.id, thread, {
                    ...thread,
                    work: entry.work,
                  }),
        )
      : list,
  );
}

export function updateCachedThreadListStatusState(
  queryClient: QueryClient,
  threadId: string,
  statusChange: ThreadStatusChangeMetadata,
): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) => {
    if (!list.some((thread) => thread.id === threadId)) {
      return list;
    }

    return list.map((thread) =>
      thread.id === threadId
        ? reconcileComposerThreadState(queryClient, threadId, thread, {
            ...thread,
            ...statusChange,
            work: null,
          })
        : thread,
    );
  });
}

export function updateCachedThreadStatusState(
  queryClient: QueryClient,
  threadId: string,
  statusChange: ThreadStatusChangeMetadata,
): void {
  updateCachedThread(queryClient, threadId, (thread) =>
    reconcileComposerThreadState(queryClient, threadId, thread, {
      ...thread,
      ...statusChange,
      work: null,
    }),
  );
}

export function captureThreadListRead(
  queryClient: QueryClient,
  previous: readonly ThreadListEntry[],
) {
  const baseline = new Map(previous.map((thread) => [thread.id, thread]));
  const generation = getComposerStateGeneration(queryClient);

  return (
    incoming: ThreadListEntry[],
    current: readonly ThreadListEntry[],
  ): ThreadListEntry[] => {
    const byId = new Map(current.map((thread) => [thread.id, thread]));

    return incoming.map((thread) => {
      const cached = byId.get(thread.id);
      const before = baseline.get(thread.id);

      const stale =
        cached !== before ||
        getComposerThreadStateGeneration(queryClient, thread.id) > generation ||
        hasPendingComposerThreadState(queryClient, thread.id);

      if (stale && cached !== undefined) return cached;

      return reconcileComposerThreadState(
        queryClient,
        thread.id,
        cached,
        thread,
        stale ? "stale-read" : "fresh-read",
      );
    });
  };
}

export async function readSidebarNavigation(
  queryClient: QueryClient,
  load: () => Promise<SidebarBootstrapResponse>,
): Promise<SidebarBootstrapResponse> {
  const key = sidebarNavigationQueryKey();
  const previous = queryClient.getQueryData<SidebarBootstrapResponse>(key);

  const reconcile = captureThreadListRead(
    queryClient,
    previous ? listSidebarNavigationThreads(previous) : [],
  );

  const response = await load();
  const current = queryClient.getQueryData<SidebarBootstrapResponse>(key);
  const currentThreads = current ? listSidebarNavigationThreads(current) : [];

  const project = (
    entry: SidebarNavigationProject,
  ): SidebarNavigationProject => ({
    ...entry,
    threads: reconcile(entry.threads, currentThreads),
  });

  return {
    ...response,
    projects: response.projects.map(project),
    personalProject: project(response.personalProject),
  };
}

export async function readThreadList(
  queryClient: QueryClient,
  key: QueryKey,
  load: () => Promise<ThreadListEntry[]>,
): Promise<ThreadListEntry[]> {
  const previous = queryClient.getQueryData<ThreadListEntry[]>(key) ?? [];
  const reconcile = captureThreadListRead(queryClient, previous);
  const response = await load();

  return reconcile(
    response,
    queryClient.getQueryData<ThreadListEntry[]>(key) ?? [],
  );
}

export async function readThreadState<
  T extends ThreadResponse | ThreadWithIncludesResponse,
>(
  queryClient: QueryClient,
  threadId: string,
  load: () => Promise<T>,
): Promise<T> {
  const key = threadQueryKey(threadId);
  const previous = queryClient.getQueryData<ThreadResponse>(key);
  const generation = getComposerThreadStateGeneration(queryClient, threadId);
  const response = await load();
  const current = queryClient.getQueryData<ThreadResponse>(key);

  const stale =
    current !== previous ||
    generation !== getComposerThreadStateGeneration(queryClient, threadId) ||
    hasPendingComposerThreadState(queryClient, threadId);

  if (stale && current !== undefined) return { ...response, ...current };

  return reconcileComposerThreadState(
    queryClient,
    threadId,
    current ? { ...response, ...current } : undefined,
    response,
    stale ? "stale-read" : "fresh-read",
  );
}

export function getFetchingThreadListQueryKeys(
  queryClient: QueryClient,
): QueryKey[] {
  return queryClient
    .getQueryCache()
    .findAll({ fetchStatus: "fetching" })
    .map((query) => query.queryKey)
    .filter(
      (queryKey) =>
        queryKey[0] === SIDEBAR_NAVIGATION_QUERY_KEY ||
        getThreadListFiltersFromQueryKey(queryKey) !== undefined ||
        getPagedThreadListFiltersFromQueryKey(queryKey) !== undefined,
    );
}
