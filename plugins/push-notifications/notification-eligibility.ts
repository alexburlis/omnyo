import type {
  PluginSidebarThread,
  PluginSidebarThreadsState,
} from "@omnyo/plugin-sdk/app";

function hasWork(thread: PluginSidebarThread): boolean {
  return (
    thread.status !== "idle" ||
    thread.runtimeStatus !== "idle" ||
    thread.queuedWork !== "none" ||
    thread.hasPendingInteraction ||
    Object.values(thread.activity).some((count) => count > 0) ||
    (thread.experimental_attention?.kind !== undefined &&
      thread.experimental_attention.kind !== "none")
  );
}

export function canShowChatNotification(
  sidebar: PluginSidebarThreadsState,
  threadId: string,
): boolean {
  if (sidebar.status !== "ready") return false;
  const thread = sidebar.threads.find((entry) => entry.id === threadId);

  if (!thread || thread.isArchived || thread.isHidden) return false;
  const attention = thread.experimental_attention?.kind;

  if (
    thread.hasPendingInteraction ||
    attention === "required-answer" ||
    attention === "optional-input"
  )
    return true;

  if (
    (thread.status !== "idle" && thread.status !== "error") ||
    (thread.runtimeStatus !== "idle" && thread.runtimeStatus !== "error") ||
    thread.queuedWork === "waiting" ||
    Object.values(thread.activity).some((count) => count > 0)
  )
    return false;

  if (
    thread.status === "error" ||
    thread.queuedWork === "failed" ||
    attention === "dependency-failed"
  )
    return true;

  if (attention === "callback-waiting") return false;
  const parents = new Set([threadId]);

  for (const parentId of parents) {
    for (const child of sidebar.threads) {
      if (child.parentThreadId !== parentId || child.isArchived) continue;

      if (hasWork(child)) return false;
      parents.add(child.id);
    }
  }

  return true;
}
