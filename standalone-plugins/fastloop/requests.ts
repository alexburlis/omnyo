import { z } from "zod";
import { idSchema, requirementsSchema, requirementSchema } from "./contracts.js";

const urlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);

      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "URL_INVALID");

const pathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").some((part) => ["", ".", ".."].includes(part)),
    "PATH_INVALID",
  );

export const changeSchema = z.strictObject({
  changeId: idSchema,
  files: z.array(pathSchema).max(256),
  patch: z.string().max(131072).optional(),
  baseRef: z.string().max(256).optional(),
  buildId: idSchema.optional(),
});

const budgetSchema = z.strictObject({
  wallMs: z.number().int().positive().max(3600000).optional(),
  maxActions: z.number().int().nonnegative().max(1000).optional(),
  maxDecisionsRequests: z.number().int().nonnegative().max(100).optional(),
  maxResponsesRequests: z.number().int().nonnegative().max(20).optional(),
  maxVisualReviews: z.number().int().nonnegative().max(20).optional(),
  maxObservationBytes: z.number().int().positive().max(1048576).optional(),
});

const common = {
  url: urlSchema,
  goal: z.string().min(1).max(8192),
  sessionId: idSchema.optional(),
  previousRunId: idSchema.optional(),
  budget: budgetSchema.optional(),
  visual: z.enum(["off", "checkpoints", "review"]).optional(),
  viewport: z
    .strictObject({
      width: z.number().int().min(240).max(7680),
      height: z.number().int().min(240).max(4320),
      deviceScaleFactor: z.number().min(0.5).max(4).optional(),
    })
    .optional(),
};

export const runSchema = z.strictObject({
  ...common,
  mode: z.enum(["navigate", "explore"]),
  requirements: z
    .array(requirementSchema)
    .max(64)
    .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 16384)
    .optional(),
});

export const verifySchema = z.strictObject({
  ...common,
  requirements: requirementsSchema,
  change: changeSchema.optional(),
});

export const submitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run"), request: runSchema }),
  z.strictObject({ kind: z.literal("verify"), request: verifySchema }),
]);
