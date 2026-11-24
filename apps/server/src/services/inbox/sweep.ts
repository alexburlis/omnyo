import {
  queuedThreadMessages,
  threadCallbacks,
  threads,
  type DbQueryConnection,
} from "@omnyo/db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { INBOX_DEFAULT_WAIT_MS, INBOX_FOR_TEXT_MAX } from "@omnyo/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { insertConditions, insertWait } from "./store.js";
import {
  settleDueRetryDecisions,
  settleUnclaimedHeldRetries,
  surfaceDueProducerHolds,
  writeReceipt,
} from "./engine.js";
import { inboxRootOf } from "./family.js";
import {
  runInboxDueSweep,
  sweepCoordinatorVersion,
  sweepStalledSources,
} from "./waits.js";

export function convertLegacyCallbacks(
  db: DbQueryConnection,
  now: number,
): string[] {
  const converted: string[] = [];

  for (const row of db.select().from(threadCallbacks).all()) {
    const wait = insertWait(db, {
      threadId: row.threadId,
      key: `callback:${row.sourceThreadId ?? row.id}`,
      generation: 1,
      kind: row.sourceThreadId === null ? "event" : "chat",
      status: "live",
      readiness: "all",
      createdBy: "agent",
      automationId: null,
      ownerAccepted: false,
      forText: row.reason.slice(0, INBOX_FOR_TEXT_MAX),
      resumeText: null,
      marker: row.matchText,
      deadline: now + INBOX_DEFAULT_WAIT_MS,
      chainStartAt: now,
      nextCheckAt: null,
      checkIntervalMs: null,
      reminderAt: null,
      questionId: null,
      questionRevision: null,
      coversReceiptIds: [],
      proposalKind: null,
      afterWaitId: null,
      now,
    });

    insertConditions(db, wait.id, [
      row.sourceThreadId === null
        ? {
            key: `event:legacy-${row.id}`,
            kind: "event",
            target: `legacy:${row.id}`,
            label: row.sourceTitle,
            afterSeq: null,
          }
        : {
            key: `chat:${row.sourceThreadId}`,
            kind: "chat",
            target: row.sourceThreadId,
            label: row.sourceTitle,
            afterSeq: row.afterSeq,
          },
    ]);
    db.delete(threadCallbacks).where(eq(threadCallbacks.threadId, row.threadId)).run();
    converted.push(row.threadId);
  }

  return converted;
}

export function returnTellsToArchivedChats(
  db: DbQueryConnection,
  now: number,
): string[] {
  const changed: string[] = [];

  for (const row of db
    .select({
      id: queuedThreadMessages.id,
      targetId: queuedThreadMessages.threadId,
      senderThreadId: queuedThreadMessages.senderThreadId,
      title: threads.title,
      titleFallback: threads.titleFallback,
    })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .where(
      and(
        isNotNull(queuedThreadMessages.senderThreadId),
        isNotNull(queuedThreadMessages.sendAt),
        lte(queuedThreadMessages.sendAt, now),
        isNotNull(threads.archivedAt),
      ),
    )
    .all()) {
    db.delete(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, row.id))
      .run();

    if (row.senderThreadId === null) continue;

    writeReceipt(db, {
      threadId: row.senderThreadId,
      cause: "dead-wake",
      summary: `Couldn't post to ${row.title ?? row.titleFallback ?? "a chat"}: archived`,
      outcomeRef: row.targetId,
      waitId: null,
      coveredInputIds: [],
      now,
    });
    changed.push(row.senderThreadId);
  }

  return changed;
}

export async function runInboxSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<void> {
  const changed = new Set<string>();

  for (const id of deps.db.transaction(
    (tx) => [
      ...convertLegacyCallbacks(tx, now),
      ...settleDueRetryDecisions(tx, now),
      ...settleUnclaimedHeldRetries(tx, now),
      ...surfaceDueProducerHolds(tx, now),
      ...returnTellsToArchivedChats(tx, now),
    ],
    { behavior: "immediate" },
  ))
    changed.add(id);

  for (const id of await runInboxDueSweep(deps, now)) changed.add(id);

  for (const id of await sweepStalledSources(deps, now)) changed.add(id);

  for (const waitId of await sweepCoordinatorVersion(deps, now)) changed.add(waitId);

  const notify = new Set<string>();

  for (const id of changed) {
    notify.add(id);
    notify.add(inboxRootOf(deps.db, id)?.id ?? id);
  }

  for (const id of notify) deps.hub.notifyThread(id, ["work-changed"]);
}
