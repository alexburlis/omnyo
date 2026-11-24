import { z } from "zod";

export const retainedProviderSessionReasonSchema = z.enum([
  "active-turn",
  "pending-turn",
  "pending-answer",
  "in-flight-operation",
  "command-in-flight",
  "not-restorable",
  "provider-unavailable",
  "idle-time-unknown",
  "idle-grace",
  "background-work",
  "release-failed",
]);

export type RetainedProviderSessionReason = z.infer<
  typeof retainedProviderSessionReasonSchema
>;

export const retainedProviderSessionSchema = z.object({
  threadId: z.string(),
  providerId: z.string().nullable(),
  processId: z.number().int().positive().nullable(),
  reason: retainedProviderSessionReasonSchema,
  idleForMs: z.number().nonnegative().nullable(),
});

export type RetainedProviderSession = z.infer<
  typeof retainedProviderSessionSchema
>;
