import type { MarketplaceItem, MarketplaceKind } from "./marketplace";
import { marketplaceItems } from "./marketplace.server";
import { orderMarketplaceItems } from "./marketplace-view";
import {
  exploreSkillSource,
  type SkillPackResearch,
} from "./skill-packs.server";

const PREVIEW_LINES = 48;

const RELATED_LIMIT = 6;

const editionFiles = import.meta.glob<string>(
  "../../public/skills/omnyo/*/*/SKILL.md",
  { query: "?raw", import: "default", eager: true },
);

export interface MarketplaceDetail {
  item: MarketplaceItem;
  related: MarketplaceItem[];
  preview: { lines: string[]; truncated: boolean } | null;
  packResearch?: SkillPackResearch;
}

function editionPreview(slug: string, version: string) {
  const text =
    editionFiles[`../../public/skills/omnyo/${slug}/${version}/SKILL.md`];

  if (text === undefined) return null;

  const body = text.replace(/^---\n[\s\S]*?\n---\n+/u, "").trimEnd();
  const lines = body.split("\n");

  return {
    lines: lines.slice(0, PREVIEW_LINES),
    truncated: lines.length > PREVIEW_LINES,
  };
}

export function marketplaceDetail(
  kind: MarketplaceKind,
  slug: string,
): MarketplaceDetail | null {
  const item = marketplaceItems.find(
    (candidate) => candidate.kind === kind && candidate.slug === slug,
  );

  if (!item) return null;

  const related = orderMarketplaceItems(
    marketplaceItems.filter(
      (candidate) => candidate !== item && candidate.category === item.category,
    ),
    "featured",
  ).slice(0, RELATED_LIMIT);

  const preview =
    item.kind === "skill" && item.source === "omnyo"
      ? editionPreview(item.slug, item.revision)
      : null;

  const packResearch =
    item.kind === "skill" && item.packSlug !== undefined
      ? exploreSkillSource(item.packSlug)?.detail.research
      : undefined;

  return {
    item,
    related,
    preview,
    ...(packResearch === undefined ? {} : { packResearch }),
  };
}
