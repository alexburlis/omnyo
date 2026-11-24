import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const machineOsSchema = z.enum(["macos", "windows", "linux"]);

export type MachineOs = z.infer<typeof machineOsSchema>;

export const machineFactsSchema = z
  .object({
    availableParallelism: z.number().int().positive(),
    os: machineOsSchema,
    arch: z.string().min(1),
    tools: z
      .object({
        xcode: z.boolean(),
        nvidiaGpu: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

export type MachineFacts = z.infer<typeof machineFactsSchema>;

export const concurrencyLimitHostContract = defineRpcContract({
  getCapacity: {
    input: z.null(),
    output: z
      .object({
        availableParallelism: z.number().int().positive(),
      })
      .strict(),
  },
  getMachineFacts: {
    input: z.null(),
    output: machineFactsSchema,
  },
});
