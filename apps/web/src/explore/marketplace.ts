import { explorePath, normalizeExploreQuery } from "./catalog";
import {
  PUBLIC_SKILLS_PAGE_SIZE,
  validatePublicSkillsSearch,
  type PublicSkill,
  type PublicSkillCategory,
  type PublicSkillsSearch,
} from "./public-skills";

export const marketplaceKinds = ["skill", "workflow", "connector"] as const;

export const marketplaceLabels = {
  skill: "Skills",
  workflow: "Workflows",
  connector: "Connectors",
} as const;

const auxiliaryKinds = ["prompt", "plugin", "guide"] as const;

export type MarketplaceKind = (typeof marketplaceKinds)[number];

interface MarketplaceListing {
  slug: string;
  title: string;
  summary?: string;
  publisher: string;
  category: PublicSkillCategory;
  keywords: string[];
  detailPath: string;
}

export interface MarketplaceWorkflow extends MarketplaceListing {
  kind: "workflow";
  sha256: string;
  requirements: string;
}

export interface MarketplaceConnector extends MarketplaceListing {
  kind: "connector";
  pluginId: string;
  service: string;
  requirements: string;
  availability: string;
}

export type MarketplaceItem =
  | (PublicSkill & { kind: "skill" })
  | MarketplaceWorkflow
  | MarketplaceConnector;

export const marketplaceSources = ["omnyo", "github"] as const;

export type MarketplaceSource = (typeof marketplaceSources)[number];

export interface MarketplaceSearch extends PublicSkillsSearch {
  type?: MarketplaceKind | (typeof auxiliaryKinds)[number];
  source?: MarketplaceSource;
  license?: string;
}

export function validateMarketplaceSearch(
  search: Record<string, unknown>,
): MarketplaceSearch {
  const type = [...marketplaceKinds, ...auxiliaryKinds].find(
    (kind) => kind === search.type,
  );

  const source = marketplaceSources.find(
    (candidate) => candidate === search.source,
  );

  const license =
    typeof search.license === "string" &&
    /^[A-Za-z0-9.+-]{1,32}$/u.test(search.license)
      ? search.license
      : undefined;

  return {
    ...validatePublicSkillsSearch(search),
    ...(type ? { type } : {}),
    ...(source ? { source } : {}),
    ...(license ? { license } : {}),
  };
}

export function isAuxiliaryExploreKind(
  kind: MarketplaceSearch["type"],
): kind is (typeof auxiliaryKinds)[number] {
  return auxiliaryKinds.some((candidate) => candidate === kind);
}

export function marketplaceHref(search: MarketplaceSearch = {}): string {
  const params = new URLSearchParams();

  if (search.type) params.set("type", search.type);

  if (search.q) params.set("q", search.q);

  if (search.category) params.set("category", search.category);

  if (search.publisher) params.set("publisher", search.publisher);

  if (search.source) params.set("source", search.source);

  if (search.license) params.set("license", search.license);

  if (search.page && search.page > 1) params.set("page", String(search.page));

  const query = params.toString();

  return query ? `${explorePath}?${query}` : explorePath;
}

export function filterMarketplaceItems(
  items: readonly MarketplaceItem[],
  { type, q, category, publisher, source, license }: MarketplaceSearch,
): MarketplaceItem[] {
  const terms = normalizeExploreQuery(q ?? "")
    .split(" ")
    .filter(Boolean);

  return items.filter((item) => {
    if (type && type !== item.kind) return false;

    if (category && category !== item.category) return false;

    if (publisher && publisher !== item.publisher) return false;

    if (source && (item.kind !== "skill" || item.source !== source))
      return false;

    if (license && (item.kind !== "skill" || item.license !== license))
      return false;

    const searchable = [
      item.slug,
      item.title,
      item.summary,
      item.publisher,
      item.category,
      ...item.keywords,
    ]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => searchable.includes(term));
  });
}

export function marketplacePage(
  items: readonly MarketplaceItem[],
  search: MarketplaceSearch,
) {
  const matches = filterMarketplaceItems(items, search);

  const lastPage = Math.max(
    1,
    Math.ceil(matches.length / PUBLIC_SKILLS_PAGE_SIZE),
  );

  const page = Math.min(search.page ?? 1, lastPage);
  const start = (page - 1) * PUBLIC_SKILLS_PAGE_SIZE;

  return {
    items: matches.slice(start, start + PUBLIC_SKILLS_PAGE_SIZE),
    total: matches.length,
    page,
    lastPage,
  };
}
