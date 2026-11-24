import { SITE_URL } from "../landing/site";

export const EXPLORE_KINDS = [
  "prompt",
  "workflow",
  "skill",
  "plugin",
  "guide",
] as const;

export type ExploreKind = (typeof EXPLORE_KINDS)[number];

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

export const EXPLORE_QUERY_MAX_LENGTH = 80;

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

export type ExploreCta =
  | { kind: "copy-prompt"; label: string; textPath: string }
  | { kind: "get-workflow"; label: string; path: string }
  | { kind: "get-skill-pack"; label: string; path: string }
  | {
      kind: "find-in-omnyo";
      label: string;
      pluginId: string;
      marketplace: string;
      install: string;
    }
  | { kind: "read-guide"; label: string; path: string };

export interface ExplorePreview {
  path: string;
  alt: string;
  width: number;
  height: number;
}

export interface ExploreItem {
  kind: ExploreKind;
  slug: string;
  title: string;
  summary: string;
  publisher: string;
  tags: string[];
  path: string;
  preview: ExplorePreview | null;
  cta: ExploreCta;
}

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

export function normalizeExploreQuery(raw: string): string {
  return raw
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, EXPLORE_QUERY_MAX_LENGTH)
    .trim()
    .toLowerCase();
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

export function filterExploreItems<
  Item extends Pick<ExploreItem, "kind" | "title" | "summary" | "tags">,
>(items: readonly Item[], filter: { kind?: ExploreKind; query?: string }) {
  const terms = normalizeExploreQuery(filter.query ?? "")
    .split(" ")
    .filter(Boolean);

  return items.filter((item) => {
    if (filter.kind !== undefined && item.kind !== filter.kind) return false;

    const haystack = [item.title, item.summary, ...item.tags]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function exploreSearchHref(search: ExploreSearch): string {
  const params = new URLSearchParams();

  if (search.type) params.set("type", search.type);

  if (search.q) params.set("q", search.q);

  const query = params.toString();

  return query ? `${explorePath}?${query}` : explorePath;
}
