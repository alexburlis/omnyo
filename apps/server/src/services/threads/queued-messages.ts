import {
  messageSourceNotice,
  messageSourceFromNotice,
} from "./message-source.js";
import { isServerUpdateDraining } from "../system/server-update-drain.js";
import {
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessageInTransaction,
  createUniqueQueuedThreadMessageInTransaction,
  getEnvironment,
  getHost,
  getQueuedThreadMessage,
  wasQueuedThreadMessageDispatched,
  getStoredProviderSession,
  getThread,
  holdQueuedThreadMessageForEdit,
  isOrdinaryTurnEndQueuedMessage,
  isThreadQueueAutoSendPaused,
  releaseQueuedMessageClaim,
  releaseQueuedThreadMessageEditHold,
  releaseStaleQueuedMessageClaims,
  type CreateQueuedThreadMessageInput,
  type DbQueryConnection,
  type DbTransaction,
  type QueuedThreadMessageGroupClaimPolicy,
  type QueuedThreadMessageGroupEligibility,
  type QueuedThreadMessageRow,
} from "@omnyo/db";
import { flattenPromptInputGroups } from "@omnyo/domain";
import type {
  QueuedMessageDeliveryMode,
  QueuedMessageWaitingOn,
  Thread,
  ThreadQueuedMessage,
} from "@omnyo/domain";
import type {
  CreateQueuedMessageRequest,
  QueuedMessageEditHoldResponse,
  SendMessageRequest,
  SendQueuedMessageMode,
  SendQueuedMessageRequest,
} from "@omnyo/server-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  findWaitsByDispatchQueuedMessage,
  updateFailure,
} from "../inbox/store.js";
import {
  admitDispatch,
  cancelHeldRetryRows,
  hasPausedQueue,
  openFailureState,
  overridesOpenFailure,
  resolveFailuresForOverride,
} from "../inbox/engine.js";
import { inboxRootOf } from "../inbox/family.js";
import { isCommandTimeoutError } from "../lib/error-log-fields.js";
import {
  parseStoredQueuedThreadMessageSystemNotice,
  parseStoredQueuedThreadMessageWaitingOn,
  storedQueuedThreadMessageRequestedBy,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  getActiveTurnId,
  isActiveTurnMainRunIdle,
  isManualCompactionActive,
} from "./thread-events.js";
import { attemptDispatch, threadTargetHostId } from "./dispatch-attempt.js";
import {
  QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
  QUEUED_MESSAGE_CLAIM_LOST_CODE,
} from "./queue-waits.js";
import { recordQueuedMessageDrainFailure } from "./queue-drain-failure.js";
import {
  captureUserMessageSentTelemetry,
  ensureThreadQueueIsWritable,
  resolveMessageSenderThreadId,
} from "./thread-send.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { ThreadContextClearInProgressError } from "./thread-context-mutation-guard.js";

interface SendQueuedMessageArgs extends SendQueuedMessageRequest {
  claimPolicy: QueuedThreadMessageGroupClaimPolicy;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
  threadId: string;
}

type ClaimedQueuedMessage = Exclude<
  ReturnType<typeof claimQueuedThreadMessageGroup>,
  null
>[number];

interface SendClaimedQueuedMessageArgs extends SendQueuedMessageRequest {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];

  sendNow: boolean;
  threadId: string;
}

interface SendClaimedQueuedMessageForThreadArgs extends SendQueuedMessageRequest {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  sendNow: boolean;
  thread: Thread;
}

type FailurePauseRow = Pick<
  QueuedThreadMessageRow,
  "overridesFailureId" | "payloadKind" | "threadId"
>;

function failurePauseHoldsPayload(
  db: DbQueryConnection,
  row: FailurePauseRow,
): boolean {
  if (row.payloadKind === "retry")
    return (
      admitDispatch(db, { threadId: row.threadId, starter: "retry" }) ===
      "pause"
    );

  return (
    !overridesOpenFailure(db, row) ||
    admitDispatch(db, { threadId: row.threadId, starter: "owner" }) === "pause"
  );
}

export function isQueuedMessageHeldByFailurePause(
  db: DbQueryConnection,
  row: FailurePauseRow,
): boolean {
  return hasPausedQueue(db, row.threadId) && failurePauseHoldsPayload(db, row);
}

export function createAutomaticQueuedMessageGroupEligibility(
  deps: Pick<AppDeps, "config" | "db" | "hub">,
  args: { now: number; retryingFailure: boolean; thread: Thread },
): QueuedThreadMessageGroupEligibility {
  const activeTurnId = getActiveTurnId(deps, args.thread.id);
  const paused = hasPausedQueue(deps.db, args.thread.id);

  const startsOwnTurn =
    args.thread.status === "idle" ||
    args.thread.status === "pending" ||
    args.thread.status === "error";

  return (group) =>
    (startsOwnTurn ||
      findWaitsByDispatchQueuedMessage(
        deps.db,
        group.map((member) => member.id),
      ).length === 0) &&
    group.every((member) => {
      if (member.sendAt !== null && member.sendAt > args.now) return false;

      if (paused && failurePauseHoldsPayload(deps.db, member)) return false;

      if (member.failureReason !== null && !args.retryingFailure) return false;
      const waitingOn = parseStoredQueuedThreadMessageWaitingOn(member);

      switch (waitingOn?.kind) {
        case undefined:
        case "plugin":
          return true;
        case "time":
          return member.sendAt !== null && member.sendAt <= args.now;
        case "thread-busy":
          return (
            args.thread.status === "idle" ||
            args.thread.status === "pending" ||
            isActiveTurnMainRunIdle(deps, args.thread)
          );
        case "stopping":
          return (
            args.thread.status === "idle" || args.thread.status === "pending"
          );
        case "turn-starting":
          return (
            args.thread.status === "idle" ||
            (args.thread.status === "active" && activeTurnId !== null)
          );
        case "host-offline": {
          const environment =
            args.thread.environmentId === null
              ? null
              : getEnvironment(deps.db, args.thread.environmentId);

          const host =
            environment === null ? null : getHost(deps.db, environment.hostId);

          return (
            host !== null &&
            host.destroyedAt === null &&
            host.phase === "active" &&
            deps.hub.hasDaemonForHost(host.id)
          );
        }

        case "host-away": {
          const environment =
            args.thread.environmentId === null
              ? null
              : getEnvironment(deps.db, args.thread.environmentId);

          const host =
            environment === null ? null : getHost(deps.db, environment.hostId);

          return host === null || host.availability !== "away";
        }

        case "server-update":
          return !isServerUpdateDraining(
            deps,
            threadTargetHostId(deps, args.thread),
          );

        case "provisioning":
        case "interaction":
        case "superseded":
          return false;
      }
    });
}

export interface CreateQueuedMessageForThreadArgs {
  payload: CreateQueuedMessageRequest;
  thread: Thread;
}

function admitQueuedMessage(
  db: DbQueryConnection,
  thread: Thread,
): { hasProviderSession: boolean } {
  ensureThreadQueueIsWritable(thread);

  const hasProviderSession =
    getStoredProviderSession(db, thread.id).kind !== "none";

  if (thread.environmentId === null) {
    if (hasProviderSession) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }

    return { hasProviderSession };
  }

  const environment = getEnvironment(db, thread.environmentId);
  assertThreadHostAcceptsWork(db, thread);

  const goneDetails = environment
    ? goneThreadEnvironmentDetails(environment)
    : null;

  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }

  return { hasProviderSession };
}

export interface QueuedMessageAcceptance {
  insert(
    tx: DbTransaction,
    options: { collapseDuplicates: boolean },
  ): { created: boolean; row: QueuedThreadMessageRow };
  announce(): void;
}

export async function prepareQueuedMessageAcceptance(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<QueuedMessageAcceptance> {
  const { payload, thread } = args;
  ensureThreadQueueIsWritable(thread);

  const input = await resolvePromptAttachmentReferences({
    db: deps.db,
    dataDir: deps.config.dataDir,
    input: payload.input,
    projectId: thread.projectId,
    hostId: threadTargetHostId(deps, thread),
  });

  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });

  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });

  let admitted: { currentThread: Thread; hasProviderSession: boolean } | null =
    null;

  return {
    insert(tx, options) {
      const currentThread = getThread(tx, thread.id);

      if (!currentThread) {
        throw new ApiError(404, "thread_not_found", "Thread not found");
      }

      const { hasProviderSession } = admitQueuedMessage(tx, currentThread);
      admitted = { currentThread, hasProviderSession };

      const queuedInput: CreateQueuedThreadMessageInput = {
        threadId: thread.id,
        content: input,
        senderThreadId,
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        permissionMode: execution.permissionMode,
        serviceTier: execution.serviceTier,
        waitingOn:
          currentThread.status === "stopping"
            ? { kind: "stopping" }
            : { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        deliveryMode: "queue",
        systemNotice: messageSourceNotice(
          payload.messageSource,
          senderThreadId,
        ),
      };

      return options.collapseDuplicates
        ? createUniqueQueuedThreadMessageInTransaction(tx, queuedInput)
        : {
            created: true,
            row: createQueuedThreadMessageInTransaction(tx, queuedInput),
          };
    },
    announce() {
      if (admitted === null) {
        throw new Error("A queued message was announced before its insert");
      }

      deps.hub.notifyThread(thread.id, ["queue-changed"]);

      if (senderThreadId === null && payload.input.length > 0) {
        captureUserMessageSentTelemetry(deps, {
          isChildThread: thread.parentThreadId !== null,
          messageSource: "queued_message",
        });
      }

      if (
        (admitted.currentThread.status === "idle" &&
          admitted.hasProviderSession) ||
        isActiveTurnMainRunIdle(deps, admitted.currentThread)
      ) {
        requestQueuedMessageDispatch(deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
      }
    },
  };
}

export async function createQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const acceptance = await prepareQueuedMessageAcceptance(deps, args);

  const queued = deps.db.transaction(
    (tx) => acceptance.insert(tx, { collapseDuplicates: true }),
    { behavior: "immediate" },
  );

  if (queued.created) acceptance.announce();

  return toThreadQueuedMessage(queued.row);
}

function isQueuedMessageAutoSendCandidate(
  thread: Thread | null,
): thread is Thread {
  return (
    thread !== null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.status !== "stopping"
  );
}

const STALE_QUEUED_MESSAGE_CLAIM_MS = 5 * 60 * 1000;

const QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS = 2 * 60 * 1000;

const activeQueuedMessageClaimTokens = new Set<string>();

function respectsManualStopPause(
  args: SendClaimedQueuedMessageForThreadArgs,
): boolean {
  return (
    args.mode === "auto" &&
    !args.sendNow &&
    args.queuedMessages.some(isOrdinaryTurnEndQueuedMessage)
  );
}

function sendModeForDeliveryMode(
  group: readonly { deliveryMode: QueuedMessageDeliveryMode }[],
): SendMessageRequest["mode"] {
  return group.some((row) => row.deliveryMode === "queue")
    ? "queue-if-active"
    : "auto";
}

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
  mode: SendMessageRequest["mode"],
  senderThreadId: string | null,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    messageSource: queuedMessage.messageSource,
    mode,
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
    ...(senderThreadId !== null ? { senderThreadId } : {}),
  };
}

function releaseQueuedMessageClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  queuedMessages: readonly ClaimedQueuedMessage[],
): void {
  for (const queuedMessage of queuedMessages) {
    releaseQueuedMessageClaim(deps.db, deps.hub, {
      id: queuedMessage.id,
      claimToken: queuedMessage.claimToken,
    });
  }
}

async function withActiveQueuedMessageClaims<T>(
  queuedMessages: readonly ClaimedQueuedMessage[],
  task: () => Promise<T>,
): Promise<T> {
  for (const queuedMessage of queuedMessages) {
    activeQueuedMessageClaimTokens.add(queuedMessage.claimToken);
  }

  try {
    return await task();
  } finally {
    for (const queuedMessage of queuedMessages) {
      activeQueuedMessageClaimTokens.delete(queuedMessage.claimToken);
    }
  }
}

function claimQueuedThreadMessageForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedMessageArgs,
): ClaimedQueuedMessage[] {
  const existingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );

  if (
    !existingQueuedMessage ||
    existingQueuedMessage.threadId !== args.threadId
  ) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  const claimedQueuedMessages = claimQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.queuedMessageId,
    args.claimPolicy,
  );

  if (claimedQueuedMessages) {
    return claimedQueuedMessages;
  }

  if (args.claimPolicy.kind === "automatic") return [];

  const latestQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );

  if (!latestQueuedMessage || latestQueuedMessage.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  throw new ApiError(
    409,
    "invalid_request",
    "Queued message is already being sent",
  );
}

function isQueuedMessageClaimLostError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_CLAIM_LOST_CODE
  );
}

function isQueuedMessageAutoSendPausedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE
  );
}

async function sendClaimedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const thread = getThread(deps.db, args.threadId);

  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }

  return sendClaimedQueuedMessageForThread(deps, {
    mode: args.mode,
    requestId: args.requestId,
    queuedMessages: args.queuedMessages,
    sendNow: args.sendNow,
    thread,
  });
}

async function sendClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const queuedMessages = args.queuedMessages.map(toThreadQueuedMessage);
  const queuedMessage = queuedMessages[0]!;

  const inputGroups = queuedMessages.map(
    (queuedMessage) => queuedMessage.content,
  );

  const input = flattenPromptInputGroups(inputGroups);
  const lead = args.queuedMessages[0]!;

  const mode =
    args.mode === "auto" && !args.sendNow
      ? sendModeForDeliveryMode(args.queuedMessages)
      : args.mode;

  const storedNotice = parseStoredQueuedThreadMessageSystemNotice(lead);

  const systemNotice =
    messageSourceFromNotice(storedNotice) === undefined ? storedNotice : null;

  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: {
      requestId: args.requestId,
      ...(systemNotice === null
        ? sendQueuedMessagePayload(
            { ...queuedMessage, content: input },
            mode,
            lead.senderThreadId,
          )
        : { input, mode }),
      ...(inputGroups.length > 1 ? { inputGroups } : {}),
    },
    source: {
      kind: "drain",
      claimed: args.queuedMessages,
      respectManualStopPause: respectsManualStopPause(args),
      sendNow: args.sendNow,
    },
    queuePayload: queuedMessage.payload,
    pluginSubmission: null,
    systemNotice,
    ...(queuedMessage.payload.kind === "retry"
      ? {
          retryOf: {
            requestId: queuedMessage.payload.retryOfTurnRequestId,
            attempt: queuedMessage.payload.attempt,
          },
        }
      : {}),
    origin: lead.origin,
    originPluginId: lead.originPluginId,
    startedOnBehalfOf: storedQueuedThreadMessageRequestedBy(lead),
    trigger: "auto-dispatch",
  });

  if (
    args.sendNow &&
    args.mode !== "steer" &&
    outcome.kind === "queued" &&
    outcome.entry.waitingOn?.kind !== "stopping"
  ) {
    throw new ApiError(
      409,
      "queued_message_still_waiting",
      `This message cannot be sent yet: ${describeCoreWait(outcome.entry.waitingOn)}.`,
    );
  }

  return queuedMessage;
}

function describeCoreWait(waitingOn: QueuedMessageWaitingOn | null): string {
  switch (waitingOn?.kind) {
    case "provisioning":
      return "the thread's workspace is still being prepared";
    case "host-offline":
      return `the "${waitingOn.hostName}" host is not ready`;
    case "host-away":
      return `the "${waitingOn.hostName}" machine is set to Away`;
    case "interaction":
      return "the thread is waiting for you to answer a pending interaction";
    case "turn-starting":
      return "the current turn is still starting";
    case "stopping":
      return "the thread is still stopping";
    case "plugin":
      return `it is waiting on the "${waitingOn.pluginId}" plugin`;
    case "superseded":
      return "a newer message was sent after it";
    case "server-update":
      return "an update is in progress";
    case "time":
    case "thread-busy":
    case undefined:
      return "the thread is already running a turn";
  }
}

export async function sendQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const queuedMessages = claimQueuedThreadMessageForSend(deps, args);

  if (queuedMessages.length === 0) {
    const existing = getQueuedThreadMessage(deps.db, args.queuedMessageId);

    if (!existing)
      throw new ApiError(404, "invalid_request", "Queued message not found");

    return toThreadQueuedMessage(existing);
  }

  try {
    return await sendClaimedQueuedMessageGroup(deps, args, queuedMessages);
  } finally {
    if (getThread(deps.db, args.threadId)?.status === "idle") {
      requestQueuedMessageDispatch(deps, {
        kind: "thread-ready",
        threadId: args.threadId,
      });
    }
  }
}

async function sendClaimedQueuedMessageGroup(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
  queuedMessages: ClaimedQueuedMessage[],
): Promise<ThreadQueuedMessage> {
  const sendNow = args.claimPolicy.kind === "explicit-send";
  const thread = getThread(deps.db, args.threadId);

  if (
    thread &&
    (isManualCompactionActive(deps, thread) ||
      (args.mode === "auto" &&
        !sendNow &&
        queuedMessages.some(isOrdinaryTurnEndQueuedMessage) &&
        isThreadQueueAutoSendPaused(deps.db, thread.id)))
  ) {
    releaseQueuedMessageClaims(deps, queuedMessages);

    return toThreadQueuedMessage(queuedMessages[0]!);
  }

  try {
    return await withActiveQueuedMessageClaims(queuedMessages, () =>
      sendClaimedQueuedMessage(deps, {
        mode: args.mode,
        requestId: args.requestId,
        queuedMessages,
        sendNow,
        threadId: args.threadId,
      }),
    );
  } catch (error) {
    releaseQueuedMessageClaims(deps, queuedMessages);

    if (
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return toThreadQueuedMessage(queuedMessages[0]!);
    }

    throw error;
  }
}

export async function sendQueuedMessageNow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageRequest & {
    queuedMessageId: string;
    threadId: string;
    overrideFailures: boolean;
  },
): Promise<
  | { delivery: "sent" }
  | { delivery: "already-sent" }
  | { delivery: "queued"; queuedMessage: ThreadQueuedMessage }
> {
  const row = getQueuedThreadMessage(deps.db, args.queuedMessageId);

  if (
    args.overrideFailures &&
    row !== null &&
    row.threadId === args.threadId &&
    row.payloadKind !== "retry"
  )
    deps.db.transaction(
      (tx) => {
        const now = Date.now();

        cancelHeldRetryRows(tx, { threadId: args.threadId, now });
        resolveFailuresForOverride(tx, {
          threadId: args.threadId,
          now,
          by: "owner",
        });
      },
      { behavior: "immediate" },
    );

  try {
    await sendQueuedMessage(deps, {
      claimPolicy: { kind: "explicit-send" },
      mode: args.mode,
      requestId: args.requestId,
      queuedMessageId: args.queuedMessageId,
      threadId: args.threadId,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      wasQueuedThreadMessageDispatched(deps.db, {
        queuedMessageId: args.queuedMessageId,
        threadId: args.threadId,
      })
    )
      return { delivery: "already-sent" };

    throw error;
  }

  const remainingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );

  return remainingQueuedMessage
    ? {
        delivery: "queued",
        queuedMessage: toThreadQueuedMessage(remainingQueuedMessage),
      }
    : { delivery: "sent" };
}

function releaseFailurePauseForOwner(
  db: DbQueryConnection,
  row: QueuedThreadMessageRow,
  now: number,
): void {
  if (row.payloadKind === "retry") {
    const failure = openFailureState(db, row.threadId);

    if (failure !== null) updateFailure(db, failure.id, { state: "held" }, now);

    return;
  }

  cancelHeldRetryRows(db, { threadId: row.threadId, now });
  resolveFailuresForOverride(db, { threadId: row.threadId, now, by: "owner" });
}

export function releaseFailurePauseForQueuedRecovery(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { queuedMessageId: string; threadId: string },
): boolean {
  const released = deps.db.transaction(
    (tx) => {
      const row = getQueuedThreadMessage(tx, args.queuedMessageId);

      if (
        row === null ||
        row.threadId !== args.threadId ||
        row.claimedAt !== null ||
        row.claimToken !== null ||
        !isQueuedMessageHeldByFailurePause(tx, row)
      )
        return false;
      releaseFailurePauseForOwner(tx, row, Date.now());

      return true;
    },
    { behavior: "immediate" },
  );

  if (released)
    deps.hub.notifyThread(
      inboxRootOf(deps.db, args.threadId)?.id ?? args.threadId,
      ["work-changed"],
    );

  return released;
}

export async function sendQueuedMessageHeldByFailurePause(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { queuedMessageId: string; threadId: string },
): Promise<
  | { delivery: "sent" }
  | { delivery: "queued"; queuedMessage: ThreadQueuedMessage }
  | null
> {
  if (!releaseFailurePauseForQueuedRecovery(deps, args)) return null;
  const thread = getThread(deps.db, args.threadId);

  if (!isQueuedMessageAutoSendCandidate(thread)) return null;

  await sendQueuedMessage(deps, {
    claimPolicy: {
      kind: "automatic",
      isGroupEligible: createAutomaticQueuedMessageGroupEligibility(deps, {
        now: Date.now(),
        retryingFailure: false,
        thread,
      }),
      retryingFailure: false,
    },
    mode: "auto",
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });

  const remainingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );

  return remainingQueuedMessage
    ? {
        delivery: "queued",
        queuedMessage: toThreadQueuedMessage(remainingQueuedMessage),
      }
    : { delivery: "sent" };
}

export async function sendNextQueuedMessageIfPresent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): Promise<boolean> {
  const initialThread = getThread(deps.db, args.threadId);

  if (!isQueuedMessageAutoSendCandidate(initialThread)) {
    return false;
  }

  const nextQueuedMessages = claimNextQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.threadId,
    createAutomaticQueuedMessageGroupEligibility(deps, {
      now: Date.now(),
      retryingFailure: false,
      thread: initialThread,
    }),
  );

  if (!nextQueuedMessages) {
    return false;
  }

  const thread = getThread(deps.db, args.threadId);

  if (
    !isQueuedMessageAutoSendCandidate(thread) ||
    isManualCompactionActive(deps, thread)
  ) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);

    return false;
  }

  try {
    await withActiveQueuedMessageClaims(nextQueuedMessages, () =>
      sendClaimedQueuedMessageForThread(deps, {
        mode: "auto",
        queuedMessages: nextQueuedMessages,
        sendNow: false,
        thread,
      }),
    );
  } catch (error) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);

    if (
      isQueuedMessageClaimLostError(error) ||
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return false;
    }

    if (!isCommandTimeoutError(error)) {
      recordQueuedMessageDrainFailure(deps, {
        error,
        now: Date.now(),
        row: nextQueuedMessages[0]!,
        thread,
      });
    }

    throw error;
  }

  if (isHeldByPluginOnIdleThread(deps, nextQueuedMessages[0]!)) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: args.threadId,
    });
  }

  return true;
}

function isHeldByPluginOnIdleThread(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  lead: ClaimedQueuedMessage,
): boolean {
  const row = getQueuedThreadMessage(deps.db, lead.id);

  return (
    row !== null &&
    parseStoredQueuedThreadMessageWaitingOn(row)?.kind === "plugin" &&
    getThread(deps.db, row.threadId)?.status === "idle"
  );
}

export function releaseStaleQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): void {
  releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now - STALE_QUEUED_MESSAGE_CLAIM_MS,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}

export function releaseOrphanedQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): number {
  return releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now + 1,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}

interface QueuedMessageEditHoldArgs {
  queuedMessageId: string;
  threadId: string;
}

export function holdQueuedMessageForEdit(
  deps: Pick<AppDeps, "db">,
  args: QueuedMessageEditHoldArgs,
): QueuedMessageEditHoldResponse {
  const result = holdQueuedThreadMessageForEdit(deps.db, {
    heldUntil: Date.now() + QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS,
    id: args.queuedMessageId,
    threadId: args.threadId,
  });

  switch (result.kind) {
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "claimed":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    case "held":
      return { leaseMs: QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS };
  }
}

export function requestEditReleasedQueuedMessageDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  requestQueuedMessageDispatch(deps, {
    kind: "edit-released",
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });
}

export function releaseQueuedMessageEditHold(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  if (
    releaseQueuedThreadMessageEditHold(deps.db, {
      id: args.queuedMessageId,
      threadId: args.threadId,
    })
  ) {
    requestEditReleasedQueuedMessageDispatch(deps, args);
  }
}
