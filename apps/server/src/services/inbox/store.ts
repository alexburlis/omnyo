import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  threadFailures,
  threadMoves,
  threadOwnerInputs,
  threadProducers,
  threadReceipts,
  threads,
  threadTurnMarks,
  threadWaitConditions,
  threadWaitResults,
  threadWaits,
  type DbQueryConnection,
} from "@omnyo/db";
import {
  INBOX_REMINDER_MS,
  type InboxConditionKind,
  type InboxFailureState,
  type InboxOwnerInputKind,
  type InboxOwnerInputState,
  type InboxProducerKind,
  type InboxProposalKind,
  type InboxReceiptCause,
  type InboxWaitCreator,
  type InboxWaitKind,
  type InboxWaitStatus,
} from "@omnyo/domain";

export type OwnerInputRow = typeof threadOwnerInputs.$inferSelect;

export type WaitRow = typeof threadWaits.$inferSelect;

export type ConditionRow = typeof threadWaitConditions.$inferSelect;

export type WaitResultRow = typeof threadWaitResults.$inferSelect;

export type ReceiptRow = typeof threadReceipts.$inferSelect;

export type MoveRow = typeof threadMoves.$inferSelect;

export type FailureRow = typeof threadFailures.$inferSelect;

export type TurnMarkRow = typeof threadTurnMarks.$inferSelect;

export type ProducerRow = typeof threadProducers.$inferSelect;

export function newInboxId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function parseIdList(value: string | null): string[] {
  if (value === null || value === "") return [];

  const parsed: unknown = JSON.parse(value);

  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

export function insertOwnerInput(
  db: DbQueryConnection,
  args: {
    threadId: string;
    kind: InboxOwnerInputKind;
    state: InboxOwnerInputState;
    requestId: string | null;
    queuedMessageId: string | null;
    now: number;
  },
): OwnerInputRow {
  return db
    .insert(threadOwnerInputs)
    .values({
      id: newInboxId("oin"),
      threadId: args.threadId,
      kind: args.kind,
      state: args.state,
      requestId: args.requestId,
      queuedMessageId: args.queuedMessageId,
      turnId: null,
      receiptId: null,
      producerId: null,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .returning()
    .get();
}

export function listOwnerInputs(
  db: DbQueryConnection,
  args: {
    threadIds: readonly string[];
    states: readonly InboxOwnerInputState[];
  },
): OwnerInputRow[] {
  if (args.threadIds.length === 0 || args.states.length === 0) return [];

  return db
    .select()
    .from(threadOwnerInputs)
    .where(
      and(
        inArray(threadOwnerInputs.threadId, [...args.threadIds]),
        inArray(threadOwnerInputs.state, [...args.states]),
      ),
    )
    .orderBy(asc(threadOwnerInputs.createdAt))
    .all();
}

export function getOwnerInputByRequest(
  db: DbQueryConnection,
  requestId: string,
): OwnerInputRow | null {
  return (
    db
      .select()
      .from(threadOwnerInputs)
      .where(eq(threadOwnerInputs.requestId, requestId))
      .get() ?? null
  );
}

export function updateOwnerInputs(
  db: DbQueryConnection,
  ids: readonly string[],
  patch: Partial<
    Pick<
      OwnerInputRow,
      "state" | "turnId" | "receiptId" | "producerId" | "requestId"
    >
  >,
  now: number,
): void {
  if (ids.length === 0) return;

  db.update(threadOwnerInputs)
    .set({ ...patch, updatedAt: now })
    .where(inArray(threadOwnerInputs.id, [...ids]))
    .run();
}

export interface NewWait {
  threadId: string;
  key: string;
  generation: number;
  kind: InboxWaitKind;
  status: InboxWaitStatus;
  readiness: "all" | "any";
  createdBy: InboxWaitCreator;
  automationId: string | null;
  ownerAccepted: boolean;
  forText: string;
  resumeText: string | null;
  marker: string;
  deadline: number | null;
  chainStartAt: number;
  nextCheckAt: number | null;
  checkIntervalMs: number | null;
  reminderAt: number | null;
  questionId: string | null;
  questionRevision: number | null;
  coversReceiptIds: readonly string[];
  proposalKind: InboxProposalKind | null;
  afterWaitId: string | null;
  now: number;
}

export function insertWait(db: DbQueryConnection, wait: NewWait): WaitRow {
  return db
    .insert(threadWaits)
    .values({
      id: newInboxId("wait"),
      threadId: wait.threadId,
      key: wait.key,
      generation: wait.generation,
      kind: wait.kind,
      status: wait.status,
      readiness: wait.readiness,
      createdBy: wait.createdBy,
      automationId: wait.automationId,
      ownerAccepted: wait.ownerAccepted,
      forText: wait.forText,
      resumeText: wait.resumeText,
      marker: wait.marker,
      deadline: wait.deadline,
      chainStartAt: wait.chainStartAt,
      nextCheckAt: wait.nextCheckAt,
      checkIntervalMs: wait.checkIntervalMs,
      checkCount: 0,
      reminderAt: wait.reminderAt,
      reminderReceiptId: null,
      questionId: wait.questionId,
      questionRevision: wait.questionRevision,
      coversReceiptIds: JSON.stringify(wait.coversReceiptIds),
      proposalKind: wait.proposalKind,
      proposalReceiptId: null,
      afterWaitId: wait.afterWaitId,
      dispatchKey: null,
      dispatchQueuedMessageId: null,
      dispatchRequestId: null,
      closedReason: null,
      createdAt: wait.now,
      updatedAt: wait.now,
      closedAt: null,
    })
    .returning()
    .get();
}

export function getWait(db: DbQueryConnection, id: string): WaitRow | null {
  return (
    db.select().from(threadWaits).where(eq(threadWaits.id, id)).get() ?? null
  );
}

export function listExpiredAgentEventWaits(
  db: DbQueryConnection,
  ids: readonly string[],
): Pick<WaitRow, "id" | "threadId">[] {
  if (ids.length === 0) return [];

  return db
    .select({ id: threadWaits.id, threadId: threadWaits.threadId })
    .from(threadWaits)
    .where(
      and(
        inArray(threadWaits.id, [...ids]),
        eq(threadWaits.kind, "event"),
        eq(threadWaits.status, "closed"),
        eq(threadWaits.closedReason, "deadline"),
        eq(threadWaits.createdBy, "agent"),
        eq(threadWaits.ownerAccepted, false),
      ),
    )
    .all();
}

export function listOpenWaits(
  db: DbQueryConnection,
  threadIds: readonly string[],
): WaitRow[] {
  if (threadIds.length === 0) return [];

  return db
    .select()
    .from(threadWaits)
    .where(
      and(
        inArray(threadWaits.threadId, [...threadIds]),
        ne(threadWaits.status, "closed"),
        or(
          isNull(threadWaits.proposalKind),
          ne(threadWaits.proposalKind, "archive"),
        ),
      ),
    )
    .orderBy(asc(threadWaits.createdAt))
    .all();
}

export function listAllOpenWaits(db: DbQueryConnection): WaitRow[] {
  return db
    .select()
    .from(threadWaits)
    .where(ne(threadWaits.status, "closed"))
    .all();
}

export function nextKeyGeneration(
  db: DbQueryConnection,
  args: { threadId: string; key: string },
): number {
  const row = db
    .select({ top: max(threadWaits.generation) })
    .from(threadWaits)
    .where(
      and(
        eq(threadWaits.threadId, args.threadId),
        eq(threadWaits.key, args.key),
      ),
    )
    .get();

  return (row?.top ?? 0) + 1;
}

export function findWaitsByKey(
  db: DbQueryConnection,
  args: { threadId: string; key: string },
): WaitRow[] {
  return db
    .select()
    .from(threadWaits)
    .where(
      and(
        eq(threadWaits.threadId, args.threadId),
        eq(threadWaits.key, args.key),
      ),
    )
    .orderBy(desc(threadWaits.generation))
    .all();
}

export function findWaitsByMarker(
  db: DbQueryConnection,
  marker: string,
): WaitRow[] {
  return db
    .select()
    .from(threadWaits)
    .where(eq(threadWaits.marker, marker))
    .orderBy(desc(threadWaits.generation))
    .all();
}

export function findWaitByDispatchRequest(
  db: DbQueryConnection,
  requestId: string,
): WaitRow | null {
  return (
    db
      .select()
      .from(threadWaits)
      .where(eq(threadWaits.dispatchRequestId, requestId))
      .get() ?? null
  );
}

export function findWaitsByDispatchQueuedMessage(
  db: DbQueryConnection,
  queuedMessageIds: readonly string[],
): WaitRow[] {
  if (queuedMessageIds.length === 0) return [];

  return db
    .select()
    .from(threadWaits)
    .where(inArray(threadWaits.dispatchQueuedMessageId, [...queuedMessageIds]))
    .all();
}

export function updateWait(
  db: DbQueryConnection,
  id: string,
  patch: Partial<Omit<WaitRow, "id" | "createdAt">>,
  now: number,
): WaitRow | null {
  const updated =
    db
      .update(threadWaits)
      .set({ ...patch, updatedAt: now })
      .where(eq(threadWaits.id, id))
      .returning()
      .get() ?? null;

  if (patch.status === "closed") settleChatStallReceipts(db, [id], now);

  return updated;
}

export function settleChatStallReceipts(
  db: DbQueryConnection,
  waitIds: readonly string[],
  now: number,
): void {
  if (waitIds.length === 0) return;

  const candidates = [
    ...new Set(
      db
        .select({ receiptId: threadWaitConditions.stallReceiptId })
        .from(threadWaitConditions)
        .where(
          and(
            inArray(threadWaitConditions.waitId, [...waitIds]),
            eq(threadWaitConditions.kind, "chat"),
            isNotNull(threadWaitConditions.stallReceiptId),
          ),
        )
        .all()
        .flatMap(({ receiptId }) => (receiptId === null ? [] : [receiptId])),
    ),
  ];

  releaseChatStallReceipts(db, candidates, now);
}

export function releaseChatStallReceipts(
  db: DbQueryConnection,
  receiptIds: readonly string[],
  now: number,
): void {
  const candidates = [...new Set(receiptIds)];

  if (candidates.length === 0) return;

  const owed = new Set(
    db
      .select({ receiptId: threadWaitConditions.stallReceiptId })
      .from(threadWaitConditions)
      .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
      .where(
        and(
          inArray(threadWaitConditions.stallReceiptId, candidates),
          eq(threadWaitConditions.kind, "chat"),
          eq(threadWaitConditions.state, "pending"),
          ne(threadWaits.status, "closed"),
        ),
      )
      .all()
      .map(({ receiptId }) => receiptId),
  );

  const released = candidates.filter((id) => !owed.has(id));

  if (released.length === 0) return;

  const settled = db
    .select({ id: threadReceipts.id })
    .from(threadReceipts)
    .where(
      and(
        inArray(threadReceipts.id, released),
        eq(threadReceipts.cause, "stall"),
        isNull(threadReceipts.handledAt),
      ),
    )
    .all();

  setReceiptsHandled(db, {
    ids: settled.map(({ id }) => id),
    moveId: null,
    now,
  });
}

export function reopenSettledChatStallReceipts(
  db: DbQueryConnection,
  receiptIds: readonly string[],
  settledSince: number,
): void {
  if (receiptIds.length === 0) return;

  const reopened = db
    .select({ id: threadReceipts.id })
    .from(threadReceipts)
    .where(
      and(
        inArray(threadReceipts.id, [...new Set(receiptIds)]),
        eq(threadReceipts.cause, "stall"),
        isNull(threadReceipts.handledByMoveId),
        gte(threadReceipts.handledAt, settledSince),
      ),
    )
    .all();

  setReceiptsHandled(db, {
    ids: reopened.map(({ id }) => id),
    moveId: null,
    now: null,
  });
}

export function claimWaitStatus(
  db: DbQueryConnection,
  args: {
    id: string;
    generation: number;
    from: readonly InboxWaitStatus[];
    patch: Partial<Omit<WaitRow, "id" | "createdAt">>;
    now: number;
  },
): WaitRow | null {
  return (
    db
      .update(threadWaits)
      .set({ ...args.patch, updatedAt: args.now })
      .where(
        and(
          eq(threadWaits.id, args.id),
          eq(threadWaits.generation, args.generation),
          inArray(threadWaits.status, [...args.from]),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function insertConditions(
  db: DbQueryConnection,
  waitId: string,
  conditions: readonly {
    key: string;
    kind: InboxConditionKind;
    target: string | null;
    label: string;
    afterSeq: number | null;
  }[],
): void {
  if (conditions.length === 0) return;

  db.insert(threadWaitConditions)
    .values(
      conditions.map((condition) => ({
        waitId,
        conditionKey: condition.key,
        kind: condition.kind,
        target: condition.target,
        label: condition.label,
        state: "pending" as const,
        afterSeq: condition.afterSeq,
        result: null,
        metAt: null,
        stallWokenAt: null,
        stallReceiptId: null,
      })),
    )
    .run();
}

export function listConditions(
  db: DbQueryConnection,
  waitIds: readonly string[],
): ConditionRow[] {
  if (waitIds.length === 0) return [];

  return db
    .select()
    .from(threadWaitConditions)
    .where(inArray(threadWaitConditions.waitId, [...waitIds]))
    .orderBy(asc(threadWaitConditions.conditionKey))
    .all();
}

export function setCondition(
  db: DbQueryConnection,
  args: {
    waitId: string;
    key: string;
    state: "pending" | "met";
    result: string | null;
    now: number;
  },
): void {
  db.update(threadWaitConditions)
    .set({
      state: args.state,
      result: args.result,
      metAt: args.state === "met" ? args.now : null,
    })
    .where(
      and(
        eq(threadWaitConditions.waitId, args.waitId),
        eq(threadWaitConditions.conditionKey, args.key),
      ),
    )
    .run();

  if (args.state === "met")
    settleChatStallReceipts(db, [args.waitId], args.now);
}

export function listPendingChatConditionsForSource(
  db: DbQueryConnection,
  sourceThreadId: string,
): { condition: ConditionRow; wait: WaitRow }[] {
  return listPendingChatConditionsForSources(db, [sourceThreadId]);
}

export function listPendingChatConditionsForSources(
  db: DbQueryConnection,
  sourceThreadIds: readonly string[],
): { condition: ConditionRow; wait: WaitRow }[] {
  if (sourceThreadIds.length === 0) return [];

  return db
    .select({ condition: threadWaitConditions, wait: threadWaits })
    .from(threadWaitConditions)
    .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
    .where(
      and(
        eq(threadWaitConditions.kind, "chat"),
        inArray(threadWaitConditions.target, [...sourceThreadIds]),
        ne(threadWaits.status, "closed"),
      ),
    )
    .all();
}

export function insertWaitResult(
  db: DbQueryConnection,
  args: {
    threadId: string;
    marker: string;
    waitId: string | null;
    sourceThreadId: string | null;
    text: string;
    late: boolean;
    now: number;
  },
): WaitResultRow {
  return db
    .insert(threadWaitResults)
    .values({
      id: newInboxId("wres"),
      threadId: args.threadId,
      marker: args.marker,
      waitId: args.waitId,
      sourceThreadId: args.sourceThreadId,
      text: args.text,
      late: args.late,
      receivedAt: args.now,
      consumedAt: null,
    })
    .returning()
    .get();
}

export function listUnconsumedResults(
  db: DbQueryConnection,
  marker: string,
): WaitResultRow[] {
  return db
    .select()
    .from(threadWaitResults)
    .where(
      and(
        eq(threadWaitResults.marker, marker),
        isNull(threadWaitResults.consumedAt),
      ),
    )
    .orderBy(asc(threadWaitResults.receivedAt))
    .all();
}

export function consumeResults(
  db: DbQueryConnection,
  ids: readonly string[],
  now: number,
): void {
  if (ids.length === 0) return;

  db.update(threadWaitResults)
    .set({ consumedAt: now })
    .where(inArray(threadWaitResults.id, [...ids]))
    .run();
}

export function insertReceipt(
  db: DbQueryConnection,
  args: {
    rootThreadId: string;
    threadId: string;
    cause: InboxReceiptCause;
    summary: string;
    outcomeRef: string | null;
    waitId: string | null;
    coveredInputIds: readonly string[];
    now: number;
  },
): ReceiptRow {
  const last = db
    .select({ seq: max(threadReceipts.seq) })
    .from(threadReceipts)
    .where(eq(threadReceipts.rootThreadId, args.rootThreadId))
    .get();

  const receipt = db
    .insert(threadReceipts)
    .values({
      id: newInboxId("rcpt"),
      rootThreadId: args.rootThreadId,
      threadId: args.threadId,
      seq: (last?.seq ?? 0) + 1,
      cause: args.cause,
      summary: args.summary,
      outcomeRef: args.outcomeRef,
      waitId: args.waitId,
      coveredInputIds: JSON.stringify(args.coveredInputIds),
      handledAt: null,
      handledByMoveId: null,
      createdAt: args.now,
    })
    .returning()
    .get();

  db.update(threads)
    .set({
      latestAttentionAt: sql`max(${threads.latestAttentionAt}, ${args.now})`,
    })
    .where(eq(threads.id, args.rootThreadId))
    .run();

  return receipt;
}

export function listOutstandingReceipts(
  db: DbQueryConnection,
  rootThreadIds: readonly string[],
): ReceiptRow[] {
  if (rootThreadIds.length === 0) return [];

  return db
    .select()
    .from(threadReceipts)
    .where(
      and(
        inArray(threadReceipts.rootThreadId, [...rootThreadIds]),
        isNull(threadReceipts.handledAt),
        notExists(
          db
            .select({ id: threadWaits.id })
            .from(threadWaits)
            .where(
              and(
                eq(threadWaits.id, threadReceipts.waitId),
                eq(threadWaits.proposalKind, "archive"),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(threadReceipts.seq))
    .all();
}

export function getReceipts(
  db: DbQueryConnection,
  ids: readonly string[],
): ReceiptRow[] {
  if (ids.length === 0) return [];

  return db
    .select()
    .from(threadReceipts)
    .where(inArray(threadReceipts.id, [...ids]))
    .all();
}

export function setReceiptsHandled(
  db: DbQueryConnection,
  args: { ids: readonly string[]; moveId: string | null; now: number | null },
): void {
  if (args.ids.length === 0) return;

  db.update(threadReceipts)
    .set({ handledAt: args.now, handledByMoveId: args.moveId })
    .where(inArray(threadReceipts.id, [...args.ids]))
    .run();

  if (args.now === null) return;

  for (const reminder of db
    .select({ id: threadReceipts.id, waitId: threadReceipts.waitId })
    .from(threadReceipts)
    .where(
      and(
        inArray(threadReceipts.id, [...args.ids]),
        eq(threadReceipts.cause, "reminder"),
      ),
    )
    .all())
    if (reminder.waitId !== null)
      db.update(threadWaits)
        .set({
          reminderAt: args.now + INBOX_REMINDER_MS,
          updatedAt: args.now,
        })
        .where(
          and(
            eq(threadWaits.id, reminder.waitId),
            eq(threadWaits.reminderReceiptId, reminder.id),
            eq(threadWaits.status, "live"),
          ),
        )
        .run();
}

export function insertMove(
  db: DbQueryConnection,
  args: {
    rootThreadId: string;
    kind: string;
    handledReceiptIds: readonly string[];
    writeSet: unknown;
    now: number;
  },
): MoveRow {
  return db
    .insert(threadMoves)
    .values({
      id: newInboxId("move"),
      rootThreadId: args.rootThreadId,
      kind: args.kind,
      handledReceiptIds: JSON.stringify(args.handledReceiptIds),
      writeSet: JSON.stringify(args.writeSet),
      createdAt: args.now,
      undoneAt: null,
    })
    .returning()
    .get();
}

export function getLatestMove(db: DbQueryConnection): MoveRow | null {
  return (
    db
      .select()
      .from(threadMoves)
      .orderBy(desc(threadMoves.createdAt), desc(sql`rowid`))
      .limit(1)
      .get() ?? null
  );
}

export function markMoveUndone(
  db: DbQueryConnection,
  id: string,
  now: number,
): void {
  db.update(threadMoves)
    .set({ undoneAt: now })
    .where(eq(threadMoves.id, id))
    .run();
}

export function insertFailure(
  db: DbQueryConnection,
  args: {
    threadId: string;
    turnId: string | null;
    requestId: string | null;
    waitId: string | null;
    state: InboxFailureState;
    reason: string;
    decisionDeadline: number | null;
    now: number;
  },
): FailureRow {
  return db
    .insert(threadFailures)
    .values({
      id: newInboxId("fail"),
      threadId: args.threadId,
      turnId: args.turnId,
      requestId: args.requestId,
      waitId: args.waitId,
      state: args.state,
      reason: args.reason,
      decisionDeadline: args.decisionDeadline,
      retryQueuedMessageId: null,
      receiptId: null,
      resolvedBy: null,
      createdAt: args.now,
      updatedAt: args.now,
      resolvedAt: null,
    })
    .returning()
    .get();
}

export function listThreadFailures(
  db: DbQueryConnection,
  threadId: string,
): FailureRow[] {
  return db
    .select()
    .from(threadFailures)
    .where(eq(threadFailures.threadId, threadId))
    .orderBy(asc(threadFailures.createdAt), asc(sql`rowid`))
    .all();
}

export function getLatestThreadFailure(
  db: DbQueryConnection,
  threadId: string,
): FailureRow | null {
  return (
    db
      .select()
      .from(threadFailures)
      .where(eq(threadFailures.threadId, threadId))
      .orderBy(desc(threadFailures.createdAt), desc(sql`rowid`))
      .limit(1)
      .get() ?? null
  );
}

export function getFailure(
  db: DbQueryConnection,
  id: string,
): FailureRow | null {
  return (
    db.select().from(threadFailures).where(eq(threadFailures.id, id)).get() ??
    null
  );
}

export function listOpenFailures(
  db: DbQueryConnection,
  threadIds: readonly string[],
): FailureRow[] {
  if (threadIds.length === 0) return [];

  return db
    .select()
    .from(threadFailures)
    .where(
      and(
        inArray(threadFailures.threadId, [...threadIds]),
        ne(threadFailures.state, "resolved"),
      ),
    )
    .orderBy(asc(threadFailures.createdAt), asc(sql`rowid`))
    .all();
}

export function updateFailure(
  db: DbQueryConnection,
  id: string,
  patch: Partial<Omit<FailureRow, "id" | "createdAt">>,
  now: number,
): FailureRow | null {
  return (
    db
      .update(threadFailures)
      .set({ ...patch, updatedAt: now })
      .where(eq(threadFailures.id, id))
      .returning()
      .get() ?? null
  );
}

export function insertTurnMark(
  db: DbQueryConnection,
  args: {
    threadId: string;
    turnId: string;
    waitId: string | null;
    waitGeneration: number | null;
    evaluation: boolean;
    now: number;
  },
): void {
  db.insert(threadTurnMarks)
    .values({
      threadId: args.threadId,
      turnId: args.turnId,
      waitId: args.waitId,
      waitGeneration: args.waitGeneration,
      evaluation: args.evaluation,
      rearmed: false,
      metCondition: null,
      afterWaitId: null,
      endedOwnerWaitIds: "[]",
      createdAt: args.now,
      endedAt: null,
      endedOutcome: null,
    })
    .onConflictDoNothing()
    .run();
}

export function getOpenTurnMark(
  db: DbQueryConnection,
  threadId: string,
): TurnMarkRow | null {
  return (
    db
      .select()
      .from(threadTurnMarks)
      .where(
        and(
          eq(threadTurnMarks.threadId, threadId),
          isNull(threadTurnMarks.endedAt),
        ),
      )
      .orderBy(desc(threadTurnMarks.createdAt), desc(sql`rowid`))
      .limit(1)
      .get() ?? null
  );
}

export function updateTurnMark(
  db: DbQueryConnection,
  args: { threadId: string; turnId: string },
  patch: Partial<Omit<TurnMarkRow, "threadId" | "turnId" | "createdAt">>,
): void {
  db.update(threadTurnMarks)
    .set(patch)
    .where(
      and(
        eq(threadTurnMarks.threadId, args.threadId),
        eq(threadTurnMarks.turnId, args.turnId),
      ),
    )
    .run();
}

export function markConditionsStall(
  db: DbQueryConnection,
  args: {
    sourceThreadId: string;
    waitIds: string[];
    patch: Partial<Pick<ConditionRow, "stallWokenAt" | "stallReceiptId">>;
  },
): void {
  db.update(threadWaitConditions)
    .set(args.patch)
    .where(
      and(
        inArray(threadWaitConditions.waitId, args.waitIds),
        eq(threadWaitConditions.kind, "chat"),
        eq(threadWaitConditions.target, args.sourceThreadId),
        eq(threadWaitConditions.state, "pending"),
      ),
    )
    .run();
}

export function latestEndedTurnMark(
  db: DbQueryConnection,
  threadId: string,
): TurnMarkRow | null {
  return (
    db
      .select()
      .from(threadTurnMarks)
      .where(eq(threadTurnMarks.threadId, threadId))
      .orderBy(desc(threadTurnMarks.endedAt))
      .limit(1)
      .get() ?? null
  );
}

export function insertProducer(
  db: DbQueryConnection,
  args: {
    threadId: string;
    kind: InboxProducerKind;
    pluginId: string;
    label: string;
    now: number;
  },
): ProducerRow {
  return db
    .insert(threadProducers)
    .values({
      id: newInboxId("producer"),
      threadId: args.threadId,
      kind: args.kind,
      pluginId: args.pluginId,
      label: args.label,
      status: "active",
      heldTurnId: null,
      heldSummary: null,
      heldUntil: null,
      endedReason: null,
      createdAt: args.now,
      updatedAt: args.now,
      endedAt: null,
    })
    .returning()
    .get();
}

export function getProducer(
  db: DbQueryConnection,
  id: string,
): ProducerRow | null {
  return (
    db.select().from(threadProducers).where(eq(threadProducers.id, id)).get() ??
    null
  );
}

export function listActiveProducers(
  db: DbQueryConnection,
  threadIds: readonly string[],
): ProducerRow[] {
  if (threadIds.length === 0) return [];

  return db
    .select()
    .from(threadProducers)
    .where(
      and(
        inArray(threadProducers.threadId, [...threadIds]),
        eq(threadProducers.status, "active"),
      ),
    )
    .orderBy(asc(threadProducers.createdAt))
    .all();
}

export function listDueHeldProducers(
  db: DbQueryConnection,
  now: number,
): ProducerRow[] {
  return db
    .select()
    .from(threadProducers)
    .where(
      and(
        eq(threadProducers.status, "active"),
        sql`${threadProducers.heldUntil} IS NOT NULL AND ${threadProducers.heldUntil} <= ${now}`,
      ),
    )
    .all();
}

export function updateProducer(
  db: DbQueryConnection,
  id: string,
  patch: Partial<
    Pick<
      ProducerRow,
      | "label"
      | "status"
      | "heldTurnId"
      | "heldSummary"
      | "heldUntil"
      | "endedReason"
      | "endedAt"
    >
  >,
  now: number,
): ProducerRow | null {
  return (
    db
      .update(threadProducers)
      .set({ ...patch, updatedAt: now })
      .where(eq(threadProducers.id, id))
      .returning()
      .get() ?? null
  );
}
