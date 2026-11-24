import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ThreadListEntry } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { threadEntryMapFor } from "./thread-cache-resolution";
import {
  useArchivedThreads,
  useShelvedThreads,
} from "@/hooks/queries/thread-queries";

interface SidebarThreadEntryStore {
  getEntries: () => ReadonlyMap<string, ThreadListEntry>;
  publish: (entries: ReadonlyMap<string, ThreadListEntry>) => void;
  subscribe: (listener: () => void) => () => void;
}

function createSidebarThreadEntryStore(
  initial: ReadonlyMap<string, ThreadListEntry>,
): SidebarThreadEntryStore {
  let entries = initial;
  const listeners = new Set<() => void>();

  return {
    getEntries: () => entries,
    publish(next) {
      if (next === entries) return;
      entries = next;

      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const SidebarThreadEntriesContext =
  createContext<SidebarThreadEntryStore | null>(null);

type PagedThreads = ReturnType<typeof useArchivedThreads>["data"];

const mergedEntryMaps = new WeakMap<
  ReadonlyMap<string, ThreadListEntry>,
  {
    archived: PagedThreads;
    shelved: PagedThreads;
    merged: ReadonlyMap<string, ThreadListEntry>;
  }
>();

function pagedEntries(
  paged: PagedThreads,
): (readonly [string, ThreadListEntry])[] {
  return (paged?.pages.flat() ?? []).map(
    (thread) => [thread.id, thread] as const,
  );
}

function mergeThreadEntries(
  active: ReadonlyMap<string, ThreadListEntry>,
  archived: PagedThreads,
  shelved: PagedThreads,
): ReadonlyMap<string, ThreadListEntry> {
  if (archived === undefined && shelved === undefined) return active;
  const cached = mergedEntryMaps.get(active);

  if (
    cached !== undefined &&
    cached.archived === archived &&
    cached.shelved === shelved
  ) {
    return cached.merged;
  }

  const merged = new Map([
    ...pagedEntries(archived),
    ...pagedEntries(shelved),
    ...active,
  ]);

  mergedEntryMaps.set(active, { archived, shelved, merged });

  return merged;
}

export function SidebarThreadEntriesProvider({
  navigation,
  children,
}: {
  navigation: SidebarBootstrapResponse | undefined;
  children: ReactNode;
}) {
  const archived = useArchivedThreads({}, { enabled: false });
  const shelved = useShelvedThreads({ enabled: false });

  const entries = useMemo(
    () =>
      mergeThreadEntries(
        threadEntryMapFor(navigation),
        archived.data,
        shelved.data,
      ),
    [navigation, archived.data, shelved.data],
  );

  const [store] = useState(() => createSidebarThreadEntryStore(entries));

  useLayoutEffect(() => store.publish(entries), [entries, store]);

  return (
    <SidebarThreadEntriesContext value={store}>
      {children}
    </SidebarThreadEntriesContext>
  );
}

function useSidebarThreadEntryStore(): SidebarThreadEntryStore {
  const store = useContext(SidebarThreadEntriesContext);

  if (store === null) {
    throw new Error("SidebarThreadEntriesProvider is required");
  }

  return store;
}

export function useSidebarThreadEntries(): ReadonlyMap<
  string,
  ThreadListEntry
> {
  const store = useSidebarThreadEntryStore();

  return useSyncExternalStore(store.subscribe, store.getEntries);
}

export function useSidebarThreadEntryById(
  threadId: string,
): ThreadListEntry | null {
  const store = useSidebarThreadEntryStore();

  const getEntry = useCallback(
    () => store.getEntries().get(threadId) ?? null,
    [store, threadId],
  );

  return useSyncExternalStore(store.subscribe, getEntry);
}
