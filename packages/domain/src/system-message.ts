import { z } from "zod";
import { pluginIdSchema } from "./plugin-id.js";

export const generatedThreadMessageSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("script"),
    label: z.string().trim().min(1).max(120),
  }),
  z.object({ kind: z.literal("plugin"), pluginId: pluginIdSchema }),
]);

export const threadMessageSourceSchema = z.union([
  z.object({ kind: z.literal("user") }),
  generatedThreadMessageSourceSchema,
]);

export type ThreadMessageSource = z.infer<typeof threadMessageSourceSchema>;

const systemMessageKindValues = [
  "external-message",
  "ownership-assigned",
  "ownership-removed",
  "child-needs-attention",
  "child-completed",
  "child-failed",
  "child-interrupted",
  "child-outcome-batch",
  "tool-result-delivered",
  "unlabeled",
] as const;

export const systemMessageKindSchema = z.enum(systemMessageKindValues);

export type SystemMessageKind = z.infer<typeof systemMessageKindSchema>;

export const systemThreadInterruptedReasonSchema = z.enum([
  "manual-stop",
  "app-update",
  "host-daemon-restarted",
  "host-removed",
  "provider-turn-idle",
]);

export type SystemThreadInterruptedReason = z.infer<
  typeof systemThreadInterruptedReasonSchema
>;

export const childThreadOutcomeSchema = z.object({
  threadId: z.string(),
  status: z.enum(["completed", "failed", "interrupted"]),
  interruption: z
    .object({
      reason: systemThreadInterruptedReasonSchema,
      cause: z.literal("host-connection-lost").optional(),
    })
    .optional(),
});

export type ChildThreadOutcome = z.infer<typeof childThreadOutcomeSchema>;

export const systemMessageSubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message-source"),
    source: generatedThreadMessageSourceSchema,
  }),
  z.object({
    kind: z.literal("thread"),
    threadId: z.string(),
    threadName: z.string(),
    outcomes: z.array(childThreadOutcomeSchema).optional(),
  }),
  z.object({
    kind: z.literal("thread-batch"),
    count: z.number(),
    outcomes: z.array(childThreadOutcomeSchema).optional(),
  }),
  z.object({
    kind: z.literal("tool-call"),
    toolName: z.string(),
    suppress: z.boolean(),
  }),
]);

export type SystemMessageSubject = z.infer<typeof systemMessageSubjectSchema>;
