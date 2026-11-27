import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { ruleChangeSchema } from "./delegation.ts";
import { verdictSchema } from "./inputs.ts";

export const CHIEF_PLUGIN_ID = "chief";

export const optionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  recommended: z.boolean(),
});

export const openQuestionSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  revision: z.number().int().positive(),
  mode: z.enum(["required", "optional"]),
  shortLabel: z.string(),
  prompt: z.string(),
  context: z.string().nullable(),
  multiSelect: z.boolean(),
  allowFreeText: z.boolean(),
  delegable: z.boolean(),
  options: z.array(optionSchema),
  createdAt: z.number(),
});

export const cardKindSchema = z.enum(["question", "problem", "ask", "result"]);

export const deckCardSchema = z.object({
  key: z.string(),
  kind: cardKindSchema,
  threadId: z.string().nullable(),
  title: z.string(),
  project: z.string(),
  text: z.string(),
  steps: z.array(
    z.object({
      question: openQuestionSchema,
      key: z.string(),
      verdict: verdictSchema.nullable(),
      triageError: z.string().nullable(),
    }),
  ),
  required: z.boolean(),
  priority: verdictSchema.shape.priority,
  suggestedReply: z.string().nullable(),
  ruleOffer: z.boolean(),
  latch: z.string().nullable(),
  alsoAsked: z.array(z.object({ threadId: z.string(), title: z.string(), key: z.string() })),
  since: z.number(),
});

export const triageStatusSchema = z.object({
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  matchRate: z.number().min(0).max(100).nullable(),
  decided: z.number().int().nonnegative(),
});

export const delegationStatusSchema = z.object({
  supported: z.boolean(),
  paused: z.boolean(),
  note: z.string().nullable(),
});

export const suggestionsSchema = z.enum(["undecided", "off", "on"]);

export const agentViewSchema = z.object({
  providerId: z.string().nullable(),
  label: z.string().nullable(),
  ready: z.boolean(),
});

export const homeStateSchema = z.enum(["ready", "starting", "missing", "error", "unsupported"]);

export const statusLineSchema = z.object({
  kind: z.enum(["paused", "failing", "no-computer", "migration", "summary"]),
  text: z.string(),
  action: z.enum(["resume", "retry", "review"]).nullable(),
});

export const deckViewSchema = z.object({
  cards: z.array(deckCardSchema),
  savedCards: z.array(z.object({ card: deckCardSchema, until: z.number().int() })),
  ruleReviews: z.record(
    z.string(),
    z.object({
      topic: z.string(),
      scope: z.string(),
      adopted: z.array(z.object({
        id: z.string(),
        cue: z.string(),
        action: z.string(),
        scope: z.string(),
      })),
    }),
  ),
  toDecide: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
  chiefThreadId: z.string().nullable(),
  home: homeStateSchema,
  suggestions: suggestionsSchema,
  agent: agentViewSchema,
  statusLine: statusLineSchema.nullable(),
  tabs: z.object({ rules: z.boolean(), decided: z.boolean() }),
  canAnswerForMe: z.boolean(),
  takeRate: z.object({ used: z.number().int(), of: z.number().int() }).nullable(),
  archiveReady: z.number().int().nonnegative(),
  swipeHintSeen: z.boolean(),
  triage: triageStatusSchema,
  delegation: delegationStatusSchema,
  generatedAt: z.number(),
});

export const sidebarStatusSchema = z.object({
  dot: z.enum(["attention", "failed"]).nullable(),
  toDecide: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
  paused: z.boolean(),
  error: z.boolean(),
});

export const threadDelegationSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  answer: z.array(z.string()),
  cue: z.string(),
  state: z.enum(["waiting", "unconfirmed", "sent", "uncertain", "cancelled", "corrected"]),
  sendAt: z.number(),
  updatedAt: z.number(),
});

export const outcomeActionSchema = z.enum([
  "accept",
  "alternative",
  "custom",
  "later",
  "open",
  "archive",
  "reply",
  "resume",
]);

export const outcomeInputSchema = z.object({
  cardKey: z.string().min(1),
  cardKind: cardKindSchema,
  action: outcomeActionSchema,
  threadId: z.string().nullable(),
  questionIds: z.array(z.string()),
  chosen: z.array(z.string()),
  freeText: z.string().max(4096).nullable(),
  reasonChip: z.string().max(60).nullable(),
  responseMs: z.number().int().nonnegative().nullable(),
});

export const ruleViewSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  cue: z.string(),
  action: z.string(),
  scope: z.string(),
  level: z.enum(["ask", "veto", "auto"]),
  required: z.boolean(),
  provenance: z.enum(["learned", "told"]),
  state: z.enum(["candidate", "adopted", "superseded", "retired"]),
  ownerAdopted: z.boolean(),
  matches: z.number().int().nonnegative(),
  overrides: z.number().int().nonnegative(),
  precision: z.number().nullable(),
  evidence: z.number().int().nonnegative(),
  updatedAt: z.number(),
});

export const delegatedViewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  title: z.string(),
  questionId: z.string(),
  prompt: z.string(),
  answer: z.array(z.string()),
  ruleId: z.string(),
  cue: z.string(),
  state: z.enum(["waiting", "unconfirmed", "sent", "uncertain", "cancelled", "corrected"]),
  sendAt: z.number(),
  answeredBy: z.string().nullable(),
  updatedAt: z.number(),
});

export const rpcContract = defineRpcContract({
  deck: { input: z.null(), output: deckViewSchema },
  "outcome.record": { input: outcomeInputSchema, output: z.object({ id: z.string() }) },
  snooze: {
    input: z.object({ cardKey: z.string().min(1), until: z.number().int().positive() }),
    output: z.object({ ok: z.literal(true) }),
  },
  unsnooze: {
    input: z.object({ cardKey: z.string().min(1), until: z.number().int().positive() }),
    output: z.object({ ok: z.literal(true) }),
  },
  status: { input: z.null(), output: sidebarStatusSchema },
  "suggestions.set": {
    input: z.object({ value: z.enum(["on", "off"]) }),
    output: z.object({ suggestions: suggestionsSchema }),
  },
  pause: { input: z.null(), output: z.object({ paused: z.literal(true) }) },
  resume: { input: z.null(), output: z.object({ questionId: z.string() }) },
  "hint.seen": { input: z.null(), output: z.object({ ok: z.literal(true) }) },
  "home.repair": { input: z.null(), output: z.object({ threadId: z.string() }) },
  "suggestions.retry": { input: z.null(), output: z.object({ ok: z.literal(true) }) },
  "delegation.answerNow": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ state: delegatedViewSchema.shape.state }),
  },
  "thread.triage": {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      chiefThreadId: z.string().nullable(),
      suggestions: suggestionsSchema,
      agent: agentViewSchema,
      paused: z.boolean(),
      delegations: z.array(threadDelegationSchema),
      steps: z.array(
        z.object({
          questionId: z.string(),
          key: z.string(),
          verdict: verdictSchema.nullable(),
          triageError: z.string().nullable(),
        }),
      ),
    }),
  },
  start: { input: z.null(), output: z.object({ threadId: z.string() }) },
  "rules.list": { input: z.null(), output: z.object({ rules: z.array(ruleViewSchema) }) },
  "rules.change": {
    input: z.object({ id: z.string().min(1), change: ruleChangeSchema }),
    output: z.object({ rule: ruleViewSchema }),
  },
  "delegation.list": { input: z.null(), output: z.object({ items: z.array(delegatedViewSchema) }) },
  "delegation.undo": {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ state: delegatedViewSchema.shape.state }),
  },
});

export type OpenQuestion = z.infer<typeof openQuestionSchema>;

export type DeckCardView = z.infer<typeof deckCardSchema>;

export type DeckView = z.infer<typeof deckViewSchema>;

export type OutcomeInput = z.infer<typeof outcomeInputSchema>;

export type RuleView = z.infer<typeof ruleViewSchema>;

export type DelegatedView = z.infer<typeof delegatedViewSchema>;

export type Suggestions = z.infer<typeof suggestionsSchema>;

export type AgentView = z.infer<typeof agentViewSchema>;

export type HomeState = z.infer<typeof homeStateSchema>;

export type StatusLine = z.infer<typeof statusLineSchema>;

export type SidebarStatus = z.infer<typeof sidebarStatusSchema>;

export type ThreadDelegation = z.infer<typeof threadDelegationSchema>;
