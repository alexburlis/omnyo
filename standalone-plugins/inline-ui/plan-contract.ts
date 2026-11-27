import { z } from "zod";

export const selectionSchema = z
  .object({
    providerId: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    reasoningLevel: z.string().min(1).max(100),
    serviceTier: z.string().min(1).max(100).optional(),
  })
  .strict();

export type Selection = z.infer<typeof selectionSchema>;

export const defaultsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current-chat-ultra") }).strict(),
  z.object({ kind: z.literal("fixed"), selection: selectionSchema }).strict(),
]);

export type PlanDefaults = z.infer<typeof defaultsSchema>;

export const referenceSchema = z
  .object({
    sourceThreadId: z.string().min(1),
    href: z.string().trim().min(1).max(4096),
  })
  .strict();

export type PlanReference = z.infer<typeof referenceSchema>;

export const executionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actionable") }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("running"), threadId: z.string() }).strict(),
  z.object({ kind: z.literal("in-progress"), message: z.string() }).strict(),
  z.object({ kind: z.literal("blocked"), message: z.string() }).strict(),
  z.object({ kind: z.literal("stopped"), message: z.string() }).strict(),
  z.object({ kind: z.literal("no-work"), message: z.string() }).strict(),
  z.object({ kind: z.literal("draft"), message: z.string() }).strict(),
]);

export const runSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("started"), threadId: z.string(), selection: selectionSchema })
    .strict(),
  z.object({ kind: z.literal("pending"), message: z.string() }).strict(),
]);

export const previewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-plan") }).strict(),
  z
    .object({
      kind: z.literal("plan"),
      title: z.string(),
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      state: z.string(),
      execution: executionSchema.optional(),
      environmentId: z.string(),
      selection: selectionSchema.nullable(),
      selectionIssue: z.string().nullable(),
      run: runSchema.nullable(),
    })
    .strict(),
]);

export type PlanPreview = z.infer<typeof previewSchema>;

export const executeSchema = referenceSchema
  .extend({
    environmentId: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    selection: selectionSchema,
    requestId: z.string().min(1).max(200),
  })
  .strict();

export type ExecutePlan = z.infer<typeof executeSchema>;

export const planRunChannel = "plan-run-changed";

export const planRunEventSchema = z.object({
  threadId: z.string(),
  parentThreadId: z.string().nullable(),
});
