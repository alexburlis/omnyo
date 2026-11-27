import { useSyncExternalStore } from "react";

const compactViewportQuery = "(max-width: 767px)";

function subscribeViewport(listener: () => void) {
  const query = window.matchMedia(compactViewportQuery);
  query.addEventListener("change", listener);

  return () => query.removeEventListener("change", listener);
}

function compactViewport() {
  return window.matchMedia(compactViewportQuery).matches;
}

export function useCompactViewport() {
  return useSyncExternalStore(subscribeViewport, compactViewport, () => false);
}
