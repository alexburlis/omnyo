import type { Verdict } from "./inputs.ts";

export interface ScoredItem {
  key: string;
  agentRecommended: string[];
  chosen: string[];
}

export interface BandScore {
  recommended: number;
  matched: number;
}

export interface RulePrecision {
  matches: number;
  correct: number;
  precision: number | null;
}

export interface PolicyScore {
  items: number;
  freeTextOnly: number;
  recommended: number;
  matched: number;
  coverage: number | null;
  matchRate: number | null;
  bands: Record<Verdict["confidence"], BandScore>;
  disagreement: { count: number; policyMatched: number; agentMatched: number };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

const share = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 10;

export function agentPolicy(items: readonly ScoredItem[]): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();

  for (const item of items)
    if (item.agentRecommended.length > 0)
      verdicts.set(item.key, {
        key: item.key,
        recommendation: item.agentRecommended,
        reason: "The asking agent's recommended option.",
        confidence: "medium",
        priority: "soon",
        authorityLike: false,
        duplicateOf: null,
        ruleIds: [],
      });

  return verdicts;
}

export function scorePolicy(
  items: readonly ScoredItem[],
  verdicts: ReadonlyMap<string, Verdict>,
): PolicyScore {
  const bands: PolicyScore["bands"] = {
    high: { recommended: 0, matched: 0 },
    medium: { recommended: 0, matched: 0 },
    low: { recommended: 0, matched: 0 },
  };

  const disagreement = { count: 0, policyMatched: 0, agentMatched: 0 };
  let freeTextOnly = 0;
  let recommended = 0;
  let matched = 0;

  for (const item of items) {
    if (item.chosen.length === 0) {
      freeTextOnly += 1;
      continue;
    }

    const verdict = verdicts.get(item.key);

    if (verdict === undefined || verdict.recommendation.length === 0) continue;
    const hit = same(verdict.recommendation, item.chosen);
    recommended += 1;
    bands[verdict.confidence].recommended += 1;

    if (hit) {
      matched += 1;
      bands[verdict.confidence].matched += 1;
    }

    if (item.agentRecommended.length > 0 && !same(verdict.recommendation, item.agentRecommended)) {
      disagreement.count += 1;

      if (hit) disagreement.policyMatched += 1;

      if (same(item.agentRecommended, item.chosen)) disagreement.agentMatched += 1;
    }
  }

  const scorable = items.length - freeTextOnly;

  return {
    items: items.length,
    freeTextOnly,
    recommended,
    matched,
    coverage: share(recommended, scorable),
    matchRate: share(matched, recommended),
    bands,
    disagreement,
  };
}

export function rulePrecision(
  items: readonly ScoredItem[],
  verdicts: ReadonlyMap<string, Verdict>,
  ruleId: string,
): RulePrecision {
  let matches = 0;
  let correct = 0;

  for (const item of items) {
    const verdict = verdicts.get(item.key);

    if (verdict === undefined || !verdict.ruleIds.includes(ruleId) || item.chosen.length === 0)
      continue;
    matches += 1;

    if (same(verdict.recommendation, item.chosen)) correct += 1;
  }

  return { matches, correct, precision: share(correct, matches) };
}
