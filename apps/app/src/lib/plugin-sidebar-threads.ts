import {
  projectThreadWork,
  queuedMessageWork,
  type ThreadListEntry,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk";
import { threadIndicatorLabel } from "./thread-indicator-label";
import {
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@omnyo/client-core";
import {
  EMPTY_TITLE_MENTION_RESOURCES,
  resolveThreadTitleDisplayText,
  type ThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { getThreadDisplayTitle } from "./thread-title";
import { getThreadRoutePath } from "./route-paths";
import { isThreadUnreadForAttention } from "./thread-unread-attention";
import {
  pendingChatHeldMessage,
  pendingChatPreview,
  type PendingChatHeldMessage,
  type PendingChatSnapshot,
} from "./pending-chat-creations";

const NO_ACTIVITY: PluginSidebarThread["activity"] = {
  workflows: 0,
  backgroundAgents: 0,
  backgroundCommands: 0,
  planMode: 0,
  goals: 0,
  experimental_subagents: 0,
};

const pendingSidebarThreads = new WeakMap<
  PendingChatSnapshot,
  PluginSidebarThread | null
>();

function pendingChatWork(
  chat: PendingChatSnapshot,
  failed: boolean,
  held: PendingChatHeldMessage | null,
): ThreadWorkSummary {
  const queued =
    failed || held === null
      ? null
      : queuedMessageWork(held, {
          threadId: chat.id,
          threadStatus: "idle",
          waitingForHost: false,
          hasRequiredInput: false,
          pluginAvailable: () => true,
          now: Date.now(),
        });

  return projectThreadWork({
    revision: `${chat.id}:${chat.status}:${held === null ? "starting" : "held"}`,
    basis: chat.id,
    activity: failed
      ? []
      : queued === null
        ? [
            {
              id: `${chat.id}:create`,
              kind: "turn",
              label: "Starting chat",
              phase: "running",
              actor: { kind: "agent", id: null, label: "Omnyo" },
            },
          ]
        : queued.kind === "activity"
          ? [queued.activity]
          : [],
    requiredInput: [],
    optionalInput: [],
    failures: failed
      ? [
          {
            code: "create-failed",
            text: "The chat could not start. Your messages were kept.",
            sourceId: null,
          },
        ]
      : [],
    waits: queued?.kind === "wait" ? [queued.wait] : [],
    coverageComplete: true,
    unknownReason: null,
    assessment: null,
    postponement: null,
    closed: false,
  });
}

function buildPendingSidebarThread(
  chat: PendingChatSnapshot,
): PluginSidebarThread | null {
  const { request, createdAt } = chat;

  if (request === null || createdAt === null || chat.realThreadId !== null)
    return null;

  if (chat.status !== "creating" && chat.status !== "failed") return null;
  const failed = chat.status === "failed";
  const preview = pendingChatPreview(request);
  const held = failed ? null : pendingChatHeldMessage(chat.id, request);
  const work = pendingChatWork(chat, failed, held);
  const status = failed ? "error" : held === null ? "starting" : "idle";

  const indicator = resolveThreadListIndicator({
    work,
    hasUnsubmittedDraft: false,
  });

  const pinned = request.pinned ?? false;

  return {
    experimental_work: work,
    id: chat.id,
    projectId: chat.projectId,
    title: null,
    titleFallback: preview,
    displayTitle: preview ?? "New chat",
    experimental_subtitle: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: request.sectionId ?? null,
    experimental_groupId: null,
    originKind: null,
    originPluginId: null,
    providerId: request.providerId,
    status,
    runtimeStatus: status,
    queuedWork: held === null ? "none" : "waiting",
    hasPendingInteraction: false,
    activity: NO_ACTIVITY,
    indicator,
    indicatorLabel: threadIndicatorLabel(indicator),
    isUnread: failed,
    isPinned: pinned,
    pinnedAt: pinned ? createdAt : null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    experimental_shelvedAt: null,
    experimental_shelfSortKey: null,
    href: getThreadRoutePath({ projectId: chat.projectId, threadId: chat.id }),
    isHidden: false,
    environment: null,
    host: null,
    createdAt,
    updatedAt: createdAt,
    lastReadAt: failed ? null : createdAt,
    latestAttentionAt: createdAt,
    lastMessageAt: createdAt,
  };
}

export function toPendingSidebarThread(
  chat: PendingChatSnapshot,
): PluginSidebarThread | null {
  const cached = pendingSidebarThreads.get(chat);

  if (cached !== undefined) return cached;
  const thread = buildPendingSidebarThread(chat);
  pendingSidebarThreads.set(chat, thread);

  return thread;
}

export function toPluginSidebarThread(
  entry: ThreadListEntry,
  hostNamesById: ReadonlyMap<string, string> = new Map(),
  titleResources: ThreadTitleMentionResources = EMPTY_TITLE_MENTION_RESOURCES,
): PluginSidebarThread {
  const indicator = resolveThreadListIndicator(
    threadListIndicatorStateForThread(entry, false),
  );

  return {
    experimental_attention: entry.attention,
    experimental_work: entry.work ?? null,
    id: entry.id,
    projectId: entry.projectId,
    title: entry.title,
    titleFallback: entry.titleFallback,
    displayTitle: resolveThreadTitleDisplayText(
      getThreadDisplayTitle(entry),
      titleResources,
    ),
    experimental_subtitle: null,
    parentThreadId: entry.parentThreadId,
    lifecycleOwnerThreadId: entry.lifecycleOwnerThreadId,
    sourceThreadId: entry.sourceThreadId,
    sectionId: entry.sectionId,
    experimental_groupId: entry.groupId,
    originKind: entry.originKind,
    originPluginId: entry.originPluginId,
    providerId: entry.providerId,
    status: entry.status,
    runtimeStatus: entry.runtime.displayStatus,
    queuedWork: entry.queuedWork,
    hasPendingInteraction: entry.hasPendingInteraction,
    activity: {
      workflows: entry.activity.activeWorkflowCount,
      backgroundAgents: entry.activity.activeBackgroundAgentCount,
      backgroundCommands: entry.activity.activeBackgroundCommandCount,
      planMode: entry.activity.activePlanModeCount,
      goals: entry.activity.activeGoalCount,
      experimental_subagents: entry.activity.activeSubagentCount,
    },
    indicator,
    indicatorLabel: threadIndicatorLabel(indicator),
    isUnread: isThreadUnreadForAttention(entry),
    isPinned: entry.pinnedAt !== null,
    pinnedAt: entry.pinnedAt,
    pinSortKey: entry.pinSortKey,
    isArchived: entry.archivedAt !== null,
    archivedAt: entry.archivedAt,
    experimental_shelvedAt: entry.shelvedAt,
    experimental_shelfSortKey: entry.shelfSortKey,
    href: getThreadRoutePath({
      projectId: entry.projectId,
      threadId: entry.id,
    }),
    isHidden: entry.visibility === "hidden",
    environment:
      entry.environmentId === null
        ? null
        : {
            id: entry.environmentId,
            name: entry.environmentName,
            branchName: entry.environmentBranchName,
            path: entry.environmentPath,
            isWorktree: entry.environmentIsWorktree,
            providerId: entry.environmentProviderId,
            workspaceDisplayKind: entry.environmentWorkspaceDisplayKind,
          },
    host:
      entry.environmentHostId === null
        ? null
        : {
            id: entry.environmentHostId,
            name:
              hostNamesById.get(entry.environmentHostId) ??
              entry.environmentHostId,
          },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastReadAt: entry.lastReadAt,
    latestAttentionAt: entry.latestAttentionAt,
    lastMessageAt: entry.lastMessageAt,
  };
}
