import type { PluginApi } from "@omnyo/plugin-sdk";

export interface QueuedRetry {
  id: string;
  threadId: string;
  sendAt: number | null;
}

export async function listQueuedRetries(
  api: PluginApi,
  threadId?: string,
): Promise<QueuedRetry[]> {
  const rows = await api.sdk.threads.queue.list(
    threadId === undefined ? {} : { threadId },
  );

  return rows
    .filter((row) => row.payload.kind === "retry")
    .map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sendAt: row.sendAt,
    }));
}

export async function findQueuedRetry(
  api: PluginApi,
  threadId: string,
): Promise<QueuedRetry | null> {
  const rows = await listQueuedRetries(api, threadId);

  return rows[0] ?? null;
}
