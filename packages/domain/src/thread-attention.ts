import { z } from "zod";
import { pluginIdSchema } from "./plugin-id.js";

const nonBlank = z.string().trim().min(1);

export const threadQuestionOptionSchema = z.object({
  value: nonBlank.max(120),
  label: nonBlank.max(120),
  description: z.string().max(2000).nullable().default(null),
  preview: z.string().max(4096).nullable().default(null),
  recommended: z.boolean().default(false),
});

export const threadQuestionInputSchema = z
  .object({
    key: nonBlank.max(120).nullable().default(null),
    prompt: nonBlank.max(2000),
    context: z.string().max(4096).nullable().default(null),
    shortLabel: nonBlank.max(120).default("Question"),
    mode: z.enum(["required", "optional"]),
    multiSelect: z.boolean().default(false),
    allowFreeText: z.boolean().default(true),
    additiveNotes: z.boolean().default(true),
    options: z.array(threadQuestionOptionSchema).max(8).default([]),
    delegable: z.boolean().default(false),
  })
  .superRefine((question, ctx) => {
    if (question.multiSelect && question.options.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "Multi-select questions need options",
      });

    if (!question.allowFreeText && question.options.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "Provide choices or allow a text answer",
      });

    if (question.options.length === 1)
      ctx.addIssue({
        code: "custom",
        message: "Provide at least two distinct choices or a text question",
      });
    const labels = question.options.map((option) => option.label.toLowerCase());
    const values = question.options.map((option) => option.value);

    if (
      new Set(labels).size !== labels.length ||
      new Set(values).size !== values.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Question options must be unique",
      });

    if (question.options.filter((option) => option.recommended).length > 1)
      ctx.addIssue({ code: "custom", message: "Recommend at most one option" });
  });

export const threadQuestionAnswerSchema = z.object({
  selected: z.array(nonBlank).max(8),
  freeText: nonBlank.max(4096).optional(),
});

export const threadQuestionAnsweredBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("thread"), threadId: nonBlank }),
  z.object({ kind: z.literal("automation"), automationId: nonBlank }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: pluginIdSchema,
    ruleId: nonBlank.max(120),
    reason: nonBlank.max(200),
  }),
]);

export const threadQuestionSchema = z.object({
  id: nonBlank,
  threadId: nonBlank,
  revision: z.number().int().positive(),
  question: threadQuestionInputSchema,
  state: z.enum(["open", "answered", "skipped", "withdrawn"]),
  answer: threadQuestionAnswerSchema.nullable(),
  queuedMessageId: z.string().nullable(),
  answeredBy: threadQuestionAnsweredBySchema.nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const threadCallbackSchema = z.object({
  id: nonBlank,
  threadId: nonBlank,
  sourceThreadId: nonBlank.nullable(),
  sourceTitle: z.string(),
  reason: nonBlank.max(500),
  createdAt: z.number(),
  afterSeq: z.number(),
  matchText: nonBlank.max(240),
  sourceState: z.enum([
    "working",
    "waiting",
    "needs-input",
    "idle",
    "error",
    "archived",
    "unavailable",
    "unverified",
  ]),
});

export const threadAttentionSchema = z.object({
  kind: z.enum([
    "none",
    "required-answer",
    "optional-input",
    "callback-waiting",
    "dependency-failed",
  ]),
  requiredCount: z.number().int().nonnegative(),
  optionalCount: z.number().int().nonnegative(),
  callback: threadCallbackSchema.nullable(),
});

export const threadAttentionSnapshotSchema = z.object({
  questions: z.array(threadQuestionSchema),
  callbacks: z.array(threadCallbackSchema),
});

export type ThreadQuestion = z.infer<typeof threadQuestionSchema>;

export type ThreadQuestionInput = z.infer<typeof threadQuestionInputSchema>;

export type ThreadQuestionAnswer = z.infer<typeof threadQuestionAnswerSchema>;

export type ThreadQuestionAnsweredBy = z.infer<
  typeof threadQuestionAnsweredBySchema
>;

export type ThreadCallback = z.infer<typeof threadCallbackSchema>;

export type ThreadAttention = z.infer<typeof threadAttentionSchema>;

export type ThreadAttentionSnapshot = z.infer<
  typeof threadAttentionSnapshotSchema
>;

export const threadAttentionResultSchema = threadAttentionSnapshotSchema.extend(
  {
    cleared: z.boolean(),
    callbackMarker: z.string().nullable(),
    routedToThreadId: z.string().nullable(),
  },
);

export type ThreadAttentionResult = z.infer<typeof threadAttentionResultSchema>;

export const legacyAttentionDecisionSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  key: z.string().nullable(),
  question: z.string(),
  context: z.string().nullable(),
  multi_select: z.number(),
  allow_text: z.number(),
  options_json: z.string(),
  state: z.enum(["open", "answered", "skipped", "withdrawn"]),
  answer_json: z.string().nullable(),
  created_at: z.number(),
  answered_at: z.number().nullable(),
  revision: z.number().default(1),
});

export const legacyAttentionOptionsSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    recommended: z.boolean(),
  }),
);

export const legacyAttentionAnswerSchema = z.object({
  optionIds: z.array(z.string()),
  text: z.string().nullable(),
});

export const legacyAttentionCallbackSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sourceThreadId: z.string(),
  reason: z.string(),
  createdAt: z.number(),
  afterSeq: z.number(),
  matchText: z.string(),
});

export const legacyAttentionExternalSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sourceTitle: z.string(),
  reason: z.string(),
  createdAt: z.number(),
});
