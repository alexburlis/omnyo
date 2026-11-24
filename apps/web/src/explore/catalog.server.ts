import type { PluginManifestSummary } from "../plugin-guide/plugin-directory";
import type { PublicWorkflowListing } from "../workflow-catalog/catalog";
import {
  workflowListingPath,
  workflowPreviewPath,
} from "../workflow-catalog/catalog";
import {
  explorePluginPath,
  explorePromptPath,
  explorePromptTextPath,
  exploreSkillPath,
  exploreKey,
  type ExploreItem,
  type ExploreItemKey,
  type ExploreKind,
  type ExploreLink,
} from "./catalog";
import type { PromptSource } from "./prompts.server";
import type { ExploreSkillSource } from "./skill-packs.server";

export type ExploreActivation = "inactive" | "active";

interface RecordBase {
  slug: string;
  state: "draft" | "published";
  position: number;
  tags: readonly string[];
  related: readonly ExploreItemKey[];
}

export type ExploreRecord =
  | (RecordBase & { kind: "prompt" | "workflow" | "skill" | "guide" })
  | (RecordBase & {
      kind: "plugin";
      marketplace: string;
      capabilities: readonly string[];
      availability: string;
    });

export interface ExploreGuideSource {
  title: string;
  description: string;
  path: string;
}

export interface ExploreOwners {
  prompt(slug: string): PromptSource | undefined;
  workflow(slug: string): { listing: PublicWorkflowListing } | undefined;
  skill(slug: string): ExploreSkillSource | undefined;
  guide(slug: string): ExploreGuideSource | undefined;
  plugin(slug: string): PluginManifestSummary | undefined;
}

export interface ExplorePromptDetail {
  item: ExploreItem;
  prompt: PromptSource;
  related: ExploreLink[];
}

export interface ExplorePluginDetail {
  item: ExploreItem;
  plugin: PluginManifestSummary;
  marketplace: string;
  capabilities: readonly string[];
  availability: string;
  related: ExploreLink[];
}

export interface ExploreSkillDetail {
  item: ExploreItem;
  release: ExploreSkillSource["detail"];
  related: ExploreLink[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const OMNYO = "Omnyo";

function undiscoverable(status: number) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

function publicHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
    "x-content-type-options": "nosniff",
  };
}

export function isCanonicalPromptText(body: string): boolean {
  return (
    body.trim().length > 0 &&
    !body.includes("\r") &&
    body.endsWith("\n") &&
    !body.endsWith("\n\n")
  );
}

function validateRecords(records: readonly ExploreRecord[]) {
  const keys = new Set<string>();

  for (const record of records) {
    const key = exploreKey(record);

    if (!SLUG.test(record.slug) || record.slug.length > 64 || keys.has(key))
      throw new Error(`Invalid or duplicate Explore record: ${key}`);

    if (!Number.isFinite(record.position))
      throw new Error(`Invalid Explore position: ${key}`);

    if (
      record.tags.length > 12 ||
      record.tags.some((tag) => tag.length < 1 || tag.length > 32)
    )
      throw new Error(`Invalid Explore tags: ${key}`);

    keys.add(key);
  }

  for (const record of records) {
    for (const related of record.related) {
      if (
        !keys.has(exploreKey(related)) ||
        exploreKey(related) === exploreKey(record)
      )
        throw new Error(
          `Explore record ${exploreKey(record)} references unknown ${exploreKey(related)}`,
        );
    }
  }
}

type Resolved =
  | {
      owner: "prompt";
      item: ExploreItem;
      record: ExploreRecord;
      prompt: PromptSource;
    }
  | {
      owner: "skill";
      item: ExploreItem;
      record: ExploreRecord;
      skill: ExploreSkillSource;
    }
  | {
      owner: "plugin";
      item: ExploreItem;
      record: Extract<ExploreRecord, { kind: "plugin" }>;
      plugin: PluginManifestSummary;
    }
  | { owner: "page"; item: ExploreItem; record: ExploreRecord };

function resolveRecord(
  record: ExploreRecord,
  owners: ExploreOwners,
): Resolved | undefined {
  const base = { slug: record.slug, tags: [...record.tags] };

  switch (record.kind) {
    case "prompt": {
      const prompt = owners.prompt(record.slug);

      if (!prompt || !isCanonicalPromptText(prompt.body)) return undefined;

      return {
        owner: "prompt",
        record,
        prompt,
        item: {
          ...base,
          kind: "prompt",
          title: prompt.title,
          summary: prompt.summary,
          publisher: OMNYO,
          path: explorePromptPath(record.slug),
          preview: null,
          cta: {
            kind: "copy-prompt",
            label: "Copy prompt",
            textPath: explorePromptTextPath(record.slug),
          },
        },
      };
    }

    case "workflow": {
      const listing = owners.workflow(record.slug)?.listing;

      if (!listing) return undefined;

      const path = workflowListingPath(listing.slug);

      return {
        owner: "page",
        record,
        item: {
          ...base,
          kind: "workflow",
          title: listing.title,
          summary: listing.description,
          publisher: OMNYO,
          path,
          preview: {
            path: workflowPreviewPath(listing.slug),
            alt: listing.openGraph.alt,
            width: listing.openGraph.width,
            height: listing.openGraph.height,
          },
          cta: {
            kind: "get-workflow",
            label: "Get workflow",
            path: `${path}#get-workflow`,
          },
        },
      };
    }

    case "skill": {
      const skill = owners.skill(record.slug);

      if (skill?.slug !== record.slug) return undefined;

      const path = exploreSkillPath(record.slug);

      return {
        owner: "skill",
        record,
        skill,
        item: {
          ...base,
          kind: "skill",
          title: skill.detail.title,
          summary: skill.detail.summary,
          publisher:
            skill.detail.publisher === "omnyo" ? OMNYO : skill.detail.publisher,
          path,
          preview: null,
          cta: { kind: "get-skill-pack", label: "View skill pack", path },
        },
      };
    }

    case "guide": {
      const guide = owners.guide(record.slug);

      if (!guide) return undefined;

      return {
        owner: "page",
        record,
        item: {
          ...base,
          kind: "guide",
          title: guide.title,
          summary: guide.description,
          publisher: OMNYO,
          path: guide.path,
          preview: null,
          cta: { kind: "read-guide", label: "Read guide", path: guide.path },
        },
      };
    }

    case "plugin": {
      const plugin = owners.plugin(record.slug);

      if (
        !plugin ||
        plugin.pluginId !== record.slug ||
        !SLUG.test(record.marketplace)
      )
        return undefined;

      return {
        owner: "plugin",
        record,
        plugin,
        item: {
          ...base,
          kind: "plugin",
          title: plugin.displayName,
          summary: plugin.description,
          publisher: plugin.author.name,
          path: explorePluginPath(record.slug),
          preview: null,
          cta: {
            kind: "find-in-omnyo",
            label: "Find in Omnyo",
            pluginId: plugin.pluginId,
            marketplace: record.marketplace,
            install: `omnyo plugin install ${plugin.pluginId}@${record.marketplace}`,
          },
        },
      };
    }
  }
}

export function createExploreCatalog({
  activation,
  records,
  owners,
}: {
  activation: ExploreActivation;
  records: readonly ExploreRecord[];
  owners: ExploreOwners;
}) {
  validateRecords(records);

  const ordered = [...records].sort(
    (left, right) =>
      left.position - right.position ||
      exploreKey(left).localeCompare(exploreKey(right), "en"),
  );

  const unresolved: ExploreItemKey[] = [];
  const visible = new Map<string, Resolved>();

  for (const record of ordered) {
    if (record.state !== "published") continue;

    const resolved = resolveRecord(record, owners);

    if (resolved) visible.set(exploreKey(record), resolved);
    else unresolved.push({ kind: record.kind, slug: record.slug });
  }

  const active = activation === "active";
  const entries = active ? [...visible.values()] : [];
  const items = entries.map(({ item }) => item);

  const byKey = new Map(
    entries.map((entry) => [exploreKey(entry.item), entry]),
  );

  const related = (record: ExploreRecord): ExploreLink[] =>
    record.related.flatMap((key) => {
      const target = byKey.get(exploreKey(key))?.item;

      return target
        ? [{ kind: target.kind, title: target.title, path: target.path }]
        : [];
    });

  const find = (kind: ExploreKind, slug: string) =>
    SLUG.test(slug) ? byKey.get(exploreKey({ kind, slug })) : undefined;

  return {
    activation,
    items,
    unresolved,
    sitemapPaths: items.length
      ? [
          "/explore",
          ...items
            .map(({ path }) => path)
            .filter((path) => path.startsWith("/explore/")),
        ]
      : [],
    promptDetail(slug: string): ExplorePromptDetail | undefined {
      const entry = find("prompt", slug);

      return entry?.owner === "prompt"
        ? {
            item: entry.item,
            prompt: entry.prompt,
            related: related(entry.record),
          }
        : undefined;
    },
    relatedFor(kind: ExploreKind, slug: string): ExploreLink[] {
      const entry = find(kind, slug);

      return entry ? related(entry.record) : [];
    },
    pluginDetail(slug: string): ExplorePluginDetail | undefined {
      const entry = find("plugin", slug);

      return entry?.owner === "plugin"
        ? {
            item: entry.item,
            plugin: entry.plugin,
            marketplace: entry.record.marketplace,
            capabilities: entry.record.capabilities,
            availability: entry.record.availability,
            related: related(entry.record),
          }
        : undefined;
    },
    skillDetail(slug: string): ExploreSkillDetail | undefined {
      const entry = find("skill", slug);

      return entry?.owner === "skill"
        ? {
            item: entry.item,
            release: entry.skill.detail,
            related: related(entry.record),
          }
        : undefined;
    },
    skillFileResponse(slug: string, sha256: string): Response {
      const entry = find("skill", slug);

      const release =
        entry?.owner === "skill" ? entry.skill.release(sha256) : undefined;

      if (!release) return undiscoverable(404);

      if (release.state === "withdrawn") return undiscoverable(410);

      return new Response(release.bytes, {
        headers: {
          ...publicHeaders("application/octet-stream"),
          "content-disposition": `attachment; filename="${slug}.omnyoskillpack"`,
        },
      });
    },
    catalogResponse(schemaVersion: 1 | 2 = 1): Response {
      const published =
        schemaVersion === 1
          ? items.filter((item) => item.kind !== "skill")
          : items;

      if (!published.length) return undiscoverable(404);

      return new Response(JSON.stringify({ schemaVersion, items: published }), {
        headers: publicHeaders("application/json; charset=utf-8"),
      });
    },
    promptTextResponse(slug: string): Response {
      const entry = find("prompt", slug);

      if (entry?.owner !== "prompt") return undiscoverable(404);

      return new Response(entry.prompt.body, {
        headers: publicHeaders("text/plain; charset=utf-8"),
      });
    },
  };
}
