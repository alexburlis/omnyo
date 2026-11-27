import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeck, type DeckSources, type InboxItem } from "../lib/cards.ts";
import type { OpenQuestion } from "../lib/contract.ts";
import { itemKey, type Verdict } from "../lib/inputs.ts";

const question = (overrides: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: "question_a",
  threadId: "thr_a",
  revision: 1,
  mode: "optional",
  shortLabel: "Scope",
  prompt: "Also build the Windows app?",
  context: null,
  multiSelect: false,
  allowFreeText: true,
  delegable: false,
  options: [
    { value: "no", label: "Server + web only", description: null, recommended: true },
    { value: "yes", label: "Build Windows", description: null, recommended: false },
  ],
  createdAt: 1_000,
  ...overrides,
});

const inbox = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  threadId: "thr_x",
  title: "Some chat",
  project: "omnyo",
  state: "finished",
  reasonKind: "recap",
  reasonText: "Done",
  archiveReady: false,
  latch: "latch_x",
  since: 500,
  ...overrides,
});

const verdict = (key: string, overrides: Partial<Verdict> = {}): Verdict => ({
  key,
  recommendation: ["no"],
  reason: "You chose this before.",
  confidence: "high",
  priority: "later",
  authorityLike: false,
  duplicateOf: null,
  ruleIds: [],
  ...overrides,
});

const sources = (overrides: Partial<DeckSources> = {}): DeckSources => ({
  questions: [],
  inbox: [],
  chats: new Map([
    ["thr_a", { title: "Release scope", project: "omnyo" }],
    ["thr_b", { title: "Another release", project: "omnyo" }],
  ]),
  verdicts: new Map(),
  triageErrors: new Map(),
  replies: new Map(),
  chiefThreadId: "thr_chief",
  offerQuestionIds: new Set(),
  showReplies: true,
  snoozedUntil: new Map(),
  now: 10_000,
  ...overrides,
});

test("questions a chat opened together form one card with one step each", () => {
  const deck = buildDeck(
    sources({
      questions: [
        question({ id: "question_b", createdAt: 1_000 }),
        question({ id: "question_a", createdAt: 1_000 }),
        question({ id: "question_c", createdAt: 2_000 }),
      ],
    }),
  );

  assert.equal(deck.cards.length, 2);
  assert.deepEqual(
    deck.cards[0]?.steps.map((step) => step.question.id),
    ["question_a", "question_b"],
  );
});

test("required questions and problems come before optional questions and suggested replies", () => {
  const deck = buildDeck(
    sources({
      questions: [
        question({ id: "question_opt" }),
        question({ id: "question_req", threadId: "thr_b", mode: "required" }),
      ],
      inbox: [
        inbox({ threadId: "thr_done", latch: "l1" }),
        inbox({ threadId: "thr_fail", state: "failed", reasonKind: "failure", latch: "l2" }),
        inbox({ threadId: "thr_ready", archiveReady: true, latch: "l3" }),
      ],
      replies: new Map([["thr_done", "Merge it"]]),
    }),
  );

  assert.deepEqual(
    deck.cards.map((card) => card.kind),
    ["question", "problem", "question", "result"],
  );
  assert.equal(deck.cards[0]?.required, true);
});

test("a triage priority reorders cards", () => {
  const optional = question({ id: "question_opt" });

  const deck = buildDeck(
    sources({
      questions: [optional, question({ id: "question_req", threadId: "thr_b", mode: "required" })],
      verdicts: new Map([
        [itemKey("question_opt", 1), verdict(itemKey("question_opt", 1), { priority: "now" })],
        [itemKey("question_req", 1), verdict(itemKey("question_req", 1), { priority: "later" })],
      ]),
    }),
  );

  assert.deepEqual(
    deck.cards.map((card) => card.steps[0]?.question.id),
    ["question_opt", "question_req"],
  );
});

test("every needs-you chat without an open native question gets a card", () => {
  const deck = buildDeck(
    sources({
      questions: [question()],
      inbox: [
        inbox({
          threadId: "thr_approval",
          state: "needs-you",
          reasonKind: "question",
          reasonText: "Allow command?",
        }),
        inbox({
          threadId: "thr_a",
          state: "needs-you",
          reasonKind: "question",
          reasonText: "Covered",
        }),
      ],
    }),
  );

  assert.deepEqual(
    deck.cards.map((card) => [card.kind, card.text]),
    [
      ["question", "Also build the Windows app?"],
      ["ask", "Allow command?"],
    ],
  );
});

test("duplicate questions keep their own cards and point at each other", () => {
  const first = question();
  const second = question({ id: "question_b", threadId: "thr_b", createdAt: 1_500 });

  const deck = buildDeck(
    sources({
      questions: [first, second],
      verdicts: new Map([
        [
          itemKey("question_b", 1),
          verdict(itemKey("question_b", 1), { duplicateOf: itemKey("question_a", 1) }),
        ],
      ]),
    }),
  );

  assert.equal(deck.cards.length, 2);
  assert.deepEqual(
    deck.cards.map((card) => card.alsoAsked.map((entry) => entry.title)),
    [["Another release"], ["Release scope"]],
  );
});

test("saved cards stay hidden until their time and are counted", () => {
  const deck = buildDeck(
    sources({
      questions: [question()],
      snoozedUntil: new Map([["question:question_a", 20_000]]),
    }),
  );

  assert.equal(deck.cards.length, 0);
  assert.equal(deck.saved, 1);
  assert.deepEqual(
    deck.savedCards.map(({ card, until }) => [card.key, until]),
    [["question:question_a", 20_000]],
  );
});

test("suggested replies show only when suggestions are on and never count; ready chats are left to Tidy", () => {
  const input = {
    inbox: [
      inbox({ threadId: "thr_r" }),
      inbox({ threadId: "thr_1", archiveReady: true, latch: "a" }),
    ],
    replies: new Map([["thr_r", "Ship it to staging"]]),
  };

  const on = buildDeck(sources(input));

  assert.equal(on.cards.length, 1);
  assert.equal(on.cards[0]?.suggestedReply, "Ship it to staging");
  assert.equal(on.toDecide, 0);
  assert.equal(on.dot, null);
  assert.equal(buildDeck(sources({ ...input, showReplies: false })).cards.length, 0);
});

test("rule offers sit at the end, never count and never light the dot", () => {
  const deck = buildDeck(
    sources({
      questions: [
        question({ id: "question_rule", threadId: "thr_chief" }),
        question({ id: "question_a", threadId: "thr_a", createdAt: 5 }),
      ],
      chats: new Map([
        ["thr_a", { title: "Release scope", project: "omnyo" }],
        ["thr_chief", { title: "Chief", project: "Personal" }],
      ]),
      offerQuestionIds: new Set(["question_rule"]),
    }),
  );

  assert.deepEqual(
    deck.cards.map((card) => [card.key, card.ruleOffer]),
    [
      ["question:question_a", false],
      ["question:question_rule", true],
    ],
  );
  assert.equal(deck.toDecide, 1);
  assert.equal(deck.dot, "attention");
});

test("a question the Chief chat asks the owner itself counts and lights the dot", () => {
  const deck = buildDeck(
    sources({
      questions: [
        question({ id: "question_rule", threadId: "thr_chief" }),
        question({ id: "question_release", threadId: "thr_chief", mode: "required", createdAt: 7 }),
      ],
      chats: new Map([["thr_chief", { title: "Chief", project: "Personal" }]]),
      offerQuestionIds: new Set(["question_rule"]),
    }),
  );

  assert.deepEqual(
    deck.cards.map((card) => [card.key, card.ruleOffer]),
    [
      ["question:question_release", false],
      ["question:question_rule", true],
    ],
  );
  assert.equal(deck.toDecide, 1);
  assert.equal(deck.dot, "attention");
});

test("the dot turns red for a failure and counts chats, not cards", () => {
  const deck = buildDeck(
    sources({
      questions: [question({ id: "q1" }), question({ id: "q2", createdAt: 99 })],
      inbox: [inbox({ threadId: "thr_f", reasonKind: "failure", state: "failed" })],
    }),
  );

  assert.equal(deck.dot, "failed");
  assert.equal(deck.toDecide, 2);
});
