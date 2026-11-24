import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

const archiveReadinessSchema = z
  .object({
    ready: z.boolean(),
    reason: z.string().trim().min(1).max(1000),
    waitingOn: z.string().trim().min(1).max(120).nullable().default(null),
    ask: z.string().trim().min(1).max(200).nullable().default(null),
    recap: z.string().trim().min(1).max(400).nullable().default(null),
  })
  .strict();

export function archiveVerdictLabel(
  readiness: z.infer<typeof archiveReadinessSchema>,
): string {
  if (readiness.ready) return "Likely ready to archive";

  return readiness.waitingOn === null
    ? "More work remains"
    : `Waiting on ${readiness.waitingOn}`;
}

export const predictionSchema = z.object({
  threadId: z.string(),
  generation: z.number().int().nonnegative(),
  basis: z.string().nullable().default(null),
  status: z.enum(["idle", "predicting", "ready", "none", "failed", "disabled"]),
  text: z.string().nullable(),
  noSuggestionReason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .nullable()
    .default(null),
  message: z.string().nullable(),
  archiveReadiness: archiveReadinessSchema.nullable(),
  assessmentVersion: z.number().int().nonnegative().optional(),
  forced: z.boolean().optional(),
});

export type PredictionState = z.infer<typeof predictionSchema>;

export const ASSESSMENT_VERSION = 3;

export const nativeFailureSchema = z
  .object({
    status: z.enum([
      "completed",
      "interrupted",
      "failed",
      "inProgress",
      "unknown",
    ]),
    code: z.enum([
      "contextWindowExceeded",
      "sessionBudgetExceeded",
      "usageLimitExceeded",
      "serverOverloaded",
      "cyberPolicy",
      "misalignmentPolicyViolation",
      "internalServerError",
      "unauthorized",
      "badRequest",
      "threadRollbackFailed",
      "sandboxError",
      "other",
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
      "activeTurnNotSteerable",
      "unknown",
    ]),
    httpStatus: z.number().int().min(100).max(599).nullable(),
  })
  .strict();

export const predictionFailureCauseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("timeout"),
      timeoutMs: z.number().nonnegative().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("native") }).strict(),
  z
    .object({
      kind: z.literal("http"),
      status: z.number().int().min(100).max(599),
    })
    .strict(),
  z
    .object({
      kind: z.literal("transport"),
      code: z.enum([
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native-rpc"),
      code: z.number().int().min(-32768).max(32767),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native-process"),
      code: z.enum([
        "start_failed",
        "exited",
        "connection_closed",
        "session_closed",
        "invalid_message",
        "notification_failed",
        "invalid_prediction",
        "invalid_lineage",
        "source_model_changed",
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);

export const predictionFailureSchema = z
  .object({
    threadId: z.string(),
    generation: z.number().int().nonnegative(),
    sourceSeq: z.number().int().nullable(),
    hostId: z.string().nullable(),
    requestId: z.string().uuid().nullable(),
    stage: z.enum(["preparation", "inference", "validation"]),
    failedAt: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative().nullable(),
    attempt: z.number().int().nonnegative(),
    retryAt: z.number().int().nullable(),
    message: z.string(),
    native: nativeFailureSchema.nullable(),
    cause: predictionFailureCauseSchema.nullable().default(null),
  })
  .strict();

const predictionSkipReasonSchema = z.enum([
  "busy",
  "queued",
  "awaiting-answer",
  "closed",
  "child",
  "hidden",
  "no-environment",
  "no-completed-turn",
  "owned-work",
  "changed",
]);

export type PredictionSkipReason = z.infer<typeof predictionSkipReasonSchema>;

export const predictionSkipMessages: Record<PredictionSkipReason, string> = {
  busy: "The chat was still running.",
  queued: "The chat had queued work.",
  "awaiting-answer": "The chat was waiting for an answer.",
  closed: "The chat was archived or deleted.",
  child: "Background predictions skip child chats.",
  hidden: "Background predictions skip hidden chats.",
  "no-environment": "The chat had no available environment.",
  "no-completed-turn": "The chat's last turn did not complete.",
  "owned-work": "The chat still owned running or waiting work.",
  changed: "The chat changed before the prediction finished.",
};

export const predictionSkipSchema = z
  .object({
    threadId: z.string(),
    sourceSeq: z.number().int().nullable(),
    skippedAt: z.number().int().nonnegative(),
    reason: predictionSkipReasonSchema,
    message: z.string(),
  })
  .strict();

export const predictionDiagnosticsSchema = z
  .object({
    threadId: z.string(),
    lastFailure: predictionFailureSchema.nullable(),
    lastSkip: predictionSkipSchema.nullable(),
  })
  .strict();

const threadInput = z.object({ threadId: z.string().min(1) }).strict();

const generationInput = threadInput.extend({
  generation: z.number().int().nonnegative(),
});

export const rpcContract = defineRpcContract({
  state: {
    input: threadInput,
    output: predictionSchema,
    experimental_threadBootstrap: true,
  },
  request: {
    input: threadInput.extend({
      fresh: z.boolean().default(false),
      force: z.boolean().default(false),
    }),
    output: predictionSchema,
  },
  diagnostics: { input: threadInput, output: predictionDiagnosticsSchema },
  dismiss: { input: generationInput, output: predictionSchema },
  cancel: { input: generationInput, output: predictionSchema },
});

export const poolPredictionSchema = z
  .object({
    text: z.string().nullable(),
    noSuggestionReason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .nullable()
      .default(null),
    promptVersion: z.string(),
    archiveReadiness: archiveReadinessSchema.nullable(),
    tag: z.string().nullable().default(null),
  })
  .strict();
