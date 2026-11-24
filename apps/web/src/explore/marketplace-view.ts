import { exploreSkillPath, normalizeExploreQuery } from "./catalog";
import {
  filterMarketplaceItems,
  type MarketplaceItem,
  type MarketplaceKind,
  type MarketplaceSearch,
} from "./marketplace";
import { workflowPreviewPath } from "../workflow-catalog/catalog";

export const marketplaceSingular = {
  skill: "Skill",
  workflow: "Workflow",
  connector: "Connector",
} as const satisfies Record<MarketplaceKind, string>;

export const marketplaceLicenses = ["MIT", "Apache-2.0", "MPL-2.0"] as const;

export type MarketplaceFilterKey =
  | "type"
  | "category"
  | "publisher"
  | "source"
  | "license";

export const marketplaceItemKey = (item: MarketplaceItem) =>
  `${item.kind}/${item.slug}`;

export const isOmnyoEdition = (item: MarketplaceItem) =>
  item.kind === "skill" && item.source === "omnyo";

function rank(item: MarketplaceItem) {
  if (item.kind === "workflow") return 0;

  if (item.kind === "connector") return 1;

  return item.source === "omnyo" ? 2 : 3;
}

export function orderMarketplaceItems(
  items: readonly MarketplaceItem[],
  sort: "featured" | "az",
): MarketplaceItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      sort === "az"
        ? a.item.title.localeCompare(b.item.title, "en")
        : rank(a.item) - rank(b.item) || a.index - b.index,
    )
    .map(({ item }) => item);
}

export function facetCounts<Value extends string>(
  items: readonly MarketplaceItem[],
  search: MarketplaceSearch,
  key: MarketplaceFilterKey,
  values: readonly Value[],
  valueOf: (item: MarketplaceItem) => string | undefined,
): Array<[Value, number]> {
  const counts = new Map<string, number>(values.map((value) => [value, 0]));

  for (const item of filterMarketplaceItems(items, {
    ...search,
    [key]: undefined,
  })) {
    const value = valueOf(item);

    if (value !== undefined && counts.has(value))
      counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return values.map((value) => [value, counts.get(value) ?? 0]);
}

function slugHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function catalogWallRows(
  items: readonly MarketplaceItem[],
  perRow: number,
): MarketplaceItem[][] {
  const skills = items
    .filter((item) => item.kind === "skill")
    .map((item) => ({ item, order: slugHash(item.slug) }))
    .sort((a, b) => a.order - b.order)
    .map(({ item }) => item);

  const others = items.filter((item) => item.kind !== "skill");

  const editions = skills.filter(isOmnyoEdition);
  const linked = skills.filter((item) => !isOmnyoEdition(item));

  return [0, 1, 2].map((row) => {
    const rowEditions = editions
      .filter((_, index) => index % 3 === row)
      .slice(0, 3);

    const picked: MarketplaceItem[] = linked
      .filter((_, index) => index % 3 === row)
      .slice(0, perRow - 1 - rowEditions.length);

    rowEditions.forEach((edition, index) =>
      picked.splice(5 + index * 7, 0, edition),
    );

    const lead = others[row];

    if (lead) picked.splice(2, 0, lead);

    return picked;
  });
}

export function listingInitials(title: string) {
  return title
    .replace(/[^A-Za-z0-9 ]/gu, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

export interface MarketplaceAction {
  label: string;
  href: string;
  external?: boolean;
  download?: string;
}

function skillSourcePath(sourceUrl: string, owned: boolean) {
  return owned ? new URL(sourceUrl).pathname : sourceUrl;
}

export function marketplaceActions(item: MarketplaceItem): MarketplaceAction[] {
  if (item.kind === "workflow")
    return [
      { label: "Get workflow", href: `${item.detailPath}#get-workflow` },
      { label: "View listing", href: item.detailPath },
    ];

  if (item.kind === "connector")
    return [
      { label: "Find in Omnyo", href: `${item.detailPath}#find-in-omnyo` },
      { label: "Setup details", href: item.detailPath },
    ];

  const owned = item.source === "omnyo";
  const source = skillSourcePath(item.sourceUrl, owned);

  if (item.packSlug !== undefined)
    return [
      { label: "Get the skill pack", href: exploreSkillPath(item.packSlug) },
      { label: "Download coordinator", href: source, download: "SKILL.md" },
    ];

  if (item.setupUrl !== undefined)
    return [
      { label: "Setup instructions", href: item.setupUrl, external: true },
      { label: "View source", href: source, external: true },
    ];

  return [
    {
      label: "Open in Omnyo",
      href: `omnyo://skills/source/${item.slug}/${item.sha256}`,
    },
    owned
      ? { label: "Download SKILL.md", href: source, download: "SKILL.md" }
      : { label: "View source", href: source, external: true },
  ];
}

export function installSteps(item: MarketplaceItem): string[] {
  if (item.kind === "workflow")
    return [
      "Get the workflow from its listing",
      "Review the import in Omnyo before it is saved",
      "Choose your own sources, then run it",
    ];

  if (item.kind === "connector")
    return [
      "Find the plugin in Omnyo’s plugin settings",
      "Connect the account you already use",
      "Use it from any chat",
    ];

  if (item.setupUrl !== undefined)
    return [
      "Open the publisher’s setup instructions",
      "Install the plugin in your coding agent",
      "Select the skill in Omnyo once it is available",
    ];

  if (item.packSlug !== undefined)
    return [
      "Open the skill pack",
      "Review the included skills and prompts in Omnyo",
      "Install the pack for your workspace",
    ];

  return [
    "Open it in Omnyo with one click",
    "Review the exact files Omnyo screened",
    "Install it for your workspace",
  ];
}

export function revisionLabel(item: MarketplaceItem) {
  if (item.kind === "workflow") return `sha256 ${item.sha256.slice(0, 7)}`;

  if (item.kind === "connector") return `plugin ${item.pluginId}`;

  return item.source === "omnyo"
    ? `v${item.revision}`
    : `@${item.revision.slice(0, 7)}`;
}

export function workflowPreview(item: MarketplaceItem) {
  return item.kind === "workflow"
    ? {
        src: workflowPreviewPath(item.slug),
        alt: `Example output from ${item.title}`,
        width: 1200,
        height: 630,
      }
    : null;
}

export function highlightParts(text: string, query: string) {
  const terms = normalizeExploreQuery(query).split(" ").filter(Boolean);

  if (!terms.length) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const marks = new Array<boolean>(text.length).fill(false);

  for (const term of terms) {
    let from = lower.indexOf(term);

    while (from !== -1) {
      marks.fill(true, from, from + term.length);
      from = lower.indexOf(term, from + term.length);
    }
  }

  const parts: Array<{ text: string; match: boolean }> = [];

  for (let index = 0; index < text.length; index += 1) {
    const last = parts.at(-1);

    if (last && last.match === marks[index]) last.text += text[index];
    else parts.push({ text: text[index] ?? "", match: marks[index] ?? false });
  }

  return parts;
}
