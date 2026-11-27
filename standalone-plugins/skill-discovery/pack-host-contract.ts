import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { maxPackBytes, packDigestSchema } from "./pack.ts";

const destinationInput = z
  .object({
    workspacePath: z.string().min(1).max(4096),
    artifact: z
      .object({
        text: z.string().min(1).max(maxPackBytes),
        digest: packDigestSchema,
      })
      .strict(),
  })
  .strict();

export const packHostContract = defineRpcContract({
  inspect: {
    input: destinationInput,
    output: z.discriminatedUnion("destination", [
      z.object({
        destination: z.literal("available"),
        receipt: z.null(),
        workspaceIdentity: packDigestSchema,
      }),
      z.object({
        destination: z.enum(["recoverable", "installed"]),
        receipt: z.uuid(),
        workspaceIdentity: packDigestSchema,
      }),
    ]),
  },
  install: {
    input: destinationInput.extend({ workspaceIdentity: packDigestSchema }),
    output: z.object({ receipt: z.uuid() }),
  },
});
