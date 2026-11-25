import type { InboxCard, InboxEntry, InboxSnapshot } from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import {
  answerInboxQuestions,
  archiveInboxThreads,
  captureInboxRows,
  predictInboxAct,
  removeInboxThreads,
  restoreInboxRows,
  retitleInboxThread,
  scheduleInboxSend,
  shelveInboxThread,
  startInboxTurn,
  queueInboxSend,
  stopInboxTurn,
  withInboxEntry,
} from "./inbox-predictions";

function card(overrides: Partial<InboxCard> = {}): InboxCard {
  return {
    kind: "result",
    causes: [
      {
        receiptId: "rcp_1",
        cause: "result",
        threadId: "thr_a",
        fromTitle: null,
        summary: "Done",
        at: 1,
      },
    ],
    primary: { kind: "archive" },
    actions: ["archive"],
    questionIds: [],
    questionMode: null,
    questionFrom: null,
    snoozedQuestionUntil: null,
    stillOnYou: null,
    notAssessed: null,
    failure: null,
    since: 10,
    ...overrides,
  };
}

function entry(threadId: string, overrides: Partial<InboxEntry> = {}) {
  return {
    threadId,
    projectId: "proj_1",
    title: threadId,
    shelved: false,
    automationId: null,
    state: "finished",
    reason: { kind: "recap", text: "Done", threadId },
    recap: null,
    archiveReady: false,
    optionalQuestion: null,
    pendingResults: 1,
    view: "inbox",
    card: card(),
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    sortAt: 10,
    latch: "inbox",
    ...overrides,
  } satisfies InboxEntry;
}

function snapshot(lists: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    revision: "rev",
    generatedAt: 1,
    inbox: [],
    waiting: [],
    running: [],
    shelf: [],
    counts: {
      needsYou: 0,
      inbox: 0,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
    ...lists,
  };
}

const ids = (entries: readonly InboxEntry[]) =>
  entries.map((item) => item.threadId);

describe("inbox predictions", () => {
  it("resumes failed cards without adding failures to Needs you", () => {
    const failed = entry("failed", {
      state: "failed",
      card: card({
        kind: "problem",
        primary: {
          kind: "resume",
          targetThreadId: "failed",
          targetTitle: "Failed chat",
        },
      }),
    });

    const current = withInboxEntry(snapshot(), "failed", failed);
    expect(current.counts.needsYou).toBe(0);
    expect(current.counts.inbox).toBe(1);

    const resumed = predictInboxAct(current, {
      action: "resume",
      threadId: "failed",
      targetThreadId: "failed",
      displayedReceiptIds: [],
      latch: "inbox",
    });

    expect(resumed.inbox).toEqual([]);
    expect(resumed.running).toMatchObject([
      { threadId: "failed", state: "working" },
    ]);
  });
  it("archives a chat out of its work lists but keeps it on the Shelf, as the server does", () => {
    const shelved = entry("thr_a", { shelved: true });

    const next = archiveInboxThreads(
      snapshot({ inbox: [shelved, entry("thr_b")], shelf: [shelved] }),
      ["thr_a"],
    );

    expect(ids(next.inbox)).toEqual(["thr_b"]);
    expect(next.shelf).toMatchObject([
      { threadId: "thr_a", view: "archive", state: "archive", card: null },
    ]);
    expect(next.counts.inbox).toBe(1);
  });

  it("deletes a chat from every list and from grouped members", () => {
    const grouped = entry("thr_a", {
      runs: [
        {
          threadId: "thr_b",
          title: "b",
          primary: { kind: "archive" },
          causes: [],
          since: 1,
          latch: "b",
        },
      ],
    });

    const next = removeInboxThreads(
      snapshot({
        inbox: [grouped],
        shelf: [entry("thr_b", { shelved: true })],
      }),
      ["thr_b"],
    );

    expect(next.inbox[0]?.runs).toEqual([]);
    expect(next.shelf).toEqual([]);
  });

  it("moves a finished chat to Running when a turn starts, and leaves a question or decision card", () => {
    const decision = entry("thr_c", {
      card: card({
        causes: [
          {
            receiptId: "rcp_2",
            cause: "your-date",
            threadId: "thr_c",
            fromTitle: null,
            summary: "Back",
            at: 1,
          },
        ],
      }),
    });

    const question = entry("thr_q", {
      card: card({ kind: "question", questionIds: ["q1"] }),
    });

    const base = snapshot({
      inbox: [entry("thr_a"), decision, question],
    });

    const started = startInboxTurn(base, "thr_a");

    expect(ids(started.inbox)).toEqual(["thr_c", "thr_q"]);
    expect(started.running).toMatchObject([
      {
        threadId: "thr_a",
        view: "running",
        state: "working",
        card: null,
        running: { label: "Working", progress: null },
      },
    ]);
    expect(startInboxTurn(base, "thr_c")).toBe(base);
    expect(startInboxTurn(base, "thr_q")).toBe(base);
  });

  it("starts a retry only for the failed chat's card, including a failed child chat", () => {
    const failed = entry("thr_root", {
      card: card({
        kind: "problem",
        failure: {
          threadId: "thr_child",
          reason: "boom",
          queuedCount: 0,
          scheduledCount: 0,
        },
      }),
    });

    const base = snapshot({ inbox: [failed] });

    expect(startInboxTurn(base, "thr_child")).toBe(base);
    expect(
      ids(startInboxTurn(base, "thr_child", { clearsFailure: true }).running),
    ).toEqual(["thr_root"]);
  });

  it("labels a stopping chat without moving it", () => {
    const running = entry("thr_a", {
      view: "running",
      state: "working",
      card: null,
      running: { label: "Working", progress: null },
    });

    const next = stopInboxTurn(snapshot({ running: [running] }), "thr_a");

    expect(next.running[0]?.running?.label).toBe("Stopping");
  });

  it("shelves and unshelves a chat with a result card", () => {
    const base = snapshot({ inbox: [entry("thr_a")] });
    const shelved = shelveInboxThread(base, "thr_a", true);

    expect(shelved.inbox[0]).toMatchObject({
      shelved: true,
      card: { primary: { kind: "ok", thenWaits: null } },
    });
    expect(ids(shelved.shelf)).toEqual(["thr_a"]);

    const working = snapshot({
      running: [entry("thr_b", { view: "running", shelved: true, card: null })],
      shelf: [entry("thr_b", { view: "running", shelved: true, card: null })],
    });

    const unshelved = shelveInboxThread(working, "thr_b", false);

    expect(unshelved.running[0]?.shelved).toBe(false);
    expect(unshelved.shelf).toEqual([]);
  });

  it("keeps a resting Shelf chat in place on unshelve until the server places it", () => {
    const resting = entry("thr_a", {
      view: "resting",
      shelved: true,
      card: null,
    });

    const base = snapshot({ shelf: [resting] });

    expect(shelveInboxThread(base, "thr_a", false)).toBe(base);
  });

  it("renames entries and grouped members", () => {
    const next = retitleInboxThread(
      snapshot({ inbox: [entry("thr_a")] }),
      "thr_a",
      "New title",
    );

    expect(next.inbox[0]?.title).toBe("New title");
  });

  it("moves a waited card to Waiting with its return time", () => {
    const next = predictInboxAct(snapshot({ inbox: [entry("thr_a")] }), {
      action: "wait",
      threadId: "thr_a",
      displayedReceiptIds: ["rcp_1"],
      until: 5_000,
    });

    expect(next.inbox).toEqual([]);
    expect(next.waiting[0]?.waiting).toMatchObject({
      returnAt: 5_000,
      guaranteed: true,
    });
    expect(next.counts.nextBackAt).toBe(5_000);
  });

  it("moves a causeless result card to Waiting when a message is scheduled", () => {
    const idle = entry("thr_a", { card: card({ causes: [] }) });

    const next = scheduleInboxSend(snapshot({ inbox: [idle] }), "thr_a", 9_000);

    expect(next.waiting[0]).toMatchObject({
      view: "waiting",
      waiting: { reason: "Your message sends", returnAt: 9_000 },
    });

    const withResult = snapshot({ inbox: [entry("thr_b")] });

    expect(scheduleInboxSend(withResult, "thr_b", 9_000)).toBe(withResult);
  });

  it("places the server's returned entry and restores captured rows", () => {
    const base = snapshot({ inbox: [entry("thr_a"), entry("thr_b")] });
    const rows = captureInboxRows(base, ["thr_a"]);
    const archived = archiveInboxThreads(base, ["thr_a"]);

    expect(ids(restoreInboxRows(archived, rows).inbox)).toEqual([
      "thr_a",
      "thr_b",
    ]);

    const placed = withInboxEntry(
      archived,
      "thr_a",
      entry("thr_a", { view: "waiting", card: null }),
    );

    expect(ids(placed.waiting)).toEqual(["thr_a"]);
  });
});

function questionEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return entry("thr_waiting", {
    state: "needs-you",
    pendingResults: 0,
    card: card({
      kind: "question",
      causes: [],
      primary: { kind: "answer" },
      actions: [],
      questionIds: ["q_1"],
    }),
    ...overrides,
  });
}

function questionSnapshot(entries: InboxEntry[]): InboxSnapshot {
  return snapshot({ inbox: entries });
}

describe("answered Inbox questions", () => {
  it("resolves a child question on its family root card", () => {
    const next = answerInboxQuestions(
      questionSnapshot([questionEntry()]),
      "thr_child",
      ["q_1"],
      true,
    );

    expect(next.inbox).toEqual([]);
    expect(next.running).toMatchObject([
      { threadId: "thr_waiting", view: "running" },
    ]);
  });

  it("keeps a running chat visible after its optional question is skipped", () => {
    const next = answerInboxQuestions(
      questionSnapshot([
        questionEntry({ running: { label: "Working", progress: null } }),
      ]),
      "thr_waiting",
      ["q_1"],
      false,
    );

    expect(next.inbox).toEqual([]);
    expect(next.running).toMatchObject([
      { threadId: "thr_waiting", view: "running" },
    ]);
  });

  it("moves the chat to Running when the answer resumes the turn", () => {
    const next = answerInboxQuestions(
      questionSnapshot([questionEntry()]),
      "thr_waiting",
      ["q_1"],
      true,
    );

    expect(next.inbox).toEqual([]);
    expect(next.running).toMatchObject([
      { threadId: "thr_waiting", view: "running", card: null },
    ]);
    expect(next.counts).toMatchObject({ inbox: 0, questions: 0, running: 1 });
  });

  it("removes a skipped question card without claiming the chat runs", () => {
    const next = answerInboxQuestions(
      questionSnapshot([questionEntry()]),
      "thr_waiting",
      ["q_1"],
      false,
    );

    expect(next.inbox).toEqual([]);
    expect(next.running).toEqual([]);
  });

  it("keeps the card while other questions remain, and leaves families alone", () => {
    const pair = questionEntry({
      card: card({ kind: "question", causes: [], questionIds: ["q_1", "q_2"] }),
    });

    expect(
      answerInboxQuestions(
        questionSnapshot([pair]),
        "thr_waiting",
        ["q_1"],
        true,
      ).inbox,
    ).toMatchObject([{ card: { kind: "question", questionIds: ["q_2"] } }]);

    const family = questionSnapshot([
      questionEntry({
        incident: {
          key: "provider-capacity",
          label: "Provider at capacity",
          resetAt: null,
          members: [],
        },
      }),
    ]);

    expect(answerInboxQuestions(family, "thr_waiting", ["q_1"], true)).toBe(
      family,
    );
  });
});

it.each(["question", "problem"] as const)(
  "keeps an existing %s when staging a message",
  (kind) => {
    const before = snapshot({
      inbox: [entry("thr_a", { card: card({ kind }) })],
    });

    expect(queueInboxSend(before, "thr_a", "Sending message")).toBe(before);
  },
);

it("keeps an existing run when its follow-up waits to send", () => {
  const before = snapshot({
    running: [
      entry("thr_a", {
        view: "running",
        state: "working",
        card: null,
        running: { label: "Working", progress: null },
      }),
    ],
  });

  expect(queueInboxSend(before, "thr_a", "Waiting for a connection")).toBe(
    before,
  );
});
