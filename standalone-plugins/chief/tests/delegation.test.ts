import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoAllowed,
  canMove,
  delegationGuard,
  undoTarget,
  type GuardInput,
} from "../lib/delegation.ts";

const passing = (): GuardInput => ({
  coreSupportsDelegation: true,
  paused: false,
  question: { open: true, revision: 2, delegable: true, mode: "optional" },
  triagedRevision: 2,
  verdict: {
    key: "question_a@2",
    recommendation: ["b"],
    reason: "You chose B for this kind of choice before.",
    confidence: "high",
    priority: "soon",
    authorityLike: false,
    duplicateOf: null,
    ruleIds: ["rule_1"],
  },
  rule: { id: "rule_1", level: "auto", required: false, ownerAdopted: true, state: "adopted" },
  vetoElapsed: false,
});

test("an owner-adopted auto rule answers a delegable optional question", () => {
  assert.deepEqual(delegationGuard(passing()), { ok: true, level: "auto" });
});

const refusals: [string, (input: GuardInput) => void][] = [
  ["an older core", (input) => (input.coreSupportsDelegation = false)],
  ["a pause", (input) => (input.paused = true)],
  ["a closed question", (input) => (input.question.open = false)],
  ["a changed revision", (input) => (input.question.revision = 3)],
  ["an unmarked question", (input) => (input.question.delegable = false)],
  ["a missing verdict", (input) => (input.verdict = null)],
  ["an authority-like verdict", (input) => input.verdict && (input.verdict.authorityLike = true)],
  ["medium confidence", (input) => input.verdict && (input.verdict.confidence = "medium")],
  ["an empty recommendation", (input) => input.verdict && (input.verdict.recommendation = [])],
  [
    "a verdict citing another rule",
    (input) => input.verdict && (input.verdict.ruleIds = ["rule_2"]),
  ],
  ["a rule not adopted by the owner", (input) => input.rule && (input.rule.ownerAdopted = false)],
  ["a candidate rule", (input) => input.rule && (input.rule.state = "candidate")],
  ["an ask-level rule", (input) => input.rule && (input.rule.level = "ask")],
  ["a required question without the required flag", (input) => (input.question.mode = "required")],
  ["a veto rule before its delay", (input) => input.rule && (input.rule.level = "veto")],
];

for (const [name, mutate] of refusals)
  test(`delegation is refused for ${name}`, () => {
    const input = passing();

    mutate(input);
    const result = delegationGuard(input);

    assert.equal(result.ok, false);
  });

test("a veto rule answers once its delay has passed", () => {
  const input = passing();

  if (input.rule) input.rule.level = "veto";
  input.vetoElapsed = true;
  assert.deepEqual(delegationGuard(input), { ok: true, level: "veto" });
});

test("a required question needs a rule with the required flag", () => {
  const input = passing();

  input.question.mode = "required";

  if (input.rule) input.rule.required = true;
  assert.equal(delegationGuard(input).ok, true);
});

test("auto adoption needs at least 95% precision over at least 10 matches", () => {
  assert.equal(autoAllowed(96, 10), true);
  assert.equal(autoAllowed(94.9, 50), false);
  assert.equal(autoAllowed(100, 9), false);
  assert.equal(autoAllowed(null, 20), false);
});

test("undo cancels before delivery and corrects after it, never retrying an uncertain send", () => {
  assert.equal(undoTarget("waiting"), "cancelled");
  assert.equal(undoTarget("sent"), "corrected");
  assert.equal(undoTarget("uncertain"), null);
  assert.equal(canMove("unconfirmed", "sent"), true);
  assert.equal(canMove("uncertain", "unconfirmed"), false);
  assert.equal(canMove("cancelled", "unconfirmed"), false);
});
