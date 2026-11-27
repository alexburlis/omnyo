import { createHash, randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  sourceLocatorSchema,
  type Collection,
  type Library,
  type LibraryLink,
  type PackExport,
  type SavedPrompt,
  type SourceLocator,
  type Target,
  type Workspace,
} from "./library-contract.ts";
import { appendImportedCollection, collectionTreeIds } from "./library-model.ts";
import { encodeSkillPack } from "./pack-encoding.ts";
import { maxPackBytes, type SkillPack } from "./pack.ts";

type SkillSdk = PluginApi["sdk"]["skills"];

type DiscoveredSkill = Awaited<ReturnType<SkillSdk["list"]>>["skills"][number];

type Layout = NonNullable<SkillPack["layout"]>;

type LayoutItem = Layout[number]["items"][number];

function sameSource(skill: DiscoveredSkill, locator: SourceLocator): boolean {
  return (
    skill.name === locator.name &&
    skill.filePath === locator.filePath &&
    skill.scope === locator.scope &&
    skill.provider === locator.provider &&
    skill.pluginId === locator.pluginId
  );
}

export async function exportCollection(sdk: SkillSdk, library: Library, input: PackExport) {
  const root = library.collections.find((collection) => collection.id === input.collectionId);

  if (!root) throw new Error("The selected collection no longer exists.");
  const tree = collectionTreeIds(library.collections, root.id);
  const links = library.links.filter((link) => tree.has(link.collectionId));

  const workspace = { projectId: input.projectId, environmentId: input.environmentId };

  const skillLinks = links.flatMap((link) =>
    link.target.kind === "skill" ? [link.target.source] : [],
  );

  const inventory = skillLinks.length > 0 ? (await sdk.list(workspace)).skills : [];
  const uniqueSources = new Map<string, DiscoveredSkill>();

  for (const locator of skillLinks) {
    const source = inventory.find((skill) => sameSource(skill, locator));

    if (!source) throw new Error("The chosen source for " + locator.name + " is unavailable.");
    const previous = uniqueSources.get(source.name);

    if (previous && previous.id !== source.id)
      throw new Error("Choose one source variant of " + source.name + " before exporting.");
    uniqueSources.set(source.name, source);
  }

  if (uniqueSources.size > 40) throw new Error("A pack can contain at most 40 skills.");

  const promptIds = new Set(
    links.flatMap((link) => (link.target.kind === "prompt" ? [link.target.promptId] : [])),
  );

  const saved = library.prompts.filter((prompt) => promptIds.has(prompt.id));
  const promptIndices = new Map(saved.map((prompt, index) => [prompt.id, index]));
  const prompts = saved.map(({ title, body, skillId }) => ({ title, body, skillId }));

  let bytes = 0;
  let fileCount = 0;
  const skills: SkillPack["skills"] = [];

  for (const [id, source] of uniqueSources) {
    const identity = { ...workspace, skillId: source.id };
    const listing = await sdk.listFiles(identity);

    if (listing.truncated) throw new Error("The file list for " + id + " is incomplete.");
    fileCount += listing.files.length;

    if (fileCount > 256) throw new Error("A pack can contain at most 256 files.");
    const files: SkillPack["skills"][number]["files"] = [];

    for (let offset = 0; offset < listing.files.length; offset += 8) {
      const chunk = await Promise.all(
        listing.files.slice(offset, offset + 8).map(async (path) => {
          const file = await sdk.getContent({ ...identity, path });
          const digest = createHash("sha256").update(file.content, "utf8").digest("hex");

          if (digest !== file.revision)
            throw new Error(path + " in " + id + " is not portable UTF-8.");

          return { path, content: file.content };
        }),
      );

      bytes += chunk.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);

      if (bytes > maxPackBytes) throw new Error("Skill pack exceeds 768 KiB.");
      files.push(...chunk);
    }

    skills.push({ id, files });
  }

  const byCollection = new Map<string, LayoutItem[]>();

  for (const link of links) {
    let item: LayoutItem;

    if (link.target.kind === "skill") {
      item = {
        kind: "skill",
        skillId: link.target.source.name,
        title: link.title,
        role: link.role,
      };
    } else if (link.target.kind === "prompt") {
      const promptIndex = promptIndices.get(link.target.promptId);

      if (promptIndex === undefined) throw new Error("A linked prompt no longer exists.");
      item = { kind: "prompt", promptIndex, title: link.title };
    } else {
      continue;
    }

    const items = byCollection.get(link.collectionId) ?? [];
    items.push(item);
    byCollection.set(link.collectionId, items);
  }

  const layout = library.collections
    .filter((collection) => tree.has(collection.id))
    .map((collection) => ({
      ...collection,
      parentId: collection.id === root.id ? null : collection.parentId,
      items: byCollection.get(collection.id) ?? [],
    }));

  return encodeSkillPack({
    schemaVersion: 1,
    publisher: input.publisher,
    slug: input.slug,
    version: input.version,
    title: root.title,
    description: root.description || root.title,
    license: input.license,
    skills,
    prompts,
    layout,
  });
}

export async function getInstalledPackSources(
  sdk: SkillSdk,
  workspace: Workspace,
  pack: SkillPack,
) {
  const result = new Map<string, SourceLocator>();

  if (pack.skills.length === 0) return result;
  const inventory = (await sdk.list(workspace)).skills;

  for (const { id } of pack.skills) {
    const matching = inventory.filter((item) => item.name === id && item.scope === "omnyo-project");

    if (matching.length !== 1)
      throw new Error(
        id +
          " was written but its exact project skill could not yet be resolved. Review the same pack to retry.",
      );
    result.set(id, sourceLocatorSchema.parse(matching[0]));
  }

  return result;
}

export function addPackCollection(
  current: Library,
  pack: SkillPack,
  sources: Map<string, SourceLocator>,
) {
  const rootId = randomUUID();

  const collections: Collection[] = [
    { id: rootId, parentId: null, title: pack.title, description: pack.description },
  ];

  const links: LibraryLink[] = [];
  const prompts: SavedPrompt[] = pack.prompts.map((prompt) => ({ ...prompt, id: randomUUID() }));
  const placedSkills = new Set<string>();
  const placedPrompts = new Set<number>();
  const groups = new Map<string, string>();

  function addLink(collectionId: string, target: Target, title?: string, role?: "entry") {
    links.push({ id: randomUUID(), collectionId, target, title, role });
  }

  function addSkill(collectionId: string, name: string, title?: string, role?: "entry") {
    const source = sources.get(name);

    if (!source) throw new Error("The installed source for " + name + " is missing.");
    addLink(collectionId, { kind: "skill", source }, title, role);
    placedSkills.add(name);
  }

  function addPrompt(collectionId: string, index: number, title?: string) {
    const prompt = prompts[index];

    if (!prompt) throw new Error("A pack link references an unavailable prompt.");
    addLink(collectionId, { kind: "prompt", promptId: prompt.id }, title);
    placedPrompts.add(index);
  }

  function createGroup(title: string): string {
    const id = randomUUID();
    collections.push({ id, parentId: rootId, title, description: "" });

    return id;
  }

  if (pack.layout && pack.layout.length > 0) {
    const roots = pack.layout.filter((node) => node.parentId === null);
    const matchingRoot = roots.length === 1 && roots[0]?.title === pack.title ? roots[0].id : null;

    for (const node of pack.layout)
      groups.set(node.id, node.id === matchingRoot ? rootId : randomUUID());

    for (const node of pack.layout) {
      const id = groups.get(node.id);

      if (!id) throw new Error("The pack collection could not be resolved.");

      if (id !== rootId) {
        const parentId = node.parentId === null ? rootId : groups.get(node.parentId);

        if (!parentId) throw new Error("The pack parent collection could not be resolved.");
        collections.push({ id, parentId, title: node.title, description: node.description });
      }

      for (const item of node.items) {
        if (item.kind === "skill") addSkill(id, item.skillId, item.title, item.role);
        else addPrompt(id, item.promptIndex, item.title);
      }
    }
  } else if (pack.skills[0]) {
    addSkill(createGroup("Start here"), pack.skills[0].id, undefined, "entry");
  }

  const remainingSkills = pack.skills.filter(({ id }) => !placedSkills.has(id));

  if (remainingSkills.length > 0) {
    const methods = createGroup("Methods");

    for (const { id } of remainingSkills) addSkill(methods, id);
  }

  const remainingPrompts = prompts.flatMap((_, index) => (placedPrompts.has(index) ? [] : [index]));

  if (remainingPrompts.length > 0) {
    const savedPrompts = createGroup("Saved prompts");

    for (const index of remainingPrompts) addPrompt(savedPrompts, index);
  }

  return {
    library: appendImportedCollection(current, { collections, links, prompts }),
    collectionId: rootId,
  };
}
