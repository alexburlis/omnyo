import { z } from "zod";
import { optionSchema } from "./contract.ts";
import {
  BATCH_LIMIT,
  acceptVerdicts,
  distillPrompt,
  itemKey,
  judgePrompt,
  triageSubmissionSchema,
  type DistillSample,
  type JudgeItem,
  type DistillRule,
  type JudgeRule,
  type PriorOutcome,
  type Verdict,
} from "./inputs.ts";
import {
  agentPolicy,
  rulePrecision,
  scorePolicy,
  type PolicyScore,
  type ScoredItem,
} from "./metrics.ts";
import type { JudgeSubmission } from "./judge.ts";
import { proposalSubmissionSchema, type Proposal, type RelatedRule } from "./rules.ts";

export const answerEntrySchema = z.object({
  questionId: z.string().min(1),
  revision: z.number().int().positive(),
  threadId: z.string().min(1),
  chatTitle: z.string(),
  project: z.string(),
  mode: z.enum(["required", "optional"]),
  shortLabel: z.string(),
  prompt: z.string(),
  context: z.string().nullable(),
  multiSelect: z.boolean(),
  options: z.array(optionSchema),
  chosen: z.array(z.string()),
  freeText: z.string().nullable(),
  answeredBy: z.object({ kind: z.string() }).loose().nullable(),
  createdAt: z.number(),
});

export const datasetSchema = z.object({
  until: z.string().nullable(),
  questions: z.array(answerEntrySchema),
});

export type AnswerEntry = z.infer<typeof answerEntrySchema>;

export type Judge = (
  prompt: string,
  keys: string[],
  kind: "eval" | "distill",
) => Promise<JudgeSubmission>;

export function ownerAnswers(entries: readonly AnswerEntry[]): AnswerEntry[] {
  return entries.filter((entry) => entry.answeredBy === null || entry.answeredBy.kind === "owner");
}

export function localMidnight(day: string): number {
  return new Date(`${day}T00:00:00`).getTime();
}

export function toJudgeItem(entry: AnswerEntry): JudgeItem {
  return {
    key: itemKey(entry.questionId, entry.revision),
    threadId: entry.threadId,
    chatTitle: entry.chatTitle,
    project: entry.project,
    mode: entry.mode,
    shortLabel: entry.shortLabel,
    prompt: entry.prompt,
    context: entry.context,
    multiSelect: entry.multiSelect,
    options: entry.options,
    createdAt: entry.createdAt,
  };
}

const recommendedValues = (entry: AnswerEntry) =>
  entry.options.filter((option) => option.recommended).map((option) => option.value);

export function toPrior(entry: AnswerEntry): PriorOutcome {
  return {
    project: entry.project,
    shortLabel: entry.shortLabel,
    prompt: entry.prompt,
    agentRecommended: recommendedValues(entry),
    chosen: entry.chosen,
    freeText: entry.freeText,
    at: entry.createdAt,
  };
}

export function toScored(entry: AnswerEntry): ScoredItem {
  return {
    key: itemKey(entry.questionId, entry.revision),
    agentRecommended: recommendedValues(entry),
    chosen: entry.chosen,
  };
}

export function toSample(entry: AnswerEntry): DistillSample {
  const labelOf = (value: string) =>
    entry.options.find((option) => option.value === value)?.label ?? value;

  return {
    key: itemKey(entry.questionId, entry.revision),
    project: entry.project,
    label: entry.shortLabel,
    prompt: entry.prompt,
    options: entry.options.map((option) => option.label),
    agentRecommended: recommendedValues(entry).map(labelOf),
    chosen: entry.chosen.map(labelOf),
    freeText: entry.freeText,
  };
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );
}

export async function judgeAll(
  judge: Judge,
  test: readonly AnswerEntry[],
  priors: readonly PriorOutcome[],
  rules: readonly JudgeRule[],
  onBatch: (done: number) => void,
): Promise<{ verdicts: Map<string, Verdict>; failures: number }> {
  const verdicts = new Map<string, Verdict>();
  let failures = 0;
  let done = 0;

  for (const batch of chunks(test, BATCH_LIMIT)) {
    const items = batch.map(toJudgeItem);

    try {
      const submitted = triageSubmissionSchema.parse(
        await judge(
          judgePrompt(items, rules, priors),
          items.map((item) => item.key),
          "eval",
        ),
      );

      for (const [key, verdict] of acceptVerdicts(items, submitted.verdicts))
        verdicts.set(key, verdict);
    } catch {
      failures += 1;
    }

    done += batch.length;
    onBatch(done);
  }

  return { verdicts, failures };
}

export async function distill(
  judge: Judge,
  train: readonly AnswerEntry[],
  existing: readonly DistillRule[],
): Promise<Proposal[]> {
  const known = new Set(train.map((entry) => itemKey(entry.questionId, entry.revision)));

  const submitted = proposalSubmissionSchema.parse(
    await judge(distillPrompt(train.map(toSample), existing), [...known], "distill"),
  );

  return submitted.proposals.filter(
    (proposal) => proposal.evidence.length >= 2 && proposal.evidence.every((key) => known.has(key)),
  );
}

export interface ReplayReport {
  split: number;
  train: number;
  test: number;
  baseline: PolicyScore;
  plain: PolicyScore;
  ruled: PolicyScore;
  judgeFailures: number;
  rules: {
    cue: string;
    action: string;
    project: string | null;
    label: string | null;
    related: RelatedRule | null;
    matches: number;
    precision: number | null;
  }[];
}

export async function replay(
  judge: Judge,
  entries: readonly AnswerEntry[],
  split: number,
  progress: (stage: string, done: number, total: number) => void,
  options: { plain: boolean; existing: readonly DistillRule[] } = { plain: true, existing: [] },
): Promise<ReplayReport> {
  const owned = ownerAnswers(entries).toSorted((a, b) => a.createdAt - b.createdAt);
  const train = owned.filter((entry) => entry.createdAt < split);
  const test = owned.filter((entry) => entry.createdAt >= split);
  const priors = owned.map(toPrior);
  const scored = test.map(toScored);

  progress("plain", 0, test.length);

  const plain = options.plain
    ? await judgeAll(judge, test, priors, [], (done) => progress("plain", done, test.length))
    : { verdicts: new Map<string, Verdict>(), failures: 0 };

  progress("distill", 0, 1);
  let distillFailures = 0;
  let proposals: Proposal[] = [];

  if (train.length >= 2)
    try {
      proposals = await distill(judge, train, options.existing);
    } catch {
      distillFailures = 1;
    }

  const rules: JudgeRule[] = proposals.map((proposal, index) => ({
    id: `replay_${index + 1}`,
    cue: proposal.cue,
    action: proposal.action,
    scope: proposal.project === null ? "all projects" : `project ${proposal.project}`,
  }));

  progress("ruled", 0, test.length);

  const ruled = await judgeAll(judge, test, priors, rules, (done) =>
    progress("ruled", done, test.length),
  );

  return {
    split,
    train: train.length,
    test: test.length,
    baseline: scorePolicy(scored, agentPolicy(scored)),
    plain: scorePolicy(scored, plain.verdicts),
    ruled: scorePolicy(scored, ruled.verdicts),
    judgeFailures: plain.failures + ruled.failures + distillFailures,
    rules: proposals.map((proposal, index) => {
      const precision = rulePrecision(scored, ruled.verdicts, `replay_${index + 1}`);

      return {
        cue: proposal.cue,
        action: proposal.action,
        project: proposal.project,
        label: proposal.label,
        related: proposal.related,
        matches: precision.matches,
        precision: precision.precision,
      };
    }),
  };
}
