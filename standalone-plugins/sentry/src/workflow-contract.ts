import { z } from "zod";
import { sha } from "./contract-fields";
import { completionSchema } from "./repair-result-contract";
import { workflowOperations } from "./workflow-operations";

const id = z.string().min(1).max(256);

const text = z
  .string()
  .min(1)
  .max(4000)
  .refine(
    (value) =>
      !/\bBearer\s+\S+|\b(?:sk|ghp|gho|ghs)[_-][A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(
        value,
      ),
    "Remove credential material",
  );

export const workflowOperationSchema = z.enum(workflowOperations.map(([operation]) => operation));

export const workflowInvocationSchema = z
  .object({
    instanceId: id,
    entryId: id,
    invocationId: id,
    attemptId: id,
    generation: z.number().int().nonnegative(),
    specHash: id,
    projectId: id,
    environmentId: id,
    stateId: id,
    operation: workflowOperationSchema,
    runId: id,
    deadlineAt: z.number().nonnegative(),
  })
  .strict();

export const workflowPolicyInputSchema = z
  .object({
    routeId: id,
    repairRouteIds: z.array(id).max(10).default([]),
    environmentId: id,
    authorityReference: text,
    enabled: z.boolean(),
    includeExisting: z.boolean().default(true),
    dailyLimit: z.number().int().min(1).max(100).default(10),
    nativeSurfaces: z.array(z.enum(["macos", "windows", "ios"])).default([]),
  })
  .strict();

export const workflowPolicySchema = workflowPolicyInputSchema.extend({
  machineId: id,
  versionId: id,
  projectId: id,
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  routeVersion: z.number().int().positive(),
  repairRoutes: z
    .array(
      z.object({
        routeId: id,
        version: z.number().int().positive(),
        repository: z.string(),
        repositoryPath: z.string(),
      }),
    )
    .default([]),
  createdAt: z.string(),
});

export const diagnosisSchema = z
  .object({
    classification: z.enum([
      "proven-defect",
      "reporting-noise",
      "needs-diagnostics",
      "deferred",
      "already-fixed",
    ]),
    proofKind: z.enum(["Reproduced", "Proven by inspection", "Hypothesis"]),
    summary: text,
    rootCause: text,
    proof: text,
    evidence: z.array(z.string().min(1).max(600)).min(1).max(20),
    sourceCommit: sha,
    targetRouteId: id.nullable().default(null),
    nativeRequired: z.array(z.enum(["macos", "windows", "ios"])).default([]),
    selectionPath: z.string().max(600).nullable().default(null),
    reconsiderWhen: text,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ["proven-defect", "reporting-noise", "already-fixed"].includes(value.classification) &&
      value.proofKind === "Hypothesis"
    )
      context.addIssue({
        code: "custom",
        message: "A repair or already-fixed claim requires causal proof",
      });
  });

export const reviewSchema = z
  .object({
    head: sha,
    verdict: z.enum(["approve", "changes-required"]),
    summary: text,
    evidence: z.array(z.string().min(1).max(600)).min(1).max(20),
  })
  .strict();

export const reviewEvidencePathPattern = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.+-]+(?:\/[\w@.+-]+)*$/u;

export const workflowWorkerResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("diagnosis"), value: diagnosisSchema }).strict(),
  z.object({ kind: z.literal("repair"), value: completionSchema }).strict(),
  z.object({ kind: z.literal("review"), value: reviewSchema }).strict(),
  z
    .object({
      kind: z.literal("runtime"),
      value: z
        .object({
          sourceCommit: sha,
          passed: z.boolean(),
          evidence: z.array(text).min(1),
          summary: text,
        })
        .strict(),
    })
    .strict(),
]);

export const workflowObservationSchema = z
  .object({
    status: z.enum(["running", "quiescent", "not-found", "uncertain"]),
    confirmedLive: z.boolean(),
    threadId: id.optional(),
    result: z
      .object({
        type: z.enum(["succeeded", "failed", "timed-out", "cancelled", "no-result", "result"]),
        outcome: z.string().optional(),
        payload: z.json(),
      })
      .optional(),
    retrySafe: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const workflowRpc = {
  "workflow.configure": { input: workflowPolicyInputSchema, output: workflowPolicySchema },
  "workflow.recoverSetup": {
    input: z.object({ runId: id }).strict(),
    output: z.object({ instanceId: id.nullable() }),
  },
  "workflow.status": {
    input: z.null(),
    output: z.object({ policies: z.array(workflowPolicySchema), tasks: z.array(z.json()) }),
  },
  "workflow.authorize": {
    input: workflowInvocationSchema,
    output: z.object({
      allowed: z.boolean(),
      reference: z.string().optional(),
      scope: z.string().optional(),
    }),
  },
  "workflow.start": { input: workflowInvocationSchema, output: workflowObservationSchema },
  "workflow.inspect": { input: workflowInvocationSchema, output: workflowObservationSchema },
  "workflow.cancel": { input: workflowInvocationSchema, output: workflowObservationSchema },
  "workflow.log": {
    input: workflowInvocationSchema.extend({
      cursor: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(32768),
    }),
    output: z.object({ text: z.string(), nextCursor: z.number(), truncated: z.boolean() }),
  },
};

export type WorkflowInvocation = z.infer<typeof workflowInvocationSchema>;

export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;

export type Diagnosis = z.infer<typeof diagnosisSchema>;

export type WorkerResult = z.infer<typeof workflowWorkerResultSchema>;

export type Observation = z.infer<typeof workflowObservationSchema>;
