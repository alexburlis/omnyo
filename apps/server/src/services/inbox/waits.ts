import { captureDueProviderFailures } from "../threads/provider-error-reporting.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import semverCoerce from "semver/functions/coerce.js";
import semverGte from "semver/functions/gte.js";
import {
  createQueuedThreadMessageInTransaction,
  getLatestThreadSequence,
  listActiveBackgroundTaskCountsByThreadIds,
  threadWaitConditions,
  threadWaits,
  type DbConnection,
  type DbQueryConnection,
} from "@omnyo/db";
import {
  INBOX_AGENT_WAIT_CAP_MS,
  INBOX_DEFAULT_WAIT_MS,
  INBOX_FOR_TEXT_MAX,
  INBOX_REMINDER_MS,
  INBOX_STALL_GRACE_MS,
  INBOX_WAIT_MARKER_PATTERN,
  chatsWaitingPhrase,
  nextCheckInterval,
  type InboxWaitCreator,
  type InboxWaitKind,
  type InboxWaitView,
} from "@omnyo/domain";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { buildExecutionOptions } from "../threads/thread-commands.js";
import { getLastThreadOutput } from "../threads/thread-data.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import {
  claimWaitStatus,
  consumeResults,
  findWaitsByDispatchQueuedMessage,
  findWaitsByKey,
  findWaitsByMarker,
  getOpenTurnMark,
  getReceipts,
  getWait,
  insertConditions,
  insertWait,
  insertWaitResult,
  latestEndedTurnMark,
  listActiveProducers,
  listAllOpenWaits,
  listConditions,
  listOpenWaits,
  listOwnerInputs,
  listPendingChatConditionsForSource,
  listUnconsumedResults,
  markConditionsStall,
  nextKeyGeneration,
  parseIdList,
  releaseChatStallReceipts,
  setCondition,
  setReceiptsHandled,
  updateTurnMark,
  updateWait,
  type ConditionRow,
  type WaitRow,
} from "./store.js";
import { getInboxThread } from "./family.js";
import {
  claimRetryForRequest,
  hasPausedQueue,
  writeReceipt,
} from "./engine.js";
import {
  describeEventKey,
  eventKeyNeedsApproval,
  validateEventKey,
} from "./event-sources.js";
import type { InboxActor } from "./actor.js";
import { lastOwnerTouchAt } from "./touch.js";

export interface RegisterWaitArgs {
  threadId: string;
  key: string;
  forText: string;
  chats: readonly string[];
  events: readonly string[];
  check: { what: string; at: number } | null;
  report: string | null;
  readiness: "all" | "any";
  by: number | null;
  resume: string | null;
  after: string | null;
}

const HOST_RECONNECT_PREFIX = "host-reconnect:";

const COORDINATOR_VERSION_PREFIX = "coordinator-version:";

function meetEventConditions(
  db: DbConnection,
  args: { matches: (target: string) => boolean; result: string; now: number },
): string[] {
  return db.transaction(
    (tx) => {
      const ready: string[] = [];

      const rows = tx
        .select({ condition: threadWaitConditions, wait: threadWaits })
        .from(threadWaitConditions)
        .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
        .where(
          and(
            eq(threadWaitConditions.kind, "event"),
            eq(threadWaitConditions.state, "pending"),
            eq(threadWaits.status, "live"),
          ),
        )
        .all()
        .filter(
          ({ condition }) =>
            condition.target !== null && args.matches(condition.target),
        );

      for (const { condition, wait } of rows) {
        setCondition(tx, {
          waitId: wait.id,
          key: condition.conditionKey,
          state: "met",
          result: args.result,
          now: args.now,
        });

        if (readinessMet(tx, wait)) ready.push(wait.id);
      }

      return ready;
    },
    { behavior: "immediate" },
  );
}

export function listPendingEventKeys(
  db: DbQueryConnection,
  prefix: string,
): string[] {
  return [
    ...new Set(
      db
        .select({ target: threadWaitConditions.target })
        .from(threadWaitConditions)
        .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
        .where(
          and(
            eq(threadWaitConditions.kind, "event"),
            eq(threadWaitConditions.state, "pending"),
            eq(threadWaits.status, "live"),
          ),
        )
        .all()
        .flatMap(({ target }) =>
          target !== null && target.startsWith(prefix) ? [target] : [],
        ),
    ),
  ].sort();
}

export async function reportEvent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { key: string; result: string; now: number },
): Promise<number> {
  const ready = meetEventConditions(deps.db, {
    matches: (target) => target === args.key,
    result: args.result,
    now: args.now,
  });

  for (const waitId of ready)
    await dispatchWake(deps, { waitId, phase: "resume", now: args.now });

  return ready.length;
}

export async function onHostReconnected(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { hostId: string; now: number },
): Promise<void> {
  const ready = meetEventConditions(deps.db, {
    matches: (target) => target === `${HOST_RECONNECT_PREFIX}${args.hostId}`,
    result: "The machine reconnected.",
    now: args.now,
  });

  for (const waitId of ready)
    await dispatchWake(deps, { waitId, phase: "resume", now: args.now });
}

export async function sweepCoordinatorVersion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<string[]> {
  const running = semverCoerce(deps.config.appVersion);

  if (running === null) return [];

  const ready = meetEventConditions(deps.db, {
    matches: (target) => {
      if (!target.startsWith(COORDINATOR_VERSION_PREFIX)) return false;

      const wanted = semverCoerce(
        target.slice(COORDINATOR_VERSION_PREFIX.length),
      );

      return wanted !== null && semverGte(running, wanted);
    },
    result: `The coordinator runs ${deps.config.appVersion}.`,
    now,
  });

  for (const waitId of ready)
    await dispatchWake(deps, { waitId, phase: "resume", now });

  return ready;
}

function invalid(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}

function conflict(message: string): never {
  throw new ApiError(409, "invalid_request", message);
}

export function toWaitView(
  wait: WaitRow,
  conditions: readonly ConditionRow[],
): InboxWaitView {
  return {
    id: wait.id,
    key: wait.key,
    generation: wait.generation,
    kind: wait.kind,
    status: wait.status,
    forText: wait.forText,
    marker: wait.marker,
    deadline: wait.deadline,
    nextCheckAt: wait.nextCheckAt,
    checkCount: wait.checkCount,
    createdBy: wait.createdBy,
    ownerAccepted: wait.ownerAccepted,
    conditions: conditions
      .filter((condition) => condition.waitId === wait.id)
      .map((condition) => ({
        key: condition.conditionKey,
        kind: condition.kind,
        label: condition.label,
        met: condition.state === "met",
      })),
  };
}

function creatorOf(actor: InboxActor): InboxWaitCreator {
  switch (actor.kind) {
    case "owner":
      return "owner";
    case "automation":
      return "automation";
    case "thread":
    case "plugin":
      return "agent";
  }
}

function sourceHasLiveOwner(db: DbQueryConnection, sourceId: string): boolean {
  const source = getInboxThread(db, sourceId);

  if (source === null || source.deletedAt !== null) return false;

  if (
    source.status === "active" ||
    source.status === "starting" ||
    source.status === "stopping"
  )
    return true;

  if (listOpenWaits(db, [sourceId]).some((wait) => wait.status !== "proposed"))
    return true;

  return (
    listOwnerInputs(db, {
      threadIds: [sourceId],
      states: ["running", "owed", "handed-off"],
    }).length > 0 ||
    listActiveProducers(db, [sourceId]).length > 0 ||
    listActiveBackgroundTaskCountsByThreadIds(db, { threadIds: [sourceId] })
      .length > 0
  );
}

function waitsOnTransitively(
  db: DbQueryConnection,
  fromThreadId: string,
  targetThreadId: string,
): boolean {
  const seen = new Set<string>();
  const stack = [fromThreadId];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const waits = listOpenWaits(db, [current]);

    const conditions = listConditions(
      db,
      waits.map((wait) => wait.id),
    );

    for (const condition of conditions) {
      if (condition.kind !== "chat" || condition.target === null) continue;

      if (condition.target === targetThreadId) return true;
      stack.push(condition.target);
    }
  }

  return false;
}

function waitKindFor(args: RegisterWaitArgs): InboxWaitKind {
  const count =
    args.chats.length +
    args.events.length +
    (args.check === null ? 0 : 1) +
    (args.report === null ? 0 : 1);

  if (count === 0)
    invalid("A wait needs --chat, --event, --check with --at, or --report.");

  if (count > 1) {
    if (args.report !== null)
      invalid("--report cannot be joined with other conditions.");

    return "join";
  }

  if (args.chats.length === 1) return "chat";

  if (args.events.length === 1) return "event";

  if (args.check !== null) return "check";

  return "report";
}

function sameContent(
  wait: WaitRow,
  conditions: readonly ConditionRow[],
  args: RegisterWaitArgs,
): boolean {
  const keys = conditions
    .filter((condition) => condition.waitId === wait.id)
    .map((condition) => `${condition.kind}:${condition.target ?? ""}`)
    .sort();

  const wanted = [
    ...args.chats.map((id) => `chat:${id}`),
    ...args.events.map((key) => `event:${key}`),
    ...(args.check === null ? [] : [`check:${args.check.what}`]),
    ...(args.report === null ? [] : [`report:${args.report}`]),
  ].sort();

  return (
    wait.forText === args.forText &&
    wait.readiness === args.readiness &&
    keys.join("|") === wanted.join("|")
  );
}

export function registerWait(
  db: DbConnection,
  args: RegisterWaitArgs,
  actor: InboxActor,
  now: number,
): { wait: WaitRow; existing: boolean; readyNow: boolean } {
  if (actor.kind === "thread" && actor.threadId !== args.threadId)
    invalid("Agents register waits only on their own chat (--self).");

  const forText = args.forText.trim();

  if (forText.length === 0) invalid("--for is required.");

  if (forText.length > INBOX_FOR_TEXT_MAX)
    invalid(`--for must be at most ${INBOX_FOR_TEXT_MAX} characters.`);

  if (args.key.trim().length === 0) invalid("--key is required.");

  const thread = getInboxThread(db, args.threadId);

  if (thread === null || thread.deletedAt !== null)
    throw new ApiError(404, "thread_not_found", "Thread not found");

  if (thread.archivedAt !== null) conflict("The chat is archived.");

  for (const key of args.events) validateEventKey(db, key);

  if (args.check !== null && args.check.at <= now)
    invalid("--at must be in the future.");

  const kind = waitKindFor(args);

  return db.transaction(
    (tx) => {
      const previous = findWaitsByKey(tx, {
        threadId: args.threadId,
        key: args.key,
      });

      const latest = previous[0] ?? null;

      if (latest !== null && latest.status !== "closed") {
        const conditions = listConditions(tx, [latest.id]);

        if (sameContent(latest, conditions, args))
          return { wait: latest, existing: true, readyNow: false };

        conflict(
          `Wait key ${args.key} is already registered with different content.`,
        );
      }

      for (const sourceId of args.chats) {
        if (sourceId === args.threadId)
          invalid("A chat cannot wait on itself.");

        const source = getInboxThread(tx, sourceId);

        if (source === null || source.deletedAt !== null)
          invalid(`Unknown chat: ${sourceId}`);

        const marker = latest?.marker ?? null;

        const retained =
          marker !== null && listUnconsumedResults(tx, marker).length > 0;

        if (source.archivedAt !== null && !retained)
          invalid(`${source.title ?? sourceId} is archived and has no result.`);

        if (!retained && !sourceHasLiveOwner(tx, sourceId))
          invalid(
            `${source.title ?? sourceId} has no running work or wait that will deliver a result.`,
          );

        if (waitsOnTransitively(tx, sourceId, args.threadId))
          invalid(`Waiting on ${source.title ?? sourceId} would form a cycle.`);
      }

      const creator = creatorOf(actor);
      const after = args.after === null ? null : getWait(tx, args.after);

      if (args.after !== null) {
        const mark = getOpenTurnMark(tx, args.threadId);

        if (after === null || mark === null || mark.waitId !== after.id)
          invalid("--after must name the wait that woke this turn.");
      }

      const chainStartAt = after?.chainStartAt ?? now;
      const touch = lastOwnerTouchAt(tx, args.threadId) ?? thread.createdAt;

      const requested =
        after?.deadline ?? args.by ?? now + INBOX_DEFAULT_WAIT_MS;

      const capped =
        creator === "owner"
          ? requested
          : Math.min(requested, touch + INBOX_AGENT_WAIT_CAP_MS);

      if (kind !== "report" && capped <= now)
        invalid(
          "The wait would end immediately: agent waits end at most 30 days after the owner last touched the chat.",
        );

      const proposed =
        (kind === "report" || args.events.some(eventKeyNeedsApproval)) &&
        creator !== "owner";

      const wait = insertWait(tx, {
        threadId: args.threadId,
        key: args.key,
        generation: (latest?.generation ?? 0) + 1,
        kind,
        status: proposed ? "proposed" : "live",
        readiness: args.readiness,
        createdBy: creator,
        automationId: actor.kind === "automation" ? actor.automationId : null,
        ownerAccepted: creator === "owner",
        forText,
        resumeText: args.resume,
        marker: latest?.marker ?? `[omnyo wait ${randomUUID()}]`,
        deadline: kind === "report" ? null : capped,
        chainStartAt,
        nextCheckAt: args.check?.at ?? null,
        checkIntervalMs: args.check === null ? null : args.check.at - now,
        reminderAt: kind === "report" ? now + INBOX_REMINDER_MS : null,
        questionId: null,
        questionRevision: null,
        coversReceiptIds: [],
        proposalKind: proposed
          ? kind === "report"
            ? "report"
            : "watch"
          : null,
        afterWaitId: args.after,
        now,
      });

      insertConditions(tx, wait.id, [
        ...args.chats.map((sourceId) => ({
          key: `chat:${sourceId}`,
          kind: "chat" as const,
          target: sourceId,
          label: getInboxThread(tx, sourceId)?.title ?? sourceId,
          afterSeq: getLatestThreadSequence(tx, { threadId: sourceId }),
        })),
        ...args.events.map((eventKey) => ({
          key: `event:${eventKey}`,
          kind: "event" as const,
          target: eventKey,
          label: describeEventKey(eventKey),
          afterSeq: null,
        })),
        ...(args.check === null
          ? []
          : [
              {
                key: "check",
                kind: "check" as const,
                target: args.check.what,
                label: args.check.what,
                afterSeq: null,
              },
            ]),
        ...(args.report === null
          ? []
          : [
              {
                key: "report",
                kind: "report" as const,
                target: args.report,
                label: args.report,
                afterSeq: null,
              },
            ]),
      ]);

      if (args.after !== null) {
        const mark = getOpenTurnMark(tx, args.threadId);

        if (mark !== null) updateTurnMark(tx, mark, { afterWaitId: wait.id });
      }

      const readyNow = reconcileStoredResults(tx, wait, now);

      if (proposed) {
        const receipt = writeReceipt(tx, {
          threadId: args.threadId,
          cause: "proposal",
          summary:
            kind === "report"
              ? `The agent proposes On you: ${forText}`
              : [
                  `The agent proposes watching: ${forText}`,
                  `Omnyo will check ${args.events.filter(eventKeyNeedsApproval).join(" · ")}`,
                ].join(" · "),
          outcomeRef: wait.id,
          waitId: wait.id,
          coveredInputIds: [],
          now,
        });

        return {
          wait:
            updateWait(
              tx,
              wait.id,
              { proposalReceiptId: receipt?.id ?? null },
              now,
            ) ?? wait,
          existing: false,
          readyNow,
        };
      }

      return { wait, existing: false, readyNow };
    },
    { behavior: "immediate" },
  );
}

export function reconcileStoredResults(
  db: DbQueryConnection,
  wait: WaitRow,
  now: number,
): boolean {
  const results = listUnconsumedResults(db, wait.marker);

  for (const result of results) {
    const key =
      result.sourceThreadId === null ? null : `chat:${result.sourceThreadId}`;

    const condition = listConditions(db, [wait.id]).find(
      (item) => item.conditionKey === key && item.state !== "met",
    );

    if (condition === undefined) continue;

    setCondition(db, {
      waitId: wait.id,
      key: condition.conditionKey,
      state: "met",
      result: result.text,
      now,
    });
    consumeResults(db, [result.id], now);
  }

  return readinessMet(db, wait);
}

export function readinessMet(db: DbQueryConnection, wait: WaitRow): boolean {
  const conditions = listConditions(db, [wait.id]).filter(
    (condition) => condition.kind !== "date",
  );

  if (conditions.length === 0) return false;

  if (wait.kind === "check" || wait.kind === "report") return false;

  return wait.readiness === "any"
    ? conditions.some((condition) => condition.state === "met")
    : conditions.every((condition) => condition.state === "met");
}

function requireWakeTurnWait(
  db: DbQueryConnection,
  args: { threadId: string; waitId: string },
): { wait: WaitRow; turnId: string } {
  const mark = getOpenTurnMark(db, args.threadId);
  const wait = getWait(db, args.waitId);

  if (wait === null || wait.threadId !== args.threadId)
    throw new ApiError(404, "wait_not_found", "Wait not found");

  if (mark === null || mark.waitId !== wait.id)
    conflict("Only the turn that this wait woke can declare its outcome.");

  return { wait, turnId: mark.turnId };
}

export function rearmWait(
  db: DbConnection,
  args: { threadId: string; waitId: string },
  now: number,
): WaitRow {
  return db.transaction(
    (tx) => {
      const { wait, turnId } = requireWakeTurnWait(tx, args);

      if (wait.kind !== "check" && wait.kind !== "join")
        conflict("Only a check can be re-armed.");

      if (wait.deadline !== null && wait.deadline <= now)
        conflict("The wait reached its deadline; it returns to the owner.");

      const interval = nextCheckInterval(wait.checkIntervalMs ?? 0, 60_000);

      const updated = updateWait(
        tx,
        wait.id,
        {
          status: "live",
          generation: nextKeyGeneration(tx, wait),
          nextCheckAt: now + interval,
          checkIntervalMs: interval,
          checkCount: wait.checkCount + 1,
          dispatchKey: null,
          dispatchQueuedMessageId: null,
          dispatchRequestId: null,
        },
        now,
      );

      updateTurnMark(
        tx,
        { threadId: args.threadId, turnId },
        { rearmed: true },
      );

      if (updated === null)
        throw new ApiError(404, "wait_not_found", "Wait not found");

      return updated;
    },
    { behavior: "immediate" },
  );
}

export function metWaitCondition(
  db: DbConnection,
  args: {
    threadId: string;
    waitId: string;
    condition: string;
    result: string | null;
  },
  now: number,
): { wait: WaitRow; readyNow: boolean } {
  return db.transaction(
    (tx) => {
      const { wait, turnId } = requireWakeTurnWait(tx, args);

      if (wait.kind !== "join") conflict("met applies to a joined wait.");

      const condition = listConditions(tx, [wait.id]).find(
        (item) => item.conditionKey === args.condition,
      );

      if (condition === undefined)
        invalid(`Unknown condition: ${args.condition}`);

      setCondition(tx, {
        waitId: wait.id,
        key: condition.conditionKey,
        state: "met",
        result: args.result,
        now,
      });
      updateTurnMark(
        tx,
        { threadId: args.threadId, turnId },
        { metCondition: condition.conditionKey },
      );

      const live =
        updateWait(
          tx,
          wait.id,
          { status: "live", generation: nextKeyGeneration(tx, wait) },
          now,
        ) ?? wait;

      return { wait: live, readyNow: readinessMet(tx, live) };
    },
    { behavior: "immediate" },
  );
}

function ownerOwns(wait: WaitRow): boolean {
  return wait.createdBy === "owner" || wait.ownerAccepted;
}

export function agentEndWait(
  db: DbConnection,
  args: { threadId: string; waitId: string; how: "done" | "cancel" },
  actor: InboxActor,
  now: number,
): { wait: WaitRow; proposed: boolean } {
  return db.transaction(
    (tx) => {
      const wait = getWait(tx, args.waitId);

      if (wait === null || wait.threadId !== args.threadId)
        throw new ApiError(404, "wait_not_found", "Wait not found");

      if (wait.status === "closed") conflict("The wait already ended.");

      const agent = actor.kind !== "owner";

      if (agent && args.how === "done") {
        if (wait.kind !== "report") conflict("done resolves a report-it wait.");

        const mark = getOpenTurnMark(tx, args.threadId);

        const consumedAfterArm =
          mark !== null &&
          listOwnerInputs(tx, {
            threadIds: [args.threadId],
            states: ["running"],
          }).some(
            (input) =>
              input.turnId === mark.turnId && input.createdAt >= wait.createdAt,
          );

        if (!consumedAfterArm)
          conflict(
            "done is accepted only in a turn that consumed the owner's message sent after the wait was armed.",
          );

        updateWait(
          tx,
          wait.id,
          { status: "closed", closedReason: "agent-done", closedAt: now },
          now,
        );

        if (mark !== null)
          updateTurnMark(tx, mark, {
            endedOwnerWaitIds: JSON.stringify([
              ...parseIdList(mark.endedOwnerWaitIds),
              wait.id,
            ]),
          });

        return { wait, proposed: false };
      }

      if (agent && ownerOwns(wait)) {
        const updated =
          updateWait(tx, wait.id, { proposalKind: "stop-waiting" }, now) ??
          wait;

        return { wait: updated, proposed: true };
      }

      const closed =
        updateWait(
          tx,
          wait.id,
          {
            status: "closed",
            closedReason: agent ? "agent-cancel" : "owner-cancel",
            closedAt: now,
          },
          now,
        ) ?? wait;

      return { wait: closed, proposed: false };
    },
    { behavior: "immediate" },
  );
}

function wakePrompt(
  db: DbQueryConnection,
  wait: WaitRow,
  phase: "check" | "evaluate" | "resume",
): string {
  const conditions = listConditions(db, [wait.id]);
  const next = wait.resumeText ? ` Next step: ${wait.resumeText}` : "";

  if (phase === "check")
    return `${wait.marker} Check ${wait.checkCount + 1}: ${wait.forText}. If nothing changed, run \`omnyo wait rearm ${wait.id}\` and stop. Otherwise continue.${next}`;

  if (phase === "evaluate") {
    const check = conditions.find((condition) => condition.kind === "check");

    return `${wait.marker} Evaluate "${check?.label ?? wait.forText}" for: ${wait.forText}. If it is met, run \`omnyo wait met ${wait.id} --condition check\`. If not yet, run \`omnyo wait rearm ${wait.id}\`.`;
  }

  const results = conditions
    .filter((condition) => condition.state === "met")
    .map((condition) => `- ${condition.label}: ${condition.result ?? "met"}`)
    .join("\n");

  return `${wait.marker} Ready: ${wait.forText}.\n${results}${next}`;
}

export async function dispatchWake(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { waitId: string; phase: "check" | "evaluate" | "resume"; now: number },
): Promise<boolean> {
  const initial = getWait(deps.db, args.waitId);

  if (initial === null || initial.status !== "live") return false;

  const thread = getInboxThread(deps.db, initial.threadId);

  if (
    thread === null ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    hasPausedQueue(deps.db, thread.id)
  )
    return false;

  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: thread.id },
  );

  const dispatched = deps.db.transaction(
    (tx) => {
      const claimed = claimWaitStatus(tx, {
        id: initial.id,
        generation: initial.generation,
        from: ["live"],
        patch: {
          status: args.phase === "evaluate" ? "evaluating" : "dispatched",
          dispatchKey: `${initial.id}:${initial.generation}:${args.phase}`,
        },
        now: args.now,
      });

      if (claimed === null) return false;

      const row = createQueuedThreadMessageInTransaction(tx, {
        threadId: thread.id,
        content: [
          {
            type: "text",
            text: wakePrompt(tx, initial, args.phase),
            mentions: [],
          },
        ],
        requestedBy: { initiator: "system", senderThreadId: thread.id },
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        permissionMode: execution.permissionMode,
        serviceTier: execution.serviceTier,
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: {
          kind: "external-message",
          subject: {
            kind: "message-source",
            source: { kind: "script", label: "Wait" },
          },
        },
      });

      updateWait(tx, initial.id, { dispatchQueuedMessageId: row.id }, args.now);

      return true;
    },
    { behavior: "immediate" },
  );

  if (dispatched) {
    deps.hub.notifyThread(thread.id, ["queue-changed", "work-changed"]);
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
  }

  return dispatched;
}

export function linkDispatchedQueueRows(
  db: DbQueryConnection,
  args: {
    threadId: string;
    rows: readonly { id: string; payloadKind: string }[];
    requestId: string;
    now: number;
  },
): void {
  for (const wait of findWaitsByDispatchQueuedMessage(
    db,
    args.rows.map((row) => row.id),
  ))
    updateWait(db, wait.id, { dispatchRequestId: args.requestId }, args.now);

  if (args.rows.some((row) => row.payloadKind === "retry"))
    claimRetryForRequest(db, {
      threadId: args.threadId,
      requestId: args.requestId,
      now: args.now,
    });
}

export function settleDeletedWakeWaits(
  db: DbQueryConnection,
  args: { queuedMessageId: string; now: number },
): WaitRow[] {
  const settled: WaitRow[] = [];

  for (const wait of findWaitsByDispatchQueuedMessage(db, [
    args.queuedMessageId,
  ])) {
    if (wait.status === "dispatched") {
      updateWait(
        db,
        wait.id,
        {
          status: "closed",
          closedReason: "wake-deleted",
          closedAt: args.now,
        },
        args.now,
      );
      settled.push(wait);
    } else if (wait.status === "evaluating") {
      updateWait(
        db,
        wait.id,
        { status: "live", generation: nextKeyGeneration(db, wait) },
        args.now,
      );
      settled.push(wait);
    }
  }

  return settled;
}

function closeWithReceipt(
  db: DbQueryConnection,
  wait: WaitRow,
  cause: "deadline" | "partial" | "dead-wake",
  summary: string,
  now: number,
): void {
  updateWait(
    db,
    wait.id,
    { status: "closed", closedReason: cause, closedAt: now },
    now,
  );
  writeReceipt(db, {
    threadId: wait.threadId,
    cause,
    summary,
    outcomeRef: wait.id,
    waitId: wait.id,
    coveredInputIds: [],
    now,
  });
}

export function applyDueDeadlines(
  db: DbConnection,
  now: number,
): {
  changedThreadIds: string[];
  readyWaitIds: string[];
  dueChecks: { waitId: string; phase: "check" | "evaluate" }[];
} {
  return db.transaction(
    (tx) => {
      const changed: string[] = [];
      const ready: string[] = [];
      const checks: { waitId: string; phase: "check" | "evaluate" }[] = [];

      for (const wait of listAllOpenWaits(tx)) {
        if (wait.status !== "live") continue;

        if (wait.kind === "date") {
          if (wait.deadline !== null && wait.deadline <= now) {
            applyDueDate(tx, wait, now);
            changed.push(wait.threadId);
          }

          continue;
        }

        if (wait.kind === "report") {
          if (wait.reminderAt !== null && wait.reminderAt <= now) {
            const receipt = writeReceipt(tx, {
              threadId: wait.threadId,
              cause: "reminder",
              summary: `Still on you: ${wait.forText}`,
              outcomeRef: wait.id,
              waitId: wait.id,
              coveredInputIds: [],
              now,
            });

            updateWait(
              tx,
              wait.id,
              {
                reminderAt: now + INBOX_REMINDER_MS,
                reminderReceiptId: receipt?.id ?? null,
              },
              now,
            );
            changed.push(wait.threadId);
          }

          continue;
        }

        const met = readinessMet(tx, wait);

        if (met) {
          ready.push(wait.id);

          continue;
        }

        if (wait.deadline !== null && wait.deadline <= now) {
          const conditions = listConditions(tx, [wait.id]);

          const delivered = conditions.filter(
            (condition) => condition.state === "met",
          );

          const blockedChats = conditions.filter(
            (condition) =>
              condition.kind === "chat" && condition.state !== "met",
          );

          const nextStep =
            blockedChats.length === 0
              ? ""
              : ` · Waiting on ${blockedChats.map((condition) => condition.label).join(", ")}. Open the blocked chat, extend the wait, or send a new direction here.`;

          if (wait.kind === "join" && delivered.length > 0)
            closeWithReceipt(
              tx,
              wait,
              "partial",
              `${delivered.length} of ${conditions.length} arrived · no ${conditions
                .filter((condition) => condition.state !== "met")
                .map((condition) => condition.label)
                .join(", ")} by the deadline${nextStep}`,
              now,
            );
          else
            closeWithReceipt(
              tx,
              wait,
              "deadline",
              `No ${wait.forText} by the deadline · checked ${wait.checkCount}×${nextStep}`,
              now,
            );

          changed.push(wait.threadId);

          continue;
        }

        if (wait.nextCheckAt !== null && wait.nextCheckAt <= now) {
          if (wait.kind === "check")
            checks.push({ waitId: wait.id, phase: "check" });

          if (wait.kind === "join") {
            const check = listConditions(tx, [wait.id]).find(
              (condition) => condition.kind === "check",
            );

            if (check !== undefined && check.state !== "met")
              checks.push({ waitId: wait.id, phase: "evaluate" });
          }
        }
      }

      return {
        changedThreadIds: changed,
        readyWaitIds: ready,
        dueChecks: checks,
      };
    },
    { behavior: "immediate" },
  );
}

function applyDueDate(db: DbQueryConnection, wait: WaitRow, now: number): void {
  updateWait(
    db,
    wait.id,
    { status: "closed", closedReason: "date", closedAt: now },
    now,
  );

  const covered = getReceipts(db, parseIdList(wait.coversReceiptIds));

  setReceiptsHandled(db, {
    ids: covered.map((receipt) => receipt.id),
    moveId: null,
    now: null,
  });

  writeReceipt(db, {
    threadId: wait.threadId,
    cause: "your-date",
    summary: wait.questionId === null ? "Your date" : "Your question date",
    outcomeRef: wait.id,
    waitId: wait.id,
    coveredInputIds: [],
    now,
  });
}

export async function runInboxDueSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<string[]> {
  const due = applyDueDeadlines(deps.db, now);
  const changed = new Set(due.changedThreadIds);

  for (const waitId of due.readyWaitIds)
    if (await dispatchWake(deps, { waitId, phase: "resume", now }))
      changed.add(getWait(deps.db, waitId)?.threadId ?? waitId);

  for (const check of due.dueChecks)
    if (
      await dispatchWake(deps, {
        waitId: check.waitId,
        phase: check.phase,
        now,
      })
    )
      changed.add(getWait(deps.db, check.waitId)?.threadId ?? check.waitId);

  captureDueProviderFailures(deps.db);

  return [...changed];
}

export function routeMarkerDelivery(
  db: DbConnection,
  args: {
    targetThreadId: string;
    senderThreadId: string | null;
    text: string;
    now: number;
  },
): { routed: boolean; readyWaitIds: string[]; lateWaitId: string | null } {
  const markerMatch = INBOX_WAIT_MARKER_PATTERN.exec(args.text);

  if (markerMatch === null)
    return { routed: false, readyWaitIds: [], lateWaitId: null };

  const marker = markerMatch[0];

  return db.transaction(
    (tx) => {
      const waits = findWaitsByMarker(tx, marker).filter(
        (wait) => wait.threadId === args.targetThreadId,
      );

      if (waits.length === 0)
        invalid(
          "The wait marker in this message is unknown or belongs to another chat.",
        );

      const live = waits.find(
        (wait) => wait.status === "live" || wait.status === "evaluating",
      );

      insertWaitResult(tx, {
        threadId: args.targetThreadId,
        marker,
        waitId: live?.id ?? waits[0]?.id ?? null,
        sourceThreadId: args.senderThreadId,
        text: args.text.replace(marker, "").trim(),
        late: live === undefined,
        now: args.now,
      });

      if (live === undefined) {
        const target = getInboxThread(tx, args.targetThreadId);

        if (target !== null && target.archivedAt === null) {
          writeReceipt(tx, {
            threadId: args.targetThreadId,
            cause: "late-result",
            summary: `Late result from ${
              args.senderThreadId === null
                ? "a chat"
                : (getInboxThread(tx, args.senderThreadId)?.title ?? "a chat")
            }`,
            outcomeRef: waits[0]?.id ?? null,
            waitId: waits[0]?.id ?? null,
            coveredInputIds: [],
            now: args.now,
          });
        }

        return {
          routed: true,
          readyWaitIds: [],
          lateWaitId: waits[0]?.id ?? null,
        };
      }

      const ready = reconcileStoredResults(tx, live, args.now);

      return {
        routed: true,
        readyWaitIds: ready ? [live.id] : [],
        lateWaitId: null,
      };
    },
    { behavior: "immediate" },
  );
}

export function storeChildCompletion(
  db: DbConnection,
  args: {
    parentThreadId: string;
    childThreadId: string;
    text: string;
    now: number;
  },
): { stored: boolean; readyWaitIds: string[] } {
  return db.transaction(
    (tx) => {
      const waits = new Map<string, WaitRow>();

      for (const { condition, wait } of listPendingChatConditionsForSource(
        tx,
        args.childThreadId,
      ))
        if (
          condition.state !== "met" &&
          wait.threadId === args.parentThreadId &&
          (wait.status === "live" || wait.status === "evaluating")
        )
          waits.set(wait.id, wait);

      const readyWaitIds: string[] = [];

      for (const wait of waits.values()) {
        insertWaitResult(tx, {
          threadId: args.parentThreadId,
          marker: wait.marker,
          waitId: wait.id,
          sourceThreadId: args.childThreadId,
          text: args.text,
          late: false,
          now: args.now,
        });

        if (reconcileStoredResults(tx, wait, args.now))
          readyWaitIds.push(wait.id);
      }

      return { stored: waits.size > 0, readyWaitIds };
    },
    { behavior: "immediate" },
  );
}

export function waitersOnSource(
  db: DbQueryConnection,
  sourceThreadId: string,
): WaitRow[] {
  return listPendingChatConditionsForSource(db, sourceThreadId)
    .filter(({ condition }) => condition.state !== "met")
    .map(({ wait }) => wait);
}

export const STALL_ESCALATED_TO_WAITER = "waiter";

const STALL_RECEIPT_SKIPPED = "none";

const STALL_LAST_MESSAGE_MAX = 400;

interface PendingChatRow {
  condition: ConditionRow;
  wait: WaitRow;
}

function latestOf(values: readonly (number | null)[]): number | null {
  let latest: number | null = null;

  for (const value of values)
    if (value !== null && (latest === null || value > latest)) latest = value;

  return latest;
}

function isOwedCallback({ condition, wait }: PendingChatRow): boolean {
  return (
    (wait.status === "live" || wait.status === "evaluating") &&
    condition.state === "pending"
  );
}

function waiterTitlesOf(
  db: DbQueryConnection,
  rows: readonly PendingChatRow[],
): string[] {
  return [...new Set(rows.map(({ wait }) => wait.threadId))].map((id) => {
    const waiter = getInboxThread(db, id);

    return waiter?.title ?? waiter?.titleFallback ?? "A chat";
  });
}

function sourceIsIdle(db: DbQueryConnection, sourceId: string): boolean {
  const source = getInboxThread(db, sourceId);

  return (
    source !== null &&
    source.archivedAt === null &&
    !sourceHasLiveOwner(db, sourceId) &&
    !hasPausedQueue(db, sourceId)
  );
}

export async function sweepStalledSources(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<string[]> {
  const pending = deps.db
    .select({ condition: threadWaitConditions, wait: threadWaits })
    .from(threadWaitConditions)
    .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
    .where(
      and(
        eq(threadWaitConditions.kind, "chat"),
        eq(threadWaitConditions.state, "pending"),
        inArray(threadWaits.status, ["live", "evaluating"]),
      ),
    )
    .all();

  const bySource = new Map<string, PendingChatRow[]>();

  for (const row of pending) {
    const target = row.condition.target;

    if (target === null) continue;

    bySource.set(target, [...(bySource.get(target) ?? []), row]);
  }

  const changed: string[] = [];

  for (const [sourceId, rows] of bySource) {
    if (!sourceIsIdle(deps.db, sourceId)) continue;

    const lastTurn = latestEndedTurnMark(deps.db, sourceId);
    const stopped = lastTurn?.endedOutcome === "stopped";

    if (
      !stopped &&
      rows.some(({ condition }) => condition.stallWokenAt === null)
    ) {
      if (await dispatchStallWake(deps, sourceId, now)) changed.push(sourceId);
      continue;
    }

    const open = rows.filter(
      ({ condition }) => condition.stallReceiptId === null,
    );

    const wokenAt = latestOf(
      open.map(({ condition }) => condition.stallWokenAt),
    );

    const forOwner = open.filter(
      ({ wait }) => stopped || wait.createdBy !== "agent",
    );

    const forWaiters = rows.filter((row) => isEscalatable(row, stopped));

    const idleSince =
      latestOf([
        ...forWaiters.map(({ condition }) => condition.stallWokenAt),
        lastTurn?.endedAt ?? null,
      ]) ?? now;

    if (forWaiters.length > 0 && now - idleSince >= INBOX_STALL_GRACE_MS) {
      const reached = await escalateToWaiters(deps, sourceId, now);

      if (reached.length > 0) changed.push(sourceId, ...reached);
    }

    if (forOwner.length === 0) continue;

    const graceStart = wokenAt ?? lastTurn?.endedAt ?? now;

    if (now - graceStart < INBOX_STALL_GRACE_MS) continue;

    const touched = lastOwnerTouchAt(deps.db, sourceId);

    if (touched !== null && touched > graceStart) continue;

    const waiting = chatsWaitingPhrase(waiterTitlesOf(deps.db, forOwner));

    const receipt = writeReceipt(deps.db, {
      threadId: sourceId,
      cause: "stall",
      summary: stopped
        ? `You stopped this chat · ${waiting} on its result`
        : `${waiting} on this chat's result`,
      outcomeRef: sourceId,
      waitId: null,
      coveredInputIds: [],
      now,
    });

    markConditionsStall(deps.db, {
      sourceThreadId: sourceId,
      waitIds: forOwner.map(({ wait }) => wait.id),
      patch: {
        stallReceiptId: receipt?.id ?? STALL_RECEIPT_SKIPPED,
        stallWokenAt: wokenAt ?? now,
      },
    });
    changed.push(sourceId);
  }

  return changed;
}

function clipMessage(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();

  return flat.length <= STALL_LAST_MESSAGE_MAX
    ? flat
    : `${flat.slice(0, STALL_LAST_MESSAGE_MAX - 1)}…`;
}

function escalationText(args: {
  sourceId: string;
  rows: readonly PendingChatRow[];
  lastMessage: string | null;
}): string {
  const wanted = [...new Set(args.rows.map(({ wait }) => wait.forText))];

  return [
    `@thread:${args.sourceId} went idle without delivering the result you wait on (${wanted.join("; ")}). Omnyo already asked it once and gave it the exact delivery command.`,
    ...(args.lastMessage === null
      ? []
      : [`Its last message: "${clipMessage(args.lastMessage)}"`]),
    "Choose one:",
    `- Ask it again: \`omnyo thread tell ${args.sourceId} --mode auto "<what you still need>"\``,
    ...args.rows.map(
      ({ wait }) =>
        `- Stop waiting for ${wait.forText}, for example when you already have the result: \`omnyo wait cancel ${wait.id}\``,
    ),
  ].join("\n");
}

function ownerStallReceiptOf(condition: ConditionRow): string | null {
  return condition.stallReceiptId === null ||
    condition.stallReceiptId === STALL_ESCALATED_TO_WAITER ||
    condition.stallReceiptId === STALL_RECEIPT_SKIPPED
    ? null
    : condition.stallReceiptId;
}

function isEscalatable(row: PendingChatRow, stopped: boolean): boolean {
  return (
    !stopped &&
    isOwedCallback(row) &&
    row.wait.createdBy === "agent" &&
    row.condition.stallWokenAt !== null &&
    (row.condition.stallReceiptId === null ||
      ownerStallReceiptOf(row.condition) !== null)
  );
}

function sourceStopped(db: DbQueryConnection, sourceId: string): boolean {
  return latestEndedTurnMark(db, sourceId)?.endedOutcome === "stopped";
}

async function escalateToWaiters(
  deps: LoggedPendingInteractionWorkSessionDeps,
  sourceId: string,
  now: number,
): Promise<string[]> {
  const stoppedBefore = sourceStopped(deps.db, sourceId);

  const waiterIds = [
    ...new Set(
      listPendingChatConditionsForSource(deps.db, sourceId)
        .filter((row) => isEscalatable(row, stoppedBefore))
        .map(({ wait }) => wait.threadId),
    ),
  ];

  if (waiterIds.length === 0) return [];

  const lastMessage = getLastThreadOutput(deps.db, sourceId);

  const executions = new Map(
    await Promise.all(
      waiterIds.map(
        async (waiterId) =>
          [
            waiterId,
            await buildExecutionOptions(deps, {}, { threadId: waiterId }),
          ] as const,
      ),
    ),
  );

  const reached = deps.db.transaction(
    (tx) => {
      if (!sourceIsIdle(tx, sourceId)) return [];

      const stopped = sourceStopped(tx, sourceId);
      const byWaiter = new Map<string, PendingChatRow[]>();

      for (const row of listPendingChatConditionsForSource(tx, sourceId))
        if (isEscalatable(row, stopped))
          byWaiter.set(row.wait.threadId, [
            ...(byWaiter.get(row.wait.threadId) ?? []),
            row,
          ]);

      const queued: string[] = [];

      for (const [waiterId, rows] of byWaiter) {
        const execution = executions.get(waiterId);
        const waiter = getInboxThread(tx, waiterId);

        if (
          execution === undefined ||
          waiter === null ||
          waiter.archivedAt !== null ||
          waiter.deletedAt !== null ||
          hasPausedQueue(tx, waiterId)
        )
          continue;

        createQueuedThreadMessageInTransaction(tx, {
          threadId: waiterId,
          content: [
            {
              type: "text",
              text: escalationText({ sourceId, rows, lastMessage }),
              mentions: [],
            },
          ],
          requestedBy: { initiator: "system", senderThreadId: waiterId },
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          permissionMode: execution.permissionMode,
          serviceTier: execution.serviceTier,
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: {
            kind: "external-message",
            subject: {
              kind: "message-source",
              source: { kind: "script", label: "Inbox" },
            },
          },
        });
        markConditionsStall(tx, {
          sourceThreadId: sourceId,
          waitIds: rows.map(({ wait }) => wait.id),
          patch: { stallReceiptId: STALL_ESCALATED_TO_WAITER },
        });
        releaseChatStallReceipts(
          tx,
          rows.flatMap(({ condition }) => {
            const receiptId = ownerStallReceiptOf(condition);

            return receiptId === null ? [] : [receiptId];
          }),
          now,
        );
        queued.push(waiterId);
      }

      return queued;
    },
    { behavior: "immediate" },
  );

  for (const waiterId of reached) {
    deps.hub.notifyThread(waiterId, ["queue-changed"]);
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: waiterId,
    });
  }

  return reached;
}

function wakeText(rows: readonly PendingChatRow[]): string {
  const waiters = [...new Set(rows.map(({ wait }) => wait.threadId))];

  return [
    `${waiters.map((id) => `@thread:${id}`).join(", ")} ${waiters.length === 1 ? "is" : "are"} waiting on your result. Deliver it with:`,
    ...[...new Map(rows.map(({ wait }) => [wait.id, wait])).values()].map(
      (wait) =>
        `- \`omnyo thread tell ${wait.threadId} --mode auto "${wait.marker} <result>"\``,
    ),
    "If you can't deliver it yet, explain why.",
  ].join("\n");
}

async function dispatchStallWake(
  deps: LoggedPendingInteractionWorkSessionDeps,
  sourceId: string,
  now: number,
): Promise<boolean> {
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: sourceId },
  );

  const queued = deps.db.transaction(
    (tx) => {
      if (!sourceIsIdle(tx, sourceId)) return false;

      const rows = listPendingChatConditionsForSource(tx, sourceId).filter(
        (row) => isOwedCallback(row) && row.condition.stallWokenAt === null,
      );

      if (rows.length === 0) return false;

      createQueuedThreadMessageInTransaction(tx, {
        threadId: sourceId,
        content: [{ type: "text", text: wakeText(rows), mentions: [] }],
        requestedBy: { initiator: "system", senderThreadId: sourceId },
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        permissionMode: execution.permissionMode,
        serviceTier: execution.serviceTier,
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: {
          kind: "external-message",
          subject: {
            kind: "message-source",
            source: { kind: "script", label: "Inbox" },
          },
        },
      });
      markConditionsStall(tx, {
        sourceThreadId: sourceId,
        waitIds: rows.map(({ wait }) => wait.id),
        patch: { stallWokenAt: now },
      });

      return true;
    },
    { behavior: "immediate" },
  );

  if (!queued) return false;
  deps.hub.notifyThread(sourceId, ["queue-changed"]);
  requestQueuedMessageDispatch(deps, {
    kind: "thread-ready",
    threadId: sourceId,
  });

  return true;
}
