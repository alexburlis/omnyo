import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

let tickNow = Date.now();

let ticker: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  tickNow = Date.now();

  for (const notify of listeners) notify();
}

function handleVisibilityChange(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }

  if (
    typeof document === "undefined" ||
    document.visibilityState !== "hidden"
  ) {
    tick();
    ticker = setInterval(tick, 30_000);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (listeners.size === 1) {
    handleVisibilityChange();

    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;

      if (typeof document !== "undefined")
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
    }
  };
}

function getSnapshot(): number {
  return tickNow;
}

export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
