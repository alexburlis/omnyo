import { useMemo, useRef, useSyncExternalStore } from "react";
import { type QueryClient } from "@tanstack/react-query";
import type { ThreadWithIncludesResponse } from "@omnyo/server-contract";
import { isPendingChatId } from "@/lib/pending-chat-creations";
import { getMediaQuerySnapshot } from "@omnyo/shared-ui/hooks/use-media-query";
import { POINTER_COARSE_QUERY } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { threadDetailBootstrapQueryKey } from "@/hooks/queries/query-keys";

export const KEPT_THREAD_VIEW_LIMIT = 6;

export const COARSE_POINTER_KEPT_THREAD_VIEW_LIMIT = 2;

export const THREAD_VIEW_INTENT_DELAY_MS = 60;

export interface KeptThreadView {
  projectId: string;
  threadId: string;
}

interface KeptThreadViewEntry extends KeptThreadView {
  scope: string;
  usedAt: number;
}

const EMPTY_VIEWS: readonly KeptThreadView[] = [];

let entries: readonly KeptThreadViewEntry[] = [];

let viewsByScope = new Map<string, readonly KeptThreadView[]>();

let clock = 0;

let focusedScope: string | null = null;

const shownByScope = new Map<string, string>();

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function resolveKeptThreadViewLimit(): number {
  return getMediaQuerySnapshot(POINTER_COARSE_QUERY)
    ? COARSE_POINTER_KEPT_THREAD_VIEW_LIMIT
    : KEPT_THREAD_VIEW_LIMIT;
}

function isShown(entry: KeptThreadViewEntry): boolean {
  return shownByScope.get(entry.scope) === entry.threadId;
}

function publish(next: readonly KeptThreadViewEntry[]): void {
  entries = next;
  const grouped = new Map<string, KeptThreadView[]>();

  for (const entry of next) {
    const views = grouped.get(entry.scope) ?? [];

    const previous = viewsByScope
      .get(entry.scope)
      ?.find(
        (view) =>
          view.threadId === entry.threadId &&
          view.projectId === entry.projectId,
      );

    views.push(
      previous ?? { projectId: entry.projectId, threadId: entry.threadId },
    );
    grouped.set(entry.scope, views);
  }

  const nextViewsByScope = new Map<string, readonly KeptThreadView[]>();

  for (const [scope, views] of grouped) {
    const previous = viewsByScope.get(scope);

    nextViewsByScope.set(
      scope,
      previous !== undefined &&
        previous.length === views.length &&
        previous.every((view, index) => view === views[index])
        ? previous
        : views,
    );
  }

  viewsByScope = nextViewsByScope;

  for (const listener of listeners) listener();
}

function touch(scope: string, view: KeptThreadView): void {
  if (isPendingChatId(view.threadId)) return;
  clock += 1;
  const usedAt = clock;

  const existing = entries.find(
    (entry) => entry.scope === scope && entry.threadId === view.threadId,
  );

  let next =
    existing === undefined
      ? [...entries, { ...view, scope, usedAt }]
      : entries.map((entry) =>
          entry === existing ? { ...entry, ...view, usedAt } : entry,
        );

  const limit = resolveKeptThreadViewLimit();

  while (next.length > limit) {
    const evicted = next
      .filter((entry) => !isShown(entry))
      .reduce<KeptThreadViewEntry | null>(
        (oldest, entry) =>
          oldest === null || entry.usedAt < oldest.usedAt ? entry : oldest,
        null,
      );

    if (evicted === null) break;
    next = next.filter((entry) => entry !== evicted);
  }

  publish(next);
}

export function showThreadView(scope: string, view: KeptThreadView): void {
  shownByScope.set(scope, view.threadId);
  touch(scope, view);
}

export function focusThreadViewScope(scope: string): void {
  focusedScope = scope;
}

export function releaseThreadViewScope(scope: string): void {
  shownByScope.delete(scope);

  if (focusedScope === scope) focusedScope = null;

  if (entries.some((entry) => entry.scope === scope))
    publish(entries.filter((entry) => entry.scope !== scope));
}

export function keepThreadView(view: KeptThreadView): void {
  if (focusedScope === null) return;
  touch(focusedScope, view);
}

export function useKeptThreadViews(
  scope: string,
  current: KeptThreadView,
): readonly KeptThreadView[] {
  const kept = useSyncExternalStore(
    subscribe,
    () => viewsByScope.get(scope) ?? EMPTY_VIEWS,
    () => EMPTY_VIEWS,
  );

  if (
    kept.some(
      (view) =>
        view.threadId === current.threadId &&
        view.projectId === current.projectId,
    )
  )
    return kept;

  return [
    ...kept.filter((view) => view.threadId !== current.threadId),
    current,
  ];
}

export function resolveThreadViewIntent(
  queryClient: QueryClient,
  threadId: string,
): KeptThreadView | null {
  const thread = queryClient.getQueryData<ThreadWithIncludesResponse>(
    threadDetailBootstrapQueryKey(threadId),
  );

  if (thread?.id !== threadId || thread.archivedAt !== null) return null;

  return { projectId: thread.projectId, threadId };
}

export function useStableThreadViewOrder(
  views: readonly KeptThreadView[],
): readonly KeptThreadView[] {
  const orderRef = useRef<readonly string[]>([]);

  return useMemo(() => {
    const byId = new Map<string, KeptThreadView>();

    for (const view of views)
      if (!byId.has(view.threadId)) byId.set(view.threadId, view);

    const order = [
      ...orderRef.current.filter((threadId) => byId.has(threadId)),
      ...[...byId.keys()].filter(
        (threadId) => !orderRef.current.includes(threadId),
      ),
    ];

    orderRef.current = order;

    return order.flatMap((threadId) => {
      const view = byId.get(threadId);

      return view === undefined ? [] : [view];
    });
  }, [views]);
}
