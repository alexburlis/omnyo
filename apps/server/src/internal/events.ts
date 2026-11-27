import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  appendDaemonEventsInTransaction,
  appendRetainedDaemonEventsInTransaction,
  deriveStoredEventItemFields,
  getThread,
  findLastRootStoredTurnStarted,
  getLastStoredTurnRequestEvent,
  listActiveBackgroundTaskCountsByThreadIds,
  listStoredTurnCompletedKeys,
  listThreadEnvironmentAssignmentsOnHost,
  MissingStoredTurnStartedError,
  PrimaryWriteBusyError,
  readDaemonEventReceiptIndex,
  recordDaemonEventReceipt,
  runImmediateTransactionWithBusyWait,
  events as storedEvents,
} from "@omnyo/db";
import type {
  AcceptedDaemonEvent,
  AppendDaemonEventInput,
  AppendDaemonEventsResult,
  DaemonEventReceiptKey,
  DbTransaction,
} from "@omnyo/db";
import {
  hostDaemonEventBatchRequestSchema,
  ungroupHostDaemonEvents,
  typedRoutes,
  type HostDaemonEventBatchResponse,
  type HostDaemonEventEnvelope,
  type HostDaemonInternalSchema,
  type HostDaemonRejectedEvent,
} from "@omnyo/host-daemon-contract";
import {
  maskProviderEnvironmentEvent,
  THREAD_SESSION_OPTIONS_STATE_KIND,
  requireThreadEventScopeTurnId,
  getThreadEventScopeTurnId,
  type ChildThreadOutcome,
  type ThreadEventType,
  type ThreadEventTurnStatus,
} from "@omnyo/domain";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  isActivePruneTriggerThreadEventType,
  maybePruneActiveThreadEventHistory,
} from "../services/system/event-pruning.js";
import { queueChildThreadTurnNotificationBestEffort } from "../services/threads/child-thread-notifications.js";
import { isParentNotifiableChildThread } from "../services/threads/thread-parent.js";
import {
  runQueuedMessageDispatch,
  type QueuedMessageDispatchWake,
} from "../services/threads/queued-message-dispatch.js";
import { deferAfterResponse } from "../services/lib/response-deferral.js";
import {
  isCommandTimeoutError,
  runtimeErrorLogFields,
} from "../services/lib/error-log-fields.js";
import { applyLoggedThreadLifecycleEvent } from "../services/threads/lifecycle-outcome.js";
import { parseStoredTurnRequestEvent } from "../services/threads/thread-events.js";
import { dropSettledThreadSessionOptionSelections } from "../services/threads/thread-session-options.js";
import { recordTurnGitActivity } from "../services/threads/turn-git-activity.js";
import { rejectUnstartedTurnRequest } from "../services/threads/unconfirmed-turn-requests.js";
import {
  applyTurnCompletedEvent,
  getTurnInterruption,
  readTurnCompletion,
} from "./turn-completed-events.js";
import { onTurnInputAccepted } from "../services/inbox/engine.js";
import { refreshMaintenanceCacheReadShare } from "../services/threads/maintenance-silence.js";
import {
  applyGeneratedThreadTitle,
  sanitizeGeneratedTitle,
} from "../services/threads/title-generation.js";
import {
  getInactiveSessionLogFields,
  requireAuthenticatedDaemonSession,
} from "./session-state.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { validateExtensionPayloads } from "./extension-payloads.js";
import { validatePresentationIcons } from "./presentation-icons.js";
import { observeTurnTraceEventBatch } from "../services/system/turn-trace.js";
import { advanceDaemonEventReceipt } from "../services/hosts/event-receipt-watermarks.js";
import { collectAfterCommit } from "../services/lib/after-commit.js";
import {
  isMaintenanceFrozen,
  isServerMoveSnapshotFenced,
  serverMovingError,
} from "../services/server-move/freeze-state.js";

const INGRESS_WRITE_BUSY_WAIT_MS = 125;

interface ToStoredEventArgs {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
}

interface ResolvePostableEventBatchEntriesArgs {
  hostId: string;
  events: HostDaemonEventEnvelope[];
}

interface PostableEventBatchEntry {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
  eventIndex: number;
}

interface ResolvePostableEventBatchEntriesResult {
  entries: PostableEventBatchEntry[];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

interface RejectedDaemonEventSummary {
  count: number;
  threadIds: string[];
}

interface ResolveEventsToApplyArgs {
  db: AppDeps["db"];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
  retainedDelivery: boolean;
}

interface EventEffectProgress {
  entry: HostDaemonEventEnvelope | null;
}

interface AppliedEventBatch {
  eventInputs: AppendDaemonEventInput[];
  postableEvents: HostDaemonEventEnvelope[];
  subagentCountsBefore: SubagentCounts;
  appendResult: AppendDaemonEventsResult;
  duplicateEvents: number;
  followUps: EventEffectFollowUp[];
}

interface NotifyInsertedEventThreadsDeps {
  db: AppDeps["db"];
  hub: AppDeps["hub"];
}

interface NotifyInsertedEventThreadsArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  eventInputs: AppendDaemonEventInput[];
  insertedInputIndexes: number[];
  reopenedInputIndexes: number[];
  subagentCountsBefore: SubagentCounts;
}

interface SubagentCounts {
  countByThreadId: ReadonlyMap<string, number>;
  threadIds: readonly string[];
}

function preserveTerminalProvisioningStatus(
  deps: Pick<AppDeps, "db">,
  entry: PostableEventBatchEntry,
): PostableEventBatchEntry {
  const event = entry.envelope.event;

  if (event.type !== "system/thread-provisioning") {
    return entry;
  }

  const latest = deps.db
    .select({
      status: sql<unknown>`json_extract(${storedEvents.data}, '$.status')`,
    })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, entry.envelope.threadId),
        eq(storedEvents.type, "system/thread-provisioning"),
        sql`json_extract(${storedEvents.data}, '$.provisioningId') = ${event.provisioningId}`,
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();

  const status = latest?.status;

  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return entry;
  }

  return {
    ...entry,
    envelope: {
      ...entry.envelope,
      event: { ...event, status },
    },
  };
}

function parseStoredBackgroundTaskItemStatus(data: string): string | undefined {
  const parsed: unknown = JSON.parse(data);

  if (parsed === null || typeof parsed !== "object" || !("item" in parsed)) {
    return undefined;
  }

  const item = parsed.item;

  if (item === null || typeof item !== "object" || !("status" in item)) {
    return undefined;
  }

  return typeof item.status === "string" ? item.status : undefined;
}

function eventInputChangesBackgroundActivity(
  input: AppendDaemonEventInput,
): boolean {
  if (input.itemKind !== "backgroundTask") {
    return false;
  }

  if (
    input.type === "item/started" ||
    input.type === "item/backgroundTask/completed"
  ) {
    return true;
  }

  if (input.type !== "item/backgroundTask/progress") {
    return false;
  }

  try {
    return parseStoredBackgroundTaskItemStatus(input.data) !== "pending";
  } catch {
    return false;
  }
}

function eventInputMayChangeSubagents(input: AppendDaemonEventInput): boolean {
  switch (input.type) {
    case "turn/started":
    case "turn/completed":
    case "item/delegation/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
      return true;
    case "item/started":
    case "item/completed":
      return (
        input.itemKind === "delegation" || input.itemKind === "backgroundTask"
      );
    default:
      return false;
  }
}

function readSubagentCounts(
  db: AppDeps["db"],
  threadIds: readonly string[],
): SubagentCounts {
  return {
    countByThreadId: new Map(
      threadIds.length === 0
        ? []
        : listActiveBackgroundTaskCountsByThreadIds(db, { threadIds }).map(
            (row) => [row.threadId, row.activeSubagentCount],
          ),
    ),
    threadIds,
  };
}

function listSubagentCountChangedThreadIds(
  before: SubagentCounts,
  after: SubagentCounts,
): string[] {
  return before.threadIds.filter(
    (threadId) =>
      (before.countByThreadId.get(threadId) ?? 0) !==
      (after.countByThreadId.get(threadId) ?? 0),
  );
}

interface ShouldApplyEventEffectArgs {
  completedTurnKeyLookup: Set<string>;
  entry: HostDaemonEventEnvelope;
  index: number;
  insertedEventIndexLookup: Set<number>;
}

interface ListCompletedTurnKeysForStartedEventsArgs {
  batchEvents: HostDaemonEventEnvelope[];
  db: AppDeps["db"];
  insertedEventIndexLookup: ReadonlySet<number>;
}

interface TurnKeyArgs {
  threadId: string;
  turnId: string;
}

interface HasThreadCommandFailureSystemErrorForTurnDeps {
  db: AppDeps["db"];
}

interface HasThreadCommandFailureSystemErrorForTurnArgs {
  threadId: string;
  turnId: string;
}

interface HasThreadStopBeforeTurnStartedArgs {
  threadId: string;
  turnId: string;
}

interface ActivePruneCandidate {
  latestPrunableSequence: number;
  threadId: string;
}

interface ResolveActivePruneCandidatesArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

interface AddParentTurnNotificationFollowUpArgs {
  failedParentNotificationThreadIds: Set<string>;
  followUps: EventEffectFollowUp[];
  thread: NonNullable<ReturnType<typeof getThread>>;
  turnStatus: ThreadEventTurnStatus;
  interruption?: ChildThreadOutcome["interruption"];
}

interface ParentTurnNotificationFollowUp {
  kind: "parent-turn-notification";
  childThreadId: string;
  projectId: string;
  parentThreadId: string;
  title: string | null;
  turnStatus: ThreadEventTurnStatus;
  interruption?: ChildThreadOutcome["interruption"];
}

interface QueuedMessageDispatchFollowUp {
  kind: "queued-message-dispatch";
  wake: Extract<
    QueuedMessageDispatchWake,
    { kind: "thread-ready" } | { kind: "turn-started" }
  >;
}

interface TurnGitActivityFollowUp {
  kind: "turn-git-activity";
  threadId: string;
  turnId: string;
}

type EventEffectFollowUp =
  | ParentTurnNotificationFollowUp
  | QueuedMessageDispatchFollowUp
  | TurnGitActivityFollowUp;

function isRootTurnStartedEvent(
  event: Extract<HostDaemonEventEnvelope["event"], { type: "turn/started" }>,
): boolean {
  return !event.parentToolCallId;
}

function resolveProviderIdentifiers(event: HostDaemonEventEnvelope["event"]): {
  providerThreadId: string | null;
} {
  switch (event.type) {
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/interaction/lifecycle":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/git-activity":
    case "system/provider-turn-watchdog":
      return { providerThreadId: null };
    case "thread/identity":
    case "thread/name/updated":
    case "provider/warning":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
    case "provider.env-resolved":
    case "thread/compacted":
    case "thread/context/cleared":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "thread/extensionState/updated":
    case "turn/started":
    case "turn/completed":
    case "turn/input/accepted":
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "thread/contextWindowUsage/updated":
    case "thread/tokenUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "turn/mainRun/updated":
    case "provider/error":
    case "provider/unhandled":
      return { providerThreadId: event.providerThreadId };
    default: {
      const exhaustive: never = event;
      throw new Error(
        `Unsupported event type: ${String((exhaustive as { type?: string }).type)}`,
      );
    }
  }
}

function toStoredEvent(args: ToStoredEventArgs): AppendDaemonEventInput {
  const envelope = args.envelope;
  const { scope, type, threadId, ...data } = envelope.event;

  return {
    threadId: envelope.threadId,
    environmentId: args.environmentId,
    ...resolveProviderIdentifiers(envelope.event),
    scope,
    type,
    ...deriveStoredEventItemFields(envelope.event),
    data: JSON.stringify(data),
  };
}

function notifyInsertedEventThreads(
  deps: NotifyInsertedEventThreadsDeps,
  args: NotifyInsertedEventThreadsArgs,
): void {
  const appendedEventsByThreadId = new Map<
    string,
    {
      eventTypes: Set<ThreadEventType>;
      timelineSequence: number;
      firstSequence: number;
      count: number;
    }
  >();

  const unknownCoverageThreadIds = new Set<string>();
  const reopenedInputIndexes = new Set(args.reopenedInputIndexes);

  const backgroundActivityThreadIds = new Set<string>(
    listSubagentCountChangedThreadIds(
      args.subagentCountsBefore,
      readSubagentCounts(deps.db, args.subagentCountsBefore.threadIds),
    ),
  );

  for (const [acceptedIndex, acceptedEvent] of args.acceptedEvents.entries()) {
    const inputIndex = args.insertedInputIndexes[acceptedIndex];

    const eventInput =
      inputIndex === undefined ? undefined : args.eventInputs[inputIndex];

    if (eventInput?.threadId === acceptedEvent.threadId) {
      const appendedEvents = appendedEventsByThreadId.get(
        eventInput.threadId,
      ) ?? {
        eventTypes: new Set<ThreadEventType>(),
        timelineSequence: acceptedEvent.sequence,
        firstSequence: acceptedEvent.sequence,
        count: 0,
      };

      appendedEvents.eventTypes.add(eventInput.type);
      appendedEvents.timelineSequence = Math.max(
        appendedEvents.timelineSequence,
        acceptedEvent.sequence,
      );
      appendedEvents.firstSequence = Math.min(
        appendedEvents.firstSequence,
        acceptedEvent.sequence,
      );
      appendedEvents.count += 1;
      appendedEventsByThreadId.set(eventInput.threadId, appendedEvents);

      if (
        eventInputChangesBackgroundActivity(eventInput) ||
        (inputIndex !== undefined && reopenedInputIndexes.has(inputIndex))
      ) {
        backgroundActivityThreadIds.add(eventInput.threadId);
      }
    } else {
      unknownCoverageThreadIds.add(acceptedEvent.threadId);
    }
  }

  for (const [
    threadId,
    { eventTypes, timelineSequence, firstSequence, count },
  ] of appendedEventsByThreadId) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      ...(backgroundActivityThreadIds.has(threadId)
        ? { backgroundActivityChanged: true }
        : {}),
      eventTypes: Array.from(eventTypes),
      timelineSequence,
      ...(!unknownCoverageThreadIds.has(threadId) &&
      timelineSequence - firstSequence + 1 === count
        ? {
            eventSequenceRange: {
              from: firstSequence,
              to: timelineSequence,
            },
          }
        : {}),
    });
  }
}

function addParentTurnNotificationFollowUp(
  args: AddParentTurnNotificationFollowUpArgs,
): void {
  if (!isParentNotifiableChildThread(args.thread)) {
    return;
  }

  if (args.turnStatus === "failed") {
    if (args.failedParentNotificationThreadIds.has(args.thread.id)) {
      return;
    }

    args.failedParentNotificationThreadIds.add(args.thread.id);
  }

  args.followUps.push({
    kind: "parent-turn-notification",
    childThreadId: args.thread.id,
    projectId: args.thread.projectId,
    parentThreadId: args.thread.parentThreadId,
    title: args.thread.title,
    turnStatus: args.turnStatus,
    ...(args.interruption ? { interruption: args.interruption } : {}),
  });
}

function applyEventEffects(
  deps: LoggedPendingInteractionWorkSessionDeps,
  events: HostDaemonEventEnvelope[],
  retainedDelivery: boolean,
  progress: EventEffectProgress,
): EventEffectFollowUp[] {
  const followUps: EventEffectFollowUp[] = [];
  const failedParentNotificationThreadIds = new Set<string>();

  for (const entry of events) {
    progress.entry = entry;
    const event = entry.event;

    if (
      retainedDelivery &&
      (event.type === "turn/completed" ||
        (event.type === "system/error" &&
          event.code === "provider_process_exited"))
    ) {
      const latestTurn = findLastRootStoredTurnStarted(deps.db, {
        threadId: entry.threadId,
      });

      const eventTurnId = getThreadEventScopeTurnId(event.scope);
      const currentThread = getThread(deps.db, entry.threadId);

      const latestRequest =
        currentThread?.status === "starting"
          ? getLastStoredTurnRequestEvent(deps.db, entry.threadId)
          : null;

      if (event.type === "system/error" && eventTurnId === undefined) {
        if (
          event.requestId === undefined ||
          currentThread?.status !== "starting" ||
          latestRequest === null ||
          parseStoredTurnRequestEvent(latestRequest).requestId !==
            event.requestId
        ) {
          continue;
        }
      } else if (
        latestTurn !== null &&
        (latestTurn.turnId !== eventTurnId ||
          (latestRequest !== null &&
            latestRequest.sequence > latestTurn.sequence))
      ) {
        continue;
      }
    }

    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });

      if (
        hasThreadStopBeforeTurnStarted(deps, {
          threadId: entry.threadId,
          turnId,
        })
      ) {
        continue;
      }

      if (!isRootTurnStartedEvent(event)) {
        continue;
      }

      followUps.push({
        kind: "queued-message-dispatch",
        wake: { kind: "turn-started", threadId: entry.threadId },
      });

      if (hasThreadAlreadyStartedRun(deps, entry.threadId)) {
        continue;
      }

      applyLoggedThreadLifecycleEvent(deps, {
        event: { type: "run.started" },
        threadId: entry.threadId,
      });
      continue;
    }

    if (event.type === "turn/input/accepted") {
      const turnId = getThreadEventScopeTurnId(event.scope);

      if (turnId !== undefined)
        deps.db.transaction(
          (tx) =>
            onTurnInputAccepted(tx, {
              threadId: entry.threadId,
              requestId: event.clientRequestId,
              turnId,
              now: Date.now(),
            }),
          { behavior: "immediate" },
        );

      continue;
    }

    if (event.type === "thread/name/updated") {
      if (event.source === "agent") {
        const title = sanitizeGeneratedTitle(event.threadName);

        if (title !== null) {
          applyGeneratedThreadTitle(deps, {
            threadId: entry.threadId,
            title,
          });
        }
      }

      continue;
    }

    if (event.type === "thread/extensionState/updated") {
      if (event.kind === THREAD_SESSION_OPTIONS_STATE_KIND) {
        dropSettledThreadSessionOptionSelections(deps, {
          threadId: entry.threadId,
          environmentId:
            getThread(deps.db, entry.threadId)?.environmentId ?? null,
        });
      }

      continue;
    }

    if (event.type === "thread/tokenUsage/updated") {
      refreshMaintenanceCacheReadShare(deps.db, entry.threadId);
      continue;
    }

    if (event.type === "turn/mainRun/updated") {
      if (event.state === "idle") {
        followUps.push({
          kind: "queued-message-dispatch",
          wake: { kind: "thread-ready", threadId: entry.threadId },
        });
      }

      continue;
    }

    if (event.type === "turn/completed") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });

      if (
        event.status !== "interrupted" &&
        hasThreadStopBeforeTurnStarted(deps, {
          threadId: entry.threadId,
          turnId,
        })
      ) {
        continue;
      }

      const payload = { ...event, threadId: entry.threadId };

      const { isRootTurnCompletion, thread } = readTurnCompletion(
        deps,
        payload,
      );

      if (!thread || !isRootTurnCompletion) {
        continue;
      }

      const idleFollowUp: QueuedMessageDispatchFollowUp | null =
        event.status === "completed"
          ? {
              kind: "queued-message-dispatch",
              wake: { kind: "thread-ready", threadId: entry.threadId },
            }
          : null;

      const transition = applyTurnCompletedEvent(deps, {
        afterIdle:
          idleFollowUp === null
            ? null
            : () => executeEventFollowUpBestEffort(deps, idleFollowUp),
        payload,
      });

      followUps.push({
        kind: "turn-git-activity",
        threadId: entry.threadId,
        turnId,
      });

      if (event.providerThreadId !== null) {
        const providerId = thread.providerId;
        const providerThreadId = event.providerThreadId;

        const requests = deps.pendingInteractions
          .listPendingThreadInteractions(entry.threadId)
          .flatMap((interaction) =>
            "providerId" in interaction &&
            interaction.providerId === providerId &&
            interaction.providerThreadId === providerThreadId &&
            interaction.turnId === turnId &&
            interaction.providerRequestId !== null
              ? [
                  {
                    interactionId: interaction.id,
                    threadId: entry.threadId,
                    turnId,
                    providerThreadId,
                    providerRequestId: interaction.providerRequestId,
                  },
                ]
              : [],
          );

        if (requests.length > 0)
          deps.pendingInteractions.interruptPendingInteractionsForThreads({
            providerId,
            threadIds: [entry.threadId],
            requests,
            reason:
              "Provider turn ended while awaiting user interaction; execution outcome is unknown",
          });
      }

      if (isParentNotifiableChildThread(thread)) {
        const alreadyHandledByCommandFailure =
          event.status === "failed" &&
          hasThreadCommandFailureSystemErrorForTurn(deps, {
            threadId: thread.id,
            turnId,
          });

        const interruption =
          event.status === "interrupted"
            ? getTurnInterruption(deps, {
                threadId: thread.id,
                turnId,
              })
            : undefined;

        const manuallyStopped =
          interruption?.reason === "manual-stop" ||
          interruption?.reason === "app-update" ||
          (event.status === "interrupted" &&
            wasTurnManuallyStopped(deps, {
              threadId: thread.id,
              turnId,
            }));

        if (!alreadyHandledByCommandFailure && !manuallyStopped) {
          addParentTurnNotificationFollowUp({
            failedParentNotificationThreadIds,
            followUps,
            thread,
            turnStatus: event.status,
            ...(interruption ? { interruption } : {}),
          });
        }
      }

      if (
        idleFollowUp !== null &&
        transition.kind === "settled" &&
        transition.nextStatus === "idle"
      ) {
        followUps.push(idleFollowUp);
      }

      continue;
    }

    if (
      event.type === "system/error" &&
      (event.code === "provider_process_exited" ||
        event.code === "provider_turn_start_failed")
    ) {
      const thread = getThread(deps.db, entry.threadId);

      if (!thread) {
        continue;
      }

      const turnStartFailed = event.code === "provider_turn_start_failed";

      if (turnStartFailed) {
        if (
          event.requestId === undefined ||
          event.scope.kind !== "thread" ||
          (thread.status !== "starting" &&
            thread.status !== "active" &&
            thread.status !== "stopping")
        ) {
          continue;
        }
      } else {
        deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
          threadIds: [entry.threadId],
          reason:
            "Provider process exited while awaiting user interaction; retry the thread to continue",
        });
      }

      const rejectedRequestId =
        event.scope.kind === "thread"
          ? rejectUnstartedTurnRequest(
              deps,
              entry.threadId,
              turnStartFailed ? event.requestId : undefined,
            )
          : null;

      if (turnStartFailed && rejectedRequestId === null) {
        continue;
      }

      const outcome = applyLoggedThreadLifecycleEvent(
        deps,
        { event: { type: "run.failed" }, threadId: entry.threadId },
        turnStartFailed && rejectedRequestId !== null
          ? {
              outcome: "failed",
              reason: null,
              summary: null,
              requestId: rejectedRequestId,
            }
          : undefined,
      );

      if (outcome.applied) {
        addParentTurnNotificationFollowUp({
          failedParentNotificationThreadIds,
          followUps,
          thread,
          turnStatus: "failed",
        });
      }

      continue;
    }
  }

  progress.entry = null;

  return followUps;
}

async function executeEventFollowUpBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUp: EventEffectFollowUp,
): Promise<void> {
  try {
    switch (followUp.kind) {
      case "parent-turn-notification":
        await queueChildThreadTurnNotificationBestEffort(deps, {
          childThread: {
            id: followUp.childThreadId,
            projectId: followUp.projectId,
            title: followUp.title,
          },
          parentThreadId: followUp.parentThreadId,
          turnStatus: followUp.turnStatus,
          ...(followUp.interruption
            ? { interruption: followUp.interruption }
            : {}),
        });

        return;
      case "queued-message-dispatch":
        await runQueuedMessageDispatch(deps, followUp.wake);

        return;
      case "turn-git-activity":
        await recordTurnGitActivity(deps, {
          threadId: followUp.threadId,
          turnId: followUp.turnId,
        });

        return;
    }
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      deps.logger.warn(
        {
          followUp,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Event follow-up deferred by host timeout",
      );

      return;
    }

    deps.logger.error(
      {
        err: error,
        followUp,
      },
      "Failed to run event follow-up",
    );
  }
}

function deferEventFollowUpBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUps: EventEffectFollowUp[],
): void {
  if (followUps.length === 0) {
    return;
  }

  deferAfterResponse({
    config: deps.config,
    logger: deps.logger,
    name: "Event follow-up scheduling",
    work: async () => {
      await Promise.all(
        followUps.map((followUp) =>
          executeEventFollowUpBestEffort(deps, followUp),
        ),
      );
    },
  });
}

function toTurnKey(args: TurnKeyArgs): string {
  return `${args.threadId}:${args.turnId}`;
}

function hasThreadCommandFailureSystemErrorForTurn(
  deps: HasThreadCommandFailureSystemErrorForTurnDeps,
  args: HasThreadCommandFailureSystemErrorForTurnArgs,
): boolean {
  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.turnId, args.turnId),
          eq(storedEvents.scopeKind, "turn"),
          eq(storedEvents.type, "system/error"),
          sql`json_extract(${storedEvents.data}, '$.code') = 'thread_command_failed'`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasThreadStopBeforeTurnStarted(
  deps: Pick<AppDeps, "db">,
  args: HasThreadStopBeforeTurnStartedArgs,
): boolean {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();

  if (!turnStarted) {
    return false;
  }

  const latestTurnRequest = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.type, "client/turn/requested"),
        lt(storedEvents.sequence, turnStarted.sequence),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();

  const lowerSequence = latestTurnRequest?.sequence ?? 0;

  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.type, "system/thread/interrupted"),
          gt(storedEvents.sequence, lowerSequence),
          lt(storedEvents.sequence, turnStarted.sequence),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function wasTurnManuallyStopped(
  deps: Pick<AppDeps, "db">,
  args: HasThreadStopBeforeTurnStartedArgs,
): boolean {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();

  if (!turnStarted) return false;

  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.type, "system/thread/interrupted"),
          gt(storedEvents.sequence, turnStarted.sequence),
          sql`json_extract(${storedEvents.data}, '$.reason') IN ('manual-stop', 'app-update')`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasThreadAlreadyStartedRun(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): boolean {
  const thread = getThread(deps.db, threadId);

  return (
    thread?.status === "active" &&
    thread.archivedAt === null &&
    thread.deletedAt === null
  );
}

function listCompletedTurnKeysForStartedEvents(
  args: ListCompletedTurnKeysForStartedEventsArgs,
): Set<string> {
  const startedTurnKeys: TurnKeyArgs[] = [];

  for (const entry of args.batchEvents) {
    if (entry.event.type !== "turn/started") {
      continue;
    }

    startedTurnKeys.push({
      threadId: entry.threadId,
      turnId: requireThreadEventScopeTurnId({
        type: entry.event.type,
        scope: entry.event.scope,
      }),
    });
  }

  if (startedTurnKeys.length === 0) {
    return new Set<string>();
  }

  const completedTurnKeys = new Set(
    listStoredTurnCompletedKeys(args.db, { keys: startedTurnKeys }).map(
      toTurnKey,
    ),
  );

  for (const [index, entry] of args.batchEvents.entries()) {
    if (
      !args.insertedEventIndexLookup.has(index) ||
      entry.event.type !== "turn/completed"
    ) {
      continue;
    }

    completedTurnKeys.delete(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }

  return completedTurnKeys;
}

function shouldApplyEventEffect(args: ShouldApplyEventEffectArgs): boolean {
  const { entry } = args;

  if (entry.event.type === "turn/completed") {
    return args.insertedEventIndexLookup.has(args.index);
  }

  if (entry.event.type === "turn/started") {
    return !args.completedTurnKeyLookup.has(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }

  return true;
}

function resolveEventsToApply(
  args: ResolveEventsToApplyArgs,
): HostDaemonEventEnvelope[] {
  const insertedEventIndexLookup = new Set(args.insertedEventIndexes);

  const completedTurnKeyLookup = listCompletedTurnKeysForStartedEvents({
    batchEvents: args.events,
    db: args.db,
    insertedEventIndexLookup,
  });

  return args.events.filter(
    (entry, index) =>
      (!args.retainedDelivery || insertedEventIndexLookup.has(index)) &&
      shouldApplyEventEffect({
        completedTurnKeyLookup,
        entry,
        index,
        insertedEventIndexLookup,
      }),
  );
}

function resolveActivePruneCandidates(
  args: ResolveActivePruneCandidatesArgs,
): ActivePruneCandidate[] {
  const latestPrunableSequenceByThreadId = new Map<string, number>();

  for (const [acceptedIndex, acceptedEvent] of args.acceptedEvents.entries()) {
    const inputIndex = args.insertedEventIndexes[acceptedIndex];

    if (inputIndex === undefined) {
      throw new Error("Missing inserted event index for accepted daemon event");
    }

    const entry = args.events[inputIndex];

    if (entry === undefined) {
      throw new Error("Missing daemon event for inserted event index");
    }

    if (!isActivePruneTriggerThreadEventType(entry.event.type)) {
      continue;
    }

    const previousSequence = latestPrunableSequenceByThreadId.get(
      entry.threadId,
    );

    if (
      previousSequence === undefined ||
      acceptedEvent.sequence > previousSequence
    ) {
      latestPrunableSequenceByThreadId.set(
        entry.threadId,
        acceptedEvent.sequence,
      );
    }
  }

  return [...latestPrunableSequenceByThreadId.entries()].map(
    ([threadId, latestPrunableSequence]) => ({
      threadId,
      latestPrunableSequence,
    }),
  );
}

function summarizeRejectedDaemonEvents(
  rejectedEvents: readonly HostDaemonRejectedEvent[],
): RejectedDaemonEventSummary {
  return {
    count: rejectedEvents.length,
    threadIds: [...new Set(rejectedEvents.map((event) => event.threadId))],
  };
}

function resolvePostableEventBatchEntries(
  deps: Pick<AppDeps, "db">,
  args: ResolvePostableEventBatchEntriesArgs,
): ResolvePostableEventBatchEntriesResult {
  const threadIds = [...new Set(args.events.map((entry) => entry.threadId))];

  if (threadIds.length === 0) {
    return {
      entries: [],
      rejectedEvents: [],
    };
  }

  const ownedThreads = listThreadEnvironmentAssignmentsOnHost(deps.db, {
    hostId: args.hostId,
    threadIds,
  });

  const canonicalEnvironmentIdByThreadId = new Map<string, string | null>();

  for (const ownedThread of ownedThreads) {
    canonicalEnvironmentIdByThreadId.set(
      ownedThread.threadId,
      ownedThread.environmentId,
    );
  }

  const entries: PostableEventBatchEntry[] = [];
  const rejectedEvents: HostDaemonRejectedEvent[] = [];

  for (const [eventIndex, entry] of args.events.entries()) {
    if (!canonicalEnvironmentIdByThreadId.has(entry.threadId)) {
      rejectedEvents.push({
        eventIndex,
        reason: "thread_not_owned_by_host",
        threadId: entry.threadId,
      });
      continue;
    }

    const canonicalEnvironmentId =
      canonicalEnvironmentIdByThreadId.get(entry.threadId) ?? null;

    entries.push({
      envelope: entry,
      environmentId: canonicalEnvironmentId,
      eventIndex,
    });
  }

  return {
    entries,
    rejectedEvents,
  };
}

interface DroppedLifecycleEvent {
  eventIndex: number;
  eventType: string;
  interactionId: string;
  threadId: string;
}

function lifecycleInteractionId(
  event: HostDaemonEventEnvelope["event"],
): string | null {
  switch (event.type) {
    case "system/interaction/lifecycle":
      return event.interaction.id;
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
      return event.interactionId;
    default:
      return null;
  }
}

function dropInteractionLifecycleEvents(entries: PostableEventBatchEntry[]): {
  entries: PostableEventBatchEntry[];
  droppedLifecycleEvents: DroppedLifecycleEvent[];
} {
  const kept: PostableEventBatchEntry[] = [];
  const droppedLifecycleEvents: DroppedLifecycleEvent[] = [];

  for (const entry of entries) {
    const interactionId = lifecycleInteractionId(entry.envelope.event);

    if (interactionId === null) {
      kept.push(entry);
      continue;
    }

    droppedLifecycleEvents.push({
      eventIndex: entry.eventIndex,
      eventType: entry.envelope.event.type,
      interactionId,
      threadId: entry.envelope.threadId,
    });
  }

  return { entries: kept, droppedLifecycleEvents };
}

interface IndexedEventInput {
  eventIndex: number;
  input: AppendDaemonEventInput;
}

interface IndexedEventBatch {
  firstEventIndex: number;
  key: DaemonEventReceiptKey;
  lastEventIndex: number;
  retained: boolean;
}

interface IndexedEventAppend {
  appendResult: AppendDaemonEventsResult;
  duplicateEvents: number;
}

function appendIndexedDaemonEventsInTransaction(
  tx: DbTransaction,
  batch: IndexedEventBatch,
  inputs: readonly IndexedEventInput[],
): IndexedEventAppend {
  const appliedThrough = readDaemonEventReceiptIndex(tx, batch.key);

  const kept = inputs.flatMap((entry, position) =>
    batch.firstEventIndex + entry.eventIndex > appliedThrough
      ? [{ input: entry.input, position }]
      : [],
  );

  const append = batch.retained
    ? appendRetainedDaemonEventsInTransaction
    : appendDaemonEventsInTransaction;

  const result = append(
    tx,
    kept.map((entry) => entry.input),
  );

  recordDaemonEventReceipt(tx, {
    ...batch.key,
    lastEventIndex: batch.lastEventIndex,
  });

  const toPosition = (keptIndex: number): number => {
    const entry = kept[keptIndex];

    if (entry === undefined) {
      throw new Error("Missing kept daemon event for an appended input");
    }

    return entry.position;
  };

  return {
    appendResult: {
      ...result,
      insertedInputIndexes: result.insertedInputIndexes.map(toPosition),
      reopenedInputIndexes: result.reopenedInputIndexes.map(toPosition),
      skippedTurnUnstartedInputIndexes:
        result.skippedTurnUnstartedInputIndexes.map(toPosition),
    },
    duplicateEvents: Math.min(
      Math.max(appliedThrough - batch.firstEventIndex + 1, 0),
      batch.lastEventIndex - batch.firstEventIndex + 1,
    ),
  };
}

function toEventBatchRefusal(
  deps: Pick<AppDeps, "config" | "logger">,
  args: {
    error: unknown;
    failedEntry: HostDaemonEventEnvelope | null;
    sessionId: string;
  },
): unknown {
  const { error } = args;

  if (error instanceof MissingStoredTurnStartedError) {
    deps.logger.warn(
      {
        ...error.details,
        sessionId: args.sessionId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Rejected daemon event before turn/started",
    );

    return new ApiError(409, "invalid_request", error.message);
  }

  if (error instanceof PrimaryWriteBusyError) {
    deps.logger.warn(
      { sessionId: args.sessionId, waitMs: error.waitMs },
      "Refused a daemon event batch while the primary write lock was held",
    );

    return new ApiError(
      503,
      "coordinator_busy",
      "The coordinator could not take its write lock in time; retry the event batch",
      true,
    );
  }

  deps.logger.error(
    {
      err: error,
      eventType: args.failedEntry?.event.type,
      threadId: args.failedEntry?.threadId,
      sessionId: args.sessionId,
    },
    "Daemon event batch was not applied",
  );

  return new ApiError(
    503,
    "event_batch_not_applied",
    "The event batch could not be applied; retry the same batch",
    true,
  );
}

function runAfterEventBatchCommit(
  deps: Pick<AppDeps, "logger">,
  sessionId: string,
  steps: readonly (() => void)[],
): void {
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      deps.logger.error(
        { err: error, sessionId },
        "Daemon event batch step failed after its commit",
      );
    }
  }
}

export function registerInternalEventRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/events",
    hostDaemonEventBatchRequestSchema,
    async (context, payload) => {
      const receivedAt = performance.now();
      let session: ReturnType<typeof requireAuthenticatedDaemonSession>;

      try {
        session = requireAuthenticatedDaemonSession({
          context,
          db: deps.db,
          sessionId: payload.sessionId,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.body.code === "inactive_session"
        ) {
          deps.logger.info(
            getInactiveSessionLogFields(deps.db, {
              authenticatedHostId: getAuthenticatedDaemon(context).hostId,
              now: Date.now(),
              sessionId: payload.sessionId,
            }),
            "Daemon event batch for inactive session",
          );
        }

        throw error;
      }

      const events = ungroupHostDaemonEvents(payload.eventGroups);

      const { entries: ownedEntries, rejectedEvents } =
        resolvePostableEventBatchEntries(deps, {
          hostId: session.hostId,
          events,
        });

      const { entries, droppedLifecycleEvents } =
        dropInteractionLifecycleEvents(ownedEntries);

      if (droppedLifecycleEvents.length > 0) {
        deps.logger.warn(
          {
            hostId: session.hostId,
            sessionId: session.id,
            droppedEvents: droppedLifecycleEvents,
          },
          "Dropped daemon-posted interaction lifecycle events; the server is their only author",
        );
      }

      if (rejectedEvents.length > 0) {
        deps.logger.warn(
          {
            hostId: session.hostId,
            rejectedEvents: summarizeRejectedDaemonEvents(rejectedEvents),
            sessionId: session.id,
          },
          "Rejected daemon events for threads outside the session host",
        );

        if (payload.firstEventIndex !== undefined) {
          throw new ApiError(
            400,
            "invalid_request",
            "Indexed daemon event batch contains threads outside the session host",
          );
        }
      }

      const validatedEnvelopes = validatePresentationIcons(
        deps,
        await validateExtensionPayloads(
          deps,
          entries.map((entry) => entry.envelope),
        ),
      );

      const validatedEntries = entries.map((entry, index) => {
        const validated = validatedEnvelopes[index];

        if (validated === undefined) {
          throw new Error("Missing validated envelope for daemon event entry");
        }

        return {
          ...entry,
          envelope: {
            ...validated,
            event: maskProviderEnvironmentEvent(validated.event),
          },
        };
      });

      const indexedBatch: IndexedEventBatch | null =
        payload.firstEventIndex === undefined
          ? null
          : {
              firstEventIndex: payload.firstEventIndex,
              key: {
                hostId: session.hostId,
                instanceId: payload.sourceInstanceId ?? session.instanceId,
              },
              lastEventIndex: payload.firstEventIndex + events.length - 1,
              retained: payload.sourceInstanceId !== undefined,
            };

      const retainedDelivery = payload.sourceInstanceId !== undefined;
      const effectProgress: EventEffectProgress = { entry: null };
      let applied: AppliedEventBatch;
      let afterCommitActions: (() => void)[];

      let waitedForWrite = false;
      let admitted = false;

      const assertWritable = () => {
        if (
          isServerMoveSnapshotFenced(deps.db) ||
          isMaintenanceFrozen(deps.db)
        ) {
          throw serverMovingError();
        }
      };

      try {
        const collected = await runImmediateTransactionWithBusyWait(
          deps.db,
          INGRESS_WRITE_BUSY_WAIT_MS,
          (tx) =>
            collectAfterCommit((): AppliedEventBatch => {
              assertWritable();

              if (waitedForWrite) {
                requireAuthenticatedDaemonSession({
                  context,
                  db: deps.db,
                  sessionId: session.id,
                });

                const assignments = new Map(
                  listThreadEnvironmentAssignmentsOnHost(deps.db, {
                    hostId: session.hostId,
                    threadIds: [
                      ...new Set(
                        validatedEntries.map(
                          ({ envelope }) => envelope.threadId,
                        ),
                      ),
                    ],
                  }).map(({ threadId, environmentId }) => [
                    threadId,
                    environmentId,
                  ]),
                );

                if (
                  validatedEntries.some(
                    ({ environmentId, envelope }) =>
                      assignments.get(envelope.threadId) !== environmentId,
                  )
                ) {
                  throw new ApiError(
                    503,
                    "event_batch_not_applied",
                    "Thread placement changed; retry the same event batch",
                    true,
                  );
                }
              }

              admitted = true;

              const labelledEntries = validatedEntries.map((entry) =>
                preserveTerminalProvisioningStatus(deps, entry),
              );

              const indexedInputs = labelledEntries.map((entry) => ({
                eventIndex: entry.eventIndex,
                input: toStoredEvent({
                  envelope: entry.envelope,
                  environmentId: entry.environmentId,
                }),
              }));

              const eventInputs = indexedInputs.map((entry) => entry.input);

              const subagentCountsBefore = readSubagentCounts(deps.db, [
                ...new Set(
                  eventInputs
                    .filter(eventInputMayChangeSubagents)
                    .map((input) => input.threadId),
                ),
              ]);

              const postableEvents = labelledEntries.map(
                (entry) => entry.envelope,
              );

              const indexed =
                indexedBatch === null
                  ? null
                  : appendIndexedDaemonEventsInTransaction(
                      tx,
                      indexedBatch,
                      indexedInputs,
                    );

              const appendResult =
                indexed === null
                  ? appendDaemonEventsInTransaction(tx, eventInputs)
                  : indexed.appendResult;

              return {
                eventInputs,
                postableEvents,
                subagentCountsBefore,
                appendResult,
                duplicateEvents: indexed?.duplicateEvents ?? 0,
                followUps: applyEventEffects(
                  deps,
                  resolveEventsToApply({
                    db: deps.db,
                    events: postableEvents,
                    insertedEventIndexes: appendResult.insertedInputIndexes,
                    retainedDelivery,
                  }),
                  retainedDelivery,
                  effectProgress,
                ),
              };
            }),
          () => {
            assertWritable();
            waitedForWrite = true;
          },
        );

        applied = collected.result;
        afterCommitActions = collected.actions;
      } catch (error) {
        if (!admitted && error instanceof ApiError) throw error;

        throw toEventBatchRefusal(deps, {
          error,
          failedEntry: effectProgress.entry,
          sessionId: session.id,
        });
      }

      const {
        appendResult,
        duplicateEvents,
        eventInputs,
        followUps,
        postableEvents,
        subagentCountsBefore,
      } = applied;

      const committedAt = performance.now();

      if (indexedBatch !== null) {
        advanceDaemonEventReceipt(
          deps.db,
          indexedBatch.key,
          indexedBatch.lastEventIndex,
        );
      }

      for (const index of appendResult.skippedTurnUnstartedInputIndexes) {
        const skipped = eventInputs[index];
        deps.logger.warn(
          {
            eventType: skipped?.type,
            threadId: skipped?.threadId,
            sessionId: session.id,
          },
          "Dropped orphan thread-state snapshot with no stored turn/started",
        );
      }

      runAfterEventBatchCommit(deps, session.id, [
        () => {
          notifyInsertedEventThreads(deps, {
            acceptedEvents: appendResult.acceptedEvents,
            eventInputs,
            insertedInputIndexes: appendResult.insertedInputIndexes,
            reopenedInputIndexes: appendResult.reopenedInputIndexes,
            subagentCountsBefore,
          });
          observeTurnTraceEventBatch({
            committedAt,
            events: postableEvents,
            notifiedAt: performance.now(),
            receivedAt,
          });
        },
        ...afterCommitActions,
        ...resolveActivePruneCandidates({
          acceptedEvents: appendResult.acceptedEvents,
          events: postableEvents,
          insertedEventIndexes: appendResult.insertedInputIndexes,
        }).map(
          (candidate) => () =>
            maybePruneActiveThreadEventHistory(deps, candidate),
        ),
        () => deferEventFollowUpBatch(deps, followUps),
      ]);

      const response: HostDaemonEventBatchResponse = {
        acceptedEvents: appendResult.acceptedEvents.map(
          (acceptedEvent, acceptedIndex) => {
            const inputIndex = appendResult.insertedInputIndexes[acceptedIndex];

            if (inputIndex === undefined) {
              throw new Error(
                "Missing inserted event index for accepted daemon event",
              );
            }

            const entry = entries[inputIndex];

            if (entry === undefined) {
              throw new Error("Missing daemon event entry for accepted event");
            }

            return {
              eventIndex: entry.eventIndex,
              sequence: acceptedEvent.sequence,
              threadId: acceptedEvent.threadId,
            };
          },
        ),
        rejectedEvents,
        ...(indexedBatch === null ? {} : { duplicateEvents }),
      };

      const body = JSON.stringify(response);

      return context.body(body, 200, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      });
    },
  );
}
