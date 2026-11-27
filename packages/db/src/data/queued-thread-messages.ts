import { acquireProjectAttachmentOwnership } from "./project-attachments.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notExists,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX,
  projectAttachmentPaths,
  queuedMessageSystemNoticeSchema,
} from "@omnyo/domain";
import type {
  QueuedMessageDeliveryMode,
  PermissionMode,
  PromptInput,
  QueuedMessagePayload,
  QueuedMessageSystemNotice,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
  QueuedMessageWaitHolder,
  QueuedMessageWaitingOn,
  QueuedMessageWaitingOnKind,
} from "@omnyo/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  dispatchedQueuedThreadMessages,
  environments,
  events,
  queuedThreadMessages,
  threads,
} from "../schema.js";
import {
  createQueuedThreadMessageClaimToken,
  createQueuedThreadMessageId,
} from "../ids.js";
import { createOrderKeyBetween } from "./order-keys.js";

export interface CreateQueuedThreadMessageInput {
  threadId: string;
  position?: "first" | "last";
  content: PromptInput[];
  senderThreadId?: string | null;

  origin?: ThreadCreateOrigin | null;
  originPluginId?: string | null;

  requestedBy?: StartedOnBehalfOf | null;
  model: string;
  reasoningLevel: string;
  permissionMode: PermissionMode;
  serviceTier: string;

  waitingOn: QueuedMessageWaitingOn | null;
  sendAt: number | null;
  payload: QueuedMessagePayload;

  systemNotice: QueuedMessageSystemNotice | null;
  deliveryMode?: QueuedMessageDeliveryMode;
  coalesce?: { key: string; state: string } | null;
}

export interface UpdateCoalescedQueuedThreadMessageInput {
  coalesceState: string;
  content: PromptInput[];
  id: string;
  sendAt: number;
  systemNotice: QueuedMessageSystemNotice;
  threadId: string;
}

export interface UpdateQueuedThreadMessageInput {
  content: PromptInput[];
  execution: Pick<
    QueuedThreadMessageRow,
    "model" | "permissionMode" | "reasoningLevel" | "serviceTier"
  > | null;
  expectedUpdatedAt: number;
  id: string;
  threadId: string;
}

export type QueuedThreadMessageRow = typeof queuedThreadMessages.$inferSelect;

export interface ClaimedQueuedThreadMessageRow extends QueuedThreadMessageRow {
  claimedAt: number;
  claimToken: string;
}

export interface QueuedMessageThreadRow {
  oldestQueuedMessageCreatedAt: number | null;
  threadId: string;
}

export interface ReorderQueuedThreadMessageArgs {
  db: DbConnection;
  groupBoundaryQueuedMessageId?: string;
  nextQueuedMessageId: string | null;
  notifier: DbNotifier;
  previousQueuedMessageId: string | null;
  queuedMessageId: string;
  threadId: string;
}

export interface SetQueuedThreadMessageGroupBoundaryArgs {
  db: DbConnection;
  expectedGroupedPrefixQueuedMessageIds: readonly string[];
  groupBoundaryQueuedMessageId: string;
  notifier: DbNotifier;
  threadId: string;
}

interface ResolveQueuedThreadMessageNeighborArgs {
  movedQueuedMessageId: string;
  neighborQueuedMessageId: string | null;
  threadId: string;
}

export interface ClaimedQueuedThreadMessageMutationArgs {
  claimToken: string;
  id: string;
}

export interface DeleteClaimedQueuedThreadMessageBatchInTransactionArgs {
  queuedMessages: readonly ClaimedQueuedThreadMessageMutationArgs[];
}

export interface ReleaseStaleQueuedMessageClaimsArgs {
  claimedBefore: number;
  protectedClaimTokens: readonly string[];
}

export interface ReorderQueuedThreadMessageSuccess {
  kind: "reordered";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface ReorderQueuedThreadMessageUnchanged {
  kind: "unchanged";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface ReorderQueuedThreadMessageNotFound {
  kind: "not_found";
}

export interface ReorderQueuedThreadMessageClaimed {
  kind: "claimed";
}

export interface ReorderQueuedThreadMessageStaleNeighbor {
  kind: "stale_neighbor";
}

export interface ReorderQueuedThreadMessageInvalidNeighborOrder {
  kind: "invalid_neighbor_order";
}

export interface QueuedThreadMessageGroupBoundarySuccess {
  kind: "updated";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface QueuedThreadMessageGroupBoundaryUnchanged {
  kind: "unchanged";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface QueuedThreadMessageGroupBoundaryNotFound {
  kind: "not_found";
}

export interface QueuedThreadMessageGroupBoundaryInvalidSender {
  kind: "invalid_sender";
}

export interface QueuedThreadMessageGroupBoundaryInvalidExecutionOptions {
  kind: "invalid_execution_options";
}

export interface QueuedThreadMessageGroupBoundaryStaleOrder {
  kind: "stale_neighbor";
}

export type ReorderQueuedThreadMessageResult =
  | ReorderQueuedThreadMessageSuccess
  | ReorderQueuedThreadMessageUnchanged
  | ReorderQueuedThreadMessageNotFound
  | ReorderQueuedThreadMessageClaimed
  | ReorderQueuedThreadMessageStaleNeighbor
  | ReorderQueuedThreadMessageInvalidNeighborOrder
  | QueuedThreadMessageGroupBoundaryInvalidSender
  | QueuedThreadMessageGroupBoundaryInvalidExecutionOptions;

export type SetQueuedThreadMessageGroupBoundaryResult =
  | QueuedThreadMessageGroupBoundarySuccess
  | QueuedThreadMessageGroupBoundaryUnchanged
  | QueuedThreadMessageGroupBoundaryNotFound
  | QueuedThreadMessageGroupBoundaryInvalidSender
  | QueuedThreadMessageGroupBoundaryInvalidExecutionOptions
  | QueuedThreadMessageGroupBoundaryStaleOrder
  | ReorderQueuedThreadMessageClaimed;

export type UpdateQueuedThreadMessageResult =
  | {
      kind: "updated";
      queuedMessage: QueuedThreadMessageRow;
      releasedEditHold: boolean;
    }
  | { kind: "not_found" }
  | { kind: "claimed" }
  | { kind: "stale" };

export interface QueuedThreadMessageEditHoldArgs {
  id: string;
  threadId: string;
}

export interface HoldQueuedThreadMessageForEditArgs extends QueuedThreadMessageEditHoldArgs {
  heldUntil: number;
}

export type HoldQueuedThreadMessageForEditResult =
  | { kind: "held" }
  | { kind: "not_found" }
  | { kind: "claimed" };

export type ReleaseQueuedMessageClaimArgs =
  ClaimedQueuedThreadMessageMutationArgs;

class ReorderQueuedThreadMessageRollback extends Error {
  constructor(readonly result: ReorderQueuedThreadMessageResult) {
    super("Queued message reorder rolled back");
  }
}

function collectLeadGroupIds(
  queuedMessages: readonly QueuedThreadMessageRow[],
): string[] {
  const ids: string[] = [];
  const firstQueuedMessage = queuedMessages[0] ?? null;

  for (const [index, queuedMessage] of queuedMessages.entries()) {
    ids.push(queuedMessage.id);

    if (!queuedMessage.groupWithNext) break;
    const nextQueuedMessage = queuedMessages[index + 1];

    if (
      !nextQueuedMessage ||
      !queuedMessageGroupingEnvelopeMatches(
        firstQueuedMessage,
        nextQueuedMessage,
      )
    ) {
      break;
    }
  }

  return ids;
}

function partitionQueuedMessageGroups(
  queuedMessages: readonly QueuedThreadMessageRow[],
): QueuedThreadMessageRow[][] {
  const groups: QueuedThreadMessageRow[][] = [];
  let index = 0;

  while (index < queuedMessages.length) {
    const size = collectLeadGroupIds(queuedMessages.slice(index)).length;
    groups.push(queuedMessages.slice(index, index + size));
    index += size;
  }

  return groups;
}

const ORDINARY_TURN_END_WAIT_KINDS = ["thread-busy", "turn-starting"] as const;

const IDLE_DRAINABLE_WAIT_KINDS = [
  ...ORDINARY_TURN_END_WAIT_KINDS,
  "stopping",
  "server-update",
] as const;

function hasOrdinaryTurnEndWait(row: QueuedThreadMessageRow): boolean {
  if (row.waitingOn === null) return true;

  try {
    const parsed = JSON.parse(row.waitingOn) as { kind?: unknown };

    return ORDINARY_TURN_END_WAIT_KINDS.some(
      (waitKind) => waitKind === parsed.kind,
    );
  } catch {
    return false;
  }
}

export function isOrdinaryTurnEndQueuedMessage(
  row: QueuedThreadMessageRow,
): boolean {
  return (
    (row.systemNotice === null ||
      queuedMessageSystemNoticeSchema.parse(JSON.parse(row.systemNotice))
        .kind === "external-message") &&
    (row.payloadKind === "continuation" || hasOrdinaryTurnEndWait(row))
  );
}

export function isIdleDrainableQueuedMessage(
  row: QueuedThreadMessageRow,
): boolean {
  if (row.failureReason !== null) return false;

  if (row.waitingOn === null) return true;

  try {
    const parsed = JSON.parse(row.waitingOn) as { kind?: unknown };

    return IDLE_DRAINABLE_WAIT_KINDS.some(
      (waitKind) => waitKind === parsed.kind,
    );
  } catch {
    return false;
  }
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function queuedMessageGroupingEnvelopeMatches(
  firstQueuedMessage: QueuedThreadMessageRow | null,
  queuedMessage: QueuedThreadMessageRow,
): boolean {
  return (
    firstQueuedMessage !== null &&
    queuedMessage.senderThreadId === firstQueuedMessage.senderThreadId &&
    queuedMessage.systemNotice === firstQueuedMessage.systemNotice &&
    queuedMessage.model === firstQueuedMessage.model &&
    queuedMessage.reasoningLevel === firstQueuedMessage.reasoningLevel &&
    queuedMessage.permissionMode === firstQueuedMessage.permissionMode &&
    queuedMessage.serviceTier === firstQueuedMessage.serviceTier
  );
}

function isQueuedThreadMessageClaimed(row: QueuedThreadMessageRow): boolean {
  return row.claimedAt !== null || row.claimToken !== null;
}

function isQueuedThreadMessageGroupEditHeld(
  rows: readonly QueuedThreadMessageRow[],
  now: number,
): boolean {
  return rows.some(
    (row) => row.editHeldUntil !== null && row.editHeldUntil > now,
  );
}

function requireClaimedQueuedThreadMessage(
  row: QueuedThreadMessageRow | null,
): ClaimedQueuedThreadMessageRow | null {
  if (!row || row.claimedAt === null || row.claimToken === null) {
    return null;
  }

  return {
    ...row,
    claimedAt: row.claimedAt,
    claimToken: row.claimToken,
  };
}

export function listQueuedThreadMessages(
  db: DbQueryConnection,
  threadId: string,
  { includeClaimed = false }: { includeClaimed?: boolean } = {},
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, threadId),
        includeClaimed ? undefined : liveQueuedThreadMessage(),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}

export function getQueuedThreadStartMessage(
  db: DbQueryConnection,
  threadId: string,
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, threadId),
          isNotNull(queuedThreadMessages.origin),
        ),
      )
      .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
      .limit(1)
      .get() ?? null
  );
}

function getQueueEdgeMessage(
  db: DbQueryConnection,
  threadId: string,
  position: "first" | "last",
): QueuedThreadMessageRow | null {
  const order = position === "first" ? asc : desc;

  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .orderBy(
        order(queuedThreadMessages.sortKey),
        order(queuedThreadMessages.id),
      )
      .limit(1)
      .get() ?? null
  );
}

function getPreviousUnclaimedQueuedThreadMessage(
  db: DbQueryConnection,
  queuedMessage: QueuedThreadMessageRow,
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, queuedMessage.threadId),
          isNull(queuedThreadMessages.claimedAt),
          isNull(queuedThreadMessages.claimToken),
          or(
            lt(queuedThreadMessages.sortKey, queuedMessage.sortKey),
            and(
              eq(queuedThreadMessages.sortKey, queuedMessage.sortKey),
              lt(queuedThreadMessages.id, queuedMessage.id),
            ),
          ),
        ),
      )
      .orderBy(
        desc(queuedThreadMessages.sortKey),
        desc(queuedThreadMessages.id),
      )
      .limit(1)
      .get() ?? null
  );
}

function clearPreviousQueuedMessageGroupEdgeInTransaction(
  db: DbTransaction,
  queuedMessage: QueuedThreadMessageRow,
  now = Date.now(),
): void {
  const previousQueuedMessage = getPreviousUnclaimedQueuedThreadMessage(
    db,
    queuedMessage,
  );

  if (!previousQueuedMessage?.groupWithNext) return;
  db.update(queuedThreadMessages)
    .set({ groupWithNext: false, updatedAt: now })
    .where(eq(queuedThreadMessages.id, previousQueuedMessage.id))
    .run();
}

function clearQueuedMessageGroupEdgeInTransaction(
  db: DbTransaction,
  queuedMessage: QueuedThreadMessageRow,
  now = Date.now(),
): void {
  if (!queuedMessage.groupWithNext) return;
  db.update(queuedThreadMessages)
    .set({ groupWithNext: false, updatedAt: now })
    .where(eq(queuedThreadMessages.id, queuedMessage.id))
    .run();
}

function resolveQueuedThreadMessageNeighbor(
  db: DbQueryConnection,
  args: ResolveQueuedThreadMessageNeighborArgs,
): QueuedThreadMessageRow | null | false {
  if (args.neighborQueuedMessageId === null) {
    return null;
  }

  if (args.neighborQueuedMessageId === args.movedQueuedMessageId) {
    return false;
  }

  const neighbor = getQueuedThreadMessage(db, args.neighborQueuedMessageId);

  if (
    !neighbor ||
    neighbor.threadId !== args.threadId ||
    isQueuedThreadMessageClaimed(neighbor)
  ) {
    return false;
  }

  return neighbor;
}

function applyQueuedThreadMessageGroupBoundary(
  db: DbTransaction,
  expectedGroupedPrefixQueuedMessageIds: readonly string[] | null,
  threadId: string,
  groupBoundaryQueuedMessageId: string,
): SetQueuedThreadMessageGroupBoundaryResult {
  const queuedMessages = listQueuedThreadMessages(db, threadId);

  const boundaryIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === groupBoundaryQueuedMessageId,
  );

  if (boundaryIndex === -1) {
    const claimedBoundary = getQueuedThreadMessage(
      db,
      groupBoundaryQueuedMessageId,
    );

    return claimedBoundary?.threadId === threadId &&
      isQueuedThreadMessageClaimed(claimedBoundary)
      ? { kind: "claimed" }
      : { kind: "not_found" };
  }

  if (expectedGroupedPrefixQueuedMessageIds !== null) {
    const currentGroupedPrefixIds = queuedMessages
      .slice(0, boundaryIndex + 1)
      .map((queuedMessage) => queuedMessage.id);

    if (
      !stringArraysEqual(
        currentGroupedPrefixIds,
        expectedGroupedPrefixQueuedMessageIds,
      )
    ) {
      return { kind: "stale_neighbor" };
    }
  }

  if (boundaryIndex > 0) {
    const firstQueuedMessage = queuedMessages[0] ?? null;
    const groupedMessages = queuedMessages.slice(0, boundaryIndex + 1);

    const hasMixedSender = groupedMessages.some(
      (queuedMessage) =>
        queuedMessage.senderThreadId !== firstQueuedMessage?.senderThreadId ||
        queuedMessage.systemNotice !== firstQueuedMessage?.systemNotice,
    );

    if (hasMixedSender) {
      return { kind: "invalid_sender" };
    }

    const hasMixedExecutionOptions = groupedMessages.some(
      (queuedMessage) =>
        !queuedMessageGroupingEnvelopeMatches(
          firstQueuedMessage,
          queuedMessage,
        ),
    );

    if (hasMixedExecutionOptions) {
      return { kind: "invalid_execution_options" };
    }
  }

  let changed = false;
  const now = Date.now();

  for (const [index, queuedMessage] of queuedMessages.entries()) {
    const groupWithNext = index < boundaryIndex;

    if (queuedMessage.groupWithNext === groupWithNext) continue;
    changed = true;
    db.update(queuedThreadMessages)
      .set({ groupWithNext, updatedAt: now })
      .where(eq(queuedThreadMessages.id, queuedMessage.id))
      .run();
  }

  return {
    kind: changed ? "updated" : "unchanged",
    queuedMessages: listQueuedThreadMessages(db, threadId, {
      includeClaimed: true,
    }),
  };
}

function applyPreservedLeadGroupAfterReorder(
  db: DbTransaction,
  threadId: string,
  originalLeadGroupIds: readonly string[],
): void {
  if (originalLeadGroupIds.length <= 1) return;

  const queuedMessages = listQueuedThreadMessages(db, threadId);

  const originalLeadGroupIdSet = new Set(originalLeadGroupIds);

  const preservesLeadGroup = queuedMessages
    .slice(0, originalLeadGroupIds.length)
    .every((queuedMessage) => originalLeadGroupIdSet.has(queuedMessage.id));

  const now = Date.now();

  for (const [index, queuedMessage] of queuedMessages.entries()) {
    const groupWithNext =
      preservesLeadGroup && index < originalLeadGroupIds.length - 1;

    if (queuedMessage.groupWithNext === groupWithNext) continue;
    db.update(queuedThreadMessages)
      .set({ groupWithNext, updatedAt: now })
      .where(eq(queuedThreadMessages.id, queuedMessage.id))
      .run();
  }
}

export type QueuedMessageThreadUnavailableReason = "archived" | "deleted";

export class QueuedMessageThreadUnavailableError extends Error {
  constructor(
    readonly threadId: string,
    readonly reason: QueuedMessageThreadUnavailableReason,
  ) {
    super(`Cannot queue a message on ${reason} thread ${threadId}`);
    this.name = "QueuedMessageThreadUnavailableError";
  }
}

function assertThreadAcceptsQueuedMessage(
  tx: DbTransaction,
  threadId: string,
): void {
  const thread = tx
    .select({ archivedAt: threads.archivedAt, deletedAt: threads.deletedAt })
    .from(threads)
    .where(eq(threads.id, threadId))
    .get();

  if (!thread || thread.deletedAt !== null) {
    throw new QueuedMessageThreadUnavailableError(threadId, "deleted");
  }

  if (thread.archivedAt !== null) {
    throw new QueuedMessageThreadUnavailableError(threadId, "archived");
  }
}

export function createQueuedThreadMessageInTransaction(
  tx: DbTransaction,
  input: CreateQueuedThreadMessageInput,
) {
  assertThreadAcceptsQueuedMessage(tx, input.threadId);

  return insertQueuedThreadMessageInTransaction(tx, input);
}

function insertQueuedThreadMessageInTransaction(
  tx: DbTransaction,
  input: CreateQueuedThreadMessageInput,
) {
  const now = Date.now();
  acquireProjectAttachmentOwnership(
    tx,
    input.threadId,
    projectAttachmentPaths(input.content),
  );
  const id = createQueuedThreadMessageId();
  const position = input.position ?? "last";
  const edge = getQueueEdgeMessage(tx, input.threadId, position);

  const sortKey = createOrderKeyBetween({
    previousKey: position === "last" ? (edge?.sortKey ?? null) : null,
    nextKey: position === "first" ? (edge?.sortKey ?? null) : null,
  });

  return tx
    .insert(queuedThreadMessages)
    .values({
      id,
      threadId: input.threadId,
      content: JSON.stringify(input.content),
      senderThreadId: input.senderThreadId ?? null,
      origin: input.origin ?? null,
      originPluginId: input.originPluginId ?? null,
      requestedByInitiator: input.requestedBy?.initiator ?? null,
      requestedByThreadId: input.requestedBy?.senderThreadId ?? null,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      permissionMode: input.permissionMode,
      serviceTier: input.serviceTier,
      waitingOn:
        input.waitingOn === null ? null : JSON.stringify(input.waitingOn),
      waitHolder:
        input.waitingOn === null ? null : waitHolderFor(input.waitingOn),
      sendAt: input.sendAt,
      systemNotice:
        input.systemNotice === null ? null : JSON.stringify(input.systemNotice),
      payloadKind: input.payload.kind,
      retryOfTurnRequestId:
        input.payload.kind === "retry"
          ? input.payload.retryOfTurnRequestId
          : null,
      retryAttempt:
        input.payload.kind === "retry" ? input.payload.attempt : null,
      retryReason: input.payload.kind === "retry" ? input.payload.reason : null,
      deliveryMode: input.deliveryMode ?? "steer",
      coalesceKey: input.coalesce?.key ?? null,
      coalesceState: input.coalesce?.state ?? null,
      groupWithNext: false,
      claimedAt: null,
      claimToken: null,
      editHeldUntil: null,
      sortKey,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getPendingCoalescedQueuedThreadMessage(
  db: DbQueryConnection,
  args: { coalesceKey: string; now: number; threadId: string },
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, args.threadId),
          eq(queuedThreadMessages.coalesceKey, args.coalesceKey),
          liveQueuedThreadMessage(),
          isNull(queuedThreadMessages.failureReason),
          isNull(queuedThreadMessages.editHeldUntil),
          gt(queuedThreadMessages.sendAt, args.now),
          sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = 'time'`,
        ),
      )
      .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
      .limit(1)
      .get() ?? null
  );
}

export function updateCoalescedQueuedThreadMessageInTransaction(
  tx: DbTransaction,
  input: UpdateCoalescedQueuedThreadMessageInput,
): QueuedThreadMessageRow | null {
  assertThreadAcceptsQueuedMessage(tx, input.threadId);
  acquireProjectAttachmentOwnership(
    tx,
    input.threadId,
    projectAttachmentPaths(input.content),
  );

  return (
    tx
      .update(queuedThreadMessages)
      .set({
        content: JSON.stringify(input.content),
        systemNotice: JSON.stringify(input.systemNotice),
        coalesceState: input.coalesceState,
        sendAt: input.sendAt,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, input.id),
          eq(queuedThreadMessages.threadId, input.threadId),
          liveQueuedThreadMessage(),
          isNull(queuedThreadMessages.failureReason),
          isNull(queuedThreadMessages.editHeldUntil),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function createQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateQueuedThreadMessageInput,
) {
  const row = db.transaction(
    (tx) => createQueuedThreadMessageInTransaction(tx, input),
    { behavior: "immediate" },
  );

  notifier.notifyThread(input.threadId, ["queue-changed"]);

  return row;
}

export interface CreateUniqueQueuedThreadMessageResult {
  created: boolean;
  row: QueuedThreadMessageRow;
}

export function createUniqueQueuedThreadMessageInTransaction(
  tx: DbTransaction,
  input: CreateQueuedThreadMessageInput,
): CreateUniqueQueuedThreadMessageResult {
  assertThreadAcceptsQueuedMessage(tx, input.threadId);
  const pending = findPendingDuplicateQueuedThreadMessage(tx, input);

  if (pending !== null) return { created: false, row: pending };

  return {
    created: true,
    row: insertQueuedThreadMessageInTransaction(tx, input),
  };
}

function matchesNullable(column: SQLiteColumn, value: string | number | null) {
  return value === null ? isNull(column) : eq(column, value);
}

function findPendingDuplicateQueuedThreadMessage(
  db: DbQueryConnection,
  input: CreateQueuedThreadMessageInput,
): QueuedThreadMessageRow | null {
  const retry = input.payload.kind === "retry" ? input.payload : null;

  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, input.threadId),
          eq(queuedThreadMessages.content, JSON.stringify(input.content)),
          matchesNullable(
            queuedThreadMessages.senderThreadId,
            input.senderThreadId ?? null,
          ),
          matchesNullable(queuedThreadMessages.origin, input.origin ?? null),
          matchesNullable(
            queuedThreadMessages.originPluginId,
            input.originPluginId ?? null,
          ),
          matchesNullable(
            queuedThreadMessages.requestedByInitiator,
            input.requestedBy?.initiator ?? null,
          ),
          matchesNullable(
            queuedThreadMessages.requestedByThreadId,
            input.requestedBy?.senderThreadId ?? null,
          ),
          eq(queuedThreadMessages.model, input.model),
          eq(queuedThreadMessages.reasoningLevel, input.reasoningLevel),
          eq(queuedThreadMessages.permissionMode, input.permissionMode),
          eq(queuedThreadMessages.serviceTier, input.serviceTier),
          eq(queuedThreadMessages.payloadKind, input.payload.kind),
          eq(queuedThreadMessages.deliveryMode, input.deliveryMode ?? "steer"),
          matchesNullable(
            queuedThreadMessages.retryOfTurnRequestId,
            retry?.retryOfTurnRequestId ?? null,
          ),
          matchesNullable(
            queuedThreadMessages.retryAttempt,
            retry?.attempt ?? null,
          ),
          matchesNullable(queuedThreadMessages.sendAt, input.sendAt),
          matchesNullable(
            queuedThreadMessages.systemNotice,
            input.systemNotice === null
              ? null
              : JSON.stringify(input.systemNotice),
          ),
          isNull(queuedThreadMessages.failureReason),
        ),
      )
      .orderBy(asc(queuedThreadMessages.sortKey))
      .limit(1)
      .get() ?? null
  );
}

export function updateQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  input: UpdateQueuedThreadMessageInput,
): UpdateQueuedThreadMessageResult {
  const result = db.transaction(
    (tx): UpdateQueuedThreadMessageResult => {
      const existing = getQueuedThreadMessage(tx, input.id);

      if (!existing || existing.threadId !== input.threadId) {
        return { kind: "not_found" };
      }

      if (isQueuedThreadMessageClaimed(existing)) {
        return { kind: "claimed" };
      }

      if (existing.updatedAt !== input.expectedUpdatedAt) {
        return { kind: "stale" };
      }

      acquireProjectAttachmentOwnership(
        tx,
        input.threadId,
        projectAttachmentPaths(input.content),
      );

      const queuedMessage = tx
        .update(queuedThreadMessages)
        .set({
          content: JSON.stringify(input.content),
          ...(input.execution ?? {}),
          coalesceKey: null,
          coalesceState: null,
          editHeldUntil: null,
          updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
        })
        .where(eq(queuedThreadMessages.id, input.id))
        .returning()
        .get();

      if (!queuedMessage) {
        return { kind: "not_found" };
      }

      return {
        kind: "updated",
        queuedMessage,
        releasedEditHold: existing.editHeldUntil !== null,
      };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "updated") {
    notifier.notifyThread(input.threadId, ["queue-changed"]);
  }

  return result;
}

export function holdQueuedThreadMessageForEdit(
  db: DbConnection,
  args: HoldQueuedThreadMessageForEditArgs,
): HoldQueuedThreadMessageForEditResult {
  return db.transaction(
    (tx): HoldQueuedThreadMessageForEditResult => {
      const existing = getQueuedThreadMessage(tx, args.id);

      if (!existing || existing.threadId !== args.threadId) {
        return { kind: "not_found" };
      }

      if (isQueuedThreadMessageClaimed(existing)) {
        return { kind: "claimed" };
      }

      tx.update(queuedThreadMessages)
        .set({ editHeldUntil: args.heldUntil })
        .where(eq(queuedThreadMessages.id, args.id))
        .run();

      return { kind: "held" };
    },
    { behavior: "immediate" },
  );
}

export function releaseQueuedThreadMessageEditHold(
  db: DbConnection,
  args: QueuedThreadMessageEditHoldArgs,
): boolean {
  return (
    db
      .update(queuedThreadMessages)
      .set({ editHeldUntil: null })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          isNotNull(queuedThreadMessages.editHeldUntil),
        ),
      )
      .run().changes > 0
  );
}

export function getQueuedThreadMessage(db: DbQueryConnection, id: string) {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, id))
      .get() ?? null
  );
}

export const DISPATCHED_QUEUED_THREAD_MESSAGE_RETENTION_MS =
  24 * 60 * 60 * 1000;

function recordDispatchedQueuedThreadMessages(
  db: DbTransaction,
  rows: readonly { id: string; threadId: string }[],
  now: number,
): void {
  db.delete(dispatchedQueuedThreadMessages)
    .where(
      lt(
        dispatchedQueuedThreadMessages.dispatchedAt,
        now - DISPATCHED_QUEUED_THREAD_MESSAGE_RETENTION_MS,
      ),
    )
    .run();
  db.insert(dispatchedQueuedThreadMessages)
    .values(
      rows.map((row) => ({
        queuedMessageId: row.id,
        threadId: row.threadId,
        dispatchedAt: now,
      })),
    )
    .onConflictDoNothing()
    .run();
}

export function wasQueuedThreadMessageDispatched(
  db: DbQueryConnection,
  args: { queuedMessageId: string; threadId: string },
): boolean {
  return (
    db
      .select({ id: dispatchedQueuedThreadMessages.queuedMessageId })
      .from(dispatchedQueuedThreadMessages)
      .where(
        and(
          eq(
            dispatchedQueuedThreadMessages.queuedMessageId,
            args.queuedMessageId,
          ),
          eq(dispatchedQueuedThreadMessages.threadId, args.threadId),
        ),
      )
      .get() !== undefined
  );
}

export function hasClaimedQueuedThreadMessages(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, threadId),
          isNotNull(queuedThreadMessages.claimedAt),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

export function deleteQueuedRetriesForThreadEventSuffixInTransaction(
  db: DbTransaction,
  args: {
    cutoffSequence: number;
    oldMaxSequence: number;
    threadId: string;
  },
): number {
  const retries = db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, args.threadId),
        eq(queuedThreadMessages.payloadKind, "retry"),
        exists(
          db
            .select({ sequence: events.sequence })
            .from(events)
            .where(
              and(
                eq(events.threadId, args.threadId),
                eq(events.type, "client/turn/requested"),
                sql`${events.sequence} >= ${args.cutoffSequence}`,
                sql`${events.sequence} <= ${args.oldMaxSequence}`,
                sql`json_extract(${events.data}, '$.requestId') = ${queuedThreadMessages.retryOfTurnRequestId}`,
              ),
            ),
        ),
      ),
    )
    .all();

  for (const retry of retries) {
    clearPreviousQueuedMessageGroupEdgeInTransaction(db, retry);
    db.delete(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, retry.id))
      .run();
  }

  return retries.length;
}

function hasAcceptedQueuedRetryInput(
  db: DbQueryConnection,
  retry: QueuedThreadMessageRow,
): boolean {
  const accepted = alias(events, "retry_chain_accepted");
  const chainRequest = alias(events, "retry_chain_request");

  return (
    db
      .select({ sequence: accepted.sequence })
      .from(accepted)
      .where(
        and(
          eq(accepted.threadId, retry.threadId),
          eq(accepted.type, "turn/input/accepted"),
          inArray(
            sql`json_extract(${accepted.data}, '$.clientRequestId')`,
            db
              .select({
                requestId: sql`json_extract(${chainRequest.data}, '$.requestId')`,
              })
              .from(chainRequest)
              .where(
                and(
                  eq(chainRequest.threadId, retry.threadId),
                  eq(chainRequest.type, "client/turn/requested"),
                  or(
                    sql`json_extract(${chainRequest.data}, '$.requestId') = ${retry.retryOfTurnRequestId}`,
                    sql`json_extract(${chainRequest.data}, '$.retryOfRequestId') = ${retry.retryOfTurnRequestId}`,
                  ),
                ),
              ),
          ),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

export function supersedeQueuedRetriesInTransaction(
  tx: DbTransaction,
  args: { threadId: string; retryOfTurnRequestId: string | null },
): number {
  const overtaken = tx
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, args.threadId),
        eq(queuedThreadMessages.payloadKind, "retry"),
        liveQueuedThreadMessage(),
        notSupersededQueuedThreadMessage(),
        ...(args.retryOfTurnRequestId === null
          ? []
          : [
              ne(
                queuedThreadMessages.retryOfTurnRequestId,
                args.retryOfTurnRequestId,
              ),
            ]),
      ),
    )
    .all();

  const now = Date.now();

  for (const retry of overtaken) {
    clearPreviousQueuedMessageGroupEdgeInTransaction(tx, retry, now);
    clearQueuedMessageGroupEdgeInTransaction(tx, retry, now);

    if (hasAcceptedQueuedRetryInput(tx, retry)) {
      tx.delete(queuedThreadMessages)
        .where(eq(queuedThreadMessages.id, retry.id))
        .run();
      continue;
    }

    tx.update(queuedThreadMessages)
      .set({
        waitingOn: JSON.stringify({ kind: "superseded" }),
        waitHolder: null,
        sendAt: null,
        updatedAt: now,
      })
      .where(eq(queuedThreadMessages.id, retry.id))
      .run();
  }

  return overtaken.length;
}

function notSupersededQueuedThreadMessage() {
  return or(
    isNull(queuedThreadMessages.waitingOn),
    sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') != 'superseded'`,
  );
}

function manuallyStoppedQueuePauseQuery(
  db: DbQueryConnection,
  threadId: string | typeof threads.id,
) {
  const interruption = alias(events, "queue_pause_interruption");
  const laterInterruption = alias(events, "queue_pause_later_interruption");
  const laterRootTurnStart = alias(events, "queue_pause_later_turn_start");
  const laterTurnRequest = alias(events, "queue_pause_later_turn_request");

  return db
    .select({ sequence: interruption.sequence })
    .from(interruption)
    .where(
      and(
        sql`${interruption.threadId} = ${threadId}`,
        eq(interruption.type, "system/thread/interrupted"),
        sql`json_extract(${interruption.data}, '$.reason') = 'manual-stop'`,
        notExists(
          db
            .select({ sequence: laterInterruption.sequence })
            .from(laterInterruption)
            .where(
              and(
                eq(laterInterruption.threadId, interruption.threadId),
                eq(laterInterruption.type, "system/thread/interrupted"),
                sql`${laterInterruption.sequence} > ${interruption.sequence}`,
              ),
            ),
        ),
        notExists(
          db
            .select({ sequence: laterRootTurnStart.sequence })
            .from(laterRootTurnStart)
            .where(
              and(
                eq(laterRootTurnStart.threadId, interruption.threadId),
                eq(laterRootTurnStart.type, "turn/started"),
                isNull(laterRootTurnStart.parentToolCallId),
                sql`${laterRootTurnStart.sequence} > ${interruption.sequence}`,
                exists(
                  db
                    .select({ sequence: laterTurnRequest.sequence })
                    .from(laterTurnRequest)
                    .where(
                      and(
                        eq(laterTurnRequest.threadId, interruption.threadId),
                        eq(laterTurnRequest.type, "client/turn/requested"),
                        sql`${laterTurnRequest.sequence} > ${interruption.sequence}`,
                        sql`${laterTurnRequest.sequence} < ${laterRootTurnStart.sequence}`,
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(1);
}

export function isThreadQueueAutoSendPaused(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return manuallyStoppedQueuePauseQuery(db, threadId).get() !== undefined;
}

function notOrdinaryTurnEndQueuedThreadMessage() {
  return or(
    and(
      isNotNull(queuedThreadMessages.systemNotice),
      ne(
        sql<string>`json_extract(${queuedThreadMessages.systemNotice}, '$.kind')`,
        "external-message",
      ),
    ),
    and(
      ne(queuedThreadMessages.payloadKind, "continuation"),
      isNotNull(queuedThreadMessages.waitingOn),
      notInArray(
        sql<string>`json_extract(${queuedThreadMessages.waitingOn}, '$.kind')`,
        [...ORDINARY_TURN_END_WAIT_KINDS],
      ),
    ),
  );
}

export function listReadySystemNoticesOnBusyThreads(
  db: DbQueryConnection,
): QueuedThreadMessageRow[] {
  return db
    .select({ row: queuedThreadMessages })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .where(
      and(
        liveQueuedThreadMessage(),
        isNull(queuedThreadMessages.failureReason),
        isNotNull(queuedThreadMessages.systemNotice),
        sql`json_extract(${queuedThreadMessages.systemNotice}, '$.kind') != 'external-message'`,
        isNull(queuedThreadMessages.waitingOn),
        notInArray(threads.status, ["idle", "pending"]),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .orderBy(asc(queuedThreadMessages.createdAt), asc(queuedThreadMessages.id))
    .all()
    .map(({ row }) => row);
}

export function listIdleThreadsWithQueuedMessages(
  db: DbConnection,
): QueuedMessageThreadRow[] {
  return db
    .select({
      threadId: threads.id,
      oldestQueuedMessageCreatedAt: min(queuedThreadMessages.createdAt),
    })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .leftJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        or(
          inArray(threads.status, ["idle", "pending"]),
          and(
            eq(threads.status, "error"),
            inArray(queuedThreadMessages.payloadKind, [
              "continuation",
              "retry",
            ]),
          ),
        ),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        or(
          notExists(manuallyStoppedQueuePauseQuery(db, threads.id)),
          notOrdinaryTurnEndQueuedThreadMessage(),
        ),
        or(isNull(threads.environmentId), ne(environments.status, "destroyed")),

        drainableQueuedThreadMessage(),
      ),
    )
    .groupBy(threads.id)
    .orderBy(asc(min(queuedThreadMessages.createdAt)), asc(threads.id))
    .all();
}

function claimQueuedThreadMessageIdsInTransaction(
  tx: DbTransaction,
  ids: readonly string[],
): ClaimedQueuedThreadMessageRow[] | null {
  if (ids.length === 0) return null;

  const now = Date.now();
  const claimToken = createQueuedThreadMessageClaimToken();

  const updated = tx
    .update(queuedThreadMessages)
    .set({ claimedAt: now, claimToken, updatedAt: now })
    .where(
      and(
        inArray(queuedThreadMessages.id, [...ids]),
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
      ),
    )
    .returning()
    .all();

  if (updated.length !== ids.length) {
    return null;
  }

  const byId = new Map(
    updated.map((row) => [row.id, requireClaimedQueuedThreadMessage(row)]),
  );

  const claimedRows: ClaimedQueuedThreadMessageRow[] = [];

  for (const id of ids) {
    const row = byId.get(id);

    if (!row) return null;
    claimedRows.push(row);
  }

  return claimedRows;
}

export type QueuedThreadMessageGroupEligibility = (
  rows: readonly QueuedThreadMessageRow[],
) => boolean;

export type QueuedThreadMessageGroupClaimPolicy =
  | {
      kind: "automatic";
      isGroupEligible: QueuedThreadMessageGroupEligibility;

      retryingFailure: boolean;
    }
  | { kind: "explicit-send" };

function isAutomaticQueuedThreadMessageGroupClaimAllowed(
  rows: readonly QueuedThreadMessageRow[],
  pauseOrdinaryMessages: boolean,
  retryingFailure: boolean,
  now: number,
): boolean {
  return (
    !isQueuedThreadMessageGroupEditHeld(rows, now) &&
    (retryingFailure || rows.every((row) => row.failureReason === null)) &&
    (!pauseOrdinaryMessages ||
      rows.every((row) => !isOrdinaryTurnEndQueuedMessage(row)))
  );
}

export function claimQueuedThreadMessageGroup(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  policy: QueuedThreadMessageGroupClaimPolicy,
): ClaimedQueuedThreadMessageRow[] | null {
  const claimedQueuedMessages = db.transaction(
    (tx) => {
      const existing = getQueuedThreadMessage(tx, id);

      if (!existing || isQueuedThreadMessageClaimed(existing)) {
        return null;
      }

      if (
        policy.kind === "automatic" &&
        hasClaimedQueuedThreadMessages(tx, existing.threadId)
      ) {
        return null;
      }

      const queuedMessages = listQueuedThreadMessages(tx, existing.threadId);

      const group =
        partitionQueuedMessageGroups(queuedMessages).find((rows) =>
          rows.some((row) => row.id === id),
        ) ?? null;

      if (group === null) {
        return null;
      }

      if (
        (policy.kind === "automatic" &&
          !isAutomaticQueuedThreadMessageGroupClaimAllowed(
            group,
            isThreadQueueAutoSendPaused(tx, existing.threadId),
            policy.retryingFailure,
            Date.now(),
          )) ||
        (policy.kind === "automatic" && !policy.isGroupEligible(group))
      ) {
        return null;
      }

      if (policy.kind === "explicit-send" && group[0]?.id !== id) {
        const now = Date.now();
        clearPreviousQueuedMessageGroupEdgeInTransaction(tx, existing, now);
        clearQueuedMessageGroupEdgeInTransaction(tx, existing, now);

        return claimQueuedThreadMessageIdsInTransaction(tx, [existing.id]);
      }

      return claimQueuedThreadMessageIdsInTransaction(
        tx,
        group.map((row) => row.id),
      );
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessages && claimedQueuedMessages.length > 0) {
    notifier.notifyThread(claimedQueuedMessages[0]!.threadId, [
      "queue-changed",
    ]);
  }

  return claimedQueuedMessages;
}

export function claimNextQueuedThreadMessageGroup(
  db: DbConnection,
  notifier: DbNotifier,
  threadId: string,
  isGroupEligible: QueuedThreadMessageGroupEligibility,
): ClaimedQueuedThreadMessageRow[] | null {
  const claimedQueuedMessages = db.transaction(
    (tx) => {
      if (hasClaimedQueuedThreadMessages(tx, threadId)) {
        return null;
      }

      const queuedMessages = listQueuedThreadMessages(tx, threadId);
      const pauseOrdinaryMessages = isThreadQueueAutoSendPaused(tx, threadId);
      const now = Date.now();

      const drainableGroups = partitionQueuedMessageGroups(
        queuedMessages,
      ).filter((rows) => rows.some(isIdleDrainableQueuedMessage));

      const editHeldIndex = drainableGroups.findIndex((rows) =>
        isQueuedThreadMessageGroupEditHeld(rows, now),
      );

      const group =
        drainableGroups
          .slice(0, editHeldIndex === -1 ? undefined : editHeldIndex)
          .find(
            (rows) =>
              isGroupEligible(rows) &&
              isAutomaticQueuedThreadMessageGroupClaimAllowed(
                rows,
                pauseOrdinaryMessages,
                false,
                now,
              ),
          ) ?? null;

      if (group === null) {
        return null;
      }

      return claimQueuedThreadMessageIdsInTransaction(
        tx,
        group.map((row) => row.id),
      );
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessages && claimedQueuedMessages.length > 0) {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }

  return claimedQueuedMessages;
}

export function reorderQueuedThreadMessage({
  db,
  groupBoundaryQueuedMessageId,
  nextQueuedMessageId,
  notifier,
  previousQueuedMessageId,
  queuedMessageId,
  threadId,
}: ReorderQueuedThreadMessageArgs): ReorderQueuedThreadMessageResult {
  let result: ReorderQueuedThreadMessageResult;

  try {
    result = db.transaction(
      (tx): ReorderQueuedThreadMessageResult => {
        const movedQueuedMessage = getQueuedThreadMessage(tx, queuedMessageId);

        if (!movedQueuedMessage || movedQueuedMessage.threadId !== threadId) {
          return { kind: "not_found" };
        }

        if (isQueuedThreadMessageClaimed(movedQueuedMessage)) {
          return { kind: "claimed" };
        }

        const previousQueuedMessage = resolveQueuedThreadMessageNeighbor(tx, {
          movedQueuedMessageId: queuedMessageId,
          neighborQueuedMessageId: previousQueuedMessageId,
          threadId,
        });

        const nextQueuedMessage = resolveQueuedThreadMessageNeighbor(tx, {
          movedQueuedMessageId: queuedMessageId,
          neighborQueuedMessageId: nextQueuedMessageId,
          threadId,
        });

        if (previousQueuedMessage === false || nextQueuedMessage === false) {
          return { kind: "stale_neighbor" };
        }

        if (
          previousQueuedMessage !== null &&
          nextQueuedMessage !== null &&
          previousQueuedMessage.sortKey >= nextQueuedMessage.sortKey
        ) {
          return { kind: "invalid_neighbor_order" };
        }

        const currentQueuedMessages = listQueuedThreadMessages(tx, threadId);
        const originalLeadGroupIds = collectLeadGroupIds(currentQueuedMessages);

        const currentIndex = currentQueuedMessages.findIndex(
          (queuedMessage) => queuedMessage.id === queuedMessageId,
        );

        const currentPreviousQueuedMessageId =
          currentQueuedMessages[currentIndex - 1]?.id ?? null;

        const currentNextQueuedMessageId =
          currentQueuedMessages[currentIndex + 1]?.id ?? null;

        if (
          currentPreviousQueuedMessageId === previousQueuedMessageId &&
          currentNextQueuedMessageId === nextQueuedMessageId
        ) {
          if (groupBoundaryQueuedMessageId !== undefined) {
            const groupResult = applyQueuedThreadMessageGroupBoundary(
              tx,
              null,
              threadId,
              groupBoundaryQueuedMessageId,
            );

            if (groupResult.kind === "not_found") {
              return { kind: "stale_neighbor" };
            }

            if (groupResult.kind === "claimed") {
              return { kind: "claimed" };
            }

            if (groupResult.kind === "stale_neighbor") {
              return { kind: "stale_neighbor" };
            }

            if (groupResult.kind === "invalid_sender") {
              return { kind: "invalid_sender" };
            }

            if (groupResult.kind === "invalid_execution_options") {
              return { kind: "invalid_execution_options" };
            }

            if (groupResult.kind === "updated") {
              return {
                kind: "reordered",
                queuedMessages: groupResult.queuedMessages,
              };
            }
          }

          return {
            kind: "unchanged",
            queuedMessages: listQueuedThreadMessages(tx, threadId, {
              includeClaimed: true,
            }),
          };
        }

        const sortKey = createOrderKeyBetween({
          previousKey: previousQueuedMessage?.sortKey ?? null,
          nextKey: nextQueuedMessage?.sortKey ?? null,
        });

        const updated = tx
          .update(queuedThreadMessages)
          .set({ sortKey, updatedAt: Date.now() })
          .where(
            and(
              eq(queuedThreadMessages.id, queuedMessageId),
              isNull(queuedThreadMessages.claimedAt),
              isNull(queuedThreadMessages.claimToken),
            ),
          )
          .returning({ id: queuedThreadMessages.id })
          .get();

        if (!updated) {
          return { kind: "stale_neighbor" };
        }

        if (groupBoundaryQueuedMessageId !== undefined) {
          const groupResult = applyQueuedThreadMessageGroupBoundary(
            tx,
            null,
            threadId,
            groupBoundaryQueuedMessageId,
          );

          if (groupResult.kind === "not_found") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "stale_neighbor",
            });
          }

          if (groupResult.kind === "claimed") {
            throw new ReorderQueuedThreadMessageRollback({ kind: "claimed" });
          }

          if (groupResult.kind === "stale_neighbor") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "stale_neighbor",
            });
          }

          if (groupResult.kind === "invalid_sender") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "invalid_sender",
            });
          }

          if (groupResult.kind === "invalid_execution_options") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "invalid_execution_options",
            });
          }

          if (groupResult.kind === "updated") {
            return {
              kind: "reordered",
              queuedMessages: groupResult.queuedMessages,
            };
          }
        } else {
          applyPreservedLeadGroupAfterReorder(
            tx,
            threadId,
            originalLeadGroupIds,
          );
        }

        return {
          kind: "reordered",
          queuedMessages: listQueuedThreadMessages(tx, threadId, {
            includeClaimed: true,
          }),
        };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof ReorderQueuedThreadMessageRollback) {
      result = error.result;
    } else {
      throw error;
    }
  }

  if (result.kind === "reordered") {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }

  return result;
}

export function setQueuedThreadMessageGroupBoundary({
  db,
  expectedGroupedPrefixQueuedMessageIds,
  groupBoundaryQueuedMessageId,
  notifier,
  threadId,
}: SetQueuedThreadMessageGroupBoundaryArgs): SetQueuedThreadMessageGroupBoundaryResult {
  const result = db.transaction(
    (tx) =>
      applyQueuedThreadMessageGroupBoundary(
        tx,
        expectedGroupedPrefixQueuedMessageIds,
        threadId,
        groupBoundaryQueuedMessageId,
      ),
    { behavior: "immediate" },
  );

  if (result.kind === "updated") {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }

  return result;
}

export interface RequeueClaimedQueuedThreadMessagesArgs {
  claims: readonly ClaimedQueuedThreadMessageMutationArgs[];
  threadId: string;
  waitingOn: QueuedMessageWaitingOn;
  sendAt: number | null;
}

export function requeueClaimedQueuedThreadMessages(
  db: DbQueryConnection,
  notifier: DbNotifier,
  args: RequeueClaimedQueuedThreadMessagesArgs,
): QueuedThreadMessageRow | null {
  const lead = args.claims[0];

  if (lead === undefined) return null;

  const queued = db.transaction(
    (tx) => {
      assertThreadAcceptsQueuedMessage(tx, args.threadId);
      const now = Date.now();

      for (const claim of args.claims) {
        tx.update(queuedThreadMessages)
          .set({
            claimedAt: null,
            claimToken: null,
            waitingOn: JSON.stringify(args.waitingOn),
            waitHolder: waitHolderFor(args.waitingOn),
            sendAt: args.sendAt,
            failureReason: null,
            failureCount: 0,
            nextAttemptAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(queuedThreadMessages.id, claim.id),
              eq(queuedThreadMessages.claimToken, claim.claimToken),
            ),
          )
          .run();
      }

      return (
        tx
          .update(queuedThreadMessages)
          .set({
            waitingOn: JSON.stringify(args.waitingOn),
            waitHolder: waitHolderFor(args.waitingOn),
            sendAt: args.sendAt,

            failureReason: null,
            failureCount: 0,
            nextAttemptAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(queuedThreadMessages.id, lead.id),
              eq(queuedThreadMessages.threadId, args.threadId),
              liveQueuedThreadMessage(),
            ),
          )
          .returning()
          .get() ?? null
      );
    },
    { behavior: "immediate" },
  );

  if (queued) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }

  return queued;
}

export function releaseQueuedMessageClaim(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseQueuedMessageClaimArgs,
): boolean {
  const existing = db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.id, args.id))
    .get();

  if (
    !existing ||
    existing.claimedAt === null ||
    existing.claimToken !== args.claimToken
  ) {
    return false;
  }

  const now = Date.now();

  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(
      and(
        eq(queuedThreadMessages.id, args.id),
        isNotNull(queuedThreadMessages.claimedAt),
        eq(queuedThreadMessages.claimToken, args.claimToken),
      ),
    )
    .run();

  if (result.changes === 0) {
    return false;
  }

  notifier.notifyThread(existing.threadId, ["queue-changed"]);

  return true;
}

export function releaseStaleQueuedMessageClaims(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseStaleQueuedMessageClaimsArgs,
): number {
  const protectedClaimTokens = [...args.protectedClaimTokens];

  const staleClaimWhere = and(
    isNotNull(queuedThreadMessages.claimedAt),
    lt(queuedThreadMessages.claimedAt, args.claimedBefore),
    ...(protectedClaimTokens.length > 0
      ? [
          or(
            isNull(queuedThreadMessages.claimToken),
            notInArray(queuedThreadMessages.claimToken, protectedClaimTokens),
          )!,
        ]
      : []),
  );

  const staleRows = db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
    })
    .from(queuedThreadMessages)
    .where(staleClaimWhere)
    .all();

  if (staleRows.length === 0) {
    return 0;
  }

  const now = Date.now();

  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(staleClaimWhere)
    .run();

  for (const threadId of new Set(staleRows.map((row) => row.threadId))) {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }

  return result.changes;
}

export function deleteClaimedQueuedThreadMessageBatchInTransaction(
  db: DbTransaction,
  args: DeleteClaimedQueuedThreadMessageBatchInTransactionArgs,
): boolean {
  if (args.queuedMessages.length === 0) return false;
  const claimToken = args.queuedMessages[0]!.claimToken;

  if (
    args.queuedMessages.some(
      (queuedMessage) => queuedMessage.claimToken !== claimToken,
    )
  ) {
    return false;
  }

  const ids = args.queuedMessages.map((queuedMessage) => queuedMessage.id);

  const existingRows = db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        inArray(queuedThreadMessages.id, ids),
        eq(queuedThreadMessages.claimToken, claimToken),
      ),
    )
    .all();

  if (existingRows.length !== ids.length) {
    return false;
  }

  const deletedRows = db
    .delete(queuedThreadMessages)
    .where(
      and(
        inArray(queuedThreadMessages.id, ids),
        eq(queuedThreadMessages.claimToken, claimToken),
      ),
    )
    .returning({ id: queuedThreadMessages.id })
    .all();

  if (deletedRows.length !== ids.length) {
    return false;
  }

  const removingIds = new Set(ids);
  const now = Date.now();

  recordDispatchedQueuedThreadMessages(db, existingRows, now);

  for (const existing of existingRows) {
    const previousQueuedMessage = getPreviousUnclaimedQueuedThreadMessage(
      db,
      existing,
    );

    if (
      previousQueuedMessage &&
      !removingIds.has(previousQueuedMessage.id) &&
      previousQueuedMessage.groupWithNext
    ) {
      db.update(queuedThreadMessages)
        .set({ groupWithNext: false, updatedAt: now })
        .where(eq(queuedThreadMessages.id, previousQueuedMessage.id))
        .run();
    }
  }

  return true;
}

function liveQueuedThreadMessage() {
  return and(
    isNull(queuedThreadMessages.claimedAt),
    isNull(queuedThreadMessages.claimToken),
  );
}

function automaticallyDrainableQueuedThreadMessage() {
  return and(
    liveQueuedThreadMessage(),
    isNull(queuedThreadMessages.failureReason),
  );
}

function drainableQueuedThreadMessage() {
  return and(
    automaticallyDrainableQueuedThreadMessage(),
    or(
      isNull(queuedThreadMessages.waitingOn),
      inArray(
        sql<string>`json_extract(${queuedThreadMessages.waitingOn}, '$.kind')`,
        [...IDLE_DRAINABLE_WAIT_KINDS],
      ),
    ),
  );
}

export interface ListQueuedThreadMessagesForApiArgs {
  threadId?: string;
  waitHolder?: QueuedMessageWaitHolder;
}

export function listQueuedThreadMessagesForApi(
  db: DbQueryConnection,
  args: ListQueuedThreadMessagesForApiArgs,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        liveQueuedThreadMessage(),
        ...(args.threadId === undefined
          ? []
          : [eq(queuedThreadMessages.threadId, args.threadId)]),
        ...(args.waitHolder === undefined
          ? []
          : [eq(queuedThreadMessages.waitHolder, args.waitHolder)]),
      ),
    )
    .orderBy(asc(queuedThreadMessages.createdAt), asc(queuedThreadMessages.id))
    .all();
}

export interface QueuedThreadMessageCounts {
  threadId: string;
  queuedMessageCount: number;

  failedQueuedMessageCount: number;
}

export function listQueuedThreadMessageCountsByThreadIds(
  db: DbQueryConnection,
  args: { threadIds: readonly string[] },
): QueuedThreadMessageCounts[] {
  const threadIds = [...new Set(args.threadIds)];

  if (threadIds.length === 0) return [];

  return db
    .select({
      threadId: queuedThreadMessages.threadId,
      queuedMessageCount: count(queuedThreadMessages.id),
      failedQueuedMessageCount: count(queuedThreadMessages.failureReason),
    })
    .from(queuedThreadMessages)
    .where(
      sql`${queuedThreadMessages.threadId} IN (SELECT value FROM json_each(${JSON.stringify(threadIds)}))`,
    )
    .groupBy(queuedThreadMessages.threadId)
    .all();
}

function waitHolderFor(
  waitingOn: QueuedMessageWaitingOn,
): QueuedMessageWaitHolder | null {
  return waitingOn.kind === "plugin"
    ? `${QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX}${waitingOn.pluginId}`
    : null;
}

export interface SetQueuedThreadMessageWaitingOnArgs {
  id: string;
  threadId: string;
  waitingOn: QueuedMessageWaitingOn;

  sendAt: number | null;
}

export interface ClearQueuedThreadMessageWaitingOnArgs {
  id: string;
  threadId: string;
  retainSendAt?: number;
}

export interface ListQueuedThreadMessagesWaitingOnKindArgs {
  kind: QueuedMessageWaitingOnKind;
  threadId: string;
}

export function setQueuedThreadMessageWaitingOn(
  db: DbConnection,
  notifier: DbNotifier,
  args: SetQueuedThreadMessageWaitingOnArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        waitingOn: JSON.stringify(args.waitingOn),
        waitHolder: waitHolderFor(args.waitingOn),
        sendAt: args.sendAt,

        failureReason: null,
        failureCount: 0,
        nextAttemptAt: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }

  return updated;
}

export interface SetQueuedThreadMessageFailureReasonArgs {
  id: string;
  threadId: string;
  failureReason: string;
  now: number;

  retryDelaysMs: readonly number[];
}

export function setQueuedThreadMessageFailureReason(
  db: DbConnection,
  notifier: DbNotifier,
  args: SetQueuedThreadMessageFailureReasonArgs,
): QueuedThreadMessageRow | null {
  const updated = db.transaction(
    (tx): QueuedThreadMessageRow | null => {
      const existing = getQueuedThreadMessage(tx, args.id);

      if (
        !existing ||
        existing.threadId !== args.threadId ||
        isQueuedThreadMessageClaimed(existing)
      ) {
        return null;
      }

      const failureCount = existing.failureCount + 1;
      const delayMs = args.retryDelaysMs[failureCount - 1];

      return (
        tx
          .update(queuedThreadMessages)
          .set({
            failureReason: args.failureReason,
            failureCount,
            nextAttemptAt: delayMs === undefined ? null : args.now + delayMs,
            updatedAt: args.now,
          })
          .where(
            and(
              eq(queuedThreadMessages.id, args.id),
              eq(queuedThreadMessages.threadId, args.threadId),
              liveQueuedThreadMessage(),
            ),
          )
          .returning()
          .get() ?? null
      );
    },
    { behavior: "immediate" },
  );

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }

  return updated;
}

export function listRetryableFailedQueuedThreadMessages(
  db: DbQueryConnection,
  now: number,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.failureReason),
        isNotNull(queuedThreadMessages.nextAttemptAt),
        lte(queuedThreadMessages.nextAttemptAt, now),
        liveQueuedThreadMessage(),
        exists(
          db
            .select({ live: sql`1` })
            .from(threads)
            .where(
              and(
                eq(threads.id, queuedThreadMessages.threadId),
                isNull(threads.archivedAt),
                isNull(threads.deletedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      asc(queuedThreadMessages.nextAttemptAt),
      asc(queuedThreadMessages.id),
    )
    .all();
}

export function clearQueuedThreadMessageWaitingOn(
  db: DbConnection,
  notifier: DbNotifier,
  args: ClearQueuedThreadMessageWaitingOnArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        waitingOn:
          args.retainSendAt === undefined
            ? null
            : JSON.stringify({ kind: "time" }),
        waitHolder: null,
        sendAt: args.retainSendAt ?? null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }

  return updated;
}

export function listDueScheduledQueuedThreadMessages(
  db: DbQueryConnection,
  now: number,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.sendAt),
        lte(queuedThreadMessages.sendAt, now),
        automaticallyDrainableQueuedThreadMessage(),
        exists(
          db
            .select({ live: sql`1` })
            .from(threads)
            .where(
              and(
                eq(threads.id, queuedThreadMessages.threadId),
                isNull(threads.archivedAt),
                isNull(threads.deletedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sendAt), asc(queuedThreadMessages.id))
    .all();
}

export function listQueuedThreadMessagesByWaitHolder(
  db: DbQueryConnection,
  waitHolder: QueuedMessageWaitHolder,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.waitHolder, waitHolder),
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(
      asc(queuedThreadMessages.createdAt),
      asc(queuedThreadMessages.sortKey),
      asc(queuedThreadMessages.id),
    )
    .all();
}

export interface QueuedThreadMessagePluginWaitRef {
  id: string;
  threadId: string;
  waitHolder: QueuedMessageWaitHolder;
}

export function listQueuedThreadMessagePluginWaitRefs(
  db: DbQueryConnection,
): QueuedThreadMessagePluginWaitRef[] {
  return db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
      waitHolder: queuedThreadMessages.waitHolder,
    })
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.waitHolder),
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(
      asc(queuedThreadMessages.createdAt),
      asc(queuedThreadMessages.sortKey),
      asc(queuedThreadMessages.id),
    )
    .all()
    .flatMap((row) =>
      row.waitHolder === null ? [] : [{ ...row, waitHolder: row.waitHolder }],
    );
}

export function listQueuedThreadMessagesWaitingOnKind(
  db: DbQueryConnection,
  args: ListQueuedThreadMessagesWaitingOnKindArgs,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, args.threadId),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = ${args.kind}`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}

export function hasQueuedRetryOfTurnRequest(
  db: DbQueryConnection,
  args: { threadId: string; retryOfTurnRequestId: string },
): boolean {
  return (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, args.threadId),
          eq(
            queuedThreadMessages.retryOfTurnRequestId,
            args.retryOfTurnRequestId,
          ),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

export function getQueuedThreadContinuation(
  db: DbQueryConnection,
  threadId: string,
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, threadId),
          inArray(queuedThreadMessages.payloadKind, ["retry", "continuation"]),
          notSupersededQueuedThreadMessage(),
        ),
      )
      .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
      .limit(1)
      .get() ?? null
  );
}

export function listThreadIdsWithHostOfflineQueueWaits(
  db: DbQueryConnection,
  hostId: string,
): string[] {
  return db
    .selectDistinct({ threadId: queuedThreadMessages.threadId })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .innerJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        eq(environments.hostId, hostId),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = 'host-offline'`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .all()
    .map((row) => row.threadId);
}

export function listThreadIdsWithHostAwayQueueWaits(
  db: DbQueryConnection,
): string[] {
  return db
    .selectDistinct({ threadId: queuedThreadMessages.threadId })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .where(
      and(
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = 'host-away'`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .all()
    .map((row) => row.threadId);
}

export function listThreadIdsWithServerUpdateQueueWaits(
  db: DbQueryConnection,
): string[] {
  return db
    .selectDistinct({ threadId: queuedThreadMessages.threadId })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .where(
      and(
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = 'server-update'`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .all()
    .map((row) => row.threadId);
}

export interface DeletedQueuedThreadMessage {
  row: QueuedThreadMessageRow;
  previousGroupedQueuedMessageId: string | null;
  nextQueuedMessageId: string | null;
}

export type RestoreDeletedQueuedThreadMessageResult =
  | { kind: "restored"; queuedMessage: QueuedThreadMessageRow }
  | { kind: "exists" }
  | { kind: "thread_not_found" };

function getNextUnclaimedQueuedThreadMessage(
  db: DbQueryConnection,
  queuedMessage: QueuedThreadMessageRow,
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, queuedMessage.threadId),
          isNull(queuedThreadMessages.claimedAt),
          isNull(queuedThreadMessages.claimToken),
          or(
            gt(queuedThreadMessages.sortKey, queuedMessage.sortKey),
            and(
              eq(queuedThreadMessages.sortKey, queuedMessage.sortKey),
              gt(queuedThreadMessages.id, queuedMessage.id),
            ),
          ),
        ),
      )
      .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
      .limit(1)
      .get() ?? null
  );
}

export function deleteQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
): DeletedQueuedThreadMessage | null {
  const deleted = db.transaction(
    (tx): DeletedQueuedThreadMessage | null => {
      const existing = getQueuedThreadMessage(tx, id);

      if (!existing) return null;

      const previous = getPreviousUnclaimedQueuedThreadMessage(tx, existing);
      const next = getNextUnclaimedQueuedThreadMessage(tx, existing);
      clearPreviousQueuedMessageGroupEdgeInTransaction(tx, existing);
      tx.delete(queuedThreadMessages)
        .where(eq(queuedThreadMessages.id, id))
        .run();

      return {
        row: existing,
        previousGroupedQueuedMessageId: previous?.groupWithNext
          ? previous.id
          : null,
        nextQueuedMessageId: next?.id ?? null,
      };
    },
    { behavior: "immediate" },
  );

  if (!deleted) return null;
  notifier.notifyThread(deleted.row.threadId, ["queue-changed"]);

  return deleted;
}

export function restoreDeletedQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  deleted: DeletedQueuedThreadMessage,
): RestoreDeletedQueuedThreadMessageResult {
  const { row } = deleted;

  const result = db.transaction(
    (tx): RestoreDeletedQueuedThreadMessageResult => {
      if (getQueuedThreadMessage(tx, row.id)) return { kind: "exists" };

      const thread = tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, row.threadId))
        .get();

      if (!thread) return { kind: "thread_not_found" };

      const now = Date.now();

      const inserted = tx
        .insert(queuedThreadMessages)
        .values({
          ...row,
          groupWithNext: false,
          claimedAt: null,
          claimToken: null,
          editHeldUntil: null,
          updatedAt: Math.max(now, row.updatedAt + 1),
        })
        .returning()
        .get();

      const previous = getPreviousUnclaimedQueuedThreadMessage(tx, inserted);

      if (
        previous !== null &&
        previous.id === deleted.previousGroupedQueuedMessageId &&
        !previous.groupWithNext &&
        queuedMessageGroupingEnvelopeMatches(previous, inserted)
      ) {
        tx.update(queuedThreadMessages)
          .set({ groupWithNext: true, updatedAt: now })
          .where(eq(queuedThreadMessages.id, previous.id))
          .run();
      }

      const next = row.groupWithNext
        ? getNextUnclaimedQueuedThreadMessage(tx, inserted)
        : null;

      if (
        next !== null &&
        next.id === deleted.nextQueuedMessageId &&
        queuedMessageGroupingEnvelopeMatches(inserted, next)
      ) {
        return {
          kind: "restored",
          queuedMessage: tx
            .update(queuedThreadMessages)
            .set({ groupWithNext: true })
            .where(eq(queuedThreadMessages.id, inserted.id))
            .returning()
            .get(),
        };
      }

      return { kind: "restored", queuedMessage: inserted };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "restored") {
    notifier.notifyThread(row.threadId, ["queue-changed"]);
  }

  return result;
}
