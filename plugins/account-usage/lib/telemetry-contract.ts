import { z } from "zod";

export const telemetryInputSchema = z.object({
  accountId: z.string().uuid().nullable(),
});

export const poolTelemetryReportSchema = z.object({
  from: z.number(),
  to: z.number(),
  collectionErrors: z.number(),
  truncated: z.boolean(),
  rows: z.array(
    z.object({
      accountId: z.string(),
      model: z.string(),
      requestedTier: z.string(),
      servedTier: z.string().nullable(),
      effort: z.string().nullable(),
      requests: z.number(),
      completed: z.number(),
      failed: z.number(),
      unmeasured: z.number(),
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      outputTokens: z.number(),
      reasoningTokens: z.number(),
      medianTps: z.number().nullable(),
      medianFirstEventMs: z.number().nullable(),
    }),
  ),
  windows: z.array(
    z.object({
      accountId: z.string(),
      slot: z.string(),
      windowMinutes: z.number().nullable(),
      resetAt: z.number().nullable(),
      from: z.number(),
      to: z.number(),
      deltaPercent: z.number().nullable(),
      attribution: z.enum([
        "observed-account",
        "mixed",
        "reset",
        "unattributed",
      ]),
      requests: z.number(),
      model: z.string().nullable(),
      requestedTier: z.string().nullable(),
      servedTier: z.string().nullable(),
      effort: z.string().nullable(),
      outputTokens: z.number().nullable(),
    }),
  ),
});

export const statsSpeedReportSchema = z.object({
  speeds: z.array(
    z.object({
      model: z.string(),
      provider: z.literal("codex"),
      effort: z.string(),
      mode: z.string(),
      medianTps: z.number().nonnegative().nullable(),
      medianSampleCount: z.number().int().nonnegative().optional(),
    }),
  ),
});

export const telemetryReportSchema = poolTelemetryReportSchema.extend({
  speedRows: z.array(
    z.object({
      model: z.string(),
      effort: z.string().nullable(),
      requestedTier: z.string().nullable(),
      medianTps: z.number().nonnegative(),
      measuredTurns: z.number().int().positive().nullable(),
    }),
  ),
});

export type TelemetryReport = z.infer<typeof telemetryReportSchema>;
