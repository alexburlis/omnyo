import { z } from "zod";
import {
  threadQuestionInputSchema,
  threadQuestionAnswerSchema,
} from "@omnyo/domain";

const delegation = z.object({
  ruleId: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(200),
});

const identity = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
});

export const attentionCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    questions: z.array(threadQuestionInputSchema).min(1).max(10),
  }),
  identity.extend({
    action: z.literal("update"),
    question: threadQuestionInputSchema,
  }),
  identity.extend({
    action: z.literal("answer"),
    answer: threadQuestionAnswerSchema,
    delegation: delegation.optional(),
  }),
  z.object({
    action: z.literal("answers"),
    answers: z
      .array(identity.extend({ answer: threadQuestionAnswerSchema.nullable() }))
      .min(1)
      .max(20),
    delegation: delegation.optional(),
  }),
  identity.extend({ action: z.literal("skip") }),
  identity.extend({ action: z.literal("withdraw") }),
  z.object({
    action: z.literal("wait"),
    sourceThreadId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({ action: z.literal("clear"), id: z.string().min(1) }),
]);

export type AttentionCommand = z.infer<typeof attentionCommandSchema>;
