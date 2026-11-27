import { useSyncExternalStore } from "react";
import { z } from "zod";
import { readStored, writeStored } from "./storage.ts";

interface FeedStore {
  runningExpanded: boolean;
  runningReveal: number;
  inboxMounted: number;
}

const RUNNING_KEY = "chat-topics:inbox-running-open";

let store: FeedStore | null = null;

const listeners = new Set<() => void>();

function current(): FeedStore {
  store ??= {
    runningExpanded: readStored(RUNNING_KEY, z.boolean(), true),
    runningReveal: 0,
    inboxMounted: 0,
  };

  return store;
}

function emit(next: FeedStore) {
  if (next.runningExpanded !== current().runningExpanded)
    writeStored(RUNNING_KEY, next.runningExpanded);
  store = next;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function setRunningExpanded(runningExpanded: boolean) {
  const state = current();

  if (state.runningExpanded !== runningExpanded) emit({ ...state, runningExpanded });
}

export function revealRunningSection() {
  const state = current();

  emit({ ...state, runningExpanded: true, runningReveal: state.runningReveal + 1 });
}

export function useRunningReveal(): number {
  return useSyncExternalStore(subscribe, () => current().runningReveal);
}

export function useRunningExpanded(): boolean {
  return useSyncExternalStore(subscribe, () => current().runningExpanded);
}

export function useInboxMounted(): boolean {
  return useSyncExternalStore(subscribe, () => current().inboxMounted > 0);
}

export function markInboxMounted(): () => void {
  emit({ ...current(), inboxMounted: current().inboxMounted + 1 });

  return () => emit({ ...current(), inboxMounted: current().inboxMounted - 1 });
}
