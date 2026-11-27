import { useSyncExternalStore } from "react";
import { z } from "zod";
import { readStored, writeStored } from "./storage.ts";

const KEY = "chat-topics:task-manager";

const listeners = new Set<() => void>();

let enabled = readStored(KEY, z.boolean(), false);

let footerHosts = 0;

let lists = 0;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function setTaskManager(next: boolean) {
  enabled = next;
  writeStored(KEY, next);
  notify();
}

export function useTaskManager() {
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => false,
  );
}

export function hostTaskManagerFooter() {
  footerHosts += 1;
  notify();

  return () => {
    footerHosts -= 1;
    notify();
  };
}

export function useTaskManagerFooter() {
  return useSyncExternalStore(
    subscribe,
    () => footerHosts > 0,
    () => false,
  );
}

export function mountTaskManagerList() {
  lists += 1;
  notify();

  return () => {
    lists -= 1;
    notify();
  };
}

export function useTaskManagerList() {
  return useSyncExternalStore(
    subscribe,
    () => lists > 0,
    () => false,
  );
}
