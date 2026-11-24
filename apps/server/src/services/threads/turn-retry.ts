import {
  hasQueuedRetryOfTurnRequest,
  getQueuedThreadContinuation,
} from "@omnyo/db";
import { permissionModeSchema } from "@omnyo/domain";
import type {
  ClientTurnRequestId,
  PermissionMode,
  PromptInput,
  Thread,
} from "@omnyo/domain";
import type {
  RetryTurnRequest,
  RetryTurnResponse,
  SendMessageRequest,
} from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";
import type { InboxActor } from "../inbox/actor.js";
import {
  failureSupersededByOwner,
  openFailureState,
  recordRetryDecision,
} from "../inbox/engine.js";
import { updateFailure } from "../inbox/store.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { getLatestMaintenanceRequest } from "./maintenance-run.js";
import {
  acquireThreadContinuationAdmission,
  isThreadContinuationInFlight,
} from "./thread-continuation-admission.js";
import {
  loadFailedTurn,
  retryChain,
  wasFailedTurnInputAccepted,
  type FailedTurnRecord,
} from "./turn-failed.js";

type TurnRetryDeps = LoggedPendingInteractionWorkSessionDeps;

function hasQueuedRetryFor(
  deps: Pick<TurnRetryDeps, "db">,
  args: { threadId: string; originalRequestId: string },
): boolean {
  return hasQueuedRetryOfTurnRequest(deps.db, {
    threadId: args.threadId,
    retryOfTurnRequestId: args.originalRequestId,
  });
}

function requireFailedTurn(
  deps: Pick<TurnRetryDeps, "db">,
  args: { thread: Thread; turnRequestId: ClientTurnRequestId | null },
) {
  const { thread } = args;
  const maintenance = getLatestMaintenanceRequest(deps.db, thread.id);

  if (maintenance !== null) {
    throw new ApiError(
      409,
      "maintenance_not_retryable",
      `Thread ${thread.id} last ran an automatic compaction, which is never retried.`,
    );
  }

  if (thread.status !== "error") {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Thread ${thread.id} has no failed turn to retry: it is ${thread.status}.`,
    );
  }

  const failed = loadFailedTurn(deps.db, thread.id);

  if (failed === null) {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Thread ${thread.id} failed before it dispatched a turn, so there is nothing to retry.`,
    );
  }

  if (
    args.turnRequestId !== null &&
    args.turnRequestId !== failed.request.requestId
  ) {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Turn ${args.turnRequestId} is not the failed turn on thread ${thread.id}; its most recent turn is ${failed.request.requestId}.`,
    );
  }

  return failed;
}

export interface RetryFailedTurnArgs {
  thread: Thread;
  request: RetryTurnRequest;
  actor: InboxActor;
}

const CONTINUE_ACCEPTED_TURN_TEXT = "Please continue.";

export interface FailedTurnRetryPrompt {
  input: PromptInput[];
  inputGroups?: PromptInput[][];
}

interface FailedTurnRetryExecution {
  model: string;
  reasoningLevel: SendMessageRequest["reasoningLevel"];
  serviceTier: SendMessageRequest["serviceTier"];
  permissionMode?: PermissionMode;
}

export function failedTurnRetryInput(
  deps: Pick<TurnRetryDeps, "db">,
  args: { threadId: string; failed: FailedTurnRecord },
): FailedTurnRetryPrompt {
  if (wasFailedTurnInputAccepted(deps.db, args)) {
    return {
      input: [
        {
          type: "text",
          text: CONTINUE_ACCEPTED_TURN_TEXT,
          mentions: [],
          visibility: "agent-only",
        },
      ],
    };
  }

  const agentOnly = (block: PromptInput): PromptInput => ({
    ...block,
    visibility: "agent-only",
  });

  const groups = args.failed.request.inputGroups;

  const prompt: FailedTurnRetryPrompt = {
    input: args.failed.request.input.map(agentOnly),
  };

  if (groups !== undefined)
    prompt.inputGroups = groups.map((group) => group.map(agentOnly));

  return prompt;
}

export function failedTurnRetryExecution(
  failed: FailedTurnRecord,
): FailedTurnRetryExecution {
  const { execution } = failed.request;

  const permissionMode = permissionModeSchema.safeParse(
    execution.permissionMode,
  ).data;

  const result: FailedTurnRetryExecution = {
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    serviceTier: execution.serviceTier,
  };

  if (permissionMode !== undefined) result.permissionMode = permissionMode;

  return result;
}

export async function retryFailedTurn(
  deps: TurnRetryDeps,
  args: RetryFailedTurnArgs,
): Promise<RetryTurnResponse> {
  const { request, thread } = args;

  const failed = requireFailedTurn(deps, {
    thread,
    turnRequestId: request.turnRequestId,
  });

  const chain = retryChain(failed.request);
  const originalRequestId = chain.originalRequestId;
  const failure = openFailureState(deps.db, thread.id);

  if (
    failure === null &&
    args.actor.kind !== "owner" &&
    failureSupersededByOwner(deps.db, thread.id)
  )
    throw new ApiError(
      409,
      "retry_refused",
      "The owner already continued this chat after the failure.",
    );

  if (failure?.state === "actionable") {
    if (args.actor.kind !== "owner")
      throw new ApiError(
        409,
        "retry_refused",
        "This failure is waiting for the owner; only Resume or a reply restarts it.",
      );

    updateFailure(deps.db, failure.id, { state: "held" }, Date.now());
  }

  if (
    isThreadContinuationInFlight(thread.id) ||
    getQueuedThreadContinuation(deps.db, thread.id) !== null ||
    hasQueuedRetryFor(deps, { threadId: thread.id, originalRequestId })
  ) {
    throw new ApiError(
      409,
      "retry_already_queued",
      `Turn ${originalRequestId} already has a retry waiting on thread ${thread.id}.`,
    );
  }

  const release = acquireThreadContinuationAdmission(thread.id);

  if (release === null)
    throw new ApiError(
      409,
      "retry_already_queued",
      "Thread recovery is already running.",
    );

  try {
    const attempt = chain.attemptNumber + 1;

    const outcome = await attemptDispatch(deps, {
      thread,
      payload: {
        mode: "queue-if-active",
        ...failedTurnRetryInput(deps, { threadId: thread.id, failed }),
        ...failedTurnRetryExecution(failed),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.sendAt === null ? {} : { sendAt: request.sendAt }),
      },
      source: { kind: "inline" },
      queuePayload: {
        kind: "retry",
        retryOfTurnRequestId: originalRequestId,
        attempt,
        reason: request.reason,
      },
      pluginSubmission: null,
      systemNotice: null,
      retryOf: { requestId: originalRequestId, attempt },
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      trigger: "user",
    });

    if (outcome.kind === "dispatched") {
      return {
        ok: true,
        delivery: "sent",
        turnRequestId: originalRequestId,
        attempt,
      };
    }

    recordRetryDecision(deps.db, {
      threadId: thread.id,
      retryQueuedMessageId: outcome.entry.id,
      now: Date.now(),
    });

    return {
      ok: true,
      delivery: "queued",
      turnRequestId: originalRequestId,
      attempt,
      queuedMessageId: outcome.entry.id,

      waitingOn: outcome.entry.waitingOn ?? { kind: "thread-busy" },
      sendAt: outcome.entry.sendAt,
    };
  } finally {
    release();
  }
}
