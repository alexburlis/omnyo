import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeckCardView, OpenQuestion } from "../lib/contract.ts";
import type { Verdict } from "../lib/inputs.ts";
import {
  EDGE_GUARD_PX,
  UNDO_MS,
  acceptPlan,
  actionLabels,
  answerShortcutIndex,
  answersCommand,
  cancelById,
  cancelLatest,
  committedSwipe,
  dragDirection,
  inEdgeGuard,
  keyIntent,
  outcomesFor,
  pruneHidden,
  restoreAnswers,
  schedule,
  snoozeChoices,
  suggestedChoice,
  takeDue,
  type PendingSend,
} from "../components/deck-logic.ts";

const question = (id: string, overrides: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id,
  threadId: "thr_a",
  revision: 2,
  mode: "required",
  shortLabel: "Pick",
  prompt: `Prompt ${id}`,
  context: null,
  multiSelect: false,
  allowFreeText: true,
  delegable: false,
  options: [
    { value: "a", label: "Alpha", description: null, recommended: true },
    { value: "b", label: "Beta", description: null, recommended: false },
    { value: "c", label: "Gamma", description: null, recommended: false },
  ],
  createdAt: 100,
  ...overrides,
});

const verdict = (key: string, recommendation: string[]): Verdict => ({
  key,
  recommendation,
  reason: "Matches earlier answers.",
  confidence: "high",
  priority: "now",
  authorityLike: false,
  duplicateOf: null,
  ruleIds: [],
});

const card = (overrides: Partial<DeckCardView> = {}): DeckCardView => ({
  key: "question:q1",
  kind: "question",
  threadId: "thr_a",
  title: "Chat",
  project: "Proj",
  text: "Prompt q1",
  steps: [{ question: question("q1"), key: "q1@2", verdict: null, triageError: null }],
  required: true,
  priority: "now",
  suggestedReply: null,
  ruleOffer: false,
  latch: null,
  alsoAsked: [],
  since: 100,
  ...overrides,
});

test("drags that start inside the edge guard on either side are ignored", () => {
  assert.equal(inEdgeGuard(EDGE_GUARD_PX - 1, 400), true);
  assert.equal(inEdgeGuard(400 - EDGE_GUARD_PX + 1, 400), true);
  assert.equal(inEdgeGuard(EDGE_GUARD_PX, 400), false);
  assert.equal(inEdgeGuard(200, 400), false);
});

test("a drag previews its dominant direction and commits only past its threshold", () => {
  assert.equal(dragDirection(5, 3), null);
  assert.equal(dragDirection(40, 10), "right");
  assert.equal(dragDirection(-40, 10), "left");
  assert.equal(dragDirection(10, -40), "up");
  assert.equal(dragDirection(5, 60), null);
  assert.equal(committedSwipe(89, 0), null);
  assert.equal(committedSwipe(91, 20), "right");
  assert.equal(committedSwipe(-91, 0), "left");
  assert.equal(committedSwipe(0, -79), null);
  assert.equal(committedSwipe(10, -81), "up");
  assert.equal(committedSwipe(0, 200), null);
});

test("accept uses the Chief's suggestion for every step and never the asking agent's pick", () => {
  const steps = [
    { question: question("q1"), key: "q1@2", verdict: verdict("q1@2", ["b"]), triageError: null },
    { question: question("q2"), key: "q2@2", verdict: verdict("q2@2", ["c"]), triageError: null },
  ];

  assert.deepEqual(acceptPlan(card({ steps })), [
    { id: "q1", revision: 2, selected: ["b"] },
    { id: "q2", revision: 2, selected: ["c"] },
  ]);

  const partial = [
    steps[0],
    { question: question("q2"), key: "q2@2", verdict: null, triageError: null },
  ];

  assert.equal(acceptPlan(card({ steps: partial })), null);
});

test("accept ignores Chief values that are not options and keeps one value for single-select", () => {
  const q = question("q1");

  assert.equal(
    acceptPlan(
      card({
        steps: [{ question: q, key: "q1@2", verdict: verdict("q1@2", ["zzz"]), triageError: null }],
      }),
    ),
    null,
  );

  assert.deepEqual(
    acceptPlan(
      card({
        steps: [{ question: q, key: "q1@2", verdict: verdict("q1@2", ["c", "b"]), triageError: null }],
      }),
    ),
    [{ id: "q1", revision: 2, selected: ["c"] }],
  );

  const multi = question("q1", { multiSelect: true });

  assert.deepEqual(
    acceptPlan(
      card({
        steps: [
          { question: multi, key: "q1@2", verdict: verdict("q1@2", ["a", "c"]), triageError: null },
        ],
      }),
    ),
    [{ id: "q1", revision: 2, selected: ["a", "c"] }],
  );
});

test("accept is unavailable without a suggestion, on rule offers and on other kinds", () => {
  const withVerdict = [
    { question: question("q1"), key: "q1@2", verdict: verdict("q1@2", ["a"]), triageError: null },
  ];

  assert.equal(acceptPlan(card()), null);
  assert.equal(acceptPlan(card({ steps: withVerdict, ruleOffer: true })), null);
  assert.equal(acceptPlan(card({ kind: "result", steps: [] })), null);
});

test("answers command submits every step in one command", () => {
  assert.deepEqual(
    answersCommand([
      { id: "q1", revision: 2, selected: ["a"], freeText: null },
      { id: "q2", revision: 3, selected: [], freeText: "Use the other one" },
      { id: "q3", revision: 1, selected: [], freeText: null },
    ]),
    {
      action: "answers",
      answers: [
        { id: "q1", revision: 2, answer: { selected: ["a"] } },
        { id: "q2", revision: 3, answer: { selected: [], freeText: "Use the other one" } },
        { id: "q3", revision: 1, answer: null },
      ],
    },
  );
});

test("only the answer picker interprets digit shortcuts", () => {
  assert.equal(answerShortcutIndex("2"), 1);
  assert.equal(answerShortcutIndex("8"), 7);
  assert.equal(answerShortcutIndex("9"), null);
  assert.equal(answerShortcutIndex("0"), null);
  assert.equal(keyIntent("2"), null);
});

test("recovering a failed answer keeps its draft and checks it against the current question", () => {
  const original = question("q1");

  const current = question("q1", {
    revision: 3,
    options: original.options.filter((option) => option.value !== "b"),
  });

  const newQuestion = question("q2", { allowFreeText: false });

  const changed = card({
    steps: [
      { question: newQuestion, key: "q2@2", verdict: null, triageError: null },
      { question: current, key: "q1@3", verdict: null, triageError: null },
    ],
  });

  assert.deepEqual(
    restoreAnswers(changed, [{ id: "q1", revision: 2, selected: ["b", "c"], freeText: " Draft  " }]),
    [
      { id: "q2", revision: 2, selected: [], freeText: null },
      { id: "q1", revision: 3, selected: ["c"], freeText: " Draft  " },
    ],
  );
});

test("keys map to deck intents", () => {
  assert.deepEqual(keyIntent("ArrowRight"), { kind: "right" });
  assert.deepEqual(keyIntent("Enter"), { kind: "right" });
  assert.deepEqual(keyIntent("ArrowLeft"), { kind: "left" });
  assert.deepEqual(keyIntent("ArrowUp"), { kind: "up" });
  assert.deepEqual(keyIntent("z"), { kind: "undo" });
  assert.deepEqual(keyIntent("Z"), { kind: "undo" });
  assert.equal(keyIntent("9"), null);
  assert.equal(keyIntent("0"), null);
  assert.equal(keyIntent("x"), null);
});

test("action labels follow the card kind and what is available", () => {
  const suggested = [
    { question: question("q1"), key: "q1@2", verdict: verdict("q1@2", ["a"]), triageError: null },
  ];

  assert.deepEqual(actionLabels(card({ steps: suggested }), false), {
    right: "Send suggested answer",
    left: "See other answers",
    up: "Save for later",
  });
  assert.equal(actionLabels(card(), false).right, "Choose an answer");
  assert.equal(
    actionLabels(card({ steps: suggested, ruleOffer: true }), false).right,
    "Review rule",
  );

  const guarded = [
    { ...suggested[0], verdict: { ...verdict("q1@2", ["a"]), authorityLike: true } },
  ];

  assert.equal(actionLabels(card({ steps: guarded }), false).right, "Review suggested answer");
  assert.equal(
    actionLabels(card({ kind: "result", suggestedReply: "Ship it" }), false).right,
    "Review reply",
  );
  assert.equal(
    actionLabels(card({ kind: "result", suggestedReply: null }), false).right,
    "Open chat",
  );
  assert.equal(actionLabels(card({ kind: "result" }), false).left, "Open chat");
  assert.equal(actionLabels(card({ kind: "problem" }), true).right, "Resume");
  assert.equal(actionLabels(card({ kind: "problem" }), false).right, "Open chat");
  assert.equal(actionLabels(card({ kind: "ask" }), false).right, "Open chat");
});

test("snooze offers an hour, tonight before 18:00 and tomorrow morning", () => {
  const morning = new Date(2026, 10, 20, 10, 15);
  const choices = snoozeChoices(morning);

  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["In 1 hour", "Tonight 18:00", "Tomorrow 09:00"],
  );
  assert.equal(choices[0].until, morning.getTime() + 3_600_000);
  assert.equal(choices[1].until, new Date(2026, 10, 20, 18, 0).getTime());
  assert.equal(choices[2].until, new Date(2026, 10, 21, 9, 0).getTime());

  const evening = snoozeChoices(new Date(2026, 10, 20, 19, 0));

  assert.deepEqual(
    evening.map((choice) => choice.label),
    ["In 1 hour", "Tomorrow 09:00"],
  );
});

test("the undo queue cancels one send by id from its toast", () => {
  const first: PendingSend = { id: "1", cardKey: "a", label: "Answered in A.", dueAt: 10 };
  const second: PendingSend = { id: "2", cardKey: "b", label: "Answered in B.", dueAt: 20 };
  const cancelled = cancelById([first, second], "1");

  assert.equal(cancelled.cancelled?.id, "1");
  assert.deepEqual(cancelled.queue, [second]);
  assert.deepEqual(cancelById([second], "1"), { queue: [second], cancelled: null });
});

test("the undo queue cancels the newest send and releases sends once due", () => {
  const first: PendingSend = { id: "1", cardKey: "a", label: "Answer", dueAt: 1000 + UNDO_MS };
  const second: PendingSend = { id: "2", cardKey: "b", label: "Reply", dueAt: 2000 + UNDO_MS };
  const queue = schedule(schedule([], first), second);
  const cancelled = cancelLatest(queue);

  assert.equal(cancelled.cancelled?.id, "2");
  assert.deepEqual(cancelled.queue, [first]);
  assert.deepEqual(cancelLatest([]), { queue: [], cancelled: null });

  const released = takeDue(queue, 1000 + UNDO_MS);

  assert.deepEqual(released.due, [first]);
  assert.deepEqual(released.rest, [second]);
});

test("hidden cards stay hidden only while the server still lists them", () => {
  const hidden = new Set(["a", "b"]);

  assert.deepEqual([...pruneHidden(hidden, [card({ key: "b" }), card({ key: "c" })])], ["b"]);
});

test("a grouped answer records one outcome per question with that question's own choice", () => {
  const steps = [
    { question: question("q1"), key: "q1@2", verdict: verdict("q1@2", ["a"]), triageError: null },
    { question: question("q2"), key: "q2@2", verdict: null, triageError: null },
  ];

  assert.deepEqual(
    outcomesFor(card({ steps }), {
      action: "accept",
      chosen: ["a", "b"],
      freeText: null,
      reasonChip: null,
      responseMs: 1234.7,
      steps: [
        { id: "q1", revision: 2, selected: ["a"], freeText: null },
        { id: "q2", revision: 2, selected: [], freeText: "Something else" },
      ],
    }).map((row) => [row.questionIds, row.chosen, row.freeText, row.action, row.responseMs]),
    [
      [["q1"], ["a"], null, "accept", 1235],
      [["q2"], [], "Something else", "custom", 1235],
    ],
  );
});

test("actions without step answers keep one row for the whole card", () => {
  const rows = outcomesFor(card(), {
    action: "later",
    chosen: [],
    freeText: null,
    reasonChip: "1 h",
    responseMs: -5,
    steps: null,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.responseMs, 0);
  assert.equal(rows[0]?.reasonChip, "1 h");
});

test("the list names Chief's pick only when it is one option of one question", () => {
  const step = (id: string, pick: string[]) => ({
    question: question(id),
    key: `${id}@2`,
    verdict: verdict(`${id}@2`, pick),
    triageError: null,
  });

  assert.equal(suggestedChoice(card({ steps: [step("q1", ["b"])] })), "Beta");
  assert.equal(suggestedChoice(card()), null);
  assert.equal(suggestedChoice(card({ steps: [step("q1", ["b"]), step("q2", ["c"])] })), null);
  assert.equal(suggestedChoice(card({ ruleOffer: true, steps: [step("q1", ["b"])] })), null);
  assert.equal(
    actionLabels(card({ steps: [step("q1", ["b"]), step("q2", ["c"])] }), false).right,
    "Send suggested answers",
  );
});
