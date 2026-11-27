import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRealtime } from "@omnyo/plugin-sdk/app";
import { CHANGE_DEBOUNCE_MS } from "./chief-logic.ts";

export const CHIEF_CHANNEL = "chief.changed";

export function useChiefChanged(onChange: () => void): void {
  const latest = useRef(onChange);
  const timer = useRef<number | null>(null);

  latest.current = onChange;

  useRealtime(CHIEF_CHANNEL, () => {
    if (timer.current !== null) window.clearTimeout(timer.current);

    timer.current = window.setTimeout(() => {
      timer.current = null;
      latest.current();
    }, CHANGE_DEBOUNCE_MS);
  });

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(REDUCED_MOTION);

  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}
