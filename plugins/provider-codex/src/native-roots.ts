import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@omnyo/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  experimental_resolveVendorPluginRoots,
  type ExperimentalNativeRootsResolveAnswer,
  type ExperimentalVendorPlugin,
} from "@omnyo/plugin-sdk/host";
import { z } from "zod";
import { resolveCodexHome } from "./codex-home.js";

export const CODEX_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [".codex/skills", ".agents/skills"],
    project: [".codex/skills", { path: ".agents/skills", ancestors: true }],
  },
  experimental_resolvesNativeRoots: true,
};

export type CodexResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

export interface ResolveCodexNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

const CODEX_PLUGIN_MANIFEST_DIRECTORIES = [
  ".codex-plugin",
  ".claude-plugin",
  ".cursor-plugin",
];

const AGENT_PLUGIN_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/";

const AGENT_PLUGIN_SCHEMA_URI =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const CODEX_PLUGIN_MANIFEST_FILE_NAME = "plugin.json";

const CODEX_CONFIG_FILE_NAME = "config.toml";

const pluginPathListSchema = z.union([z.string(), z.array(z.string())]);

const codexPluginManifestSchema = z
  .object({
    name: z.string().min(1).optional(),
    skills: pluginPathListSchema.optional(),
  })
  .passthrough();

type CodexPluginManifest = z.infer<typeof codexPluginManifestSchema>;

const agentPluginManifestSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_SCHEMA_URI),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
    .refine((name) => !name.includes("--") && !name.includes("..")),
});

type CodexPluginManifestLocation = {
  filePath: string;
  format: "agent" | "legacy";
};

interface PluginCacheCandidate {
  modifiedAtMs: number;
  rootPath: string;
}

export async function resolveCodexNativeRoots(
  args: ResolveCodexNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const codexHome = resolveCodexHome(args.homeDir, args.env);
  const skillsRootPath = path.join(codexHome, "skills");

  const skills: CodexResolvedSkillRoot[] = [
    { path: skillsRootPath, origin: "user", shape: "skills" },
    {
      path: path.join(skillsRootPath, ".system"),
      origin: "user",
      shape: "skills",
    },
    ...(await resolveCodexPluginSkillRoots(codexHome)),
  ];

  return {
    watchPaths: [
      path.join(codexHome, CODEX_CONFIG_FILE_NAME),
      path.join(codexHome, "plugins", "cache"),
    ],
    skills: experimental_filterResolvedNativeRoots(
      { skills },
      { warn: console.warn },
    ).answer.skills,
  };
}

function decodeTomlBasicString(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character !== "\\" || index === value.length - 1) {
      decoded += character;
      continue;
    }

    index += 1;
    const escaped = value[index];

    if (escaped === "n") {
      decoded += "\n";
      continue;
    }

    if (escaped === "r") {
      decoded += "\r";
      continue;
    }

    if (escaped === "t") {
      decoded += "\t";
      continue;
    }

    decoded += escaped;
  }

  return decoded;
}

export function readCodexEnabledPluginSettingsFromToml(
  content: string,
): ReadonlyMap<string, boolean> {
  const enabledPlugins = new Map<string, boolean>();
  let currentPluginId: string | null = null;

  for (const line of content.split(/\r?\n/u)) {
    const sectionMatch = line.match(
      /^\s*\[plugins\.(?:"((?:\\.|[^"\\])*)"|([^\]\s]+))\]\s*(?:#.*)?$/u,
    );

    if (sectionMatch) {
      currentPluginId =
        sectionMatch[1] !== undefined
          ? decodeTomlBasicString(sectionMatch[1])
          : (sectionMatch[2] ?? null);
      continue;
    }

    if (/^\s*\[/u.test(line)) {
      currentPluginId = null;
      continue;
    }

    if (currentPluginId === null) {
      continue;
    }

    const enabledMatch = line.match(
      /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/u,
    );

    if (enabledMatch) {
      enabledPlugins.set(currentPluginId, enabledMatch[1] === "true");
    }
  }

  return enabledPlugins;
}

async function readCodexEnabledPluginSettings(
  codexHome: string,
): Promise<ReadonlyMap<string, boolean>> {
  try {
    return readCodexEnabledPluginSettingsFromToml(
      await fs.readFile(path.join(codexHome, CODEX_CONFIG_FILE_NAME), "utf8"),
    );
  } catch {
    return new Map<string, boolean>();
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function manifestEntry(entryPath: string) {
  try {
    return await fs.lstat(entryPath);
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }

    throw error;
  }
}

function parseManifestJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function resolveCodexPluginManifestLocation(
  pluginRootPath: string,
): Promise<CodexPluginManifestLocation | null> {
  try {
    const filePath = path.join(pluginRootPath, CODEX_PLUGIN_MANIFEST_FILE_NAME);
    const entry = await manifestEntry(filePath);

    if (entry !== null) {
      if (!entry.isFile()) {
        return null;
      }

      const parsed = z
        .object({ $schema: z.string() })
        .safeParse(parseManifestJson(await fs.readFile(filePath, "utf8")));

      if (
        parsed.success &&
        parsed.data.$schema.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)
      ) {
        return { filePath, format: "agent" };
      }
    }

    for (const directory of CODEX_PLUGIN_MANIFEST_DIRECTORIES) {
      const directoryPath = path.join(pluginRootPath, directory);
      const directoryEntry = await manifestEntry(directoryPath);

      if (directoryEntry === null) {
        continue;
      }

      if (!directoryEntry.isDirectory()) {
        return null;
      }

      const filePath = path.join(
        directoryPath,
        CODEX_PLUGIN_MANIFEST_FILE_NAME,
      );

      const entry = await manifestEntry(filePath);

      if (entry !== null) {
        return entry.isFile() ? { filePath, format: "legacy" } : null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function readCodexPluginManifest(
  pluginRootPath: string,
): Promise<CodexPluginManifest | null> {
  const location = await resolveCodexPluginManifestLocation(pluginRootPath);

  if (location === null) {
    return null;
  }

  try {
    const json = parseManifestJson(
      await fs.readFile(location.filePath, "utf8"),
    );

    if (location.format === "agent") {
      const parsed = agentPluginManifestSchema.safeParse(json);

      return parsed.success ? { name: parsed.data.name } : null;
    }

    const parsed = codexPluginManifestSchema.safeParse(json);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function statCodexPluginCacheCandidate(
  rootPath: string,
): Promise<PluginCacheCandidate | null> {
  if ((await resolveCodexPluginManifestLocation(rootPath)) === null) {
    return null;
  }

  try {
    const stat = await fs.stat(rootPath);

    return { rootPath, modifiedAtMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

async function resolveLatestPluginCacheRoot(
  pluginCacheRootPath: string,
): Promise<string | null> {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(pluginCacheRootPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: PluginCacheCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = await statCodexPluginCacheCandidate(
      path.join(pluginCacheRootPath, entry.name),
    );

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return (
    candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0]
      ?.rootPath ?? null
  );
}

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function resolveEnabledCodexPlugins(
  codexHome: string,
): Promise<ExperimentalVendorPlugin[]> {
  const enabledPlugins = await readCodexEnabledPluginSettings(codexHome);
  const cacheRootPath = path.join(codexHome, "plugins", "cache");
  const plugins: ExperimentalVendorPlugin[] = [];

  for (const marketplaceEntry of await readDirectoryEntries(cacheRootPath)) {
    const marketplacePath = path.join(cacheRootPath, marketplaceEntry.name);

    for (const pluginEntry of await readDirectoryEntries(marketplacePath)) {
      const pluginId = `${pluginEntry.name}@${marketplaceEntry.name}`;

      if (enabledPlugins.get(pluginId) === false) {
        continue;
      }

      const rootPath = await resolveLatestPluginCacheRoot(
        path.join(marketplacePath, pluginEntry.name),
      );

      if (rootPath === null) {
        continue;
      }

      const manifest = await readCodexPluginManifest(rootPath);

      if (!manifest) {
        continue;
      }

      plugins.push({
        rootPath,
        name: manifest.name ?? pluginEntry.name,
        origin: "user",
        skills: manifest.skills,
      });
    }
  }

  return plugins;
}

async function resolveCodexPluginSkillRoots(
  codexHome: string,
): Promise<CodexResolvedSkillRoot[]> {
  const roots = await experimental_resolveVendorPluginRoots({
    plugins: await resolveEnabledCodexPlugins(codexHome),
    layout: "claude",
  });

  return roots.skills;
}
