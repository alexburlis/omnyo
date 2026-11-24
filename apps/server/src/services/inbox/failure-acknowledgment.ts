import {
  getActiveStoredTurnId,
  getLastStoredTurnRequestEvent,
  getStoredTurnRequestEventForTurn,
  listPendingInteractionsByThread,
  queuedThreadMessages,
  threadCallbacks,
  threadQuestions,
  type DbQueryConnection,
} from "@omnyo/db";
import type {
  InboxFailureAcknowledgeRequest,
  InboxFailureAcknowledgeResponse,
  InboxFailureView,
} from "@omnyo/domain";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { isThreadContinuationInFlight } from "../threads/thread-continuation-admission.js";
import { parseStoredTurnRequestEvent } from "../threads/thread-events.js";
import {
  hasLiveThreadStartInFlight,
  hasLiveThreadStopInFlight,
} from "../threads/thread-lifecycle.js";
import type { InboxActor } from "./actor.js";
import { getInboxThread, inboxRootOf } from "./family.js";
import {
  getFailure,
  getLatestThreadFailure,
  getOpenTurnMark,
  insertReceipt,
  listActiveProducers,
  listOpenWaits,
  listOwnerInputs,
  setReceiptsHandled,
  updateFailure,
  type FailureRow,
} from "./store.js";

export function toFailureView(failure: FailureRow): InboxFailureView {
  return {
    id: failure.id,
    threadId: failure.threadId,
    turnId: failure.turnId,
    requestId: failure.requestId,
    state: failure.state,
    reason: failure.reason,
    resolvedBy: failure.resolvedBy,
  };
}

function refuse(message: string): never {
  throw new ApiError(409, "failure_acknowledgment_refused", message);
}

export function requireFailureActor(
  db: DbQueryConnection,
  threadId: string,
  actor: InboxActor,
): void {
  if (actor.kind === "owner") return;

  const thread = getInboxThread(db, threadId);

  const caller =
    actor.kind === "thread" ? getInboxThread(db, actor.threadId) : null;

  const root = inboxRootOf(db, threadId);

  if (
    thread !== null &&
    caller !== null &&
    caller.deletedAt === null &&
    caller.id !== thread.id &&
    (caller.id === (thread.parentThreadId ?? thread.lifecycleOwnerThreadId) ||
      caller.id === root?.id)
  )
    return;

  throw new ApiError(
    403,
    "failure_acknowledgment_forbidden",
    "Only the owner or this chat's existing parent or root can acknowledge its failure.",
  );
}

function requireInactiveTarget(db: DbQueryConnection, threadId: string): void {
  const thread = getInboxThread(db, threadId);

  if (
    thread === null ||
    thread.status !== "idle" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    hasLiveThreadStartInFlight(threadId) ||
    hasLiveThreadStopInFlight(threadId) ||
    isThreadContinuationInFlight(threadId) ||
    getActiveStoredTurnId(db, threadId) !== null ||
    getOpenTurnMark(db, threadId) !== null
  )
    refuse("The chat must be idle with no turn or recovery in flight.");

  if (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .get() !== undefined ||
    listPendingInteractionsByThread(db, {
      threadId,
      statuses: ["pending", "resolving"],
    }).length > 0 ||
    db
      .select({ id: threadQuestions.id })
      .from(threadQuestions)
      .where(
        and(
          eq(threadQuestions.threadId, threadId),
          eq(threadQuestions.state, "open"),
        ),
      )
      .get() !== undefined ||
    db
      .select({ id: threadCallbacks.id })
      .from(threadCallbacks)
      .where(eq(threadCallbacks.threadId, threadId))
      .get() !== undefined ||
    listOpenWaits(db, [threadId]).length > 0 ||
    listActiveProducers(db, [threadId]).length > 0 ||
    listOwnerInputs(db, { threadIds: [threadId], states: ["running"] }).length >
      0
  )
    refuse(
      "The chat still has queued work, input, a wait or an active producer.",
    );
}

export function acknowledgeFailure(
  deps: Pick<AppDeps, "db">,
  args: InboxFailureAcknowledgeRequest & {
    threadId: string;
    failureId: string;
    actor: InboxActor;
    now: number;
  },
): InboxFailureAcknowledgeResponse {
  return deps.db.transaction(
    (tx) => {
      requireFailureActor(tx, args.threadId, args.actor);
      requireInactiveTarget(tx, args.threadId);
      const failure = getFailure(tx, args.failureId);

      if (failure === null || failure.threadId !== args.threadId)
        throw new ApiError(404, "failure_not_found", "Failure not found.");

      if (
        failure.turnId !== args.turnId ||
        getLatestThreadFailure(tx, args.threadId)?.id !== failure.id
      )
        refuse("The failure or its stored turn has changed.");

      const stored = getStoredTurnRequestEventForTurn(tx, {
        threadId: args.threadId,
        turnId: args.turnId,
      });

      if (stored === null)
        refuse("The failure's stored turn request could not be identified.");

      const request = parseStoredTurnRequestEvent(stored);
      const latest = getLastStoredTurnRequestEvent(tx, args.threadId);

      if (
        (failure.requestId !== null &&
          failure.requestId !== request.requestId) ||
        latest?.sequence !== stored.sequence
      )
        refuse("The failure's stored request has changed.");

      if (failure.state === "resolved") {
        if (failure.resolvedBy !== "acknowledged")
          refuse("This failure was resolved by another action.");

        return { failure: toFailureView(failure), acknowledged: false };
      }

      if (
        failure.state !== "actionable" ||
        failure.retryQueuedMessageId !== null ||
        failure.decisionDeadline !== null
      )
        refuse("The failure still has a retry decision or scheduled recovery.");

      const root = inboxRootOf(tx, args.threadId);

      if (root === null) refuse("The failure's root no longer exists.");

      const actorLabel =
        args.actor.kind === "thread"
          ? `parent chat ${args.actor.threadId}`
          : "owner";

      const receipt = insertReceipt(tx, {
        threadId: args.threadId,
        rootThreadId: root.id,
        cause: "result",
        summary: `Acknowledged failure ${failure.id} for turn ${args.turnId}, request ${request.requestId}, by ${actorLabel}: ${args.reason}`,
        outcomeRef: failure.id,
        waitId: null,
        coveredInputIds: [],
        now: args.now,
      });

      setReceiptsHandled(tx, {
        ids: [
          receipt.id,
          ...(failure.receiptId === null ? [] : [failure.receiptId]),
        ],
        moveId: null,
        now: args.now,
      });

      const resolved = updateFailure(
        tx,
        failure.id,
        { state: "resolved", resolvedBy: "acknowledged", resolvedAt: args.now },
        args.now,
      );

      if (resolved === null) refuse("The failure no longer exists.");

      return { failure: toFailureView(resolved), acknowledged: true };
    },
    { behavior: "immediate" },
  );
}
