import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  like,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import {
  threadQuestionSchema,
  threadQuestionAnsweredBySchema,
  queuedMessageWaitingOnSchema,
  type ThreadQuestion,
  type ThreadAttention,
  type ThreadCallback,
} from "@omnyo/domain";
import type { DbConnection } from "../connection.js";
import {
  threadQuestions,
  threads,
  threadWaits,
  threadWaitConditions,
  threadProducers,
  threadOwnerInputs,
  queuedThreadMessages,
  pendingInteractions,
} from "../schema.js";
import { listActiveBackgroundTaskCountsByThreadIds } from "./events.js";
import { listRetryingFailures } from "./thread-failures.js";

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

type CallbackRow = Omit<ThreadCallback, "sourceState">;

function selectCallbackRows(
  db: DbConnection,
  scope: SQL | undefined,
): CallbackRow[] {
  const seen = new Set<string>();

  return db
    .select({
      id: threadWaits.id,
      threadId: threadWaits.threadId,
      reason: threadWaits.forText,
      createdAt: threadWaits.createdAt,
      matchText: threadWaits.marker,
      kind: threadWaitConditions.kind,
      target: threadWaitConditions.target,
      label: threadWaitConditions.label,
      afterSeq: threadWaitConditions.afterSeq,
    })
    .from(threadWaits)
    .innerJoin(
      threadWaitConditions,
      eq(threadWaitConditions.waitId, threadWaits.id),
    )
    .innerJoin(threads, eq(threads.id, threadWaits.threadId))
    .where(
      and(
        scope,
        like(threadWaits.key, "callback:%"),
        inArray(threadWaits.status, ["live", "evaluating"]),
        eq(threadWaitConditions.state, "pending"),
        inArray(threadWaitConditions.kind, ["chat", "event"]),
        isNull(threads.deletedAt),
        isNull(threads.archivedAt),
      ),
    )
    .orderBy(asc(threadWaits.createdAt), asc(threadWaits.id))
    .all()
    .flatMap((row) => {
      if (seen.has(row.id)) return [];
      seen.add(row.id);

      return [
        {
          id: row.id,
          threadId: row.threadId,
          sourceThreadId: row.kind === "chat" ? row.target : null,
          sourceTitle: row.label,
          reason: row.reason,
          createdAt: row.createdAt,
          afterSeq: row.afterSeq ?? 0,
          matchText: row.matchText,
        },
      ];
    });
}

function callbackRowsForThreads(
  db: DbConnection,
  ids: readonly string[],
): CallbackRow[] {
  const rows: CallbackRow[] = [];

  for (let start = 0; start < ids.length; start += 400)
    rows.push(
      ...selectCallbackRows(
        db,
        inArray(threadWaits.threadId, ids.slice(start, start + 400)),
      ),
    );

  return rows;
}

export function listThreadCallbacks(
  db: DbConnection,
  threadId?: string,
): ThreadCallback[] {
  return classifyCallbackRows(
    db,
    threadId === undefined
      ? selectCallbackRows(db, undefined)
      : callbackRowsForThreads(db, [threadId]),
  );
}

export function listThreadCallbacksByThread(
  db: DbConnection,
  ids: readonly string[],
): Map<string, ThreadCallback[]> {
  const result = new Map<string, ThreadCallback[]>(ids.map((id) => [id, []]));

  for (const callback of classifyCallbackRows(
    db,
    callbackRowsForThreads(db, ids),
  ))
    result.get(callback.threadId)?.push(callback);

  return result;
}

export function listCallbackWaiterIds(
  db: DbConnection,
  sourceThreadIds: readonly string[],
): string[] {
  const waiters = new Set<string>();

  for (let start = 0; start < sourceThreadIds.length; start += 400)
    for (const row of selectCallbackRows(
      db,
      and(
        eq(threadWaitConditions.kind, "chat"),
        inArray(
          threadWaitConditions.target,
          sourceThreadIds.slice(start, start + 400),
        ),
      ),
    ))
      waiters.add(row.threadId);

  return [...waiters];
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
  }

  for (const callback of classifyCallbackRows(
    db,
    callbackRowsForThreads(db, ids),
  ))
    result.get(callback.threadId)?.callbacks.push(callback);

  return result;
}

function classifyCallbackRows(
  db: DbConnection,
  callbacks: readonly CallbackRow[],
): ThreadCallback[] {
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
  const waiting = new Set<string>();
  const retrying = new Set<string>();

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
      waiting.add(row.threadId);

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

    for (const row of db
      .select({ threadId: threadWaits.threadId })
      .from(threadWaits)
      .where(
        and(
          inArray(threadWaits.threadId, batch),
          inArray(threadWaits.status, ["live", "evaluating", "dispatched"]),
          or(
            isNull(threadWaits.proposalKind),
            ne(threadWaits.proposalKind, "archive"),
          ),
        ),
      )
      .all())
      waiting.add(row.threadId);

    for (const row of db
      .select({ threadId: threadProducers.threadId })
      .from(threadProducers)
      .where(
        and(
          inArray(threadProducers.threadId, batch),
          eq(threadProducers.status, "active"),
        ),
      )
      .all())
      waiting.add(row.threadId);

    for (const row of db
      .select({ threadId: threadOwnerInputs.threadId })
      .from(threadOwnerInputs)
      .where(
        and(
          inArray(threadOwnerInputs.threadId, batch),
          inArray(threadOwnerInputs.state, ["running", "owed", "handed-off"]),
        ),
      )
      .all())
      waiting.add(row.threadId);

    for (const id of listRetryingFailures(db, batch).keys()) retrying.add(id);
  }

  return callbacks.map((row) => {
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
              : source.status === "error" && !retrying.has(source.id)
                ? "error"
                : ["active", "starting", "stopping"].includes(source.status) ||
                    working.has(source.id)
                  ? "working"
                  : waiting.has(source.id) || retrying.has(source.id)
                    ? "waiting"
                    : "idle";

    return {
      ...row,
      sourceState,
      sourceTitle: source?.title ?? source?.titleFallback ?? row.sourceTitle,
    };
  });
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
