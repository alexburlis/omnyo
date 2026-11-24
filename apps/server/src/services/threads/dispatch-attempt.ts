import { messageSourceNotice } from "./message-source.js";
import {
  requestQueuedMachineReadiness,
  requestQueuedMessageDispatch,
} from "./queued-message-dispatch.js";
import {
  isHostUpdateDraining,
  isServerUpdateDraining,
} from "../system/server-update-drain.js";
import {
  cancelPreparingMachinePause,
  isMachineWaitingForExecution,
} from "../machines/lifecycle.js";
import {
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getEnvironment,
  getHost,
  type EnvironmentRow,
  getThread,
  isThreadQueueAutoSendPaused,
  listRunningThreads,
  type ClaimedQueuedThreadMessageRow,
  type RunningThreadRow,
} from "@omnyo/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  promptInputSchema,
  type PromptInput,
  type QueuedMessagePayload,
  type QueuedMessageDeliveryMode,
  type QueuedMessageSystemNotice,
  type QueuedMessageWaitingOn,
  type ResolvedThreadExecutionOptions,
  startedOnBehalfOfSchema,
  type StartedOnBehalfOf,
  type Thread,
  type ThreadCreateOrigin,
  type ThreadMaintenanceKind,
  type ThreadQueuedMessage,
} from "@omnyo/domain";
import type { SendMessageRequest } from "@omnyo/server-contract";
import type {
  MessageDispatchHookContext,
  PluginDispatchEnvironmentIntent,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import {
  admitDispatch,
  claimRetryForRequest,
  markOwnerFailureOverride,
  overridesOpenFailure,
  resolveFailuresForOverride,
} from "../inbox/engine.js";
import { linkDispatchedQueueRows } from "../inbox/waits.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import {
  NotificationBuffer,
  type BufferedTransaction,
} from "../lib/notification-buffer.js";
import {
  goneThreadEnvironmentDetails,
  throwThreadNotWritable,
} from "../lib/lifecycle-api-errors.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import {
  dispatchEnvironmentAndHost,
  dispatchExecutionSources,
  dispatchWaitReasonForPass,
  hasMessageDispatchHooks,
  noteDispatchRequeued,
  runMessageDispatchHookPass,
  type DispatchAttemptKind,
} from "./dispatch-hooks.js";
import {
  createQueuedMessageAutoSendPausedError,
  createQueuedMessageClaimLostError,
  recordQueuedMessageWait,
  settleQueueRowDispatched,
  type QueuedDispatchMessage,
} from "./queue-waits.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  getActiveTurnId,
  isActiveTurnMainRunIdle,
  isManualCompactionActive,
} from "./thread-events.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import {
  requestThreadProvision,
  scheduleThreadProvisioningAdvance,
} from "./thread-provisioning.js";
import {
  threadForkDescriptorSchema,
  threadProvisionEnvironmentIntentSchema,
} from "./thread-startup-store.js";
import {
  readThreadProvisionContext,
  readThreadStartupContextOfKind,
} from "./thread-startup-store.js";
import {
  buildThreadStatusChangeMetadata,
  toThreadResponseFromThread,
} from "./thread-runtime-display.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import { isPreStartThreadStatus } from "./thread-status.js";
import { queueInputForStartingTurn } from "./thread-turn-starting.js";
import {
  ensureThreadIsWritable,
  formatAgentThreadInput,
  resolveMessageSenderThreadId,
  sendThreadMessage,
  type SendThreadMessageTransactionPreflight,
} from "./thread-send.js";
import {
  resolveDispatchAuthor,
  type DispatchAuthor,
} from "./dispatch-author.js";
import type { TurnRequestRetryMarker } from "./thread-events.js";
import { restoreInterruptedThreadStartupRequest } from "./thread-provisioning.js";
import { reportProvisioningNote } from "./thread-environment-placement.js";
import { markTurnTraceSpan } from "../system/turn-trace.js";

export const pendingThreadStartContextSchema = z.object({
  environmentIntent: threadProvisionEnvironmentIntentSchema,
  fork: threadForkDescriptorSchema.nullable(),

  providerInput: z.array(promptInputSchema).optional(),
  startedOnBehalfOf: startedOnBehalfOfSchema.nullable(),
  titleProvided: z.boolean(),
  machinePinned: z.boolean().default(true),
  moveNote: z.string().min(1).max(200).nullable().default(null),
});

export type PendingThreadStartContext = z.infer<
  typeof pendingThreadStartContextSchema
>;

export function readPendingThreadStartContext(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): PendingThreadStartContext | null {
  return readThreadStartupContextOfKind(
    deps.db,
    threadId,
    "pending",
    pendingThreadStartContextSchema,
  );
}

export function hostIdForEnvironmentIntent(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  intent: PendingThreadStartContext["environmentIntent"],
): string | null {
  if (intent.type === "reuse") {
    return getEnvironment(deps.db, intent.environmentId)?.hostId ?? null;
  }

  return intent.machine.type === "existing" ? intent.machine.hostId : null;
}

function toPluginEnvironmentIntent(
  intent: PendingThreadStartContext["environmentIntent"],
): PluginDispatchEnvironmentIntent {
  switch (intent.type) {
    case "reuse":
      return { kind: "environment", environmentId: intent.environmentId };
    case "provider":
      return {
        kind: "provider",
        environmentProviderId: intent.environmentProviderId,
        machine: intent.machine,
        inputs: intent.inputs,
      };
  }
}

function intendedThreadIntent(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): PendingThreadStartContext["environmentIntent"] | null {
  return (
    readThreadProvisionContext(deps.db, threadId)?.request.environmentIntent ??
    readPendingThreadStartContext(deps, threadId)?.environmentIntent ??
    null
  );
}

export function intendedThreadEnvironmentIntent(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  thread: Pick<Thread, "id" | "environmentId">,
): PluginDispatchEnvironmentIntent | null {
  if (thread.environmentId !== null) {
    return { kind: "environment", environmentId: thread.environmentId };
  }

  const intent = intendedThreadIntent(deps, thread.id);

  return intent === null ? null : toPluginEnvironmentIntent(intent);
}

export function intendedThreadHostId(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): string | null {
  const intent = intendedThreadIntent(deps, threadId);

  return intent === null ? null : hostIdForEnvironmentIntent(deps, intent);
}

export function threadTargetHostId(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  thread: Pick<Thread, "id" | "environmentId">,
): string | null {
  return thread.environmentId !== null
    ? (getEnvironment(deps.db, thread.environmentId)?.hostId ?? null)
    : intendedThreadHostId(deps, thread.id);
}

export function listRunningThreadsWithIntendedHosts(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): RunningThreadRow[] {
  return listRunningThreads(deps.db).map((row) =>
    row.hostId !== null
      ? row
      : { ...row, hostId: intendedThreadHostId(deps, row.id) },
  );
}

export type DispatchAttemptSource =
  | { kind: "inline" }
  | {
      kind: "drain";
      claimed: ClaimedQueuedThreadMessageRow[];
      respectManualStopPause: boolean;

      sendNow: boolean;
    }
  | {
      kind: "operation";
      environment: EnvironmentRow;
      maintenance?: ThreadMaintenanceKind;
      beforeAppendInTransaction?: SendThreadMessageTransactionPreflight;
      historyReplacement?: {
        forkSourceProviderThreadId: string | null;
        onCommandSettled?: () => void | Promise<void>;
      };
    };

export interface DispatchAttemptArgs {
  thread: Thread;
  payload: SendMessageRequest & { inputGroups?: PromptInput[][] };
  source: DispatchAttemptSource;

  startContext?: PendingThreadStartContext;

  queuePayload: QueuedMessagePayload;
  pluginSubmission: MessageDispatchHookContext["experimental_submission"];
  systemNotice: QueuedMessageSystemNotice | null;
  retryOf?: TurnRequestRetryMarker;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  startedOnBehalfOf: StartedOnBehalfOf | null;

  executionDefaults?: Parameters<typeof buildExecutionOptions>[2];
  trigger: "auto-dispatch" | "user";
}

export type DispatchAttemptOutcome =
  | { kind: "dispatched" }
  | { kind: "queued"; entry: ThreadQueuedMessage };

export function resolveDispatchAttemptKind(
  thread: Thread,
  mode: SendMessageRequest["mode"],
): DispatchAttemptKind {
  if (thread.status !== "active") return "start-turn";

  return mode === "steer" || mode === "steer-if-active" || mode === "auto"
    ? "join-turn"
    : "start-turn";
}

function dispatchStarter(
  args: DispatchAttemptArgs,
  author: { initiator: string },
  message: QueuedDispatchMessage,
  sendNow: boolean,
): "owner" | "owner-override" | "retry" | "other" {
  if (args.retryOf !== undefined || args.queuePayload.kind === "retry")
    return "retry";

  if (args.queuePayload.kind === "continuation") return "owner-override";

  if (author.initiator !== "user" || message.systemNotice !== null)
    return "other";

  return sendNow ? "owner-override" : "owner";
}

export function attemptDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
): Promise<DispatchAttemptOutcome> {
  return runDispatchAttempt(deps, args, {
    deliveryMode: deliveryModeForSendMode(args.payload.mode),
    reattempted: false,
  });
}

function deliveryModeForSendMode(
  mode: SendMessageRequest["mode"],
): QueuedMessageDeliveryMode {
  return mode === "queue-if-active" || mode === "start" ? "queue" : "steer";
}

async function runOperationDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
  source: Extract<DispatchAttemptSource, { kind: "operation" }>,
): Promise<DispatchAttemptOutcome> {
  await sendThreadMessage(deps, {
    environment: source.environment,
    payload: args.payload,
    thread: args.thread,
    trigger: args.trigger,
    ...(source.maintenance !== undefined
      ? { maintenance: source.maintenance }
      : {}),
    ...(source.beforeAppendInTransaction !== undefined
      ? { beforeAppendInTransaction: source.beforeAppendInTransaction }
      : {}),
    ...(source.historyReplacement !== undefined
      ? { historyReplacement: source.historyReplacement }
      : {}),
  });

  return { kind: "dispatched" };
}

interface DispatchAttemptRun {
  deliveryMode: QueuedMessageDeliveryMode;
  reattempted: boolean;
}

async function runDispatchAttempt(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
  run: DispatchAttemptRun,
): Promise<DispatchAttemptOutcome> {
  const { thread } = args;
  let { payload } = args;

  if (args.source.kind === "operation") {
    return runOperationDispatch(deps, args, args.source);
  }

  ensureThreadIsWritable(thread, true);
  assertThreadHostAcceptsWork(deps.db, thread);

  if (
    payload.mode === "queue-if-active" &&
    isActiveTurnMainRunIdle(deps, thread)
  ) {
    payload = {
      ...payload,
      mode: args.source.kind === "drain" ? "auto" : "steer-if-active",
    };
    args = { ...args, payload };
  }

  if (args.trigger === "user" && args.source.kind === "inline") {
    const input = await resolvePromptAttachmentReferences({
      db: deps.db,
      dataDir: deps.config.dataDir,
      input: payload.input,
      projectId: thread.projectId,
      hostId: threadTargetHostId(deps, thread),
    });

    payload = { ...payload, input };
    args = { ...args, payload };
  }

  const senderThreadId = resolveMessageSenderThreadId(deps, {
    ...(payload.senderThreadId !== undefined
      ? { senderThreadId: payload.senderThreadId }
      : {}),
    targetThread: thread,
  });

  const systemNotice = args.systemNotice;

  const interruptedStartupRequest =
    systemNotice === null &&
    (thread.status === "error" || thread.status === "idle") &&
    thread.environmentId === null
      ? await restoreInterruptedThreadStartupRequest(deps, thread.id)
      : null;

  const firstDispatch =
    systemNotice === null &&
    (thread.status === "pending" || interruptedStartupRequest !== null);

  const retryStartContext: PendingThreadStartContext | null =
    interruptedStartupRequest === null
      ? null
      : {
          environmentIntent: interruptedStartupRequest.environmentIntent,
          fork: interruptedStartupRequest.fork,
          startedOnBehalfOf: args.startedOnBehalfOf,
          titleProvided: interruptedStartupRequest.titleProvided,
          machinePinned: true,
          moveNote: null,
        };

  const author = resolveDispatchAuthor({
    retrying:
      args.retryOf !== undefined || args.queuePayload.kind === "continuation",
    systemNotice: systemNotice !== null,
    senderThreadId,
    startedOnBehalfOf: args.startedOnBehalfOf,
  });

  const claimed = args.source.kind === "drain" ? args.source.claimed : null;

  const sendNow =
    args.source.kind === "drain"
      ? args.source.sendNow
      : payload.sendNow === true;

  const respectManualStopPause =
    args.source.kind === "drain" && args.source.respectManualStopPause;

  const attempt = resolveDispatchAttemptKind(thread, payload.mode);

  const execution = await buildExecutionOptions(
    deps,
    payload,
    args.executionDefaults ?? { threadId: thread.id },
  );

  if (payload.compactFirst) {
    const { compactFirst, ...request } = payload;
    const currentThread = getThread(deps.db, thread.id);

    if (currentThread === null) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    if (currentThread.status !== "active") {
      await compactThreadContext(deps, currentThread);
    }

    payload = request;
    args = { ...args, payload };
  }

  const resolvedPayload = resolveExecutionIntoPayload(payload, execution);

  const queuedMessage: QueuedDispatchMessage = {
    input: payload.input,
    execution,
    senderThreadId,
    origin: args.origin,
    originPluginId: args.originPluginId,
    requestedBy: args.startedOnBehalfOf,
    payload: args.queuePayload,
    systemNotice:
      systemNotice ??
      messageSourceNotice(payload.messageSource, senderThreadId),
    deliveryMode: run.deliveryMode,
  };

  const waitOn = (
    waitingOn: QueuedMessageWaitingOn,
    sendAt: number | null,
  ): DispatchAttemptOutcome => {
    const entry = recordQueuedMessageWait(deps, {
      thread,
      message: queuedMessage,
      waitingOn,
      sendAt:
        !sendNow && (payload.sendAt ?? 0) > Date.now()
          ? Math.max(payload.sendAt ?? 0, sendAt ?? 0)
          : sendAt,
      claimed,
    });

    if (entry === null) {
      return { kind: "dispatched" };
    }

    return { kind: "queued", entry };
  };

  const admitted: { value: PendingThreadAdmission | null } = {
    value: null,
  };

  const continued: {
    outcome: DispatchAttemptOutcome | null;
    reattemptThread: Thread | null;
  } = {
    outcome: null,
    reattemptThread: null,
  };

  const continueThroughCoreWaits = async (): Promise<void> => {
    const sendAt = payload.sendAt ?? null;

    if (!sendNow && sendAt !== null && sendAt > Date.now()) {
      continued.outcome = waitOn({ kind: "time" }, sendAt);

      return;
    }

    if (thread.status === "stopping") {
      continued.outcome = waitOn({ kind: "stopping" }, null);

      return;
    }

    const currentThread = getThread(deps.db, thread.id);

    if (currentThread === null) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    if (
      currentThread.status !== thread.status ||
      currentThread.environmentId !== thread.environmentId ||
      currentThread.archivedAt !== thread.archivedAt ||
      currentThread.deletedAt !== thread.deletedAt
    ) {
      continued.reattemptThread = currentThread;

      return;
    }

    if (systemNotice !== null && thread.environmentId === null) {
      continued.outcome = waitOn({ kind: "provisioning" }, null);

      return;
    }

    if (thread.status === "active" && payload.mode === "start") {
      throwThreadNotWritable(
        thread,
        "already_active",
        "Thread is already active",
      );
    }

    if (
      args.source.kind === "inline" ||
      (claimed?.some((row) => overridesOpenFailure(deps.db, row)) ?? false)
    ) {
      const starter = dispatchStarter(args, author, queuedMessage, sendNow);

      if (
        admitDispatch(deps.db, { threadId: thread.id, starter }) === "pause"
      ) {
        continued.outcome = waitOn({ kind: "thread-busy" }, null);

        return;
      }

      if (starter === "owner" || starter === "owner-override")
        resolveFailuresForOverride(deps.db, {
          threadId: thread.id,
          now: Date.now(),
          by: "owner",
        });
    }

    const { environment: dispatchEnvironment, host: dispatchHost } =
      dispatchEnvironmentAndHost(deps, thread.environmentId);

    if (
      dispatchHost !== null &&
      isMachineWaitingForExecution(deps, dispatchHost.id)
    ) {
      cancelPreparingMachinePause(deps, dispatchHost.id);
      continued.outcome = waitOn(
        { kind: "host-offline", hostName: dispatchHost.name },
        null,
      );
      requestQueuedMachineReadiness(deps, dispatchHost.id);

      return;
    }

    if (
      thread.status === "idle" ||
      thread.status === "pending" ||
      thread.status === "error"
    ) {
      const targetHostId = dispatchHost?.id ?? threadTargetHostId(deps, thread);

      const targetHost =
        targetHostId === null ? null : getHost(deps.db, targetHostId);

      if (targetHost !== null && targetHost.availability === "away") {
        continued.outcome = waitOn(
          { kind: "host-away", hostName: targetHost.name },
          null,
        );

        return;
      }
    }

    if (
      isHostUpdateDraining(
        deps,
        dispatchHost?.id ?? threadTargetHostId(deps, thread),
      )
    ) {
      continued.outcome = waitOn({ kind: "server-update" }, null);

      return;
    }

    if (
      thread.status === "active" &&
      (attempt === "start-turn" ||
        (run.deliveryMode === "queue" &&
          !isActiveTurnMainRunIdle(deps, currentThread)))
    ) {
      continued.outcome = waitOn({ kind: "thread-busy" }, null);

      return;
    }

    if (
      (thread.status === "idle" ||
        thread.status === "pending" ||
        thread.status === "error") &&
      isServerUpdateDraining(deps)
    ) {
      continued.outcome = waitOn({ kind: "server-update" }, null);

      return;
    }

    if (
      dispatchEnvironment !== null &&
      goneThreadEnvironmentDetails(dispatchEnvironment) === null &&
      dispatchHost !== null &&
      !deps.hub.hasDaemonForHost(dispatchHost.id)
    ) {
      continued.outcome = waitOn(
        { kind: "host-offline", hostName: dispatchHost.name },
        null,
      );

      return;
    }

    if (payload.mode !== "start" && isManualCompactionActive(deps, thread)) {
      continued.outcome = waitOn({ kind: "thread-busy" }, null);

      return;
    }

    if (
      currentThread.status === "active" &&
      resolveDispatchAttemptKind(currentThread, payload.mode) === "join-turn" &&
      getActiveTurnId(deps, thread.id) === null
    ) {
      const outcome = queueInputForStartingTurn(deps, {
        claimed,
        input: queuedMessage,
        threadId: thread.id,
      });

      if (outcome.kind === "queued" || outcome.kind === "dispatched") {
        continued.outcome = outcome;

        return;
      }

      if (outcome.kind === "retry") {
        continued.reattemptThread = outcome.thread;

        return;
      }
    }

    if (!firstDispatch && isPreStartThreadStatus(thread.status)) {
      continued.outcome = waitOn({ kind: "provisioning" }, null);

      return;
    }

    if (
      payload.mode !== "start" &&
      deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(thread.id)
    ) {
      continued.outcome = waitOn({ kind: "interaction" }, null);

      return;
    }

    if (firstDispatch) {
      admitted.value = await admitPendingThread(deps, {
        author,
        claimed,
        payload:
          senderThreadId === null
            ? resolvedPayload
            : {
                ...resolvedPayload,
                input: formatAgentThreadInput({
                  input: resolvedPayload.input,
                  senderThreadId,
                }),
              },
        respectManualStopPause,
        retryOf: args.retryOf,
        startContext: args.startContext ?? retryStartContext,
        thread,
      });

      if (admitted.value === null) {
        const current = getThread(deps.db, thread.id);
        continued.reattemptThread = current;
      }
    }
  };

  if (!sendNow && hasMessageDispatchHooks()) {
    const outcome = await runMessageDispatchHookPass(deps, {
      thread,
      threadResponse: toThreadResponseFromThread(deps, { thread }),
      project: requirePublicProject(deps.db, thread.projectId),
      environmentId: thread.environmentId,
      intendedHostId:
        thread.environmentId !== null
          ? null
          : intendedThreadHostId(deps, thread.id),
      environmentIntent: intendedThreadEnvironmentIntent(deps, thread),
      input: payload.input,
      requestedExecution: {
        providerId: thread.providerId,
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        serviceTier: execution.serviceTier,
        permissionMode: execution.permissionMode,
      },
      executionSources: dispatchExecutionSources(
        payload.executionInputSources ?? {},
      ),
      attempt,
      initiator: author.initiator,
      senderThreadId: author.senderThreadId,
      origin: args.origin,
      originPluginId: args.originPluginId,
      startedOnBehalfOf: args.startedOnBehalfOf,
      parentThreadId: thread.parentThreadId,
      queuedMessages: claimed?.map(toThreadQueuedMessage) ?? [],
      pluginSubmission: args.pluginSubmission,
      continueAfterHooks: continueThroughCoreWaits,
    });

    if (outcome.kind === "wait") {
      if (claimed !== null) {
        noteDispatchRequeued(thread.id, outcome.waiter.pluginId);
      }

      const held = waitOn(
        {
          kind: "plugin",
          pluginId: outcome.waiter.pluginId,
          reason: dispatchWaitReasonForPass(outcome),
        },
        outcome.waiter.sendAt,
      );

      if (
        held.kind === "queued" &&
        args.source.kind === "inline" &&
        (payload.sendAt ?? 0) <= Date.now() &&
        dispatchStarter(args, author, queuedMessage, sendNow) === "owner"
      )
        markOwnerFailureOverride(deps.db, {
          threadId: thread.id,
          queuedMessageId: held.entry.id,
        });

      return held;
    }
  } else {
    await continueThroughCoreWaits();
  }

  if (continued.outcome !== null) {
    return continued.outcome;
  }

  if (continued.reattemptThread !== null) {
    return reattemptDispatchForThreadChange(
      deps,
      args,
      continued.reattemptThread,
      run,
      waitOn,
    );
  }

  if (firstDispatch) {
    const admission = admitted.value;

    if (admission === null) {
      const current = getThread(deps.db, thread.id);

      return reattemptDispatchForThreadChange(deps, args, current, run, waitOn);
    }

    await launchAdmittedThread(deps, admission);

    return { kind: "dispatched" };
  }

  markTurnTraceSpan("dispatch.checkpoint.done");
  const environment = await requireThreadCommandEnvironment(deps, { thread });

  try {
    await sendThreadMessage(deps, {
      preparation: {
        execution,
        attachmentInputs: new Set<PromptInput>(
          args.trigger === "user" && args.source.kind === "inline"
            ? payload.input
            : [],
        ),
      },
      environment,
      payload: resolvedPayload,
      thread,
      trigger: args.trigger,
      systemContinuation: args.queuePayload.kind === "continuation",
      ...(systemNotice !== null ? { systemNotice } : {}),
      ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
      beforeAppendInTransaction: (acceptance) => {
        const { tx } = acceptance;
        const current = getThread(tx, thread.id);

        if (
          current?.status !== thread.status ||
          (!sendNow &&
            run.deliveryMode === "queue" &&
            current.status === "active" &&
            !isActiveTurnMainRunIdle({ db: tx }, current))
        ) {
          throw new DispatchThreadStatusChangedError();
        }

        if (
          acceptance.kind === "turn" &&
          claimed === null &&
          args.retryOf !== undefined
        )
          claimRetryForRequest(tx, {
            threadId: thread.id,
            requestId: acceptance.requestId,
            now: Date.now(),
          });

        if (claimed !== null) {
          consumeClaimedRows({
            ...acceptance,
            claimed,
            threadId: thread.id,
            respectManualStopPause,
          });

          if (acceptance.kind === "turn")
            linkDispatchedQueueRows(tx, {
              threadId: thread.id,
              rows: claimed,
              requestId: acceptance.requestId,
              now: Date.now(),
            });
        }
      },
    });
  } catch (error) {
    if (!(error instanceof DispatchThreadStatusChangedError)) {
      throw error;
    }

    return reattemptDispatchForThreadChange(
      deps,
      args,
      getThread(deps.db, thread.id),
      run,
      waitOn,
    );
  }

  if (claimed !== null) {
    settleQueueRowDispatched({ row: claimed[0]! });
  }

  return { kind: "dispatched" };
}

class DispatchThreadStatusChangedError extends Error {}

async function reattemptDispatchForThreadChange(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
  thread: Thread | null,
  run: DispatchAttemptRun,
  waitOn: (
    waitingOn: QueuedMessageWaitingOn,
    sendAt: number | null,
  ) => DispatchAttemptOutcome,
): Promise<DispatchAttemptOutcome> {
  if (thread === null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }

  if (run.reattempted) {
    ensureThreadIsWritable(thread, true);
    const outcome = waitOn({ kind: "thread-busy" }, null);
    deps.logger.info(
      {
        queuedMessageId: outcome.kind === "queued" ? outcome.entry.id : null,
        status: thread.status,
        threadId: thread.id,
      },
      "Queued a message whose thread changed twice under its dispatch attempt",
    );
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });

    return outcome;
  }

  return runDispatchAttempt(
    deps,
    { ...args, thread },
    { ...run, reattempted: true },
  );
}

function consumeClaimedRows({
  claimed,
  threadId,
  respectManualStopPause,
  tx,
  notifications,
}: BufferedTransaction & {
  claimed: readonly ClaimedQueuedThreadMessageRow[];
  threadId: string;
  respectManualStopPause: boolean;
}): void {
  if (respectManualStopPause && isThreadQueueAutoSendPaused(tx, threadId)) {
    throw createQueuedMessageAutoSendPausedError();
  }

  const consumed = deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
    queuedMessages: claimed,
  });

  if (!consumed) {
    throw createQueuedMessageClaimLostError();
  }

  notifications.notifyThread(threadId, ["queue-changed"]);
}

interface AdmitPendingThreadArgs {
  author: DispatchAuthor;
  claimed: ClaimedQueuedThreadMessageRow[] | null;
  payload: SendMessageRequest & { inputGroups?: PromptInput[][] };
  respectManualStopPause: boolean;
  retryOf: TurnRequestRetryMarker | undefined;
  startContext: PendingThreadStartContext | null;
  thread: Thread;
}

interface PendingThreadAdmission {
  claimedRow: ClaimedQueuedThreadMessageRow | null;
  startingThread: Thread;
}

class PendingThreadAdmissionLost extends Error {
  constructor() {
    super("The thread left pending under the attempt");
    this.name = "PendingThreadAdmissionLost";
  }
}

async function admitPendingThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AdmitPendingThreadArgs,
): Promise<PendingThreadAdmission | null> {
  const startContext =
    args.startContext ?? readPendingThreadStartContext(deps, args.thread.id);

  if (startContext === null) {
    if (getThread(deps.db, args.thread.id)?.status !== "pending") {
      return null;
    }

    throw new ApiError(
      500,
      "internal_error",
      `Thread ${args.thread.id} is pending but has no start context to dispatch`,
    );
  }

  const execution = await buildExecutionOptions(deps, args.payload, {
    threadId: args.thread.id,
  });

  const claimedRow = args.claimed?.[0] ?? null;
  let startingThread: Thread;
  let admittedMoveNote: string | null = null;
  const notifications = new NotificationBuffer();

  try {
    startingThread = deps.db.transaction(
      (tx) => {
        const admittedContext =
          args.startContext ??
          readThreadStartupContextOfKind(
            tx,
            args.thread.id,
            "pending",
            pendingThreadStartContextSchema,
          );

        if (admittedContext === null) throw new PendingThreadAdmissionLost();
        admittedMoveNote = admittedContext.moveNote;

        if (args.claimed !== null && args.claimed.length > 0) {
          consumeClaimedRows({
            claimed: args.claimed,
            threadId: args.thread.id,
            respectManualStopPause: args.respectManualStopPause,
            tx,
            notifications,
          });
        }

        const prepared = applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, hub: deps.hub, logger: deps.logger },
          { threadId: args.thread.id, event: { type: "run.preparing" } },
        );

        if (!prepared.applied) {
          throw new PendingThreadAdmissionLost();
        }

        const starting = getThread(tx, args.thread.id);

        if (starting === null) throw new PendingThreadAdmissionLost();
        requestThreadProvision(deps, {
          author: args.author,
          thread: starting,
          environmentIntent: admittedContext.environmentIntent,
          execution,
          fork: admittedContext.fork,
          input: args.payload.input,
          systemMessageKind: messageSourceNotice(
            args.payload.messageSource,
            args.payload.senderThreadId ?? null,
          )?.kind,
          systemMessageSubject: messageSourceNotice(
            args.payload.messageSource,
            args.payload.senderThreadId ?? null,
          )?.subject,
          ...(admittedContext.providerInput === undefined
            ? {}
            : { providerInput: admittedContext.providerInput }),
          ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
          startedOnBehalfOf: admittedContext.startedOnBehalfOf,
          titleProvided: admittedContext.titleProvided,
        });

        return starting;
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (!(error instanceof PendingThreadAdmissionLost)) {
      throw error;
    }

    deps.logger.warn(
      { threadId: args.thread.id, status: args.thread.status },
      "A cleared first dispatch could not move its thread out of pending",
    );

    return null;
  }

  notifications.flushInto(deps.hub);
  deps.hub.notifyThread(
    startingThread.id,
    ["status-changed"],
    buildThreadStatusChangeMetadata(deps, startingThread),
  );

  if (admittedMoveNote !== null) {
    reportProvisioningNote(deps, startingThread.id, admittedMoveNote);
  }

  return {
    claimedRow,
    startingThread,
  };
}

async function launchAdmittedThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  admission: PendingThreadAdmission,
): Promise<void> {
  const { claimedRow, startingThread } = admission;

  if (claimedRow !== null) {
    settleQueueRowDispatched({ row: claimedRow });
  }

  scheduleThreadProvisioningAdvance(deps, startingThread.id);
}

function resolveExecutionIntoPayload(
  payload: SendMessageRequest & { inputGroups?: PromptInput[][] },
  execution: ResolvedThreadExecutionOptions,
): SendMessageRequest & { inputGroups?: PromptInput[][] } {
  return {
    ...payload,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    serviceTier: execution.serviceTier,
    permissionMode: execution.permissionMode,
    executionInputSources: {
      ...(payload.executionInputSources ?? {}),
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
  };
}

export interface MaintenanceCompactionOptions {
  maintenance: ThreadMaintenanceKind;
  execution: Pick<
    ResolvedThreadExecutionOptions,
    "model" | "reasoningLevel" | "serviceTier"
  >;
  beforeAppendInTransaction?: SendThreadMessageTransactionPreflight;
}

export async function compactThreadContext(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
  options?: MaintenanceCompactionOptions,
): Promise<void> {
  ensureThreadIsWritable(thread);

  if (!deps.providerRegistry.supportsManualCompaction(thread.providerId)) {
    throw new ApiError(
      409,
      "invalid_request",
      `Provider "${thread.providerId}" does not support manual context compaction`,
    );
  }

  if (thread.status !== "idle" && thread.status !== "error") {
    throw new ApiError(
      409,
      "invalid_request",
      "Context can only be compacted while the thread is idle or errored",
    );
  }

  const environment = await requireThreadCommandEnvironment(deps, { thread });
  await attemptDispatch(deps, {
    thread,
    payload: {
      input: createStandaloneBuiltinCompactCommandInput(),
      mode: "start",
      ...(options !== undefined
        ? {
            model: options.execution.model,
            reasoningLevel: options.execution.reasoningLevel,
            serviceTier: options.execution.serviceTier,
            executionInputSources: {
              model: "explicit",
              reasoningLevel: "explicit",
              serviceTier: "explicit",
            },
          }
        : {}),
    },
    source: {
      kind: "operation",
      environment,
      ...(options !== undefined
        ? {
            maintenance: options.maintenance,
            ...(options.beforeAppendInTransaction !== undefined
              ? { beforeAppendInTransaction: options.beforeAppendInTransaction }
              : {}),
          }
        : {}),
    },
    queuePayload: { kind: "inline" },
    pluginSubmission: null,
    systemNotice: null,
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "user",
  });
}
