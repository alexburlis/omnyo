import { compareCodepoint } from "./compare-codepoint.js";
import { isSidebarProjectThread } from "./project-thread-groups.js";
import type { SidebarThread } from "./sidebar-thread.js";
import { sidebarThreadLifecycle } from "./sidebar-thread-lifecycle.js";

function isNewer(candidate: SidebarThread, current: SidebarThread): boolean {
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt;
  }

  return compareCodepoint(candidate.id, current.id) > 0;
}

function rendersAtTopLevel(
  source: SidebarThread,
  threadById: ReadonlyMap<string, SidebarThread>,
): boolean {
  if (source.parentThreadId === null) return true;

  const parent = threadById.get(source.parentThreadId);

  return (
    parent === undefined ||
    !isSidebarProjectThread(parent) ||
    isShelved(parent) !== isShelved(source)
  );
}

function isShelved(thread: SidebarThread): boolean {
  return sidebarThreadLifecycle(thread) === "shelved";
}

function canGroupUnder(
  source: SidebarThread,
  handoff: SidebarThread,
  threadById: ReadonlyMap<string, SidebarThread>,
): boolean {
  return (
    rendersAtTopLevel(source, threadById) &&
    source.pinnedAt === null &&
    source.projectId === handoff.projectId &&
    sidebarThreadLifecycle(source) === sidebarThreadLifecycle(handoff)
  );
}

export function handoffChainHeads(
  threads: readonly SidebarThread[],
): ReadonlyMap<string, string> {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const newestHandoffBySourceId = new Map<string, SidebarThread>();

  for (const thread of threads) {
    if (thread.originKind !== "handoff" || thread.sourceThreadId === null) {
      continue;
    }

    const source = threadById.get(thread.sourceThreadId);

    if (source === undefined || !canGroupUnder(source, thread, threadById)) {
      continue;
    }

    const current = newestHandoffBySourceId.get(source.id);

    if (current === undefined || isNewer(thread, current)) {
      newestHandoffBySourceId.set(source.id, thread);
    }
  }

  const headById = new Map<string, string>();

  for (const sourceId of newestHandoffBySourceId.keys()) {
    const visited = new Set([sourceId]);
    let head = sourceId;
    let next = newestHandoffBySourceId.get(head);

    while (next !== undefined && !visited.has(next.id)) {
      visited.add(next.id);
      head = next.id;
      next = newestHandoffBySourceId.get(head);
    }

    if (head !== sourceId) headById.set(sourceId, head);
  }

  return headById;
}

const groupedBySource = new WeakMap<
  SidebarThread,
  { headId: string; grouped: SidebarThread }
>();

export function groupUnderHandoffHead(
  thread: SidebarThread,
  headId: string | undefined,
): SidebarThread {
  if (headId === undefined) return thread;

  const cached = groupedBySource.get(thread);

  if (cached !== undefined && cached.headId === headId) return cached.grouped;

  const grouped = {
    ...thread,
    parentThreadId: headId,
    handoffGroupHeadId: headId,
  };

  groupedBySource.set(thread, { headId, grouped });

  return grouped;
}
