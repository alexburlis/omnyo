import { useEffect, useRef } from "react";

const outlineRequestListeners = new Map<string, Set<() => void>>();

export function requestThreadOutline(threadId: string): boolean {
  const listeners = outlineRequestListeners.get(threadId);

  if (listeners === undefined || listeners.size === 0) return false;

  for (const listener of listeners) listener();

  return true;
}

export function useThreadOutlineRequests(
  threadId: string,
  onRequest: () => void,
): void {
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;

  useEffect(() => {
    const listener = () => onRequestRef.current();
    const listeners = outlineRequestListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    outlineRequestListeners.set(threadId, listeners);

    return () => {
      listeners.delete(listener);

      if (listeners.size === 0) outlineRequestListeners.delete(threadId);
    };
  }, [threadId]);
}
