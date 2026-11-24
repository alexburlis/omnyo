import {
  prependOlderTimelineRows,
  areTimelineHistorySnapshotsCompatible,
  resolveLoadedTimelineSurfaceKey,
} from "@omnyo/client-core";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type NotifyOnChangeProps,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { isPendingChatId } from "@/lib/pending-chat-creations";
import { mergePendingComposerQueuedMessages } from "../cache-owners/pending-composer-cache-owner";
import { beginPendingSentMessageRead } from "../cache-owners/pending-sent-messages";
import { COMPACT_VIEWPORT_QUERY } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { getMediaQuerySnapshot } from "@omnyo/shared-ui/hooks/use-media-query";
import type { PendingInteraction, ThreadListEntry } from "@omnyo/domain";
import type {
  PromptHistoryResponse,
  ThreadQueuedMessageListResponse,
  ThreadListResponse,
  ThreadPendingInteractionsResponse,
  ThreadResponse,
  ThreadSearchResponse,
  ThreadWithIncludesResponse,
  ThreadConversationOutlineResponse,
  ThreadStorageFileListResponse,
  ThreadStorageLocationResponse,
  ThreadStoragePathListResponse,
  ThreadTimelineResponse,
  TimelineRow,
  TimelineTurnSummaryDetailsResponse,
} from "@omnyo/server-contract";
import { useDebouncedValue } from "../useDebouncedValue";
import { applyTimelineDelta } from "@omnyo/server-contract";
import type { ThreadListFilters } from "@omnyo/client-core";
import type { FilePreview } from "@omnyo/client-core";
import type { PathListOptions } from "@/lib/path-list-options";
import type { ThreadStorageFileListOptions } from "@/lib/thread-storage-files";
import * as api from "@/lib/api";
import { sdk } from "@/lib/sdk";
import {
  useThreadDetailRealtimeSubscription,
  useThreadListRealtimeSubscription,
} from "@/hooks/useRealtimeSubscription";
import {
  getCachedSidebarNavigationThreads,
  getCachedThreadListPlaceholder,
  findSidebarNavigationThreadPlaceholder,
  readThreadList,
  readThreadState,
} from "../cache-owners/query-cache";
import { useSidebarNavigationThreadSelection } from "./sidebar-navigation-query";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "../cache-owners/thread-list-cache-data";
import type { ArchivedThreadsKindFilter } from "./query-keys";
import {
  resolveThreadPlaceholder,
  resolveThreadTimelinePlaceholder,
} from "./query-placeholders";
import {
  PROMPT_HISTORY_STALE_TIME_MS,
  requireEnabledQueryArg,
  requireThreadId,
  shouldRetryTransientReadQuery,
  TRANSIENT_READ_RETRY_DELAY_MS,
} from "./query-helpers";
import {
  HEAVY_PAYLOAD_QUERY_POLICY,
  REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
  REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
  RESUME_REFETCH_QUERY_POLICY,
} from "./query-policies";
import {
  archivedThreadsListQueryKey,
  disabledThreadListQueryKey,
  threadDetailBootstrapQueryKey,
  threadPluginBootstrapQueryKey,
  threadQueuedMessagesQueryKey,
  threadListQueryKey,
  threadPendingInteractionsQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadSearchQueryKey,
  threadStorageFilesQueryKey,
  threadStorageLocationQueryKey,
  threadStoragePathsQueryKey,
  threadStorageFilePreviewQueryKey,
  threadHostFilePreviewQueryKey,
  threadConversationOutlineQueryKey,
  shelvedThreadsListQueryKey,
  threadTimelineQueryKey,
  threadTimelineTurnSummaryDetailsQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  threadsQueryKey,
  type ThreadConversationOutlineRole,
  type ThreadTimelineTurnSummaryDetailsQueryIdentity,
} from "./query-keys";
import { ARCHIVED_THREADS_PAGE_SIZE } from "./archived-threads-page-size";
import { prefetchEnvironmentWorkStatus } from "./environment-queries";
import { ingestThreadDetailBootstrap } from "../cache-owners/thread-detail-cache-owner";
import {
  getCompletedThreadTimelineDetails,
  getThreadOpenRuntimeId,
  getThreadTimelineRuntimeId,
  getThreadTimelineHistoryGeneration,
  isThreadTimelineForRuntimeCurrent,
  rememberCompletedThreadTimelineDetails,
  rememberThreadOpenRuntimeId,
  rememberThreadTimelineRuntimeId,
  THREAD_OPEN_CACHE_GC_MS,
  THREAD_TIMELINE_DEFER_CONTENT,
  touchThreadOpenCache,
  activateThreadOpenCache,
  admitThreadTimelineHistory,
  schedulePersistedThreadTimelineDisplay,
} from "../cache-owners/thread-open-cache-owner";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";
import { hasThreadTimelineUnseenEvents } from "../cache-owners/thread-timeline-unseen-events";
import { prefetchThreadDefaultExecutionOptions } from "./thread-default-execution-options-query";

interface QueryOptions {
  enabled?: boolean;
  refetchOnMount?: boolean | "always";
  staleTime?: number;
}

export const THREAD_LIST_STALE_TIME_MS = 10_000;

const THREAD_SEARCH_STALE_TIME_MS = 10_000;

const THREAD_DETAIL_STALE_TIME_MS = 5_000;

const THREAD_MENTION_CANDIDATE_LIMIT = 200;

const THREAD_SEARCH_DEBOUNCE_MS = 150;

export const THREAD_SEARCH_LIMIT_PER_GROUP = 20;

const THREAD_SEARCH_MIN_NON_WHITESPACE_CHARS = 2;

const THREAD_OPEN_RUNTIME_IDENTITY_FRESH_MS = 1_000;

interface ThreadDetailBootstrapQueryOptions extends QueryOptions {
  timelinePrefetch?: boolean;
}

export function didThreadDetailBootstrapRefreshAfterMount(query: {
  dataUpdatedAt: number;
  isFetchedAfterMount: boolean;
  isSuccess: boolean;
}): boolean {
  return (
    query.isSuccess &&
    (query.isFetchedAfterMount ||
      (query.dataUpdatedAt > 0 &&
        Date.now() - query.dataUpdatedAt <= THREAD_DETAIL_STALE_TIME_MS))
  );
}

interface ThreadTimelineQueryOptions extends QueryOptions {
  notifyOnChangeProps?: NotifyOnChangeProps;
}

type ThreadConversationOutlineQueryOptions = QueryOptions;

type ThreadTimelineTurnSummaryDetailsQueryOptions = QueryOptions;

type ThreadQueuedMessagesQueryOptions = QueryOptions;

type ThreadPromptHistoryQueryOptions = QueryOptions;

type ThreadPendingInteractionsQueryOptions = QueryOptions;

interface UseThreadsFilters extends Omit<
  ThreadListFilters,
  "archived" | "projectId"
> {
  archived: boolean;
  projectId?: string;
}

export interface ProjectThreadSubsetFilters {
  hasParent?: ThreadListFilters["hasParent"];
  parentThreadId?: string;
}

interface UseProjectThreadSubsetArgs {
  enabled?: boolean;
  filters: ProjectThreadSubsetFilters;
  projectId: string | undefined;
}

interface UseProjectThreadSubsetResult {
  data: ThreadListResponse | undefined;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  retry: () => void;
}

interface UseThreadMentionCandidatesResult {
  data: ThreadListResponse | undefined;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
}

interface UseThreadSearchArgs {
  active: boolean;
  limitPerGroup?: number;
  query: string;
}

export interface UseThreadSearchResult {
  data: ThreadSearchResponse | undefined;
  debouncedQuery: string;
  hasSearchableQuery: boolean;
  isDebouncing: boolean;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
}

interface BuildThreadSubsetListFiltersArgs {
  filters: ProjectThreadSubsetFilters;
  projectId: string | undefined;
}

interface UseThreadMentionCandidatesArgs {
  enabled?: boolean;
}

type ThreadListItem = ThreadListResponse[number];

interface GetThreadMentionCandidatePlaceholderArgs {
  limit: number;
  queryClient: QueryClient;
}

const THREAD_MENTION_CANDIDATE_FILTERS = {
  archived: false,
  limit: THREAD_MENTION_CANDIDATE_LIMIT,
} satisfies UseThreadsFilters;

function buildThreadSubsetListFilters({
  filters,
  projectId,
}: BuildThreadSubsetListFiltersArgs): UseThreadsFilters {
  const listFilters: UseThreadsFilters = {
    archived: false,
  };

  if (projectId !== undefined) {
    listFilters.projectId = projectId;
  }

  if (filters.parentThreadId !== undefined) {
    listFilters.parentThreadId = filters.parentThreadId;
  }

  if (filters.hasParent !== undefined) {
    listFilters.hasParent = filters.hasParent;
  }

  return listFilters;
}

function threadMatchesProjectThreadSubset(
  thread: ThreadListItem,
  filters: ProjectThreadSubsetFilters,
): boolean {
  if (
    filters.parentThreadId !== undefined &&
    thread.parentThreadId !== filters.parentThreadId
  ) {
    return false;
  }

  if (
    filters.hasParent !== undefined &&
    (thread.parentThreadId !== null) !== filters.hasParent
  ) {
    return false;
  }

  if (thread.visibility === "hidden" || thread.pluginHome) {
    return false;
  }

  return true;
}

function filterProjectThreadSubset(
  threads: ThreadListResponse,
  filters: ProjectThreadSubsetFilters,
): ThreadListResponse {
  return threads.filter((thread) =>
    threadMatchesProjectThreadSubset(thread, filters),
  );
}

function addThreadMentionCandidate(
  candidatesById: Map<string, ThreadListItem>,
  thread: ThreadListItem,
): void {
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    return;
  }

  if (thread.visibility === "hidden" || thread.pluginHome) {
    return;
  }

  if (!candidatesById.has(thread.id)) {
    candidatesById.set(thread.id, thread);
  }
}

const EMPTY_THREAD_LIST: ThreadListResponse = [];

function selectThreadMentionCandidates(
  threads: ThreadListEntry[],
): ThreadListResponse {
  const candidatesById = new Map<string, ThreadListItem>();

  for (const thread of threads) {
    addThreadMentionCandidate(candidatesById, thread);
  }

  return Array.from(candidatesById.values());
}

function getThreadMentionCandidatePlaceholder({
  limit,
  queryClient,
}: GetThreadMentionCandidatePlaceholderArgs): ThreadListResponse | undefined {
  const candidatesById = new Map<string, ThreadListItem>();

  for (const thread of getCachedSidebarNavigationThreads(queryClient)) {
    addThreadMentionCandidate(candidatesById, thread);
  }

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      addThreadMentionCandidate(candidatesById, thread);
    }
  }

  const candidates = Array.from(candidatesById.values()).slice(0, limit);

  return candidates.length > 0 ? candidates : undefined;
}

function countNonWhitespaceChars(value: string): number {
  return value.replace(/\s/g, "").length;
}

export function hasThreadSearchableQuery(value: string): boolean {
  return (
    countNonWhitespaceChars(value) >= THREAD_SEARCH_MIN_NON_WHITESPACE_CHARS
  );
}

export interface UseArchivedThreadsFilters {
  projectId?: string;
  kind?: ArchivedThreadsKindFilter;
}

export function useArchivedThreads(
  filters: UseArchivedThreadsFilters,
  options?: QueryOptions,
) {
  const { projectId, kind = "all" } = filters;
  const enabled = options?.enabled ?? true;
  const hasParent = kind === "all" ? undefined : kind === "child";
  useThreadListRealtimeSubscription({ enabled });

  return useInfiniteQuery<
    ThreadListResponse,
    Error,
    { pageParams: number[]; pages: ThreadListResponse[] },
    ReturnType<typeof archivedThreadsListQueryKey>,
    number
  >({
    queryKey: archivedThreadsListQueryKey({
      ...(projectId ? { projectId } : {}),
      ...(kind !== "all" ? { kind } : {}),
    }),
    queryFn: ({ pageParam, signal }) =>
      sdk.threads.list({
        ...(projectId ? { projectId } : {}),
        ...(hasParent !== undefined ? { hasParent } : {}),
        archived: true,
        limit: ARCHIVED_THREADS_PAGE_SIZE,
        offset: pageParam,
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < ARCHIVED_THREADS_PAGE_SIZE) {
        return undefined;
      }

      return allPages.reduce((sum, page) => sum + page.length, 0);
    },
    enabled,
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });
}

const SHELVED_THREADS_PAGE_SIZE = 200;

export function useShelvedThreads(options?: QueryOptions) {
  const enabled = options?.enabled ?? true;
  useThreadListRealtimeSubscription({ enabled });

  return useInfiniteQuery<
    ThreadListResponse,
    Error,
    { pageParams: number[]; pages: ThreadListResponse[] },
    ReturnType<typeof shelvedThreadsListQueryKey>,
    number
  >({
    queryKey: shelvedThreadsListQueryKey(),
    queryFn: ({ pageParam, signal }) =>
      sdk.threads.list({
        shelved: true,
        limit: SHELVED_THREADS_PAGE_SIZE,
        offset: pageParam,
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < SHELVED_THREADS_PAGE_SIZE) {
        return undefined;
      }

      return allPages.reduce((sum, page) => sum + page.length, 0);
    },
    enabled,
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });
}

export function useThreads(filters: UseThreadsFilters, options?: QueryOptions) {
  const queryClient = useQueryClient();
  const { projectId, ...rest } = filters;
  const enabled = (options?.enabled ?? true) && Boolean(projectId);
  useThreadListRealtimeSubscription({ enabled });

  const queryKey =
    enabled && projectId
      ? threadListQueryKey({ ...rest, projectId })
      : disabledThreadListQueryKey(projectId ? { ...rest, projectId } : rest);

  return useQuery<ThreadListResponse>({
    queryKey,
    queryFn: ({ signal }) =>
      readThreadList(queryClient, queryKey, () =>
        sdk.threads.list({
          ...rest,
          projectId: requireThreadId(projectId ?? "", "useThreads"),
          signal,
        }),
      ),
    enabled,
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });
}

interface MachineThreadPreview {
  threads: ThreadListResponse;
  total: number;
}

export function useMachineThreadPreview({
  hostId,
  limit,
}: {
  hostId: string | null;
  limit: number;
}) {
  const enabled = hostId !== null;
  useThreadListRealtimeSubscription({ enabled });

  return useQuery<MachineThreadPreview>({
    queryKey:
      hostId === null
        ? disabledThreadListQueryKey({ archived: false, limit })
        : threadListQueryKey({ archived: false, hostId, limit }),
    queryFn: async ({ signal }) => {
      const id = requireEnabledQueryArg({
        value: hostId,
        hookName: "useMachineThreadPreview",
        argName: "host id",
      });

      const [threads, count] = await Promise.all([
        sdk.threads.list({ archived: false, hostId: id, limit, signal }),
        sdk.threads.count({ hostId: id, signal }),
      ]);

      return { threads, total: count.total };
    },
    enabled,
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });
}

interface UseChildThreadsArgs {
  enabled: boolean;
  parentThreadId: string | undefined;
}

interface UseChildThreadsResult {
  data: ThreadListResponse | undefined;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
}

export function useChildThreads({
  enabled: enabledOption,
  parentThreadId,
}: UseChildThreadsArgs): UseChildThreadsResult {
  const enabled = enabledOption && Boolean(parentThreadId);
  useThreadListRealtimeSubscription({ enabled });

  const selectChildren = useCallback(
    (threads: ThreadListEntry[]) =>
      parentThreadId === undefined
        ? EMPTY_THREAD_LIST
        : filterProjectThreadSubset(threads, { parentThreadId }),
    [parentThreadId],
  );

  const { data: sidebarChildren, isBootstrapPending } =
    useSidebarNavigationThreadSelection(selectChildren);

  const shouldFetch =
    enabled && sidebarChildren === undefined && !isBootstrapPending;

  const fallbackQuery = useQuery<ThreadListResponse>({
    queryKey:
      shouldFetch && parentThreadId
        ? threadListQueryKey({ archived: false, parentThreadId })
        : disabledThreadListQueryKey({ archived: false }),
    queryFn: ({ signal }) =>
      sdk.threads.list({
        archived: false,
        parentThreadId: requireThreadId(
          parentThreadId ?? "",
          "useChildThreads",
        ),
        signal,
      }),
    enabled: shouldFetch,
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });

  const derivedChildren = enabled ? sidebarChildren : undefined;

  if (derivedChildren !== undefined) {
    return {
      data: derivedChildren,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
  }

  const waitingForBootstrap = enabled && isBootstrapPending;

  return {
    data: fallbackQuery.data,
    isError: fallbackQuery.isError,
    isFetching: fallbackQuery.isFetching || waitingForBootstrap,
    isLoading: fallbackQuery.isLoading || waitingForBootstrap,
  };
}

export function useProjectThreadSubset({
  enabled: enabledOption,
  filters,
  projectId,
}: UseProjectThreadSubsetArgs): UseProjectThreadSubsetResult {
  const queryClient = useQueryClient();
  const enabled = (enabledOption ?? true) && Boolean(projectId);
  useThreadListRealtimeSubscription({ enabled });
  const { hasParent, parentThreadId } = filters;

  const activeProjectThreadListQueryKey =
    enabled && projectId
      ? threadListQueryKey({ archived: false, projectId })
      : disabledThreadListQueryKey(
          projectId ? { archived: false, projectId } : { archived: false },
        );

  const activeProjectThreadListIsCached =
    enabled &&
    projectId !== undefined &&
    queryClient.getQueryData<ThreadListResponse>(
      threadListQueryKey({ archived: false, projectId }),
    ) !== undefined;

  const activeProjectThreadsQuery = useQuery<ThreadListResponse>({
    queryKey: activeProjectThreadListQueryKey,
    queryFn: ({ signal }) =>
      sdk.threads.list({
        archived: false,
        projectId: requireThreadId(projectId ?? "", "useProjectThreadSubset"),
        signal,
      }),
    enabled: enabled && activeProjectThreadListIsCached,
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });

  const hasActiveProjectThreadList =
    activeProjectThreadsQuery.data !== undefined;

  const targetedThreadsQuery = useThreads(
    buildThreadSubsetListFilters({ filters, projectId }),
    {
      enabled: enabled && !hasActiveProjectThreadList,
    },
  );

  const derivedThreads = useMemo(
    () =>
      activeProjectThreadsQuery.data
        ? filterProjectThreadSubset(activeProjectThreadsQuery.data, {
            hasParent,
            parentThreadId,
          })
        : undefined,
    [activeProjectThreadsQuery.data, hasParent, parentThreadId],
  );

  const refetchActiveProjectThreads = activeProjectThreadsQuery.refetch;
  const refetchTargetedThreads = targetedThreadsQuery.refetch;

  const retry = useCallback(() => {
    void (hasActiveProjectThreadList
      ? refetchActiveProjectThreads()
      : refetchTargetedThreads());
  }, [
    hasActiveProjectThreadList,
    refetchActiveProjectThreads,
    refetchTargetedThreads,
  ]);

  return {
    data: derivedThreads ?? targetedThreadsQuery.data,
    isError: hasActiveProjectThreadList
      ? activeProjectThreadsQuery.isError
      : targetedThreadsQuery.isError,
    isFetching: hasActiveProjectThreadList
      ? activeProjectThreadsQuery.isFetching
      : targetedThreadsQuery.isFetching,
    isLoading: hasActiveProjectThreadList
      ? activeProjectThreadsQuery.isLoading
      : targetedThreadsQuery.isLoading,
    retry,
  };
}

export function useThreadMentionCandidates({
  enabled: enabledOption,
}: UseThreadMentionCandidatesArgs): UseThreadMentionCandidatesResult {
  const queryClient = useQueryClient();
  const enabled = enabledOption ?? true;
  useThreadListRealtimeSubscription({ enabled });

  const { data: sidebarCandidates, isBootstrapPending } =
    useSidebarNavigationThreadSelection(selectThreadMentionCandidates);

  const shouldFetch =
    enabled && sidebarCandidates === undefined && !isBootstrapPending;

  const queryKey = shouldFetch
    ? threadListQueryKey(THREAD_MENTION_CANDIDATE_FILTERS)
    : disabledThreadListQueryKey(THREAD_MENTION_CANDIDATE_FILTERS);

  const threadsQuery = useQuery<ThreadListResponse>({
    queryKey,
    queryFn: ({ signal }) =>
      sdk.threads.list({ ...THREAD_MENTION_CANDIDATE_FILTERS, signal }),
    enabled: shouldFetch,
    placeholderData: (previousData) =>
      previousData ??
      getThreadMentionCandidatePlaceholder({
        limit: THREAD_MENTION_CANDIDATE_LIMIT,
        queryClient,
      }),
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });

  const derivedCandidates = enabled ? sidebarCandidates : undefined;

  if (derivedCandidates !== undefined) {
    return {
      data: derivedCandidates,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
  }

  const waitingForBootstrap = enabled && isBootstrapPending;

  return {
    data: threadsQuery.data,
    isError: threadsQuery.isError,
    isFetching: threadsQuery.isFetching || waitingForBootstrap,
    isLoading: threadsQuery.isLoading || waitingForBootstrap,
  };
}

export function useThreadSearch({
  active,
  limitPerGroup = THREAD_SEARCH_LIMIT_PER_GROUP,
  query,
}: UseThreadSearchArgs): UseThreadSearchResult {
  const debouncedRawQuery = useDebouncedValue(query, THREAD_SEARCH_DEBOUNCE_MS);
  const trimmedQuery = query.trim();
  const debouncedQuery = debouncedRawQuery.trim();
  const liveQueryIsSearchable = hasThreadSearchableQuery(trimmedQuery);
  const hasSearchableQuery = hasThreadSearchableQuery(debouncedQuery);

  const isDebouncing =
    active && liveQueryIsSearchable && trimmedQuery !== debouncedQuery;

  const enabled = active && liveQueryIsSearchable && hasSearchableQuery;

  const threadSearchQuery = useQuery<ThreadSearchResponse>({
    queryKey: threadSearchQueryKey({
      limitPerGroup,
      query: debouncedQuery,
    }),
    queryFn: ({ signal }) =>
      sdk.threads.search({
        limitPerGroup: String(limitPerGroup),
        query: debouncedQuery,
        signal,
      }),
    enabled,
    staleTime: THREAD_SEARCH_STALE_TIME_MS,
  });

  return {
    data: threadSearchQuery.data,
    debouncedQuery,
    hasSearchableQuery,
    isDebouncing,
    isError: threadSearchQuery.isError,
    isFetching: threadSearchQuery.isFetching,
    isLoading: threadSearchQuery.isLoading,
  };
}

export function useThread(id: string, options?: QueryOptions) {
  const queryClient = useQueryClient();
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadResponse>({
    queryKey: threadQueryKey(id),
    queryFn: ({ signal }) =>
      readThreadState(queryClient, id, () =>
        sdk.threads.get({
          threadId: requireThreadId(id, "useThread"),
          signal,
        }),
      ),
    enabled,
    staleTime: THREAD_DETAIL_STALE_TIME_MS,
    refetchOnMount: options?.refetchOnMount ?? true,
    retry: shouldRetryTransientReadQuery,
    retryDelay: TRANSIENT_READ_RETRY_DELAY_MS,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadPlaceholder(previousData, previousQuery?.queryKey, id) ??
      liftThreadListPlaceholder(
        getCachedThreadListPlaceholder(queryClient, id) ??
          findSidebarNavigationThreadPlaceholder(queryClient, id),
      ),
  });
}

function liftThreadListPlaceholder(
  thread: ThreadListEntry | undefined,
): ThreadResponse | undefined {
  if (thread === undefined) {
    return undefined;
  }

  return {
    ...thread,
    activeBackgroundAgentCount: thread.activity.activeBackgroundAgentCount,
    canRestoreEnvironment: false,
    canSpawnChild: false,
    queuedMessageCount: 0,
  };
}

export function useThreadDetailBootstrap(
  id: string,
  options?: ThreadDetailBootstrapQueryOptions,
) {
  const queryClient = useQueryClient();
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadWithIncludesResponse>({
    ...threadDetailBootstrapQueryOptions(
      queryClient,
      id,
      options?.timelinePrefetch ?? false,
    ),
    enabled,
  });
}

export function useThreadPluginBootstrap(id: string, options?: QueryOptions) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadWithIncludesResponse>({
    queryKey: threadPluginBootstrapQueryKey(id),
    queryFn: ({ signal }) =>
      sdk.threads.get({
        include: "experimental_pluginData",
        threadId: requireThreadId(id, "useThreadPluginBootstrap"),
        signal,
      }),
    enabled,
    staleTime: Infinity,
    refetchOnMount: "always",
    gcTime: THREAD_OPEN_CACHE_GC_MS,
    retry: shouldRetryTransientReadQuery,
    retryDelay: TRANSIENT_READ_RETRY_DELAY_MS,
  });
}

function threadDetailBootstrapQueryOptions(
  queryClient: QueryClient,
  threadId: string,
  timelinePrefetch: boolean,
) {
  return {
    queryKey: threadDetailBootstrapQueryKey(threadId),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const requiredThreadId = requireThreadId(
        threadId,
        "useThreadDetailBootstrap",
      );

      if (timelinePrefetch) {
        void queryClient.prefetchQuery(
          threadTimelineQueryOptions(queryClient, requiredThreadId),
        );
      }

      const thread = await readThreadState(queryClient, requiredThreadId, () =>
        sdk.threads.get({
          include: "environment,host",
          threadId: requiredThreadId,
          signal,
        }),
      );

      ingestThreadDetailBootstrap({
        queryClient,
        thread,
      });
      prefetchThreadWorkStatus(queryClient, thread);

      return thread;
    },
    staleTime: Infinity,
    gcTime: THREAD_OPEN_CACHE_GC_MS,
    retry: shouldRetryTransientReadQuery,
    retryDelay: TRANSIENT_READ_RETRY_DELAY_MS,
  };
}

function prefetchThreadWorkStatus(
  queryClient: QueryClient,
  thread: ThreadWithIncludesResponse | undefined,
): void {
  if (thread?.archivedAt === null)
    void prefetchEnvironmentWorkStatus(queryClient, thread.environment);
}

async function readServerRuntimeId(): Promise<string> {
  return (await sdk.server.runtimeIdentity()).runtimeId;
}

export function useThreadOpenRuntimeIdentity(threadId: string, enabled = true) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: threadOpenRuntimeIdentityQueryKey(),
    queryFn: readServerRuntimeId,
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: shouldRetryTransientReadQuery,
    retryDelay: TRANSIENT_READ_RETRY_DELAY_MS,
    notifyOnChangeProps: () => {
      const identity = queryClient.getQueryState<string>(
        threadOpenRuntimeIdentityQueryKey(),
      );

      const runtimeId = identity?.data;
      const knownRuntimeId = getThreadOpenRuntimeId(queryClient);

      if (
        identity?.status === "success" &&
        identity.fetchStatus === "idle" &&
        runtimeId !== undefined &&
        (knownRuntimeId === undefined || knownRuntimeId === runtimeId) &&
        queryClient.getQueryData(threadTimelineQueryKey(threadId)) !==
          undefined &&
        isThreadTimelineForRuntimeCurrent(queryClient, threadId, runtimeId)
      ) {
        rememberThreadOpenRuntimeId(queryClient, runtimeId);

        return [];
      }

      return ["data", "error", "isFetchedAfterMount"];
    },
  });
}

export function useThreadQueuedMessages(
  id: string,
  options?: ThreadQueuedMessagesQueryOptions,
) {
  const queryClient = useQueryClient();
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadQueuedMessageListResponse>({
    queryKey: threadQueuedMessagesQueryKey(id),
    queryFn: async ({ signal }) =>
      mergePendingComposerQueuedMessages(
        queryClient,
        id,
        await sdk.threads.queuedMessages.list({
          threadId: requireThreadId(id, "useThreadQueuedMessages"),
          signal,
        }),
      ),
    enabled,
    refetchOnMount: options?.refetchOnMount ?? true,
    refetchOnWindowFocus: true,
    staleTime: options?.staleTime,
  });
}

export function useThreadPromptHistory(
  id: string,
  options?: ThreadPromptHistoryQueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<PromptHistoryResponse>({
    queryKey: threadPromptHistoryQueryKey(id),
    queryFn: ({ signal }) =>
      sdk.threads.promptHistory({
        threadId: requireThreadId(id, "useThreadPromptHistory"),
        signal,
      }),
    enabled,
    refetchOnMount: options?.refetchOnMount ?? true,
    staleTime: options?.staleTime ?? PROMPT_HISTORY_STALE_TIME_MS,
  });
}

export function useThreadPendingInteractions(
  id: string,
  options?: ThreadPendingInteractionsQueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadPendingInteractionsResponse>({
    queryKey: threadPendingInteractionsQueryKey(id),
    queryFn: ({ signal }) =>
      sdk.threads.interactions.list({
        threadId: requireThreadId(id, "useThreadPendingInteractions"),
        signal,
      }),
    enabled,
    refetchOnMount:
      options?.refetchOnMount ??
      ((query) => (query.getObserversCount() === 1 ? "always" : true)),
    ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
    ...(options?.staleTime === undefined
      ? {}
      : { staleTime: options.staleTime }),
  });
}

export function useThreadStorageFiles(
  id: string,
  listOptions: ThreadStorageFileListOptions,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadStorageFileListResponse>({
    queryKey: threadStorageFilesQueryKey(id, listOptions),
    queryFn: ({ signal }) => {
      const query = listOptions.query?.trim() ?? "";

      return sdk.threads.storageFiles({
        limit: String(listOptions.limit),
        ...(query.length > 0 ? { query } : {}),
        threadId: requireThreadId(id, "useThreadStorageFiles"),
        signal,
      });
    },
    enabled,
    ...REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
  });
}

export function useThreadStorageLocation(id: string, options?: QueryOptions) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadStorageLocationResponse>({
    queryKey: threadStorageLocationQueryKey(id),
    queryFn: ({ signal }) =>
      sdk.threads.storageLocation({
        threadId: requireThreadId(id, "useThreadStorageLocation"),
        signal,
      }),
    enabled,
    ...REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
  });
}

export function useThreadStoragePaths(
  id: string,
  listOptions: PathListOptions,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadStoragePathListResponse>({
    queryKey: threadStoragePathsQueryKey(id, listOptions),
    queryFn: ({ signal }) => {
      const query = listOptions.query?.trim() ?? "";

      return sdk.threads.storagePaths({
        includeDirectories: listOptions.includeDirectories ? "true" : "false",
        includeFiles: listOptions.includeFiles ? "true" : "false",
        limit: String(listOptions.limit),
        ...(query.length > 0 ? { query } : {}),
        threadId: requireThreadId(id, "useThreadStoragePaths"),
        signal,
      });
    },
    enabled,
    ...REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
    placeholderData: (previousData) => previousData,
  });
}

export function useThreadStorageFilePreview(
  id: string,
  path: string | null,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id) && Boolean(path);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<FilePreview>({
    queryKey: threadStorageFilePreviewQueryKey(id, path),
    queryFn: ({ signal }) =>
      api.getThreadStorageFilePreview(
        requireThreadId(id, "useThreadStorageFilePreview"),
        path ?? "",
        signal,
      ),
    enabled,
    ...REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
    ...HEAVY_PAYLOAD_QUERY_POLICY,
  });
}

export function useThreadHostFilePreview(
  id: string,
  environmentId: string | null | undefined,
  path: string | null,
  options?: QueryOptions,
) {
  const enabled =
    (options?.enabled ?? true) &&
    Boolean(id) &&
    Boolean(environmentId) &&
    Boolean(path);

  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<FilePreview>({
    queryKey: threadHostFilePreviewQueryKey(id, environmentId, path),
    queryFn: ({ signal }) =>
      api.getThreadHostFilePreview(
        requireThreadId(id, "useThreadHostFilePreview"),
        path ?? "",
        signal,
      ),
    enabled,
    ...RESUME_REFETCH_QUERY_POLICY,
    ...HEAVY_PAYLOAD_QUERY_POLICY,
  });
}

async function mergeThreadTimelineDelta(
  previous: ThreadTimelineResponse | undefined,
  response: ThreadTimelineResponse,
  fetchFull: () => Promise<ThreadTimelineResponse>,
): Promise<ThreadTimelineResponse> {
  if (response.delta === undefined) {
    return response;
  }

  const merged =
    previous &&
    areTimelineHistorySnapshotsCompatible(
      previous.timelinePage.historySnapshot,
      response.timelinePage.historySnapshot,
    )
      ? applyTimelineDelta(previous.rows, response.delta, previous.revision)
      : null;

  if (merged !== null) {
    return { ...response, rows: merged, delta: undefined };
  }

  return fetchFull();
}

interface FetchThreadTimelineArgs {
  queryClient: QueryClient;
  signal: AbortSignal;
  threadId: string;
  priority?: "background";
}

interface TimelineReadFlight {
  background: boolean;
  controller: AbortController | null;
}

const timelineFlightsByClient = new WeakMap<
  QueryClient,
  Map<string, TimelineReadFlight>
>();

function promoteTimelineRead(queryClient: QueryClient, threadId: string): void {
  const flight = timelineFlightsByClient.get(queryClient)?.get(threadId);

  if (!flight?.background) return;
  flight.background = false;
  flight.controller?.abort();
}

export const COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT = 8;

function resolveThreadTimelineSegmentLimit(): number | undefined {
  return getMediaQuerySnapshot(COMPACT_VIEWPORT_QUERY)
    ? COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT
    : undefined;
}

export function fetchThreadOpenRuntimeId(
  queryClient: QueryClient,
): Promise<string> {
  return queryClient.fetchQuery({
    queryKey: threadOpenRuntimeIdentityQueryKey(),
    queryFn: readServerRuntimeId,
    staleTime: THREAD_OPEN_RUNTIME_IDENTITY_FRESH_MS,
    retry: shouldRetryTransientReadQuery,
    retryDelay: TRANSIENT_READ_RETRY_DELAY_MS,
  });
}

async function fetchThreadTimeline({
  queryClient,
  signal,
  threadId,
  priority,
}: FetchThreadTimelineArgs): Promise<ThreadTimelineResponse> {
  let flights = timelineFlightsByClient.get(queryClient);

  if (!flights) {
    flights = new Map();
    timelineFlightsByClient.set(queryClient, flights);
  }

  const flight: TimelineReadFlight = {
    background: priority === "background",
    controller: null,
  };

  flights.set(threadId, flight);

  const read = async (
    args: Parameters<typeof sdk.threads.timeline>[0],
  ): Promise<ThreadTimelineResponse> => {
    for (;;) {
      const controller = new AbortController();
      flight.controller = controller;
      const background = flight.background;
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });

      if (signal.aborted) controller.abort();

      try {
        const requestArgs = {
          ...args,
          signal: controller.signal,
        };

        if (background) requestArgs.priority = "background";
        const response = await sdk.threads.timeline(requestArgs);

        if (
          background &&
          !flight.background &&
          controller.signal.aborted &&
          !signal.aborted
        )
          continue;

        return response;
      } catch (error) {
        if (
          background &&
          !flight.background &&
          controller.signal.aborted &&
          !signal.aborted
        )
          continue;
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
  };

  try {
    const queryKey = threadTimelineQueryKey(threadId);

    const historyGeneration = getThreadTimelineHistoryGeneration(
      queryClient,
      threadId,
    );

    const cached = queryClient.getQueryData<ThreadTimelineResponse>(queryKey);

    const settlePendingSentMessages = beginPendingSentMessageRead({
      displayedMaxSeq: cached?.maxSeq,
      queryClient,
      threadId,
    });

    const previous =
      cached?.runtimeId !== undefined &&
      getThreadTimelineRuntimeId(queryClient, threadId) === cached.runtimeId
        ? cached
        : undefined;

    const segmentLimit = resolveThreadTimelineSegmentLimit();

    const pageArgs: Parameters<typeof sdk.threads.timeline>[0] = {
      deferContent: THREAD_TIMELINE_DEFER_CONTENT,
      deltaFormat: "assistant-text-append-v1",
      runtimeIdentity: "server-v1",
      signal,
      threadId,
    };

    if (segmentLimit !== undefined)
      pageArgs.segmentLimit = String(segmentLimit);
    const timelineArgs = { ...pageArgs };

    if (previous?.maxSeq !== undefined) {
      timelineArgs.afterSequence = String(previous.maxSeq);
      timelineArgs.afterRuntimeId = previous.runtimeId;

      if (previous.revision !== undefined)
        timelineArgs.afterRevision = previous.revision;
    }

    const [runtimeId, speculative] = await Promise.all([
      fetchThreadOpenRuntimeId(queryClient),
      read(timelineArgs),
    ]);

    const assertCurrent = (response?: ThreadTimelineResponse) => {
      if (
        signal.aborted ||
        getThreadTimelineHistoryGeneration(queryClient, threadId) !==
          historyGeneration ||
        queryClient.getQueryData<string>(
          threadOpenRuntimeIdentityQueryKey(),
        ) !== runtimeId ||
        (response?.runtimeId !== undefined && response.runtimeId !== runtimeId)
      )
        throw new Error("Thread timeline changed while loading");
    };

    assertCurrent(speculative);

    const fetchFull = async () => {
      assertCurrent();
      const response = await read(pageArgs);
      assertCurrent(response);

      if (response.delta !== undefined)
        throw new Error("Expected a full thread timeline");

      return response;
    };

    const response =
      speculative.runtimeId === undefined ? await fetchFull() : speculative;

    assertCurrent(response);

    const timeline = await mergeThreadTimelineDelta(
      previous?.runtimeId === runtimeId ? previous : undefined,
      response,
      fetchFull,
    );

    assertCurrent(timeline);
    admitThreadTimelineHistory(queryClient, threadId, timeline);
    rememberThreadTimelineRuntimeId(queryClient, threadId, runtimeId);

    if (
      flight.background &&
      timeline.delta === undefined &&
      typeof window !== "undefined" &&
      !queryClient
        .getQueryCache()
        .get(queryClient.defaultQueryOptions({ queryKey }).queryHash)
        ?.isActive()
    )
      schedulePersistedThreadTimelineDisplay({
        queryClient,
        origin: window.location.origin,
        runtimeId,
        threadId,
        response: timeline,
        surfaceKey: resolveLoadedTimelineSurfaceKey(threadId, timeline),
      });

    settlePendingSentMessages(timeline);

    return timeline;
  } finally {
    if (flights.get(threadId) === flight) flights.delete(threadId);
  }
}

export function prefetchThreadOpen(
  queryClient: QueryClient,
  threadId: string,
  refreshDetail = false,
  priority?: "background",
  refreshTimeline = false,
): Promise<void> {
  if (!threadId || isPendingChatId(threadId)) return Promise.resolve();

  if (priority === undefined) {
    activateThreadOpenCache(queryClient, threadId);
    promoteTimelineRead(queryClient, threadId);
  }

  touchThreadOpenCache(queryClient, threadId);
  void LazyThreadDetailView.preload();
  void prefetchThreadDefaultExecutionOptions(queryClient, threadId);

  const detailOptions = threadDetailBootstrapQueryOptions(
    queryClient,
    threadId,
    false,
  );

  if (refreshDetail) detailOptions.staleTime = 0;

  const detailRequest = queryClient
    .prefetchQuery(detailOptions)
    .then(() =>
      prefetchThreadWorkStatus(
        queryClient,
        queryClient.getQueryData<ThreadWithIncludesResponse>(
          threadDetailBootstrapQueryKey(threadId),
        ),
      ),
    );

  const timelineRequest = queryClient.prefetchQuery(
    threadTimelineQueryOptions(
      queryClient,
      threadId,
      priority,
      refreshTimeline,
    ),
  );

  return Promise.all([detailRequest, timelineRequest]).then(() => {});
}

function threadTimelineQueryOptions(
  queryClient: QueryClient,
  threadId: string,
  priority?: "background",
  refresh = false,
) {
  return {
    queryKey: threadTimelineQueryKey(threadId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchThreadTimeline({
        queryClient,
        signal,
        threadId: requireThreadId(threadId, "useThreadTimeline"),
        priority,
      }),
    staleTime:
      refresh ||
      hasThreadTimelineUnseenEvents(queryClient, threadId) ||
      !isThreadTimelineForRuntimeCurrent(
        queryClient,
        threadId,
        getThreadOpenRuntimeId(queryClient),
      )
        ? 0
        : Infinity,
    gcTime: THREAD_OPEN_CACHE_GC_MS,
    retry: shouldRetryTransientReadQuery,
    retryDelay: TRANSIENT_READ_RETRY_DELAY_MS,
  };
}

export function useThreadTimeline(
  id: string,
  options?: ThreadTimelineQueryOptions,
) {
  const queryClient = useQueryClient();
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });
  useEffect(() => {
    if (enabled) {
      activateThreadOpenCache(queryClient, id);
      promoteTimelineRead(queryClient, id);
      touchThreadOpenCache(queryClient, id);
    }
  }, [enabled, id, queryClient]);

  return useQuery<ThreadTimelineResponse>({
    ...threadTimelineQueryOptions(queryClient, id),
    enabled,
    ...(options?.notifyOnChangeProps === undefined
      ? {}
      : { notifyOnChangeProps: options.notifyOnChangeProps }),
    refetchOnMount: options?.refetchOnMount ?? true,
    ...(options?.staleTime === undefined
      ? {}
      : { staleTime: options.staleTime }),
    placeholderData: (previousData, previousQuery) =>
      resolveThreadTimelinePlaceholder(
        previousData,
        previousQuery?.queryKey,
        id,
      ),
  });
}

export function useThreadConversationOutline(
  id: string,
  role: ThreadConversationOutlineRole,
  options?: ThreadConversationOutlineQueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  return useQuery<ThreadConversationOutlineResponse>({
    queryKey: threadConversationOutlineQueryKey(id, role),
    queryFn: async ({ signal }) => {
      const threadId = requireThreadId(id, "useThreadConversationOutline");

      return sdk.threads.conversationOutline({ threadId, role, signal });
    },
    enabled,
    refetchOnMount: options?.refetchOnMount ?? true,
    ...(options?.staleTime === undefined
      ? {}
      : { staleTime: options.staleTime }),
  });
}

function mergeTimelineTurnSummaryDetailsPages(
  data: InfiniteData<TimelineTurnSummaryDetailsResponse, string | undefined>,
): TimelineRow[] {
  const [latest, ...olderPages] = data.pages;
  let rows = latest?.rows ?? [];

  for (const older of olderPages) {
    rows = prependOlderTimelineRows({
      olderRows: older.rows,
      loadedRows: rows,
    });
  }

  return rows;
}

function threadTimelineTurnSummaryDetailsQueryOptions(
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity,
  queryClient: QueryClient,
) {
  const cachedDetails = getCompletedThreadTimelineDetails({
    identity,
    queryClient,
  });

  return infiniteQueryOptions<
    TimelineTurnSummaryDetailsResponse,
    Error,
    TimelineRow[],
    ReturnType<typeof threadTimelineTurnSummaryDetailsQueryKey>,
    string | undefined
  >({
    queryKey: threadTimelineTurnSummaryDetailsQueryKey(identity),
    queryFn: async ({ pageParam, signal }) => {
      const response = await sdk.threads.timelineTurnSummaryDetails({
        threadId: requireThreadId(
          identity.threadId,
          "useThreadTimelineTurnSummaryDetails",
        ),
        sourceSeqEnd: String(identity.sourceSeqEnd),
        sourceSeqStart: String(identity.sourceSeqStart),
        turnId: identity.turnId,
        deferContent: "true",
        ...(identity.itemId === null ? {} : { itemId: identity.itemId }),
        ...(pageParam === undefined ? {} : { beforeCursor: pageParam }),
        signal,
      });

      if (pageParam === undefined) {
        rememberCompletedThreadTimelineDetails({
          identity,
          queryClient,
          response,
        });
      }

      return response;
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.olderCursor ?? undefined,
    select: mergeTimelineTurnSummaryDetailsPages,
    initialData:
      cachedDetails === null
        ? undefined
        : { pages: [cachedDetails.response], pageParams: [undefined] },
    initialDataUpdatedAt: cachedDetails?.dataUpdatedAt,
    meta: {
      errorMessage: "Failed to load turn summary details.",
      showErrorToast: false,
    },
    staleTime: Infinity,
    ...HEAVY_PAYLOAD_QUERY_POLICY,
  });
}

export function prefetchThreadTimelineTurnSummaryDetails(
  queryClient: QueryClient,
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity,
): void {
  if (!identity.threadId || !identity.turnId) {
    return;
  }

  void queryClient.prefetchInfiniteQuery(
    threadTimelineTurnSummaryDetailsQueryOptions(identity, queryClient),
  );
}

export function useThreadTimelineTurnSummaryDetails(
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity,
  options?: ThreadTimelineTurnSummaryDetailsQueryOptions,
) {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    ...threadTimelineTurnSummaryDetailsQueryOptions(identity, queryClient),
    enabled:
      (options?.enabled ?? true) &&
      Boolean(identity.threadId) &&
      Boolean(identity.turnId),
    refetchOnMount: options?.refetchOnMount ?? true,
    staleTime: options?.staleTime ?? Infinity,
  });
}

const EMPTY_PENDING_INTERACTIONS: readonly PendingInteraction[] = [];

export function orderPendingInteractions(
  interactions: readonly PendingInteraction[] | undefined,
): readonly PendingInteraction[] {
  if (!interactions || interactions.length === 0) {
    return EMPTY_PENDING_INTERACTIONS;
  }

  return [...interactions].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}
