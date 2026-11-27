import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);

export const commandSpecSchema = z
  .object({
    attemptId: identity,
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
    rootPath: z.string().min(1).max(4096),
    cwd: z.string().max(4096),
    argv: z.array(z.string().max(16384)).min(1).max(256),
    deadlineAt: z.number().int().positive(),
    outputBytes: z.number().int().min(1024).max(1048576).default(1048576),
  })
  .strict();

export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const commandReceiptSchema = z
  .object({
    attemptId: identity,
    specHash: z.string(),
    status: z.enum([
      "launching",
      "running",
      "succeeded",
      "failed",
      "timed-out",
      "cancelled",
      "uncertain",
    ]),
    pid: z.number().int().positive().nullable(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
    exitCode: z.number().int().nullable(),
    reason: z.string().nullable(),
    quiescent: z.boolean(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

const lookup = z.object({ attemptId: identity, specHash: z.string() }).strict();

export const hostContract = defineRpcContract({
  submitInvocation: { input: commandSpecSchema, output: commandReceiptSchema },
  inspectInvocation: { input: lookup, output: commandReceiptSchema.nullable() },
  cancelInvocation: { input: lookup, output: commandReceiptSchema.nullable() },
  ackInvocation: { input: lookup, output: z.object({ acknowledged: z.boolean() }).strict() },
  readInvocationLog: {
    input: lookup.extend({
      cursor: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(32768),
    }),
    output: z
      .object({
        text: z.string(),
        nextCursor: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict(),
  },
});
