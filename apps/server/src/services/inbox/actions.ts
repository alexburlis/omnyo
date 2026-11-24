import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import {
  queuedThreadMessages,
  shelveThreadFamily,
  threadQuestions,
  threadOwnerInputs,
  threads,
  unshelveThreadFamily,
  type DbQueryConnection,
} from "@omnyo/db";
import {
  INBOX_DEFAULT_WAIT_MS,
  INBOX_REMINDER_MS,
  type InboxActRequest,
  type InboxActResult,
  type InboxEntry,
  type Thread,
} from "@omnyo/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  archiveThreadAndChildren,
  unarchiveThreadWithLifecycleEffects,
} from "../threads/thread-archive.js";
import { acceptThreadSendRequest } from "../threads/thread-send-request.js";
import { continueThread } from "../threads/thread-continue.js";
import { retryFailedTurn } from "../threads/turn-retry.js";
import { getThread } from "@omnyo/db";
import { OWNER_ACTOR, type InboxActor } from "./actor.js";
import { collectInboxEntry, collectInboxSnapshot } from "./collect.js";
import {
  acknowledgeOwnerMessage,
  cancelHeldRetryRows,
  endProducers,
  writeReceipt,
} from "./engine.js";
import {
  familyIdsOf,
  getInboxThread,
  inboxRootOf,
  isInboxDomainRoot,
} from "./family.js";
import {
  consumeResults,
  getLatestMove,
  getReceipts,
  getWait,
  insertConditions,
  insertMove,
  insertOwnerInput,
  insertWait,
  listConditions,
  listOpenFailures,
  listOpenWaits,
  listOwnerInputs,
  listPendingChatConditionsForSource,
  listUnconsumedResults,
  markMoveUndone,
  nextKeyGeneration,
  parseIdList,
  reopenSettledChatStallReceipts,
  setCondition,
  setReceiptsHandled,
  updateFailure,
  updateOwnerInputs,
  updateWait,
  type FailureRow,
  type MoveRow,
  type WaitRow,
} from "./store.js";
import { reconcileStoredResults } from "./waits.js";

interface ArchiveWriteSet {
  threadIds: string[];
  waits: WaitRow[];
  failures: FailureRow[];
  inputs: { id: string; state: string }[];
  waiterWaits: WaitRow[];
  waiterReceiptIds: string[];
}

interface RunsWriteSet {
  runs: { rootId: string; set: ArchiveWriteSet }[];
}

interface WaitWriteSet {
  createdWaitIds: string[];
  cancelledWaits: WaitRow[];
  updatedWaits: WaitRow[];
}

interface ShelfWriteSet {
  shelvedBefore: boolean;
}

function updated(): never {
  throw new ApiError(409, "inbox_updated", "Updated");
}

function refused(message: string): never {
  throw new ApiError(409, "invalid_request", message);
}

function requireOwner(actor: InboxActor): void {
  if (actor.kind !== "owner")
    throw new ApiError(
      403,
      "owner_only",
      "Only the owner can act on the Inbox. Agents propose instead.",
    );
}

function requireRoot(db: DbQueryConnection, threadId: string) {
  const root = getInboxThread(db, threadId);

  if (root === null || root.deletedAt !== null)
    throw new ApiError(404, "thread_not_found", "Thread not found");

  if (!isInboxDomainRoot(root))
    refused("Inbox actions apply to a top-level chat.");

  return root;
}

function requireDisplayed(
  entry: InboxEntry | null,
  displayed: readonly string[],
  latch: string | undefined,
): string[] {
  if (entry === null) updated();

  if (latch !== undefined && latch !== entry.latch) updated();

  const outstanding = new Set(
    (entry.card?.causes ?? []).map((cause) => cause.receiptId),
  );

  for (const id of displayed) if (!outstanding.has(id)) updated();

  return [...displayed];
}

function handle(
  db: DbQueryConnection,
  ids: readonly string[],
  moveId: string,
  now: number,
): void {
  setReceiptsHandled(db, { ids, moveId, now });

  const handled = new Set(ids);

  for (const wait of listOpenWaitsForReceipts(db, ids)) {
    if (
      wait.status === "proposed" &&
      wait.proposalReceiptId !== null &&
      handled.has(wait.proposalReceiptId)
    )
      updateWait(
        db,
        wait.id,
        { status: "closed", closedReason: "withdrawn", closedAt: now },
        now,
      );
  }
}

function listOpenWaitsForReceipts(
  db: DbQueryConnection,
  receiptIds: readonly string[],
): WaitRow[] {
  const receipts = getReceipts(db, receiptIds);
  const roots = [...new Set(receipts.map((receipt) => receipt.rootThreadId))];

  return roots.flatMap((rootId) => listOpenWaits(db, familyIdsOf(db, rootId)));
}

function recordMove(
  db: DbQueryConnection,
  args: {
    rootThreadId: string;
    kind: string;
    handled: readonly string[];
    writeSet: unknown;
    now: number;
  },
): MoveRow {
  return insertMove(db, {
    rootThreadId: args.rootThreadId,
    kind: args.kind,
    handledReceiptIds: args.handled,
    writeSet: args.writeSet,
    now: args.now,
  });
}

function notifyRoots(deps: Pick<AppDeps, "hub">, ids: readonly string[]): void {
  for (const id of new Set(ids)) deps.hub.notifyThread(id, ["work-changed"]);
}

function familyBlocked(
  entry: InboxEntry,
  db: DbQueryConnection,
  rootId: string,
): boolean {
  if (entry.card?.questionMode === "required") return true;

  return familyIdsOf(db, rootId).some((id) => {
    const thread = getInboxThread(db, id);

    return (
      thread !== null &&
      thread.archivedAt === null &&
      (thread.status === "active" ||
        thread.status === "starting" ||
        thread.status === "stopping")
    );
  });
}

function closeWaitRows(
  db: DbQueryConnection,
  waits: readonly WaitRow[],
  reason: string,
  now: number,
): void {
  for (const wait of waits)
    updateWait(
      db,
      wait.id,
      { status: "closed", closedReason: reason, closedAt: now },
      now,
    );
}

function deleteWakeRows(
  db: DbQueryConnection,
  waits: readonly WaitRow[],
): void {
  const ids = waits
    .map((wait) => wait.dispatchQueuedMessageId)
    .filter((id): id is string => id !== null);

  if (ids.length > 0)
    db.delete(queuedThreadMessages)
      .where(inArray(queuedThreadMessages.id, ids))
      .run();
}

function archiveWriteSet(
  db: DbQueryConnection,
  args: { rootId: string; now: number },
): ArchiveWriteSet {
  const ids = familyIdsOf(db, args.rootId);
  const waits = listOpenWaits(db, ids);
  const failures = listOpenFailures(db, ids);

  const inputs = listOwnerInputs(db, {
    threadIds: ids,
    states: ["running", "owed", "handed-off"],
  });

  for (const failure of failures)
    if (failure.state === "held")
      cancelHeldRetryRows(db, { threadId: failure.threadId, now: args.now });

  deleteWakeRows(db, waits);
  closeWaitRows(db, waits, "archived", args.now);

  for (const failure of failures)
    updateFailure(
      db,
      failure.id,
      { state: "resolved", resolvedBy: "archive", resolvedAt: args.now },
      args.now,
    );

  updateOwnerInputs(
    db,
    inputs.map((input) => input.id),
    { state: "waived" },
    args.now,
  );
  endProducers(db, { threadIds: ids, reason: "archived", now: args.now });

  const waiterWaits: WaitRow[] = [];
  const waiterReceiptIds: string[] = [];

  for (const id of ids) {
    for (const { condition, wait } of listPendingChatConditionsForSource(
      db,
      id,
    )) {
      if (condition.state === "met" || ids.includes(wait.threadId)) continue;

      const retained = listUnconsumedResults(db, wait.marker).length > 0;

      if (retained) continue;

      waiterWaits.push(wait);
      updateWait(
        db,
        wait.id,
        {
          status: "closed",
          closedReason: "source-archived",
          closedAt: args.now,
        },
        args.now,
      );

      const receipt = writeReceipt(db, {
        threadId: wait.threadId,
        cause: "chain",
        summary: `${getInboxThread(db, id)?.title ?? "The source"} was archived without a result`,
        outcomeRef: wait.id,
        waitId: wait.id,
        coveredInputIds: [],
        now: args.now,
      });

      if (receipt !== null) waiterReceiptIds.push(receipt.id);
    }
  }

  return {
    threadIds: ids,
    waits,
    failures,
    inputs: inputs.map((input) => ({ id: input.id, state: input.state })),
    waiterWaits,
    waiterReceiptIds,
  };
}

export function archiveRootViaInbox(
  deps: AppDeps,
  args: {
    rootId: string;
    displayed: readonly string[] | "all";
    stopRunning: boolean;
    now: number;
  },
): { moveId: string; archivedThreadIds: string[] } {
  const root = requireRoot(deps.db, args.rootId);
  const entry = collectInboxEntry(deps, root.id, args.now);

  if (entry === null) updated();

  const outstanding = (entry.card?.causes ?? []).map(
    (cause) => cause.receiptId,
  );

  const displayed =
    args.displayed === "all" ? outstanding : [...args.displayed];

  for (const id of outstanding)
    if (!displayed.includes(id))
      refused("Archive needs every outstanding cause displayed first.");

  if (!args.stopRunning && familyBlocked(entry, deps.db, root.id))
    refused(
      "The chat has a pending question or running work; use stop and archive.",
    );

  const { move, writeSet } = deps.db.transaction(
    (tx) => {
      const writeSet = archiveWriteSet(tx, { rootId: root.id, now: args.now });

      const move = recordMove(tx, {
        rootThreadId: root.id,
        kind: "archive",
        handled: displayed,
        writeSet,
        now: args.now,
      });

      setReceiptsHandled(tx, {
        ids: displayed,
        moveId: move.id,
        now: args.now,
      });

      return { move, writeSet };
    },
    { behavior: "immediate" },
  );

  const thread = getThread(deps.db, root.id);

  const archivedThreadIds =
    thread === null
      ? []
      : archiveThreadAndChildren(deps, { parentThread: thread });

  notifyRoots(deps, [
    root.id,
    ...writeSet.waiterWaits.map(
      (wait) => inboxRootOf(deps.db, wait.threadId)?.id ?? wait.threadId,
    ),
  ]);

  return { moveId: move.id, archivedThreadIds };
}

function ownerInputSince(db: DbQueryConnection, since: number): boolean {
  return (
    db
      .select({ id: threadOwnerInputs.id })
      .from(threadOwnerInputs)
      .where(gt(threadOwnerInputs.createdAt, since))
      .limit(1)
      .get() !== undefined
  );
}

function restoreWait(
  db: DbQueryConnection,
  snapshot: WaitRow,
  now: number,
): "restored" | "returned" {
  const conditions = listConditions(db, [snapshot.id]);

  const deadSource = conditions.some((condition) => {
    if (
      condition.kind !== "chat" ||
      condition.state === "met" ||
      condition.target === null
    )
      return false;

    const source = getInboxThread(db, condition.target);

    return (
      (source === null || source.archivedAt !== null) &&
      listUnconsumedResults(db, snapshot.marker).length === 0
    );
  });

  const expired =
    snapshot.kind !== "report" &&
    snapshot.deadline !== null &&
    snapshot.deadline <= now;

  if (deadSource || expired) {
    writeReceipt(db, {
      threadId: snapshot.threadId,
      cause: deadSource
        ? "dead-wake"
        : snapshot.kind === "date"
          ? "your-date"
          : "deadline",
      summary: deadSource
        ? `Can't wake: the source for ${snapshot.forText} ended`
        : `No ${snapshot.forText} by the deadline`,
      outcomeRef: snapshot.id,
      waitId: snapshot.id,
      coveredInputIds: [],
      now,
    });

    return "returned";
  }

  const closedAt = getWait(db, snapshot.id)?.closedAt ?? null;

  const restored = updateWait(
    db,
    snapshot.id,
    {
      status: snapshot.status === "proposed" ? "proposed" : "live",
      generation: nextKeyGeneration(db, snapshot),
      closedReason: null,
      closedAt: null,
      dispatchKey: null,
      dispatchQueuedMessageId: null,
      dispatchRequestId: null,
    },
    now,
  );

  if (restored === null) return "restored";

  if (closedAt !== null)
    reopenSettledChatStallReceipts(
      db,
      conditions.flatMap((condition) =>
        condition.kind === "chat" &&
        condition.state === "pending" &&
        condition.stallReceiptId !== null
          ? [condition.stallReceiptId]
          : [],
      ),
      closedAt,
    );

  reconcileStoredResults(db, restored, now);

  return "restored";
}

function restoreArchiveWriteSet(
  tx: DbQueryConnection,
  set: ArchiveWriteSet,
  moveId: string,
  now: number,
): void {
  for (const id of set.threadIds)
    tx.update(threads)
      .set({ archivedAt: null, updatedAt: now })
      .where(and(eq(threads.id, id), isNotNull(threads.archivedAt)))
      .run();

  for (const failure of set.failures)
    updateFailure(
      tx,
      failure.id,
      {
        state: "actionable",
        resolvedBy: null,
        resolvedAt: null,
        retryQueuedMessageId: null,
      },
      now,
    );

  const orphanIds = new Set(
    set.inputs
      .filter((input) => input.state === "handed-off")
      .map((input) => input.id),
  );

  updateOwnerInputs(
    tx,
    set.inputs
      .filter((input) => !orphanIds.has(input.id))
      .map((input) => input.id),
    { state: "owed" },
    now,
  );

  const orphans = listOwnerInputs(tx, {
    threadIds: set.threadIds,
    states: ["waived"],
  }).filter((input) => orphanIds.has(input.id));

  const orphanReceipt =
    orphans[0] === undefined
      ? null
      : writeReceipt(tx, {
          threadId: orphans[0].threadId,
          cause: "result",
          summary: "The goal ended when this chat was archived",
          outcomeRef: null,
          waitId: null,
          coveredInputIds: orphans.map((input) => input.id),
          now,
        });

  updateOwnerInputs(
    tx,
    orphans.map((input) => input.id),
    {
      state: "covered",
      producerId: null,
      receiptId: orphanReceipt?.id ?? null,
    },
    now,
  );

  for (const wait of set.waits) restoreWait(tx, wait, now);

  setReceiptsHandled(tx, { ids: set.waiterReceiptIds, moveId, now });

  for (const wait of set.waiterWaits) restoreWait(tx, wait, now);
}

export function undoInboxMove(
  deps: AppDeps,
  args: { moveId: string; actor: InboxActor; now: number },
): InboxActResult {
  requireOwner(args.actor);

  const latest = getLatestMove(deps.db);

  if (latest === null || latest.id !== args.moveId || latest.undoneAt !== null)
    refused("Undo applies only to your most recent move.");

  if (ownerInputSince(deps.db, latest.createdAt))
    refused("Undo ended when you sent a message.");

  const writeSet: unknown = JSON.parse(latest.writeSet);
  const handled = parseIdList(latest.handledReceiptIds);

  if (latest.kind === "archive" || latest.kind === "archive-runs") {
    const sets: { rootId: string; set: ArchiveWriteSet }[] =
      latest.kind === "archive"
        ? [{ rootId: latest.rootThreadId, set: writeSet as ArchiveWriteSet }]
        : (writeSet as RunsWriteSet).runs;

    for (const { rootId } of sets) {
      const root = getThread(deps.db, rootId);

      if (root !== null && root.archivedAt !== null)
        unarchiveThreadWithLifecycleEffects(deps, root);
    }

    deps.db.transaction(
      (tx) => {
        for (const { set } of sets)
          restoreArchiveWriteSet(tx, set, latest.id, args.now);

        setReceiptsHandled(tx, { ids: handled, moveId: null, now: null });
        markMoveUndone(tx, latest.id, args.now);
      },
      { behavior: "immediate" },
    );

    notifyRoots(deps, [
      latest.rootThreadId,
      ...sets.map(({ rootId }) => rootId),
    ]);

    return {
      moveId: null,
      entry: collectInboxEntry(deps, latest.rootThreadId, args.now),
    };
  }

  if (latest.kind === "shelf") {
    const set = writeSet as ShelfWriteSet;

    if (set.shelvedBefore)
      shelveThreadFamily(deps.db, deps.hub, { threadId: latest.rootThreadId });
    else
      unshelveThreadFamily(deps.db, deps.hub, {
        threadId: latest.rootThreadId,
      });

    markMoveUndone(deps.db, latest.id, args.now);
    notifyRoots(deps, [latest.rootThreadId]);

    return {
      moveId: null,
      entry: collectInboxEntry(deps, latest.rootThreadId, args.now),
    };
  }

  const set = writeSet as WaitWriteSet;

  deps.db.transaction(
    (tx) => {
      for (const id of set.createdWaitIds) {
        const wait = getWait(tx, id);

        if (wait !== null && wait.status !== "closed")
          updateWait(
            tx,
            id,
            { status: "closed", closedReason: "undone", closedAt: args.now },
            args.now,
          );
      }

      for (const snapshot of set.updatedWaits)
        updateWait(
          tx,
          snapshot.id,
          {
            status: snapshot.status,
            ownerAccepted: snapshot.ownerAccepted,
            reminderAt: snapshot.reminderAt,
            reminderReceiptId: snapshot.reminderReceiptId,
            deadline: snapshot.deadline,
            proposalKind: snapshot.proposalKind,
            closedReason: snapshot.closedReason,
            closedAt: snapshot.closedAt,
          },
          args.now,
        );

      for (const wait of set.cancelledWaits) restoreWait(tx, wait, args.now);

      setReceiptsHandled(tx, { ids: handled, moveId: null, now: null });
      markMoveUndone(tx, latest.id, args.now);
    },
    { behavior: "immediate" },
  );

  notifyRoots(deps, [latest.rootThreadId]);

  return {
    moveId: null,
    entry: collectInboxEntry(deps, latest.rootThreadId, args.now),
  };
}

async function sendOwnerMessage(
  deps: AppDeps,
  thread: Thread,
  text: string,
): Promise<void> {
  deps.db.transaction(
    (tx) =>
      acknowledgeOwnerMessage(tx, { threadId: thread.id, now: Date.now() }),
    { behavior: "immediate" },
  );
  await acceptThreadSendRequest(deps, {
    payload: { input: [{ type: "text", text, mentions: [] }], mode: "auto" },
    thread,
  });
}

function requireWaitOn(
  db: DbQueryConnection,
  rootId: string,
  waitId: string,
): WaitRow {
  const wait = getWait(db, waitId);

  if (wait === null || !familyIdsOf(db, rootId).includes(wait.threadId))
    throw new ApiError(404, "wait_not_found", "Wait not found");

  return wait;
}

export async function actOnInbox(
  deps: AppDeps,
  request: InboxActRequest,
  actor: InboxActor,
  now: number = Date.now(),
): Promise<InboxActResult> {
  requireOwner(actor);

  const root = requireRoot(deps.db, request.threadId);
  const entry = collectInboxEntry(deps, root.id, now);

  switch (request.action) {
    case "archive": {
      requireDisplayed(entry, request.displayedReceiptIds, request.latch);

      const { moveId } = archiveRootViaInbox(deps, {
        rootId: root.id,
        displayed: request.displayedReceiptIds,
        stopRunning: request.stopRunning === true,
        now,
      });

      return { moveId, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "archive-runs": {
      const group = collectInboxSnapshot(deps, now).inbox.find(
        (item) => item.card?.kind === "runs" && item.threadId === root.id,
      );

      const primary = group?.card?.primary;

      if (group === undefined || primary?.kind !== "archive-runs") updated();

      if (request.latch !== undefined && request.latch !== group.latch)
        updated();

      const wanted = [...request.threadIds].sort();

      if (wanted.join("|") !== [...primary.threadIds].sort().join("|"))
        updated();

      const members = wanted.map((id) => {
        const member = collectInboxEntry(deps, id, now);

        if (member === null || familyBlocked(member, deps.db, id)) updated();

        return {
          id,
          displayed: (member.card?.causes ?? []).map(
            (cause) => cause.receiptId,
          ),
        };
      });

      const move = deps.db.transaction(
        (tx) => {
          const runs = members.map(({ id }) => ({
            rootId: id,
            set: archiveWriteSet(tx, { rootId: id, now }),
          }));

          const handled = members.flatMap((member) => member.displayed);

          const move = recordMove(tx, {
            rootThreadId: root.id,
            kind: "archive-runs",
            handled,
            writeSet: { runs } satisfies RunsWriteSet,
            now,
          });

          setReceiptsHandled(tx, { ids: handled, moveId: move.id, now });

          return move;
        },
        { behavior: "immediate" },
      );

      for (const { id } of members) {
        const thread = getThread(deps.db, id);

        if (thread !== null)
          archiveThreadAndChildren(deps, { parentThread: thread });
      }

      notifyRoots(deps, [root.id, ...members.map(({ id }) => id)]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "ok": {
      const displayed = requireDisplayed(
        entry,
        request.displayedReceiptIds,
        request.latch,
      );

      if (entry?.card?.primary.kind !== "ok" && !root.shelvedAt)
        refused(
          "OK applies while a wait or the chat's own work continues, or on a Shelf chat.",
        );

      const move = deps.db.transaction(
        (tx) => {
          const move = recordMove(tx, {
            rootThreadId: root.id,
            kind: "ok",
            handled: displayed,
            writeSet: {
              createdWaitIds: [],
              cancelledWaits: [],
              updatedWaits: [],
            } satisfies WaitWriteSet,
            now,
          });

          handle(tx, displayed, move.id, now);

          return move;
        },
        { behavior: "immediate" },
      );

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "wait":
    case "wait-report": {
      const displayed = requireDisplayed(
        entry,
        request.displayedReceiptIds,
        request.latch,
      );

      if (entry?.card?.kind === "problem")
        refused("A failure can only be resumed, replied to or archived.");

      if (entry?.card?.questionMode === "required")
        refused("Answer the question, or snooze it to a date.");

      if (request.action === "wait" && request.until <= now)
        refused("Pick a future date.");

      const move = deps.db.transaction(
        (tx) => {
          const wait = insertWait(tx, {
            threadId: root.id,
            key: `owner:${request.action}:${now}`,
            generation: 1,
            kind: request.action === "wait" ? "date" : "report",
            status: "live",
            readiness: "all",
            createdBy: "owner",
            automationId: null,
            ownerAccepted: true,
            forText: request.action === "wait" ? "Your date" : request.event,
            resumeText: null,
            marker: `[omnyo wait owner ${root.id} ${now}]`,
            deadline: request.action === "wait" ? request.until : null,
            chainStartAt: now,
            nextCheckAt: null,
            checkIntervalMs: null,
            reminderAt:
              request.action === "wait-report" ? now + INBOX_REMINDER_MS : null,
            questionId: null,
            questionRevision: null,
            coversReceiptIds: request.action === "wait" ? displayed : [],
            proposalKind: null,
            afterWaitId: null,
            now,
          });

          if (request.action === "wait-report")
            insertConditions(tx, wait.id, [
              {
                key: "report",
                kind: "report",
                target: request.event,
                label: request.event,
                afterSeq: null,
              },
            ]);

          const move = recordMove(tx, {
            rootThreadId: root.id,
            kind: request.action,
            handled: displayed,
            writeSet: {
              createdWaitIds: [wait.id],
              cancelledWaits: [],
              updatedWaits: [],
            } satisfies WaitWriteSet,
            now,
          });

          handle(tx, displayed, move.id, now);

          return move;
        },
        { behavior: "immediate" },
      );

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "accept-proposal": {
      const displayed = requireDisplayed(
        entry,
        request.displayedReceiptIds,
        request.latch,
      );

      const wait = requireWaitOn(deps.db, root.id, request.waitId);

      if (
        wait.proposalKind === "archive" ||
        (wait.status !== "proposed" && wait.proposalKind !== "stop-waiting")
      )
        updated();

      if (wait.proposalKind === "shelve") {
        updateWait(
          deps.db,
          wait.id,
          {
            status: "closed",
            closedReason: "owner-accepted",
            closedAt: now,
            proposalKind: null,
          },
          now,
        );

        setReceiptsHandled(deps.db, { ids: displayed, moveId: null, now });

        return actOnInbox(
          deps,
          { action: "shelf", threadId: root.id, shelved: true },
          actor,
          now,
        );
      }

      const move = deps.db.transaction(
        (tx) => {
          if (wait.proposalKind === "stop-waiting")
            updateWait(
              tx,
              wait.id,
              {
                status: "closed",
                closedReason: "owner-accepted-stop",
                closedAt: now,
                proposalKind: null,
              },
              now,
            );
          else
            updateWait(
              tx,
              wait.id,
              {
                status: "live",
                ownerAccepted: true,
                proposalKind: null,
                reminderAt:
                  wait.kind === "report"
                    ? now + INBOX_REMINDER_MS
                    : wait.reminderAt,
                deadline:
                  wait.kind === "report"
                    ? null
                    : Math.max(wait.deadline ?? 0, now + INBOX_DEFAULT_WAIT_MS),
              },
              now,
            );

          const move = recordMove(tx, {
            rootThreadId: root.id,
            kind: "accept-proposal",
            handled: displayed,
            writeSet: {
              createdWaitIds: [],
              cancelledWaits: [],
              updatedWaits: [wait],
            } satisfies WaitWriteSet,
            now,
          });

          handle(tx, displayed, move.id, now);

          return move;
        },
        { behavior: "immediate" },
      );

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "keep-waiting": {
      const displayed = requireDisplayed(
        entry,
        request.displayedReceiptIds,
        request.latch,
      );

      const wait = requireWaitOn(deps.db, root.id, request.waitId);

      if (request.until <= now) refused("Pick a future date.");

      const move = deps.db.transaction(
        (tx) => {
          const conditions = listConditions(tx, [wait.id]);

          const next = insertWait(tx, {
            threadId: wait.threadId,
            key: wait.key,
            generation: nextKeyGeneration(tx, wait),
            kind: wait.kind,
            status: "live",
            readiness: wait.readiness,
            createdBy: wait.createdBy,
            automationId: wait.automationId,
            ownerAccepted: true,
            forText: wait.forText,
            resumeText: wait.resumeText,
            marker: wait.marker,
            deadline: request.until,
            chainStartAt: wait.chainStartAt,
            nextCheckAt:
              wait.nextCheckAt === null
                ? null
                : Math.max(wait.nextCheckAt, now),
            checkIntervalMs: wait.checkIntervalMs,
            reminderAt: null,
            questionId: null,
            questionRevision: null,
            coversReceiptIds: [],
            proposalKind: null,
            afterWaitId: null,
            now,
          });

          insertConditions(
            tx,
            next.id,
            conditions.map((condition) => ({
              key: condition.conditionKey,
              kind: condition.kind,
              target: condition.target,
              label: condition.label,
              afterSeq: condition.afterSeq,
            })),
          );

          for (const condition of conditions.filter(
            (item) => item.state === "met",
          ))
            setCondition(tx, {
              waitId: next.id,
              key: condition.conditionKey,
              state: "met",
              result: condition.result,
              now,
            });

          reconcileStoredResults(tx, next, now);

          const move = recordMove(tx, {
            rootThreadId: root.id,
            kind: "keep-waiting",
            handled: displayed,
            writeSet: {
              createdWaitIds: [next.id],
              cancelledWaits: [],
              updatedWaits: [],
            } satisfies WaitWriteSet,
            now,
          });

          handle(tx, displayed, move.id, now);

          return move;
        },
        { behavior: "immediate" },
      );

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "remind-later": {
      const displayed = requireDisplayed(
        entry,
        request.displayedReceiptIds,
        request.latch,
      );

      const wait = requireWaitOn(deps.db, root.id, request.waitId);

      if (wait.kind !== "report")
        refused("Remind me applies to a report-it wait.");

      const move = deps.db.transaction(
        (tx) => {
          updateWait(
            tx,
            wait.id,
            { reminderAt: now + INBOX_REMINDER_MS, reminderReceiptId: null },
            now,
          );

          const move = recordMove(tx, {
            rootThreadId: root.id,
            kind: "remind-later",
            handled: displayed,
            writeSet: {
              createdWaitIds: [],
              cancelledWaits: [],
              updatedWaits: [wait],
            } satisfies WaitWriteSet,
            now,
          });

          handle(tx, displayed, move.id, now);

          return move;
        },
        { behavior: "immediate" },
      );

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "happened": {
      const wait = requireWaitOn(deps.db, root.id, request.waitId);

      if (wait.kind !== "report" || wait.status !== "live")
        refused("It happened applies to a live report-it wait.");

      updateWait(
        deps.db,
        wait.id,
        { status: "closed", closedReason: "happened", closedAt: now },
        now,
      );

      const target = getThread(deps.db, wait.threadId);

      if (target === null)
        throw new ApiError(404, "thread_not_found", "Thread not found");

      await sendOwnerMessage(
        deps,
        target,
        `It happened: ${wait.forText}.${request.note ? ` ${request.note}` : ""}`,
      );
      notifyRoots(deps, [root.id]);

      return { moveId: null, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "shelf": {
      const before = root.shelvedAt !== null;

      if (before === request.shelved) return { moveId: null, entry };

      if (request.shelved)
        shelveThreadFamily(deps.db, deps.hub, { threadId: root.id });
      else unshelveThreadFamily(deps.db, deps.hub, { threadId: root.id });

      const move = recordMove(deps.db, {
        rootThreadId: root.id,
        kind: "shelf",
        handled: [],
        writeSet: { shelvedBefore: before } satisfies ShelfWriteSet,
        now,
      });

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "snooze-question": {
      if (entry === null) updated();

      if (request.latch !== undefined && request.latch !== entry.latch)
        updated();

      if (request.until <= now) refused("Pick a future date.");

      if (!entry.card?.questionIds.includes(request.questionId)) updated();

      const question = deps.db
        .select({
          threadId: threadQuestions.threadId,
          revision: threadQuestions.revision,
        })
        .from(threadQuestions)
        .where(eq(threadQuestions.id, request.questionId))
        .get();

      const move = deps.db.transaction(
        (tx) => {
          const wait = insertWait(tx, {
            threadId: question?.threadId ?? root.id,
            key: `owner:snooze:${request.questionId}:${now}`,
            generation: 1,
            kind: "date",
            status: "live",
            readiness: "all",
            createdBy: "owner",
            automationId: null,
            ownerAccepted: true,
            forText: "Your question date",
            resumeText: null,
            marker: `[omnyo wait owner ${root.id} ${now}]`,
            deadline: request.until,
            chainStartAt: now,
            nextCheckAt: null,
            checkIntervalMs: null,
            reminderAt: null,
            questionId: request.questionId,
            questionRevision: question?.revision ?? 0,
            coversReceiptIds: [],
            proposalKind: null,
            afterWaitId: null,
            now,
          });

          const shown = (entry.card?.causes ?? []).map(
            (cause) => cause.receiptId,
          );

          const move = recordMove(tx, {
            rootThreadId: root.id,
            kind: "snooze-question",
            handled: shown,
            writeSet: {
              createdWaitIds: [wait.id],
              cancelledWaits: [],
              updatedWaits: [],
            } satisfies WaitWriteSet,
            now,
          });

          handle(tx, shown, move.id, now);

          return move;
        },
        { behavior: "immediate" },
      );

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "cancel-wait": {
      const wait = requireWaitOn(deps.db, root.id, request.waitId);

      if (wait.status === "closed") refused("The wait already ended.");

      const move = deps.db.transaction(
        (tx) => {
          deleteWakeRows(tx, [wait]);
          updateWait(
            tx,
            wait.id,
            { status: "closed", closedReason: "owner-cancel", closedAt: now },
            now,
          );

          return recordMove(tx, {
            rootThreadId: root.id,
            kind: "cancel-wait",
            handled: [],
            writeSet: {
              createdWaitIds: [],
              cancelledWaits: [wait],
              updatedWaits: [],
            } satisfies WaitWriteSet,
            now,
          });
        },
        { behavior: "immediate" },
      );

      notifyRoots(deps, [root.id]);

      return { moveId: move.id, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "resume-all-at-reset": {
      const group = collectInboxSnapshot(deps, now).inbox.find(
        (item) => item.threadId === root.id && item.incident !== null,
      );

      const primary = group?.card?.primary;

      if (group === undefined || primary?.kind !== "resume-all-at-reset")
        updated();

      if (request.latch !== undefined && request.latch !== group.latch)
        updated();

      if (
        [...request.threadIds].sort().join("|") !==
        [...primary.threadIds].sort().join("|")
      )
        updated();

      for (const member of group.incident?.members ?? []) {
        const target = getThread(
          deps.db,
          member.primary.kind === "resume"
            ? member.primary.targetThreadId
            : member.threadId,
        );

        if (target === null) updated();

        await retryFailedTurn(deps, {
          thread: target,
          actor: OWNER_ACTOR,
          request: {
            turnRequestId: null,
            sendAt: primary.resetAt,
            reason: "Resume at reset",
          },
        });
      }

      deps.db.transaction(
        (tx) =>
          setReceiptsHandled(tx, {
            ids: (group.card?.causes ?? []).map((cause) => cause.receiptId),
            moveId: null,
            now,
          }),
        { behavior: "immediate" },
      );
      notifyRoots(deps, primary.threadIds);

      return { moveId: null, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "resume": {
      const displayed = requireDisplayed(
        entry,
        request.displayedReceiptIds,
        request.latch,
      );

      if (entry?.card?.primary.kind !== "resume") updated();

      if (entry.card.primary.targetThreadId !== request.targetThreadId)
        updated();

      const target = getThread(deps.db, request.targetThreadId);

      if (target === null)
        throw new ApiError(404, "thread_not_found", "Thread not found");

      deps.db.transaction(
        (tx) => {
          cancelHeldRetryRows(tx, { threadId: target.id, now });
          insertOwnerInput(tx, {
            threadId: target.id,
            kind: "resume",
            state: "owed",
            requestId: null,
            queuedMessageId: null,
            now,
          });
          setReceiptsHandled(tx, { ids: displayed, moveId: null, now });
        },
        { behavior: "immediate" },
      );

      await continueThread(deps, target.id);
      notifyRoots(deps, [root.id]);

      return { moveId: null, entry: collectInboxEntry(deps, root.id, now) };
    }

    case "continue-with-result": {
      const displayed = requireDisplayed(
        entry,
        request.displayedReceiptIds,
        request.latch,
      );

      const wait = requireWaitOn(deps.db, root.id, request.waitId);
      const results = listUnconsumedResults(deps.db, wait.marker);
      const target = getThread(deps.db, wait.threadId);

      if (target === null)
        throw new ApiError(404, "thread_not_found", "Thread not found");

      consumeResults(
        deps.db,
        results.map((result) => result.id),
        now,
      );
      setReceiptsHandled(deps.db, { ids: displayed, moveId: null, now });
      await sendOwnerMessage(
        deps,
        target,
        `Continue with the late result for ${wait.forText}:\n${results.map((result) => result.text).join("\n")}`,
      );
      notifyRoots(deps, [root.id]);

      return { moveId: null, entry: collectInboxEntry(deps, root.id, now) };
    }
  }
}

export function proposeShelve(
  deps: AppDeps,
  threadId: string,
  now: number,
): void {
  const root = inboxRootOf(deps.db, threadId);

  if (root === null || !isInboxDomainRoot(root) || root.archivedAt !== null)
    return;

  deps.db.transaction(
    (tx) => {
      const open = listOpenWaits(tx, [root.id]).find(
        (wait) => wait.status === "proposed" && wait.proposalKind === "shelve",
      );

      if (open !== undefined) return;

      const wait = insertWait(tx, {
        threadId: root.id,
        key: `proposal:shelve:${now}`,
        generation: 1,
        kind: "date",
        status: "proposed",
        readiness: "all",
        createdBy: "agent",
        automationId: null,
        ownerAccepted: false,
        forText: "Shelve",
        resumeText: null,
        marker: `[omnyo proposal ${root.id} ${now}]`,
        deadline: now + INBOX_DEFAULT_WAIT_MS,
        chainStartAt: now,
        nextCheckAt: null,
        checkIntervalMs: null,
        reminderAt: null,
        questionId: null,
        questionRevision: null,
        coversReceiptIds: [],
        proposalKind: "shelve",
        afterWaitId: null,
        now,
      });

      const receipt = writeReceipt(tx, {
        threadId: root.id,
        cause: "proposal",
        summary: "The agent proposes Shelve",
        outcomeRef: wait.id,
        waitId: wait.id,
        coveredInputIds: [],
        now,
      });

      updateWait(tx, wait.id, { proposalReceiptId: receipt?.id ?? null }, now);
    },
    { behavior: "immediate" },
  );
  notifyRoots(deps, [root.id]);
}

export function unattendedArchiveRefusal(
  deps: AppDeps,
  rootId: string,
  now: number,
): string | null {
  const root = getInboxThread(deps.db, rootId);

  if (root === null) return "The chat no longer exists.";

  if (root.shelvedAt !== null)
    return "Shelf chats are only archived by the owner.";

  const ids = familyIdsOf(deps.db, rootId);

  if (
    ids.some((id) => {
      const thread = getInboxThread(deps.db, id);

      return (
        thread !== null &&
        (thread.status === "active" ||
          thread.status === "starting" ||
          thread.status === "stopping")
      );
    })
  )
    return "Work is running in this chat.";

  if (listOpenWaits(deps.db, ids).length > 0)
    return "The chat has a live wait.";

  if (listOpenFailures(deps.db, ids).length > 0)
    return "The chat has a failure to resolve.";

  if (
    listOwnerInputs(deps.db, {
      threadIds: ids,
      states: ["running", "owed", "handed-off"],
    }).length > 0
  )
    return "The chat owes the owner an answer.";

  if (
    ids.some((id) => listPendingChatConditionsForSource(deps.db, id).length > 0)
  )
    return "Other chats wait on this one.";

  const entry = collectInboxEntry(deps, rootId, now);

  if (entry === null) return "The chat is not in the Inbox.";

  if ((entry.card?.causes.length ?? 0) > 0)
    return "The chat has outstanding results.";

  if (entry.card?.questionMode === "required")
    return "The chat has a pending question.";

  if (entry.view !== "inbox" || entry.card?.primary.kind === "ok")
    return "The chat is not idle.";

  return null;
}
