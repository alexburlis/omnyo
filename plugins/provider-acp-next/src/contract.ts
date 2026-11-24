import { defineRpcContract } from "@omnyo/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@omnyo/plugin-sdk/host";
import { experimental_acpAgentProbeSchema } from "@omnyo/plugin-sdk/provider-bridge/acp-next";
import { z } from "zod";

export const acpHostContract = defineRpcContract({
  probeAgent: {
    input: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      })
      .strict(),
    output: experimental_acpAgentProbeSchema,
  },
  ...experimental_nativeRootsHostContract,
});
