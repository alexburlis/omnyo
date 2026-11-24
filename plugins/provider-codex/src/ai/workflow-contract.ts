import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(200);

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Buffer.byteLength(value, "utf8") <= max);

export const workflowModelInputSchema = z
  .object({
    hostId: id,
    attemptId: id,
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    prompt: boundedText(128 * 1024),
    timeoutMs: z.number().int().min(1).max(60_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export const workflowModelFailureCodeSchema = z.enum([
  "caller_not_allowed",
  "subscription_transport_unverified",
  "allowance_unavailable",
  "invalid_response",
  "request_failed",
  "timeout",
  "cancelled",
]);

export const workflowModelFailureSchema = z
  .object({
    ok: z.literal(false),
    attemptId: id,
    code: workflowModelFailureCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

export const workflowModelResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      attemptId: id,
      text: boundedText(64 * 1024),
    })
    .strict(),
  workflowModelFailureSchema,
]);

export const workflowModelCapabilitiesSchema = z.union([
  z.object({ available: z.literal(true) }).strict(),
  z
    .object({
      available: z.literal(false),
      code: z.enum([
        "caller_not_allowed",
        "subscription_transport_unverified",
        "allowance_unavailable",
      ]),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);

export type WorkflowModelCapabilities = z.infer<
  typeof workflowModelCapabilitiesSchema
>;

export type WorkflowModelInput = z.infer<typeof workflowModelInputSchema>;

export type WorkflowModelResult = z.infer<typeof workflowModelResultSchema>;

export type WorkflowModelFailureCode = z.infer<
  typeof workflowModelFailureCodeSchema
>;

export const workflowModelContract = defineRpcContract({
  workflowModelCapabilities: {
    input: workflowModelInputSchema.pick({ hostId: true, model: true }),
    output: workflowModelCapabilitiesSchema,
  },
  workflowModelComplete: {
    input: workflowModelInputSchema,
    output: workflowModelResultSchema,
  },
});
