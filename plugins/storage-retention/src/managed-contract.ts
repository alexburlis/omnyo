import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const MANAGED_HOLDING_MS = 7 * 24 * 60 * 60 * 1000;

export const managedThreadIdSchema = z
  .string()
  .regex(/^thr_[a-zA-Z0-9_-]{4,100}$/);

export const managedProjectIdSchema = z
  .string()
  .regex(/^(?:prj|proj)_[a-zA-Z0-9_-]{4,100}$/);

export const managedHostIdSchema = z
  .string()
  .regex(
    /^(?:host|hst|machine|mac)_[a-zA-Z0-9_-]{4,100}$|^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
  );

export const managedIdSchema = z.uuid();

export const managedDispositionSchema = z.enum([
  "disposable-when-owner-ends",
  "keep-until-released",
]);

const physicalPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
    "Use an absolute path.",
  );

export const managedStorageSchema = z
  .object({
    role: z.enum([
      "build",
      "verification",
      "render",
      "source-snapshot",
      "temporary",
    ]),
    budgetBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minimumFreeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    restoreInputs: z
      .array(
        z
          .object({
            reference: z.string().trim().min(1).max(4096),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export const managedCloseoutSchema = z
  .object({
    outcome: z.enum(["success", "failure", "cancelled"]),
    retainedOutputs: z
      .array(
        z
          .object({
            path: physicalPath,
            reason: z.string().trim().min(1).max(1000),
            removalCondition: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const managedPolicySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mode: z.enum(["review", "owner-approved"]),
    automaticExpiry: z.boolean(),
    expiryEnabledAt: z.number().nonnegative().nullable(),
    quarantineBudgetBytes: z.number().int().positive(),
  })
  .strict();

export const defaultManagedPolicy = {
  revision: 0,
  mode: "review",
  automaticExpiry: false,
  expiryEnabledAt: null,
  quarantineBudgetBytes: 10 * 1024 ** 3,
} satisfies z.infer<typeof managedPolicySchema>;

export const managedPolicyDraftSchema = managedPolicySchema.omit({
  revision: true,
  expiryEnabledAt: true,
});

export type ManagedPolicyDraft = z.infer<typeof managedPolicyDraftSchema>;

export type ManagedPolicy = z.infer<typeof managedPolicySchema>;

export const managedSnapshotSchema = z
  .object({
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    logicalBytes: z.number().int().nonnegative(),
    entryCount: z.number().int().nonnegative(),
    capturedAt: z.number().nonnegative(),
  })
  .strict();

export const managedHoldSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    at: z.number(),
  })
  .strict();

export const managedGrantSchema = z
  .object({ kind: z.enum(["native-release", "owner-ended"]), at: z.number() })
  .strict();

export const managedPhaseSchema = z.enum([
  "allocated",
  "kept",
  "proposed",
  "approved",
  "quarantine-intent",
  "quarantined",
  "restore-intent",
  "purge-intent",
  "removed",
]);

export const managedAllocationSchema = z
  .object({
    id: managedIdSchema,
    hostId: managedHostIdSchema,
    ownerThreadId: managedThreadIdSchema,
    projectId: managedProjectIdSchema.nullable(),
    purpose: z.string(),
    disposition: managedDispositionSchema,
    storage: managedStorageSchema.nullable().default(null),
    closeout: managedCloseoutSchema.nullable().default(null),
    createdAt: z.number(),
    revision: z.number().int().positive(),
    phase: managedPhaseSchema,
    path: z.string(),
    originalPath: z.string(),
    snapshot: managedSnapshotSchema.nullable(),
    grant: managedGrantSchema.nullable(),
    reviewedAt: z.number().nullable(),
    quarantinedAt: z.number().nullable(),
    purgeEligibleAt: z.number().nullable(),
    hold: managedHoldSchema.nullable(),
    consumers: z.array(
      z
        .object({
          threadId: managedThreadIdSchema,
          releasedAt: z.number().nullable(),
        })
        .strict(),
    ),
    removedLogicalBytes: z.number().int().nonnegative(),
    reason: z.string().nullable(),
  })
  .strict();

export type ManagedAllocation = z.infer<typeof managedAllocationSchema>;

export type ManagedSnapshot = z.infer<typeof managedSnapshotSchema>;

const exactFields = {
  id: managedIdSchema,
  revision: z.number().int().positive(),
  snapshotDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
};

const clientExactFields = {
  hostId: managedHostIdSchema,
  ...exactFields,
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
};

const allocateFields = {
  requestKey: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  purpose: z.string().trim().min(1).max(1000),
  disposition: managedDispositionSchema,
  storage: managedStorageSchema,
};

export const managedOwnerRequestSchema = z
  .object({
    request: z.discriminatedUnion("action", [
      z.object({ action: z.literal("allocate"), ...allocateFields }).strict(),
      z.object({ action: z.literal("list") }).strict(),
      z.object({ action: z.literal("inspect"), id: managedIdSchema }).strict(),
      z
        .object({
          action: z.enum(["keep", "reuse"]),
          ...exactFields,
          reason: z.string().trim().min(1).max(1000),
        })
        .strict(),
      z
        .object({
          action: z.literal("release"),
          ...exactFields,
          reason: z.string().trim().min(1).max(1000),
          closeout: managedCloseoutSchema,
        })
        .strict(),
      z
        .object({
          action: z.literal("budget-extend"),
          ...exactFields,
          reason: z.string().trim().min(1).max(1000),
          budgetBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      z
        .object({
          action: z.literal("consumer-register"),
          ...exactFields,
          consumerThreadId: managedThreadIdSchema,
        })
        .strict(),
      z
        .object({ action: z.literal("consumer-release"), ...exactFields })
        .strict(),
    ]),
  })
  .strict();

export type ManagedOwnerRequest = z.infer<typeof managedOwnerRequestSchema>;

export const managedAdminRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("namespace-preview"),
      hostId: managedHostIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("namespace-reanchor"),
      hostId: managedHostIdSchema,
      previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("inspect"),
      hostId: managedHostIdSchema,
      id: managedIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.enum(["review", "restore", "purge"]),
      ...clientExactFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("policy-preview"),
      policy: managedPolicyDraftSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("configure"),
      policy: managedPolicyDraftSchema,
      expectedRevision: z.number().int().nonnegative(),
      previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("purge-preview"),
      items: z.array(z.object(clientExactFields).strict()).min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("purge-batch"),
      items: z.array(z.object(clientExactFields).strict()).min(1).max(100),
      previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
]);

export type ManagedAdminRequest = z.infer<typeof managedAdminRequestSchema>;

export const managedPreviewSchema = z
  .object({
    digest: z.string(),
    affectedCount: z.number().int().nonnegative(),
    eligibleCount: z.number().int().nonnegative(),
    quarantinedCount: z.number().int().nonnegative(),
  })
  .strict();

export const managedStateSchema = z
  .object({
    preview: managedPreviewSchema.nullable(),
    policy: managedPolicySchema,
    allocations: z.array(managedAllocationSchema),
    failures: z.array(
      z.object({ hostId: z.string(), message: z.string() }).strict(),
    ),
  })
  .strict();

export type ManagedState = z.infer<typeof managedStateSchema>;

export const managedRpc = defineRpcContract({
  managedRequest: {
    input: managedAdminRequestSchema,
    output: managedStateSchema,
  },
  managedState: { input: z.null(), output: managedStateSchema },
});

export const managedHostAllocateSchema = z
  .object({
    hostId: managedHostIdSchema,
    ownerThreadId: managedThreadIdSchema,
    projectId: managedProjectIdSchema.nullable(),
    ...allocateFields,
  })
  .strict();

export const managedHostDecisionSchema = z
  .object({
    ...exactFields,
    actorThreadId: managedThreadIdSchema,
    decision: z.discriminatedUnion("action", [
      z
        .object({
          action: z.enum(["keep", "reuse"]),
          reason: z.string().min(1).max(1000),
        })
        .strict(),
      z
        .object({
          action: z.literal("release"),
          reason: z.string().min(1).max(1000),
          closeout: managedCloseoutSchema,
        })
        .strict(),
      z
        .object({
          action: z.literal("budget-extend"),
          reason: z.string().min(1).max(1000),
          budgetBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      z
        .object({
          action: z.literal("consumer-register"),
          consumerThreadId: managedThreadIdSchema,
        })
        .strict(),
      z.object({ action: z.literal("consumer-release") }).strict(),
      z
        .object({ action: z.enum(["owner-ended", "owner-unarchived"]) })
        .strict(),
    ]),
  })
  .strict();

export const managedHostTransitionSchema = z
  .object({
    ...exactFields,
    action: z.enum(["quarantine", "restore", "purge"]),
    settledConsumerThreadIds: z.array(managedThreadIdSchema).max(100),
    expiryEnabledAt: z.number().nullable(),
  })
  .strict();

export const managedHostContract = defineRpcContract({
  managedReanchor: {
    input: z
      .object({
        previewDigest: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      })
      .strict(),
    output: z
      .object({
        digest: z.string(),
        allocationCount: z.number().int().nonnegative(),
        applied: z.boolean(),
      })
      .strict(),
  },
  managedAllocate: {
    input: managedHostAllocateSchema,
    output: managedAllocationSchema,
  },
  managedInspect: {
    input: z.object({ id: managedIdSchema }).strict(),
    output: managedAllocationSchema,
  },
  managedList: { input: z.null(), output: z.array(managedAllocationSchema) },
  managedOwnerDecision: {
    input: managedHostDecisionSchema,
    output: managedAllocationSchema,
  },
  managedReview: {
    input: z.object(exactFields).strict(),
    output: managedAllocationSchema,
  },
  managedTransition: {
    input: managedHostTransitionSchema,
    output: managedAllocationSchema,
  },
  managedReconcile: {
    input: z.object({ id: managedIdSchema.nullable() }).strict(),
    output: z.array(managedAllocationSchema),
  },
});

export type ManagedHostAllocate = z.infer<typeof managedHostAllocateSchema>;

export type ManagedHostDecision = z.infer<typeof managedHostDecisionSchema>;

export type ManagedHostTransition = z.infer<typeof managedHostTransitionSchema>;
