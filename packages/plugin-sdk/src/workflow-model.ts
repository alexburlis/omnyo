import { defineRpcContract } from "./rpc-contract.js";
import { z } from "zod";

const id = z.string().min(1).max(200);

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Buffer.byteLength(value, "utf8") <= max);

const workflowModelInputSchema = z
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

const workflowModelFailureCodeSchema = z.enum([
  "caller_not_allowed",
  "subscription_transport_unverified",
  "allowance_unavailable",
  "invalid_response",
  "request_failed",
  "timeout",
  "cancelled",
]);

const workflowModelFailureSchema = z
  .object({
    ok: z.literal(false),
    attemptId: id,
    code: workflowModelFailureCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

const workflowModelResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      attemptId: id,
      text: boundedText(64 * 1024),
    })
    .strict(),
  workflowModelFailureSchema,
]);

const workflowModelCapabilitiesSchema = z.union([
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

export type ExperimentalWorkflowModelV1Capabilities = z.infer<
  typeof workflowModelCapabilitiesSchema
>;

export type ExperimentalWorkflowModelV1Input = z.infer<
  typeof workflowModelInputSchema
>;

export type ExperimentalWorkflowModelV1Result = z.infer<
  typeof workflowModelResultSchema
>;

export type ExperimentalWorkflowModelV1FailureCode = z.infer<
  typeof workflowModelFailureCodeSchema
>;

const workflowModelContract = defineRpcContract({
  workflowModelCapabilities: {
    input: workflowModelInputSchema.pick({ hostId: true, model: true }),
    output: workflowModelCapabilitiesSchema,
  },
  workflowModelComplete: {
    input: workflowModelInputSchema,
    output: workflowModelResultSchema,
  },
});

export const experimental_workflowModelV1 = {
  inputSchema: workflowModelInputSchema,
  resultSchema: workflowModelResultSchema,
  capabilitiesSchema: workflowModelCapabilitiesSchema,
  failureSchema: workflowModelFailureSchema,
  failureCodeSchema: workflowModelFailureCodeSchema,
  contract: workflowModelContract,
} as const;
