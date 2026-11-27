import { createHash } from "node:crypto";
import { z } from "zod";
import { assetsSchema, researchProvenanceSchema } from "./contracts.js";

const { keyword, site, retrievedAt } = researchProvenanceSchema.shape;

const evidenceSchema = z.strictObject({
  source: z.literal("OpenSEO saved keywords"),
  meaning: z.string().max(256),
  site,
  retrievedAt,
  keywords: z
    .array(
      z.strictObject({
        keyword,
        intent: z.string().max(100).nullable(),
        volume: z.int().nonnegative().nullable(),
      }),
    )
    .min(1)
    .max(50),
});

export function frozenOpenSeoEvidence(inputs: z.infer<typeof assetsSchema>["inputs"]) {
  if (inputs.openSeoEvidence === undefined) return undefined;

  const evidence = evidenceSchema.parse(
    JSON.parse(z.string().max(65536).parse(inputs.openSeoEvidence)),
  );

  const keywords = new Map<string, string>();

  for (const { keyword } of evidence.keywords) {
    const normalized = keyword.normalize("NFKC").toLowerCase();

    if (!keywords.has(normalized)) keywords.set(normalized, keyword);
  }

  return {
    site: evidence.site,
    retrievedAt: evidence.retrievedAt,
    keywords: [...keywords.values()],
  };
}

export function openSeoFocus(
  evidence: ReturnType<typeof frozenOpenSeoEvidence>,
  candidateIndex: number,
) {
  const keyword = evidence?.keywords[candidateIndex];

  if (!evidence || !keyword) return undefined;

  const normalized = keyword.normalize("NFKC").toLowerCase();

  const canonicalTopic =
    normalized.length <= 256
      ? normalized
      : `openseo:${createHash("sha256").update(normalized).digest("hex")}`;

  return {
    canonicalTopic,
    research: researchProvenanceSchema.parse({
      kind: "openseo",
      keyword,
      site: evidence.site,
      retrievedAt: evidence.retrievedAt,
    }),
  };
}
