import { createHash } from "node:crypto";
import { z } from "zod";
import type { Account } from "./contracts.js";

export const MODEL_CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const MODEL_CATALOG_PROBE_TIMEOUT_MS = 10_000;

export const MODEL_CATALOG_LIST_WAIT_MS = 3_000;

export const MODEL_CATALOG_RETRY_MS = 5 * 60 * 1_000;

export const MODEL_CATALOG_INVALIDATION_INTERVAL_MS = 10 * 60 * 1_000;

export const MAX_MODEL_CATALOG_BYTES = 4 * 1024 * 1024;

export const catalogModelSchema = z
  .object({
    slug: z.string().min(1),
    visibility: z.string().nullable(),
    entry: z.record(z.string(), z.unknown()),
  })
  .strict();

export type CatalogModel = z.infer<typeof catalogModelSchema>;

export const modelCatalogSchema = z
  .object({
    accountId: z.string().uuid(),
    plan: z.string().nullable(),
    clientVersion: z.string().nullable(),
    etag: z.string().nullable(),
    fetchedAt: z.number().int(),
    models: z.array(catalogModelSchema),
  })
  .strict();

export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export type ModelCatalogHeader = Omit<ModelCatalog, "models">;

const upstreamEntrySchema = z
  .object({ slug: z.string().min(1), visibility: z.unknown().optional() })
  .passthrough();

const upstreamCatalogSchema = z
  .object({ models: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

const openAiModelListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

export function codexCatalogFromOpenAi(text: string): string | null {
  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }

  const list = openAiModelListSchema.safeParse(payload);

  if (!list.success) return null;

  const models = list.data.data.flatMap(({ id }) => {
    const match =
      /^gpt-([56])(?:\.(\d+))?(?:-(astra|sol|terra|luna|codex(?:-max|-mini)?|mini|nano))?$/u.exec(
        id,
      );

    return match === null
      ? []
      : [
          {
            id,
            generation: Number(match[1]),
            revision: Number(match[2] ?? 0),
            preferred: Number(match[3] === "sol"),
          },
        ];
  });

  return JSON.stringify({
    models: models
      .sort(
        (a, b) =>
          b.generation - a.generation ||
          b.revision - a.revision ||
          b.preferred - a.preferred ||
          a.id.localeCompare(b.id),
      )
      .map(({ id }, priority) => ({
        slug: id,
        display_name: id,
        default_reasoning_level: "medium",
        visibility: "list",
        priority,
      })),
  });
}

export interface ParsedModelCatalog {
  body: Record<string, unknown>;
  entries: Record<string, unknown>[];
  models: CatalogModel[];
}

export function parseModelCatalog(text: string): ParsedModelCatalog | null {
  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = upstreamCatalogSchema.safeParse(payload);

  if (!parsed.success) return null;
  const seen = new Set<string>();
  const models: CatalogModel[] = [];

  for (const entry of parsed.data.models) {
    const model = upstreamEntrySchema.safeParse(entry);

    if (!model.success || seen.has(model.data.slug)) continue;
    seen.add(model.data.slug);
    models.push({
      slug: model.data.slug,
      visibility:
        typeof model.data.visibility === "string"
          ? model.data.visibility
          : null,
      entry,
    });
  }

  return { body: parsed.data, entries: parsed.data.models, models };
}

export function isActiveModelCatalog(
  account: Pick<Account, "id" | "subscriptionType">,
  catalog: ModelCatalogHeader,
  now: number,
): boolean {
  return (
    catalog.accountId === account.id &&
    catalog.plan === account.subscriptionType &&
    now - catalog.fetchedAt < MODEL_CATALOG_TTL_MS
  );
}

export function listsModel(model: CatalogModel): boolean {
  return model.visibility !== "hide";
}

const serviceTierListSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      name: z.string(),
      description: z.string(),
    })
    .passthrough(),
);

const legacySpeedTierListSchema = z.array(z.string().min(1));

export function codexServiceTierId(id: string): string {
  return id === "fast" ? "priority" : id;
}

function serviceTiers(entry: Record<string, unknown>) {
  const advertised = serviceTierListSchema.safeParse(entry.service_tiers).data;

  return (
    advertised ??
    (
      legacySpeedTierListSchema.safeParse(entry.additional_speed_tiers).data ??
      []
    ).map((id) => ({
      id: codexServiceTierId(id),
      name: id === "fast" ? "Fast" : id,
      description: "",
    }))
  );
}

export function advertisesServiceTier(
  entry: Record<string, unknown>,
  tier: string,
): boolean {
  return serviceTiers(entry).some(({ id }) => codexServiceTierId(id) === tier);
}

function mergeServiceTiers(
  base: Record<string, unknown>,
  other: Record<string, unknown>,
) {
  const tiers = new Map(
    serviceTiers(base).map((tier) => [codexServiceTierId(tier.id), tier]),
  );

  const initialSize = tiers.size;

  for (const tier of serviceTiers(other)) {
    const id = codexServiceTierId(tier.id);

    if (!tiers.has(id)) tiers.set(id, tier);
  }

  if (tiers.size === initialSize) return base;

  return {
    ...base,
    service_tiers: [...tiers.values()],
    additional_speed_tiers: [...tiers.keys()].map((id) =>
      id === "priority" ? "fast" : id,
    ),
  };
}

export interface MergedModelCatalog {
  text: string;
  changed: boolean;
}

export function mergeModelCatalogs(
  base: ParsedModelCatalog,
  others: readonly ModelCatalog[],
): MergedModelCatalog {
  const entries = [...base.entries];
  const positions = new Map<string, number>();

  for (const [index, entry] of entries.entries()) {
    const slug = entry.slug;

    if (typeof slug === "string" && !positions.has(slug))
      positions.set(slug, index);
  }

  let changed = false;

  const priorities = base.models.flatMap(({ entry }) =>
    typeof entry.priority === "number" && Number.isFinite(entry.priority)
      ? [entry.priority]
      : [],
  );

  let nextPriority = priorities.length === 0 ? null : Math.max(...priorities);

  for (const catalog of others) {
    for (const model of catalog.models) {
      if (!listsModel(model)) continue;
      const index = positions.get(model.slug);
      const existing = index === undefined ? undefined : entries[index];

      if (index !== undefined && existing !== undefined) {
        const withTiers = mergeServiceTiers(existing, model.entry);

        if (withTiers !== existing) {
          entries[index] = withTiers;
          changed = true;
        }

        continue;
      }

      changed = true;
      positions.set(model.slug, entries.length);

      if (nextPriority === null || typeof model.entry.priority !== "number") {
        entries.push(model.entry);
        continue;
      }

      nextPriority += 1;
      entries.push({ ...model.entry, priority: nextPriority });
    }
  }

  return {
    text: JSON.stringify({ ...base.body, models: entries }),
    changed,
  };
}

export function mergedCatalogEtag(text: string): string {
  return `W/"omnyo-${createHash("sha256").update(text).digest("hex").slice(0, 32)}"`;
}
