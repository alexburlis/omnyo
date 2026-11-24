import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { usageProofSchema } from "@omnyo/domain/usage-telemetry";
import { mutateManagedJsonFile } from "@omnyo/config/managed-json-file";
import { resolveCliDataDir } from "./data-dir.js";

const stateSchema = z
  .object({
    active: usageProofSchema.nullable(),
    proofs: z.array(usageProofSchema).max(64),
  })
  .strict();

export type CliUsageConsent = z.infer<typeof stateSchema>;

function location(baseUrl: string): string {
  return join(
    resolveCliDataDir(),
    "client-usage",
    `${createHash("sha256").update(new URL(baseUrl).origin).digest("hex")}.json`,
  );
}

export function readCliUsageConsent(baseUrl: string): CliUsageConsent {
  try {
    return stateSchema.parse(
      JSON.parse(readFileSync(location(baseUrl), "utf8")),
    );
  } catch {
    return { active: null, proofs: [] };
  }
}

export async function saveCliUsageConsent(
  baseUrl: string,
  value: CliUsageConsent,
  erasedProofs: readonly string[] = [],
): Promise<void> {
  await mutateManagedJsonFile({
    path: location(baseUrl),
    read: async () => readCliUsageConsent(baseUrl),
    mutate: (current) =>
      stateSchema.parse({
        ...value,
        proofs: [...new Set([...current.proofs, ...value.proofs])]
          .filter((proof) => !erasedProofs.includes(proof))
          .slice(-64),
      }),
  });
}
