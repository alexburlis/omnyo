import { useSyncExternalStore } from "react";

let selection: readonly string[] = [];

const listeners = new Set<() => void>();

function sameSelection(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export function getChatSelection(): readonly string[] {
  return selection;
}

export function setChatSelection(threadIds: readonly string[]): void {
  if (sameSelection(selection, threadIds)) return;
  selection = [...threadIds];

  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useChatSelection(): readonly string[] {
  return useSyncExternalStore(subscribe, getChatSelection, getChatSelection);
}
