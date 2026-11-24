import { readThreadServiceTier } from "./thread-session-options.js";
import { getLastExecutionOptions } from "./thread-events.js";
import {
  buildThreadWorkSummaries,
  type ResolveThreadWorkSources,
} from "./thread-work.js";
import {
  getEnvironment,
  readThreadAttentionFacts,
  summarizeThreadAttention,
  getSessionById,
  listActiveBackgroundTaskCountsByThreadIds,
  listLatestClosedSessionsForHosts,
  listLatestThreadStateEventRowsByThreadIds,
  listOpenTurnInputAcceptedRowsByThreadIds,
  listStoredClientTurnRequestRowsByKeys,
  listThreadsWithPendingInteractionState,
  listThreadsWithUpdateActivity,
  type DbConnection,
  type RunningThreadRow,
  type StoredEventRow,
  type ThreadClientTurnRequestKey,
  type ThreadWithPendingInteractionState,
} from "@omnyo/db";
import { LEGACY_CODEX_GOAL_EXTENSION_KIND } from "@omnyo/domain";
import type {
  Thread,
  ThreadActivityState,
  ThreadChangeMetadata,
  ThreadListEntry,
  ThreadQueuedWork,
  ThreadRuntimeState,
  ThreadStatus,
  ThreadWithRuntime,
} from "@omnyo/domain";
import {
  extractThreadTimelineActivePlanTurn,
  extractThreadTimelineGoal,
  type ThreadEventWithMeta,
} from "@omnyo/thread-view";
import type { ThreadResponse } from "@omnyo/server-contract";
import type { NotificationHub } from "../../ws/hub.js";
import { isHostDisconnectHidden } from "../hosts/host-disconnect-display.js";
import { resolveProviderPlanCommand } from "../providers/provider-plan-command.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { listQueuedThreadMessageCountsByThreadIds } from "@omnyo/db";
import { resolveEnvironmentWorkspaceDisplayKind } from "../environments/environment-response.js";
import { canThreadSpawnChild } from "./thread-parent.js";
import { canRestoreThreadEnvironment } from "./thread-environment-restore.js";
import { toThreadEventWithMeta } from "./timeline.js";
import { intendedThreadHostId } from "./dispatch-attempt.js";

type ThreadRuntimeDisplayHub = Pick<
  NotificationHub,
  "getDaemonSessionIdForHost"
>;

interface ThreadRuntimeDisplayDeps {
  db: DbConnection;
  hub: ThreadRuntimeDisplayHub;
  providerRegistry?: ProviderRegistryService;
}

interface ThreadPromptBannerDeps extends ThreadRuntimeDisplayDeps {
  providerRegistry: ProviderRegistryService;
}

interface ResolveThreadRuntimeStateArgs {
  environmentHostId: string | null;
  now?: number;
  status: ThreadStatus;
}

interface ToThreadResponseFromThreadArgs {
  now?: number;
  thread: Thread;
}

interface ToThreadResponseWithHostArgs extends ToThreadResponseFromThreadArgs {
  environmentHostId: string | null;
}

interface ToThreadListEntryResponsesArgs {
  now?: number;
  threads: readonly ThreadWithPendingInteractionState[];
}

interface ToThreadListEntryResponseArgs {
  activity: ThreadActivityState;
  waitingForHost: boolean;
  queuedWork: ThreadQueuedWork;
  thread: ThreadWithPendingInteractionState;
}

interface BuildThreadStatusChangeMetadataByThreadIdArgs {
  environmentHostId: string;
  threads: readonly Thread[];
}

interface ToThreadStatusChangeMetadataArgs {
  activity: ThreadActivityState;
  runtime: ThreadRuntimeState;
  thread: Thread;
}

interface PromptBannerActivityState extends Pick<
  ThreadActivityState,
  "activeGoalCount" | "activePlanModeCount"
> {
  activePlanTurnId: string | null;
}

const EMPTY_THREAD_ACTIVITY: ThreadActivityState = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeSubagentCount: 0,
  activeWorkflowCount: 0,
};

function threadStatusRuntimeState(status: ThreadStatus): ThreadRuntimeState {
  switch (status) {
    case "pending":
    case "starting":
    case "idle":
    case "active":
    case "stopping":
    case "error":
      return { displayStatus: status };
  }
}

function hasOpenDaemonSessionForHost(
  deps: ThreadRuntimeDisplayDeps,
  hostId: string,
): boolean {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);

  if (!sessionId) {
    return false;
  }

  const session = getSessionById(deps.db, { sessionId });

  return session?.hostId === hostId && session.status === "active";
}

function toPublicThread(thread: Thread): Thread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    providerId: thread.providerId,
    claudeProfileBinding: thread.claudeProfileBinding,
    title: thread.title,
    titleFallback: thread.titleFallback,
    sectionId: thread.sectionId,
    groupId: thread.groupId,
    status: thread.status,
    parentThreadId: thread.parentThreadId,
    sourceThreadId: thread.sourceThreadId,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId,
    originKind: thread.originKind,
    originPluginId: thread.originPluginId,
    visibility: thread.visibility,
    pluginHome: thread.pluginHome,
    quiet: thread.quiet,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    shelvedAt: thread.shelvedAt,
    deletedAt: thread.deletedAt,
    lastReadAt: thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
    lastMessageAt: thread.lastMessageAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function resolveThreadRuntimeState(
  deps: ThreadRuntimeDisplayDeps,
  args: ResolveThreadRuntimeStateArgs,
): ThreadRuntimeState {
  const waitingForHost =
    args.status === "active" &&
    args.environmentHostId !== null &&
    waitingThreadHostIds(deps, [args.environmentHostId], args.now).has(
      args.environmentHostId,
    );

  return threadRuntimeState(args.status, waitingForHost);
}

function threadRuntimeState(
  status: ThreadStatus,
  waitingForHost: boolean,
): ThreadRuntimeState {
  return status === "active" && waitingForHost
    ? { displayStatus: "waiting-for-host" }
    : threadStatusRuntimeState(status);
}

function waitingThreadHostIds(
  deps: ThreadRuntimeDisplayDeps,
  hostIds: Iterable<string>,
  now = Date.now(),
): Set<string> {
  const disconnected = new Set(
    [...new Set(hostIds)].filter(
      (hostId) => !hasOpenDaemonSessionForHost(deps, hostId),
    ),
  );

  for (const session of listLatestClosedSessionsForHosts(deps.db, {
    hostIds: [...disconnected],
  })) {
    if (isHostDisconnectHidden(session, now))
      disconnected.delete(session.hostId);
  }

  return disconnected;
}

export function filterRunningThreadsByHost(
  deps: ThreadRuntimeDisplayDeps,
  rows: readonly RunningThreadRow[],
): RunningThreadRow[] {
  const waitingHosts = waitingThreadHostIds(
    deps,
    rows.flatMap((row) => (row.hostId === null ? [] : [row.hostId])),
  );

  return rows.filter(
    (row) => row.hostId === null || !waitingHosts.has(row.hostId),
  );
}

export function countRunningThreadsForAppUpdate(
  deps: ThreadRuntimeDisplayDeps,
): number {
  return filterRunningThreadsByHost(
    deps,
    listThreadsWithUpdateActivity(deps.db),
  ).length;
}

function resolveThreadEnvironmentHostId(
  deps: ThreadRuntimeDisplayDeps,
  thread: Thread,
): string | null {
  if (thread.environmentId === null) {
    return null;
  }

  return getEnvironment(deps.db, thread.environmentId)?.hostId ?? null;
}

export function buildThreadStatusChangeMetadata(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): ThreadChangeMetadata {
  return toThreadStatusChangeMetadata({
    activity:
      buildThreadActivityStateByThreadId(deps, [thread]).get(thread.id) ??
      EMPTY_THREAD_ACTIVITY,
    runtime: resolveThreadRuntimeState(deps, {
      environmentHostId: resolveThreadEnvironmentHostId(deps, thread),
      status: thread.status,
    }),
    thread,
  });
}

export function buildThreadStatusChangeMetadataByThreadId(
  deps: ThreadPromptBannerDeps,
  args: BuildThreadStatusChangeMetadataByThreadIdArgs,
): Map<string, ThreadChangeMetadata> {
  if (args.threads.length === 0) {
    return new Map();
  }

  const activityByThreadId = buildThreadActivityStateByThreadId(
    deps,
    args.threads,
  );

  const waitingForHost = waitingThreadHostIds(deps, [
    args.environmentHostId,
  ]).has(args.environmentHostId);

  return new Map(
    args.threads.map((thread) => [
      thread.id,
      toThreadStatusChangeMetadata({
        activity: activityByThreadId.get(thread.id) ?? EMPTY_THREAD_ACTIVITY,
        runtime: threadRuntimeState(thread.status, waitingForHost),
        thread,
      }),
    ]),
  );
}

function toThreadStatusChangeMetadata(
  args: ToThreadStatusChangeMetadataArgs,
): ThreadChangeMetadata {
  return {
    projectId: args.thread.projectId,
    statusChange: {
      status: args.thread.status,
      runtime: args.runtime,
      activity: args.activity,
      latestAttentionAt: args.thread.latestAttentionAt,
      lastMessageAt: args.thread.lastMessageAt,
      updatedAt: args.thread.updatedAt,
    },
  };
}

function toThreadResponseWithHost(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadResponseWithHostArgs,
): ThreadWithRuntime {
  const thread = toPublicThread(args.thread);

  return {
    ...thread,
    runtime: resolveThreadRuntimeState(deps, {
      environmentHostId: args.environmentHostId,
      now: args.now,
      status: thread.status,
    }),
  };
}

export function toThreadResponseFromThread(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadResponseFromThreadArgs,
): ThreadResponse {
  const threadWithRuntime = toThreadResponseWithHost(deps, {
    ...args,
    environmentHostId: resolveThreadEnvironmentHostId(deps, args.thread),
  });

  const background = listActiveBackgroundTaskCountsByThreadIds(deps.db, {
    threadIds: [args.thread.id],
  })[0];

  const banner =
    deps.providerRegistry === undefined
      ? EMPTY_THREAD_ACTIVITY
      : getThreadPromptBannerActivity(
          { ...deps, providerRegistry: deps.providerRegistry },
          args.thread,
        );

  const queue = listQueuedThreadMessageCountsByThreadIds(deps.db, {
    threadIds: [args.thread.id],
  })[0];

  const pending = listThreadsWithPendingInteractionState(deps.db, {
    threadIds: [args.thread.id],
    includeHidden: true,
  })[0];

  const work =
    buildThreadWorkSummaries(
      deps.db,
      [
        {
          ...threadWithRuntime,
          activity: {
            ...EMPTY_THREAD_ACTIVITY,
            activeGoalCount: banner.activeGoalCount,
            activePlanModeCount: banner.activePlanModeCount,
            activeWorkflowCount: background?.activeWorkflowCount ?? 0,
            activeBackgroundAgentCount:
              background?.activeBackgroundAgentCount ?? 0,
            activeBackgroundCommandCount:
              background?.activeBackgroundCommandCount ?? 0,
            activeSubagentCount: background?.activeSubagentCount ?? 0,
          },
          queuedWork:
            (queue?.failedQueuedMessageCount ?? 0) > 0
              ? "failed"
              : (queue?.queuedMessageCount ?? 0) > 0
                ? "waiting"
                : "none",
          hasPendingInteraction: pending?.hasPendingInteraction ?? false,
        },
      ],
      threadWorkSourceResolver(deps),
    ).get(args.thread.id) ?? null;

  return {
    ...threadWithRuntime,
    serviceTier:
      readThreadServiceTier(deps.db, args.thread.id) ??
      getLastExecutionOptions(deps, args.thread.id)?.serviceTier,
    work,
    activeBackgroundAgentCount: background?.activeBackgroundAgentCount ?? 0,
    canRestoreEnvironment: canRestoreThreadEnvironment(deps, {
      thread: args.thread,
    }),
    canSpawnChild: canThreadSpawnChild(deps, { thread: args.thread }),
    queuedMessageCount: queue?.queuedMessageCount ?? 0,
  };
}

function getThreadPromptBannerActivityState(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
  events: readonly ThreadEventWithMeta[],
): PromptBannerActivityState {
  const activePlanTurn = extractThreadTimelineActivePlanTurn({
    events,
    planCommand: resolveProviderPlanCommand(
      deps.providerRegistry,
      thread.providerId,
    ),
    providerId: thread.providerId,
    threadStatus: thread.status,
  });

  const goal = extractThreadTimelineGoal(events);

  return {
    activeGoalCount: goal?.status === "active" ? 1 : 0,
    activePlanModeCount: activePlanTurn === null ? 0 : 1,
    activePlanTurnId: activePlanTurn?.turnId ?? null,
  };
}

function canThreadShowActivePlanMode(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): boolean {
  return (
    thread.status === "active" &&
    resolveProviderPlanCommand(deps.providerRegistry, thread.providerId) !==
      null
  );
}

function listPromptBannerActivityCandidateRows(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): StoredEventRow[] {
  const latestGoalRows = listLatestThreadStateEventRowsByThreadIds(deps.db, {
    threadIds: threads.map((thread) => thread.id),
    kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
  });

  const openAcceptedRows = listOpenTurnInputAcceptedRowsByThreadIds(deps.db, {
    threadIds: threads
      .filter((thread) => canThreadShowActivePlanMode(deps, thread))
      .map((thread) => thread.id),
  });

  const openAcceptedEvents = openAcceptedRows.map(toThreadEventWithMeta);

  const requestKeys: ThreadClientTurnRequestKey[] = openAcceptedEvents.flatMap(
    ({ event, meta }) =>
      event.type === "turn/input/accepted"
        ? [
            {
              beforeSequence: meta.seq,
              requestId: event.clientRequestId,
              threadId: event.threadId,
            },
          ]
        : [],
  );

  const requestRows = listStoredClientTurnRequestRowsByKeys(deps.db, {
    keys: requestKeys,
  });

  return [...latestGoalRows, ...openAcceptedRows, ...requestRows].sort(
    (left, right) =>
      left.threadId.localeCompare(right.threadId) ||
      left.sequence - right.sequence,
  );
}

function buildThreadPromptBannerActivityByThreadId(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): Map<string, PromptBannerActivityState> {
  const rows = listPromptBannerActivityCandidateRows(deps, threads);
  const eventsByThreadId = new Map<string, ThreadEventWithMeta[]>();

  for (const row of rows) {
    const threadEvents = eventsByThreadId.get(row.threadId);
    const event = toThreadEventWithMeta(row);

    if (threadEvents) {
      threadEvents.push(event);
    } else {
      eventsByThreadId.set(row.threadId, [event]);
    }
  }

  const result = new Map<string, PromptBannerActivityState>();

  for (const thread of threads) {
    const activity = getThreadPromptBannerActivityState(
      deps,
      thread,
      eventsByThreadId.get(thread.id) ?? [],
    );

    if (activity.activeGoalCount > 0 || activity.activePlanModeCount > 0) {
      result.set(thread.id, activity);
    }
  }

  return result;
}

export function getThreadPromptBannerActivity(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): PromptBannerActivityState {
  return (
    buildThreadPromptBannerActivityByThreadId(deps, [thread]).get(
      thread.id,
    ) ?? {
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activePlanTurnId: null,
    }
  );
}

function buildThreadActivityStateByThreadId(
  deps: ThreadRuntimeDisplayDeps,
  threads: readonly Thread[],
): Map<string, ThreadActivityState> {
  const backgroundTaskActivityByThreadId = new Map(
    listActiveBackgroundTaskCountsByThreadIds(deps.db, {
      threadIds: threads.map((thread) => thread.id),
    }).map((activity) => [activity.threadId, activity]),
  );

  const { providerRegistry } = deps;

  const promptBannerActivityByThreadId =
    providerRegistry === undefined
      ? new Map<string, PromptBannerActivityState>()
      : buildThreadPromptBannerActivityByThreadId(
          { ...deps, providerRegistry },
          threads,
        );

  const result = new Map<string, ThreadActivityState>();

  for (const thread of threads) {
    const backgroundActivity = backgroundTaskActivityByThreadId.get(thread.id);
    const promptBannerActivity = promptBannerActivityByThreadId.get(thread.id);

    if (!backgroundActivity && !promptBannerActivity) {
      continue;
    }

    result.set(thread.id, {
      activeBackgroundAgentCount:
        backgroundActivity?.activeBackgroundAgentCount ??
        EMPTY_THREAD_ACTIVITY.activeBackgroundAgentCount,
      activeBackgroundCommandCount:
        backgroundActivity?.activeBackgroundCommandCount ??
        EMPTY_THREAD_ACTIVITY.activeBackgroundCommandCount,
      activeGoalCount:
        promptBannerActivity?.activeGoalCount ??
        EMPTY_THREAD_ACTIVITY.activeGoalCount,
      activePlanModeCount:
        promptBannerActivity?.activePlanModeCount ??
        EMPTY_THREAD_ACTIVITY.activePlanModeCount,
      activeSubagentCount:
        backgroundActivity?.activeSubagentCount ??
        EMPTY_THREAD_ACTIVITY.activeSubagentCount,
      activeWorkflowCount:
        backgroundActivity?.activeWorkflowCount ??
        EMPTY_THREAD_ACTIVITY.activeWorkflowCount,
    });
  }

  return result;
}

function buildThreadQueuedWorkByThreadId(
  deps: ThreadRuntimeDisplayDeps,
  threads: readonly Thread[],
): Map<string, ThreadQueuedWork> {
  const result = new Map<string, ThreadQueuedWork>();

  for (const counts of listQueuedThreadMessageCountsByThreadIds(deps.db, {
    threadIds: threads.map((thread) => thread.id),
  })) {
    if (counts.queuedMessageCount === 0) continue;
    result.set(
      counts.threadId,
      counts.failedQueuedMessageCount > 0 ? "failed" : "waiting",
    );
  }

  return result;
}

function threadWorkSourceResolver(
  deps: ThreadRuntimeDisplayDeps,
): ResolveThreadWorkSources {
  return (threadIds) => {
    const { entries, attentionFacts } = buildThreadListEntriesWithoutWork(
      deps,
      {
        threads: listThreadsWithPendingInteractionState(deps.db, {
          threadIds: [...threadIds],
          includeHidden: true,
        }),
      },
    );

    return { sources: entries, attentionFacts };
  };
}

export function toThreadListEntryResponses(
  deps: ThreadPromptBannerDeps,
  args: ToThreadListEntryResponsesArgs,
): ThreadListEntry[] {
  const { entries, attentionFacts } = buildThreadListEntriesWithoutWork(
    deps,
    args,
  );

  const summaries = buildThreadWorkSummaries(
    deps.db,
    entries,
    threadWorkSourceResolver(deps),
    attentionFacts,
  );

  return entries.map((entry) => ({
    ...entry,
    work: summaries.get(entry.id) ?? null,
  }));
}

function buildThreadListEntriesWithoutWork(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadListEntryResponsesArgs,
): {
  entries: ThreadListEntry[];
  attentionFacts: ReturnType<typeof readThreadAttentionFacts>;
} {
  const ids = args.threads.map((thread) => thread.id);
  const attentionFacts = readThreadAttentionFacts(deps.db, ids);
  const attention = summarizeThreadAttention(attentionFacts);

  const activityByThreadId = buildThreadActivityStateByThreadId(
    deps,
    args.threads,
  );

  const waitingHosts = waitingThreadHostIds(
    deps,
    args.threads.flatMap((thread) =>
      thread.status === "active" && thread.environmentHostId !== null
        ? [thread.environmentHostId]
        : [],
    ),
    args.now,
  );

  const queuedWorkByThreadId = buildThreadQueuedWorkByThreadId(
    deps,
    args.threads,
  );

  const entries = args.threads.map((thread) => {
    const entry = toThreadListEntryResponse({
      activity: activityByThreadId.get(thread.id) ?? EMPTY_THREAD_ACTIVITY,
      queuedWork: queuedWorkByThreadId.get(thread.id) ?? "none",
      waitingForHost:
        thread.environmentHostId !== null &&
        waitingHosts.has(thread.environmentHostId),
      thread,
    });

    entry.attention = attention.get(thread.id);

    return thread.environmentHostId === null &&
      (thread.status === "pending" || thread.status === "starting")
      ? {
          ...entry,
          environmentHostId: intendedThreadHostId(deps, thread.id),
        }
      : entry;
  });

  return { entries, attentionFacts };
}

export function buildThreadListEntry(
  deps: ThreadPromptBannerDeps,
  threadId: string,
): ThreadListEntry | null {
  const threads = listThreadsWithPendingInteractionState(deps.db, {
    threadIds: [threadId],
    includeHidden: true,
  });

  return toThreadListEntryResponses(deps, { threads })[0] ?? null;
}

function toThreadListEntryResponse(
  args: ToThreadListEntryResponseArgs,
): ThreadListEntry {
  const thread = toPublicThread(args.thread);

  return {
    ...thread,
    work: null,
    activity: args.activity,
    queuedWork: args.queuedWork,
    pinSortKey: args.thread.pinSortKey,
    shelfSortKey: args.thread.shelfSortKey,
    environmentBranchName: args.thread.environmentBranchName,
    environmentHostId: args.thread.environmentHostId,
    environmentName: args.thread.environmentName,
    environmentPath: args.thread.environmentPath,
    environmentProviderId: args.thread.environmentProviderId,
    environmentIsWorktree: args.thread.environmentIsWorktree,
    environmentWorkspaceDisplayKind: resolveEnvironmentWorkspaceDisplayKind({
      environmentProviderId: args.thread.environmentProviderId,
      isWorktree: args.thread.environmentIsWorktree,
    }),
    hasPendingInteraction: args.thread.hasPendingInteraction,
    runtime: threadRuntimeState(thread.status, args.waitingForHost),
  };
}
