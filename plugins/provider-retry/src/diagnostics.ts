import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { retryAvailabilitySchema } from "./retry-contract.js";

export const retryAvailabilityLookupSchema = z.union([
  retryAvailabilitySchema,
  z.object({ kind: z.literal("lookup-failed") }),
]);

export type RetryAvailabilityLookup = z.infer<
  typeof retryAvailabilityLookupSchema
>;

export const retryDiagnosticSchema = z.object({
  requestId: z.string(),
  observedAt: z.number(),
  availability: retryAvailabilityLookupSchema,
  decision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("decline"), reason: z.string() }),
    z.object({
      kind: z.literal("retry"),
      reason: z.string(),
      sendAt: z.number(),
    }),
  ]),
});

export type RetryDiagnostic = z.infer<typeof retryDiagnosticSchema>;

export const retryDiagnosticContract = defineRpcContract({
  "decision.get": {
    input: z.object({ threadId: z.string().min(1) }),
    output: retryDiagnosticSchema.nullable(),
  },
});

export async function readRetryDiagnostic(
  api: PluginApi,
  threadId: string,
): Promise<RetryDiagnostic | null> {
  return retryDiagnosticSchema
    .nullable()
    .parse((await api.storage.kv.get(`decision:${threadId}`)) ?? null);
}
