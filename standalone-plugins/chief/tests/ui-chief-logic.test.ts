import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeckCardView, OpenQuestion, SidebarStatus, ThreadDelegation } from "../lib/contract.ts";
import type { Verdict } from "../lib/inputs.ts";
import {
  ERROR_TOOLTIP,
  PAUSED_TOOLTIP,
  ageLabel,
  cardRow,
  companionView,
  confidenceWord,
  decidedState,
  emptyKind,
  kindLabel,
  levelLine,
  lowestConfidence,
  offerText,
  projectChips,
  questionFromPath,
  ruleLowerings,
  ruleText,
  rowStatus,
  sectionFor,
  showSwipeHint,
  stepNote,
  tabFromPath,
  usageText,
  visibleCards,
  visibleTabs,
  type CompanionInput,
} from "../components/chief-logic.ts";

const status = (overrides: Partial<SidebarStatus> = {}): SidebarStatus => ({
  dot: null,
  toDecide: 0,
  saved: 0,
  paused: false,
  error: false,
  ...overrides,
});

const question = (overrides: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: "q1",
  threadId: "thr_a",
  revision: 1,
  mode: "optional",
  shortLabel: "Tests",
  prompt: "Which tests?",
  context: null,
  multiSelect: false,
  allowFreeText: false,
  delegable: true,
  options: [
    { value: "focused", label: "Focused tests", description: null, recommended: false },
    { value: "full", label: "Full suite", description: null, recommended: true },
  ],
  createdAt: 1,
  ...overrides,
});

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  key: "q1@1",
  recommendation: ["focused"],
  reason: "Only one file changed.",
  confidence: "high",
  priority: "now",
  authorityLike: false,
  duplicateOf: null,
  ruleIds: [],
  ...overrides,
});

const card = (overrides: Partial<DeckCardView> = {}): DeckCardView => ({
  key: "question:q1",
  kind: "question",
  threadId: "thr_a",
  title: "Fix login bug",
  project: "omnyo",
  text: "Which tests?",
  steps: [{ question: question(), key: "q1@1", verdict: verdict(), triageError: null }],
  required: false,
  priority: "now",
  suggestedReply: null,
  ruleOffer: false,
  latch: null,
  alsoAsked: [],
  since: 1,
  ...overrides,
});

test("the row shows a dot and counts only in its tooltip", () => {
  assert.deepEqual(rowStatus({ kind: "loaded", status: status() }), {
    dot: null,
    tooltip: null,
    state: null,
  });
  assert.deepEqual(
    rowStatus({ kind: "loaded", status: status({ dot: "attention", toDecide: 3, saved: 1 }) }),
    { dot: "attention", tooltip: "3 to decide · 1 saved for later", state: null },
  );
  assert.equal(
    rowStatus({ kind: "loaded", status: status({ dot: "failed", toDecide: 2 }) }).tooltip,
    "2 to decide",
  );
  assert.equal(rowStatus({ kind: "loaded", status: status({ saved: 4 }) }).tooltip, null);
});

test("the row reports paused and error states", () => {
  assert.deepEqual(
    rowStatus({ kind: "loaded", status: status({ paused: true, toDecide: 1, dot: "attention" }) }),
    { dot: "attention", tooltip: `1 to decide · ${PAUSED_TOOLTIP}`, state: "paused" },
  );

  const failed = { dot: null, tooltip: ERROR_TOOLTIP, state: "error" };

  assert.deepEqual(rowStatus({ kind: "failed" }), failed);
  assert.deepEqual(
    rowStatus({ kind: "loaded", status: status({ error: true, dot: "attention", toDecide: 2 }) }),
    failed,
  );
});

test("confidence maps one to one onto plain words", () => {
  assert.equal(confidenceWord("high"), "Sure");
  assert.equal(confidenceWord("medium"), "Fairly sure");
  assert.equal(confidenceWord("low"), "Unsure");
  assert.equal(
    lowestConfidence([verdict(), verdict({ confidence: "low" }), verdict({ confidence: "medium" })]),
    "low",
  );
  assert.equal(lowestConfidence([]), null);
});

test("card kinds use the new names", () => {
  assert.equal(kindLabel(card()), "Question");
  assert.equal(kindLabel(card({ kind: "ask" })), "Needs you");
  assert.equal(kindLabel(card({ kind: "problem" })), "Failed");
  assert.equal(kindLabel(card({ kind: "result" })), "Suggested reply");
  assert.equal(kindLabel(card({ ruleOffer: true })), "Make this a rule?");

  const review = question({
    shortLabel: "1Password",
    options: [
      { value: "keep", label: "Keep", description: null, recommended: false },
      { value: "reject", label: "Retire", description: null, recommended: false },
    ],
  });

  assert.equal(
    kindLabel(
      card({
        ruleOffer: true,
        steps: [{ question: review, key: "q1@1", verdict: null, triageError: null }],
      }),
    ),
    "Keep this rule?",
  );
});

test("decisions, standing rules and drafted replies are shown in different views", () => {
  assert.equal(sectionFor(card()), "decide");
  assert.equal(sectionFor(card({ kind: "ask" })), "decide");
  assert.equal(sectionFor(card({ ruleOffer: true })), "rules");
  assert.equal(sectionFor(card({ kind: "result" })), "replies");
  assert.equal(tabFromPath("replies"), "replies");
  assert.equal(tabFromPath("saved"), "saved");
  assert.equal(tabFromPath("question/question_example"), "decide");
  assert.equal(questionFromPath("question/question_example"), "question_example");
});

test("suggestions off hides every Chief pick and suggested reply", () => {
  const cards = [card(), card({ key: "result:a", kind: "result", suggestedReply: "Ship it" })];
  const off = visibleCards(cards, "off", null);

  assert.equal(off.length, 1);
  assert.equal(off[0]?.steps[0]?.verdict, null);
  assert.equal(visibleCards(cards, "on", null).length, 2);
});

test("project chips appear only when non-rule cards span two projects", () => {
  assert.deepEqual(projectChips([card(), card({ project: "omnyo" })]), []);
  assert.deepEqual(projectChips([card(), card({ project: "Personal", ruleOffer: true })]), []);
  assert.deepEqual(projectChips([card(), card({ project: "Orbit" })]), ["Orbit", "omnyo"]);
  assert.deepEqual(
    visibleCards([card(), card({ key: "b", project: "Orbit" }), card({ key: "r", ruleOffer: true })], "on", "Orbit").map(
      (item) => item.key,
    ),
    ["b", "r"],
  );
});

test("a step says reading, no suggestion or shows the suggestion only when suggestions are on", () => {
  const step = card().steps[0];

  assert.ok(step !== undefined);
  assert.equal(stepNote(step, "off").kind, "hidden");
  assert.equal(stepNote(step, "undecided").kind, "hidden");
  assert.equal(stepNote(step, "on").kind, "verdict");
  assert.equal(stepNote({ ...step, verdict: null }, "on").kind, "reading");
  assert.deepEqual(stepNote({ ...step, verdict: null, triageError: "Timed out" }, "on"), {
    kind: "none",
    reason: "Timed out",
  });
});

test("the offer names the agent account it uses", () => {
  assert.equal(
    offerText("Claude Code"),
    "Use your Claude Code account to read chat context and suggest answers across all projects.",
  );
});

test("the empty stack is a first run only before anything has happened", () => {
  const fresh = {
    suggestions: "undecided" as const,
    saved: 0,
    archiveReady: 0,
    tabs: { rules: false, decided: false },
  };

  assert.equal(emptyKind(fresh, false), "first-run");
  assert.equal(emptyKind(fresh, true), "caught-up");
  assert.equal(emptyKind({ ...fresh, suggestions: "off" }, false), "caught-up");
  assert.equal(emptyKind({ ...fresh, saved: 2 }, false), "caught-up");
});

test("the swipe hint shows once, with suggestions on and two cards", () => {
  assert.equal(showSwipeHint({ swipeHintSeen: false, suggestions: "on" }, 2), true);
  assert.equal(showSwipeHint({ swipeHintSeen: true, suggestions: "on" }, 2), false);
  assert.equal(showSwipeHint({ swipeHintSeen: false, suggestions: "off" }, 3), false);
  assert.equal(showSwipeHint({ swipeHintSeen: false, suggestions: "on" }, 1), false);
});

test("rules read in plain words and offer only lowering actions", () => {
  const rule = {
    scope: "omnyo",
    cue: "a chat asks which tests to run",
    action: "run the focused tests",
    level: "veto" as const,
    required: true,
    state: "adopted" as const,
  };

  assert.equal(
    ruleText(rule),
    "In omnyo · When a chat asks which tests to run, run the focused tests",
  );
  assert.equal(ruleText({ ...rule, scope: "All projects" }).startsWith("In all projects · "), true);
  assert.equal(
    levelLine(rule),
    "Chats follow it. The Chief answers optional and required questions after 10 minutes unless you stop it.",
  );
  assert.equal(levelLine({ ...rule, level: "ask" }), "Chats follow it. The Chief only suggests.");
  assert.equal(levelLine({ ...rule, state: "retired" }), "Retired. Chats no longer follow it.");
  assert.deepEqual(ruleLowerings(rule), ["optional", "ask", "retire"]);
  assert.deepEqual(ruleLowerings({ ...rule, required: false }), ["ask", "retire"]);
  assert.deepEqual(ruleLowerings({ ...rule, level: "ask", required: false }), ["retire"]);
  assert.deepEqual(ruleLowerings({ ...rule, state: "retired" }), []);
  assert.equal(usageText(0), "Not used yet");
  assert.equal(usageText(1), "Used once");
  assert.equal(usageText(5), "Used 5 times");
});

test("answers given for the owner read as plain states with their action", () => {
  assert.deepEqual(decidedState("waiting", 9 * 60_000, 0), {
    text: "Sends in 9 min",
    action: "cancel",
    actionLabel: "Cancel",
  });
  assert.equal(decidedState("unconfirmed", 0, 0).text, "Sending…");
  assert.equal(decidedState("sent", 0, 0).actionLabel, "Undo");
  assert.equal(decidedState("uncertain", 0, 0).action, "open");
  assert.equal(decidedState("cancelled", 0, 0).action, null);
});

test("the queue and assistant have separate navigation, and old links still open", () => {
  const populated = {
    tabs: { rules: true, decided: true },
    cards: [card({ kind: "result", suggestedReply: "Draft" })],
    savedCards: [{ card: card(), until: 1 }],
  };

  assert.deepEqual(visibleTabs(null, "decide"), ["decide"]);
  assert.deepEqual(visibleTabs(null, "talk"), ["talk", "rules"]);
  assert.deepEqual(visibleTabs(populated, "decide"), ["decide", "saved", "replies"]);
  assert.deepEqual(visibleTabs(populated, "rules"), ["talk", "rules", "decided"]);
  assert.equal(tabFromPath("decided"), "decided");
});

const delegation = (overrides: Partial<ThreadDelegation> = {}): ThreadDelegation => ({
  id: "d1",
  questionId: "q1",
  answer: ["Focused tests"],
  cue: "Focused tests",
  state: "waiting",
  sendAt: 9 * 60_000,
  updatedAt: 0,
  ...overrides,
});

const input = (overrides: Partial<CompanionInput> = {}): CompanionInput => ({
  suggestions: "on",
  agentReady: true,
  paused: false,
  delegations: [],
  steps: [
    {
      verdict: verdict(),
      failed: false,
      labels: ["Focused tests"],
      selected: ["focused"],
      questionId: "q1",
      revision: 1,
    },
  ],
  now: 0,
  ...overrides,
});

test("the chat card shows only while a question is open and suggestions are on or undecided", () => {
  assert.equal(companionView(input({ steps: [] })).kind, "hidden");
  assert.equal(companionView(input({ suggestions: "off" })).kind, "hidden");
  assert.equal(companionView(input({ suggestions: "undecided" })).kind, "offer");
  assert.equal(companionView(input({ suggestions: "undecided", agentReady: false })).kind, "no-agent");

  const reading = input().steps.map((step) => ({ ...step, verdict: null, labels: [], selected: [] }));

  assert.equal(companionView(input({ steps: reading })).kind, "reading");
  assert.deepEqual(companionView(input()), {
    kind: "suggests",
    labels: ["Focused tests"],
    reason: "Only one file changed.",
    confidence: "Sure",
    usable: true,
  });

  const noFit = input().steps.map((step) => ({ ...step, labels: [], selected: [] }));

  assert.equal(companionView(input({ steps: noFit })).kind, "hidden");
});

test("the chat companion sends policy decisions to review", () => {
  const [step] = input().steps;

  const review = companionView(
    input({ steps: [{ ...step, verdict: verdict({ authorityLike: true }) }] }),
  );

  assert.equal(review.kind === "suggests" && review.usable, false);
});

test("the chat card counts down, then shows the answer for ten minutes, unless paused", () => {
  const waiting = companionView(input({ delegations: [delegation()] }));

  assert.equal(waiting.kind, "countdown");
  assert.equal(waiting.kind === "countdown" ? waiting.minutes : 0, 9);
  assert.equal(companionView(input({ paused: true, delegations: [delegation()] })).kind, "suggests");

  const sent = delegation({ state: "sent", updatedAt: 0 });

  assert.equal(companionView(input({ steps: [], delegations: [sent], now: 60_000 })).kind, "answered");
  assert.equal(
    companionView(input({ steps: [], delegations: [sent], now: 10 * 60_000 + 1 })).kind,
    "hidden",
  );
});

test("the in-chat card hides when no suggestion came back and reads while one is pending", () => {
  const step = { verdict: null, failed: true, labels: [], selected: [], questionId: "q1", revision: 1 };

  assert.equal(companionView(input({ steps: [step] })).kind, "hidden");
  assert.equal(companionView(input({ steps: [{ ...step, failed: false }] })).kind, "reading");
});

test("a row ages in minutes, hours, days and then weeks", () => {
  const now = 100 * 24 * 60 * 60_000;
  const ago = (ms: number) => ageLabel(now - ms, now);

  assert.equal(ago(30_000), "now");
  assert.equal(ago(-5_000), "now");
  assert.equal(ago(5 * 60_000), "5m");
  assert.equal(ago(3 * 60 * 60_000), "3h");
  assert.equal(ago(2 * 24 * 60 * 60_000), "2d");
  assert.equal(ago(15 * 24 * 60 * 60_000), "2w");
});

test("a question row names what is asked, then the prompt and where it came from", () => {
  assert.deepEqual(cardRow(card(), undefined), {
    title: "Tests",
    preview: "Which tests?",
    context: "Fix login bug · omnyo",
  });

  const unlabelled = card({
    steps: [
      {
        question: question({ shortLabel: " ", context: "Two files changed." }),
        key: "q1@1",
        verdict: null,
        triageError: null,
      },
    ],
  });

  assert.deepEqual(cardRow(unlabelled, undefined), {
    title: "Which tests?",
    preview: "Two files changed.",
    context: "Fix login bug · omnyo",
  });
  assert.equal(cardRow(card({ title: "Personal", project: "Personal" }), undefined).context, "Personal");
});

test("rule rows use the review topic and scope; other cards show their text", () => {
  assert.deepEqual(cardRow(card({ ruleOffer: true }), { topic: "Land on main first", scope: "In omnyo" }), {
    title: "Land on main first",
    preview: "Which tests?",
    context: "In omnyo",
  });
  assert.deepEqual(cardRow(card({ kind: "problem", steps: [], text: "The turn failed." }), undefined), {
    title: "Fix login bug",
    preview: "The turn failed.",
    context: "omnyo",
  });
  assert.deepEqual(
    cardRow(card({ kind: "result", steps: [], text: "Done.", suggestedReply: "Ship it" }), undefined),
    { title: "Fix login bug", preview: "Ship it", context: "omnyo" },
  );
  assert.equal(cardRow(card({ kind: "ask", steps: [], text: " ", project: "" }), undefined).context, null);
});
