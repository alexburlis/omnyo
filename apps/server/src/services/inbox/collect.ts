import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import {
  listThreadsWithPendingInteractionState,
  queuedThreadMessages,
  threadPluginMetadata,
  threads,
  threadTurnMarks,
  type DbConnection,
} from "@omnyo/db";
import {
  buildInboxSnapshot,
  isChatStallReceipt,
  projectInboxFamily,
  type InboxChatFacts,
  type InboxEntry,
  type InboxFamilyFacts,
  type InboxFailureFacts,
  type InboxSnapshot,
  type InboxWaitFacts,
  type ThreadListEntry,
  type ThreadWorkInput,
} from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { readWorkContinuations } from "../threads/thread-completion.js";
import { toThreadListEntryResponses } from "../threads/thread-runtime-display.js";
import { ThreadWorkFacts } from "../threads/thread-work-facts.js";
import { isAdmittingToInbox } from "./admission.js";
import { listFamilyThreads, type InboxThreadRow } from "./family.js";
import { readTurnProgress } from "./turn-progress.js";
import {
  getLatestMove,
  latestEndedTurnMark,
  listExpiredAgentEventWaits,
  listActiveProducers,
  listConditions,
  listOpenFailures,
  listOpenWaits,
  listOutstandingReceipts,
  listOwnerInputs,
  listPendingChatConditionsForSources,
  type FailureRow,
  type WaitRow,
} from "./store.js";

type CollectDeps = Parameters<typeof toThreadListEntryResponses>[0] &
  Pick<AppDeps, "db">;

function groupBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);

    if (group) group.push(row);
    else groups.set(id, [row]);
  }

  return groups;
}

function listInboxRoots(
  db: DbConnection,
  rootIds: readonly string[] | undefined,
): InboxThreadRow[] {
  if (rootIds?.length === 0) return [];

  return db
    .select()
    .from(threads)
    .where(
      and(
        rootIds === undefined ? undefined : inArray(threads.id, [...rootIds]),
        isNull(threads.deletedAt),
        eq(threads.visibility, "visible"),
        eq(threads.pluginHome, false),
        isNull(threads.parentThreadId),
        isNull(threads.lifecycleOwnerThreadId),
        or(isNull(threads.archivedAt), isNotNull(threads.shelvedAt)),
      ),
    )
    .all();
}

function failureFacts(
  db: DbConnection,
  failure: FailureRow,
  queuedCount: number,
  scheduledCount: number,
): InboxFailureFacts {
  const retry =
    failure.retryQueuedMessageId === null
      ? undefined
      : db
          .select({
            sendAt: queuedThreadMessages.sendAt,
            attempt: queuedThreadMessages.retryAttempt,
          })
          .from(queuedThreadMessages)
          .where(eq(queuedThreadMessages.id, failure.retryQueuedMessageId))
          .get();

  return {
    id: failure.id,
    state: failure.state === "resolved" ? "actionable" : failure.state,
    reason: failure.reason,
    retryAt: retry?.sendAt ?? (retry === undefined ? null : failure.updatedAt),
    decisionDeadline: failure.decisionDeadline,
    attempt: retry?.attempt ?? null,
    maxAttempts: null,
    canResume: true,
    outwardEffectRan: true,
    queuedCount,
    scheduledCount,
    incident:
      failure.incidentKey === null
        ? null
        : {
            key: failure.incidentKey,
            label: failure.incidentLabel ?? failure.reason,
            resetAt: failure.resetAt,
          },
  };
}

function waitFacts(
  wait: WaitRow,
  conditions: ReturnType<typeof listConditions>,
  titleOf: (threadId: string) => string | null,
): InboxWaitFacts {
  const own = conditions;
  const chat = own.find((condition) => condition.kind === "chat");

  return {
    id: wait.id,
    threadId: wait.threadId,
    kind: wait.kind,
    status: wait.status === "closed" ? "dispatched" : wait.status,
    forText: wait.forText,
    createdBy: wait.createdBy,
    ownerAccepted: wait.ownerAccepted,
    deadline: wait.deadline,
    nextCheckAt: wait.nextCheckAt,
    checkCount: wait.checkCount,
    reminderAt: wait.reminderAt,
    readiness: wait.readiness,
    conditions: own.map((condition) => ({
      key: condition.conditionKey,
      kind: condition.kind,
      target: condition.target,
      label: condition.label,
      met: condition.state === "met",
    })),
    proposalKind:
      wait.status === "proposed" || wait.proposalKind === "stop-waiting"
        ? wait.proposalKind
        : null,
    proposalReceiptId: wait.proposalReceiptId,
    questionId: wait.questionId,
    behindTitle:
      chat?.target === undefined || chat.target === null
        ? null
        : titleOf(chat.target),
  };
}

export function collectInboxEntries(
  deps: CollectDeps,
  options: { now: number; rootIds?: readonly string[] } = { now: Date.now() },
): InboxEntry[] {
  const db = deps.db;

  const roots = listInboxRoots(db, options.rootIds).filter(
    (root) => !isAdmittingToInbox(root.id),
  );

  const continuations = readWorkContinuations(
    db,
    roots.map(({ id }) => id),
  );

  const families = listFamilyThreads(
    db,
    roots.map((root) => root.id),
  );

  const memberIds = roots.flatMap((root) => [
    root.id,
    ...(families.get(root.id) ?? [])
      .filter(
        (member) =>
          member.archivedAt === null && !isAdmittingToInbox(member.id),
      )
      .map((member) => member.id),
  ]);

  const listRows = listThreadsWithPendingInteractionState(db, {
    threadIds: memberIds,
    includeHidden: true,
  });

  const workFacts = new ThreadWorkFacts(db);
  workFacts.ensure(memberIds);

  const entries = new Map<string, ThreadListEntry>(
    toThreadListEntryResponses(deps, { threads: listRows, workFacts }).map(
      (entry) => [entry.id, entry],
    ),
  );

  const receipts = listOutstandingReceipts(
    db,
    roots.map((root) => root.id),
  );

  const deadlineWaitIds = receipts.flatMap((receipt) =>
    receipt.cause === "deadline" && receipt.waitId !== null
      ? [receipt.waitId]
      : [],
  );

  const agentEventDeadlines = new Map(
    listExpiredAgentEventWaits(db, [...new Set(deadlineWaitIds)]).map(
      (wait) => [wait.id, wait.threadId],
    ),
  );

  const waits = listOpenWaits(db, memberIds);

  const conditions = listConditions(
    db,
    waits.map((wait) => wait.id),
  );

  const failures = listOpenFailures(db, memberIds);

  const runningInputs = listOwnerInputs(db, {
    threadIds: memberIds,
    states: ["running"],
  });

  const producers = listActiveProducers(db, memberIds);

  const marks =
    memberIds.length === 0
      ? []
      : db
          .select()
          .from(threadTurnMarks)
          .where(
            and(
              inArray(threadTurnMarks.threadId, memberIds),
              isNull(threadTurnMarks.endedAt),
            ),
          )
          .all();

  const queued = memberIds.flatMap((id) => workFacts.queue.get(id) ?? []);

  const automationIds = new Map<string, string>();

  for (const row of roots.length === 0
    ? []
    : db
        .select({
          threadId: threadPluginMetadata.threadId,
          metadata: threadPluginMetadata.metadataJson,
        })
        .from(threadPluginMetadata)
        .where(
          and(
            eq(threadPluginMetadata.pluginId, "automations"),
            inArray(
              threadPluginMetadata.threadId,
              roots.map((root) => root.id),
            ),
          ),
        )
        .all()) {
    const parsed: unknown = JSON.parse(row.metadata);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "automationId" in parsed &&
      typeof parsed.automationId === "string"
    )
      automationIds.set(row.threadId, parsed.automationId);
  }

  const rootTitles = new Map(roots.map((root) => [root.id, root.title]));
  const failuresByThread = groupBy(failures, (row) => row.threadId);

  const queuedByThread = groupBy(
    queued.filter((row) => row.payloadKind === "inline"),
    (row) => row.threadId,
  );

  const marksByThread = groupBy(marks, (row) => row.threadId);
  const producersByThread = groupBy(producers, (row) => row.threadId);
  const inputsByThread = groupBy(runningInputs, (row) => row.threadId);

  const waitsByThread = groupBy(
    waits.map((wait, index) => ({ wait, index })),
    (row) => row.wait.threadId,
  );

  const waitById = new Map(waits.map((wait) => [wait.id, wait]));
  const conditionsByWait = groupBy(conditions, (row) => row.waitId);
  const receiptsByRoot = groupBy(receipts, (row) => row.rootThreadId);

  const titleOf = (threadId: string): string | null =>
    entries.get(threadId)?.title ?? rootTitles.get(threadId) ?? null;

  const pendingChatConditionsBySource = new Map<
    string,
    ReturnType<typeof listPendingChatConditionsForSources>
  >();

  const ownerStallReceiptIds = new Set<string>();
  const stoppedSources = new Map<string, boolean>();

  const sourceStopped = (sourceId: string): boolean => {
    const known = stoppedSources.get(sourceId);

    if (known !== undefined) return known;

    const stopped =
      latestEndedTurnMark(db, sourceId)?.endedOutcome === "stopped";

    stoppedSources.set(sourceId, stopped);

    return stopped;
  };

  const callbackSourceIds = new Set([
    ...roots.map((root) => root.id),
    ...receipts.flatMap((receipt) =>
      isChatStallReceipt(receipt) ? [receipt.threadId] : [],
    ),
  ]);

  for (const row of listPendingChatConditionsForSources(db, [
    ...callbackSourceIds,
  ])) {
    const source = row.condition.target;

    if (source === null) continue;

    if (
      row.condition.state === "pending" &&
      row.condition.stallReceiptId !== null &&
      (row.wait.status === "live" || row.wait.status === "evaluating") &&
      (row.wait.createdBy !== "agent" || sourceStopped(source))
    )
      ownerStallReceiptIds.add(row.condition.stallReceiptId);

    const forSource = pendingChatConditionsBySource.get(source);

    if (forSource === undefined) {
      pendingChatConditionsBySource.set(source, [row]);
    } else {
      forSource.push(row);
    }
  }

  const result: InboxEntry[] = [];

  for (const root of roots) {
    const continuation = continuations.get(root.id);

    const members = [
      root,
      ...(families.get(root.id) ?? []).filter(
        (member) => member.archivedAt === null,
      ),
    ];

    const chats: InboxChatFacts[] = members.map((member) => {
      const entry = entries.get(member.id);
      const work = entry?.work ?? null;

      const failure = failuresByThread.get(member.id)?.at(-1);
      const memberQueued = queuedByThread.get(member.id) ?? [];

      const ownerQueued = memberQueued.filter((row) => row.ownerQueued);

      const scheduled = ownerQueued.filter(
        (row) => row.sendAt !== null && row.sendAt > options.now,
      ).length;

      const mark = marksByThread.get(member.id)?.[0];
      const producer = producersByThread.get(member.id)?.[0];

      const working =
        member.status === "starting" ||
        member.status === "active" ||
        member.status === "stopping" ||
        (failure === undefined && (work?.activity.length ?? 0) > 0);

      const running =
        working || (failure === undefined && producer !== undefined);

      const turn =
        member.status === "starting" ||
        member.status === "active" ||
        member.status === "stopping"
          ? readTurnProgress(db, member.id)
          : null;

      const turnHasOwnerInput =
        mark !== undefined &&
        (inputsByThread.get(member.id) ?? []).some(
          (input) => input.turnId === mark.turnId || input.turnId === null,
        );

      const markWait =
        mark?.waitId === null || mark?.waitId === undefined
          ? undefined
          : waitById.get(mark.waitId);

      const checkingWaitId =
        running &&
        mark !== undefined &&
        markWait !== undefined &&
        (markWait.kind === "check" || markWait.kind === "join") &&
        !turnHasOwnerInput
          ? markWait.id
          : null;

      const snoozes = (waitsByThread.get(member.id) ?? [])
        .map(({ wait }) => wait)
        .filter((wait) => wait.kind === "date" && wait.questionId !== null);

      const questionFacts = (input: ThreadWorkInput) => {
        const snooze = snoozes.find((wait) => wait.questionId === input.id);

        return {
          id: input.id,
          revision: snooze?.questionRevision ?? 0,
          label: input.label,
          permission: input.kind === "permission",
          snoozedUntil: snooze?.deadline ?? null,
        };
      };

      return {
        threadId: member.id,
        title: member.title ?? member.titleFallback ?? "Untitled chat",
        isRoot: member.id === root.id,
        running,
        working,
        runningLabel:
          turn?.note ?? work?.activity[0]?.label ?? producer?.label ?? null,
        runningProgress: turn?.progress ?? null,
        waitingLabel:
          work?.primary.label === "waiting" ||
          work?.primary.label === "external"
            ? work.primary.reason.text
            : (work?.waits[0]?.reason ?? null),
        queuedOwnerWork: ownerQueued.length > scheduled,
        checkingWaitId,
        requiredQuestions: (work?.requiredInput ?? []).map(questionFacts),
        optionalQuestions: (work?.optionalInput ?? []).map(questionFacts),
        failure:
          failure === undefined
            ? null
            : failureFacts(
                db,
                failure,
                ownerQueued.length - scheduled,
                scheduled,
              ),
        hostEpisode: null,
        coverageGap: null,
      };
    });

    const familyWaits = members
      .flatMap((member) => waitsByThread.get(member.id) ?? [])
      .sort((left, right) => left.index - right.index)
      .map(({ wait }) => wait)
      .filter((wait) => !(wait.kind === "date" && wait.questionId !== null))
      .map((wait) =>
        waitFacts(wait, conditionsByWait.get(wait.id) ?? [], titleOf),
      );

    for (const member of members) {
      for (const row of (queuedByThread.get(member.id) ?? []).filter(
        (item) =>
          item.ownerQueued && item.sendAt !== null && item.sendAt > options.now,
      ))
        familyWaits.push({
          id: row.id,
          threadId: member.id,
          kind: "send-later",
          status: "live",
          forText: "Your message sends",
          createdBy: "owner",
          ownerAccepted: true,
          deadline: row.sendAt,
          nextCheckAt: null,
          checkCount: 0,
          reminderAt: null,
          readiness: "all",
          conditions: [],
          proposalKind: null,
          proposalReceiptId: null,
          questionId: null,
          behindTitle: null,
        });
    }

    for (const member of members) {
      for (const row of (queuedByThread.get(member.id) ?? []).filter(
        (item) =>
          item.senderThreadId !== null &&
          item.sendAt !== null &&
          item.sendAt > options.now,
      ))
        familyWaits.push({
          id: row.id,
          threadId: member.id,
          kind: "date",
          status: "live",
          forText: `Message from ${titleOf(row.senderThreadId ?? "") ?? "another chat"}`,
          createdBy: "agent",
          ownerAccepted: false,
          deadline: row.sendAt,
          nextCheckAt: null,
          checkCount: 0,
          reminderAt: null,
          readiness: "all",
          conditions: [],
          proposalKind: null,
          proposalReceiptId: null,
          questionId: null,
          behindTitle: null,
        });
    }

    const rootEntry = entries.get(root.id);
    const work = rootEntry?.work ?? null;
    const assessment = work?.assessment;

    const waiters = (pendingChatConditionsBySource.get(root.id) ?? [])
      .filter(({ condition }) => condition.state !== "met")
      .map(({ wait }) => ({
        threadId: wait.threadId,
        title: titleOf(wait.threadId) ?? "A chat",
        createdBy: wait.createdBy,
      }));

    const facts: InboxFamilyFacts = {
      ...(continuation ? { continuation } : {}),
      rootId: root.id,
      projectId: root.projectId,
      title: root.title ?? root.titleFallback ?? "Untitled chat",
      createdAt: root.createdAt,
      archivedAt: root.archivedAt,
      shelvedAt: root.shelvedAt,
      automationId: automationIds.get(root.id) ?? null,
      chats,
      receipts: (receiptsByRoot.get(root.id) ?? [])
        .filter(
          (receipt) =>
            !isChatStallReceipt(receipt) ||
            ownerStallReceiptIds.has(receipt.id),
        )
        .map((receipt) => ({
          id: receipt.id,
          seq: receipt.seq,
          threadId: receipt.threadId,
          fromTitle:
            receipt.threadId === root.id ? null : titleOf(receipt.threadId),
          cause: receipt.cause,
          summary: receipt.summary,
          waitId: receipt.waitId,
          agentEventDeadline:
            receipt.waitId !== null &&
            agentEventDeadlines.get(receipt.waitId) === receipt.threadId,
          createdAt: receipt.createdAt,
        })),
      waits: familyWaits,
      waiters,
      assessment: {
        fresh:
          assessment !== undefined &&
          assessment.availability !== "stale" &&
          assessment.availability !== "missing",
        availability: assessment?.availability ?? "missing",
        reason: assessment?.reason ?? "No completion assessment is available.",
        ask: assessment?.ask ?? null,
        recap: assessment?.recap ?? null,
        suggestion: assessment?.suggestion === "available",
        archiveReady: work?.archive.recommended ?? false,
        archiveEligible: work?.archive.eligible ?? false,
      },
    };

    result.push(projectInboxFamily(facts));
  }

  return result;
}

export function collectInboxSnapshot(
  deps: CollectDeps,
  now: number = Date.now(),
): InboxSnapshot {
  const entries = collectInboxEntries(deps, { now });
  const latest = getLatestMove(deps.db);

  const revision = createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((entry) => [
          entry.threadId,
          entry.latch,
          entry.view,
          entry.state,
          entry.reason.text,
        ]),
      ),
    )
    .digest("hex")
    .slice(0, 16);

  return buildInboxSnapshot({
    entries,
    now,
    revision,
    lastMove:
      latest === null || latest.undoneAt !== null
        ? null
        : {
            moveId: latest.id,
            kind: latest.kind,
            threadId: latest.rootThreadId,
            at: latest.createdAt,
          },
  });
}

export function collectInboxEntry(
  deps: CollectDeps,
  rootId: string,
  now: number = Date.now(),
): InboxEntry | null {
  return collectInboxEntries(deps, { now, rootIds: [rootId] })[0] ?? null;
}
