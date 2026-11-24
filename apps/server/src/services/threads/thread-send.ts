import {
  getEnvironment,
  getThread,
  requireThreadLifecycleEventApplied,
} from "@omnyo/db";
import type {
  DbConnection,
  DbNotifier,
  DbTransaction,
  EnvironmentRow,
} from "@omnyo/db";
import type {
  ClientTurnRequestId,
  PromptInput,
  QueuedMessageSystemNotice,
  ResolvedThreadExecutionOptions,
  Thread,
  ThreadMaintenanceKind,
  ThreadTurnInitiator,
  TurnRequestTarget,
} from "@omnyo/domain";
import {
  flattenPromptInputGroups,
  isStandaloneBuiltinClearCommand,
} from "@omnyo/domain";
import type { SendMessageRequest } from "@omnyo/server-contract";
import { renderTemplate } from "@omnyo/templates";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  buildThreadStartCommand,
  prepareTurnSubmitCommandPayload,
} from "./thread-commands.js";
import {
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  type AppendedClientTurnRequestWithNotification,
  createClientTurnRequestId,
  getActiveTurnId,
  type TurnRequestRetryMarker,
} from "./thread-events.js";
import { recoverThreadModelOverride } from "./thread-execution-override.js";
import {
  ensureThreadCanStartRequest,
  prepareReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import {
  dispatchTurnDuringReprovision,
  requireReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import { resolveDispatchAuthor } from "./dispatch-author.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import {
  buildThreadStatusChangeMetadata,
  resolveThreadRuntimeState,
} from "./thread-runtime-display.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import {
  inactiveHostUnavailableDetails,
  threadNotWritableReasonForStatus,
  throwHostUnavailable,
  throwSenderThreadInvalid,
  throwThreadNotWritable,
} from "../lib/lifecycle-api-errors.js";
import {
  NotificationBuffer,
  type BufferedTransaction,
} from "../lib/notification-buffer.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import { threadTargetHostId } from "./dispatch-attempt.js";
import { resolvePluginMentionContextInputs } from "../plugins/plugin-mentions.js";
import { clearThreadContext } from "./thread-context-clear.js";
import { withThreadSendGuard } from "./thread-context-mutation-guard.js";
import {
  settleInFlightTurnRequest,
  trackInFlightTurnRequest,
} from "../../internal/turn-completed-events.js";
import {
  prependDeferredFirstTurnContext,
  requireDeferredFirstTurnContextCurrent,
  resolveDeferredFirstTurnContext,
  type GroupedPrompt,
  type PromptWithGroups,
} from "./deferred-first-turn-context.js";
import type { TelemetryEvent } from "../system/telemetry.js";
import { messageSourceNotice } from "./message-source.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import {
  readAutoCompactionBasis,
  recordAutoCompactionBasisSnapshot,
} from "./maintenance-run.js";

type SendThreadMessageMode = SendMessageRequest["mode"];

type TextPromptInput = Extract<PromptInput, { type: "text" }>;

type SendThreadMessageTrigger = "auto-dispatch" | "user";

type SendThreadMessagePayload = SendMessageRequest & {
  inputGroups?: PromptInput[][];
};

interface SendThreadMessageArgs {
  preparation?: {
    execution: ResolvedThreadExecutionOptions;
    attachmentInputs: ReadonlySet<PromptInput>;
  };
  beforeAppendInTransaction?: SendThreadMessageTransactionPreflight;
  systemContinuation?: boolean;
  maintenance?: ThreadMaintenanceKind;

  retryOf?: TurnRequestRetryMarker;
  environment: EnvironmentRow;
  historyReplacement?: {
    forkSourceProviderThreadId: string | null;
    onCommandSettled?: () => void | Promise<void>;
  };
  payload: SendThreadMessagePayload;
  systemNotice?: QueuedMessageSystemNotice;
  thread: Thread;
  trigger: SendThreadMessageTrigger;
}

interface ResolveMessageSenderArgs {
  senderThreadId?: string;
  targetThread: Thread;
}

interface FormatAgentThreadInputArgs {
  input: PromptInput[];
  senderThreadId: string;
}

interface BuildAgentThreadMessageTextArgs {
  messageText: string;
  senderThreadId: string;
}

type SendThreadMessageTransactionPreflightArgs = BufferedTransaction &
  (
    | { kind: "turn"; requestId: ClientTurnRequestId }
    | { kind: "context-clear" }
  );

interface SendThreadMessageQueueRequestArgs {
  hub: DbNotifier;
  requestEventSequence: number;
  tx: DbTransaction;
}

interface SendThreadMessageQueueRequestResult {
  activeThread: Thread | null;
}

export interface SendThreadMessageTransactionPreflight {
  (args: SendThreadMessageTransactionPreflightArgs): void;
}

interface SendThreadMessageQueueRequest {
  (
    args: SendThreadMessageQueueRequestArgs,
  ): SendThreadMessageQueueRequestResult;
}

interface AppendAndQueueSendThreadMessageArgs {
  retryOf?: TurnRequestRetryMarker;
  beforeAppendInTransaction?: SendThreadMessageTransactionPreflight;
  db: DbConnection;
  hub: DbNotifier;
  environmentId: string | null;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  maintenance: ThreadMaintenanceKind | undefined;
  messageNotice: QueuedMessageSystemNotice | null;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  queueInTransaction: SendThreadMessageQueueRequest;
  requestId: ClientTurnRequestId;
  senderThreadId: string | null;
  systemNotice: QueuedMessageSystemNotice | undefined;
  target: TurnRequestTarget;
  thread: Thread;
}

interface AppendAndQueueSendThreadMessageResult {
  activeThread: Thread | null;
  request: AppendedClientTurnRequestWithNotification;
}

export function ensureThreadIsNotAwaitingUserInteraction(
  deps: Pick<AppDeps, "pendingInteractions">,
  threadId: string,
): void {
  if (
    !deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(threadId)
  ) {
    return;
  }

  throw new ApiError(
    409,
    "awaiting_user_interaction",
    "Thread is awaiting user interaction. Resolve the pending interaction before sending another prompt.",
  );
}

export function ensureThreadIsWritable(
  thread: Thread,
  allowStopping = false,
): void {
  if (thread.archivedAt) {
    throwThreadNotWritable(thread, "archived", "Thread is archived");
  }

  if (thread.status === "stopping" && !allowStopping) {
    throwThreadNotWritable(thread, "stopping", "Thread is stopping");
  }

  if (thread.deletedAt !== null) {
    throwThreadNotWritable(thread, "deleted", "Thread is deleted");
  }
}

export function ensureThreadQueueIsWritable(thread: Thread): void {
  ensureThreadIsWritable(thread, true);
}

function resolveSendMode(
  thread: Thread,
  requestedMode: SendThreadMessageMode,
): "start" | "auto" | "steer" {
  if (requestedMode === "start") {
    if (thread.status === "active") {
      throwThreadNotWritable(
        thread,
        "already_active",
        "Thread is already active",
      );
    }

    return "start";
  }

  if (requestedMode === "steer" || requestedMode === "steer-if-active") {
    if (thread.status === "active") {
      return "steer";
    }

    if (
      thread.status === "idle" ||
      (requestedMode === "steer-if-active" && thread.status === "error")
    ) {
      return "start";
    }

    throwThreadNotWritable(
      thread,
      threadNotWritableReasonForStatus(thread.status),
      "Thread is not active",
    );
  }

  if (requestedMode === "queue-if-active") {
    if (thread.status === "active") {
      throwThreadNotWritable(
        thread,
        "already_active",
        "Thread is already active",
      );
    }

    return "start";
  }

  if (thread.status === "active") {
    return "auto";
  }

  return "start";
}

function ensureRuntimeCanAcceptActiveSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: Pick<SendThreadMessageArgs, "environment" | "thread">,
): void {
  if (args.thread.status !== "active") {
    return;
  }

  const runtime = resolveThreadRuntimeState(deps, {
    environmentHostId: args.environment.hostId,
    status: args.thread.status,
  });

  if (runtime.displayStatus === "active") {
    return;
  }

  throwHostUnavailable(
    502,
    "Host daemon is not connected",
    inactiveHostUnavailableDetails(),
  );
}

export function resolveMessageSenderThreadId(
  deps: Pick<AppDeps, "db">,
  args: ResolveMessageSenderArgs,
): string | null {
  if (!args.senderThreadId || args.senderThreadId === args.targetThread.id) {
    return null;
  }

  const senderThread = getThread(deps.db, args.senderThreadId);

  if (!senderThread) {
    throwSenderThreadInvalid("not_found");
  }

  if (senderThread.deletedAt !== null) {
    throwSenderThreadInvalid("deleted");
  }

  return senderThread.id;
}

function buildAgentThreadMessageText(
  args: BuildAgentThreadMessageTextArgs,
): string {
  return renderTemplate("agentThreadMessage", {
    messageText: args.messageText,
    senderThreadId: args.senderThreadId,
  });
}

export function formatAgentThreadInput(
  args: FormatAgentThreadInputArgs,
): PromptInput[] {
  const firstTextIndex = args.input.findIndex((item) => item.type === "text");

  if (firstTextIndex === -1) {
    const textItem: TextPromptInput = {
      type: "text",
      text: buildAgentThreadMessageText({
        messageText: "",
        senderThreadId: args.senderThreadId,
      }),
      mentions: [],
    };

    return [textItem, ...args.input];
  }

  return args.input.map((item, index) => {
    if (index !== firstTextIndex || item.type !== "text") {
      return item;
    }

    return {
      ...item,
      text: buildAgentThreadMessageText({
        messageText: item.text,
        senderThreadId: args.senderThreadId,
      }),
    };
  });
}

export function appendPluginMentionContext(
  prompt: GroupedPrompt,
): Promise<GroupedPrompt>;
export function appendPluginMentionContext(
  prompt: PromptWithGroups,
): Promise<PromptWithGroups>;
export async function appendPluginMentionContext(
  prompt: PromptWithGroups,
): Promise<PromptWithGroups> {
  const pluginMentionContext = await resolvePluginMentionContextInputs(
    prompt.input,
  );

  if (pluginMentionContext.length === 0) {
    return prompt;
  }

  const inputGroups = prompt.inputGroups;

  return {
    input: [...prompt.input, ...pluginMentionContext],
    ...(inputGroups !== undefined
      ? {
          inputGroups:
            inputGroups.length > 0
              ? [
                  ...inputGroups.slice(0, -1),
                  [
                    ...inputGroups[inputGroups.length - 1]!,
                    ...pluginMentionContext,
                  ],
                ]
              : inputGroups,
        }
      : {}),
  };
}

type UserMessageSentProperties = Extract<
  TelemetryEvent,
  { name: "user_message_sent" }
>["properties"];

export function captureUserMessageSentTelemetry(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "telemetry">,
  args: {
    isChildThread: boolean;
    messageSource: UserMessageSentProperties["message_source"];
  },
): void {
  deps.telemetry.capture({
    name: "user_message_sent",
    properties: {
      is_child_thread: args.isChildThread,
      message_source: args.messageSource,
    },
  });
}

function appendAndQueueSendThreadMessageInTransaction({
  retryOf,
  beforeAppendInTransaction,
  db,
  hub,
  environmentId,
  execution,
  initiator,
  maintenance,
  messageNotice,
  input,
  inputGroups,
  queueInTransaction,
  requestId,
  senderThreadId,
  systemNotice,
  target,
  thread,
}: AppendAndQueueSendThreadMessageArgs): AppendAndQueueSendThreadMessageResult {
  let activeThread: Thread | null = null;
  const notifications = new NotificationBuffer();

  const request = db.transaction(
    (tx) => {
      assertThreadHostAcceptsWork(tx, thread);
      beforeAppendInTransaction?.({
        kind: "turn",
        requestId,
        tx,
        notifications,
      });

      const maintenanceBasis =
        maintenance === undefined
          ? null
          : readAutoCompactionBasis(tx, thread.id);

      const appended =
        appendPreparedClientTurnRequestedEventWithNotificationInTransaction(
          { db: tx, hub: notifications },
          {
            threadId: thread.id,
            environmentId,
            type: "client/turn/requested",
            ...(retryOf !== undefined ? { retryOf } : {}),
            input,
            ...(inputGroups !== undefined ? { inputGroups } : {}),
            execution,
            initiator,
            systemMessageKind: messageNotice?.kind,
            systemMessageSubject: messageNotice?.subject,
            senderThreadId,
            ...(systemNotice !== undefined
              ? {
                  systemMessageKind: systemNotice.kind,
                  systemMessageSubject: systemNotice.subject,
                }
              : {}),
            ...(maintenance !== undefined ? { maintenance } : {}),
            requestMethod: "turn/start",
            source: "tell",
            target,
            requestId,
          },
        );

      if (maintenanceBasis !== null) {
        recordAutoCompactionBasisSnapshot(tx, {
          threadId: thread.id,
          requestSequence: appended.sequence,
          conversation: maintenanceBasis,
        });
      }

      recordAcceptedPromptHistoryEntry(
        { db: tx },
        {
          thread,
          input,
          initiator,
          target,
          requestSequence: appended.sequence,
        },
      );

      const queueResult = queueInTransaction({
        hub: notifications,
        requestEventSequence: appended.sequence,
        tx,
      });

      activeThread = queueResult.activeThread;

      return appended;
    },
    { behavior: "immediate" },
  );

  notifications.flushInto(hub);

  return {
    activeThread,
    request,
  };
}

export async function sendThreadMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendThreadMessageArgs,
): Promise<void> {
  if (isStandaloneBuiltinClearCommand(args.payload.input)) {
    const beforeAppendInTransaction = args.beforeAppendInTransaction;
    await clearThreadContext(deps, {
      ...(beforeAppendInTransaction !== undefined
        ? {
            beforeCommitInTransaction: (transaction) =>
              beforeAppendInTransaction({
                ...transaction,
                kind: "context-clear",
              }),
          }
        : {}),
      environment: args.environment,
      thread: args.thread,
    });

    return;
  }

  return withThreadSendGuard(args.thread.id, () =>
    sendThreadMessageWithoutContextClear(deps, args),
  );
}

async function sendThreadMessageWithoutContextClear(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendThreadMessageArgs,
): Promise<void> {
  const { environment, payload, thread } = args;
  ensureThreadIsWritable(thread);

  if (args.trigger === "user") {
    ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);
  }

  const mode = resolveSendMode(thread, payload.mode);
  ensureRuntimeCanAcceptActiveSend(deps, args);

  if (mode === "start") {
    ensureThreadCanStartRequest(thread);
  }

  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });

  let inputGroups = payload.inputGroups
    ? payload.inputGroups.map((inputGroup) =>
        senderThreadId
          ? formatAgentThreadInput({
              input: inputGroup,
              senderThreadId,
            })
          : inputGroup,
      )
    : undefined;

  let input =
    inputGroups !== undefined
      ? flattenPromptInputGroups(inputGroups)
      : senderThreadId
        ? formatAgentThreadInput({
            input: payload.input,
            senderThreadId,
          })
        : payload.input;

  ({ input, inputGroups } = await appendPluginMentionContext({
    input,
    ...(inputGroups !== undefined ? { inputGroups } : {}),
  }));

  const deferredFirstTurnContext =
    args.retryOf === undefined
      ? resolveDeferredFirstTurnContext(deps.db, thread.id)
      : null;

  ({ input, inputGroups } = prependDeferredFirstTurnContext(
    { input, ...(inputGroups !== undefined ? { inputGroups } : {}) },
    deferredFirstTurnContext,
  ));

  const beforeAppendInTransaction: SendThreadMessageTransactionPreflight = (
    acceptance,
  ) => {
    const { tx } = acceptance;
    args.beforeAppendInTransaction?.(acceptance);

    if (deferredFirstTurnContext) {
      requireDeferredFirstTurnContextCurrent(tx, {
        requestSequence: deferredFirstTurnContext.requestSequence,
        threadId: thread.id,
      });
    }
  };

  const preparedAttachmentInputs = args.preparation?.attachmentInputs;

  const unpreparedInput =
    preparedAttachmentInputs === undefined
      ? input
      : input.filter((item) => !preparedAttachmentInputs.has(item));

  const resolvedUnpreparedInput = await resolvePromptAttachmentReferences({
    db: deps.db,
    dataDir: deps.config.dataDir,
    input: unpreparedInput,
    projectId: thread.projectId,
    hostId: threadTargetHostId(deps, thread),
  });

  const resolvedByInput = new Map(
    unpreparedInput.map((item, index) => [
      item,
      resolvedUnpreparedInput[index]!,
    ]),
  );

  input = input.map((item) => resolvedByInput.get(item) ?? item);
  inputGroups = inputGroups?.map((group) =>
    group.map((item) => resolvedByInput.get(item) ?? item),
  );

  const { initiator } = resolveDispatchAuthor({
    ...(args.maintenance !== undefined
      ? { maintenance: args.maintenance }
      : {}),
    retrying: args.retryOf !== undefined || args.systemContinuation === true,
    systemNotice: args.systemNotice !== undefined,
    senderThreadId,
    startedOnBehalfOf: null,
  });

  const messageNotice = messageSourceNotice(
    payload.messageSource,
    senderThreadId,
  );

  const shouldCaptureUserMessageSent =
    args.trigger === "user" &&
    initiator === "user" &&
    input.length > 0 &&
    args.retryOf === undefined &&
    args.systemNotice === undefined &&
    args.systemContinuation !== true;

  const expectedSteerTurnId =
    mode === "auto" || mode === "steer"
      ? getActiveTurnId(deps, thread.id)
      : null;

  if (
    senderThreadId === null &&
    args.retryOf === undefined &&
    args.systemContinuation !== true &&
    args.systemNotice === undefined &&
    args.maintenance === undefined
  ) {
    await recoverThreadModelOverride(deps, {
      model: payload.model,
      modelSource:
        payload.executionInputSources === undefined
          ? "explicit"
          : payload.executionInputSources.model,
      reasoningLevel: payload.reasoningLevel,
      reasoningLevelSource:
        payload.executionInputSources === undefined
          ? "explicit"
          : payload.executionInputSources.reasoningLevel,
      thread,
    });
  }

  const execution =
    args.preparation?.execution ??
    (await buildExecutionOptions(deps, payload, {
      threadId: thread.id,
    }));

  const permissionEscalation = resolvePermissionEscalation({
    initiator,
  });

  const requestId = payload.requestId ?? createClientTurnRequestId();

  if (
    args.maintenance === undefined &&
    (await dispatchTurnDuringReprovision({
      beforeRequestAppendInTransaction: (transaction) =>
        beforeAppendInTransaction({ ...transaction, kind: "turn", requestId }),
      deps,
      environment,
      execution,
      initiator,
      input,
      inputGroups,
      requestId,
      ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
      senderThreadId,
      systemMessageKind: (args.systemNotice ?? messageNotice)?.kind,
      systemMessageSubject: (args.systemNotice ?? messageNotice)?.subject,
      thread,
    }))
  ) {
    if (shouldCaptureUserMessageSent) {
      captureUserMessageSentTelemetry(deps, {
        isChildThread: thread.parentThreadId !== null,
        messageSource: "thread_send",
      });
    }

    return;
  }

  const readyEnvironment = requireReadyThreadEnvironment(
    getEnvironment(deps.db, environment.id) ?? environment,
  );

  let target: TurnRequestTarget;

  if (mode === "start") {
    target = {
      kind:
        args.historyReplacement !== undefined &&
        args.historyReplacement.forkSourceProviderThreadId === null
          ? "thread-start"
          : "new-turn",
    };
  } else {
    target = {
      kind: mode,
      expectedTurnId: expectedSteerTurnId,
    };
  }

  if (mode === "start") {
    const commandArgs = {
      thread,
      fork: null,
      input,
      ...(inputGroups !== undefined ? { inputGroups } : {}),
      requestId,
      execution,
      permissionEscalation,
      environment: {
        id: readyEnvironment.id,
        hostId: readyEnvironment.hostId,
        path: readyEnvironment.path,
        status: readyEnvironment.status,
      },
      projectId: thread.projectId,
      providerId: thread.providerId,
      syncGeneratedTitle: false,
    };

    const command = args.historyReplacement
      ? {
          command: await buildThreadStartCommand(deps, {
            ...commandArgs,
            fork:
              args.historyReplacement.forkSourceProviderThreadId === null
                ? null
                : {
                    sourceProviderThreadId:
                      args.historyReplacement.forkSourceProviderThreadId,
                    restoreArchivedSource: true,
                  },
          }),
          mode: "thread.start" as const,
        }
      : await prepareReadyThreadTurnCommand(deps, commandArgs);

    const queuedRequest = appendAndQueueSendThreadMessageInTransaction({
      ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
      beforeAppendInTransaction: (acceptance) => {
        beforeAppendInTransaction(acceptance);
        ensureThreadCanStartRequest(thread);
      },
      db: deps.db,
      hub: deps.hub,
      environmentId: thread.environmentId,
      execution,
      initiator,
      maintenance: args.maintenance,
      messageNotice,
      input,
      inputGroups,
      queueInTransaction: ({ hub, tx }) => {
        const dispatchKind = command.mode;
        const currentThread = getThread(tx, thread.id);

        if (
          dispatchKind === "turn.submit" ||
          currentThread?.status === "error" ||
          currentThread?.status === "idle"
        ) {
          return {
            activeThread: requireThreadLifecycleEventApplied(
              applyLoggedThreadLifecycleEventInTransaction(
                { db: tx, hub, logger: deps.logger },
                { event: { type: "run.started" }, threadId: thread.id },
              ),
            ),
          };
        }

        return { activeThread: null };
      },
      requestId,
      senderThreadId,
      systemNotice: args.systemNotice,
      target,
      thread,
    });

    deps.hub.notifyThread(
      thread.id,
      queuedRequest.request.notificationChanges,
      queuedRequest.request.notificationMetadata,
    );

    const onHistoryReplacementSettled =
      args.historyReplacement?.onCommandSettled;

    trackInFlightTurnRequest(thread.id);
    startLiveHostCommand(deps, {
      command: command.command,
      hostId: readyEnvironment.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
      onSettled: async () => {
        try {
          await onHistoryReplacementSettled?.();
        } finally {
          await settleInFlightTurnRequest(deps, thread.id);
        }
      },
      onError: ({ error }) => {
        deps.logger.warn(
          { err: error, threadId: thread.id },
          "Live ready turn command failed",
        );
      },
    });

    if (queuedRequest.activeThread) {
      deps.hub.notifyThread(
        thread.id,
        ["status-changed"],
        buildThreadStatusChangeMetadata(deps, queuedRequest.activeThread),
      );
    }

    if (shouldCaptureUserMessageSent) {
      captureUserMessageSentTelemetry(deps, {
        isChildThread: thread.parentThreadId !== null,
        messageSource: "thread_send",
      });
    }

    return;
  }

  await ensureHostSessionReadyForWork(deps, {
    hostId: readyEnvironment.hostId,
  });

  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
    thread,
    input,
    ...(inputGroups !== undefined ? { inputGroups } : {}),
    execution,
    permissionEscalation,
    target: {
      mode,
      expectedTurnId: expectedSteerTurnId,
    },
    environment: {
      id: readyEnvironment.id,
      hostId: readyEnvironment.hostId,
      path: readyEnvironment.path,
      status: readyEnvironment.status,
    },
  });

  const command = addRequestIdToTurnSubmitCommandPayload({
    preparedCommand,
    requestId,
  });

  const queuedRequest = appendAndQueueSendThreadMessageInTransaction({
    ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
    beforeAppendInTransaction,
    db: deps.db,
    hub: deps.hub,
    environmentId: thread.environmentId,
    execution,
    initiator,
    maintenance: args.maintenance,
    messageNotice,
    input,
    inputGroups,
    queueInTransaction: () => {
      return { activeThread: null };
    },
    requestId,
    senderThreadId,
    systemNotice: args.systemNotice,
    target,
    thread,
  });

  deps.hub.notifyThread(
    thread.id,
    queuedRequest.request.notificationChanges,
    queuedRequest.request.notificationMetadata,
  );
  trackInFlightTurnRequest(thread.id);
  startLiveHostCommand(deps, {
    command,
    hostId: readyEnvironment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: thread.id },
        "Live turn submit command failed",
      );
    },
    onSettled: () => settleInFlightTurnRequest(deps, thread.id),
  });

  if (shouldCaptureUserMessageSent) {
    captureUserMessageSentTelemetry(deps, {
      isChildThread: thread.parentThreadId !== null,
      messageSource: "thread_send",
    });
  }
}
