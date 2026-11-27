import type { PluginSidebarThread, PluginSidebarThreadRowStatus } from "@omnyo/plugin-sdk/app";

export type GroupId =
  | "unread-needs-you"
  | "unread"
  | "unread-ready"
  | "read-needs-you"
  | "unfinished"
  | "ready"
  | "working";

export interface ChatGroup {
  id: GroupId;
  label: string;
  icon: string;
  readState: "Unread" | "Read" | null;
}

export type SectionId = "unread" | "read" | "working";

export interface ChatSection {
  id: SectionId;
  label: string;
  groups: readonly GroupId[];
}

export const CHAT_SECTIONS: readonly ChatSection[] = [
  { id: "unread", label: "Unread", groups: ["unread-needs-you", "unread", "unread-ready"] },
  { id: "read", label: "Read", groups: ["read-needs-you", "unfinished", "ready"] },
  { id: "working", label: "Working", groups: ["working"] },
];

export function sectionForGroup(group: GroupId): SectionId {
  if (group === "working") return "working";

  return group.startsWith("unread") ? "unread" : "read";
}

export const CHAT_GROUPS: readonly ChatGroup[] = [
  { id: "unread-needs-you", label: "Needs you", readState: "Unread", icon: "MessageQuestion" },
  { id: "unread", label: "Other chats", readState: "Unread", icon: "Mail" },
  { id: "unread-ready", label: "Ready to archive", readState: "Unread", icon: "Archive" },
  { id: "read-needs-you", label: "Needs you", readState: "Read", icon: "MessageQuestion" },
  { id: "unfinished", label: "Unfinished", readState: "Read", icon: "Circle" },
  { id: "ready", label: "Ready to archive", readState: "Read", icon: "Archive" },
  { id: "working", label: "Working", readState: null, icon: "Spinner" },
];

export function isAttentionGroup(group: GroupId) {
  return group === "unread-needs-you" || group === "read-needs-you";
}

const WORKING_STATUS = new Set([
  "starting",
  "active",
  "stopping",
  "provisioning",
  "waiting-for-host",
]);

function needsInput(thread: PluginSidebarThread, rowStatus: PluginSidebarThreadRowStatus | null) {
  return (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.queuedWork === "failed" ||
    rowStatus?.icon === "decisions/signpost"
  );
}

function isWorking(thread: PluginSidebarThread) {
  return (
    WORKING_STATUS.has(thread.runtimeStatus) ||
    WORKING_STATUS.has(thread.status) ||
    thread.queuedWork === "waiting" ||
    Object.values(thread.activity).some((count) => count > 0)
  );
}

export function chatGroup(
  thread: PluginSidebarThread,
  rowStatus: PluginSidebarThreadRowStatus | null,
): GroupId {
  if (needsInput(thread, rowStatus) || thread.indicator === "unread-error")
    return thread.isUnread ? "unread-needs-you" : "read-needs-you";

  // Unread output and stale archive marks cannot hide ongoing work.
  if (isWorking(thread)) return "working";

  if (rowStatus?.icon === "Archive" && rowStatus.label === "Ready to archive")
    return thread.isUnread ? "unread-ready" : "ready";

  return thread.isUnread ? "unread" : "unfinished";
}

export interface ChatNode {
  thread: PluginSidebarThread;
  children: ChatNode[];
  group: GroupId;
  needsInput: boolean;
  working: boolean;
  uncertain: boolean;
}

export function chatTree(
  threads: readonly PluginSidebarThread[],
  rowStatuses: ReadonlyMap<string, PluginSidebarThreadRowStatus>,
  workflowWorking: ReadonlySet<string> = new Set(),
  workflowUncertain: ReadonlySet<string> = new Set(),
) {
  const nodes = new Map<string, ChatNode>();
  const roots: ChatNode[] = [];

  for (const thread of threads) {
    if (thread.isHidden || thread.isArchived) continue;
    const rowStatus = rowStatuses.get(thread.id) ?? null;

    const mark =
      workflowUncertain.has(thread.id) && rowStatus?.icon === "Archive" ? null : rowStatus;

    nodes.set(thread.id, {
      thread,
      children: [],
      group: chatGroup(thread, mark),
      needsInput: needsInput(thread, mark),
      working: isWorking(thread) || workflowWorking.has(thread.id),
      uncertain: workflowUncertain.has(thread.id),
    });
  }

  for (const node of nodes.values()) {
    if (node.thread.parentThreadId === null) roots.push(node);
    else nodes.get(node.thread.parentThreadId)?.children.push(node);
  }

  const recentFirst = (a: ChatNode, b: ChatNode) =>
    b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
    b.thread.updatedAt - a.thread.updatedAt ||
    a.thread.id.localeCompare(b.thread.id);

  const classify = (node: ChatNode) => {
    node.children.sort(recentFirst);

    for (const child of node.children) classify(child);

    // Child replies are for the parent agent. Only blocked input and live work
    // affect the parent's section; unread child success/errors stay in its tree.
    node.needsInput ||= node.children.some((child) => child.needsInput);
    node.working ||= node.children.some((child) => child.working);
    node.uncertain ||= node.children.some((child) => child.uncertain);

    if (node.needsInput) node.group = node.thread.isUnread ? "unread-needs-you" : "read-needs-you";
    else if (!isAttentionGroup(node.group) && node.working) node.group = "working";
    else if (node.uncertain && (node.group === "ready" || node.group === "unread-ready"))
      node.group = node.thread.isUnread ? "unread" : "unfinished";
  };

  roots.sort(recentFirst);

  for (const root of roots) classify(root);

  return { roots, nodes };
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
    case "runtime":
    case "background-agent":
    case "background-command":
    case "goal":
    case "plan-mode":
    case "workflow":
    case "working-draft":
      return "Spinner";
    case "draft":
      return "Edit";
    default:
      return null;
  }
}
