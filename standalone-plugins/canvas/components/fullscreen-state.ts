import { useSyncExternalStore } from "react";
import type { PluginComposerApi } from "@omnyo/plugin-sdk/app";

interface FullScreenBoard {
  threadId: string;
  composer: PluginComposerApi | null;
  opener: HTMLElement | null;
}

let current: FullScreenBoard | null = null;

const listeners = new Set<() => void>();

function publish(next: FullScreenBoard | null) {
  current = next;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function openFullScreen(threadId: string, composer: PluginComposerApi | null) {
  publish({
    threadId,
    composer,
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  });
}

export function closeFullScreen() {
  publish(null);
}

export function useFullScreenBoard(): FullScreenBoard | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
