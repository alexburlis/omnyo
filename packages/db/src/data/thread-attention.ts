import { and, eq, inArray, isNull, or, exists, placeholder } from "drizzle-orm";
import {
  threadQuestionSchema,
  threadQuestionAnsweredBySchema,
  queuedMessageWaitingOnSchema,
  type ThreadQuestion,
  type ThreadAttention,
  type ThreadCallback,
} from "@omnyo/domain";
import {
  prepareCachedQuery,
  type DbConnection,
  type DbQueryConnection,
} from "../connection.js";
import {
  threadQuestions,
  threadCallbacks,
  threads,
  queuedThreadMessages,
  pendingInteractions,
} from "../schema.js";
import { listActiveBackgroundTaskCountsByThreadIds } from "./events.js";
import { getThread } from "./threads.js";
import { getActivePendingInteractionForThread } from "./pending-interactions.js";
import { listQueuedThreadMessages } from "./queued-thread-messages.js";

export function toThreadQuestion(
  row: typeof threadQuestions.$inferSelect,
): ThreadQuestion {
  return threadQuestionSchema.parse({
    id: row.id,
    threadId: row.threadId,
    revision: row.revision,
    question: JSON.parse(row.question),
    state: row.state,
    answer: row.answer === null ? null : JSON.parse(row.answer),
    queuedMessageId: row.queuedMessageId,
    answeredBy:
      row.answeredBy === null
        ? null
        : threadQuestionAnsweredBySchema.parse(JSON.parse(row.answeredBy)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function listThreadQuestions(
  db: DbConnection,
  threadId?: string,
  includeClosed = false,
): ThreadQuestion[] {
  return db
    .select({ question: threadQuestions })
    .from(threadQuestions)
    .innerJoin(threads, eq(threads.id, threadQuestions.threadId))
    .where(
      and(
        threadId === undefined
          ? undefined
          : eq(threadQuestions.threadId, threadId),
        includeClosed ? undefined : eq(threadQuestions.state, "open"),
        isNull(threads.deletedAt),
        isNull(threads.archivedAt),
      ),
    )
    .orderBy(threadQuestions.createdAt, threadQuestions.id)
    .all()
    .map((row) => toThreadQuestion(row.question));
}

const prepareGetRequiredOpenThreadQuestion = (db: DbQueryConnection) =>
  db
    .select({ id: threadQuestions.id })
    .from(threadQuestions)
    .where(
      and(
        eq(threadQuestions.threadId, placeholder("threadId")),
        eq(threadQuestions.state, "open"),
        eq(threadQuestions.mode, "required"),
      ),
    )
    .limit(1)
    .prepare();

export function getCallbackSourceState(
  db: DbConnection,
  sourceThreadId: string | null,
): ThreadCallback["sourceState"] {
  if (sourceThreadId === null) return "unverified";
  const source = getThread(db, sourceThreadId);

  if (source === null || source.deletedAt !== null) return "unavailable";

  if (source.archivedAt !== null) return "archived";

  if (
    getActivePendingInteractionForThread(db, sourceThreadId) !== null ||
    prepareCachedQuery(db, prepareGetRequiredOpenThreadQuestion).get({
      threadId: sourceThreadId,
    }) !== undefined
  )
    return "needs-input";

  if (source.status === "error") return "error";

  if (
    ["active", "starting", "stopping"].includes(source.status) ||
    listActiveBackgroundTaskCountsByThreadIds(db, {
      threadIds: [sourceThreadId],
    }).some((row) => row.activeBackgroundAgentCount > 0) ||
    listNativeWorkerOwners(db, [sourceThreadId]).has(sourceThreadId)
  )
    return "working";
  const queue = listQueuedThreadMessages(db, sourceThreadId);
  const pending = queue.filter((entry) => entry.failureReason === null);

  if (
    pending.some(
      (entry) =>
        entry.waitingOn !== null &&
        queuedMessageWaitingOnSchema.parse(JSON.parse(entry.waitingOn)).kind ===
          "interaction",
    )
  )
    return "needs-input";

  return pending.length > 0 ? "waiting" : "idle";
}

export function toThreadCallback(
  db: DbConnection,
  row: typeof threadCallbacks.$inferSelect,
): ThreadCallback {
  const source =
    row.sourceThreadId === null ? null : getThread(db, row.sourceThreadId);

  return {
    ...row,
    sourceTitle: source?.title ?? source?.titleFallback ?? row.sourceTitle,
    sourceState: getCallbackSourceState(db, row.sourceThreadId),
  };
}

export function listThreadCallbacks(
  db: DbConnection,
  threadId?: string,
): ThreadCallback[] {
  return db
    .select({ callback: threadCallbacks })
    .from(threadCallbacks)
    .innerJoin(threads, eq(threads.id, threadCallbacks.threadId))
    .where(
      and(
        threadId === undefined
          ? undefined
          : eq(threadCallbacks.threadId, threadId),
        isNull(threads.deletedAt),
        isNull(threads.archivedAt),
      ),
    )
    .orderBy(threadCallbacks.createdAt)
    .all()
    .map((row) => toThreadCallback(db, row.callback));
}

export function readThreadAttention(
  db: DbConnection,
  ids: readonly string[],
): Map<string, ThreadAttention> {
  return summarizeThreadAttention(readThreadAttentionFacts(db, ids));
}

export interface ThreadAttentionFacts {
  questions: ThreadQuestion[];
  callbacks: ThreadCallback[];
}

export function summarizeThreadAttention(
  facts: ReadonlyMap<string, ThreadAttentionFacts>,
): Map<string, ThreadAttention> {
  const result = new Map<string, ThreadAttention>();

  for (const [id, entry] of facts) {
    const requiredCount = entry.questions.filter(
      (question) => question.question.mode === "required",
    ).length;

    const optionalCount = entry.questions.length - requiredCount;

    const failed = entry.callbacks.find((callback) =>
      ["error", "archived", "unavailable"].includes(callback.sourceState),
    );

    result.set(id, {
      kind:
        requiredCount > 0
          ? "required-answer"
          : failed
            ? "dependency-failed"
            : optionalCount > 0
              ? "optional-input"
              : entry.callbacks.length > 0
                ? "callback-waiting"
                : "none",
      requiredCount,
      optionalCount,
      callback: failed ?? entry.callbacks[0] ?? null,
    });
  }

  return result;
}

export function readThreadAttentionFacts(
  db: DbConnection,
  ids: readonly string[],
): Map<string, ThreadAttentionFacts> {
  const result = new Map<string, ThreadAttentionFacts>(
    ids.map((id) => [id, { questions: [], callbacks: [] }]),
  );

  const callbacks: Array<typeof threadCallbacks.$inferSelect> = [];

  for (let start = 0; start < ids.length; start += 400) {
    const batch = ids.slice(start, start + 400);

    for (const row of db
      .select()
      .from(threadQuestions)
      .where(
        and(
          inArray(threadQuestions.threadId, batch),
          eq(threadQuestions.state, "open"),
        ),
      )
      .all()) {
      result.get(row.threadId)?.questions.push(toThreadQuestion(row));
    }

    callbacks.push(
      ...db
        .select()
        .from(threadCallbacks)
        .where(inArray(threadCallbacks.threadId, batch))
        .all(),
    );
  }

  const sourceIds = [
    ...new Set(
      callbacks.flatMap((callback) =>
        callback.sourceThreadId === null ? [] : [callback.sourceThreadId],
      ),
    ),
  ];

  const sources = new Map<string, typeof threads.$inferSelect>();
  const needsInput = new Set<string>();
  const working = new Set<string>();
  const queued = new Set<string>();

  for (let start = 0; start < sourceIds.length; start += 400) {
    const batch = sourceIds.slice(start, start + 400);

    for (const row of db
      .select()
      .from(threads)
      .where(inArray(threads.id, batch))
      .all())
      sources.set(row.id, row);

    for (const row of db
      .select({ threadId: threadQuestions.threadId })
      .from(threadQuestions)
      .where(
        and(
          inArray(threadQuestions.threadId, batch),
          eq(threadQuestions.state, "open"),
          eq(threadQuestions.mode, "required"),
        ),
      )
      .all())
      needsInput.add(row.threadId);

    for (const row of db
      .select({ threadId: pendingInteractions.threadId })
      .from(pendingInteractions)
      .where(
        and(
          inArray(pendingInteractions.threadId, batch),
          inArray(pendingInteractions.status, ["pending", "resolving"]),
        ),
      )
      .all())
      needsInput.add(row.threadId);

    for (const row of db
      .select({
        threadId: queuedThreadMessages.threadId,
        waitingOn: queuedThreadMessages.waitingOn,
      })
      .from(queuedThreadMessages)
      .where(
        and(
          inArray(queuedThreadMessages.threadId, batch),
          isNull(queuedThreadMessages.failureReason),
        ),
      )
      .all()) {
      queued.add(row.threadId);

      if (
        row.waitingOn !== null &&
        queuedMessageWaitingOnSchema.parse(JSON.parse(row.waitingOn)).kind ===
          "interaction"
      )
        needsInput.add(row.threadId);
    }

    for (const row of listActiveBackgroundTaskCountsByThreadIds(db, {
      threadIds: batch,
    }))
      if (
        row.activeBackgroundAgentCount > 0 ||
        row.activeBackgroundCommandCount > 0 ||
        row.activeWorkflowCount > 0
      )
        working.add(row.threadId);

    for (const id of listNativeWorkerOwners(db, batch)) working.add(id);
  }

  for (const row of callbacks) {
    const source =
      row.sourceThreadId === null ? undefined : sources.get(row.sourceThreadId);

    const sourceState: ThreadCallback["sourceState"] =
      row.sourceThreadId === null
        ? "unverified"
        : source === undefined || source.deletedAt !== null
          ? "unavailable"
          : source.archivedAt !== null
            ? "archived"
            : needsInput.has(source.id)
              ? "needs-input"
              : source.status === "error"
                ? "error"
                : ["active", "starting", "stopping"].includes(source.status) ||
                    working.has(source.id)
                  ? "working"
                  : queued.has(source.id)
                    ? "waiting"
                    : "idle";

    result.get(row.threadId)?.callbacks.push({
      ...row,
      sourceState,
      sourceTitle: source?.title ?? source?.titleFallback ?? row.sourceTitle,
    });
  }

  return result;
}

export function listNativeWorkerOwners(
  db: DbConnection,
  ids: readonly string[],
): Set<string> {
  const owners = new Set<string>();

  for (let start = 0; start < ids.length; start += 400) {
    const batch = ids.slice(start, start + 400);

    const rows = db
      .select({ owner: threads.lifecycleOwnerThreadId })
      .from(threads)
      .where(
        and(
          inArray(threads.lifecycleOwnerThreadId, batch),
          eq(threads.originPluginId, "workflows"),
          isNull(threads.deletedAt),
          isNull(threads.archivedAt),
          or(
            inArray(threads.status, ["starting", "active", "stopping"]),
            exists(
              db
                .select({ id: queuedThreadMessages.id })
                .from(queuedThreadMessages)
                .where(
                  and(
                    eq(queuedThreadMessages.threadId, threads.id),
                    isNull(queuedThreadMessages.failureReason),
                  ),
                ),
            ),
          ),
        ),
      )
      .all();

    for (const row of rows) if (row.owner !== null) owners.add(row.owner);
  }

  return owners;
}
