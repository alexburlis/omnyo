import { and, eq, inArray } from "drizzle-orm";
import {
  queuedThreadMessages,
  getStoredTurnRequestEventForTurn,
  threadFailures,
  type DbQueryConnection,
} from "@omnyo/db";
import {
  INBOX_GOAL_VERDICT_HOLD_MS,
  clientTurnRequestIdSchema,
  INBOX_RETRY_DECISION_MS,
  type InboxIncident,
  type InboxProducerKind,
  type InboxProducerVerdict,
  type InboxReceiptCause,
  type TurnRequestEventData,
} from "@omnyo/domain";
import { ApiError } from "../../errors.js";
import { z } from "zod";
import {
  findWaitByDispatchRequest,
  getOpenTurnMark,
  getOwnerInputByRequest,
  getProducer,
  getWait,
  insertFailure,
  insertOwnerInput,
  insertProducer,
  insertReceipt,
  insertTurnMark,
  listActiveProducers,
  listConditions,
  listDueHeldProducers,
  listOpenFailures,
  listOutstandingReceipts,
  listOwnerInputs,
  nextKeyGeneration,
  setReceiptsHandled,
  updateFailure,
  updateOwnerInputs,
  updateProducer,
  updateTurnMark,
  updateWait,
  type FailureRow,
  type ProducerRow,
  type ReceiptRow,
  type WaitRow,
} from "./store.js";
import { getInboxThread, inboxRootOf } from "./family.js";
import { isMaintenanceTurnRequest } from "../threads/maintenance-silence.js";

export type InboxRunOutcome = "completed" | "failed" | "stopped" | "suspended";

export function isOwnerTurnRequest(
  data: Pick<
    TurnRequestEventData,
    "initiator" | "systemMessageKind" | "retryOfRequestId"
  >,
): boolean {
  return (
    data.initiator === "user" &&
    data.systemMessageKind !== "external-message" &&
    data.retryOfRequestId === undefined
  );
}

export function recordOwnerTurnRequest(
  db: DbQueryConnection,
  args: { threadId: string; requestId: string; now: number },
): void {
  if (getOwnerInputByRequest(db, args.requestId) !== null) return;

  insertOwnerInput(db, {
    threadId: args.threadId,
    kind: "message",
    state: "running",
    requestId: args.requestId,
    queuedMessageId: null,
    now: args.now,
  });
}

export function writeReceipt(
  db: DbQueryConnection,
  args: {
    threadId: string;
    cause: InboxReceiptCause;
    summary: string;
    outcomeRef: string | null;
    waitId: string | null;
    coveredInputIds: readonly string[];
    now: number;
  },
): ReceiptRow | null {
  const root = inboxRootOf(db, args.threadId);

  if (root === null || root.archivedAt !== null || root.deletedAt !== null)
    return null;

  return insertReceipt(db, {
    rootThreadId: root.id,
    threadId: args.threadId,
    cause: args.cause,
    summary: args.summary,
    outcomeRef: args.outcomeRef,
    waitId: args.waitId,
    coveredInputIds: args.coveredInputIds,
    now: args.now,
  });
}

export function onTurnInputAccepted(
  db: DbQueryConnection,
  args: { threadId: string; requestId: string; turnId: string; now: number },
): void {
  if (isMaintenanceTurnRequest(db, args)) return;

  const owner = getOwnerInputByRequest(db, args.requestId);

  if (owner !== null && owner.state === "running")
    updateOwnerInputs(db, [owner.id], { turnId: args.turnId }, args.now);

  const mark = getOpenTurnMark(db, args.threadId);

  if (mark !== null && mark.turnId === args.turnId) return;

  if (mark !== null) updateTurnMark(db, mark, { endedAt: args.now });

  const owed = listOwnerInputs(db, {
    threadIds: [args.threadId],
    states: ["owed"],
  });

  updateOwnerInputs(
    db,
    owed.map((input) => input.id),
    { state: "running", turnId: args.turnId },
    args.now,
  );

  const unbound = listOwnerInputs(db, {
    threadIds: [args.threadId],
    states: ["running"],
  }).filter((input) => input.turnId === null);

  updateOwnerInputs(
    db,
    unbound.map((input) => input.id),
    { turnId: args.turnId },
    args.now,
  );

  const wait = findWaitByDispatchRequest(db, args.requestId);

  insertTurnMark(db, {
    threadId: args.threadId,
    turnId: args.turnId,
    waitId: wait?.id ?? null,
    waitGeneration: wait?.generation ?? null,
    evaluation: wait?.status === "evaluating",
    now: args.now,
  });

  for (const failure of listOpenFailures(db, [args.threadId]))
    updateFailure(
      db,
      failure.id,
      { state: "resolved", resolvedBy: "turn", resolvedAt: args.now },
      args.now,
    );
}

function closeWait(
  db: DbQueryConnection,
  wait: WaitRow,
  reason: string,
  now: number,
): void {
  if (wait.status === "closed") return;

  updateWait(
    db,
    wait.id,
    { status: "closed", closedReason: reason, closedAt: now },
    now,
  );
}

function deliveredSummary(db: DbQueryConnection, wait: WaitRow): string {
  const conditions = listConditions(db, [wait.id]);
  const met = conditions.filter((condition) => condition.state === "met");
  const missing = conditions.filter((condition) => condition.state !== "met");

  return `${met.length} of ${conditions.length} arrived: ${met
    .map((condition) => condition.label)
    .join(
      ", ",
    )}${missing.length > 0 ? ` · no ${missing.map((condition) => condition.label).join(", ")}` : ""}`;
}

export interface InboxRunEndArgs {
  threadId: string;
  outcome: InboxRunOutcome;
  reason: string | null;
  summary: string | null;
  retryDecider: boolean;
  now: number;
}

export function applyInboxRunEnd(
  db: DbQueryConnection,
  args: InboxRunEndArgs,
): { changedThreadIds: string[] } {
  const thread = getInboxThread(db, args.threadId);

  if (thread === null) return { changedThreadIds: [] };

  const root = inboxRootOf(db, thread.id);
  const rootId = root?.id ?? thread.id;
  const isRoot = rootId === thread.id;
  const mark = getOpenTurnMark(db, thread.id);

  if (mark !== null)
    updateTurnMark(db, mark, { endedAt: args.now, endedOutcome: args.outcome });

  const running = listOwnerInputs(db, {
    threadIds: [thread.id],
    states: ["running"],
  }).filter(
    (input) =>
      mark === null || input.turnId === null || input.turnId === mark.turnId,
  );

  const runningIds = running.map((input) => input.id);
  const wait = mark?.waitId ? getWait(db, mark.waitId) : null;
  const changed = [thread.id, rootId];

  if (args.outcome === "stopped" || args.outcome === "suspended") {
    updateOwnerInputs(
      db,
      runningIds,
      { state: args.outcome === "stopped" ? "waived" : "owed" },
      args.now,
    );

    if (wait !== null && wait.status === "dispatched")
      closeWait(db, wait, "stopped", args.now);

    if (wait !== null && wait.status === "evaluating")
      updateWait(
        db,
        wait.id,
        { status: "live", generation: nextKeyGeneration(db, wait) },
        args.now,
      );

    return { changedThreadIds: changed };
  }

  if (args.outcome === "failed") {
    updateOwnerInputs(db, runningIds, { state: "owed" }, args.now);

    if (wait !== null && wait.status === "evaluating" && wait.kind === "join")
      updateWait(
        db,
        wait.id,
        { status: "live", generation: nextKeyGeneration(db, wait) },
        args.now,
      );

    recordFailure(db, {
      threadId: thread.id,
      turnId: mark?.turnId ?? null,
      reason: args.reason ?? "The turn failed.",
      retryDecider: args.retryDecider,
      heldWaitId:
        wait !== null &&
        (wait.status === "dispatched" || wait.status === "evaluating")
          ? wait.id
          : null,
      now: args.now,
    });

    return { changedThreadIds: changed };
  }

  let silent = false;

  if (wait !== null && mark !== null) {
    if (mark.evaluation && wait.kind === "join") {
      if (mark.metCondition !== null || mark.rearmed) silent = true;
      else if (wait.status !== "closed") {
        const delivered = listConditions(db, [wait.id]).some(
          (condition) => condition.state === "met",
        );

        closeWait(db, wait, "evaluation-ended", args.now);

        if (delivered)
          writeReceipt(db, {
            threadId: thread.id,
            cause: "partial",
            summary: `${deliveredSummary(db, wait)} · the check ended without a verdict`,
            outcomeRef: wait.id,
            waitId: wait.id,
            coveredInputIds: [],
            now: args.now,
          });
      }
    } else if (mark.rearmed || mark.afterWaitId !== null) {
      silent = true;

      if (
        !mark.rearmed &&
        (wait.status === "dispatched" || wait.status === "evaluating")
      )
        closeWait(db, wait, "continued", args.now);
    } else if (wait.status === "dispatched" || wait.status === "evaluating") {
      closeWait(db, wait, "resumed", args.now);
    }
  }

  const summary = args.summary ?? "Turn finished";

  if (running.length > 0) {
    const receipt = writeReceipt(db, {
      threadId: thread.id,
      cause: "result",
      summary,
      outcomeRef: mark?.turnId ?? null,
      waitId: null,
      coveredInputIds: runningIds,
      now: args.now,
    });

    updateOwnerInputs(
      db,
      runningIds,
      { state: "covered", receiptId: receipt?.id ?? null },
      args.now,
    );

    return { changedThreadIds: changed };
  }

  if (silent || !isRoot) return { changedThreadIds: changed };

  const producer = listActiveProducers(db, [thread.id])[0];

  if (producer !== undefined) {
    updateProducer(
      db,
      producer.id,
      {
        heldTurnId: mark?.turnId ?? null,
        heldSummary: summary,
        heldUntil: producer.heldUntil ?? args.now + INBOX_GOAL_VERDICT_HOLD_MS,
      },
      args.now,
    );

    return { changedThreadIds: changed };
  }

  writeReceipt(db, {
    threadId: thread.id,
    cause: "result",
    summary,
    outcomeRef: mark?.turnId ?? null,
    waitId: null,
    coveredInputIds: [],
    now: args.now,
  });

  return { changedThreadIds: changed };
}

function producerDebt(db: DbQueryConnection, producer: ProducerRow) {
  return listOwnerInputs(db, {
    threadIds: [producer.threadId],
    states: ["handed-off"],
  }).filter((input) => input.producerId === producer.id);
}

export function startProducer(
  db: DbQueryConnection,
  args: {
    threadId: string;
    kind: InboxProducerKind;
    pluginId: string;
    label: string;
    now: number;
  },
): ProducerRow {
  const existing = listActiveProducers(db, [args.threadId]).find(
    (producer) =>
      producer.pluginId === args.pluginId && producer.kind === args.kind,
  );

  const producer =
    existing === undefined
      ? insertProducer(db, args)
      : existing.label === args.label
        ? existing
        : (updateProducer(db, existing.id, { label: args.label }, args.now) ??
          existing);

  const mark = getOpenTurnMark(db, args.threadId);

  const handed = listOwnerInputs(db, {
    threadIds: [args.threadId],
    states: ["running"],
  }).filter(
    (input) =>
      mark !== null && (input.turnId === null || input.turnId === mark.turnId),
  );

  updateOwnerInputs(
    db,
    handed.map((input) => input.id),
    { state: "handed-off", producerId: producer.id },
    args.now,
  );

  return producer;
}

export function settleProducer(
  db: DbQueryConnection,
  args: {
    threadId: string;
    producerId: string;
    pluginId: string;
    verdict: InboxProducerVerdict;
    summary: string;
    now: number;
  },
): { producer: ProducerRow; receiptId: string | null } {
  const producer = getProducer(db, args.producerId);

  if (
    producer === null ||
    producer.threadId !== args.threadId ||
    producer.pluginId !== args.pluginId
  )
    throw new ApiError(404, "producer_not_found", "Producer not found");

  if (producer.status === "ended") return { producer, receiptId: null };

  if (args.verdict === "unmet")
    return {
      producer:
        updateProducer(
          db,
          producer.id,
          { heldTurnId: null, heldSummary: null, heldUntil: null },
          args.now,
        ) ?? producer,
      receiptId: null,
    };

  const debt = producerDebt(db, producer);

  const receipt =
    args.verdict !== "stopped" || producer.heldUntil !== null || debt.length > 0
      ? writeReceipt(db, {
          threadId: producer.threadId,
          cause: "result",
          summary: args.summary,
          outcomeRef: producer.heldTurnId,
          waitId: null,
          coveredInputIds: debt.map((input) => input.id),
          now: args.now,
        })
      : null;

  updateOwnerInputs(
    db,
    debt.map((input) => input.id),
    { state: "covered", receiptId: receipt?.id ?? null },
    args.now,
  );

  return {
    producer:
      updateProducer(
        db,
        producer.id,
        {
          status: "ended",
          endedReason: args.verdict,
          endedAt: args.now,
          heldTurnId: null,
          heldSummary: null,
          heldUntil: null,
        },
        args.now,
      ) ?? producer,
    receiptId: receipt?.id ?? null,
  };
}

export function surfaceDueProducerHolds(
  db: DbQueryConnection,
  now: number,
): string[] {
  const changed: string[] = [];

  for (const producer of listDueHeldProducers(db, now)) {
    const debt = producerDebt(db, producer);

    const receipt = writeReceipt(db, {
      threadId: producer.threadId,
      cause: "result",
      summary: `${producer.heldSummary ?? "Turn finished"} · no verdict from the goal's judge`,
      outcomeRef: producer.heldTurnId,
      waitId: null,
      coveredInputIds: debt.map((input) => input.id),
      now,
    });

    updateOwnerInputs(
      db,
      debt.map((input) => input.id),
      { state: "covered", receiptId: receipt?.id ?? null },
      now,
    );
    updateProducer(
      db,
      producer.id,
      { heldTurnId: null, heldSummary: null, heldUntil: null },
      now,
    );
    changed.push(producer.threadId);
  }

  return changed;
}

export function endProducers(
  db: DbQueryConnection,
  args: { threadIds: readonly string[]; reason: string; now: number },
): void {
  for (const producer of listActiveProducers(db, args.threadIds))
    updateProducer(
      db,
      producer.id,
      {
        status: "ended",
        endedReason: args.reason,
        endedAt: args.now,
        heldTurnId: null,
        heldSummary: null,
        heldUntil: null,
      },
      args.now,
    );
}

const failedTurnRequestSchema = z.object({
  requestId: clientTurnRequestIdSchema,
});

function failedTurnRequestId(
  db: DbQueryConnection,
  threadId: string,
  turnId: string | null,
): string | null {
  if (turnId === null) return null;
  const row = getStoredTurnRequestEventForTurn(db, { threadId, turnId });

  if (row === null) return null;

  try {
    return (
      failedTurnRequestSchema.safeParse(JSON.parse(row.data)).data?.requestId ??
      null
    );
  } catch {
    return null;
  }
}

function recordFailure(
  db: DbQueryConnection,
  args: {
    threadId: string;
    turnId: string | null;
    reason: string;
    retryDecider: boolean;
    heldWaitId: string | null;
    now: number;
  },
): FailureRow {
  for (const open of listOpenFailures(db, [args.threadId]))
    updateFailure(
      db,
      open.id,
      { state: "resolved", resolvedBy: "superseded", resolvedAt: args.now },
      args.now,
    );

  const failure = insertFailure(db, {
    threadId: args.threadId,
    turnId: args.turnId,
    requestId: failedTurnRequestId(db, args.threadId, args.turnId),
    waitId: args.heldWaitId,
    state: args.retryDecider ? "deciding" : "actionable",
    reason: args.reason,
    decisionDeadline: args.retryDecider
      ? args.now + INBOX_RETRY_DECISION_MS
      : null,
    now: args.now,
  });

  if (!args.retryDecider) return makeFailureActionable(db, failure, args.now);

  return failure;
}

export function makeFailureActionable(
  db: DbQueryConnection,
  failure: FailureRow,
  now: number,
): FailureRow {
  if (failure.waitId !== null) {
    const wait = getWait(db, failure.waitId);

    if (wait !== null && wait.status === "dispatched")
      closeWait(db, wait, "wake-failed", now);
  }

  const receipt = writeReceipt(db, {
    threadId: failure.threadId,
    cause: "problem",
    summary: `Failed: ${failure.reason}`,
    outcomeRef: failure.id,
    waitId: null,
    coveredInputIds: [],
    now,
  });

  return (
    updateFailure(
      db,
      failure.id,
      {
        state: "actionable",
        decisionDeadline: null,
        receiptId: receipt?.id ?? null,
      },
      now,
    ) ?? failure
  );
}

export function declineRetry(
  db: DbQueryConnection,
  args: {
    threadId: string;
    turnRequestId: string | null;
    reason: string;
    incident: InboxIncident | null;
    now: number;
  },
): "actionable" | "none" {
  const failure = listOpenFailures(db, [args.threadId])
    .filter(
      (row) =>
        args.turnRequestId === null ||
        row.requestId === null ||
        row.requestId === args.turnRequestId,
    )
    .at(-1);

  if (failure === undefined || failure.state === "held") return "none";

  const decided =
    failure.state === "deciding"
      ? makeFailureActionable(db, failure, args.now)
      : failure;

  updateFailure(
    db,
    decided.id,
    {
      incidentKey: args.incident?.key ?? null,
      incidentLabel: args.incident?.label ?? null,
      resetAt: args.incident?.resetAt ?? null,
    },
    args.now,
  );

  return "actionable";
}

export function recordRetryDecision(
  db: DbQueryConnection,
  args: {
    threadId: string;
    retryQueuedMessageId: string | null;
    now: number;
  },
): "held" | "actionable" | "none" {
  const open = listOpenFailures(db, [args.threadId]).at(-1);

  if (open === undefined) return "none";

  if (open.state === "actionable") return "actionable";

  if (args.retryQueuedMessageId === null) {
    makeFailureActionable(db, open, args.now);

    return "actionable";
  }

  updateFailure(
    db,
    open.id,
    {
      state: "held",
      decisionDeadline: null,
      retryQueuedMessageId: args.retryQueuedMessageId,
    },
    args.now,
  );

  return "held";
}

export function settleDueRetryDecisions(
  db: DbQueryConnection,
  now: number,
): string[] {
  const due = db
    .select()
    .from(threadFailures)
    .where(eq(threadFailures.state, "deciding"))
    .all()
    .filter(
      (failure) =>
        failure.decisionDeadline !== null && failure.decisionDeadline <= now,
    );

  for (const failure of due) makeFailureActionable(db, failure, now);

  return due.map((failure) => failure.threadId);
}

export function settleUnclaimedHeldRetries(
  db: DbQueryConnection,
  now: number,
): string[] {
  const held = db
    .select()
    .from(threadFailures)
    .where(eq(threadFailures.state, "held"))
    .all();

  const changed: string[] = [];

  for (const failure of held) {
    if (failure.retryQueuedMessageId === null) continue;

    const row = db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, failure.retryQueuedMessageId))
      .get();

    if (row !== undefined) continue;

    makeFailureActionable(db, failure, now);
    changed.push(failure.threadId);
  }

  return changed;
}

export type InboxAdmission = "admit" | "pause";

export function openFailureState(
  db: DbQueryConnection,
  threadId: string,
): FailureRow | null {
  return listOpenFailures(db, [threadId]).at(-1) ?? null;
}

export function admitDispatch(
  db: DbQueryConnection,
  args: {
    threadId: string;
    starter: "owner" | "owner-override" | "retry" | "other";
  },
): InboxAdmission {
  const failure = openFailureState(db, args.threadId);

  if (failure === null) return "admit";

  switch (args.starter) {
    case "owner-override":
      return "admit";
    case "owner":
      return failure.state === "held" ? "pause" : "admit";
    case "retry":
      return failure.state === "actionable" ? "pause" : "admit";
    case "other":
      return "pause";
  }
}

export function markOwnerFailureOverride(
  db: DbQueryConnection,
  args: { threadId: string; queuedMessageId: string },
): void {
  const failure = openFailureState(db, args.threadId);

  if (
    failure === null ||
    admitDispatch(db, { threadId: args.threadId, starter: "owner" }) === "pause"
  )
    return;

  db.update(queuedThreadMessages)
    .set({ overridesFailureId: failure.id })
    .where(
      and(
        eq(queuedThreadMessages.id, args.queuedMessageId),
        eq(queuedThreadMessages.threadId, args.threadId),
      ),
    )
    .run();
}

export function overridesOpenFailure(
  db: DbQueryConnection,
  row: { threadId: string; overridesFailureId: string | null },
): boolean {
  return (
    row.overridesFailureId !== null &&
    row.overridesFailureId === openFailureState(db, row.threadId)?.id
  );
}

export function resolveFailuresForOverride(
  db: DbQueryConnection,
  args: { threadId: string; now: number; by: "owner" | "retry" },
): boolean {
  const open = listOpenFailures(db, [args.threadId]);

  for (const failure of open)
    updateFailure(
      db,
      failure.id,
      {
        state: "resolved",
        resolvedBy: args.by,
        resolvedAt: args.now,
      },
      args.now,
    );

  return open.length > 0;
}

export function claimRetryForRequest(
  db: DbQueryConnection,
  args: { threadId: string; requestId: string; now: number },
): void {
  for (const failure of listOpenFailures(db, [args.threadId])) {
    if (failure.waitId !== null) {
      const wait = getWait(db, failure.waitId);

      if (wait !== null && wait.status !== "closed")
        updateWait(
          db,
          wait.id,
          { dispatchRequestId: args.requestId },
          args.now,
        );
    }

    updateFailure(
      db,
      failure.id,
      { state: "resolved", resolvedBy: "retry", resolvedAt: args.now },
      args.now,
    );
  }
}

export function failureSupersededByOwner(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  const latest = db
    .select()
    .from(threadFailures)
    .where(eq(threadFailures.threadId, threadId))
    .all()
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1);

  return latest?.state === "resolved" && latest.resolvedBy === "owner";
}

export function acknowledgeOwnerMessage(
  db: DbQueryConnection,
  args: { threadId: string; now: number },
): string[] {
  const root = inboxRootOf(db, args.threadId);

  if (root === null) return [];

  const ids = listOutstandingReceipts(db, [root.id])
    .filter((receipt) => receipt.createdAt <= args.now)
    .map((receipt) => receipt.id);

  setReceiptsHandled(db, { ids, moveId: null, now: args.now });

  return ids;
}

export function hasPausedQueue(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return openFailureState(db, threadId) !== null;
}

export function cancelHeldRetryRows(
  db: DbQueryConnection,
  args: { threadId: string; now: number },
): string[] {
  const held = listOpenFailures(db, [args.threadId]).filter(
    (failure) => failure.state === "held",
  );

  const ids = held
    .map((failure) => failure.retryQueuedMessageId)
    .filter((id): id is string => id !== null);

  if (ids.length > 0)
    db.delete(queuedThreadMessages)
      .where(
        and(
          inArray(queuedThreadMessages.id, ids),
          eq(queuedThreadMessages.threadId, args.threadId),
        ),
      )
      .run();

  for (const failure of held)
    updateFailure(
      db,
      failure.id,
      { state: "actionable", retryQueuedMessageId: null },
      args.now,
    );

  return ids;
}
