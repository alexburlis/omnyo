import type { PluginThreadActionTarget } from "@omnyo/plugin-sdk/app";
import type { SidebarThread } from "../model/sidebar-thread.js";

export function toThreadActionTarget(
  thread: SidebarThread,
): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    shelvedAt: thread.experimental_shelvedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      thread.environment?.id == null
        ? null
        : { id: thread.environment.id, path: thread.environment.path },
  };
}
