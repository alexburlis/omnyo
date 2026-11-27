import {
  EXPLORE_KINDS,
  normalizeExploreQuery,
  type ExploreKind,
} from "@omnyo/domain/explore-catalog";

import { SITE_URL } from "../landing/site";

export {
  EXPLORE_KINDS,
  EXPLORE_QUERY_MAX_LENGTH,
  filterExploreItems,
  normalizeExploreQuery,
  type ExploreCta,
  type ExploreItem,
  type ExploreKind,
  type ExplorePreview,
} from "@omnyo/domain/explore-catalog";

export const EXPLORE_KIND_LABELS: Record<
  ExploreKind,
  { one: string; many: string }
> = {
  prompt: { one: "Prompt", many: "Prompts" },
  workflow: { one: "Workflow", many: "Workflows" },
  skill: { one: "Skill pack", many: "Skill packs" },
  plugin: { one: "Plugin", many: "Plugins" },
  guide: { one: "Guide", many: "Guides" },
};

export const explorePath = "/explore";

export const explorePromptPath = (slug: string) =>
  `${explorePath}/prompts/${slug}`;

export const explorePromptTextPath = (slug: string) =>
  `${explorePromptPath(slug)}/text`;

export const explorePluginPath = (slug: string) =>
  `${explorePath}/plugins/${slug}`;

export const exploreSkillPath = (slug: string) =>
  `${explorePath}/skills/${slug}`;

export const exploreSkillFilePath = (slug: string, sha256: string) =>
  `${exploreSkillPath(slug)}/file/${sha256}`;

export const canonicalExploreUrl = (path: string) => `${SITE_URL}${path}`;

export interface ExploreItemKey {
  kind: ExploreKind;
  slug: string;
}

export interface ExploreLink {
  kind: ExploreKind;
  title: string;
  path: string;
}

export interface ExploreSearch {
  type?: ExploreKind;
  q?: string;
}

export const exploreKey = ({ kind, slug }: ExploreItemKey) => `${kind}/${slug}`;

export function isExploreKind(value: unknown): value is ExploreKind {
  return (
    typeof value === "string" &&
    (EXPLORE_KINDS as readonly string[]).includes(value)
  );
}

export function validateExploreSearch(
  search: Record<string, unknown>,
): ExploreSearch {
  const raw =
    typeof search.q === "string" || typeof search.q === "number"
      ? normalizeExploreQuery(String(search.q))
      : "";

  return {
    ...(isExploreKind(search.type) ? { type: search.type } : {}),
    ...(raw ? { q: raw } : {}),
  };
}

export function exploreSearchHref(search: ExploreSearch): string {
  const params = new URLSearchParams();

  if (search.type) params.set("type", search.type);

  if (search.q) params.set("q", search.q);

  const query = params.toString();

  return query ? `${explorePath}?${query}` : explorePath;
}
