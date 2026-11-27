import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTRUCTION_LIMIT,
  REVIEW_AFTER_MS,
  Rules,
  sameRule,
  type AdoptionAnswer,
} from "../lib/rules.ts";
import { memorySql } from "./sql.ts";

function ledger(): Rules {
  return new Rules(memorySql());
}

const proposal = (
  overrides: Partial<{ cue: string; action: string; project: string | null }> = {},
) => ({
  cue: "a release asks whether to also build native apps",
  action: "answer server and web only",
  project: null,
  evidence: ["question_a", "question_b"],
  label: null,
  related: null,
  ...overrides,
});

const owner = (overrides: Partial<AdoptionAnswer> = {}): AdoptionAnswer => ({
  questionRevision: 1,
  choice: "auto",
  ownerAttributed: true,
  coreSupportsAttribution: true,
  precision: 97,
  replayMatches: 12,
  ...overrides,
});

test("duplicate rule detection preserves material changes and overlapping scopes", () => {
  const adopted = { ...proposal(), state: "adopted" as const };

  assert.equal(
    sameRule(
      adopted,
      proposal({ cue: "A release asks whether to also build native apps.", project: "omnyo" }),
    ),
    true,
  );
  assert.equal(sameRule(adopted, proposal({ action: "answer server, web and macOS" })), false);
  assert.equal(sameRule({ ...adopted, project: "omnyo" }, proposal()), false);
  assert.equal(sameRule({ ...adopted, state: "candidate" }, proposal({ project: "omnyo" })), false);
});

test("anything told to the Chief starts as a candidate that grants nothing", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "told", 1);

  assert.equal(rule.state, "candidate");
  assert.equal(rule.level, "ask");
  assert.equal(rule.ownerAdopted, false);
  assert.deepEqual(rules.forTriage("omnyo"), []);
});

test("an owner answer at the bound revision adopts the rule at the chosen level", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "learned", 1);

  rules.bindQuestion(rule.id, "question_rule", 1, 2);
  const result = rules.applyAnswer(rule.id, owner(), 3);

  assert.equal(result.applied, true);
  assert.equal(result.applied && result.rule.level, "auto");
  assert.equal(result.applied && result.rule.ownerAdopted, true);
});

test("an answer to a question rewritten after the plugin opened it is discarded", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "learned", 1);

  rules.bindQuestion(rule.id, "question_rule", 1, 2);
  assert.deepEqual(rules.applyAnswer(rule.id, owner({ questionRevision: 2 }), 3), {
    applied: false,
    reason: "changed",
  });
  assert.equal(rules.get(rule.id)?.state, "candidate");
});

test("a non-owner answer cannot adopt once core records who answered", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "learned", 1);

  rules.bindQuestion(rule.id, "question_rule", 1, 2);
  assert.deepEqual(rules.applyAnswer(rule.id, owner({ ownerAttributed: false }), 3), {
    applied: false,
    reason: "not-owner",
  });
});

test("before core attribution exists adoption is limited to recommending and stays out of chat instructions", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "learned", 1);

  rules.bindQuestion(rule.id, "question_rule", 1, 2);

  const result = rules.applyAnswer(
    rule.id,
    owner({ coreSupportsAttribution: false, ownerAttributed: false }),
    3,
  );

  assert.equal(result.applied && result.rule.level, "ask");
  assert.equal(rules.instructionBlock("omnyo"), null);
  assert.equal(rules.forTriage("omnyo").length, 1);
});

test("auto is clamped to veto when replay precision misses the gate", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "learned", 1);

  rules.bindQuestion(rule.id, "question_rule", 1, 2);
  const result = rules.applyAnswer(rule.id, owner({ precision: 90 }), 3);

  assert.equal(result.applied && result.rule.level, "veto");
});

test("edits supersede earlier versions and an override demotes auto to veto", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "learned", 1);

  rules.bindQuestion(rule.id, "question_rule", 1, 2);
  rules.applyAnswer(rule.id, owner(), 3);
  const demoted = rules.recordOverride(rule.id, 4);
  const history = rules.history(rule.id);

  assert.equal(demoted?.level, "veto");
  assert.deepEqual(
    history.map((entry) => [entry.version, entry.state, entry.level]),
    [
      [1, "superseded", "ask"],
      [2, "superseded", "auto"],
      [3, "adopted", "veto"],
    ],
  );
});

test("rules overridden twice or unmatched for thirty days come back for review", () => {
  const rules = ledger();
  const stale = rules.propose(proposal(), "learned", 0);

  const busy = rules.propose(
    proposal({ cue: "a chat asks which package manager to use" }),
    "learned",
    0,
  );

  for (const rule of [stale, busy]) {
    rules.bindQuestion(rule.id, `question_${rule.id}`, 1, 0);
    rules.applyAnswer(rule.id, owner({ choice: "ask" }), 0);
  }

  rules.recordMatch(busy.id, REVIEW_AFTER_MS);
  rules.recordOverride(busy.id, REVIEW_AFTER_MS);
  rules.recordOverride(busy.id, REVIEW_AFTER_MS);
  const review = rules.needingReview(REVIEW_AFTER_MS + 1).map((rule) => rule.id);

  assert.deepEqual(review.toSorted(), [busy.id, stale.id].toSorted());
});

test("a rule answers required questions only when the owner chose that, and never before attribution", () => {
  const rules = ledger();

  const adopt = (cue: string, answer: Partial<AdoptionAnswer>) => {
    const rule = rules.propose(proposal({ cue }), "learned", 1);

    rules.bindQuestion(rule.id, `question_${rule.id}`, 1, 2);
    const result = rules.applyAnswer(rule.id, owner(answer), 3);

    return result.applied ? [result.rule.level, result.rule.required] : result.reason;
  };

  assert.deepEqual(adopt("a chat asks which test runner to use", { choice: "veto" }), [
    "veto",
    false,
  ]);
  assert.deepEqual(adopt("a chat asks which package manager to use", { choice: "veto-required" }), [
    "veto",
    true,
  ]);
  assert.deepEqual(
    adopt("a chat asks whether to add a changelog entry", {
      choice: "auto-required",
      precision: 80,
    }),
    ["veto", true],
  );
  assert.deepEqual(
    adopt("a chat asks whether to squash its commits", {
      choice: "auto-required",
      ownerAttributed: false,
      coreSupportsAttribution: false,
    }),
    ["ask", false],
  );
  assert.equal(adopt("a chat asks which icon set to use", { choice: "keep" }), "unknown");
});

test("lowering and retiring only ever reduce what an adopted rule may do", () => {
  const rules = ledger();
  const rule = rules.propose(proposal(), "learned", 1);

  rules.bindQuestion(rule.id, "question_rule", 1, 2);
  rules.applyAnswer(rule.id, owner({ choice: "auto-required" }), 3);

  assert.deepEqual(
    [rules.reduce(rule.id, "optional", 4)].map((next) => [next.level, next.required]),
    [["auto", false]],
  );
  assert.equal(rules.reduce(rule.id, "veto", 5).level, "veto");
  assert.equal(rules.reduce(rule.id, "ask", 6).level, "ask");

  const unchanged = rules.reduce(rule.id, "veto", 7);

  assert.equal(unchanged.level, "ask");
  assert.equal(rules.reduce(rule.id, "retire", 8).state, "retired");
  assert.throws(() => rules.reduce(rule.id, "ask", 9), /retired/);

  const candidate = rules.propose(
    proposal({ cue: "a chat asks which package manager to use" }),
    "learned",
    1,
  );

  assert.throws(() => rules.reduce(candidate.id, "retire", 2), /Rule\? question/);
});

test("answering or dismissing a review question settles it until new evidence arrives", () => {
  const rules = ledger();

  const [kept, lowered, dismissed] = ["test runner", "package manager", "icon set"].map((topic) => {
    const rule = rules.propose(proposal({ cue: `a chat asks which ${topic} to use` }), "learned", 0);

    rules.bindQuestion(rule.id, `question_${rule.id}`, 1, 0);
    rules.applyAnswer(rule.id, owner({ choice: "veto-required" }), 0);
    rules.recordOverride(rule.id, 0);
    rules.recordOverride(rule.id, 0);

    return rule.id;
  });

  const now = REVIEW_AFTER_MS / 2;
  const due = [kept, lowered, dismissed].toSorted();

  assert.deepEqual(
    rules
      .needingReview(now)
      .map((rule) => rule.id)
      .toSorted(),
    due,
  );

  for (const id of due) rules.bindQuestion(id, `review_${id}`, 1, now);
  assert.deepEqual(rules.needingReview(now), []);

  rules.applyAnswer(kept, owner({ choice: "keep" }), now);
  rules.applyAnswer(lowered, owner({ choice: "ask" }), now);
  rules.settleUnanswered(dismissed, now);

  assert.deepEqual(rules.needingReview(now + 1), []);
  assert.deepEqual(
    [kept, lowered, dismissed].map((id) => {
      const rule = rules.get(id);

      return [rule?.level, rule?.required, rule?.overrides];
    }),
    [
      ["veto", true, 0],
      ["ask", false, 0],
      ["veto", true, 0],
    ],
  );
  assert.equal(rules.needingReview(now + REVIEW_AFTER_MS + 1).length, 3);
});

test("the instruction block lists owner-adopted rules, project rules first, within the size limit", () => {
  const rules = ledger();
  const global = rules.propose(proposal(), "learned", 1);

  const local = rules.propose(
    proposal({
      cue: "an Acme chat asks about radius",
      action: "keep the tokens",
      project: "acme",
    }),
    "learned",
    2,
  );

  const other = rules.propose(
    proposal({ cue: "a Nimbus chat asks", action: "do X", project: "nimbus" }),
    "learned",
    3,
  );

  for (const rule of [global, local, other]) {
    rules.bindQuestion(rule.id, `question_${rule.id}`, 1, 4);
    rules.applyAnswer(rule.id, owner({ choice: "ask" }), 5);
  }

  for (let index = 0; index < 30; index += 1) {
    const filler = rules.propose(
      proposal({ cue: `filler rule number ${index} with words` }),
      "learned",
      6,
    );

    rules.bindQuestion(filler.id, `question_filler_${index}`, 1, 6);
    rules.applyAnswer(filler.id, owner({ choice: "ask" }), 6);
  }

  const block = rules.instructionBlock("acme") ?? "";
  const lines = block.split("\n").slice(1);

  assert.ok(block.length <= INSTRUCTION_LIMIT);
  assert.match(lines[0] ?? "", /Acme chat asks about radius/);
  assert.doesNotMatch(block, /Nimbus/);
  assert.match(block, /never authorize/);
});

test("the daily rule check sees adopted, offered and rejected rules, labeled by status", () => {
  const rules = ledger();
  const adopted = rules.propose(proposal({ project: "omnyo" }), "learned", 1);

  rules.bindQuestion(adopted.id, "question_rule", 1, 2);
  rules.applyAnswer(adopted.id, owner({ choice: "ask" }), 3);

  const offered = rules.propose(proposal({ cue: "a chat asks which tests to run" }), "told", 4);
  const retired = rules.propose(proposal({ cue: "a chat asks to reformat files" }), "learned", 5);

  rules.bindQuestion(retired.id, "question_retired", 1, 6);
  rules.applyAnswer(retired.id, owner({ choice: "ask" }), 7);
  rules.reduce(retired.id, "retire", 8);

  assert.deepEqual(
    rules
      .forDistill()
      .map((rule) => [rule.id, rule.status, rule.scope])
      .toSorted(),
    [
      [adopted.id, "adopted", "project omnyo"],
      [offered.id, "offered", "all projects"],
      [retired.id, "rejected", "all projects"],
    ].toSorted(),
  );
});
