import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const COMMAND_TIMEOUT_MS = 20_000;

export const COMMAND_OUTPUT_MAX = 16_384;

const pathFactsSchema = z
  .object({
    exists: z.boolean(),
    kind: z.enum(["file", "directory", "other"]).nullable(),
    size: z.number().int().nonnegative().nullable(),
    modifiedAt: z.number().nullable(),
  })
  .strict();

const commandRunSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    timedOut: z.boolean(),
  })
  .strict();

export type PathFacts = z.infer<typeof pathFactsSchema>;

export type CommandRun = z.infer<typeof commandRunSchema>;

export const waitSourcesHostContract = defineRpcContract({
  stat: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: pathFactsSchema,
  },
  runCheck: {
    input: z.object({ command: z.string().min(1) }).strict(),
    output: commandRunSchema,
  },
});
