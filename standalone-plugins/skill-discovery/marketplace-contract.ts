import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const marketplaceOrigin = "https://omnyohq.com";

export const marketplaceMaxBytes = 1024 * 1024;

export const marketplaceCategories = [
  "Design & UI",
  "Testing & security",
  "Coding & architecture",
  "Writing & documents",
  "Marketing & growth",
  "Research & data",
  "Product & teamwork",
  "Agent workflows",
  "Cloud & DevOps",
] as const;

const slug = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const sourceUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password && !url.port;
  }, "Expected a public HTTPS source URL");

const common = {
  slug,
  title: z.string().min(1).max(180),
  summary: z.string().min(1).max(1000).optional(),
  publisher: z.string().min(1).max(120),
  category: z.enum(marketplaceCategories),
  keywords: z.array(z.string().min(1).max(80)).max(32),
  detailPath: z.string().min(1).max(240),
};

export const marketplaceItemSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("skill"),
        source: z.enum(["github", "omnyo"]),
        sourceUrl,
        setupUrl: sourceUrl.optional(),
        revision: z.string().min(1).max(100),
        sha256,
        license: z.string().min(1).max(80),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("workflow"),
        sha256,
        requirements: z.string().min(1).max(2000),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("connector"),
        pluginId: slug,
        service: z.string().min(1).max(120),
        requirements: z.string().min(1).max(2000),
        availability: z.string().min(1).max(1000),
      })
      .strict(),
  ])
  .superRefine((item, context) => {
    const expected =
      item.kind === "skill"
        ? `/explore/skills/source/${item.slug}`
        : item.kind === "workflow"
          ? `/workflows/${item.slug}`
          : `/explore/plugins/${item.pluginId}`;

    if (item.detailPath !== expected || (item.kind === "connector" && item.slug !== item.pluginId))
      context.addIssue({
        code: "custom",
        message: "Marketplace identity and detail path disagree",
      });

    if (item.kind === "skill" && item.setupUrl !== undefined) {
      const setup = new URL(item.setupUrl);

      if (
        item.source !== "github" ||
        setup.origin !== "https://github.com" ||
        setup.search !== "" ||
        !setup.pathname.startsWith(`/${item.publisher}/blob/${item.revision}/`)
      )
        context.addIssue({
          code: "custom",
          path: ["setupUrl"],
          message: "Expected a setup URL at the pinned GitHub revision",
        });
    }
  });

export const marketplaceCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(marketplaceItemSchema).max(1024),
  })
  .strict()
  .superRefine((catalog, context) => {
    const paths = new Set<string>();

    for (const item of catalog.items) {
      if (paths.has(item.detailPath))
        context.addIssue({ code: "custom", message: "Duplicate marketplace detail path" });
      paths.add(item.detailPath);
    }
  });

export type MarketplaceItem = z.infer<typeof marketplaceItemSchema>;

export type MarketplaceCatalog = z.infer<typeof marketplaceCatalogSchema>;

export type MarketplaceFilters = {
  query: string;
  kind: string;
  category: string;
  publisher: string;
};

export function filterMarketplace(items: MarketplaceItem[], filters: MarketplaceFilters) {
  const terms = filters.query.toLowerCase().trim().slice(0, 80).split(/\s+/u).filter(Boolean);

  return items.filter((item) => {
    const text = [
      item.slug,
      item.title,
      item.summary ?? "",
      item.publisher,
      item.category,
      ...item.keywords,
    ]
      .join(" ")
      .toLowerCase();

    return (
      (!filters.kind || item.kind === filters.kind) &&
      (!filters.category || item.category === filters.category) &&
      (!filters.publisher || item.publisher === filters.publisher) &&
      terms.every((term) => text.includes(term))
    );
  });
}

export function workflowImportPath(item: Extract<MarketplaceItem, { kind: "workflow" }>) {
  return `/plugins/automations/automations/import/${item.sha256.slice(0, 32)}`;
}

export const marketplaceRpc = defineRpcContract({
  marketplaceGet: {
    input: z.object({}).strict(),
    output: z
      .object({
        catalog: marketplaceCatalogSchema,
        reviewedSkills: z.record(slug, z.string().min(1).max(160)),
      })
      .strict(),
  },
});
