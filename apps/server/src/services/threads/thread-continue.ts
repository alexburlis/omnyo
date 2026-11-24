import { OWNER_ACTOR } from "../inbox/actor.js";
import {
  getEnvironment,
  getLatestStoredThreadEventOfTypes,
  getQueuedThreadContinuation,
  getThread,
  listErroredThreadsForContinuation,
  updateQueuedThreadMessage,
} from "@omnyo/db";
import type {
  PromptInput,
  QueuedMessageWaitingOn,
  Thread,
} from "@omnyo/domain";
import type {
  ThreadContinueAllResponse,
  ThreadContinueResponse,
  ThreadContinueState,
} from "@omnyo/server-contract";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  attemptDispatch,
  type DispatchAttemptArgs,
} from "./dispatch-attempt.js";
import {
  buildTurnFailedEvent,
  loadFailedTurn,
  loadFailedTurnErrorMessage,
  retryChain,
} from "./turn-failed.js";
import {
  failedTurnRetryExecution,
  failedTurnRetryInput,
  retryFailedTurn,
  type FailedTurnRetryPrompt,
} from "./turn-retry.js";
import {
  acquireThreadContinuationAdmission,
  isThreadContinuationInFlight,
} from "./thread-continuation-admission.js";
import { hasLiveThreadStartInFlight } from "./thread-lifecycle.js";
import { readThreadProvisionContext } from "./thread-startup-store.js";
import { resolveThreadEnvironmentRestore } from "./thread-environment-restore.js";
import {
  requestThreadEnvironmentRestore,
  scheduleThreadProvisioningAdvance,
} from "./thread-provisioning.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  isQueuedMessageHeldByFailurePause,
  releaseFailurePauseForQueuedRecovery,
  sendQueuedMessageHeldByFailurePause,
  sendQueuedMessageNow,
} from "./queued-messages.js";
import {
  parseStoredQueuedThreadMessageWaitingOn,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";

type ContinueDeps = LoggedPendingInteractionWorkSessionDeps;

type QueuedContinuation = NonNullable<
  ReturnType<typeof getQueuedThreadContinuation>
>;

function isQueuedContinuationPending(
  deps: Pick<ContinueDeps, "db">,
  thread: Thread,
  queued: QueuedContinuation,
): boolean {
  if (queued.claimedAt !== null || queued.claimToken !== null) return true;

  if (queued.failureReason !== null) return false;

  return !(
    thread.status === "error" &&
    isQueuedMessageHeldByFailurePause(deps.db, queued)
  );
}

const completedSchema = z.object({ status: z.string() });

function retryableFailure(deps: Pick<ContinueDeps, "db">, threadId: string) {
  const failed = loadFailedTurn(deps.db, threadId);

  if (failed === null) return null;

  const completed = getLatestStoredThreadEventOfTypes(deps.db, {
    threadId,
    types: ["turn/completed"],
    afterSequence: failed.requestSequence,
  });

  if (completed !== null) {
    let data: unknown;

    try {
      data = JSON.parse(completed.data);
    } catch {
      return null;
    }

    const status = completedSchema.safeParse(data).data?.status;

    if (status === "completed" || status === "interrupted") return null;
  }

  return failed;
}

export function getThreadContinueState(
  deps: Pick<ContinueDeps, "db">,
  thread: Thread,
): ThreadContinueState {
  const category =
    thread.status === "error"
      ? buildTurnFailedEvent(deps.db, thread.id)?.errorInfo?.category
      : undefined;

  const failed =
    thread.status === "error" ? loadFailedTurn(deps.db, thread.id) : null;

  const failedExecution =
    failed === null ? null : failedTurnRetryExecution(failed);

  const failureLabel =
    category === "rate-limit"
      ? "Provider usage limit reached"
      : category === "overloaded"
        ? "The selected model is at capacity"
        : category === "unauthorized"
          ? "Provider sign-in is required"
          : category === "billing" || category === "budget-exceeded"
            ? "Provider billing needs attention"
            : category === "context-window-exceeded"
              ? "The chat reached its context limit"
              : category === "policy" || category === "bad-request"
                ? "The provider rejected this request"
                : "This turn could not finish";

  const base = {
    threadId: thread.id,
    available: false,
    pending: false,
    action: "none" as const,
    message: null,
    retryAt: null,
    retryAttempt: null,
    model: failedExecution?.model ?? null,
    permissionMode: failedExecution?.permissionMode ?? null,
    canRetryNow: false,
    cause: null,
    failureLabel: thread.status === "error" ? failureLabel : null,
  };

  if (thread.archivedAt !== null || thread.deletedAt !== null) return base;
  const queued = getQueuedThreadContinuation(deps.db, thread.id);

  const cause =
    thread.status === "error"
      ? loadFailedTurnErrorMessage(deps.db, thread.id)
      : null;

  if (
    isThreadContinuationInFlight(thread.id) ||
    hasLiveThreadStartInFlight(thread.id)
  )
    return {
      ...base,
      pending: true,
      message: "Recovery is starting.",
    };

  if (queued !== null && isQueuedContinuationPending(deps, thread, queued)) {
    const canRetryNow = queued.claimedAt === null && queued.claimToken === null;

    const wait = canRetryNow
      ? parseStoredQueuedThreadMessageWaitingOn(queued)
      : null;

    const hasScheduledWake =
      wait === null || wait.kind === "time" || wait.kind === "plugin";

    return {
      ...base,
      cause,
      pending: true,
      canRetryNow,
      action: "retry-queued",
      retryAt: canRetryNow && hasScheduledWake ? queued.sendAt : null,
      retryAttempt: queued.retryAttempt,
      model: queued.model,
      permissionMode: queued.permissionMode,
      message: canRetryNow
        ? queuedRecoveryMessage(queued, wait)
        : "Recovery is starting.",
    };
  }

  if (thread.status !== "error") return base;

  const nextAction =
    category === "unauthorized"
      ? "Sign in to your provider, then continue."
      : category === "billing" || category === "budget-exceeded"
        ? "Check your provider’s billing or budget before continuing."
        : category === "policy" || category === "bad-request"
          ? "Revise the request before continuing."
          : category === "context-window-exceeded"
            ? "Compact the chat or start a new chat before continuing."
            : "Continue when ready.";

  const available = {
    ...base,
    cause,
    available: true,
    canRetryNow: true,
    message: `No automatic retry is scheduled. ${nextAction}`,
  };

  if (queued !== null)
    return {
      ...available,
      action: "retry-queued",
      ...(queued.failureReason === null
        ? {}
        : {
            message: `Recovery could not start: ${queued.failureReason}`,
          }),
    };
  const startup = readThreadProvisionContext(deps.db, thread.id);

  if (
    startup !== null &&
    startup.request.execution !== null &&
    startup.request.input.length > 0
  )
    return { ...available, action: "startup" };

  if (thread.environmentId === null)
    return {
      ...available,
      action: "unavailable",
      message:
        "The original workspace setup is unavailable. Choose a workspace or start a new chat.",
    };
  const environment = getEnvironment(deps.db, thread.environmentId);

  if (environment === undefined || environment === null)
    return {
      ...available,
      action: "unavailable",
      message: "This chat’s workspace is unavailable.",
    };

  if (environment.status === "destroyed") {
    const resolution = resolveThreadEnvironmentRestore(deps, { thread });

    return resolution.restorable
      ? { ...available, action: "restore-workspace" }
      : {
          ...available,
          action: "unavailable",
          message:
            "This workspace cannot be restored. Choose a workspace or start a new chat.",
        };
  }

  if (retryableFailure(deps, thread.id) !== null)
    return { ...available, action: "retry" };

  if (loadFailedTurn(deps.db, thread.id) !== null)
    return { ...available, action: "continue" };

  return {
    ...available,
    action: "unavailable",
    message:
      "The original request is unavailable. Send a message to continue this chat.",
  };
}

function queuedRecoveryMessage(
  queued: QueuedContinuation,
  wait: QueuedMessageWaitingOn | null,
): string {
  switch (wait?.kind) {
    case "host-offline":
      return `Automatic recovery is waiting for ${wait.hostName} to reconnect.`;
    case "host-away":
      return `Automatic recovery is waiting while ${wait.hostName} is Away.`;
    case "interaction":
      return "Automatic recovery is waiting for your reply.";
    case "plugin":
      return `Automatic recovery is held: ${wait.reason}`;
    case "server-update":
      return "Automatic recovery will continue after the Omnyo update.";
    case "superseded":
      return "A newer message overtook this retry. Send or delete the queued input.";
    case "provisioning":
      return "Automatic recovery is waiting for the workspace.";
    case "thread-busy":
    case "stopping":
    case "turn-starting":
      return "Automatic recovery is waiting for the current turn to stop.";
    case "time":
    case undefined:
      return queued.sendAt === null
        ? "Automatic recovery is queued."
        : `${queued.retryReason ?? "Automatic recovery"}. Next attempt scheduled${queued.retryAttempt === null ? "." : ` (attempt ${queued.retryAttempt}).`}`;
  }
}

function outcome(
  threadId: string,
  result: ThreadContinueResponse["outcome"],
  message: string | null = null,
  queuedMessageId: string | null = null,
): ThreadContinueResponse {
  return { threadId, outcome: result, queuedMessageId, message };
}

export async function continueThread(
  deps: ContinueDeps,
  threadId: string,
  request: { now?: boolean; model?: string } = {},
): Promise<ThreadContinueResponse> {
  const thread = getThread(deps.db, threadId);

  if (thread === undefined || thread === null)
    throw new ApiError(404, "thread_not_found", "Thread not found");
  const state = getThreadContinueState(deps, thread);

  if (
    state.pending &&
    (!state.canRetryNow || (!request.now && request.model === undefined))
  )
    return outcome(
      threadId,
      "pending",
      null,
      getQueuedThreadContinuation(deps.db, threadId)?.id ?? null,
    );

  if (
    !state.available &&
    !(state.canRetryNow && (request.now || request.model !== undefined))
  )
    return outcome(threadId, "blocked", "This chat is no longer errored.");

  if (state.action === "unavailable")
    return outcome(threadId, "blocked", state.message);

  if (state.action === "retry") {
    try {
      const result = await retryFailedTurn(deps, {
        thread,
        actor: OWNER_ACTOR,
        request: {
          turnRequestId: null,
          sendAt: null,
          reason: "Continue",
          ...(request.model === undefined ? {} : { model: request.model }),
        },
      });

      return outcome(
        threadId,
        result.delivery,
        null,
        result.delivery === "queued" ? result.queuedMessageId : null,
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.body.code === "retry_already_queued"
      )
        return outcome(threadId, "pending");

      if (error instanceof ApiError && error.status < 500)
        return outcome(threadId, "blocked", error.body.message);
      throw error;
    }
  }

  const release = acquireThreadContinuationAdmission(threadId);

  if (release === null) return outcome(threadId, "pending");

  try {
    if (state.action === "retry-queued") {
      const queued = getQueuedThreadContinuation(deps.db, threadId);

      if (
        queued === null ||
        queued.claimedAt !== null ||
        queued.claimToken !== null
      )
        return outcome(threadId, "pending");

      if (request.model !== undefined && request.model !== queued.model) {
        const original = toThreadQueuedMessage(queued);

        const execution = await buildExecutionOptions(
          deps,
          {
            model: request.model,
            reasoningLevel: original.reasoningLevel,
            serviceTier: original.serviceTier,
            permissionMode: original.permissionMode,
          },
          { threadId },
        );

        const updated = updateQueuedThreadMessage(deps.db, deps.hub, {
          id: queued.id,
          threadId,
          expectedUpdatedAt: queued.updatedAt,
          content: original.content,
          execution: {
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            serviceTier: execution.serviceTier,
            permissionMode: execution.permissionMode,
          },
        });

        if (updated.kind !== "updated") return outcome(threadId, "pending");
      }

      const result =
        queued.failureReason === null && !state.pending
          ? await sendQueuedMessageHeldByFailurePause(deps, {
              threadId,
              queuedMessageId: queued.id,
            })
          : await sendQueuedMessageNow(deps, {
              threadId,
              queuedMessageId: queued.id,
              mode: "auto",
              overrideFailures: true,
            });

      if (result === null) return outcome(threadId, "pending");

      return outcome(
        threadId,
        result.delivery === "already-sent" ? "sent" : result.delivery,
        null,
        result.delivery === "queued" ? result.queuedMessage.id : null,
      );
    }

    const failed = retryableFailure(deps, threadId);

    const startup =
      state.action === "startup"
        ? readThreadProvisionContext(deps.db, threadId)
        : null;

    let currentThread = thread;

    if (state.action === "restore-workspace") {
      const resolution = resolveThreadEnvironmentRestore(deps, { thread });

      if (!resolution.restorable)
        return outcome(
          threadId,
          "blocked",
          "This workspace can no longer be restored.",
        );

      const restored = requestThreadEnvironmentRestore(deps, {
        thread,
        environment: resolution.target.environment,
        provider: {
          environmentProviderId: resolution.target.environmentProviderId,
          selection: resolution.target.selection,
        },
      });

      if (restored === null) return outcome(threadId, "pending");
      const reloaded = getThread(deps.db, threadId);

      if (reloaded === undefined || reloaded === null)
        throw new ApiError(404, "thread_not_found", "Thread not found");
      currentThread = reloaded;
      deps.hub.notifyThread(
        threadId,
        ["status-changed"],
        buildThreadStatusChangeMetadata(deps, reloaded),
      );
      scheduleThreadProvisioningAdvance(deps, threadId);
    }

    const agentOnly = (block: PromptInput): PromptInput => ({
      ...block,
      visibility: "agent-only",
    });

    const replay = startup?.request;
    const retry = failed === null ? null : retryChain(failed.request);
    let input: FailedTurnRetryPrompt;

    if (replay !== undefined) {
      input = { input: replay.input.map(agentOnly) };

      if (replay.inputGroups !== undefined)
        input.inputGroups = replay.inputGroups.map((group) =>
          group.map(agentOnly),
        );
    } else if (failed !== null)
      input = failedTurnRetryInput(deps, { threadId, failed });
    else
      input = {
        input: [
          {
            type: "text",
            text: "Please continue.",
            mentions: [],
            visibility: "agent-only",
          },
        ],
      };

    const execution =
      replay?.execution ??
      (failed !== null ? failedTurnRetryExecution(failed) : {});

    const dispatch: DispatchAttemptArgs = {
      thread: currentThread,
      payload: {
        mode: "queue-if-active",
        ...input,
        ...execution,
        ...(request.model === undefined ? {} : { model: request.model }),
      },
      source: { kind: "inline" },
      queuePayload:
        retry === null || replay !== undefined
          ? { kind: "continuation" }
          : {
              kind: "retry",
              retryOfTurnRequestId: retry.originalRequestId,
              attempt: retry.attemptNumber + 1,
              reason: "Continue",
            },
      pluginSubmission: null,
      systemNotice: null,
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      trigger: "user",
    };

    if (retry !== null && replay === undefined)
      dispatch.retryOf = {
        requestId: retry.originalRequestId,
        attempt: retry.attemptNumber + 1,
      };
    const result = await attemptDispatch(deps, dispatch);

    if (result.kind === "queued")
      releaseFailurePauseForQueuedRecovery(deps, {
        threadId,
        queuedMessageId: result.entry.id,
      });

    return outcome(
      threadId,
      result.kind === "dispatched" ? "sent" : "queued",
      null,
      result.kind === "queued" ? result.entry.id : null,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status < 500)
      return outcome(threadId, "blocked", error.body.message);
    throw error;
  } finally {
    release();
  }
}

export function listThreadContinuations(deps: Pick<ContinueDeps, "db">) {
  return {
    threads: listErroredThreadsForContinuation(deps.db).map((thread) =>
      getThreadContinueState(deps, thread),
    ),
  };
}

export async function continueAllThreads(
  deps: ContinueDeps,
): Promise<ThreadContinueAllResponse> {
  const results: ThreadContinueResponse[] = [];

  for (const thread of listErroredThreadsForContinuation(deps.db)) {
    if (!getThreadContinueState(deps, thread).available) continue;

    try {
      results.push(await continueThread(deps, thread.id));
    } catch {
      results.push(
        outcome(
          thread.id,
          "blocked",
          "This chat could not continue. Try it again individually.",
        ),
      );
    }
  }

  return { results };
}
