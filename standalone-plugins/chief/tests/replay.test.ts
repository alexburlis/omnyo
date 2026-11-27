import assert from "node:assert/strict";
import { test } from "node:test";
import { itemKey } from "../lib/inputs.ts";
import { datasetSchema, replay, type AnswerEntry, type Judge } from "../lib/replay.ts";

const entry = (index: number, overrides: Partial<AnswerEntry> = {}): AnswerEntry => ({
  questionId: `question_${index}`,
  revision: 1,
  threadId: `thr_${index}`,
  chatTitle: `Chat ${index}`,
  project: "omnyo",
  mode: "required",
  shortLabel: "Scope",
  prompt: "Also build the Windows app?",
  context: null,
  multiSelect: false,
  options: [
    { value: "no", label: "Server + web only", description: null, recommended: index % 2 === 0 },
    { value: "yes", label: "Build Windows", description: null, recommended: index % 2 === 1 },
  ],
  chosen: ["no"],
  freeText: null,
  answeredBy: null,
  createdAt: index * 1_000,
  ...overrides,
});

interface FakeJudge {
  judge: Judge;
  prompts: string[];
}

function fakeJudge(): FakeJudge {
  const prompts: string[] = [];

  const judge: Judge = async (prompt, keys, kind) => {
    prompts.push(prompt);

    if (kind === "distill")
      return {
        proposals: [
          {
            cue: "a release asks whether to also build native apps",
            action: "answer server and web only",
            project: null,
            evidence: keys.slice(0, 2),
            label: null,
            related: null,
          },
          {
            cue: "an invented pattern without evidence in the data",
            action: "do something",
            project: null,
            evidence: ["question_missing@1", "question_other@1"],
            label: null,
            related: null,
          },
        ],
      };

    const ruled = prompt.includes("replay_1");

    return {
      verdicts: keys.map((key) => ({
        key,
        recommendation: ["no"],
        reason: "Matches earlier answers.",
        confidence: "high",
        priority: "soon",
        authorityLike: false,
        duplicateOf: null,
        ruleIds: ruled ? ["replay_1"] : [],
      })),
    };
  };

  return { judge, prompts };
}

test("the dataset schema accepts the baseline export shape", () => {
  const parsed = datasetSchema.parse({ until: "2026-11-20T00:00:00", questions: [entry(1)] });

  assert.equal(parsed.questions.length, 1);
});

test("replay splits by time, scores three policies, drops unsupported rules and excludes delegated answers", async () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, index) => entry(index)),
    ...Array.from({ length: 12 }, (_, index) => entry(10 + index)),
    entry(30, { answeredBy: { kind: "plugin" } }),
  ];

  const { judge } = fakeJudge();
  const report = await replay(judge, entries, 10_000, () => {});

  assert.equal(report.train, 6);
  assert.equal(report.test, 12);
  assert.equal(report.baseline.recommended, 12);
  assert.equal(report.baseline.matched, 6);
  assert.equal(report.plain.matched, 12);
  assert.equal(report.ruled.matched, 12);
  assert.equal(report.rules.length, 1);
  assert.deepEqual(report.rules[0], {
    cue: "a release asks whether to also build native apps",
    action: "answer server and web only",
    project: null,
    label: null,
    related: null,
    matches: 12,
    precision: 100,
  });
});

test("a failing judge batch is counted and leaves its items without verdicts", async () => {
  const entries = Array.from({ length: 14 }, (_, index) => entry(index));
  let calls = 0;

  const judge: Judge = async (prompt, keys, kind) => {
    calls += 1;

    if (kind === "eval" && calls === 1) throw new Error("timeout");

    return fakeJudge().judge(prompt, keys, kind);
  };

  const report = await replay(judge, entries, 0, () => {});

  assert.equal(report.judgeFailures, 1);
  assert.equal(report.plain.recommended, 4);
  assert.equal(itemKey("question_0", 1), "question_0@1");
});

test("the daily rule check shows the judge existing and rejected rules, so a reworded one is not offered again", async () => {
  const existing = [
    {
      id: "rule_adopted",
      status: "rejected" as const,
      cue: "a release asks whether to also build native apps",
      action: "answer server and web only",
      scope: "all projects",
    },
  ];

  const prompts: string[] = [];

  const judge: Judge = async (prompt, keys, kind) => {
    prompts.push(prompt);

    if (kind !== "distill") return { verdicts: [] };
    const listed = prompt.includes("a release asks whether to also build native apps");

    return {
      proposals: listed
        ? []
        : [
            {
              cue: "a release offers to build the native apps too",
              action: "keep it to server and web",
              project: null,
              evidence: keys.slice(0, 2),
              label: null,
              related: null,
            },
          ],
    };
  };

  const entries = [entry(1), entry(2), entry(3), entry(4)];
  const report = await replay(judge, entries, 10_000, () => {}, { plain: false, existing });

  assert.deepEqual(report.rules, []);
  assert.ok(
    prompts.some((prompt) =>
      prompt.includes(
        '"existingRules":[{"id":"rule_adopted","status":"rejected","when":"a release asks',
      ),
    ),
  );
});
