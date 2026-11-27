import { z } from "zod";
import { experimental_threadIndicators } from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";

export type ChatState = "need" | "failed" | "blk" | "run" | "que" | "ext" | "done" | "idle";

const SURFACED: ReadonlySet<ChatState> = new Set(["need", "failed", "blk", "run", "que"]);

export function needsAttention(state: ChatState): boolean {
  return SURFACED.has(state);
}

type SidebarWork = NonNullable<PluginSidebarThread["experimental_work"]>;

const ownStateSchema = z.object({
  primary: z.object({
    label: z.enum([
      "needs-you",
      "failed",
      "working",
      "blocked",
      "waiting",
      "open",
      "external",
      "ready-to-archive",
    ]),
    reason: z.object({ code: z.string(), text: z.string() }),
  }),
  hasActivity: z.boolean(),
});

export type WorkSummary = SidebarWork & {
  experimental_ownState?: z.infer<typeof ownStateSchema>;
};

export interface ThreadActivity {
  [key: string]: number;
}

export interface GroupThread {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  sourceThreadId: string | null;
  originKind: string | null;
  displayTitle: string;
  originPluginId: string | null;
  createdAt: number;
  latestAttentionAt: number;
  lastMessageAt: PluginSidebarThread["lastMessageAt"];
  isUnread: boolean;
  isPinned: boolean;
  isHidden: boolean;
  isArchived: boolean;
  shelvedAt: number | null;
  shelfSortKey: string | null;
  groupId: string | null;
  status: string;
  runtimeStatus: string;
  queuedWork: string;
  indicator: string | null;
  hasPendingInteraction: boolean;
  activity: ThreadActivity;
  work: WorkSummary | null;
}

export function groupThreadOf(thread: PluginSidebarThread): GroupThread {
  const work = thread.experimental_work ?? null;

  const ownState =
    work !== null && "experimental_ownState" in work
      ? ownStateSchema.optional().parse(work.experimental_ownState)
      : undefined;

  return {
    ...thread,
    activity: { ...thread.activity },
    shelvedAt: thread.experimental_shelvedAt ?? null,
    shelfSortKey: thread.experimental_shelfSortKey ?? null,
    groupId: thread.experimental_groupId ?? null,
    work:
      work === null || ownState === undefined ? work : { ...work, experimental_ownState: ownState },
  };
}

export interface RowMark {
  icon: string;
  label: string;
}

const STATE_OF_WORK: Readonly<Record<WorkSummary["primary"]["label"], ChatState>> = {
  "needs-you": "need",
  failed: "failed",
  working: "run",
  blocked: "blk",
  waiting: "que",
  open: "idle",
  external: "ext",
  "ready-to-archive": "done",
};

export function stateOfWork(work: WorkSummary | null, label = work?.primary.label): ChatState {
  if (label === undefined) return "idle";

  return STATE_OF_WORK[label];
}

export interface ChatNode {
  thread: GroupThread;
  parentId: string | null;
  continuation: boolean;
  children: ChatNode[];
  family: readonly GroupThread[];
  own: ChatState;
  state: ChatState;
  attentionAt: number;
  newChildren: number;
  descendants: number;
}

export function continuationLabel(
  node: Pick<ChatNode, "continuation" | "children">,
): string | null {
  if (node.continuation) return "Earlier chat";
  const earlier = node.children.filter((child) => child.continuation).length;

  if (earlier === 0) return null;

  return `Continues ${earlier} earlier ${earlier === 1 ? "chat" : "chats"}`;
}

export function showsUnread(node: Pick<ChatNode, "thread">): boolean {
  return node.thread.isUnread;
}

export function isProjectRoot(node: ChatNode): boolean {
  return node.parentId === null && node.thread.lifecycleOwnerThreadId === null;
}

const ASKING_LABELS: ReadonlySet<string> = new Set(["working", "needs-you"]);

export function rootAttention(node: ChatNode) {
  const work = node.thread.work;
  const own = work?.experimental_ownState;
  const label = own?.primary.label ?? work?.primary.label;

  const optional = label !== "failed" && label !== "needs-you" ? work?.optionalInput[0] : undefined;

  const root = isProjectRoot(node);

  const running =
    root && (label === "working" || (own?.hasActivity ?? (work?.activity.length ?? 0) > 0));

  const asking =
    running &&
    label !== undefined &&
    ASKING_LABELS.has(label) &&
    (work?.requiredInput.length ?? 0) + (work?.optionalInput.length ?? 0) > 0;

  return {
    state: !root ? "idle" : asking ? "need" : stateOfWork(work, label),
    unread: root && node.thread.isUnread,
    running,
    asking,
    reason: optional?.label ?? own?.primary.reason.text ?? work?.primary.reason.text ?? null,
  } satisfies {
    state: ChatState;
    unread: boolean;
    running: boolean;
    asking: boolean;
    reason: string | null;
  };
}

export function familyWorkSource(node: ChatNode): GroupThread {
  const family = node.family.filter(
    (thread) =>
      thread.id === node.thread.id ||
      (thread.work?.primary.label !== "failed" && thread.work?.primary.label !== "blocked"),
  );

  const required = family.find((thread) => thread.work?.primary.label === "needs-you");

  if (required !== undefined) return required;

  const failed = family.find((thread) => thread.work?.primary.label === "failed");

  if (failed !== undefined) return failed;

  const work = experimental_threadIndicators.strongest(family.map((thread) => thread.work));

  return family.find((thread) => thread.work === work) ?? node.thread;
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set(["active", "starting"]);

export function familyStopping(node: Pick<ChatNode, "state" | "family">): boolean {
  return (
    node.state === "run" &&
    node.family.some((thread) => thread.status === "stopping") &&
    !node.family.some((thread) => RUNNING_STATUSES.has(thread.status))
  );
}

export function hasFamilyActivity(node: ChatNode): boolean {
  return node.family.some((thread) => (thread.work?.activity.length ?? 0) > 0);
}

function recentFirst(a: ChatNode, b: ChatNode): number {
  return (
    b.attentionAt - a.attentionAt ||
    b.thread.createdAt - a.thread.createdAt ||
    a.thread.id.localeCompare(b.thread.id)
  );
}

export function newestFirst(a: ChatNode, b: ChatNode): number {
  return b.thread.createdAt - a.thread.createdAt || a.thread.id.localeCompare(b.thread.id);
}

export interface ChatTree {
  roots: ChatNode[];
  shelf: ChatNode[];
  nodes: Map<string, ChatNode>;
}

function isNewerThread(candidate: GroupThread, current: GroupThread): boolean {
  return (
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id.localeCompare(current.id) > 0)
  );
}

function canContinueInto(source: GroupThread, continuation: GroupThread): boolean {
  return (
    source.parentThreadId === null &&
    !source.isPinned &&
    source.projectId === continuation.projectId &&
    (continuation.shelvedAt === null || source.shelvedAt !== null)
  );
}

export function continuationHeads(
  threads: ReadonlyMap<string, GroupThread>,
): ReadonlyMap<string, string> {
  const newest = new Map<string, GroupThread>();

  for (const thread of threads.values()) {
    if (thread.originKind !== "handoff" || thread.sourceThreadId === null) continue;
    const source = threads.get(thread.sourceThreadId);

    if (source === undefined || !canContinueInto(source, thread)) continue;
    const current = newest.get(source.id);

    if (current === undefined || isNewerThread(thread, current)) newest.set(source.id, thread);
  }

  const heads = new Map<string, string>();

  for (const sourceId of newest.keys()) {
    const seen = new Set([sourceId]);
    let head = sourceId;
    let next = newest.get(head);

    while (next !== undefined && !seen.has(next.id)) {
      seen.add(next.id);
      head = next.id;
      next = newest.get(head);
    }

    if (head !== sourceId) heads.set(sourceId, head);
  }

  return heads;
}

export function buildTree(threads: readonly GroupThread[]): ChatTree {
  const nodes = new Map<string, ChatNode>();
  const visible = new Map<string, GroupThread>();

  for (const thread of threads) {
    if (!thread.isHidden && !thread.isArchived) visible.set(thread.id, thread);
  }

  const heads = continuationHeads(visible);

  for (const thread of threads) {
    if (thread.isHidden || thread.isArchived) continue;

    const own = stateOfWork(thread.work);

    const head = thread.parentThreadId === null ? heads.get(thread.id) : undefined;
    const parent = thread.parentThreadId === null ? undefined : visible.get(thread.parentThreadId);

    const continuation =
      head !== undefined ||
      (parent?.originKind === "handoff" && parent.sourceThreadId === thread.id);

    nodes.set(thread.id, {
      thread,
      parentId: thread.parentThreadId ?? head ?? null,
      continuation,
      children: [],
      family: [thread],
      own,
      state: own,
      attentionAt: thread.latestAttentionAt,
      newChildren: 0,
      descendants: 0,
    });
  }

  const roots: ChatNode[] = [];
  const parents = new Map<ChatNode, ChatNode>();

  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);

    if (parent === undefined) roots.push(node);
    else {
      parent.children.push(node);
      parents.set(node, parent);
    }
  }

  const reached = new Set<ChatNode>();

  const mark = (start: ChatNode) => {
    const stack = [start];

    while (stack.length > 0) {
      const node = stack.pop();

      if (node === undefined || reached.has(node)) continue;
      reached.add(node);
      stack.push(...node.children);
    }
  };

  for (const root of roots) mark(root);

  for (const node of nodes.values()) {
    if (reached.has(node)) continue;
    const parent = parents.get(node);

    if (parent !== undefined) parent.children = parent.children.filter((child) => child !== node);
    roots.push(node);
    mark(node);
  }

  const settle = (node: ChatNode) => {
    node.children.sort(newestFirst);

    for (const child of node.children) {
      settle(child);
      node.descendants += 1 + child.descendants;

      if (child.thread.isUnread || child.newChildren > 0) node.newChildren += 1;
    }

    node.family = [
      node.thread,
      ...node.children.filter((child) => !child.continuation).flatMap((child) => child.family),
    ];
    node.state = stateOfWork(familyWorkSource(node).work);
  };

  for (const root of roots) settle(root);

  roots.sort(newestFirst);

  const active: ChatNode[] = [];
  const shelf: ChatNode[] = [];

  for (const root of roots) {
    if (root.thread.shelvedAt === null) active.push(root);
    else shelf.push(root);
  }

  shelf.sort((a, b) => compareShelved(a.thread, b.thread));

  return { roots: active, shelf, nodes };
}

type ShelfSortable = Pick<GroupThread, "id" | "shelvedAt" | "shelfSortKey">;

function byCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareShelved(a: ShelfSortable, b: ShelfSortable): number {
  if (a.shelfSortKey !== b.shelfSortKey) {
    if (a.shelfSortKey === null) return -1;

    if (b.shelfSortKey === null) return 1;

    return byCodepoint(a.shelfSortKey, b.shelfSortKey);
  }

  return (b.shelvedAt ?? 0) - (a.shelvedAt ?? 0) || byCodepoint(a.id, b.id);
}

export interface RootEntry {
  node: ChatNode;
}

export type ProjectSectionKey =
  | "pinned"
  | "need"
  | "failed"
  | "blk"
  | "run"
  | "que"
  | "read"
  | "ext"
  | "done"
  | "shelf";

interface SectionDefinition {
  key: ProjectSectionKey;
  label: string;
  folded: boolean;
}

export const PROJECT_SECTIONS: readonly SectionDefinition[] = [
  { key: "need", label: "Needs you", folded: false },
  { key: "run", label: "Running", folded: false },
  { key: "pinned", label: "Pinned", folded: false },
  { key: "failed", label: "Failed", folded: false },
  { key: "blk", label: "Blocked", folded: false },
  { key: "que", label: "Waiting", folded: false },
  { key: "read", label: "Open", folded: false },
  { key: "ext", label: "External", folded: false },
  { key: "done", label: "Ready to archive", folded: false },
];

export const SHELF_SECTION: SectionDefinition = { key: "shelf", label: "Shelf", folded: false };

const PLACEMENT_SECTION: Readonly<Record<ChatState, ProjectSectionKey>> = {
  need: "need",
  failed: "failed",
  blk: "blk",
  run: "run",
  que: "que",
  ext: "ext",
  done: "done",
  idle: "read",
};

export function projectSectionOf(entry: RootEntry): ProjectSectionKey {
  return entry.node.thread.isPinned ? "pinned" : PLACEMENT_SECTION[rootAttention(entry.node).state];
}

export interface ProjectSection extends SectionDefinition {
  entries: RootEntry[];
}

export function sectionProject(roots: readonly ChatNode[]): ProjectSection[] {
  const bySection = new Map<ProjectSectionKey, RootEntry[]>();
  const asking = new Set<ChatNode>();

  for (const node of roots) {
    const entry: RootEntry = { node };
    const key = projectSectionOf(entry);
    const list = bySection.get(key);

    if (rootAttention(node).asking) asking.add(node);

    if (list === undefined) bySection.set(key, [entry]);
    else list.push(entry);
  }

  return PROJECT_SECTIONS.flatMap((section) => {
    const entries = bySection.get(section.key);

    if (entries === undefined) return [];
    entries.sort(
      (a, b) =>
        Number(asking.has(b.node)) - Number(asking.has(a.node)) || newestFirst(a.node, b.node),
    );

    return [{ ...section, entries }];
  });
}

export interface ProjectGroup {
  projectId: string;
  sections: ProjectSection[];
  shelf: ProjectSection | null;
}

export function projectGroup(
  projectId: string,
  roots: readonly ChatNode[],
  shelf: readonly ChatNode[],
): ProjectGroup {
  return {
    projectId,
    sections: sectionProject(roots),
    shelf:
      shelf.length === 0 ? null : { ...SHELF_SECTION, entries: shelf.map((node) => ({ node })) },
  };
}

export function groupProjects(tree: ChatTree): ProjectGroup[] {
  const newest = new Map<string, number>();

  for (const root of [...tree.roots, ...tree.shelf]) {
    const { projectId, createdAt } = root.thread;

    newest.set(projectId, Math.max(newest.get(projectId) ?? createdAt, createdAt));
  }

  return [...newest]
    .sort(([a, aNewest], [b, bNewest]) => bNewest - aNewest || a.localeCompare(b))
    .map(([projectId]) => {
      const inProject = (root: ChatNode) => root.thread.projectId === projectId;

      return projectGroup(projectId, tree.roots.filter(inProject), tree.shelf.filter(inProject));
    });
}

export function rootsInProject(families: readonly ChatNode[], projectId: string): ChatNode[] {
  const roots: ChatNode[] = [];

  const visit = (node: ChatNode, parentProjectId: string | null) => {
    if (node.thread.projectId === projectId && parentProjectId !== projectId) roots.push(node);

    for (const child of node.children) visit(child, node.thread.projectId);
  };

  for (const family of families) visit(family, null);

  return roots;
}

export function countReachable(
  roots: readonly ChatNode[],
  projectId: string | null = null,
): number {
  const seen = new Set<ChatNode>();
  const stack = [...roots];

  while (stack.length > 0) {
    const node = stack.pop();

    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    stack.push(...node.children);
  }

  return projectId === null
    ? seen.size
    : [...seen].filter((node) => node.thread.projectId === projectId).length;
}

export type InboxSectionId = "blk" | "need" | "failed" | "run" | "que" | "idle" | "ext" | "done";

export interface InboxSection {
  id: InboxSectionId;
  label: string;
  roots: ChatNode[];
  folded: boolean;
}

export function inboxRoots(tree: ChatTree): ChatNode[] {
  return tree.roots;
}

const INBOX_SECTIONS: readonly { id: InboxSectionId; label: string; folded: boolean }[] = [
  { id: "run", label: "Running", folded: false },
  { id: "need", label: "Needs you", folded: false },
  { id: "failed", label: "Failed", folded: false },
  { id: "blk", label: "Blocked", folded: false },
  { id: "que", label: "Waiting", folded: false },
  { id: "idle", label: "Open", folded: true },
  { id: "ext", label: "External", folded: true },
  { id: "done", label: "Ready to archive", folded: true },
];

export function inboxSections(tree: ChatTree): InboxSection[] {
  return INBOX_SECTIONS.flatMap((section) => {
    const roots = inboxRoots(tree)
      .filter((root) => rootAttention(root).state === section.id)
      .sort(recentFirst);

    return roots.length === 0 ? [] : [{ ...section, roots }];
  });
}
