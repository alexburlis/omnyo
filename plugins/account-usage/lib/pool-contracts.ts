import { z } from "zod";

export const POOL_PROVIDERS = ["claude", "codex"] as const;

export type PoolProvider = (typeof POOL_PROVIDERS)[number];

export const OMNYO_PROVIDER_ID: Record<PoolProvider, string> = {
  claude: "claude-code",
  codex: "codex",
};

export const CLAUDE_FAMILIES = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "other",
] as const;

export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];

const familyQuotaSchema = z.object({
  utilization: z.number().nullable(),
  resetAt: z.number().nullable(),
  status: z.string().nullable(),
  observedAt: z.number().nullable(),
});

const limitWindowSchema = z.object({
  slot: z.string().nullable().optional(),
  windowMinutes: z.number().nullable(),
  utilization: z.number().nullable(),
  resetAt: z.number().nullable(),
  status: z.string().nullable(),
  observedAt: z.number().nullable().optional(),
});

export const creditBalanceSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("points"), amount: z.number().nonnegative() }),
  z.object({
    unit: z.literal("currency"),
    amount: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
]);

export const extraUsageSchema = z.object({
  hasCredits: z.boolean().nullable().optional(),
  unlimited: z.boolean().nullable().optional(),
  observedAt: z.number(),
  creditBalance: creditBalanceSchema.nullish(),
});

export const accountSummarySchema = z.object({
  id: z.string(),
  provider: z.enum(POOL_PROVIDERS),
  kind: z.string(),
  label: z.string().nullable(),
  email: z.string().nullable(),
  subscriptionType: z.string().nullable(),
  enabled: z.boolean(),
  priority: z.number(),
  lastUsedAt: z.number().nullable(),

  fiveHourUtilization: z.number().nullable(),
  fiveHourResetAt: z.number().nullable(),
  fiveHourStatus: z.string().nullable(),
  sevenDayUtilization: z.number().nullable(),
  sevenDayResetAt: z.number().nullable(),
  sevenDayStatus: z.string().nullable(),
  familyWeekly: z.record(z.string(), familyQuotaSchema.nullable()),
  limitWindows: z.array(limitWindowSchema),

  extraUsage: extraUsageSchema.nullish(),
  observedAt: z.number().nullable(),
  heldUntil: z.number().nullable(),
  error: z.string().nullable(),
  inFlight: z.number(),
  status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;

export type AccountStatus = AccountSummary["status"];

export const poolStatusSchema = z.object({
  accepting: z.boolean(),
  inFlight: z.number(),
  enabledAccountCount: z.number(),
  routing: z.object({ claude: z.boolean(), codex: z.boolean() }),
  accounts: z.array(accountSummarySchema),
});

export type PoolStatus = z.infer<typeof poolStatusSchema>;

export const poolConfigSchema = z.object({
  switchThreshold: z.number().min(0).max(1),
});
