import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  codexResetCreditsInputSchema,
  codexResetCreditsSchema,
  codexRedeemResetInputSchema,
  codexRedeemResetSchema,
} from "./lib/codex-reset-contract.ts";

import { creditBalanceSchema, extraUsageSchema } from "./lib/pool-contracts.ts";
import {
  telemetryInputSchema,
  telemetryReportSchema,
} from "./lib/telemetry-contract.ts";

export const USAGE_CHANGED_CHANNEL = "usage-changed";

export const PANEL_POLL_MS = 30_000;

export const STALE_AFTER_MS = 11 * 60 * 1000;

export const toneSchema = z.enum([
  "ok",
  "warn",
  "blocked",
  "elapsed",
  "unknown",
]);

export type Tone = z.infer<typeof toneSchema>;

export const cellSchema = z.object({
  key: z.string(),

  percent: z.number().nullable(),
  tone: toneSchema,
  resetAt: z.number().nullable(),

  gating: z.boolean(),
});

export type Cell = z.infer<typeof cellSchema>;

export const columnSchema = z.object({
  key: z.string(),
  label: z.string(),
});

export type Column = z.infer<typeof columnSchema>;

export const accountRowSchema = z.object({
  id: z.string(),

  name: z.string(),

  plan: z.string().nullable(),
  enabled: z.boolean(),
  canResetCredits: z.boolean(),
  canSignInAgain: z.boolean(),
  extraUsage: extraUsageSchema.nullish(),
  status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),
  statusLabel: z.string(),

  serving: z.enum(["serving", "next", "idle"]),

  resetAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
  observedAt: z.number().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),

  cells: z.array(cellSchema.nullable()),
});

export type AccountRow = z.infer<typeof accountRowSchema>;

export const weeklyBarSchema = z.object({
  accountId: z.string(),

  name: z.string(),
  plan: z.string().nullable(),

  remainingPercent: z.number().nullable(),

  resetAt: z.number().nullable(),

  windowMinutes: z.number().nullable(),
  status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),

  serving: z.enum(["serving", "next", "idle"]),

  fiveHourWarning: z
    .object({
      remainingPercent: z.number().nullable(),
      exhausted: z.boolean(),
      resetAt: z.number().nullable(),
    })
    .nullable(),

  credits: z
    .object({
      balance: creditBalanceSchema.nullable(),
      unlimited: z.boolean(),
      observedAt: z.number(),
    })
    .nullable(),
});

export type WeeklyBar = z.infer<typeof weeklyBarSchema>;

export const groupSchema = z.object({
  providerId: z.string(),
  poolProvider: z.enum(["claude", "codex"]),
  routingEnabled: z.boolean(),
  readyCount: z.number(),
  totalCount: z.number(),

  nextCapacityAt: z.number().nullable(),

  weeklyBars: z.array(weeklyBarSchema),
  columns: z.array(columnSchema),
  accounts: z.array(accountRowSchema),
});

export type Group = z.infer<typeof groupSchema>;

export const snapshotSchema = z.object({
  fetchedAt: z.number(),

  error: z.string().nullable(),

  poolUnavailable: z.boolean(),
  groups: z.array(groupSchema),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

const accountIdSchema = z.string().uuid();

export const signInStartSchema = z
  .object({
    provider: z.literal("codex"),
    sessionId: z.string().uuid(),
    verificationUri: z.string().url(),
    userCode: z.string().min(1),
    expiresAt: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
  })
  .strict();

export type SignInStart = z.infer<typeof signInStartSchema>;

export const signInResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z
    .object({
      status: z.literal("complete"),
      usageRefreshError: z.string().nullable(),
    })
    .strict(),
  z.object({ status: z.literal("error"), message: z.string().min(1) }).strict(),
]);

export type SignInResult = z.infer<typeof signInResultSchema>;

export const rpcContract = defineRpcContract({
  telemetry: { input: telemetryInputSchema, output: telemetryReportSchema },
  snapshot: { input: z.null(), output: snapshotSchema },

  refresh: { input: z.null(), output: snapshotSchema },
  codexResetCredits: {
    input: codexResetCreditsInputSchema,
    output: codexResetCreditsSchema,
  },
  codexRedeemReset: {
    input: codexRedeemResetInputSchema,
    output: codexRedeemResetSchema,
  },
  refreshAccount: {
    input: z.object({ accountId: accountIdSchema }).strict(),
    output: z.null(),
  },
  signInStart: {
    input: z.object({ accountId: accountIdSchema }).strict(),
    output: signInStartSchema,
  },
  signInFinish: {
    input: z
      .object({
        accountId: accountIdSchema,
        sessionId: z.string().uuid(),
        code: z.string().trim().min(1),
      })
      .strict(),
    output: signInResultSchema,
  },
  signInPoll: {
    input: z
      .object({ accountId: accountIdSchema, sessionId: z.string().uuid() })
      .strict(),
    output: signInResultSchema,
  },
  signInCancel: {
    input: z.object({ sessionId: z.string().uuid() }).strict(),
    output: z.null(),
  },
});
