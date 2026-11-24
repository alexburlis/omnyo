import type { Thread, ThreadListEntry } from "@omnyo/domain";
import { isThreadRead } from "@omnyo/client-core";
import type { PluginThreadActionTarget } from "@omnyo/plugin-sdk";

export function toThreadActionTarget(
  thread: Thread,
  environment: PluginThreadActionTarget["environment"],
): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    shelvedAt: thread.shelvedAt,
    sectionId: thread.sectionId,
    isUnread: !isThreadRead(thread),
    status: thread.status,
    environment,
  };
}

export function threadListEntryActionTarget(
  entry: ThreadListEntry,
): PluginThreadActionTarget {
  return toThreadActionTarget(
    entry,
    entry.environmentId === null
      ? null
      : { id: entry.environmentId, path: entry.environmentPath },
  );
}
