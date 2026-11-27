import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, stringList, type Sql, type SqlRow } from "./db.ts";
import { autoAllowed, type RuleChange, type RuleLevel } from "./delegation.ts";
import type { DistillRule, JudgeRule } from "./inputs.ts";

export const INSTRUCTION_LIMIT = 1_200;

export const REVIEW_AFTER_MS = 30 * 24 * 60 * 60_000;

function normalizedRuleText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function sameRule(
  existing: Pick<RuleRecord, "cue" | "action" | "project" | "state">,
  proposed: Pick<Proposal, "cue" | "action" | "project">,
): boolean {
  return (
    (existing.project === proposed.project ||
      (existing.state === "adopted" && existing.project === null)) &&
    normalizedRuleText(existing.cue) === normalizedRuleText(proposed.cue) &&
    normalizedRuleText(existing.action) === normalizedRuleText(proposed.action)
  );
}

export const relatedRuleSchema = z.object({
  ruleId: z.string().min(1),
  relation: z.enum(["overlaps", "conflicts"]),
});

export type RelatedRule = z.infer<typeof relatedRuleSchema>;

export const proposalSchema = z.object({
  cue: z.string().trim().min(8).max(300),
  action: z.string().trim().min(3).max(300),
  project: z.string().trim().min(1).max(200).nullable(),
  evidence: z.array(z.string().min(1)).max(50),
  label: z.string().trim().min(1).max(24).nullable().default(null),
  related: relatedRuleSchema.nullable().default(null),
});

export const proposalSubmissionSchema = z.object({ proposals: z.array(proposalSchema).max(8) });

export type Proposal = z.infer<typeof proposalSchema>;

export type ProposalSubmission = z.infer<typeof proposalSubmissionSchema>;

export interface ReplayEvidence {
  precision: number | null;
  matches: number;
}

const rowSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  cue: z.string(),
  action: z.string(),
  scope_kind: z.enum(["global", "project", "tag"]),
  scope_value: z.string().nullable(),
  level: z.enum(["ask", "veto", "auto"]),
  required: z.number().int(),
  provenance: z.enum(["learned", "told"]),
  evidence: z.string(),
  state: z.enum(["candidate", "adopted", "superseded", "retired"]),
  owner_adopted: z.number().int(),
  question_id: z.string().nullable(),
  question_revision: z.number().int().nullable(),
  requested_level: z.string().nullable(),
  matches: z.number().int(),
  overrides: z.number().int(),
  last_matched_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  label: z.string().nullable(),
});

export interface RuleRecord {
  id: string;
  version: number;
  cue: string;
  action: string;
  label: string | null;
  project: string | null;
  level: RuleLevel;
  required: boolean;
  provenance: "learned" | "told";
  evidence: string[];
  state: "candidate" | "adopted" | "superseded" | "retired";
  ownerAdopted: boolean;
  questionId: string | null;
  questionRevision: number | null;
  matches: number;
  overrides: number;
  lastMatchedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const adoptionChoiceSchema = z.enum([
  "ask",
  "veto",
  "veto-required",
  "auto",
  "auto-required",
  "keep",
  "reject",
]);

export type AdoptionChoice = z.infer<typeof adoptionChoiceSchema>;

type GrantingChoice = Exclude<AdoptionChoice, "keep" | "reject">;

const GRANTS: Record<GrantingChoice, { level: RuleLevel; required: boolean }> = {
  ask: { level: "ask", required: false },
  veto: { level: "veto", required: false },
  "veto-required": { level: "veto", required: true },
  auto: { level: "auto", required: false },
  "auto-required": { level: "auto", required: true },
};

const RANK: Record<RuleLevel, number> = { ask: 0, veto: 1, auto: 2 };

export interface AdoptionAnswer {
  questionRevision: number;
  choice: AdoptionChoice;
  ownerAttributed: boolean;
  coreSupportsAttribution: boolean;
  precision: number | null;
  replayMatches: number;
}

export type AdoptionResult =
  | { applied: true; rule: RuleRecord }
  | { applied: false; reason: "changed" | "not-owner" | "unknown" };

function toRecord(source: SqlRow): RuleRecord {
  const row = rowSchema.parse(source);

  return {
    id: row.id,
    version: row.version,
    cue: row.cue,
    action: row.action,
    label: row.label,
    project: row.scope_kind === "project" ? row.scope_value : null,
    level: row.level,
    required: row.required === 1,
    provenance: row.provenance,
    evidence: stringList(row.evidence),
    state: row.state,
    ownerAdopted: row.owner_adopted === 1,
    questionId: row.question_id,
    questionRevision: row.question_revision,
    matches: row.matches,
    overrides: row.overrides,
    lastMatchedAt: row.last_matched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const replayRowSchema = z.object({
  replay_precision: z.number().nullable(),
  replay_matches: z.number().nullable(),
});

const LATEST = `SELECT r.* FROM rules r
  JOIN (SELECT id, MAX(version) AS version FROM rules GROUP BY id) latest
  ON latest.id = r.id AND latest.version = r.version`;

export class Rules {
  private readonly db: Sql;

  constructor(db: Sql) {
    this.db = db;
  }

  latest(): RuleRecord[] {
    return this.db.prepare(`${LATEST} ORDER BY r.updated_at DESC`).all().map(toRecord);
  }

  get(id: string): RuleRecord | null {
    const row = this.db.prepare(`${LATEST} WHERE r.id = ?`).get(id);

    return row === undefined ? null : toRecord(row);
  }

  history(id: string): RuleRecord[] {
    return this.db
      .prepare("SELECT * FROM rules WHERE id = ? ORDER BY version")
      .all(id)
      .map(toRecord);
  }

  propose(proposal: Proposal, provenance: RuleRecord["provenance"], now: number): RuleRecord {
    const id = `rule_${randomUUID().slice(0, 8)}`;

    this.db
      .prepare(
        `INSERT INTO rules (id, version, cue, action, label, scope_kind, scope_value, level, required, provenance, evidence,
          state, owner_adopted, matches, overrides, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, 'ask', 0, ?, ?, 'candidate', 0, 0, 0, ?, ?)`,
      )
      .run(
        id,
        proposal.cue,
        proposal.action,
        proposal.label,
        proposal.project === null ? "global" : "project",
        proposal.project,
        provenance,
        JSON.stringify(proposal.evidence),
        now,
        now,
      );
    this.event(id, 1, "proposed", provenance, now);

    return this.require(id);
  }

  unbindQuestion(id: string): void {
    const rule = this.require(id);

    this.db
      .prepare(
        "UPDATE rules SET question_id = NULL, question_revision = NULL WHERE id = ? AND version = ?",
      )
      .run(id, rule.version);
  }

  bound(): RuleRecord[] {
    return this.latest().filter((rule) => rule.questionId !== null);
  }

  setReplay(id: string, precision: number | null, matches: number): void {
    const rule = this.require(id);

    this.db
      .prepare(
        "UPDATE rules SET replay_precision = ?, replay_matches = ? WHERE id = ? AND version = ?",
      )
      .run(precision, matches, id, rule.version);
  }

  replayOf(id: string): ReplayEvidence {
    const row = one(
      replayRowSchema,
      this.db
        .prepare(
          "SELECT replay_precision, replay_matches FROM rules WHERE id = ? ORDER BY version DESC LIMIT 1",
        )
        .get(id),
    );

    return { precision: row?.replay_precision ?? null, matches: row?.replay_matches ?? 0 };
  }

  bindQuestion(id: string, questionId: string, revision: number, now: number): void {
    const rule = this.require(id);

    this.db
      .prepare(
        "UPDATE rules SET question_id = ?, question_revision = ?, updated_at = ? WHERE id = ? AND version = ?",
      )
      .run(questionId, revision, now, id, rule.version);
    this.event(id, rule.version, "asked", questionId, now);
  }

  applyAnswer(id: string, answer: AdoptionAnswer, now: number): AdoptionResult {
    const rule = this.get(id);

    if (rule === null) return { applied: false, reason: "unknown" };

    if (rule.questionRevision !== answer.questionRevision)
      return { applied: false, reason: "changed" };

    if (answer.coreSupportsAttribution && !answer.ownerAttributed)
      return { applied: false, reason: "not-owner" };

    if (answer.choice === "reject")
      return { applied: true, rule: this.revise(rule, { state: "retired" }, "rejected", now) };

    const reviewed = rule.state === "adopted" ? { overrides: 0, lastMatchedAt: now } : {};

    if (answer.choice === "keep")
      return rule.state === "adopted"
        ? { applied: true, rule: this.revise(rule, reviewed, "kept", now) }
        : { applied: false, reason: "unknown" };

    const grant = GRANTS[answer.choice];

    const level: RuleLevel = !answer.coreSupportsAttribution
      ? "ask"
      : grant.level === "auto" && !autoAllowed(answer.precision, answer.replayMatches)
        ? "veto"
        : grant.level;

    const required = grant.required && level !== "ask";

    return {
      applied: true,
      rule: this.revise(
        rule,
        {
          ...reviewed,
          state: "adopted",
          level,
          required,
          ownerAdopted: answer.coreSupportsAttribution,
        },
        `adopted:${level}${required ? "+required" : ""}`,
        now,
      ),
    };
  }

  reduce(id: string, change: RuleChange, now: number): RuleRecord {
    const rule = this.require(id);

    if (rule.state !== "adopted")
      throw new Error(
        `Rule ${id} is ${rule.state}. Only adopted rules can be lowered or retired; a candidate is decided by its Rule? question.`,
      );

    if (change === "retire") return this.revise(rule, { state: "retired" }, "retired", now);

    if (change === "optional")
      return rule.required ? this.revise(rule, { required: false }, "lowered:optional", now) : rule;

    if (RANK[change] >= RANK[rule.level]) return rule;

    return this.revise(
      rule,
      { level: change, required: change === "ask" ? false : rule.required },
      `lowered:${change}`,
      now,
    );
  }

  settleUnanswered(id: string, now: number): void {
    const rule = this.require(id);

    if (rule.state === "adopted")
      this.revise(rule, { overrides: 0, lastMatchedAt: now }, "review-dismissed", now);
    else this.unbindQuestion(id);
  }

  recordMatch(id: string, now: number): void {
    this.db
      .prepare(
        `UPDATE rules SET matches = matches + 1, last_matched_at = ?
         WHERE id = ? AND version = (SELECT MAX(version) FROM rules WHERE id = ?)`,
      )
      .run(now, id, id);
  }

  recordOverride(id: string, now: number): RuleRecord | null {
    this.db
      .prepare(
        `UPDATE rules SET overrides = overrides + 1
         WHERE id = ? AND version = (SELECT MAX(version) FROM rules WHERE id = ?)`,
      )
      .run(id, id);
    const rule = this.get(id);

    return rule?.level === "auto" ? this.revise(rule, { level: "veto" }, "demoted", now) : rule;
  }

  forTriage(project: string): JudgeRule[] {
    return this.latest()
      .filter(
        (rule) => rule.state === "adopted" && (rule.project === null || rule.project === project),
      )
      .map((rule) => ({
        id: rule.id,
        cue: rule.cue,
        action: rule.action,
        scope: rule.project === null ? "all projects" : `project ${rule.project}`,
      }));
  }

  forDistill(): DistillRule[] {
    return this.latest()
      .filter((rule) => rule.state !== "superseded")
      .map((rule) => ({
        id: rule.id,
        status:
          rule.state === "adopted" ? "adopted" : rule.state === "candidate" ? "offered" : "rejected",
        cue: rule.cue,
        action: rule.action,
        scope: rule.project === null ? "all projects" : `project ${rule.project}`,
      }));
  }

  instructionBlock(project: string): string | null {
    const eligible = this.latest()
      .filter(
        (rule) =>
          rule.state === "adopted" &&
          rule.ownerAdopted &&
          (rule.project === null || rule.project === project),
      )
      .toSorted(
        (a, b) =>
          Number(a.project === null) - Number(b.project === null) || b.updatedAt - a.updatedAt,
      );

    const header =
      "The owner adopted these preferences. Follow them instead of asking. They never authorize an effect that needs the owner's approval; still ask for those.";

    const lines: string[] = [];
    let size = header.length;

    for (const rule of eligible) {
      const line = `\n- When ${rule.cue}: ${rule.action}`;

      if (size + line.length > INSTRUCTION_LIMIT) continue;
      lines.push(line);
      size += line.length;
    }

    return lines.length === 0 ? null : `${header}${lines.join("")}`;
  }

  needingReview(now: number): RuleRecord[] {
    return this.latest().filter(
      (rule) =>
        rule.state === "adopted" &&
        rule.questionId === null &&
        (rule.overrides >= 2 || now - (rule.lastMatchedAt ?? rule.updatedAt) > REVIEW_AFTER_MS),
    );
  }

  private require(id: string): RuleRecord {
    const rule = this.get(id);

    if (rule === null) throw new Error(`Rule ${id} does not exist.`);

    return rule;
  }

  private revise(
    rule: RuleRecord,
    changes: Partial<
      Pick<
        RuleRecord,
        "state" | "level" | "ownerAdopted" | "required" | "overrides" | "lastMatchedAt"
      >
    >,
    kind: string,
    now: number,
  ): RuleRecord {
    const next = { ...rule, ...changes };
    const version = rule.version + 1;

    this.db
      .prepare("UPDATE rules SET state = 'superseded' WHERE id = ? AND version = ?")
      .run(rule.id, rule.version);
    this.db
      .prepare(
        `INSERT INTO rules (id, version, cue, action, label, scope_kind, scope_value, level, required, provenance, evidence,
          state, owner_adopted, question_id, question_revision, matches, overrides, last_matched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id,
        version,
        next.cue,
        next.action,
        next.label,
        next.project === null ? "global" : "project",
        next.project,
        next.level,
        next.required ? 1 : 0,
        next.provenance,
        JSON.stringify(next.evidence),
        next.state,
        next.ownerAdopted ? 1 : 0,
        next.matches,
        next.overrides,
        next.lastMatchedAt,
        rule.createdAt,
        now,
      );
    this.event(rule.id, version, kind, null, now);

    return this.require(rule.id);
  }

  private event(
    id: string,
    version: number,
    kind: string,
    detail: string | null,
    at: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO rule_events (rule_id, version, kind, detail, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, version, kind, detail, at);
  }
}
