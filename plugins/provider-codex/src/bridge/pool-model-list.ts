import { z } from "zod";
import { parseModelCatalog, type CodexModelCatalog } from "../models.js";

const POOLED_CATALOG_TIMEOUT_MS = 10_000;

const pooledCatalogSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string(),
      description: z.string().nullish(),
      visibility: z.string(),
      priority: z.number().int(),
      default_reasoning_level: z.string().nullish(),
      supported_reasoning_levels: z
        .array(
          z.object({
            effort: z.string(),
            description: z.string(),
          }),
        )
        .optional(),
      service_tiers: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
          }),
        )
        .optional(),
      additional_speed_tiers: z.array(z.string()).optional(),
      available_access_programs: z.unknown().optional(),
    }),
  ),
});

export async function listPooledModelCatalog({
  baseUrl,
  token,
  clientVersion,
}: {
  baseUrl: string;
  token: string;
  clientVersion: string | null;
}): Promise<CodexModelCatalog> {
  if (clientVersion === null) {
    throw new Error(
      "Could not determine the Codex version for pooled model discovery.",
    );
  }

  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/models`;
  url.searchParams.set("client_version", clientVersion);

  const response = await fetch(url, {
    headers: { "x-omnyo-account-pool-token": token },
    redirect: "error",
    signal: AbortSignal.timeout(POOLED_CATALOG_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Account Pooler model discovery failed with HTTP ${response.status}.`,
    );
  }

  const catalog = pooledCatalogSchema.safeParse(await response.json());

  if (!catalog.success) {
    throw new Error("Account Pooler returned an invalid Codex model catalog.");
  }

  const listed = catalog.data.models
    .filter((model) => model.visibility === "list")
    .sort((a, b) => a.priority - b.priority);

  return parseModelCatalog({
    data: listed.map((model, index) => ({
      id: model.slug,
      model: model.slug,
      displayName: model.display_name,
      description: model.description,
      defaultReasoningEffort: model.default_reasoning_level ?? "none",
      supportedReasoningEfforts: model.supported_reasoning_levels?.map(
        ({ effort, description }) => ({ reasoningEffort: effort, description }),
      ),
      serviceTiers: model.service_tiers,
      additionalSpeedTiers: model.additional_speed_tiers ?? [],
      availableAccessPrograms: model.available_access_programs,
      isDefault: index === 0,
    })),
  });
}
