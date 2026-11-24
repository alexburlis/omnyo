import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  Environment,
  ThreadListEntry,
  ThreadWithRuntime,
} from "@omnyo/domain";
import {
  archivedThreadsListQueryKey,
  environmentQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";
import { patchCachedQueryData } from "./cache-effect-utils";
import {
  applyToCachedSidebarNavigationThreads,
  getCachedSidebarNavigationThreads,
} from "./query-cache";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  iterateThreadListCacheEntries,
  type ThreadListCacheData,
} from "./thread-list-cache-data";

type CachedLiveThreadMatcher = (thread: ThreadListEntry) => boolean;

export interface CachedThreadSnapshot {
  id: string;
  thread: ThreadWithRuntime | undefined;
}

interface CachedLiveThreadIdsMatchingArgs {
  matchesThread: CachedLiveThreadMatcher;
  queryClient: QueryClient;
}

interface CachedThreadSnapshotsArgs {
  queryClient: QueryClient;
  threadIds: readonly string[];
}

interface OptimisticallyArchiveThreadsArgs {
  archivedAt?: number;
  queryClient: QueryClient;
  threadIds: readonly string[];
}

interface RemoveLiveThreadsFromCachedListsArgs {
  matchesThread: CachedLiveThreadMatcher;
  queryClient: QueryClient;
}

export function getCachedLiveThreadIdsMatching({
  matchesThread,
  queryClient,
}: CachedLiveThreadIdsMatchingArgs): string[] {
  const threadIds = new Set<string>();

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.archivedAt === null && matchesThread(thread)) {
        threadIds.add(thread.id);
      }
    }
  }

  for (const thread of getCachedSidebarNavigationThreads(queryClient)) {
    if (thread.archivedAt === null && matchesThread(thread)) {
      threadIds.add(thread.id);
    }
  }

  return Array.from(threadIds);
}

export function getCachedThreadSnapshots({
  queryClient,
  threadIds,
}: CachedThreadSnapshotsArgs): CachedThreadSnapshot[] {
  return threadIds.map((threadId) => ({
    id: threadId,
    thread: queryClient.getQueryData<ThreadWithRuntime>(
      threadQueryKey(threadId),
    ),
  }));
}

export function optimisticallyArchiveThreads({
  archivedAt = Date.now(),
  queryClient,
  threadIds,
}: OptimisticallyArchiveThreadsArgs): void {
  for (const threadId of threadIds) {
    queryClient.setQueryData<ThreadWithRuntime>(
      threadQueryKey(threadId),
      (thread) => {
        if (!thread) {
          return thread;
        }

        return { ...thread, archivedAt };
      },
    );
  }
}

export function removeLiveThreadsFromCachedLists({
  matchesThread,
  queryClient,
}: RemoveLiveThreadsFromCachedListsArgs): void {
  const removeMatchingLiveThreads = (list: ThreadListEntry[]) =>
    list.filter(
      (thread) => thread.archivedAt !== null || !matchesThread(thread),
    );

  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper: removeMatchingLiveThreads,
  });
  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper: removeMatchingLiveThreads,
  });
}

interface ArchivedListScope {
  projectId: string | undefined;
  kind: string | undefined;
}

function parseArchivedListScope(queryKey: QueryKey): ArchivedListScope | null {
  const filters = queryKey[2];

  if (typeof filters !== "object" || filters === null) return null;
  const projectId = "projectId" in filters ? filters.projectId : undefined;
  const kind = "kind" in filters ? filters.kind : undefined;

  if (projectId !== undefined && typeof projectId !== "string") return null;

  if (kind !== undefined && typeof kind !== "string") return null;

  return { projectId, kind };
}

function belongsToArchivedList(
  thread: ThreadListEntry,
  { kind, projectId }: ArchivedListScope,
): boolean {
  if (projectId !== undefined && thread.projectId !== projectId) return false;

  if (kind === "root") return thread.parentThreadId === null;

  if (kind === "child") return thread.parentThreadId !== null;

  return true;
}

export function prependToFirstPage(
  data: ThreadListCacheData,
  entries: readonly ThreadListEntry[],
): ThreadListCacheData {
  if (Array.isArray(data)) return [...entries, ...data];
  const [first = [], ...rest] = data.pages;

  return { ...data, pages: [[...entries, ...first], ...rest] };
}

export function insertArchivedEntriesIntoCachedLists({
  entries,
  queryClient,
}: {
  entries: readonly ThreadListEntry[];
  queryClient: QueryClient;
}): void {
  if (entries.length === 0) return;

  const newestFirst = [...entries].sort(
    (left, right) =>
      (right.archivedAt ?? 0) - (left.archivedAt ?? 0) ||
      (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
  );

  for (const { queryKey, data } of getCachedThreadLists(queryClient, {
    queryKey: archivedThreadsListQueryKey({}),
  })) {
    const scope = parseArchivedListScope(queryKey);

    if (scope === null) continue;

    const present = new Set(
      [...iterateThreadListCacheEntries(data)].map(({ id }) => id),
    );

    const missing = newestFirst.filter(
      (entry) => !present.has(entry.id) && belongsToArchivedList(entry, scope),
    );

    if (missing.length === 0) continue;
    patchCachedQueryData(
      queryClient,
      queryKey,
      prependToFirstPage(data, missing),
    );
  }
}

export function removeThreadsFromCachedArchivedLists({
  queryClient,
  threadIds,
}: {
  queryClient: QueryClient;
  threadIds: ReadonlySet<string>;
}): void {
  applyToCachedThreadLists(queryClient, {
    queryKey: archivedThreadsListQueryKey({}),
    mapper: (list) =>
      list.some((thread) => threadIds.has(thread.id))
        ? list.filter((thread) => !threadIds.has(thread.id))
        : list,
  });
}

function workspaceDisplayKind(
  environment: Environment,
): ThreadListEntry["environmentWorkspaceDisplayKind"] {
  if (environment.workspaceProvisionType === "managed-worktree") {
    return "managed-worktree";
  }

  return environment.isWorktree ? "unmanaged-worktree" : "other";
}

export function getCachedThreadDetailListEntry(
  queryClient: QueryClient,
  threadId: string,
): ThreadListEntry | undefined {
  const thread = queryClient.getQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
  );

  if (thread === undefined) return undefined;

  const environment =
    thread.environmentId === null
      ? undefined
      : queryClient.getQueryData<Environment>(
          environmentQueryKey(thread.environmentId),
        );

  return {
    ...thread,
    work: null,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
      activeSubagentCount: 0,
    },
    queuedWork: "none",
    pinSortKey: null,
    shelfSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: environment?.hostId ?? null,
    environmentName: environment?.name ?? null,
    environmentBranchName: environment?.branchName ?? null,
    environmentPath: environment?.path ?? null,
    environmentProviderId: environment?.environmentProviderId ?? null,
    environmentIsWorktree: environment?.isWorktree ?? null,
    environmentWorkspaceDisplayKind:
      environment === undefined ? "other" : workspaceDisplayKind(environment),
  };
}
