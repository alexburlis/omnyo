import { defineRpcContract } from "./rpc-contract.js";
import { z } from "zod";

const usagePlanSchema = z.object({
  id: z.string().min(1),
  multiplier: z.number().int().positive().nullable(),
});

const accountFields = {
  plan: usagePlanSchema.nullable().default(null),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

const usageWindowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "custom",
]);

const usageWindowSchema = z.object({
  kind: usageWindowKindSchema.default("custom"),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z
    .number()
    .nonnegative()
    .describe("Percentage consumed; may exceed 100 for overage."),
  resetsAt: z
    .string()
    .nullable()
    .describe("ISO timestamp, or null when no reset is known."),
  model: z
    .string()
    .nullable()
    .describe("Applicable model family, or null for all models."),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable(),
});

const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    ...accountFields,
    windows: z.array(usageWindowSchema),
  }),
  z.object({ status: z.literal("not_installed"), ...accountFields }),
  z.object({ status: z.literal("unauthenticated"), ...accountFields }),
  z.object({ status: z.literal("expired"), ...accountFields }),
  z.object({
    status: z.literal("error"),
    ...accountFields,
    message: z.string(),
  }),
]);

const usageAccountKeySchema = z
  .string()
  .min(1)
  .nullable()
  .default(null)
  .describe(
    "Provider-issued quota account identity, namespaced by issuer and account/organization scope. Never use email, a display label, a source-local ID, or credentials. Null means unknown; unknown accounts must not be merged.",
  );

const usageResourceSchema = z.object({
  accountKey: usageAccountKeySchema,
  id: z
    .string()
    .min(1)
    .describe("Stable resource ID within this source plugin."),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});

const usageResourceListSchema = z.object({
  label: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Declares a shared group even when empty. Host-only sources omit it; machine groups use host names.",
    ),
  resources: z.array(usageResourceSchema),
});

const usageMeasurementSchema = z.object({
  accountKey: usageAccountKeySchema,
  observedAt: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      "Last successful measurement time in epoch milliseconds; null if never observed.",
    ),
  usage: usageSchema,
});

const usageListInputSchema = z.object({});

const usageFetchInputSchema = z.object({
  resourceId: z.string().min(1),
  refresh: z
    .boolean()
    .describe(
      "False permits a cached measurement but still returns actual usage. True requests a fresh collection attempt for this resource only.",
    ),
});

const usageListMethod = "provider-usage.v1.listResources";

const usageFetchMethod = "provider-usage.v1.getResource";

const usageSourceRpcContract = defineRpcContract({
  [usageListMethod]: {
    input: usageListInputSchema,
    output: usageResourceListSchema,
    experimental_description:
      "Cheap complete inventory of resources owned by this source. Reads local metadata only; never refreshes quota or contacts providers. IDs are stable and source-local. Resource order is display order. Shared label preserves empty groups. Resources may disappear between list and fetch.",
  },
  [usageFetchMethod]: {
    input: usageFetchInputSchema,
    output: usageMeasurementSchema,
    experimental_description:
      "Returns actual usage for exactly one listed resource, even when refresh is false. False permits cached observations; true requests a fresh attempt. Never collects other resources as a side effect. A removed resource fails the RPC; consumers relist. Per-account authentication and collection failures are usage states. observedAt is the last successful measurement time.",
  },
});

export const experimental_providerUsageSourceV1 = {
  usageListMethod,
  usageFetchMethod,
  usageSourceRpcContract,
  usageMeasurementSchema,
  usagePlanSchema,
  usageResourceListSchema,
  usageWindowKindSchema,
} as const;
