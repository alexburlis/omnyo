import { useSyncExternalStore } from "react";

export const STARTUP_SETTLE_CAP_MS = 3_000;

export const STARTUP_IDLE_TIMEOUT_MS = 1_000;

let settled = false;

let idleRequested = false;

let capTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();

function settle(): void {
  if (settled) return;
  settled = true;

  if (capTimer !== null) clearTimeout(capTimer);
  capTimer = null;

  for (const listener of [...listeners]) listener();
}

export function markStartupChatRendered(): void {
  if (settled || idleRequested) return;
  idleRequested = true;

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(settle, { timeout: STARTUP_IDLE_TIMEOUT_MS });

    return;
  }

  setTimeout(settle, 0);
}

export function isStartupSettled(): boolean {
  return settled;
}

export function subscribeStartupSettled(listener: () => void): () => void {
  if (!settled && capTimer === null)
    capTimer = setTimeout(settle, STARTUP_SETTLE_CAP_MS);
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useStartupSettled(): boolean {
  return useSyncExternalStore(
    subscribeStartupSettled,
    isStartupSettled,
    isStartupSettled,
  );
}
