import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const absolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
    "Use an absolute physical path.",
  );

export const housekeepingBudgetSchema = z
  .object({
    maxItems: z.number().int().min(1).max(1000),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 ** 3),
    budgetSeconds: z.number().int().min(1).max(900),
  })
  .strict();

export const defaultHousekeepingBudget = {
  maxItems: 100,
  maxBytes: 10 * 1024 ** 3,
  budgetSeconds: 900,
};

export const housekeepingSourceSchema = z
  .object({
    sourceDirectory: absolutePath,
    pythonPath: absolutePath,
    policyPath: absolutePath,
    namedPolicies: z
      .object({ "docker-kasten": absolutePath.optional() })
      .strict()
      .default({}),
  })
  .strict();

export const housekeepingBindingsSchema = z
  .object({
    runtime: z.object({ path: absolutePath, sha256: digest }).strict(),
    policy: z.object({ path: absolutePath, sha256: digest }).strict(),
    namedPolicies: z
      .object({
        "docker-kasten": z
          .object({ path: absolutePath, sha256: digest })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    sourceDirectory: absolutePath,
    helpers: z.record(z.string(), digest),
    configuration: z.record(z.string(), digest),
  })
  .strict();

export const housekeepingRegistrationSchema = z
  .object({
    kind: z.literal("safe-mac-cleanup-v1"),
    revision: z.number().int().positive(),
    adoptedAt: z.number(),
    bindingsDigest: digest,
    bindings: housekeepingBindingsSchema,
  })
  .strict();

export const housekeepingStageSchema = z
  .object({
    name: z.string().min(1),
    state: z.enum([
      "planned",
      "running",
      "complete",
      "skipped",
      "held",
      "failed",
      "deferred",
    ]),
    reason: z.string().nullable(),
    items: z.number().int().nonnegative().nullable(),
    bytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const housekeepingReviewProposalSchema = z
  .object({
    id: digest,
    kind: z.enum([
      "cua-placement-review",
      "unregistered-engine-review",
      "owner-storage-review",
    ]),
    owner: z.string().min(1),
    paths: z.array(absolutePath).min(1).max(32),
    observedAt: z.number().nonnegative(),
    logicalBytes: z.number().int().nonnegative().nullable(),
    allocatedBytes: z.number().int().nonnegative().nullable(),
    reason: z.string().min(1),
    action: z.string().min(1),
    preservation: z.string().min(1),
    state: z.literal("protected"),
  })
  .strict();

export const housekeepingRunSchema = z
  .object({
    id: z.uuid(),
    mode: z.enum(["preview", "apply"]),
    state: z.enum(["planned", "running", "completed", "held", "failed"]),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    registrationRevision: z.number().int().positive().nullable(),
    bindingsDigest: digest.nullable(),
    budget: housekeepingBudgetSchema,
    reserved: z
      .object({
        items: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
    stages: z.array(housekeepingStageSchema),
    reason: z.string().nullable(),
    reviewProposals: z
      .array(housekeepingReviewProposalSchema)
      .max(100)
      .optional(),
  })
  .strict();

export const housekeepingHostStateSchema = z
  .object({
    hostId: z.string().min(1),
    registration: housekeepingRegistrationSchema.nullable(),
    currentRun: housekeepingRunSchema.nullable(),
    lastRun: housekeepingRunSchema.nullable(),
    nextRunAt: z.number().nullable(),
  })
  .strict();

export const housekeepingStatusSchema = z
  .object({
    hosts: z.array(housekeepingHostStateSchema),
    failures: z.array(
      z.object({ hostId: z.string(), message: z.string() }).strict(),
    ),
  })
  .strict();

export const housekeepingAdapterPreviewSchema = z
  .object({
    hostId: z.string(),
    revision: z.number().int().nonnegative(),
    previewDigest: digest,
    bindingsDigest: digest,
    bindings: housekeepingBindingsSchema,
    stages: z.array(z.string()),
    kind: z.literal("safe-mac-cleanup-v1"),
  })
  .strict();

export const housekeepingHostPreviewSchema =
  housekeepingAdapterPreviewSchema.omit({ hostId: true });

const hostInput = z.object({ hostId: z.string().min(1) }).strict();

export const housekeepingRunInputSchema = hostInput
  .extend({
    budget: housekeepingBudgetSchema.default(defaultHousekeepingBudget),
  })
  .strict();

export const housekeepingAdapterAdoptSchema = hostInput
  .extend({ revision: z.number().int().nonnegative(), previewDigest: digest })
  .strict();

export const housekeepingRpc = defineRpcContract({
  housekeepingStatus: { input: z.null(), output: housekeepingStatusSchema },
  housekeepingRun: {
    input: housekeepingRunInputSchema,
    output: housekeepingHostStateSchema,
  },
  housekeepingPreview: {
    input: housekeepingRunInputSchema,
    output: housekeepingHostStateSchema,
  },
  housekeepingAdapterPreview: {
    input: hostInput.extend(housekeepingSourceSchema.shape).strict(),
    output: housekeepingAdapterPreviewSchema,
  },
  housekeepingAdapterAdopt: {
    input: housekeepingAdapterAdoptSchema,
    output: housekeepingHostStateSchema,
  },
  housekeepingAdapterRemove: {
    input: housekeepingAdapterAdoptSchema,
    output: housekeepingHostStateSchema,
  },
});

export const housekeepingHostContract = defineRpcContract({
  housekeepingHostState: {
    experimental_hostReplacementKey: "housekeeping-v1",
    input: z.null(),
    output: housekeepingHostStateSchema.omit({ hostId: true, nextRunAt: true }),
  },
  housekeepingHostAdapterPreview: {
    experimental_hostReplacementKey: "housekeeping-v1",
    input: housekeepingSourceSchema,
    output: housekeepingHostPreviewSchema,
  },
  housekeepingHostAdapterAdopt: {
    experimental_hostReplacementKey: "housekeeping-v1",
    input: housekeepingAdapterAdoptSchema.omit({ hostId: true }),
    output: housekeepingRegistrationSchema,
  },
  housekeepingHostAdapterRemove: {
    experimental_hostReplacementKey: "housekeeping-v1",
    input: housekeepingAdapterAdoptSchema.omit({ hostId: true }),
    output: z.null(),
  },
  housekeepingHostStart: {
    experimental_hostReplacementKey: "housekeeping-v1",
    input: z.object({ run: housekeepingRunSchema }).strict(),
    output: housekeepingRunSchema,
  },
  housekeepingHostRun: {
    experimental_hostReplacementKey: "housekeeping-v1",
    input: z.object({ id: z.uuid() }).strict(),
    output: housekeepingRunSchema,
  },
});

export type HousekeepingBudget = z.infer<typeof housekeepingBudgetSchema>;

export type HousekeepingRun = z.infer<typeof housekeepingRunSchema>;

export type HousekeepingStage = z.infer<typeof housekeepingStageSchema>;

export type HousekeepingRegistration = z.infer<
  typeof housekeepingRegistrationSchema
>;

export type HousekeepingHostState = z.infer<typeof housekeepingHostStateSchema>;

export type HousekeepingStatus = z.infer<typeof housekeepingStatusSchema>;

export type HousekeepingSource = z.input<typeof housekeepingSourceSchema>;

export type HousekeepingBindings = z.infer<typeof housekeepingBindingsSchema>;

export type HousekeepingAdapterPreview = z.infer<
  typeof housekeepingAdapterPreviewSchema
>;

export const housekeepingHostSignals = {
  changed: { payload: z.object({ runId: z.uuid() }).strict() },
};
