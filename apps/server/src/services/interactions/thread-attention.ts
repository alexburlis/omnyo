import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  createQueuedThreadMessageInTransaction,
  getQueuedThreadMessage,
  getThread,
  listStoredEventRows,
  listThreadQuestions,
  listThreadCallbacks,
  threadQuestions,
  threadCallbacks,
  toThreadQuestion,
} from "@omnyo/db";
import {
  INBOX_FOR_TEXT_MAX,
  threadQuestionInputSchema,
  threadQuestionAnswerSchema,
  threadQuestionAnsweredBySchema,
  type ThreadAttentionResult,
  type ThreadQuestionAnswer,
  type ThreadQuestionAnsweredBy,
  type ThreadQuestion,
} from "@omnyo/domain";
import type { AttentionCommand } from "@omnyo/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { buildExecutionOptions } from "../threads/thread-commands.js";
import { sendQueuedMessageNow } from "../threads/queued-messages.js";
import { parseStoredEvent } from "../threads/thread-data.js";
import { acknowledgeOwnerMessage, writeReceipt } from "../inbox/engine.js";
import { getWait, updateWait } from "../inbox/store.js";
import { dispatchWake, registerWait } from "../inbox/waits.js";
import { queueChildThreadQuestion } from "../threads/child-thread-notifications.js";
import { resolveQuestionOwnerThread } from "../threads/thread-parent.js";
import { messageSourceNotice } from "../threads/message-source.js";
import type { InboxActor } from "../inbox/actor.js";

function conflict(message: string): never {
  throw new ApiError(409, "invalid_request", message);
}

function ownerOnly(message: string): never {
  throw new ApiError(403, "owner_only", message);
}

interface QuestionDelegation {
  ruleId: string;
  reason: string;
}

function answeringIdentity(
  actor: InboxActor,
  delegation: QuestionDelegation | undefined,
): ThreadQuestionAnsweredBy {
  if (actor.kind !== "plugin" && delegation !== undefined)
    throw new ApiError(
      400,
      "invalid_request",
      "Only a plugin answering under a delegation rule supplies delegation",
    );

  if (actor.kind === "plugin" && delegation === undefined)
    throw new ApiError(
      400,
      "invalid_request",
      "A plugin answer must name the delegation rule and reason",
    );

  const parsed = threadQuestionAnsweredBySchema.safeParse(
    actor.kind === "plugin"
      ? {
          kind: "plugin",
          pluginId: actor.pluginId,
          ruleId: delegation?.ruleId,
          reason: delegation?.reason,
        }
      : actor.kind === "automation"
        ? { kind: "automation", automationId: actor.automationId }
        : actor,
  );

  if (!parsed.success)
    throw new ApiError(400, "invalid_request", "Unrecognized answering caller");

  return parsed.data;
}

export function notifyThreadAttentionChanged(
  deps: Pick<AppDeps, "db" | "hub">,
  threadId: string,
): void {
  deps.hub.notifyThread(threadId, ["interactions-changed"], {
    attentionItems: {
      questions: listThreadQuestions(deps.db, threadId),
      callbacks: listThreadCallbacks(deps.db, threadId),
    },
  });
}

export function reconcileThreadCallbacks(
  deps: Pick<AppDeps, "db" | "hub">,
  threadId?: string,
): void {
  const rows = deps.db
    .select()
    .from(threadCallbacks)
    .where(
      threadId === undefined
        ? undefined
        : eq(threadCallbacks.threadId, threadId),
    )
    .all();

  for (const wait of rows) {
    if (wait.sourceThreadId === null) continue;
    let cursor = wait.afterSeq;
    let matched = false;
    const requests = new Map<string, number>();
    const accepted = new Set<string>();
    const rejected = new Set<string>();

    for (;;) {
      const events = listStoredEventRows(deps.db, {
        threadId: wait.threadId,
        afterSequence: cursor,
        limit: 100,
        order: "asc",
        types: [
          "client/turn/requested",
          "turn/input/accepted",
          "client/turn/rejected",
        ],
      });

      for (const row of events) {
        cursor = row.sequence;
        const event = parseStoredEvent(row);

        if (event.type === "client/turn/requested") {
          const text = event.input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");

          if (
            event.senderThreadId === wait.sourceThreadId &&
            row.createdAt >= wait.createdAt &&
            text.includes(wait.matchText)
          )
            requests.set(event.requestId, row.sequence);
        } else if (event.type === "turn/input/accepted")
          accepted.add(event.clientRequestId);
        else if (event.type === "client/turn/rejected")
          rejected.add(event.requestId);
      }

      matched = [...requests.keys()].some((id) => accepted.has(id));

      if (matched || events.length < 100) break;
    }

    for (const [id, sequence] of requests)
      if (!rejected.has(id)) cursor = Math.min(cursor, sequence - 1);

    const identity = and(
      eq(threadCallbacks.threadId, wait.threadId),
      eq(threadCallbacks.id, wait.id),
    );

    if (matched) {
      const removed = deps.db
        .delete(threadCallbacks)
        .where(identity)
        .returning()
        .get();

      if (removed) notifyThreadAttentionChanged(deps, wait.threadId);
    } else if (cursor !== wait.afterSeq)
      deps.db
        .update(threadCallbacks)
        .set({ afterSeq: cursor })
        .where(identity)
        .run();
  }
}

export function threadAttentionSnapshot(deps: Pick<AppDeps, "db" | "hub">) {
  reconcileThreadCallbacks(deps);

  return {
    questions: listThreadQuestions(deps.db),
    callbacks: listThreadCallbacks(deps.db),
  };
}

export async function executeAttentionCommand(
  deps: AppDeps,
  threadId: string,
  command: AttentionCommand,
  actor: InboxActor,
): Promise<ThreadAttentionResult> {
  const thread = getThread(deps.db, threadId);

  if (!thread || thread.deletedAt !== null)
    throw new ApiError(404, "invalid_request", "Chat not found");

  if (thread.archivedAt !== null)
    conflict("Questions and callbacks belong to a visible, unarchived chat");

  if (command.action === "open") {
    const ownerThread = resolveQuestionOwnerThread(deps, thread);

    if (ownerThread !== null) {
      const delivered = await queueChildThreadQuestion(deps, {
        childThread: thread,
        parentThreadId: ownerThread.id,
        questions: command.questions.map((question) =>
          threadQuestionInputSchema.parse(question),
        ),
      });

      if (!delivered)
        conflict(
          "The chat this one reports to is no longer available; ask the question again",
        );

      return {
        questions: [],
        callbacks: listThreadCallbacks(deps.db, threadId),
        cleared: false,
        callbackMarker: null,
        routedToThreadId: ownerThread.id,
      };
    }
  }

  if (thread.visibility === "hidden")
    conflict("Questions and callbacks belong to a visible, unarchived chat");
  let cleared = false;
  let callbackMarker: string | null = null;
  let changedQuestions = listThreadQuestions(deps.db, threadId);
  let delivery: ThreadQuestion | null = null;

  if (command.action === "open") {
    const inputs = command.questions.map((question) =>
      threadQuestionInputSchema.parse(question),
    );

    changedQuestions = deps.db.transaction(
      (tx) => {
        const open = tx
          .select()
          .from(threadQuestions)
          .where(
            and(
              eq(threadQuestions.threadId, threadId),
              eq(threadQuestions.state, "open"),
            ),
          )
          .all();

        if (open.length + inputs.length > 20)
          conflict("At most 20 questions may be open in a chat");

        const keys = new Set(
          open.flatMap((row) => (row.key === null ? [] : [row.key])),
        );

        for (const input of inputs) {
          if (input.key !== null && keys.has(input.key))
            conflict(`Question key ${input.key} is already open`);

          if (input.key !== null) keys.add(input.key);
        }

        const now = Date.now();

        const required = inputs.find(
          (question) => question.mode === "required",
        );

        if (required !== undefined)
          writeReceipt(tx, {
            threadId,
            cause: "question",
            summary: required.prompt,
            outcomeRef: null,
            waitId: null,
            coveredInputIds: [],
            now,
          });

        return inputs.map((question) =>
          toThreadQuestion(
            tx
              .insert(threadQuestions)
              .values({
                id: `question_${randomUUID()}`,
                threadId,
                revision: 1,
                question: JSON.stringify(question),
                mode: question.mode,
                key: question.key,
                state: "open",
                answer: null,
                queuedMessageId: null,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .get(),
          ),
        );
      },
      { behavior: "immediate" },
    );
  } else if (command.action === "wait") {
    const now = Date.now();

    const registered = registerWait(
      deps.db,
      {
        threadId,
        key: `callback:${command.sourceThreadId}`,
        forText: command.reason.slice(0, INBOX_FOR_TEXT_MAX),
        chats: [command.sourceThreadId],
        events: [],
        check: null,
        report: null,
        readiness: "all",
        by: null,
        resume: null,
        after: null,
      },
      { kind: "thread", threadId },
      now,
    );

    callbackMarker = registered.wait.marker;

    if (registered.readyNow)
      await dispatchWake(deps, {
        waitId: registered.wait.id,
        phase: "resume",
        now,
      });
  } else if (command.action === "clear") {
    const wait = getWait(deps.db, command.id);

    cleared =
      wait !== null && wait.threadId === threadId && wait.status !== "closed"
        ? (updateWait(
            deps.db,
            wait.id,
            {
              status: "closed",
              closedReason: "agent-cancel",
              closedAt: Date.now(),
            },
            Date.now(),
          ),
          true)
        : deps.db
            .delete(threadCallbacks)
            .where(
              and(
                eq(threadCallbacks.threadId, threadId),
                eq(threadCallbacks.id, command.id),
              ),
            )
            .returning()
            .get() !== undefined;
  } else if (command.action === "answer" || command.action === "answers") {
    const resolution = await resolveQuestions(
      deps,
      thread,
      command.action === "answer"
        ? [
            {
              id: command.id,
              revision: command.revision,
              answer: command.answer,
            },
          ]
        : command.answers,
      answeringIdentity(actor, command.delegation),
    );

    if (resolution.retried) {
      if (resolution.delivery !== null)
        await dispatchQuestionAnswer(deps, resolution.delivery);

      return {
        questions: resolution.questions,
        callbacks: listThreadCallbacks(deps.db, threadId),
        cleared: false,
        callbackMarker: null,
        routedToThreadId: null,
      };
    }

    changedQuestions = resolution.questions;
    delivery = resolution.delivery;
  } else {
    const existing = deps.db
      .select()
      .from(threadQuestions)
      .where(
        and(
          eq(threadQuestions.id, command.id),
          eq(threadQuestions.threadId, threadId),
        ),
      )
      .get();

    if (!existing)
      throw new ApiError(404, "invalid_request", "Question not found");
    const current = toThreadQuestion(existing);

    if (current.revision !== command.revision)
      conflict(
        "The question changed; review the current question before answering",
      );

    if (current.state !== "open")
      conflict(`The question is already ${current.state}`);

    if (
      command.action === "update" &&
      !current.question.delegable &&
      command.question.delegable &&
      actor.kind !== "owner" &&
      !(actor.kind === "thread" && actor.threadId === threadId)
    )
      ownerOnly(
        "Only the owner or the asking chat can mark a question delegable",
      );

    if (
      command.action !== "update" &&
      actor.kind === "plugin" &&
      !current.question.delegable
    )
      ownerOnly("Only the owner can resolve a question not marked delegable");

    if (
      command.action === "update" &&
      command.question.key !== null &&
      deps.db
        .select()
        .from(threadQuestions)
        .where(
          and(
            eq(threadQuestions.threadId, threadId),
            eq(threadQuestions.state, "open"),
            eq(threadQuestions.key, command.question.key),
          ),
        )
        .all()
        .some((row) => row.id !== current.id)
    )
      conflict(`Question key ${command.question.key} is already open`);

    const identity = and(
      eq(threadQuestions.id, current.id),
      eq(threadQuestions.revision, command.revision),
      eq(threadQuestions.state, "open"),
    );

    const updated =
      command.action === "update"
        ? deps.db
            .update(threadQuestions)
            .set({
              question: JSON.stringify(command.question),
              key: command.question.key,
              mode: command.question.mode,
              revision: current.revision + 1,
              updatedAt: Date.now(),
            })
            .where(identity)
            .returning()
            .get()
        : deps.db
            .update(threadQuestions)
            .set({
              state: command.action === "skip" ? "skipped" : "withdrawn",
              updatedAt: Date.now(),
            })
            .where(identity)
            .returning()
            .get();

    if (!updated) conflict("Question changed during submission");
    changedQuestions = [toThreadQuestion(updated)];
  }

  notifyThreadAttentionChanged(deps, threadId);

  if (delivery !== null) {
    const accepted = delivery;

    if (actor.kind === "owner")
      deps.db.transaction(
        (tx) =>
          acknowledgeOwnerMessage(tx, {
            threadId: accepted.threadId,
            now: Date.now(),
          }),
        { behavior: "immediate" },
      );
    await dispatchQuestionAnswer(deps, accepted);
  }

  return {
    questions: changedQuestions,
    callbacks: listThreadCallbacks(deps.db, threadId),
    cleared,
    callbackMarker,
    routedToThreadId: null,
  };
}

interface QuestionResolution {
  id: string;
  revision: number;
  answer: ThreadQuestionAnswer | null;
}

function matchesResolution(
  question: ThreadQuestion,
  resolution: QuestionResolution,
): boolean {
  if (question.revision !== resolution.revision) return false;

  return resolution.answer === null
    ? question.state === "skipped"
    : question.state === "answered" &&
        JSON.stringify(question.answer) === JSON.stringify(resolution.answer);
}

function validateQuestionAnswer(
  question: ThreadQuestion,
  answer: ThreadQuestionAnswer,
): void {
  const known = new Set(
    question.question.options.map((option) => option.value),
  );

  if (
    new Set(answer.selected).size !== answer.selected.length ||
    answer.selected.some((value) => !known.has(value))
  )
    conflict("Choose valid distinct options");

  if (!question.question.multiSelect && answer.selected.length > 1)
    conflict("Choose one option");

  if (answer.freeText !== undefined && !question.question.allowFreeText)
    conflict("This question accepts choices only");

  if (answer.selected.length === 0 && answer.freeText === undefined)
    conflict("Supply an answer");
}

function firstDelivery(
  questions: readonly ThreadQuestion[],
): ThreadQuestion | null {
  return (
    questions.find(
      (question) =>
        question.state === "answered" && question.queuedMessageId !== null,
    ) ?? null
  );
}

async function resolveQuestions(
  deps: AppDeps,
  thread: { id: string; status: string },
  entries: readonly QuestionResolution[],
  answeredBy: ThreadQuestionAnsweredBy,
): Promise<{
  questions: ThreadQuestion[];
  delivery: ThreadQuestion | null;
  retried: boolean;
}> {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    conflict("Answer each question once");

  const resolutions = entries.map((entry) => ({
    id: entry.id,
    revision: entry.revision,
    answer:
      entry.answer === null
        ? null
        : threadQuestionAnswerSchema.parse(entry.answer),
  }));

  const read = (db: Pick<AppDeps["db"], "select">) => {
    const rows = new Map(
      db
        .select()
        .from(threadQuestions)
        .where(
          and(
            eq(threadQuestions.threadId, thread.id),
            inArray(
              threadQuestions.id,
              resolutions.map((resolution) => resolution.id),
            ),
          ),
        )
        .all()
        .map((row) => [row.id, toThreadQuestion(row)] as const),
    );

    return resolutions.map((resolution) => ({
      resolution,
      question: rows.get(resolution.id) ?? null,
    }));
  };

  const current = read(deps.db).map(({ resolution, question }) => {
    if (question === null)
      throw new ApiError(404, "invalid_request", "Question not found");

    if (question.revision !== resolution.revision)
      conflict(
        "The question changed; review the current question before answering",
      );

    return { resolution, question };
  });

  if (
    answeredBy.kind !== "owner" &&
    current.some(({ question }) => !question.question.delegable)
  )
    ownerOnly("Only the owner can answer a question not marked delegable");

  if (
    current.every(({ question, resolution }) =>
      matchesResolution(question, resolution),
    )
  ) {
    const questions = current.map(({ question }) => question);

    return { questions, delivery: firstDelivery(questions), retried: true };
  }

  for (const { question, resolution } of current) {
    if (question.state !== "open")
      conflict(`The question is already ${question.state}`);

    if (resolution.answer !== null)
      validateQuestionAnswer(question, resolution.answer);
  }

  const execution = current.some(({ resolution }) => resolution.answer !== null)
    ? await buildExecutionOptions(deps, {}, { threadId: thread.id })
    : null;

  const text = questionAnswerMessage(current, answeredBy);

  const questions = deps.db.transaction(
    (tx) => {
      const latest = read(tx);
      const settled: ThreadQuestion[] = [];

      for (const { question, resolution } of latest)
        if (question !== null && matchesResolution(question, resolution))
          settled.push(question);

      if (settled.length === latest.length) return settled;

      if (
        latest.some(
          ({ question, resolution }) =>
            question === null ||
            question.state !== "open" ||
            question.revision !== resolution.revision,
        )
      )
        conflict("Question changed during submission; reload and retry");

      const queue =
        execution === null
          ? null
          : createQueuedThreadMessageInTransaction(tx, {
              threadId: thread.id,
              content: [{ type: "text", text, mentions: [] }],
              model: execution.model,
              reasoningLevel: execution.reasoningLevel,
              permissionMode: execution.permissionMode,
              serviceTier: execution.serviceTier,
              waitingOn:
                thread.status === "stopping"
                  ? { kind: "stopping" }
                  : { kind: "thread-busy" },
              sendAt: null,
              payload: { kind: "inline" },
              systemNotice:
                answeredBy.kind === "plugin"
                  ? messageSourceNotice(
                      { kind: "plugin", pluginId: answeredBy.pluginId },
                      null,
                    )
                  : null,
            });

      const now = Date.now();

      return resolutions.map(({ id, answer }) =>
        toThreadQuestion(
          tx
            .update(threadQuestions)
            .set(
              answer === null || queue === null
                ? { state: "skipped", updatedAt: now }
                : {
                    state: "answered",
                    answer: JSON.stringify(answer),
                    queuedMessageId: queue.id,
                    answeredBy: JSON.stringify(answeredBy),
                    updatedAt: now,
                  },
            )
            .where(eq(threadQuestions.id, id))
            .returning()
            .get(),
        ),
      );
    },
    { behavior: "immediate" },
  );

  if (execution !== null) deps.hub.notifyThread(thread.id, ["queue-changed"]);

  return { questions, delivery: firstDelivery(questions), retried: false };
}

async function dispatchQuestionAnswer(
  deps: AppDeps,
  question: ThreadQuestion,
): Promise<void> {
  const queuedMessageId = question.queuedMessageId;

  if (
    queuedMessageId === null ||
    getQueuedThreadMessage(deps.db, queuedMessageId) === null
  )
    return;

  try {
    await sendQueuedMessageNow(deps, {
      mode: "auto",
      queuedMessageId,
      threadId: question.threadId,
      overrideFailures: question.answeredBy?.kind === "owner",
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    if (error.body.code === "queued_message_still_waiting") return;
    const remaining = getQueuedThreadMessage(deps.db, queuedMessageId);

    if (
      error.body.code === "invalid_request" &&
      (((error.status === 404 || error.status === 409) && remaining === null) ||
        (error.status === 409 &&
          remaining !== null &&
          remaining.claimedAt !== null))
    )
      return;

    throw error;
  }
}

function questionAnswerMessage(
  resolutions: readonly {
    question: ThreadQuestion;
    resolution: { answer: ThreadQuestionAnswer | null };
  }[],
  answeredBy: ThreadQuestionAnsweredBy,
): string {
  return [
    ...resolutions.map(({ question, resolution: { answer } }) => {
      if (answer === null)
        return [
          `Question skipped: ${question.question.prompt}`,
          `Question ID: ${question.id}.`,
        ].join("\n");

      const labels = question.question.options
        .filter((option) => answer.selected.includes(option.value))
        .map((option) => option.label);

      return [
        `Question answered: ${question.question.prompt}`,
        labels.length > 0 ? `Choice: ${labels.join(", ")}` : "",
        answer.freeText ?? "",
        `Question ID: ${question.id}.`,
      ]
        .filter(Boolean)
        .join("\n");
    }),
    answeredBy.kind === "plugin"
      ? `Answered on the owner's behalf by the ${answeredBy.pluginId} plugin under its rule ${answeredBy.ruleId} (${answeredBy.reason}). This covers only this reversible choice and does not authorize any effect that needs the owner's approval.`
      : "",
    "Continue the current task from its existing progress.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
