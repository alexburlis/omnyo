import { z } from "zod";
import { jsonObjectSchema } from "../contracts/definition.js";

const id = z.string().min(1).max(128);

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const prompt = z.string().min(1).max(32768);

const step = z.discriminatedUnion("kind", [
  z.strictObject({ id, kind: z.literal("model"), prompt, nextStepId: id }),
  z.strictObject({
    id,
    kind: z.literal("validate-text"),
    maxBytes: z.int().min(0).max(65536),
    nextStepId: id,
    failureStepId: id,
  }),
  z.strictObject({
    id,
    kind: z.literal("decision"),
    operand: z.enum(["equals", "contains"]),
    value: z.string().max(65536),
    nextStepId: id,
    otherwiseStepId: id,
  }),
  z.strictObject({ id, kind: z.literal("export") }),
]);

export const importedFlowSchema = z.union([
  z.strictObject({ kind: z.literal("prompt"), prompt }),
  z.strictObject({
    kind: z.literal("graph"),
    engine: z.literal("weekly-content-feed"),
    targetCount: z.int().min(1).max(7),
    maxCandidates: z.int().min(1).max(28),
    writer: z.strictObject({ prompt }),
    reviewer: z.strictObject({ prompt }),
  }),
  z.strictObject({
    kind: z.literal("graph"),
    engine: z.literal("restricted"),
    startStepId: id,
    steps: z.array(step).min(1).max(32),
  }),
]);

export type ImportedFlow = z.infer<typeof importedFlowSchema>;

export const assetsSchema = z.strictObject({
  skills: z.array(z.strictObject({ id, text: z.string().max(32768) })).max(32),
  inputs: jsonObjectSchema,
});

export const bindingSchema = z.strictObject({ hostId: id, providerId: id, model: id });

export const unsupportedBinding = {
  available: false,
  code: "unsupported_provider",
  message:
    "Choose a connected Codex or Claude Code subscription and an explicit model in workflow setup.",
} as const;

export function supportsSubscription(binding: z.infer<typeof bindingSchema>): boolean {
  return binding.providerId === "codex" || binding.providerId === "claude-code";
}

export const importInputSchema = z.strictObject({
  projectId: id,
  importId: id,
  packageDigest: digest,
  executionDigest: digest,
  flow: importedFlowSchema,
  assets: assetsSchema,
});

export const importRecordSchema = importInputSchema.extend({
  graphId: id,
  graphVersion: z.int().positive(),
  origin: z.literal("imported"),
  status: z.literal("disabled"),
});

export const admitInputSchema = z.strictObject({
  projectId: id,
  importId: id,
  graphId: id,
  graphVersion: z.int().positive(),
  executionDigest: digest,
  occurrenceKey: id,
  bindingRevision: z.int().nonnegative(),
  binding: bindingSchema,
  assets: assetsSchema,
});

export const draftSchema = z.strictObject({
  candidateId: id,
  canonicalTopic: z.string().min(1).max(256),
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(32768),
  sources: z.array(z.string().url()).max(20),
});

export const reviewSchema = z.strictObject({
  candidateId: id,
  draftDigest: digest,
  outcome: z.enum(["accepted", "rejected", "revise"]),
  reason: z.string().max(4096),
});

export const researchProvenanceSchema = z.strictObject({
  kind: z.literal("openseo"),
  keyword: z.string().trim().min(1).max(500),
  site: z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
  retrievedAt: z.iso.datetime(),
});

export const acceptedSchema = z.strictObject({
  draft: draftSchema,
  digest,
  review: reviewSchema,
  research: researchProvenanceSchema.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const runSchema = admitInputSchema.extend({
  runId: id,
  status: z.enum(["ready", "running", "partial", "complete", "failed"]),
  cursor: z.int().nonnegative(),
  accepted: z.array(acceptedSchema).max(7),
  outputs: z.array(z.string().max(65536)).max(32),
  pending: z
    .strictObject({
      phase: z.enum(["writer", "reviewer", "rewrite", "review-rewrite", "model"]),
      candidateId: id,
      requestId: id,
      draft: draftSchema.nullable(),
    })
    .nullable(),
  error: z.string().nullable(),
});

export type ImportedRun = z.infer<typeof runSchema>;

export const lookupInputSchema = z.strictObject({
  projectId: id,
  importId: id,
  occurrenceKey: id.optional(),
});

export function validateImportedFlow(flow: ImportedFlow): void {
  if (flow.kind !== "graph") return;

  if (flow.engine === "weekly-content-feed") {
    if (flow.maxCandidates < flow.targetCount)
      throw new Error("Candidate budget is below the requested count");

    return;
  }

  const steps = new Map(flow.steps.map((item) => [item.id, item]));

  if (steps.size !== flow.steps.length || !steps.has(flow.startStepId))
    throw new Error("Invalid restricted graph identity");
  const reached = new Set<string>();
  const visiting = new Set<string>();
  const checked = new Set<string>();

  function visit(stepId: string, hasText: boolean): void {
    const step = steps.get(stepId);

    if (!step) throw new Error("Unknown next step");

    if (visiting.has(stepId)) throw new Error("Restricted graph must be finite");
    const checkKey = `${stepId}:${hasText}`;

    if (checked.has(checkKey)) return;
    reached.add(stepId);
    visiting.add(stepId);

    if ((step.kind === "validate-text" || step.kind === "decision") && !hasText)
      throw new Error("Text branch requires a prior model output on every route");

    if (step.kind !== "export") {
      visit(step.nextStepId, hasText || step.kind === "model");

      if (step.kind === "validate-text") visit(step.failureStepId, hasText);

      if (step.kind === "decision") visit(step.otherwiseStepId, hasText);
    }

    visiting.delete(stepId);
    checked.add(checkKey);
  }

  visit(flow.startStepId, false);

  if (reached.size !== steps.size) throw new Error("Unreachable restricted step");
}

export const reviseInputSchema = importInputSchema.omit({ importId: true }).extend({
  importId: z.string().min(1).max(128),
  graphId: z.string().min(1).max(128),
  expectedGraphVersion: z.int().positive(),
});

export const exportSchema = z.strictObject({
  runId: id,
  graphId: id,
  graphVersion: z.int().positive(),
  occurrenceKey: id,
  manifestDigest: digest,
  files: z.array(z.strictObject({ name: z.string(), content: z.string(), digest })).max(16),
});

export const reconcileInputSchema = lookupInputSchema.extend({
  requestId: id,
  response: z.string().max(65536),
});
