import { useSyncExternalStore } from "react";

let session = 0;

const listeners = new Set<() => void>();

export function resetPluginPageSession() {
  session += 1;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function usePluginPageSession() {
  return useSyncExternalStore(subscribe, () => session);
}
