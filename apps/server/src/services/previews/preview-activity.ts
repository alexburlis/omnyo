import { and, desc, eq, sql } from "drizzle-orm";
import {
  createEventId,
  events,
  getHost,
  getThread,
  managedPreviews,
  type DbQueryConnection,
  type DbTransaction,
} from "@omnyo/db";
import {
  THREAD_ACTIVITY_OPERATION,
  threadScope,
  turnScope,
  type PreviewThreadActivity,
} from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import {
  appendThreadEventInTransaction,
  getActiveTurnId,
} from "../threads/thread-events.js";

const activityPreviewId = sql`json_extract(${events.data}, '$.metadata.ref.previewId')`;

function isPreviewActivityEvent(previewId: string) {
  return and(
    eq(events.type, "system/operation"),
    sql`json_extract(${events.data}, '$.operation') = ${THREAD_ACTIVITY_OPERATION}`,
    sql`json_extract(${events.data}, '$.metadata.activityKind') = 'preview'`,
    sql`${activityPreviewId} = ${previewId}`,
  );
}

function hasTurnPreviewActivity(
  db: DbQueryConnection,
  args: { threadId: string; turnId: string; previewId: string },
): boolean {
  return (
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, args.threadId),
          eq(events.turnId, args.turnId),
          isPreviewActivityEvent(args.previewId),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasCurrentThreadPreviewActivity(
  db: DbQueryConnection,
  args: { threadId: string; previewId: string },
): boolean {
  const activity = db
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.scopeKind, "thread"),
        isPreviewActivityEvent(args.previewId),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  if (activity === undefined) return false;

  const laterTurn = db
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, "turn/started"),
        sql`${events.sequence} > ${activity.sequence}`,
      ),
    )
    .limit(1)
    .get();

  return laterTurn === undefined;
}

function resolveTargetThread(
  tx: DbTransaction,
  args: {
    projectId: string;
    ownerThreadId: string;
    actingThreadId: string | null;
  },
) {
  const acting =
    args.actingThreadId === null ? null : getThread(tx, args.actingThreadId);

  const target =
    acting !== null &&
    acting.deletedAt === null &&
    acting.projectId === args.projectId
      ? acting
      : getThread(tx, args.ownerThreadId);

  return target === null ||
    target.deletedAt !== null ||
    target.archivedAt !== null
    ? null
    : target;
}

function appendPreviewActivity(
  tx: DbTransaction,
  args: { previewId: string; actingThreadId: string | null },
): { threadId: string; sequence: number } | null {
  const preview = tx
    .select()
    .from(managedPreviews)
    .where(eq(managedPreviews.id, args.previewId))
    .get();

  if (preview === undefined) return null;

  const thread = resolveTargetThread(tx, {
    projectId: preview.projectId,
    ownerThreadId: preview.threadId,
    actingThreadId: args.actingThreadId,
  });

  if (thread === null) return null;
  const turnId = getActiveTurnId({ db: tx }, thread.id);

  const alreadyShown =
    turnId === null
      ? hasCurrentThreadPreviewActivity(tx, {
          threadId: thread.id,
          previewId: preview.id,
        })
      : hasTurnPreviewActivity(tx, {
          threadId: thread.id,
          turnId,
          previewId: preview.id,
        });

  if (alreadyShown) return null;

  const activity: PreviewThreadActivity = {
    activityKind: "preview",
    ref: { previewId: preview.id },
    snapshot: {
      url: preview.url,
      hostName: getHost(tx, preview.hostId)?.name ?? "",
    },
  };

  const sequence = appendThreadEventInTransaction(tx, {
    threadId: thread.id,
    environmentId: thread.environmentId,
    type: "system/operation",
    scope: turnId === null ? threadScope() : turnScope(turnId),
    data: {
      operation: THREAD_ACTIVITY_OPERATION,
      operationId: createEventId(),
      status: "completed",
      message: `Started ${preview.url}`,
      metadata: activity,
    },
  });

  return { threadId: thread.id, sequence };
}

export function recordPreviewStartedActivity(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  args: { previewId: string; actingThreadId: string | null },
): void {
  let appended: { threadId: string; sequence: number } | null;

  try {
    appended = deps.db.transaction((tx) => appendPreviewActivity(tx, args), {
      behavior: "immediate",
    });
  } catch (error) {
    deps.logger.error(
      { err: error, previewId: args.previewId },
      "Could not add the started preview to its chat timeline",
    );

    return;
  }

  if (appended === null) return;

  deps.hub.notifyThread(appended.threadId, ["events-appended"], {
    eventTypes: ["system/operation"],
    timelineSequence: appended.sequence,
    eventSequenceRange: { from: appended.sequence, to: appended.sequence },
  });
}
