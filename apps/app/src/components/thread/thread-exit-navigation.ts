import type { QueryClient } from "@tanstack/react-query";
import type { Thread } from "@omnyo/domain";
import { getCachedSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "@/hooks/cache-owners/thread-list-cache-data";
import { threadsQueryKey } from "@/hooks/queries/query-keys";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadLifecycle } from "@/lib/thread-lifecycle";
import {
  getInboxThreadNavigationTargets,
  getSidebarThreadNavigationTargets,
} from "@/components/sidebar/sidebarThreadShortcuts";

export function getThreadExitNavigation(
  queryClient: QueryClient,
  thread: Pick<Thread, "id" | "projectId">,
) {
  const cached = new Map(
    getCachedSidebarNavigationThreads(queryClient).map((entry) => [
      entry.id,
      entry,
    ]),
  );

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const entry of iterateThreadListCacheEntries(data)) {
      if (!cached.has(entry.id)) cached.set(entry.id, entry);
    }
  }

  const familyIds = new Set([thread.id]);
  const children = new Map<string, string[]>();

  for (const entry of cached.values()) {
    if (entry.parentThreadId === null) continue;
    const siblings = children.get(entry.parentThreadId) ?? [];
    siblings.push(entry.id);
    children.set(entry.parentThreadId, siblings);
  }

  for (const id of familyIds) {
    for (const childId of children.get(id) ?? []) familyIds.add(childId);
  }

  const inboxTargets = getInboxThreadNavigationTargets(document.body);

  const eligible = (id: string) => {
    const entry = cached.get(id);

    return (
      entry !== undefined &&
      !familyIds.has(id) &&
      entry.deletedAt === null &&
      entry.visibility !== "hidden" &&
      (inboxTargets === null
        ? entry.projectId === thread.projectId &&
          getThreadLifecycle(entry) === "active"
        : getThreadLifecycle(entry) !== "archived")
    );
  };

  const targets =
    inboxTargets ?? getSidebarThreadNavigationTargets(document.body);

  const index = targets.findIndex((target) => target.threadId === thread.id);
  const after = targets.slice(index + 1);

  const ordered =
    inboxTargets !== null || index < 0
      ? after
      : [...after, ...targets.slice(0, index).reverse()];

  const nextTarget = ordered.find((target) => eligible(target.threadId));

  const nextId =
    nextTarget?.threadId ??
    (inboxTargets === null ? [...cached.keys()].find(eligible) : undefined);

  const nextThread = nextId === undefined ? undefined : cached.get(nextId);

  return {
    familyIds: [...familyIds],
    destination: nextThread
      ? getThreadRoutePath({
          projectId: nextThread.projectId,
          threadId: nextThread.id,
        })
      : null,
  };
}
