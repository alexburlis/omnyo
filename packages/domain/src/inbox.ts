import { z } from "zod";
import { threadQuestionInputSchema } from "./thread-attention.js";

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

export const INBOX_DISPLAY_MAX = 3;

export const INBOX_DEFAULT_WAIT_MS = 7 * DAY;

export const INBOX_AGENT_WAIT_CAP_MS = 30 * DAY;

export const INBOX_REMINDER_MS = 14 * DAY;

export const INBOX_RETRY_DECISION_MS = 30_000;

export const INBOX_HOST_EPISODE_MS = 24 * HOUR;

export const INBOX_STALL_GRACE_MS = 10 * MINUTE;

export const INBOX_GOAL_VERDICT_HOLD_MS = 15 * MINUTE;

export const INBOX_CHECK_MAX_INTERVAL_MS = DAY;

export const INBOX_UNDO_TOAST_MS = 10_000;

export const INBOX_FOR_TEXT_MAX = 60;

export const inboxViewValues = [
  "inbox",
  "waiting",
  "running",
  "resting",
  "archive",
] as const;

export const inboxViewSchema = z.enum(inboxViewValues);

export type InboxView = z.infer<typeof inboxViewSchema>;

export const inboxStateValues = [
  "needs-you",
  "failed",
  "finished",
  "working",
  "waiting",
  "resting",
  "archive",
] as const;

export const inboxStateSchema = z.enum(inboxStateValues);

export type InboxState = z.infer<typeof inboxStateSchema>;

export const inboxReasonKindValues = [
  "question",
  "failure",
  "unverified",
  "decision",
  "ask",
  "deliver",
  "recap",
  "unassessed",
  "activity",
  "wait",
  "none",
] as const;

export const inboxReasonKindSchema = z.enum(inboxReasonKindValues);

export type InboxReasonKind = z.infer<typeof inboxReasonKindSchema>;

export const inboxCardKindValues = [
  "question",
  "result",
  "returned",
  "problem",
  "runs",
  "chain",
] as const;

export const inboxCardKindSchema = z.enum(inboxCardKindValues);

export type InboxCardKind = z.infer<typeof inboxCardKindSchema>;

export const inboxReceiptCauseValues = [
  "result",
  "question",
  "problem",
  "coverage-gap",
  "deadline",
  "partial",
  "dead-wake",
  "your-date",
  "reminder",
  "proposal",
  "stall",
  "late-result",
  "chain",
  "catch-up",
  "post-failed",
] as const;

export const inboxReceiptCauseSchema = z.enum(inboxReceiptCauseValues);

export type InboxReceiptCause = z.infer<typeof inboxReceiptCauseSchema>;

const RETURNED_CAUSES: ReadonlySet<InboxReceiptCause> = new Set([
  "deadline",
  "partial",
  "dead-wake",
  "reminder",
  "late-result",
]);

export function isReturnedCause(cause: InboxReceiptCause): boolean {
  return RETURNED_CAUSES.has(cause);
}

const WORK_REPORT_CAUSES: ReadonlySet<InboxReceiptCause> = new Set([
  "result",
  "problem",
  "question",
]);

export const inboxWaitKindValues = [
  "chat",
  "check",
  "event",
  "report",
  "date",
  "send-later",
  "join",
] as const;

export const inboxWaitKindSchema = z.enum(inboxWaitKindValues);

export type InboxWaitKind = z.infer<typeof inboxWaitKindSchema>;

export const inboxWaitStatusValues = [
  "proposed",
  "live",
  "evaluating",
  "dispatched",
  "closed",
] as const;

export const inboxWaitStatusSchema = z.enum(inboxWaitStatusValues);

export type InboxWaitStatus = z.infer<typeof inboxWaitStatusSchema>;

export const inboxWaitCreatorValues = ["agent", "owner", "automation"] as const;

export const inboxWaitCreatorSchema = z.enum(inboxWaitCreatorValues);

export type InboxWaitCreator = z.infer<typeof inboxWaitCreatorSchema>;

export const inboxProducerKindValues = ["goal"] as const;

export const inboxProducerKindSchema = z.enum(inboxProducerKindValues);

export type InboxProducerKind = z.infer<typeof inboxProducerKindSchema>;

export const inboxProducerVerdictValues = [
  "unmet",
  "met",
  "limit",
  "stopped",
  "failed",
] as const;

export const inboxProducerVerdictSchema = z.enum(inboxProducerVerdictValues);

export type InboxProducerVerdict = z.infer<typeof inboxProducerVerdictSchema>;

export const inboxConditionKindValues = [
  "chat",
  "check",
  "event",
  "report",
  "date",
] as const;

export const inboxConditionKindSchema = z.enum(inboxConditionKindValues);

export type InboxConditionKind = z.infer<typeof inboxConditionKindSchema>;

export const inboxOwnerInputKindValues = [
  "message",
  "answer",
  "happened",
  "resume",
  "send-later",
] as const;

export const inboxOwnerInputKindSchema = z.enum(inboxOwnerInputKindValues);

export type InboxOwnerInputKind = z.infer<typeof inboxOwnerInputKindSchema>;

export const inboxOwnerInputStateValues = [
  "queued",
  "running",
  "owed",
  "handed-off",
  "covered",
  "waived",
] as const;

export const inboxOwnerInputStateSchema = z.enum(inboxOwnerInputStateValues);

export type InboxOwnerInputState = z.infer<typeof inboxOwnerInputStateSchema>;

export const inboxFailureStateValues = [
  "deciding",
  "held",
  "actionable",
  "resolved",
] as const;

export const inboxFailureStateSchema = z.enum(inboxFailureStateValues);

export type InboxFailureState = z.infer<typeof inboxFailureStateSchema>;

export const inboxFailureViewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  requestId: z.string().nullable(),
  state: inboxFailureStateSchema,
  reason: z.string(),
  resolvedBy: z.string().nullable(),
});

export type InboxFailureView = z.infer<typeof inboxFailureViewSchema>;

export const inboxFailureListResponseSchema = z.object({
  failures: z.array(inboxFailureViewSchema),
});

export type InboxFailureListResponse = z.infer<
  typeof inboxFailureListResponseSchema
>;

export const inboxFailureAcknowledgeRequestSchema = z.object({
  turnId: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(1000),
});

export type InboxFailureAcknowledgeRequest = z.infer<
  typeof inboxFailureAcknowledgeRequestSchema
>;

export const inboxFailureAcknowledgeResponseSchema = z.object({
  failure: inboxFailureViewSchema,
  acknowledged: z.boolean(),
});

export type InboxFailureAcknowledgeResponse = z.infer<
  typeof inboxFailureAcknowledgeResponseSchema
>;

export const inboxProposalKindValues = [
  "report",
  "watch",
  "wait",
  "stop-waiting",
  "shelve",
  "archive",
] as const;

export const inboxProposalKindSchema = z.enum(inboxProposalKindValues);

export type InboxProposalKind = z.infer<typeof inboxProposalKindSchema>;

export const inboxCauseSchema = z.object({
  receiptId: z.string(),
  cause: inboxReceiptCauseSchema,
  threadId: z.string(),
  fromTitle: z.string().nullable(),
  summary: z.string(),
  at: z.number(),
});

export type InboxCause = z.infer<typeof inboxCauseSchema>;

export const inboxPrimarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer") }),
  z.object({
    kind: z.literal("accept-proposal"),
    proposalKind: inboxProposalKindSchema,
    waitId: z.string().nullable(),
    label: z.string(),
  }),
  z.object({ kind: z.literal("ok"), thenWaits: z.string().nullable() }),
  z.object({
    kind: z.literal("reply"),
    waiterTitles: z.array(z.string()),
  }),
  z.object({ kind: z.literal("archive") }),
  z.object({ kind: z.literal("your-call") }),
  z.object({
    kind: z.literal("resume"),
    targetThreadId: z.string(),
    targetTitle: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("problem-chooser"),
    targetThreadId: z.string(),
    retryAllowed: z.boolean(),
  }),
  z.object({
    kind: z.literal("keep-waiting"),
    waitId: z.string(),
    until: z.number(),
  }),
  z.object({ kind: z.literal("remind-later"), waitId: z.string() }),
  z.object({ kind: z.literal("continue-with-result"), waitId: z.string() }),
  z.object({
    kind: z.literal("archive-runs"),
    mode: z.enum(["done", "older"]),
    threadIds: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("resume-all-at-reset"),
    resetAt: z.number(),
    threadIds: z.array(z.string()).min(2),
  }),
]);

export type InboxPrimary = z.infer<typeof inboxPrimarySchema>;

export function isInboxPrimaryReadyToArchive(primary: InboxPrimary): boolean {
  return (
    primary.kind === "archive" ||
    (primary.kind === "archive-runs" && primary.mode === "done")
  );
}

export const inboxRowActionValues = [
  "archive",
  "wait",
  "reply",
  "shelf",
] as const;

export const inboxRowActionSchema = z.enum(inboxRowActionValues);

export type InboxRowAction = z.infer<typeof inboxRowActionSchema>;

export const inboxCardSchema = z.object({
  kind: inboxCardKindSchema,
  causes: z.array(inboxCauseSchema),
  primary: inboxPrimarySchema,
  actions: z.array(inboxRowActionSchema),
  questionIds: z.array(z.string()),
  questionMode: threadQuestionInputSchema.shape.mode.nullable(),
  questionFrom: z.string().nullable(),
  snoozedQuestionUntil: z.number().nullable(),
  stillOnYou: z.string().nullable(),
  notAssessed: z.string().nullable(),
  failure: z
    .object({
      threadId: z.string(),
      reason: z.string(),
      queuedCount: z.number().int().nonnegative(),
      scheduledCount: z.number().int().nonnegative(),
    })
    .nullable(),
  since: z.number(),
});

export type InboxCard = z.infer<typeof inboxCardSchema>;

export const inboxWaitingGroupSchema = z.enum(["on-you", "comes-back"]);

export type InboxWaitingGroup = z.infer<typeof inboxWaitingGroupSchema>;

export const inboxWaitingRowSchema = z.object({
  group: inboxWaitingGroupSchema,
  reason: z.string(),
  waitId: z.string().nullable(),
  waitThreadId: z.string().optional(),
  returnAt: z.number().nullable(),
  checkAt: z.number().nullable(),
  checkCount: z.number().int().nonnegative(),
  checking: z.boolean(),
  guaranteed: z.boolean(),
  behind: z.string().nullable(),
  retry: z
    .object({
      at: z.number().nullable(),
      attempt: z.number().int().nullable(),
      maxAttempts: z.number().int().nullable(),
    })
    .nullable(),
  questionId: z.string().nullable(),
});

export type InboxWaitingRow = z.infer<typeof inboxWaitingRowSchema>;

export const inboxGroupMemberSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  primary: inboxPrimarySchema,
  causes: z.array(inboxCauseSchema),
  since: z.number(),
  latch: z.string(),
});

export type InboxGroupMember = z.infer<typeof inboxGroupMemberSchema>;

export const inboxRunningProgressSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});

export type InboxRunningProgress = z.infer<typeof inboxRunningProgressSchema>;

export const inboxEntrySchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  title: z.string(),
  shelved: z.boolean(),
  automationId: z.string().nullable(),
  state: inboxStateSchema,
  reason: z.object({
    kind: inboxReasonKindSchema,
    text: z.string(),
    threadId: z.string(),
  }),
  recap: z.string().nullable(),
  archiveReady: z.boolean(),
  optionalQuestion: z
    .object({ id: z.string(), label: z.string(), threadId: z.string() })
    .nullable(),
  pendingResults: z.number().int().nonnegative(),
  view: inboxViewSchema,
  card: inboxCardSchema.nullable(),
  waiting: inboxWaitingRowSchema.nullable(),
  running: z
    .object({
      label: z.string(),
      progress: inboxRunningProgressSchema.nullable(),
    })
    .nullable(),
  runs: z.array(inboxGroupMemberSchema).nullable(),
  incident: z
    .object({
      key: z.string(),
      label: z.string(),
      resetAt: z.number().nullable(),
      members: z.array(inboxGroupMemberSchema),
    })
    .nullable(),
  sortAt: z.number(),
  latch: z.string(),
});

export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export const inboxCountsSchema = z.object({
  needsYou: z.number().int().nonnegative(),
  inbox: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  onYou: z.array(z.string()),
  nextBackAt: z.number().nullable(),
});

export type InboxCounts = z.infer<typeof inboxCountsSchema>;

export const inboxSnapshotSchema = z.object({
  revision: z.string(),
  generatedAt: z.number(),
  inbox: z.array(inboxEntrySchema),
  waiting: z.array(inboxEntrySchema),
  running: z.array(inboxEntrySchema),
  shelf: z.array(inboxEntrySchema),
  counts: inboxCountsSchema,
  lastMove: z
    .object({
      moveId: z.string(),
      kind: z.string(),
      threadId: z.string(),
      at: z.number(),
    })
    .nullable(),
});

export type InboxSnapshot = z.infer<typeof inboxSnapshotSchema>;

export interface InboxQuestionFacts {
  id: string;
  revision: number;
  label: string;
  permission: boolean;
  snoozedUntil: number | null;
}

export interface InboxFailureFacts {
  id: string;
  state: Exclude<InboxFailureState, "resolved">;
  reason: string;
  retryAt: number | null;
  decisionDeadline: number | null;
  attempt: number | null;
  maxAttempts: number | null;
  canResume: boolean;
  outwardEffectRan: boolean;
  queuedCount: number;
  scheduledCount: number;
  incident: { key: string; label: string; resetAt: number | null } | null;
}

export interface InboxChatFacts {
  threadId: string;
  title: string;
  isRoot: boolean;
  running: boolean;
  working: boolean;
  runningLabel: string | null;
  runningProgress: InboxRunningProgress | null;
  waitingLabel: string | null;
  queuedOwnerWork: boolean;
  checkingWaitId: string | null;
  requiredQuestions: InboxQuestionFacts[];
  optionalQuestions: InboxQuestionFacts[];
  failure: InboxFailureFacts | null;
  hostEpisode: { hostName: string; deadline: number } | null;
  coverageGap: string | null;
}

export interface InboxConditionFacts {
  key: string;
  kind: InboxConditionKind;
  target: string | null;
  label: string;
  met: boolean;
}

export interface InboxWaitFacts {
  id: string;
  threadId: string;
  kind: InboxWaitKind;
  status: Exclude<InboxWaitStatus, "closed">;
  forText: string;
  createdBy: InboxWaitCreator;
  ownerAccepted: boolean;
  deadline: number | null;
  nextCheckAt: number | null;
  checkCount: number;
  reminderAt: number | null;
  readiness: "all" | "any";
  conditions: InboxConditionFacts[];
  proposalKind: InboxProposalKind | null;
  proposalReceiptId: string | null;
  questionId: string | null;
  behindTitle: string | null;
}

export interface InboxReceiptFacts {
  id: string;
  seq: number;
  threadId: string;
  fromTitle: string | null;
  cause: InboxReceiptCause;
  summary: string;
  waitId: string | null;
  createdAt: number;
  agentEventDeadline?: boolean;
}

export interface InboxAssessmentFacts {
  ask: string | null;
  recap: string | null;
  fresh: boolean;
  availability:
    | "missing"
    | "checking"
    | "available"
    | "stale"
    | "disabled"
    | "failed"
    | "skipped";
  reason: string;
  suggestion: boolean;
  archiveReady: boolean;
  archiveEligible: boolean;
}

export interface InboxWaiterFacts {
  threadId: string;
  title: string;
  createdBy: InboxWaitCreator;
}

export interface InboxFamilyFacts {
  rootId: string;
  projectId: string;
  title: string;
  createdAt: number;
  archivedAt: number | null;
  shelvedAt: number | null;
  automationId: string | null;
  chats: InboxChatFacts[];
  receipts: InboxReceiptFacts[];
  waits: InboxWaitFacts[];
  waiters: InboxWaiterFacts[];
  assessment: InboxAssessmentFacts;
  continuation?: { threadId: string; title: string };
}

export function isChatStallReceipt(receipt: {
  cause: string;
  waitId: string | null;
}): boolean {
  return receipt.cause === "stall" && receipt.waitId === null;
}

export function chatsWaitingPhrase(titles: readonly string[]): string {
  const last = titles.at(-1) ?? "A chat";

  const names =
    titles.length <= 1 ? last : `${titles.slice(0, -1).join(", ")} and ${last}`;

  return `${names} ${titles.length > 1 ? "are" : "is"} waiting`;
}

function distinctWaiters(
  waiters: readonly InboxWaiterFacts[],
): InboxWaiterFacts[] {
  return [
    ...new Map(waiters.map((waiter) => [waiter.threadId, waiter])).values(),
  ];
}

function ownerWaiters(facts: InboxFamilyFacts): InboxWaiterFacts[] {
  return distinctWaiters(
    facts.waiters.filter((waiter) => waiter.createdBy !== "agent"),
  );
}

function deliverReason(facts: InboxFamilyFacts): string {
  return `${chatsWaitingPhrase(
    distinctWaiters(facts.waiters).map((waiter) => waiter.title),
  )} on this chat`;
}

function liveWaits(facts: InboxFamilyFacts): InboxWaitFacts[] {
  return facts.waits.filter(
    (wait) => wait.status !== "proposed" && wait.kind !== "send-later",
  );
}

function questionCandidates(facts: InboxFamilyFacts) {
  return facts.chats.flatMap((chat) => [
    ...chat.requiredQuestions.map((question) => ({
      chat,
      question,
      mode: "required" as const,
    })),
    ...chat.optionalQuestions.map((question) => ({
      chat,
      question,
      mode: "optional" as const,
    })),
  ]);
}

function actionableFailure(facts: InboxFamilyFacts): {
  chat: InboxChatFacts;
  failure: InboxFailureFacts;
} | null {
  const chat = facts.chats.find((chat) => chat.isRoot);

  return chat?.failure?.state === "actionable"
    ? { chat, failure: chat.failure }
    : null;
}

function heldFailure(facts: InboxFamilyFacts): InboxFailureFacts | null {
  const failure = facts.chats.find((chat) => chat.isRoot)?.failure;

  return failure && failure.state !== "actionable" ? failure : null;
}

function ownerReceipts(facts: InboxFamilyFacts): InboxReceiptFacts[] {
  return facts.receipts.filter((receipt) => {
    if (receipt.cause === "problem") return receipt.threadId === facts.rootId;

    if (receipt.cause === "stall")
      return !facts.chats.some(
        (chat) => chat.threadId === receipt.threadId && chat.running,
      );

    return true;
  });
}

function isResumedAgentDeadline(
  facts: InboxFamilyFacts,
  receipt: InboxReceiptFacts,
): boolean {
  return (
    receipt.cause === "deadline" &&
    receipt.agentEventDeadline === true &&
    facts.chats.some(
      (chat) =>
        chat.threadId === receipt.threadId &&
        chat.working &&
        chat.checkingWaitId === null,
    )
  );
}

function isWorkReport(
  facts: InboxFamilyFacts,
  receipt: InboxReceiptFacts,
): boolean {
  return (
    WORK_REPORT_CAUSES.has(receipt.cause) ||
    isResumedAgentDeadline(facts, receipt)
  );
}

function toCause(receipt: InboxReceiptFacts): InboxCause {
  return {
    receiptId: receipt.id,
    cause: receipt.cause,
    threadId: receipt.threadId,
    fromTitle: receipt.fromTitle,
    summary: receipt.summary,
    at: receipt.createdAt,
  };
}

function waitReturnAt(wait: InboxWaitFacts): number | null {
  if (wait.kind === "report") return wait.reminderAt ?? wait.deadline;

  return wait.deadline;
}

function earliest(values: readonly (number | null)[]): number | null {
  let best: number | null = null;

  for (const value of values)
    if (value !== null && (best === null || value < best)) best = value;

  return best;
}

function proposalLabel(wait: InboxWaitFacts): string {
  switch (wait.proposalKind) {
    case "report":
      return `On you: ${wait.forText}?`;
    case "watch":
      return `Watch: ${wait.forText}?`;
    case "stop-waiting":
      return `Stop waiting: ${wait.forText}?`;
    case "shelve":
      return "Shelve?";
    default:
      return `Wait: ${wait.forText}`;
  }
}

function thenWaits(facts: InboxFamilyFacts): string | null {
  const waits = liveWaits(facts);

  const first = [...waits].sort(
    (a, b) =>
      (waitReturnAt(a) ?? Number.MAX_SAFE_INTEGER) -
      (waitReturnAt(b) ?? Number.MAX_SAFE_INTEGER),
  )[0];

  if (first) return first.forText;

  const running = facts.chats.find((chat) => chat.running);

  return (
    running?.runningLabel ??
    (running
      ? "Work continues"
      : (facts.chats.find((chat) => chat.waitingLabel !== null)?.waitingLabel ??
        null))
  );
}

function resultPrimary(
  facts: InboxFamilyFacts,
  receipts: readonly InboxReceiptFacts[],
): InboxPrimary {
  const proposal = facts.waits.find(
    (wait) => wait.status === "proposed" && wait.proposalKind !== null,
  );

  if (proposal)
    return {
      kind: "accept-proposal",
      proposalKind: proposal.proposalKind ?? "wait",
      waitId: proposal.id,
      label: proposalLabel(proposal),
    };

  const newest = (cause: InboxReceiptCause) =>
    [...receipts]
      .reverse()
      .find(
        (receipt) =>
          receipt.cause === cause && !isResumedAgentDeadline(facts, receipt),
      );

  if (newest("dead-wake")) return { kind: "reply", waiterTitles: [] };

  const deadline = newest("deadline") ?? newest("partial");

  if (deadline?.waitId)
    return {
      kind: "keep-waiting",
      waitId: deadline.waitId,
      until: deadline.createdAt + INBOX_DEFAULT_WAIT_MS,
    };

  const reminder = newest("reminder");

  if (reminder?.waitId)
    return { kind: "remind-later", waitId: reminder.waitId };

  const late = newest("late-result");

  if (late?.waitId)
    return { kind: "continue-with-result", waitId: late.waitId };

  const continues =
    liveWaits(facts).length > 0 ||
    facts.chats.some((chat) => chat.running || chat.waitingLabel !== null);

  if (continues) return { kind: "ok", thenWaits: thenWaits(facts) };

  const owed = receipts.some(isChatStallReceipt)
    ? distinctWaiters(facts.waiters)
    : ownerWaiters(facts);

  if (owed.length > 0)
    return { kind: "reply", waiterTitles: owed.map((waiter) => waiter.title) };

  if (facts.shelvedAt !== null) return { kind: "ok", thenWaits: null };

  if (
    facts.waiters.length === 0 &&
    ownerAsk(facts) === null &&
    facts.assessment.fresh &&
    facts.assessment.availability === "available" &&
    facts.assessment.archiveReady &&
    facts.assessment.archiveEligible
  )
    return { kind: "archive" };

  if (
    facts.assessment.fresh &&
    facts.assessment.availability === "available" &&
    !facts.assessment.archiveReady &&
    facts.assessment.suggestion
  )
    return { kind: "reply", waiterTitles: [] };

  return { kind: "your-call" };
}

function notAssessedReason(facts: InboxFamilyFacts): string | null {
  const { assessment } = facts;

  if (assessment.fresh && assessment.availability === "available") return null;

  if (assessment.availability === "missing") return null;

  if (!assessment.fresh) return "the chat changed since its assessment";

  return assessment.reason;
}

function cardKind(receipts: readonly InboxReceiptFacts[]): InboxCardKind {
  if (receipts.some((receipt) => isReturnedCause(receipt.cause)))
    return "returned";

  if (receipts.some((receipt) => receipt.cause === "chain")) return "chain";

  return "result";
}

function rowActions(kind: InboxCardKind): InboxRowAction[] {
  if (kind === "question") return [];

  if (kind === "problem") return ["archive", "reply", "shelf"];

  return ["archive", "wait", "reply", "shelf"];
}

function stillOnYou(facts: InboxFamilyFacts): string | null {
  const report = liveWaits(facts).find((wait) => wait.kind === "report");

  return report ? report.forText : null;
}

function snoozedQuestion(facts: InboxFamilyFacts) {
  const snoozed = questionCandidates(facts).filter(
    ({ question }) => question.snoozedUntil !== null,
  );

  return snoozed.find(({ mode }) => mode === "required") ?? snoozed[0] ?? null;
}

function ownerAsk(facts: InboxFamilyFacts): string | null {
  const { assessment } = facts;

  if (
    facts.shelvedAt !== null ||
    !assessment.fresh ||
    assessment.availability !== "available"
  )
    return null;

  const ask = assessment.ask?.trim();

  if (
    !ask ||
    facts.chats.some((chat) => chat.running || chat.hostEpisode !== null) ||
    liveWaits(facts).length > 0 ||
    heldFailure(facts) !== null ||
    snoozedQuestion(facts) !== null
  )
    return null;

  return ask;
}

function failureSummary(
  chat: InboxChatFacts,
  failure: InboxFailureFacts,
): NonNullable<InboxCard["failure"]> {
  return {
    threadId: chat.threadId,
    reason: failure.reason,
    queuedCount: failure.queuedCount,
    scheduledCount: failure.scheduledCount,
  };
}

function latchOf(card: InboxCard | null, view: InboxView): string {
  if (card === null) return view;

  return [
    view,
    card.kind,
    JSON.stringify(card.primary),
    ...card.causes.map((cause) => cause.receiptId),
    ...card.questionIds,
    ...(card.questionMode === null ? [] : [card.questionMode]),
  ].join("|");
}

function entry(
  facts: InboxFamilyFacts,
  fields: Pick<InboxEntry, "view"> &
    Partial<
      Pick<InboxEntry, "card" | "waiting" | "running" | "sortAt" | "incident">
    >,
): InboxEntry {
  const card = fields.card ?? null;

  return {
    threadId: facts.rootId,
    projectId: facts.projectId,
    title: facts.title,
    shelved: facts.shelvedAt !== null,
    automationId: facts.automationId,
    ...decideInboxState(facts),
    view: fields.view,
    card,
    waiting: fields.waiting ?? null,
    running: fields.running ?? null,
    runs: null,
    incident: fields.incident ?? null,
    sortAt: fields.sortAt ?? card?.since ?? facts.createdAt,
    latch: latchOf(card, fields.view),
  };
}

function baseCard(
  facts: InboxFamilyFacts,
  kind: InboxCardKind,
  primary: InboxPrimary,
  receipts: readonly InboxReceiptFacts[],
  since: number,
): InboxCard {
  const snoozed = snoozedQuestion(facts);

  return {
    kind,
    causes: receipts.map(toCause),
    primary,
    actions: rowActions(kind),
    questionIds: [],
    questionMode: null,
    questionFrom: null,
    snoozedQuestionUntil:
      kind === "question" ? null : (snoozed?.question.snoozedUntil ?? null),
    stillOnYou: kind === "question" ? null : stillOnYou(facts),
    notAssessed: null,
    failure: null,
    since,
  };
}

function questionEntry(
  facts: InboxFamilyFacts,
  open: ReturnType<typeof questionCandidates>,
  receipts: readonly InboxReceiptFacts[],
  since: number,
): InboxEntry {
  const card = baseCard(facts, "question", { kind: "answer" }, receipts, since);

  const questionMode = open.some(({ mode }) => mode === "required")
    ? "required"
    : "optional";

  const asking = open.find(({ mode }) => mode === questionMode)?.chat;
  const from = asking && !asking.isRoot ? asking.title : null;
  const running = facts.chats.find((chat) => chat.running);

  return entry(facts, {
    view: "inbox",
    card: {
      ...card,
      actions:
        questionMode === "required" ? card.actions : rowActions("result"),
      questionIds: open.map(({ question }) => question.id),
      questionMode,
      questionFrom: from,
    },
    running: running
      ? {
          label: running.runningLabel ?? "Working",
          progress: running.runningProgress,
        }
      : null,
  });
}

function runningEntry(
  facts: InboxFamilyFacts,
  chat: InboxChatFacts,
): InboxEntry {
  return entry(facts, {
    view: "running",
    running: {
      label: chat.runningLabel ?? "Working",
      progress: chat.runningProgress,
    },
  });
}

function scheduledSends(facts: InboxFamilyFacts): InboxWaitFacts[] {
  return facts.waits.filter((wait) => wait.kind === "send-later");
}

function waitingRow(
  facts: InboxFamilyFacts,
  checkingWaitId: string | null,
): InboxWaitingRow | null {
  const waits = liveWaits(facts);
  const sends = scheduledSends(facts);
  const report = waits.find((wait) => wait.kind === "report");
  const held = heldFailure(facts);
  const snoozed = snoozedQuestion(facts);
  const host = facts.chats.find((chat) => chat.hostEpisode !== null);
  const workWait = facts.chats.find((chat) => chat.waitingLabel !== null);

  const checking =
    checkingWaitId === null
      ? null
      : (waits.find((wait) => wait.id === checkingWaitId) ?? null);

  const byReturn = (a: InboxWaitFacts, b: InboxWaitFacts) =>
    (waitReturnAt(a) ?? Number.MAX_SAFE_INTEGER) -
    (waitReturnAt(b) ?? Number.MAX_SAFE_INTEGER);

  const primaryWait =
    report ??
    checking ??
    [...waits].sort(byReturn)[0] ??
    [...sends].sort(byReturn)[0] ??
    null;

  if (
    primaryWait === null &&
    held === null &&
    snoozed === null &&
    host === undefined &&
    workWait === undefined
  )
    return null;

  const returnAt = earliest([
    ...waits.map(waitReturnAt),
    ...sends.map(waitReturnAt),
    snoozed?.question.snoozedUntil ?? null,
    host?.hostEpisode?.deadline ?? null,
    held?.retryAt ?? held?.decisionDeadline ?? null,
  ]);

  const checkAt = earliest(
    waits
      .filter((wait) => wait.kind === "check" || wait.kind === "join")
      .map((wait) => wait.nextCheckAt),
  );

  const reason =
    primaryWait?.forText ??
    (held
      ? `Retrying: ${held.reason}`
      : host?.hostEpisode
        ? `Can't reach ${host.hostEpisode.hostName}`
        : snoozed
          ? snoozed.question.label
          : (workWait?.waitingLabel ?? "Waiting"));

  return {
    group: report ? "on-you" : "comes-back",
    reason,
    waitId: primaryWait?.id ?? null,
    ...(primaryWait === null ? {} : { waitThreadId: primaryWait.threadId }),
    returnAt,
    checkAt,
    checkCount: primaryWait?.checkCount ?? 0,
    checking: checking !== null,
    guaranteed: returnAt !== null,
    behind: primaryWait?.behindTitle ?? null,
    retry: held
      ? {
          at: held.retryAt,
          attempt: held.attempt,
          maxAttempts: held.maxAttempts,
        }
      : null,
    questionId: primaryWait === null ? (snoozed?.question.id ?? null) : null,
  };
}

export function decideInboxState(
  facts: InboxFamilyFacts,
): Pick<
  InboxEntry,
  | "state"
  | "reason"
  | "recap"
  | "archiveReady"
  | "optionalQuestion"
  | "pendingResults"
> {
  const assessed =
    facts.assessment.fresh && facts.assessment.availability === "available";

  const recap = assessed ? facts.assessment.recap : null;

  const receipts = ownerReceipts(facts);

  const pendingResults = receipts.filter(
    (receipt) => receipt.cause === "result",
  ).length;

  const open = questionCandidates(facts).filter(
    ({ question }) => question.snoozedUntil === null,
  );

  const optional = open.find(({ mode }) => mode === "optional");

  const result = (
    state: InboxState,
    kind: InboxReasonKind,
    text: string,
    threadId = facts.rootId,
    optionalQuestion: InboxEntry["optionalQuestion"] = optional
      ? {
          id: optional.question.id,
          label: optional.question.label,
          threadId: optional.chat.threadId,
        }
      : null,
  ) => ({
    state,
    reason: { kind, text, threadId },
    recap,
    pendingResults,
    optionalQuestion,
    archiveReady:
      state === "finished" &&
      facts.shelvedAt === null &&
      assessed &&
      facts.assessment.archiveReady &&
      facts.assessment.archiveEligible,
  });

  if (facts.archivedAt !== null) return result("archive", "none", "");

  if (facts.continuation)
    return {
      ...result(
        "finished",
        "recap",
        `Continued in ${facts.continuation.title}`,
        facts.continuation.threadId,
      ),
      recap: null,
      archiveReady: false,
      pendingResults: 0,
    };

  const required = open.find(({ mode }) => mode === "required");

  const questionResult = ({ chat, question, mode }: (typeof open)[number]) =>
    result(
      "needs-you",
      "question",
      mode === "required" && !chat.isRoot
        ? `${chat.title}: ${question.label}`
        : question.label,
      chat.threadId,
      null,
    );

  if (required) return questionResult(required);
  const failed = actionableFailure(facts);

  if (failed)
    return result(
      "failed",
      "failure",
      `Failed: ${failed.failure.reason}`,
      failed.chat.threadId,
    );
  const gap = facts.chats.find((chat) => chat.coverageGap !== null);

  if (gap)
    return result(
      "needs-you",
      "unverified",
      gap.coverageGap ?? "Work ownership could not be verified.",
      gap.threadId,
    );

  const decision = [...receipts]
    .sort((a, b) => b.seq - a.seq)
    .find((receipt) => !isWorkReport(facts, receipt));

  if (decision) {
    const proposal = facts.waits.find(
      (wait) => wait.status === "proposed" && wait.proposalKind !== null,
    );

    return result(
      "needs-you",
      "decision",
      proposal ? proposalLabel(proposal) : decision.summary,
      proposal?.threadId ?? decision.threadId,
    );
  }

  const ask = ownerAsk(facts);

  if (ask) return result("needs-you", "ask", ask);

  const checkingWaitId =
    facts.chats.find((chat) => chat.isRoot)?.checkingWaitId ?? null;

  const checking =
    checkingWaitId !== null &&
    !facts.chats.some((chat) => !chat.isRoot && chat.running);

  const running = facts.chats.find((chat) => chat.running);
  const working = facts.chats.find((chat) => chat.working);
  const snoozed = snoozedQuestion(facts);

  const activity = (chat: InboxChatFacts, badge = false) =>
    result(
      "working",
      "activity",
      chat.runningLabel ?? "Working",
      chat.threadId,
      badge && optional
        ? {
            id: optional.question.id,
            label: optional.question.label,
            threadId: optional.chat.threadId,
          }
        : null,
    );

  const waiting = (row: InboxWaitingRow) =>
    result("waiting", "wait", row.reason);

  if (working && !checking) {
    const row = snoozed?.mode === "required" ? waitingRow(facts, null) : null;

    return row ? waiting(row) : activity(running ?? working, true);
  }

  const owesDelivery = facts.shelvedAt === null && facts.waiters.length > 0;
  const deliver = () => result("waiting", "deliver", deliverReason(facts));

  if (receipts.length > 0) {
    const continues =
      liveWaits(facts).length > 0 ||
      running !== undefined ||
      facts.chats.some((chat) => chat.waitingLabel !== null);

    if (owesDelivery && !continues) return deliver();

    if (continues)
      return running
        ? activity(running)
        : result(
            "waiting",
            "wait",
            waitingRow(facts, checkingWaitId)?.reason ?? "Waiting",
          );
  } else {
    if (checking) {
      const row = waitingRow(facts, checkingWaitId);

      if (row) return waiting(row);
    }

    if (snoozed !== null && (snoozed.mode === "required" || !running)) {
      const row = waitingRow(facts, null);

      if (row) return waiting(row);
    }

    if (running) return activity(running);
    const row = waitingRow(facts, null);

    if (row) return waiting(row);

    if (owesDelivery) return deliver();

    if (facts.shelvedAt !== null) return result("resting", "none", "");
  }

  if (assessed)
    return result("finished", "recap", recap || facts.assessment.reason);
  const missing = notAssessedReason(facts);

  return result(
    "finished",
    "unassessed",
    `Finished, not assessed${missing ? `: ${missing}` : ""}`,
  );
}

export function projectInboxFamily(facts: InboxFamilyFacts): InboxEntry {
  if (facts.archivedAt !== null) return entry(facts, { view: "archive" });

  if (facts.continuation)
    return entry(facts, {
      view: facts.shelvedAt === null ? "inbox" : "resting",
      card: baseCard(
        facts,
        "result",
        { kind: "your-call" },
        [],
        facts.createdAt,
      ),
    });

  const receipts = ownerReceipts(facts).sort((a, b) => a.seq - b.seq);
  const firstAt = receipts[0]?.createdAt ?? facts.createdAt;

  const open = questionCandidates(facts).filter(
    ({ question }) => question.snoozedUntil === null,
  );

  if (open.some(({ mode }) => mode === "required"))
    return questionEntry(facts, open, receipts, firstAt);

  const failed = actionableFailure(facts);

  if (failed) {
    const { chat, failure } = failed;

    const primary: InboxPrimary = failure.canResume
      ? {
          kind: "resume",
          targetThreadId: chat.threadId,
          targetTitle: chat.isRoot ? null : chat.title,
        }
      : {
          kind: "problem-chooser",
          targetThreadId: chat.threadId,
          retryAllowed: !failure.outwardEffectRan,
        };

    const card = baseCard(facts, "problem", primary, receipts, firstAt);

    return entry(facts, {
      view: "inbox",
      card: { ...card, failure: failureSummary(chat, failure) },
      incident:
        failure.incident === null ? null : { ...failure.incident, members: [] },
    });
  }

  const gap = facts.chats.find((chat) => chat.coverageGap !== null);

  if (gap) {
    const card = baseCard(
      facts,
      "problem",
      { kind: "your-call" },
      receipts,
      firstAt,
    );

    return entry(facts, {
      view: "inbox",
      card: {
        ...card,
        failure: {
          threadId: gap.threadId,
          reason: gap.coverageGap ?? "Work ownership could not be verified.",
          queuedCount: 0,
          scheduledCount: 0,
        },
      },
    });
  }

  if (open.length > 0) return questionEntry(facts, open, receipts, firstAt);

  if (ownerAsk(facts) !== null) {
    const card = baseCard(
      facts,
      cardKind(receipts),
      resultPrimary(facts, receipts),
      receipts,
      firstAt,
    );

    return entry(facts, { view: "inbox", card });
  }

  const running = facts.chats.find((chat) => chat.running);
  const snoozed = snoozedQuestion(facts);

  const checkingWaitId =
    facts.chats.find((chat) => chat.isRoot)?.checkingWaitId ?? null;

  const descendantOwnerWork = facts.chats.some(
    (chat) => !chat.isRoot && chat.running,
  );

  const checking = checkingWaitId !== null && !descendantOwnerWork;
  const working = facts.chats.find((chat) => chat.working);

  const onlyWorkReports = receipts.every((receipt) =>
    isWorkReport(facts, receipt),
  );

  if (working && !checking && onlyWorkReports) {
    const row = snoozed?.mode === "required" ? waitingRow(facts, null) : null;

    return row
      ? entry(facts, { view: "waiting", waiting: row })
      : runningEntry(facts, running ?? working);
  }

  if (receipts.length > 0) {
    const kind = cardKind(receipts);
    const primary = resultPrimary(facts, receipts);

    if (
      ((!running && !working) || checking) &&
      primary.kind === "ok" &&
      receipts.every((receipt) => receipt.cause === "result") &&
      (liveWaits(facts).some((wait) => wait.kind !== "report") ||
        facts.chats.some((chat) => chat.waitingLabel !== null))
    ) {
      const row = waitingRow(facts, checkingWaitId);

      if (row) return entry(facts, { view: "waiting", waiting: row });
    }

    const card = baseCard(facts, kind, primary, receipts, firstAt);

    return entry(facts, {
      view: "inbox",
      card: { ...card, notAssessed: notAssessedReason(facts) },
    });
  }

  if (checking) {
    const row = waitingRow(facts, checkingWaitId);

    if (row) return entry(facts, { view: "waiting", waiting: row });
  }

  if (snoozed !== null && (snoozed.mode === "required" || !running)) {
    const row = waitingRow(facts, null);

    if (row) return entry(facts, { view: "waiting", waiting: row });
  }

  if (running) return runningEntry(facts, running);

  const row = waitingRow(facts, null);

  if (row) return entry(facts, { view: "waiting", waiting: row });

  if (facts.shelvedAt !== null) return entry(facts, { view: "resting" });

  const card = baseCard(
    facts,
    "result",
    resultPrimary(facts, []),
    [],
    facts.createdAt,
  );

  return entry(facts, {
    view: "inbox",
    card: { ...card, notAssessed: notAssessedReason(facts) },
  });
}

function compareCards(a: InboxEntry, b: InboxEntry): number {
  const aq = a.card?.kind === "question" ? 0 : 1;
  const bq = b.card?.kind === "question" ? 0 : 1;

  if (aq !== bq) return aq - bq;

  if (a.sortAt !== b.sortAt) return a.sortAt - b.sortAt;

  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

function compareWaiting(a: InboxEntry, b: InboxEntry): number {
  const ag = a.waiting?.group === "on-you" ? 0 : 1;
  const bg = b.waiting?.group === "on-you" ? 0 : 1;

  if (ag !== bg) return ag - bg;

  const ar = a.waiting?.returnAt ?? Number.MAX_SAFE_INTEGER;
  const br = b.waiting?.returnAt ?? Number.MAX_SAFE_INTEGER;

  if (ar !== br) return ar - br;

  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

function memberOf(item: InboxEntry): InboxGroupMember {
  return {
    threadId: item.threadId,
    title: item.title,
    primary: item.card?.primary ?? { kind: "your-call" },
    causes: item.card?.causes ?? [],
    since: item.card?.since ?? item.sortAt,
    latch: item.latch,
  };
}

function strongestMember(
  members: readonly InboxEntry[],
): Pick<
  InboxEntry,
  "state" | "reason" | "recap" | "archiveReady" | "pendingResults"
> {
  const rank: Record<InboxState, number> = {
    "needs-you": 0,
    failed: 1,
    working: 2,
    waiting: 3,
    finished: 4,
    resting: 5,
    archive: 6,
  };

  const strongest = members.reduce<InboxEntry | null>(
    (best, member) =>
      best === null || rank[member.state] < rank[best.state] ? member : best,
    null,
  );

  if (strongest === null) throw new Error("Inbox group has no members");

  return {
    state: strongest.state,
    reason: strongest.reason,
    recap: strongest.recap,
    archiveReady:
      strongest.state === "finished" &&
      members.some((member) => member.archiveReady),
    pendingResults: members.reduce(
      (sum, member) => sum + member.pendingResults,
      0,
    ),
  };
}

function groupIncidents(entries: readonly InboxEntry[]): InboxEntry[] {
  const groups = new Map<string, InboxEntry[]>();
  const rest: InboxEntry[] = [];

  for (const item of entries)
    if (item.card?.kind === "problem" && item.incident !== null)
      groups.set(item.incident.key, [
        ...(groups.get(item.incident.key) ?? []),
        item,
      ]);
    else rest.push(item);

  for (const members of groups.values()) {
    const ordered = [...members].sort(
      (a, b) => a.sortAt - b.sortAt || a.threadId.localeCompare(b.threadId),
    );

    const first = ordered[0];

    if (members.length < 2 || first?.card == null || first.incident === null) {
      rest.push(...members.map((item) => ({ ...item, incident: null })));

      continue;
    }

    const resetAt = ordered.every(
      (item) => item.incident?.resetAt === first.incident?.resetAt,
    )
      ? first.incident.resetAt
      : null;

    const group = ordered.map(memberOf);

    rest.push({
      ...first,
      ...strongestMember(ordered),
      card: {
        ...first.card,
        actions: [],
        primary:
          resetAt === null
            ? first.card.primary
            : {
                kind: "resume-all-at-reset",
                resetAt,
                threadIds: ordered.map((item) => item.threadId),
              },
        causes: ordered.flatMap((item) => item.card?.causes ?? []),
      },
      incident: { ...first.incident, resetAt, members: group },
      latch: ["incident", ...group.map((member) => member.latch)].join("|"),
    });
  }

  return rest;
}

function groupRuns(entries: readonly InboxEntry[]): InboxEntry[] {
  const groups = new Map<string, InboxEntry[]>();
  const rest: InboxEntry[] = [];

  for (const item of entries) {
    const kind = item.card?.kind;

    if (
      item.automationId !== null &&
      (kind === "result" || kind === "returned") &&
      item.card?.primary.kind !== "accept-proposal"
    )
      groups.set(item.automationId, [
        ...(groups.get(item.automationId) ?? []),
        item,
      ]);
    else rest.push(item);
  }

  for (const members of groups.values()) {
    if (members.length < 2) {
      rest.push(...members);

      continue;
    }

    const ordered = [...members].sort(
      (a, b) => a.sortAt - b.sortAt || a.threadId.localeCompare(b.threadId),
    );

    const latest = ordered.at(-1);
    const first = ordered[0];

    if (latest === undefined || first === undefined || latest.card === null)
      continue;

    const done = ordered.filter(
      (item) => item.card?.primary.kind === "archive",
    );

    const older = ordered.slice(0, -1);

    const primary: InboxPrimary =
      done.length > 0
        ? {
            kind: "archive-runs",
            mode: "done",
            threadIds: done.map((item) => item.threadId),
          }
        : {
            kind: "archive-runs",
            mode: "older",
            threadIds: older.map((item) => item.threadId),
          };

    const runs = ordered.map(memberOf);

    rest.push({
      ...latest,
      ...strongestMember(ordered),
      card: {
        ...latest.card,
        kind: "runs",
        actions: [],
        primary,
        causes: ordered.flatMap((item) => item.card?.causes ?? []),
        since: first.sortAt,
      },
      runs,
      sortAt: first.sortAt,
      latch: ["runs", ...runs.map((run) => run.latch)].join("|"),
    });
  }

  return rest;
}

export function buildInboxSnapshot(args: {
  entries: readonly InboxEntry[];
  now: number;
  revision: string;
  lastMove: InboxSnapshot["lastMove"];
}): InboxSnapshot {
  const inbox = groupIncidents(
    groupRuns(args.entries.filter((item) => item.view === "inbox")),
  ).sort(compareCards);

  const waiting = args.entries
    .filter((item) => item.view === "waiting")
    .sort(compareWaiting);

  const running = args.entries
    .filter((item) => item.view === "running")
    .sort((a, b) => a.sortAt - b.sortAt);

  const shelf = args.entries
    .filter((item) => item.shelved)
    .sort((a, b) => a.sortAt - b.sortAt);

  const nextBackAt = earliest(
    waiting.map((item) =>
      item.waiting?.guaranteed ? item.waiting.returnAt : null,
    ),
  );

  return {
    revision: args.revision,
    generatedAt: args.now,
    inbox,
    waiting,
    running,
    shelf,
    counts: {
      needsYou: inbox.filter((item) => item.state === "needs-you").length,
      inbox: inbox.length,
      questions: inbox.filter((item) => item.card?.kind === "question").length,
      running: running.length,
      waiting: waiting.length,
      onYou: waiting
        .filter((item) => item.waiting?.group === "on-you")
        .map((item) => item.waiting?.reason ?? item.title),
      nextBackAt,
    },
    lastMove: args.lastMove,
  };
}

export function displayedReceiptIds(
  card: Pick<InboxCard, "causes">,
  focused: boolean,
): string[] {
  const ids = card.causes.map((cause) => cause.receiptId);

  return focused ? ids : ids.slice(0, INBOX_DISPLAY_MAX);
}

export function nextCheckInterval(previousMs: number, firstMs: number): number {
  const base = previousMs <= 0 ? firstMs : previousMs * 2;

  return Math.min(base, INBOX_CHECK_MAX_INTERVAL_MS);
}

export const INBOX_CORE_EVENT_FAMILIES = [
  "host-reconnect",
  "coordinator-version",
  "automation-run",
] as const;

export const INBOX_EVENT_FAMILY_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export const INBOX_EVENT_POLL_MIN_MS = 60_000;

export const INBOX_EVENT_KEY_MAX = 500;

export function splitEventKey(
  key: string,
): { family: string; target: string } | null {
  const index = key.indexOf(":");

  if (index <= 0) return null;

  return { family: key.slice(0, index), target: key.slice(index + 1) };
}

export const INBOX_CALLER_THREAD_HEADER = "x-omnyo-caller-thread-id";

export const INBOX_CALLER_AUTOMATION_HEADER = "x-omnyo-automation-id";

export const INBOX_CALLER_AUTOMATION_RUN_HEADER = "x-omnyo-automation-run-id";

export const INBOX_CALLER_PLUGIN_HEADER = "x-omnyo-caller-plugin";

const receiptIdsSchema = z.array(z.string().min(1)).max(200);

const latchSchema = z.string().min(1).optional();

export const inboxActRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ok"),
    threadId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("archive"),
    threadId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    stopRunning: z.boolean().default(false),
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("wait"),
    threadId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    until: z.number().int().positive(),
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("wait-report"),
    threadId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    event: z.string().trim().min(1).max(INBOX_FOR_TEXT_MAX),
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("accept-proposal"),
    threadId: z.string().min(1),
    waitId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("keep-waiting"),
    threadId: z.string().min(1),
    waitId: z.string().min(1),
    until: z.number().int().positive(),
    displayedReceiptIds: receiptIdsSchema,
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("remind-later"),
    threadId: z.string().min(1),
    waitId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("happened"),
    threadId: z.string().min(1),
    waitId: z.string().min(1),
    note: z.string().trim().max(4000).nullable().default(null),
  }),
  z.object({
    action: z.literal("shelf"),
    threadId: z.string().min(1),
    shelved: z.boolean(),
  }),
  z.object({
    action: z.literal("snooze-question"),
    threadId: z.string().min(1),
    questionId: z.string().min(1),
    until: z.number().int().positive(),
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("cancel-wait"),
    threadId: z.string().min(1),
    waitId: z.string().min(1),
  }),
  z.object({
    action: z.literal("resume"),
    threadId: z.string().min(1),
    targetThreadId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("continue-with-result"),
    threadId: z.string().min(1),
    waitId: z.string().min(1),
    displayedReceiptIds: receiptIdsSchema,
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("archive-runs"),
    threadId: z.string().min(1),
    threadIds: z.array(z.string().min(1)).min(1).max(100),
    latch: latchSchema,
  }),
  z.object({
    action: z.literal("resume-all-at-reset"),
    threadId: z.string().min(1),
    threadIds: z.array(z.string().min(1)).min(2).max(100),
    latch: latchSchema,
  }),
]);

export type InboxActRequest = z.infer<typeof inboxActRequestSchema>;

export const inboxIncidentSchema = z.object({
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(INBOX_FOR_TEXT_MAX),
  resetAt: z.number().int().positive().nullable(),
});

export type InboxIncident = z.infer<typeof inboxIncidentSchema>;

export const inboxRetryDeclineRequestSchema = z.object({
  turnRequestId: z.string().min(1).nullable(),
  reason: z.string().trim().min(1).max(500),
  incident: inboxIncidentSchema.nullable(),
});

export type InboxRetryDeclineRequest = z.infer<
  typeof inboxRetryDeclineRequestSchema
>;

export const inboxPendingEventsQuerySchema = z.object({
  prefix: z.string().trim().min(1).max(100),
});

export type InboxPendingEventsQuery = z.infer<
  typeof inboxPendingEventsQuerySchema
>;

export const inboxPendingEventsResponseSchema = z.object({
  keys: z.array(z.string()),
});

export type InboxPendingEventsResponse = z.infer<
  typeof inboxPendingEventsResponseSchema
>;

export const inboxEventReportRequestSchema = z.object({
  key: z.string().trim().min(1).max(300),
  result: z.string().trim().min(1).max(2000),
});

export type InboxEventReportRequest = z.infer<
  typeof inboxEventReportRequestSchema
>;

export const inboxEventSourceViewSchema = z.object({
  family: z.string(),
  owner: z.string(),
  label: z.string(),
  keyFormat: z.string(),
  examples: z.array(z.string()),
  approval: z.enum(["none", "owner"]),
  kind: z.enum(["poll", "push"]),
  everyMs: z.number().nullable(),
  pendingKeys: z.number().int().nonnegative(),
  health: z.object({
    state: z.enum(["idle", "ok", "failing", "proof-failed"]),
    lastCheckAt: z.number().nullable(),
    lastOkAt: z.number().nullable(),
    lastError: z.string().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    proof: z.string().nullable(),
  }),
});

export type InboxEventSourceView = z.infer<typeof inboxEventSourceViewSchema>;

export const inboxEventSourcesResponseSchema = z.object({
  sources: z.array(inboxEventSourceViewSchema),
});

export type InboxEventSourcesResponse = z.infer<
  typeof inboxEventSourcesResponseSchema
>;

export const inboxEventCheckRequestSchema = z.object({
  key: z.string().trim().min(1).max(INBOX_EVENT_KEY_MAX),
});

export type InboxEventCheckRequest = z.infer<
  typeof inboxEventCheckRequestSchema
>;

export const inboxEventCheckResponseSchema = z.object({
  key: z.string(),
  family: z.string().nullable(),
  valid: z.boolean(),
  error: z.string().nullable(),
  describe: z.string().nullable(),
  kind: z.enum(["poll", "push"]).nullable(),
  approval: z.enum(["none", "owner"]).nullable(),
  fired: z.boolean().nullable(),
  result: z.string().nullable(),
});

export type InboxEventCheckResponse = z.infer<
  typeof inboxEventCheckResponseSchema
>;

export const inboxEventReportResponseSchema = z.object({
  resumed: z.number().int().nonnegative(),
});

export type InboxEventReportResponse = z.infer<
  typeof inboxEventReportResponseSchema
>;

export const inboxRetryDeclineResponseSchema = z.object({
  state: z.enum(["actionable", "none"]),
});

export type InboxRetryDeclineResponse = z.infer<
  typeof inboxRetryDeclineResponseSchema
>;

export const inboxActResultSchema = z.object({
  moveId: z.string().nullable(),
  entry: inboxEntrySchema.nullable(),
});

export type InboxActResult = z.infer<typeof inboxActResultSchema>;

export const inboxUndoRequestSchema = z.object({ moveId: z.string().min(1) });

export type InboxUndoRequest = z.infer<typeof inboxUndoRequestSchema>;

export const inboxWaitViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  generation: z.number().int(),
  kind: inboxWaitKindSchema,
  status: inboxWaitStatusSchema,
  forText: z.string(),
  marker: z.string(),
  deadline: z.number().nullable(),
  nextCheckAt: z.number().nullable(),
  checkCount: z.number().int(),
  createdBy: inboxWaitCreatorSchema,
  ownerAccepted: z.boolean(),
  conditions: z.array(
    z.object({
      key: z.string(),
      kind: z.string(),
      label: z.string(),
      met: z.boolean(),
    }),
  ),
});

export type InboxWaitView = z.infer<typeof inboxWaitViewSchema>;

export const inboxWaitRegisterRequestSchema = z.object({
  key: z.string().trim().min(1).max(200),
  for: z.string().trim().min(1).max(INBOX_FOR_TEXT_MAX),
  chats: z.array(z.string().min(1)).max(20).default([]),
  events: z
    .array(z.string().min(1).max(INBOX_EVENT_KEY_MAX))
    .max(20)
    .default([]),
  check: z
    .object({
      what: z.string().trim().min(1).max(500),
      at: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  report: z
    .string()
    .trim()
    .min(1)
    .max(INBOX_FOR_TEXT_MAX)
    .nullable()
    .default(null),
  readiness: z.enum(["all", "any"]).default("all"),
  by: z.number().int().positive().nullable().default(null),
  resume: z.string().trim().min(1).max(2000).nullable().default(null),
  after: z.string().min(1).nullable().default(null),
});

export type InboxWaitRegisterRequest = z.infer<
  typeof inboxWaitRegisterRequestSchema
>;

export const inboxWaitRegisterResponseSchema = z.object({
  wait: inboxWaitViewSchema,
  existing: z.boolean(),
});

export type InboxWaitRegisterResponse = z.infer<
  typeof inboxWaitRegisterResponseSchema
>;

export const inboxWaitListResponseSchema = z.object({
  waitingChatIds: z.array(z.string()).optional(),
  waits: z.array(inboxWaitViewSchema),
});

export type InboxWaitListResponse = z.infer<typeof inboxWaitListResponseSchema>;

export const inboxWaitMetRequestSchema = z.object({
  condition: z.string().min(1),
  result: z.string().max(8000).nullable().default(null),
});

export type InboxWaitMetRequest = z.infer<typeof inboxWaitMetRequestSchema>;

export const inboxWaitActionResponseSchema = z.object({
  wait: inboxWaitViewSchema,
  proposed: z.boolean(),
});

export type InboxWaitActionResponse = z.infer<
  typeof inboxWaitActionResponseSchema
>;

export const inboxWaitDetailResponseSchema = z.object({
  wait: inboxWaitViewSchema,
  closedReason: z.string().nullable(),
});

export type InboxWaitDetailResponse = z.infer<
  typeof inboxWaitDetailResponseSchema
>;

export const INBOX_PRODUCER_LABEL_MAX = 120;

export const inboxProducerStartRequestSchema = z.object({
  kind: inboxProducerKindSchema,
  label: z.string().trim().min(1).max(INBOX_PRODUCER_LABEL_MAX),
});

export type InboxProducerStartRequest = z.infer<
  typeof inboxProducerStartRequestSchema
>;

export const inboxProducerSettleRequestSchema = z.object({
  verdict: inboxProducerVerdictSchema,
  summary: z.string().trim().min(1).max(500),
});

export type InboxProducerSettleRequest = z.infer<
  typeof inboxProducerSettleRequestSchema
>;

export const inboxProducerViewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  kind: inboxProducerKindSchema,
  label: z.string(),
  status: z.enum(["active", "ended"]),
  heldUntil: z.number().nullable(),
  endedReason: z.string().nullable(),
});

export type InboxProducerView = z.infer<typeof inboxProducerViewSchema>;

export const inboxProducerResponseSchema = z.object({
  producer: inboxProducerViewSchema,
  receiptId: z.string().nullable(),
});

export type InboxProducerResponse = z.infer<typeof inboxProducerResponseSchema>;

export const INBOX_WAIT_MARKER_PATTERN =
  /\[(?:(?:omnyo|bb) wait [0-9a-f-]{36}|callback-wait:[0-9a-f-]{36})\]/;
