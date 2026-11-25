import { matchQuery, type QueryClient } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@omnyo/domain";
import {
  sidebarNavigationQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";
import { applyToCachedSidebarNavigationThreads } from "./query-cache";
import {
  insertArchivedEntriesIntoCachedLists,
  optimisticallyArchiveThreads,
  removeLiveThreadsFromCachedLists,
  removeThreadsFromCachedArchivedLists,
} from "./thread-archive-cache";

type PendingMembership =
  | { kind: "archived"; threadId: string; entry: ThreadListEntry | undefined }
  | { kind: "unarchived"; threadId: string; entry: ThreadListEntry };

interface PendingMembershipOwner {
  token: symbol;
  membership: PendingMembership;
}

interface PendingMembershipRegistry {
  pending: Map<string, PendingMembershipOwner>;
  unsubscribe: () => void;
}

const registries = new WeakMap<QueryClient, PendingMembershipRegistry>();

function restoreUnarchivedEntries(
  queryClient: QueryClient,
  entries: ReadonlyMap<string, ThreadListEntry>,
): void {
  for (const threadId of entries.keys()) {
    queryClient.setQueryData<ThreadWithRuntime>(
      threadQueryKey(threadId),
      (thread) =>
        thread && thread.archivedAt !== null
          ? { ...thread, archivedAt: null }
          : thread,
    );
  }

  removeThreadsFromCachedArchivedLists({
    queryClient,
    threadIds: new Set(entries.keys()),
  });
  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper: (list, projectId) => {
      const restored = [...entries.values()].filter(
        (entry) => entry.projectId === projectId,
      );

      if (restored.length === 0) return list;
      const present = new Set(list.map(({ id }) => id));
      const missing = restored.filter(({ id }) => !present.has(id));

      const next = list.map((entry) =>
        entries.has(entry.id) && entry.archivedAt !== null
          ? { ...entry, archivedAt: null }
          : entry,
      );

      return missing.length === 0 ? next : [...next, ...missing];
    },
  });
}

function applyPendingMembership(
  queryClient: QueryClient,
  pending: ReadonlyMap<string, PendingMembershipOwner>,
): void {
  const archivedIds = new Set<string>();
  const archivedEntries: ThreadListEntry[] = [];
  const restored = new Map<string, ThreadListEntry>();

  for (const { membership } of pending.values()) {
    if (membership.kind === "unarchived")
      restored.set(membership.threadId, membership.entry);
    else {
      archivedIds.add(membership.threadId);

      if (membership.entry !== undefined)
        archivedEntries.push(membership.entry);
    }
  }

  if (archivedIds.size > 0) {
    optimisticallyArchiveThreads({ queryClient, threadIds: [...archivedIds] });
    removeLiveThreadsFromCachedLists({
      queryClient,
      matchesThread: (thread) => archivedIds.has(thread.id),
    });
    insertArchivedEntriesIntoCachedLists({
      queryClient,
      entries: archivedEntries,
    });
  }

  if (restored.size > 0) restoreUnarchivedEntries(queryClient, restored);
}

function holdPendingThreadMembership(
  queryClient: QueryClient,
  memberships: readonly PendingMembership[],
): () => void {
  if (memberships.length === 0) return () => {};

  let registry = registries.get(queryClient);

  if (registry === undefined) {
    const pending = new Map<string, PendingMembershipOwner>();

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "success" ||
        event.action.manual
      )
        return;

      if (
        matchQuery({ queryKey: threadsQueryKey() }, event.query) ||
        matchQuery(
          { queryKey: sidebarNavigationQueryKey(), exact: true },
          event.query,
        ) ||
        [...pending.keys()].some((id) =>
          matchQuery(
            { queryKey: threadQueryKey(id), exact: true },
            event.query,
          ),
        )
      )
        applyPendingMembership(queryClient, pending);
    });

    registry = { pending, unsubscribe };
    registries.set(queryClient, registry);
  }

  const activeRegistry = registry;
  const token = Symbol();

  for (const membership of memberships)
    activeRegistry.pending.set(membership.threadId, { token, membership });

  return () => {
    for (const { threadId } of memberships) {
      if (activeRegistry.pending.get(threadId)?.token === token)
        activeRegistry.pending.delete(threadId);
    }

    if (activeRegistry.pending.size === 0) {
      activeRegistry.unsubscribe();

      if (registries.get(queryClient) === activeRegistry)
        registries.delete(queryClient);
    }
  };
}

export function holdPendingThreadArchives(
  queryClient: QueryClient,
  threadIds: readonly string[],
  archivedEntries: readonly ThreadListEntry[] = [],
): () => void {
  const entries = new Map(archivedEntries.map((entry) => [entry.id, entry]));

  return holdPendingThreadMembership(
    queryClient,
    threadIds.map((threadId) => ({
      kind: "archived",
      threadId,
      entry: entries.get(threadId),
    })),
  );
}

export function holdPendingThreadUnarchives(
  queryClient: QueryClient,
  entries: readonly ThreadListEntry[],
): () => void {
  return holdPendingThreadMembership(
    queryClient,
    entries.map((entry) => ({ kind: "unarchived", threadId: entry.id, entry })),
  );
}
