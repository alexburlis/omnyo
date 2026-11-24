import { z } from "zod";

export const USAGE_CONSENT_VERSION = 1;

export const USER_ACTIVITY_HEADER = "x-omnyo-user-activity";

export const ANALYTICS_CONSENT_HEADER = "x-omnyo-analytics-consent";

export const USAGE_REQUEST_AGENT = "Omnyo-Usage/1";

export const USAGE_RAW_RETENTION_DAYS = 30;

export const usageProofSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const usageChoiceSchema = z.enum(["unset", "granted", "declined"]);

export const usageConsentSourceSchema = z.enum([
  "initial",
  "legacy-refusal",
  "settings",
  "cli",
  "sdk",
]);

export const usageConsentSchema = z
  .object({
    version: z.literal(1),
    count: usageChoiceSchema,
    product: usageChoiceSchema,
    countSource: usageConsentSourceSchema,
    productSource: usageConsentSourceSchema,
    noticeVersion: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export const initialUsageConsent = {
  version: 1,
  count: "unset",
  product: "unset",
  countSource: "initial",
  productSource: "initial",
  noticeVersion: 0,
} satisfies z.infer<typeof usageConsentSchema>;

export const usageOnboardingStepSchema = z.enum([
  "agent",
  "projects",
  "chats",
  "browser",
  "plugins",
  "automations",
  "devices",
]);

export const publicUsageListingSchema = z.enum(["workspace-github", "sentry"]);

export const productUsageEventSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("activity"),
      properties: z.object({ first: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal("feature_used"),
      properties: z
        .object({ feature: z.enum(["chat", "queued_message", "plugin"]) })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal("onboarding"),
      properties: z
        .object({
          step: usageOnboardingStepSchema,
          outcome: z.enum(["reached", "completed", "skipped"]),
          entry: z.enum(["first_run", "replay"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal("operation"),
      properties: z
        .object({
          operation: z.enum(["new_chat", "message", "agent_sign_in"]),
          outcome: z.enum(["started", "accepted", "failed", "cancelled"]),
          failure_reason: z
            .enum(["nonzero_exit", "start_rejected", "unknown"])
            .optional(),
          latency: z.enum([
            "unknown",
            "under_1s",
            "1_to_5s",
            "5_to_30s",
            "over_30s",
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal("public_plugin_installed"),
      properties: z.object({ listing: publicUsageListingSchema }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal("first_accepted_action"),
      properties: z
        .object({
          since_grant: z.enum([
            "under_1m",
            "1_to_10m",
            "10_to_60m",
            "over_60m",
          ]),
        })
        .strict(),
    })
    .strict(),
]);

const reportFields = {
  count: z.number().int().min(1).max(100),
  subject: usageProofSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

export const productUsageReportSchema = z.discriminatedUnion("event", [
  productUsageEventSchema.options[0].extend(reportFields),
  productUsageEventSchema.options[1].extend(reportFields),
  productUsageEventSchema.options[2].extend(reportFields),
  productUsageEventSchema.options[3].extend(reportFields),
  productUsageEventSchema.options[4].extend(reportFields),
  productUsageEventSchema.options[5].extend(reportFields),
]);

export const productUsageErasureSchema = z
  .object({ proof: usageProofSchema })
  .strict();

export const usageConsentRequestSchema = z
  .object({
    purpose: z.enum(["count", "product", "notice"]),
    proof: usageProofSchema.optional(),
    choice: z.enum(["granted", "declined"]),
    source: z.enum(["settings", "cli", "sdk"]),
  })
  .strict();

export const usageStatusSchema = z
  .object({
    count: z.object({
      choice: usageChoiceSchema,
      effective: z.boolean(),
      reason: z.enum([
        "granted",
        "regional-default",
        "declined",
        "consent-required",
        "disabled",
        "not-configured",
      ]),
      noticeRequired: z.boolean(),
      attemptedWeek: z.string().nullable(),
    }),
    product: z.object({
      choice: usageChoiceSchema,
      effective: z.boolean(),
      reason: z.enum([
        "granted",
        "declined",
        "consent-required",
        "disabled",
        "not-configured",
      ]),
      erasure: z.enum(["none", "pending", "complete"]),
      rawRetentionDays: z.literal(30),
    }),
  })
  .strict();

export const usageConsentResponseSchema = z
  .object({ status: usageStatusSchema, proof: usageProofSchema.optional() })
  .strict();

export const usagePreviewSchema = z
  .object({
    count: z.object({
      method: z.literal("POST"),
      path: z.literal("/metrics/active-week"),
      body: z.literal(""),
    }),
    product: z.array(productUsageReportSchema),
    destination: z.string().nullable(),
  })
  .strict();

export type UsageConsent = z.infer<typeof usageConsentSchema>;

export type UsageConsentRequest = z.infer<typeof usageConsentRequestSchema>;

export type UsageConsentResponse = z.infer<typeof usageConsentResponseSchema>;

export type UsageStatus = z.infer<typeof usageStatusSchema>;

export type UsagePreview = z.infer<typeof usagePreviewSchema>;

export type ProductUsageEvent = z.infer<typeof productUsageEventSchema>;

export type ProductUsageReport = z.infer<typeof productUsageReportSchema>;

export function usageRequestEligible(
  pathname: string,
  method: string,
): boolean {
  if (method.toUpperCase() === "GET")
    return pathname === "/api/v1/system/usage";

  if (method.toUpperCase() !== "POST") return false;

  return (
    pathname === "/api/v1/plugins/install" ||
    pathname === "/api/v1/threads" ||
    pathname === "/api/v1/system/telemetry/events" ||
    /^\/api\/v1\/threads\/[^/]+\/(send|queued-messages)$/.test(pathname)
  );
}

const usageActorSchema = z
  .object({
    subject: usageProofSchema,
    grantedAt: z.number().int(),
    source: z.enum(["settings", "cli", "sdk"]),
    activated: z.boolean(),
    withdrawnAt: z.number().int().nullable(),
    erasure: z.enum(["none", "pending", "complete"]),
    day: z.string(),
    keys: z
      .array(
        z
          .object({
            key: z.string().max(250),
            count: z.number().int().min(1).max(100),
            sentCount: z.number().int().min(0).max(100).default(0),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export const usageActorsSchema = z.array(usageActorSchema).max(64);

export type UsageActor = z.infer<typeof usageActorSchema>;
