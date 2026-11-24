import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { SidebarThread } from "./sidebar-thread.js";

type Listener = () => void;

const NO_LINKS: ReadonlySet<string> = new Set();

export interface HandoffLineageStore {
  setThreads(
    threads: readonly SidebarThread[],
    activeThreadId: string | null,
  ): void;
  hover(threadId: string): void;
  unhover(threadId: string): void;
  isLinked(threadId: string): boolean;
  isHighlighted(threadId: string): boolean;
  subscribe(listener: Listener): () => void;
}

function handoffLinks(
  threads: readonly SidebarThread[],
): Map<string, ReadonlySet<string>> {
  const links = new Map<string, Set<string>>();

  const link = (from: string, to: string) => {
    const linked = links.get(from);

    if (linked === undefined) {
      links.set(from, new Set([to]));
    } else {
      linked.add(to);
    }
  };

  for (const thread of threads) {
    if (thread.originKind === "handoff" && thread.sourceThreadId !== null) {
      link(thread.sourceThreadId, thread.id);
      link(thread.id, thread.sourceThreadId);
    }
  }

  return links;
}

function sameLinks(
  left: ReadonlyMap<string, ReadonlySet<string>>,
  right: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (left.size !== right.size) return false;

  for (const [threadId, linked] of left) {
    const other = right.get(threadId);

    if (other === undefined || other.size !== linked.size) return false;

    for (const linkedId of linked) {
      if (!other.has(linkedId)) return false;
    }
  }

  return true;
}

export function createHandoffLineageStore(): HandoffLineageStore {
  let links: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  let hoveredId: string | null = null;
  let activeId: string | null = null;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    setThreads(threads, activeThreadId) {
      const nextLinks = handoffLinks(threads);

      if (sameLinks(links, nextLinks) && activeId === activeThreadId) return;
      activeId = activeThreadId;
      links = nextLinks;

      if (hoveredId !== null && !links.has(hoveredId)) hoveredId = null;
      notify();
    },
    hover(threadId) {
      if (hoveredId === threadId || !links.has(threadId)) return;
      hoveredId = threadId;
      notify();
    },
    unhover(threadId) {
      if (hoveredId !== threadId) return;
      hoveredId = null;
      notify();
    },
    isLinked(threadId) {
      return links.has(threadId);
    },
    isHighlighted(threadId) {
      if (activeId === threadId) return false;

      return (
        (activeId !== null &&
          (links.get(activeId) ?? NO_LINKS).has(threadId)) ||
        (hoveredId !== null &&
          hoveredId !== threadId &&
          (links.get(hoveredId) ?? NO_LINKS).has(threadId))
      );
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const HandoffLineageContext = createContext<HandoffLineageStore>(
  createHandoffLineageStore(),
);

export interface ThreadHandoffLineage {
  isLinked: boolean;
  isHighlighted: boolean;
  hover(): void;
  unhover(): void;
}

export function useThreadHandoffLineage(
  threadId: string,
): ThreadHandoffLineage {
  const store = useContext(HandoffLineageContext);

  const isLinked = useSyncExternalStore(store.subscribe, () =>
    store.isLinked(threadId),
  );

  const isHighlighted = useSyncExternalStore(store.subscribe, () =>
    store.isHighlighted(threadId),
  );

  const hover = useCallback(() => store.hover(threadId), [store, threadId]);

  const unhover = useCallback(() => store.unhover(threadId), [store, threadId]);

  return { isLinked, isHighlighted, hover, unhover };
}
