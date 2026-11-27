import type { experimental_PluginBrowserSdk } from "@omnyo/plugin-sdk/app";
import { skillDisplayName, type SkillEntry, type SkillSource } from "./catalogue.ts";
import type { Collection, Library, LibraryLink, SavedPrompt } from "./library-contract";

type Skills = experimental_PluginBrowserSdk["skills"];

export type InstalledSource = Awaited<ReturnType<Skills["list"]>>["skills"][number];

export type SkillWorkspace = { projectId: string; environmentId: string | null };

type RowBase = {
  key: string;
  title: string;
  subtitle: string;
  path: string[];
  link: LibraryLink | null;
};

export type LibraryRow =
  | (RowBase & { kind: "skill"; source: SkillSource; variantIds: string[] })
  | (RowBase & { kind: "prompt"; prompt: SavedPrompt })
  | (RowBase & { kind: "reference"; filePath: string })
  | (RowBase & { kind: "unavailable" });

export function collectionPath(collections: Map<string, Collection>, leaf: string) {
  const path: Collection[] = [];
  const visited = new Set<string>();
  let current = collections.get(leaf);

  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId === null ? undefined : collections.get(current.parentId);
  }

  return path;
}

export function catalogueRows(entries: SkillEntry[]): LibraryRow[] {
  const rows: LibraryRow[] = [];

  for (const entry of entries) {
    const source = entry.sources[0];

    if (!source) continue;
    rows.push({
      kind: "skill",
      key: `skill:${entry.key}`,
      title: entry.label,
      subtitle: entry.summary,
      path: entry.category,
      link: null,
      source,
      variantIds: entry.sources.map((item) => item.id),
    });
  }

  return rows;
}

export function libraryRows(library: Library, inventory: InstalledSource[]): LibraryRow[] {
  const collections = new Map(library.collections.map((item) => [item.id, item]));
  const prompts = new Map(library.prompts.map((item) => [item.id, item]));
  const sources = new Map(inventory.map((item) => [sourceLocatorKey(item), item]));
  const sameName = new Map<string, string[]>();
  const rows: LibraryRow[] = [];

  for (const item of inventory) {
    const variants = sameName.get(item.name) ?? [];
    variants.push(item.id);
    sameName.set(item.name, variants);
  }

  for (const link of library.links) {
    const { target } = link;
    const path = collectionPath(collections, link.collectionId).map((item) => item.title);
    const base = { key: `link:${link.id}`, path, link };

    if (target.kind === "skill") {
      const source = sources.get(sourceLocatorKey(target.source));
      const title = link.title ?? skillDisplayName(target.source.name);
      rows.push(
        source
          ? {
              ...base,
              kind: "skill",
              title,
              subtitle: source.description ?? "Skill",
              source,
              variantIds: sameName.get(source.name) ?? [source.id],
            }
          : {
              ...base,
              kind: "unavailable",
              title,
              subtitle: "Source unavailable in this workspace",
            },
      );
    } else if (target.kind === "prompt") {
      const prompt = prompts.get(target.promptId);

      if (prompt)
        rows.push({
          ...base,
          kind: "prompt",
          title: link.title ?? prompt.title,
          subtitle: "Saved prompt",
          prompt,
        });
    } else {
      rows.push({
        ...base,
        kind: "reference",
        title: link.title ?? target.path.split("/").at(-1) ?? target.path,
        subtitle: "Project reference",
        filePath: target.path,
      });
    }
  }

  for (const prompt of library.prompts) {
    rows.push({
      kind: "prompt",
      key: `prompt:${prompt.id}`,
      title: prompt.title,
      subtitle: "Saved prompt",
      path: ["Saved prompts"],
      link: null,
      prompt,
    });
  }

  return rows;
}

export function searchRows(rows: LibraryRow[], query: string): LibraryRow[] {
  const search = query.trim().toLocaleLowerCase();
  const words = search.split(/\s+/u).filter(Boolean);
  const matches: { row: LibraryRow; rank: number }[] = [];

  for (const row of rows) {
    const id = row.kind === "skill" ? row.source.name : row.kind === "prompt" ? row.prompt.id : "";

    const text = [
      row.title,
      row.subtitle,
      ...row.path,
      id,
      row.kind === "skill" ? row.source.filePath : "",
      row.kind === "reference" ? row.filePath : "",
    ]
      .join(" ")
      .toLocaleLowerCase();

    if (!words.every((word) => text.includes(word))) continue;

    const rank =
      id.toLocaleLowerCase() === search
        ? 0
        : row.title.toLocaleLowerCase() === search
          ? 1
          : row.title.toLocaleLowerCase().startsWith(search)
            ? 2
            : 3;

    matches.push({ row, rank });
  }

  return matches
    .sort((a, b) => a.rank - b.rank || a.row.title.localeCompare(b.row.title))
    .map((match) => match.row);
}

export function sourceLocator(source: SkillSource) {
  return {
    name: source.name,
    filePath: source.filePath,
    provider: source.provider,
    scope: source.scope,
    pluginId: source.pluginId,
  };
}

export function sourceLocatorKey(source: ReturnType<typeof sourceLocator>): string {
  return JSON.stringify([
    source.name,
    source.provider,
    source.scope,
    source.pluginId,
    source.filePath,
  ]);
}

export function canEditSource(source: InstalledSource | undefined): boolean {
  if (!source?.manageable) return false;

  return ["omnyo-user", "omnyo-project", "provider-user", "provider-project"].includes(
    source.scope,
  );
}
