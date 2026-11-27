export const EXPLORE_KINDS = [
  "prompt",
  "workflow",
  "skill",
  "plugin",
  "guide",
] as const;

export type ExploreKind = (typeof EXPLORE_KINDS)[number];

export const EXPLORE_QUERY_MAX_LENGTH = 80;

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

export function normalizeExploreQuery(raw: string): string {
  return raw
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, EXPLORE_QUERY_MAX_LENGTH)
    .trim()
    .toLowerCase();
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
