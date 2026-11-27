import assert from "node:assert/strict";
import { test } from "node:test";
import type { Verdict } from "../lib/inputs.ts";
import { agentPolicy, rulePrecision, scorePolicy, type ScoredItem } from "../lib/metrics.ts";

const verdict = (
  key: string,
  recommendation: string[],
  overrides: Partial<Verdict> = {},
): Verdict => ({
  key,
  recommendation,
  reason: "Because.",
  confidence: "high",
  priority: "soon",
  authorityLike: false,
  duplicateOf: null,
  ruleIds: [],
  ...overrides,
});

const items: ScoredItem[] = [
  { key: "a", agentRecommended: ["x"], chosen: ["x"] },
  { key: "b", agentRecommended: ["x"], chosen: ["y"] },
  { key: "c", agentRecommended: [], chosen: ["y"] },
  { key: "d", agentRecommended: ["x"], chosen: [] },
];

test("the agent baseline scores only items where the agent recommended and the owner chose an option", () => {
  const score = scorePolicy(items, agentPolicy(items));

  assert.equal(score.freeTextOnly, 1);
  assert.equal(score.recommended, 2);
  assert.equal(score.matched, 1);
  assert.equal(score.matchRate, 50);
  assert.equal(score.coverage, 66.7);
  assert.equal(score.disagreement.count, 0);
});

test("disagreement counts which side matched the owner when the policy differs from the agent", () => {
  const verdicts = new Map([
    ["a", verdict("a", ["y"])],
    ["b", verdict("b", ["y"], { confidence: "low" })],
    ["c", verdict("c", ["y"], { confidence: "medium" })],
  ]);

  const score = scorePolicy(items, verdicts);

  assert.equal(score.recommended, 3);
  assert.equal(score.matched, 2);
  assert.deepEqual(score.disagreement, { count: 2, policyMatched: 1, agentMatched: 1 });
  assert.deepEqual(score.bands.low, { recommended: 1, matched: 1 });
  assert.deepEqual(score.bands.high, { recommended: 1, matched: 0 });
});

test("rule precision counts only items whose verdict cites the rule", () => {
  const verdicts = new Map([
    ["a", verdict("a", ["x"], { ruleIds: ["r1"] })],
    ["b", verdict("b", ["x"], { ruleIds: ["r1"] })],
    ["c", verdict("c", ["y"], { ruleIds: ["r2"] })],
    ["d", verdict("d", ["x"], { ruleIds: ["r1"] })],
  ]);

  assert.deepEqual(rulePrecision(items, verdicts, "r1"), { matches: 2, correct: 1, precision: 50 });
});
