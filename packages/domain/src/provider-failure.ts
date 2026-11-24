import { z } from "zod";

const providerErrorCategoryValues = [
  "active-turn-not-steerable",
  "bad-request",
  "connection-failed",
  "context-window-exceeded",
  "billing",
  "budget-exceeded",
  "internal",
  "max-output-tokens",
  "max-turns",
  "overloaded",
  "policy",
  "rate-limit",
  "sandbox",
  "stream-disconnected",
  "structured-output-retries",
  "thread-rollback-failed",
  "too-many-failed-attempts",
  "unauthorized",
  "unknown",
] as const;

export const providerErrorCategorySchema = z.enum(providerErrorCategoryValues);

export type ProviderErrorCategory = z.infer<typeof providerErrorCategorySchema>;

export const providerErrorInfoSchema = z.object({
  category: providerErrorCategorySchema,
  providerCode: z.string().nullable(),
  httpStatusCode: z.number().nullable(),
});

export type ProviderErrorInfo = z.infer<typeof providerErrorInfoSchema>;

const providerRateLimitStatusSchema = z.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown",
]);

export type ProviderRateLimitStatus = z.infer<
  typeof providerRateLimitStatusSchema
>;

const providerRateLimitWindowSchema = z.object({
  providerKey: z.string().min(1).nullable(),
  label: z.string().min(1).nullable(),
  status: providerRateLimitStatusSchema,
  resetsAtMs: z.number().int().nonnegative().nullable(),
});

export type ProviderRateLimitWindow = z.infer<
  typeof providerRateLimitWindowSchema
>;

export const providerRateLimitStateSchema = z.object({
  providerId: z.string().min(1),
  status: providerRateLimitStatusSchema,
  kind: z.enum(["subscription-window", "credits", "spend-control", "unknown"]),
  windows: z.array(providerRateLimitWindowSchema),
  reachedReason: z.string().min(1).nullable(),
  overageStatus: z
    .enum(["allowed", "warning", "rejected", "unavailable"])
    .nullable(),
  overageReason: z.string().min(1).nullable(),
});

export type ProviderRateLimitState = z.infer<
  typeof providerRateLimitStateSchema
>;

export const providerFailureMetadataSchema = z.object({
  expectedFailure: z.boolean().optional(),
  errorInfo: providerErrorInfoSchema.optional(),
  rateLimits: providerRateLimitStateSchema.optional(),
});

export type ProviderFailureMetadata = z.infer<
  typeof providerFailureMetadataSchema
>;
