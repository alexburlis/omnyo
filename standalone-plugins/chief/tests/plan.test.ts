import assert from "node:assert/strict";
import { test } from "node:test";
import { itemKey } from "../lib/inputs.ts";
import { planRuleAnswer, untriaged } from "../lib/plan.ts";
import type { QuestionPayload } from "../lib/sources.ts";

const payload = (overrides: Partial<QuestionPayload> = {}): QuestionPayload => ({
  id: "question_a",
  threadId: "thr_a",
  revision: 1,
  state: "open",
  question: {
    prompt: "Adopt this rule?",
    context: null,
    shortLabel: "Rule?",
    mode: "optional",
    multiSelect: false,
    allowFreeText: false,
    options: [],
  },
  answer: null,
  createdAt: 1_000,
  ...overrides,
});

test("triage takes the oldest untriaged questions, at most ten, never the Chief's offers", () => {
  const open = [
    ...Array.from({ length: 12 }, (_, index) =>
      payload({ id: `question_${index}`, createdAt: 2_000 - index }),
    ),
    payload({ id: "question_offer", threadId: "thr_chief", createdAt: 1 }),
  ];

  const known = new Set([itemKey("question_11", 1)]);
  const picked = untriaged(open, known, new Set(["question_offer"]));

  assert.equal(picked.length, 10);
  assert.equal(picked[0]?.id, "question_10");
  assert.equal(
    picked.some((question) => question.id === "question_offer" || question.id === "question_11"),
    false,
  );
});

test("a question the Chief chat asks the owner itself is triaged like any other", () => {
  const picked = untriaged(
    [payload({ id: "question_release", threadId: "thr_chief" })],
    new Set(),
    new Set(["question_offer"]),
  );

  assert.deepEqual(
    picked.map((question) => question.id),
    ["question_release"],
  );
});

test("an updated question is triaged again under its new revision", () => {
  const known = new Set([itemKey("question_a", 1)]);

  assert.equal(untriaged([payload({ revision: 2 })], known, new Set()).length, 1);
  assert.equal(untriaged([payload({ revision: 1 })], known, new Set()).length, 0);
});

test("rule answers wait while open, unbind when closed without a usable answer, and apply otherwise", () => {
  assert.deepEqual(planRuleAnswer(undefined), { kind: "wait" });
  assert.deepEqual(planRuleAnswer(payload()), { kind: "wait" });
  assert.deepEqual(planRuleAnswer(payload({ state: "skipped" })), { kind: "unbind" });
  assert.deepEqual(
    planRuleAnswer(payload({ state: "answered", answer: { selected: ["maybe"] } })),
    { kind: "unbind" },
  );
  assert.deepEqual(
    planRuleAnswer(
      payload({
        state: "answered",
        revision: 3,
        answer: { selected: ["auto"] },
        answeredBy: { kind: "owner" },
      }),
    ),
    {
      kind: "apply",
      choice: "auto",
      revision: 3,
      ownerAttributed: true,
      coreSupportsAttribution: true,
    },
  );
});

test("rule answers carry the required-question and review choices", () => {
  for (const choice of ["veto-required", "auto-required", "keep"] as const)
    assert.deepEqual(
      planRuleAnswer(
        payload({ state: "answered", answer: { selected: [choice] }, answeredBy: { kind: "owner" } }),
      ),
      { kind: "apply", choice, revision: 1, ownerAttributed: true, coreSupportsAttribution: true },
    );
});

test("on an older core the answerer is unknown, so adoption is treated as unattributed", () => {
  assert.deepEqual(planRuleAnswer(payload({ state: "answered", answer: { selected: ["veto"] } })), {
    kind: "apply",
    choice: "veto",
    revision: 1,
    ownerAttributed: false,
    coreSupportsAttribution: false,
  });
});
