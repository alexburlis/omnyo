import { z } from "zod";
import { attentionViewSchema } from "./rpc.js";

export const RUN_DECISION_RENDERER_ID = "run-decision";

export const runDecisionPayloadSchema = attentionViewSchema.extend({
  lastError: z.string().nullable(),
});

export const runDecisionAnswerSchema = z.strictObject({
  decision: z.string().min(1).max(256),
  evidence: z.string().max(4000),
});

export type RunDecisionPayload = z.infer<typeof runDecisionPayloadSchema>;

export type RunDecisionAnswer = z.infer<typeof runDecisionAnswerSchema>;
