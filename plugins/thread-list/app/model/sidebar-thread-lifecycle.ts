import {
  buildProjectThreadGroups,
  compareStandardThreads,
  type ProjectThreadNode,
} from "./project-thread-groups.js";
import { compareCodepoint } from "./compare-codepoint.js";
import type { SidebarThread } from "./sidebar-thread.js";

export type SidebarThreadLifecycle = "active" | "shelved" | "archived";

export function sidebarThreadLifecycle(
  thread: Pick<SidebarThread, "archivedAt" | "experimental_shelvedAt">,
): SidebarThreadLifecycle {
  if (thread.archivedAt != null) return "archived";

  return thread.experimental_shelvedAt == null ? "active" : "shelved";
}

function compareShelfSortKeys(left: string | null, right: string | null) {
  if (left === right) return 0;

  if (left === null) return -1;

  if (right === null) return 1;

  return compareCodepoint(left, right);
}

export function compareShelvedThreads(
  left: SidebarThread,
  right: SidebarThread,
): number {
  const sortKeyDelta = compareShelfSortKeys(
    left.experimental_shelfSortKey,
    right.experimental_shelfSortKey,
  );

  if (sortKeyDelta !== 0) return sortKeyDelta;

  const shelvedAtDelta =
    (right.experimental_shelvedAt ?? 0) - (left.experimental_shelvedAt ?? 0);

  return shelvedAtDelta !== 0
    ? shelvedAtDelta
    : compareStandardThreads(left, right);
}

export function buildShelfRootNodes(
  shelvedThreads: readonly SidebarThread[],
): ProjectThreadNode[] {
  return buildProjectThreadGroups(
    shelvedThreads,
    compareShelvedThreads,
    false,
  ).flatMap((item) => (item.kind === "thread" ? [item.node] : []));
}
