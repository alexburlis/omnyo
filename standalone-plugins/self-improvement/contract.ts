import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const configSchema = z.object({
  environmentId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.enum([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
    "ultracode",
  ]),
});

export type Config = z.infer<typeof configSchema>;

export const targetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  path: z.string(),
  name: z.string(),
});

export type Target = z.infer<typeof targetSchema>;

export const rpcContract = defineRpcContract({
  config: { input: z.null(), output: configSchema.nullable() },
  save: { input: configSchema, output: configSchema },
  targets: { input: z.null(), output: z.array(targetSchema) },
});
