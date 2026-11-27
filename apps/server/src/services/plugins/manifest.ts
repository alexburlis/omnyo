import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import {
  derivePluginId,
  isCodeThemeFilePath,
  isPluginOwnedIconPath,
  pluginPackageJsonSchema,
  pluginRepositoryUrl,
  type PluginPackageJson,
  type UiCodeThemeDeclaration,
} from "@omnyo/domain";
import { resolvePluginCodeThemePath } from "../system/code-themes.js";
import {
  readPluginPackageJsonFile,
  resolveManifestAssetFile,
  resolveManifestEntryFile,
  resolveManifestPath,
  assertValidPluginCompactIconSvg,
  assertValidPluginIconSvg,
} from "@omnyo/plugin-build";

export interface PluginManifest {
  id: string;
  packageName: string;
  version: string;
  name: string;
  shortName: string | null;
  description: string;
  keywords: string[];
  author?: PluginPackageJson["author"] | null;
  repositoryUrl?: string | null;
  branding: {
    icon?: string;
    compactIconPath?: string;
    logo?: {
      lightPath: string;
      darkPath?: string;
    };
    icons: ReadonlyMap<string, string>;
  };
  coreEngineRange: string | undefined;
  pluginSdkRange: string | undefined;
  providerCatalog: Array<{ id: string; displayName: string }>;
  serverEntry: string;
  appEntry: string | undefined;
  hostEntry: string | undefined;
  themes: Array<{
    id: string;
    name: string;
    description: string | null;
    cssPath: string;
    codeTheme: UiCodeThemeDeclaration | null;
    codeThemePaths: { dark?: string; light?: string };
  }>;
  skillsRootPaths: string[];
  skillNames: string[];
  rootDir: string;
}

async function readSkillNames(rootPaths: string[]): Promise<string[]> {
  const names = new Set<string>();

  for (const rootPath of rootPaths) {
    let entries;

    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      try {
        const skillFile = await lstat(join(rootPath, entry.name, "SKILL.md"));

        if (!skillFile.isFile()) continue;
      } catch {
        continue;
      }

      names.add(entry.name);
    }
  }

  return [...names].sort();
}

export async function readPluginManifest(
  rootDir: string,
): Promise<PluginManifest> {
  const packageJsonPath = join(rootDir, "package.json");
  const json = await readPluginPackageJsonFile(packageJsonPath);
  const parsed = pluginPackageJsonSchema.safeParse(json);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new Error(
      `invalid plugin package.json${path ? ` (${path})` : ""}: ${issue?.message ?? "unknown error"}`,
    );
  }

  const {
    name: packageName,
    version,
    engines,
    omnyo,
    author,
    repository,
  } = parsed.data;

  if (
    engines?.omnyoPluginSdk !== undefined &&
    semver.validRange(engines.omnyoPluginSdk) === null
  ) {
    throw new Error(
      "invalid plugin package.json (engines.omnyoPluginSdk): must be a valid semver range",
    );
  }

  const serverEntry = await resolveManifestEntryFile(
    rootDir,
    omnyo.server,
    "omnyo.server",
  );

  const hostEntry = omnyo.host
    ? await resolveManifestEntryFile(rootDir, omnyo.host, "omnyo.host")
    : undefined;

  const skillsRootPaths = (omnyo.skills ?? ["skills"]).map((entry) =>
    resolveManifestPath(rootDir, entry.replace(/\/\*$/, ""), "omnyo.skills"),
  );

  const resolveBrandingAsset = (entry: string, label: string): string => {
    if (!/\.(svg|png|webp)$/i.test(entry)) {
      throw new Error(
        `manifest ${label} must point at a .svg, .png, or .webp file, got "${entry}"`,
      );
    }

    return resolveManifestPath(rootDir, entry, label);
  };

  const brandingLogo =
    omnyo.branding.logo === undefined
      ? undefined
      : {
          lightPath: resolveBrandingAsset(
            omnyo.branding.logo.light,
            "omnyo.branding.logo.light",
          ),
          ...(omnyo.branding.logo.dark === undefined
            ? {}
            : {
                darkPath: resolveBrandingAsset(
                  omnyo.branding.logo.dark,
                  "omnyo.branding.logo.dark",
                ),
              }),
        };

  const brandingCompactIconPath =
    omnyo.branding.icon !== undefined &&
    isPluginOwnedIconPath(omnyo.branding.icon)
      ? resolveBrandingAsset(omnyo.branding.icon, "omnyo.branding.icon")
      : undefined;

  for (const [label, assetPath] of [
    ["omnyo.branding.icon", brandingCompactIconPath],
    ["omnyo.branding.logo.light", brandingLogo?.lightPath],
    ["omnyo.branding.logo.dark", brandingLogo?.darkPath],
  ] as const) {
    if (assetPath === undefined) continue;
    const realAsset = await resolveManifestAssetFile(rootDir, assetPath, label);

    if (label === "omnyo.branding.icon") {
      assertValidPluginCompactIconSvg(await readFile(realAsset), label);
    }
  }

  const brandingIcons = new Map<string, string>();

  for (const [name, entry] of Object.entries(
    omnyo.branding.experimental_icons ?? {},
  )) {
    const label = `omnyo.branding.experimental_icons["${name}"]`;

    const realAsset = await resolveManifestAssetFile(
      rootDir,
      resolveManifestPath(rootDir, entry, label),
      label,
    );

    assertValidPluginIconSvg(await readFile(realAsset), label);
    brandingIcons.set(name, realAsset);
  }

  const themeIds = new Set<string>();

  const themes = (omnyo.themes ?? []).map((theme) => {
    if (themeIds.has(theme.id)) {
      throw new Error(
        `manifest omnyo.themes contains duplicate id "${theme.id}"`,
      );
    }

    themeIds.add(theme.id);

    if (!theme.css.toLowerCase().endsWith(".css")) {
      throw new Error(
        `manifest omnyo.themes theme "${theme.id}" must point at a .css file`,
      );
    }

    const codeTheme = theme.codeTheme ?? null;
    const codeThemePaths: { dark?: string; light?: string } = {};

    if (codeTheme?.dark !== undefined && isCodeThemeFilePath(codeTheme.dark)) {
      codeThemePaths.dark = resolvePluginCodeThemePath(
        rootDir,
        theme.id,
        "dark",
        codeTheme.dark,
      );
    }

    if (
      codeTheme?.light !== undefined &&
      isCodeThemeFilePath(codeTheme.light)
    ) {
      codeThemePaths.light = resolvePluginCodeThemePath(
        rootDir,
        theme.id,
        "light",
        codeTheme.light,
      );
    }

    return {
      id: theme.id,
      name: theme.name,
      description: theme.description ?? null,
      cssPath: resolveManifestPath(
        rootDir,
        theme.css,
        `omnyo.themes.${theme.id}.css`,
      ),
      codeTheme,
      codeThemePaths,
    };
  });

  for (const theme of themes) {
    try {
      await stat(theme.cssPath);
    } catch {
      throw new Error(
        `manifest omnyo.themes theme "${theme.id}" points at a missing file`,
      );
    }

    for (const [side, path] of Object.entries(theme.codeThemePaths)) {
      try {
        await stat(path);
      } catch {
        throw new Error(
          `manifest omnyo.themes theme "${theme.id}" codeTheme.${side} points at a missing file`,
        );
      }
    }
  }

  return {
    id: derivePluginId(packageName),
    packageName,
    version,
    name: omnyo.name,
    shortName: omnyo.shortName ?? null,
    description: omnyo.description,
    keywords: Array.isArray(parsed.data.keywords)
      ? parsed.data.keywords.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    author: author ?? null,
    repositoryUrl: pluginRepositoryUrl(repository),
    branding: {
      ...(omnyo.branding.icon === undefined
        ? {}
        : { icon: omnyo.branding.icon }),
      ...(brandingCompactIconPath === undefined
        ? {}
        : { compactIconPath: brandingCompactIconPath }),
      ...(brandingLogo === undefined ? {} : { logo: brandingLogo }),
      icons: brandingIcons,
    },
    coreEngineRange: engines?.omnyo,
    pluginSdkRange: engines?.omnyoPluginSdk,
    providerCatalog: (omnyo.experimental_providers ?? []).map(
      ({ id, displayName }) => ({ id, displayName }),
    ),
    serverEntry,
    appEntry: omnyo.app
      ? resolveManifestPath(rootDir, omnyo.app, "omnyo.app")
      : undefined,
    hostEntry,
    themes,
    skillsRootPaths,
    skillNames: await readSkillNames(skillsRootPaths),
    rootDir,
  };
}
