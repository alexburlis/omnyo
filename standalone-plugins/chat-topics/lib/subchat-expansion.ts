import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { z } from "zod";
import type { ChatTree } from "./grouping.ts";
import { readStored, writeStored } from "./storage.ts";

const STORAGE_KEY = "chat-topics:subchat-expansion";

const MAX_CHOICES = 300;

const choicesSchema = z.record(z.string(), z.boolean());

type Choices = Readonly<Record<string, boolean>>;

let choices: Choices | null = null;

const listeners = new Set<() => void>();

function current(): Choices {
  choices ??= readStored(STORAGE_KEY, choicesSchema, {});

  return choices;
}

function save(next: Choices) {
  choices = next;
  writeStored(STORAGE_KEY, next);

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function revealedAncestors(tree: ChatTree, activeThreadId: string | null): Set<string> {
  const revealed = new Set<string>();
  let id = activeThreadId === null ? null : (tree.nodes.get(activeThreadId)?.parentId ?? null);

  while (id !== null && !revealed.has(id)) {
    const node = tree.nodes.get(id);

    if (node === undefined) break;
    revealed.add(id);
    id = node.parentId;
  }

  return revealed;
}

export function expandedThreads(
  tree: ChatTree,
  revealed: ReadonlySet<string>,
  stored: Choices,
): Set<string> {
  const expanded = new Set<string>();

  for (const [id, node] of tree.nodes) {
    if (node.children.length === 0) continue;

    if (stored[id] ?? revealed.has(id)) expanded.add(id);
  }

  return expanded;
}

export function toggledChoices(
  stored: Choices,
  id: string,
  open: boolean,
): Record<string, boolean> {
  const kept = Object.entries(stored).filter(([key]) => key !== id);

  const next: Record<string, boolean> = Object.fromEntries(
    kept.slice(Math.max(0, kept.length - MAX_CHOICES + 1)),
  );

  next[id] = !open;

  return next;
}

export function withoutCollapsed(stored: Choices, ids: ReadonlySet<string>): Choices {
  if (![...ids].some((id) => stored[id] === false)) return stored;

  return Object.fromEntries(Object.entries(stored).filter(([id, open]) => open || !ids.has(id)));
}

export function useSubchatExpansion(tree: ChatTree, activeThreadId: string | null) {
  const stored = useSyncExternalStore(subscribe, current);

  const revealed = useMemo(() => revealedAncestors(tree, activeThreadId), [tree, activeThreadId]);

  const expanded = useMemo(() => expandedThreads(tree, revealed, stored), [tree, revealed, stored]);

  const revealedFor = useRef<string | null>(null);

  useEffect(() => {
    if (activeThreadId === revealedFor.current || revealed.size === 0) return;
    revealedFor.current = activeThreadId;
    const next = withoutCollapsed(current(), revealed);

    if (next !== current()) save(next);
  }, [activeThreadId, revealed]);

  const toggle = useCallback(
    (id: string) => save(toggledChoices(current(), id, expanded.has(id))),
    [expanded],
  );

  return { expanded, toggle };
}
