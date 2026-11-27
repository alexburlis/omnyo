import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";

export interface BranchNode {
  thread: PluginSidebarThread;
  children: BranchNode[];
  count: number;
  newest: number;
  pinned: boolean;
  pinSortKey: string | null;
  pinnedAt: number;
}

export function branchForest(threads: readonly PluginSidebarThread[]) {
  const nodes = new Map<string, BranchNode>();
  const parents = new Map<string, string>();

  for (const thread of threads) {
    if (thread.isArchived || thread.isHidden || nodes.has(thread.id)) continue;
    nodes.set(thread.id, {
      thread,
      children: [],
      count: 1,
      newest: thread.updatedAt,
      pinned: thread.isPinned,
      pinSortKey: thread.pinSortKey,
      pinnedAt: thread.pinnedAt ?? 0,
    });
  }

  for (const { thread } of nodes.values()) {
    if (thread.originKind !== "fork" || thread.sourceThreadId === null) continue;
    const source = nodes.get(thread.sourceThreadId);

    if (source && source.thread.projectId === thread.projectId && source.thread.id !== thread.id) {
      parents.set(thread.id, source.thread.id);
    }
  }

  // Native forks form a DAG. Break corrupt cycles without dropping a visible chat.
  const processed = new Set<string>();

  for (const id of nodes.keys()) {
    const path = new Set<string>();
    let cursor: string | undefined = id;

    while (cursor !== undefined && !processed.has(cursor)) {
      if (path.has(cursor)) {
        parents.delete(cursor);
        break;
      }

      path.add(cursor);
      cursor = parents.get(cursor);
    }

    for (const member of path) processed.add(member);
  }

  const roots: BranchNode[] = [];

  for (const [id, node] of nodes) {
    const parentId = parents.get(id);
    const parent = parentId === undefined ? undefined : nodes.get(parentId);

    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const visit: BranchNode[] = [];
  const stack = [...roots];

  while (stack.length > 0) {
    const node = stack.pop();

    if (!node) break;
    node.children.sort(
      (a, b) => a.thread.createdAt - b.thread.createdAt || a.thread.id.localeCompare(b.thread.id),
    );
    visit.push(node);
    stack.push(...node.children);
  }

  for (let i = visit.length - 1; i >= 0; i--) {
    const node = visit[i];

    for (const child of node.children) {
      node.count += child.count;
      node.newest = Math.max(node.newest, child.newest);
      node.pinned ||= child.pinned;
      node.pinnedAt = Math.max(node.pinnedAt, child.pinnedAt);

      if (
        child.pinSortKey !== null &&
        (node.pinSortKey === null || child.pinSortKey < node.pinSortKey)
      ) {
        node.pinSortKey = child.pinSortKey;
      }
    }
  }

  roots.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

    if (a.pinned && b.pinned) {
      if (a.pinSortKey !== null && b.pinSortKey !== null) {
        const order = a.pinSortKey.localeCompare(b.pinSortKey);

        if (order !== 0) return order;
      } else if (a.pinSortKey !== b.pinSortKey) return a.pinSortKey !== null ? -1 : 1;

      if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt;
    }

    return b.newest - a.newest || a.thread.id.localeCompare(b.thread.id);
  });

  return { roots, nodes, parents };
}

export function indicatorIcon(thread: PluginSidebarThread): string | null {
  switch (thread.indicator) {
    case "waiting-for-input":
      return "MessageQuestion";
    case "unread-error":
    case "queued-failed":
      return "AlertCircle";
    case "unread-success":
      return "Circle";
    case "queued-waiting":
      return "Clock";
    case "draft":
      return "Edit";
    case "runtime":
    case "background-agent":
    case "background-command":
    case "goal":
    case "plan-mode":
    case "workflow":
    case "working-draft":
      return "Spinner";
    default:
      return null;
  }
}
