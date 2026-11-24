import type { QueryClient } from "@tanstack/react-query";

const MAX_RENDER_KEY_ALIASES = 256;

const renderKeysByClient = new WeakMap<QueryClient, Map<string, string>>();

export function carryQueuedMessageRenderKey(
  queryClient: QueryClient,
  fromQueuedMessageId: string,
  toQueuedMessageId: string,
): void {
  let renderKeys = renderKeysByClient.get(queryClient);

  if (renderKeys === undefined) {
    renderKeys = new Map();
    renderKeysByClient.set(queryClient, renderKeys);
  }

  const renderKey = renderKeys.get(fromQueuedMessageId) ?? fromQueuedMessageId;
  renderKeys.delete(fromQueuedMessageId);
  renderKeys.set(toQueuedMessageId, renderKey);

  for (const queuedMessageId of renderKeys.keys()) {
    if (renderKeys.size <= MAX_RENDER_KEY_ALIASES) break;
    renderKeys.delete(queuedMessageId);
  }
}

export function queuedMessageRenderKey(
  queryClient: QueryClient | null,
  queuedMessageId: string,
): string {
  if (queryClient === null) return queuedMessageId;

  return (
    renderKeysByClient.get(queryClient)?.get(queuedMessageId) ?? queuedMessageId
  );
}
