import { z } from "zod";
import type { Verdict } from "./inputs.ts";

export type RuleLevel = "ask" | "veto" | "auto";

export const ruleChangeSchema = z.enum(["veto", "ask", "optional", "retire"]);

export type RuleChange = z.infer<typeof ruleChangeSchema>;

export const VETO_DELAY_MS = 10 * 60_000;

export const AUTO_PRECISION_FLOOR = 95;

export const AUTO_MATCH_FLOOR = 10;

export interface GuardRule {
  id: string;
  level: RuleLevel;
  required: boolean;
  ownerAdopted: boolean;
  state: "candidate" | "adopted" | "superseded" | "retired";
}

export interface GuardInput {
  coreSupportsDelegation: boolean;
  paused: boolean;
  question: {
    open: boolean;
    revision: number;
    delegable: boolean;
    mode: "required" | "optional";
  };
  triagedRevision: number;
  verdict: Verdict | null;
  rule: GuardRule | null;
  vetoElapsed: boolean;
}

export type GuardResult = { ok: true; level: "veto" | "auto" } | { ok: false; reason: string };

export function delegationGuard(input: GuardInput): GuardResult {
  const { question, verdict, rule } = input;

  if (!input.coreSupportsDelegation)
    return { ok: false, reason: "This Omnyo version cannot attribute delegated answers." };

  if (input.paused) return { ok: false, reason: "Delegation is paused." };

  if (!question.open) return { ok: false, reason: "The question is no longer open." };

  if (question.revision !== input.triagedRevision)
    return { ok: false, reason: "The question changed after it was triaged." };

  if (!question.delegable)
    return { ok: false, reason: "The asking chat did not mark this question as delegable." };

  if (verdict === null) return { ok: false, reason: "No triage verdict." };

  if (verdict.authorityLike)
    return { ok: false, reason: "The judge read this as approving an effect that needs you." };

  if (verdict.confidence !== "high") return { ok: false, reason: "The judge was not confident." };

  if (verdict.recommendation.length === 0) return { ok: false, reason: "No recommended answer." };

  if (rule === null || !verdict.ruleIds.includes(rule.id))
    return { ok: false, reason: "No adopted rule decides this question." };

  if (rule.state !== "adopted" || !rule.ownerAdopted)
    return { ok: false, reason: "The rule was not adopted by you." };

  if (rule.level === "ask") return { ok: false, reason: "The rule only recommends." };

  if (question.mode === "required" && !rule.required)
    return { ok: false, reason: "The rule may not answer required questions." };

  if (rule.level === "veto" && !input.vetoElapsed)
    return { ok: false, reason: "Waiting for the veto delay." };

  return { ok: true, level: rule.level };
}

export function autoAllowed(precision: number | null, matches: number): boolean {
  return precision !== null && precision >= AUTO_PRECISION_FLOOR && matches >= AUTO_MATCH_FLOOR;
}

export const delegatedStateSchema = z.enum([
  "waiting",
  "unconfirmed",
  "sent",
  "uncertain",
  "cancelled",
  "corrected",
]);

export type DelegatedState = z.infer<typeof delegatedStateSchema>;

const TRANSITIONS: Record<DelegatedState, readonly DelegatedState[]> = {
  waiting: ["unconfirmed", "cancelled"],
  unconfirmed: ["sent", "uncertain"],
  sent: ["corrected"],
  uncertain: [],
  cancelled: [],
  corrected: [],
};

export function canMove(from: DelegatedState, to: DelegatedState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function undoTarget(state: DelegatedState): DelegatedState | null {
  if (state === "waiting") return "cancelled";

  return state === "sent" ? "corrected" : null;
}
