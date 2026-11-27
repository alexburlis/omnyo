import type {
  InboxCard,
  InboxCounts,
  InboxEntry,
  InboxPrimary,
  InboxSnapshot,
  InboxWaitingRow,
} from "../lib/inbox.ts";

export type InboxCause = InboxCard["causes"][number];

export const OK: InboxPrimary = { kind: "ok", thenWaits: null };

export function cause(receiptId: string, change: Partial<InboxCause> = {}): InboxCause {
  return {
    receiptId,
    cause: "result",
    threadId: "root",
    fromTitle: null,
    summary: `Result ${receiptId}`,
    at: 1_000,
    ...change,
  };
}

export function card(primary: InboxPrimary, change: Partial<InboxCard> = {}): InboxCard {
  return {
    kind: "result",
    causes: [cause("r1")],
    primary,
    actions: ["archive", "wait", "reply", "shelf"],
    questionIds: [],
    questionMode: change.kind === "question" ? "required" : null,
    questionFrom: null,
    snoozedQuestionUntil: null,
    stillOnYou: null,
    notAssessed: null,
    failure: null,
    since: 1_000,
    ...change,
  };
}

export function question(questionId: string, change: Partial<InboxCard> = {}): InboxCard {
  return card(
    { kind: "answer" },
    {
      kind: "question",
      questionMode: "required",
      actions: [],
      questionIds: [questionId],
      ...change,
    },
  );
}

function latchOf(entry: Omit<InboxEntry, "latch">): string {
  const shown = entry.card;

  if (shown === null) return entry.view;

  return [
    entry.view,
    shown.kind,
    ...(shown.questionMode === null ? [] : [shown.questionMode]),
    JSON.stringify(shown.primary),
    ...shown.causes.map((item) => item.receiptId),
    ...shown.questionIds,
  ].join("|");
}

export function entry(threadId: string, change: Partial<InboxEntry> = {}): InboxEntry {
  const base: Omit<InboxEntry, "latch"> = {
    threadId,
    projectId: "omnyo",
    title: threadId,
    shelved: false,
    automationId: null,
    view: "inbox",
    state:
      change.view === "running"
        ? "working"
        : change.view === "waiting"
          ? "waiting"
          : change.view === "resting"
            ? "resting"
            : change.view === "archive"
              ? "archive"
              : change.card?.kind === "question"
                ? "needs-you"
                : "finished",
    reason: { kind: "recap", text: "Finished the work.", threadId },
    recap: null,
    archiveReady:
      change.card?.kind !== "problem" &&
      (change.card?.primary.kind === "archive" ||
        (change.card?.primary.kind === "archive-runs" && change.card.primary.mode === "done")),
    optionalQuestion: null,
    pendingResults: 0,
    card: card(OK),
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    sortAt: 1_000,
    ...change,
  };

  return { ...base, latch: change.latch ?? latchOf(base) };
}

export function row(change: Partial<InboxWaitingRow> = {}): InboxWaitingRow {
  return {
    group: "comes-back",
    kind: "event",
    reason: "Deploy result",
    waitId: "wait-1",
    returnAt: null,
    checkAt: null,
    checkCount: 0,
    checking: false,
    guaranteed: false,
    behind: null,
    retry: null,
    questionId: null,
    ...change,
  };
}

export function waiting(threadId: string, change: Partial<InboxWaitingRow> = {}): InboxEntry {
  return entry(threadId, { view: "waiting", card: null, waiting: row(change) });
}

export function counts(change: Partial<InboxCounts> = {}): InboxCounts {
  return {
    needsYou: 0,
    inbox: 0,
    questions: 0,
    running: 0,
    waiting: 0,
    onYou: [],
    nextBackAt: null,
    ...change,
  };
}

export function snapshot(change: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    revision: "rev-1",
    generatedAt: 1_000,
    inbox: [],
    waiting: [],
    running: [],
    shelf: [],
    counts: counts(),
    lastMove: null,
    ...change,
  };
}
