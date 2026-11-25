import type { QueryClient } from "@tanstack/react-query";
import type { ThreadListEntry } from "@omnyo/domain";
import {
  applyToCachedThreadListsAndSidebarNavigation,
  getCachedSidebarNavigationThreads,
} from "./query-cache";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import { threadsQueryKey } from "../queries/query-keys";

export function applyOptimisticThreadListState(
  queryClient: QueryClient,
  threadId: string,
  update: (thread: ThreadListEntry) => ThreadListEntry,
): ReadonlyMap<ThreadListEntry, ThreadListEntry> {
  const lists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });

  const previous = lists.map(({ queryKey, data }) => ({
    queryKey,
    thread: [...iterateThreadListCacheEntries(data)].find(
      (thread) => thread.id === threadId,
    ),
  }));

  const previousSidebar = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
    threads.map((thread) => (thread.id === threadId ? update(thread) : thread)),
  );
  const rollback = new Map<ThreadListEntry, ThreadListEntry>();

  for (const snapshot of previous) {
    const current = getCachedThreadLists(queryClient, {
      queryKey: snapshot.queryKey,
    }).find((entry) => entry.queryKey === snapshot.queryKey);

    const thread =
      current === undefined
        ? undefined
        : [...iterateThreadListCacheEntries(current.data)].find(
            (entry) => entry.id === threadId,
          );

    if (thread !== undefined && snapshot.thread !== undefined)
      rollback.set(thread, snapshot.thread);
  }

  const currentSidebar = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );

  if (currentSidebar !== undefined && previousSidebar !== undefined)
    rollback.set(currentSidebar, previousSidebar);

  return rollback;
}

export function restoreOptimisticThreadLists(
  queryClient: QueryClient,
  rollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>,
  project: (thread: ThreadListEntry) => ThreadListEntry = (thread) => thread,
): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
    threads.map((thread) => {
      const previous = rollback.get(thread);

      return previous === undefined ? thread : project(previous);
    }),
  );
}
