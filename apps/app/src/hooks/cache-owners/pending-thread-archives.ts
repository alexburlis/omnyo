import { matchQuery, type QueryClient } from "@tanstack/react-query";
import type { ThreadListEntry } from "@omnyo/domain";
import {
  sidebarNavigationQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";
import {
  insertArchivedEntriesIntoCachedLists,
  optimisticallyArchiveThreads,
  removeLiveThreadsFromCachedLists,
} from "./thread-archive-cache";

interface PendingArchiveHold {
  archivedEntries: readonly ThreadListEntry[];
  threadIds: ReadonlySet<string>;
}

interface PendingArchiveRegistry {
  holds: Set<PendingArchiveHold>;
  unsubscribe: () => void;
}

const registries = new WeakMap<QueryClient, PendingArchiveRegistry>();

export function holdPendingThreadArchives(
  queryClient: QueryClient,
  threadIds: readonly string[],
  archivedEntries: readonly ThreadListEntry[] = [],
): () => void {
  let registry = registries.get(queryClient);

  if (!registry) {
    const holds = new Set<PendingArchiveHold>();

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "success" ||
        event.action.manual
      )
        return;

      const archivedIds = new Set(
        [...holds].flatMap(({ threadIds }) => [...threadIds]),
      );

      if (
        !matchQuery({ queryKey: threadsQueryKey() }, event.query) &&
        !matchQuery(
          { queryKey: sidebarNavigationQueryKey(), exact: true },
          event.query,
        ) &&
        ![...archivedIds].some((id) =>
          matchQuery(
            { queryKey: threadQueryKey(id), exact: true },
            event.query,
          ),
        )
      )
        return;

      optimisticallyArchiveThreads({
        queryClient,
        threadIds: [...archivedIds],
      });
      removeLiveThreadsFromCachedLists({
        queryClient,
        matchesThread: (thread) => archivedIds.has(thread.id),
      });
      insertArchivedEntriesIntoCachedLists({
        queryClient,
        entries: [...holds].flatMap((hold) => hold.archivedEntries),
      });
    });

    registry = { holds, unsubscribe };
    registries.set(queryClient, registry);
  }

  const activeRegistry = registry;

  const hold: PendingArchiveHold = {
    archivedEntries,
    threadIds: new Set(threadIds),
  };

  activeRegistry.holds.add(hold);

  return () => {
    if (!activeRegistry.holds.delete(hold)) return;

    if (activeRegistry.holds.size === 0) {
      activeRegistry.unsubscribe();
      registries.delete(queryClient);
    }
  };
}
