import { z } from "zod";

export const claudeProfileIdSchema = z.uuid();

export const claudeProfileSchema = z
  .object({
    id: claudeProfileIdSchema,
    label: z.string().trim().min(1).max(80),
    status: z.enum([
      "ready",
      "sign-in-required",
      "duplicate-account",
      "wrong-account",
      "unavailable",
    ]),
    loginExpiresAt: z.iso.datetime().nullable(),
  })
  .strict();

export const claudeProfileLoginStateSchema = z.enum([
  "idle",
  "running",
  "finished",
  "failed",
]);

export const claudeProfileManagementRequestSchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("list") }).strict(),
    z
      .object({
        action: z.literal("add"),
        label: claudeProfileSchema.shape.label,
        adoptExisting: z.literal(true).optional(),
      })
      .strict(),
    z
      .object({ action: z.literal("status"), profileId: claudeProfileIdSchema })
      .strict(),
    z
      .object({
        action: z.literal("loginStart"),
        profileId: claudeProfileIdSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("loginGet"),
        profileId: claudeProfileIdSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("loginCancel"),
        profileId: claudeProfileIdSchema,
      })
      .strict(),
  ],
);

const loginResult = z
  .object({
    action: z.enum(["loginStart", "loginGet", "loginCancel"]),
    profile: claudeProfileSchema,
    loginState: claudeProfileLoginStateSchema,
  })
  .strict();

export const claudeProfileManagementResultSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("list"),
        supported: z.boolean(),
        profiles: z.array(claudeProfileSchema),
      })
      .strict(),
    z
      .object({ action: z.literal("add"), profile: claudeProfileSchema })
      .strict(),
    z
      .object({ action: z.literal("status"), profile: claudeProfileSchema })
      .strict(),
    loginResult,
  ],
);

export type ClaudeProfile = z.infer<typeof claudeProfileSchema>;

export type ClaudeProfileLoginState = z.infer<
  typeof claudeProfileLoginStateSchema
>;

export type ClaudeProfileManagementRequest = z.infer<
  typeof claudeProfileManagementRequestSchema
>;

export type ClaudeProfileManagementResult = z.infer<
  typeof claudeProfileManagementResultSchema
>;

export const claudeProfileManageCommandSchema = z
  .object({
    type: z.literal("claude-profile/manage"),
    request: claudeProfileManagementRequestSchema,
  })
  .strict();
