interface PluginManifest {
  name?: string;
  author?: { name?: string; url?: string };
  omnyo?: {
    name?: string;
    description?: string;
    branding?: { icon?: string };
  };
}

const PLUGIN_MANIFESTS = import.meta.glob<PluginManifest>(
  "../../../../plugins/*/package.json",
  { import: "default", eager: true },
);

const PLUGIN_ICON_URLS = import.meta.glob<string>(
  "../../../../plugins/*/{icons/*.svg,*.svg}",
  { query: "?url", import: "default", eager: true },
);

export const BRAND_ICON_URL_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(PLUGIN_MANIFESTS).flatMap(([manifestPath, { omnyo }]) => {
    const icon = omnyo?.branding?.icon;

    if (!omnyo?.name || !icon?.startsWith("./")) return [];

    const url =
      PLUGIN_ICON_URLS[manifestPath.replace(/package\.json$/, icon.slice(2))];

    return url === undefined ? [] : [[omnyo.name, url] as const];
  }),
);

export interface PluginManifestSummary {
  directory: string;
  packageName: string;
  pluginId: string;
  displayName: string;
  description: string;
  author: { name: string; url: string | null };
}

const PACKAGE_PREFIX = "omnyo-plugin-";

const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function pluginManifestSummary(
  directory: string,
): PluginManifestSummary | undefined {
  const manifest = PLUGIN_ID.test(directory)
    ? PLUGIN_MANIFESTS[`../../../../plugins/${directory}/package.json`]
    : undefined;

  const packageName = manifest?.name;

  const pluginId = packageName?.startsWith(PACKAGE_PREFIX)
    ? packageName.slice(PACKAGE_PREFIX.length)
    : undefined;

  if (
    !manifest?.omnyo?.name ||
    !manifest.omnyo.description ||
    !manifest.author?.name ||
    packageName === undefined ||
    pluginId === undefined ||
    !PLUGIN_ID.test(pluginId)
  )
    return undefined;

  return {
    directory,
    packageName,
    pluginId,
    displayName: manifest.omnyo.name,
    description: manifest.omnyo.description,
    author: { name: manifest.author.name, url: manifest.author.url ?? null },
  };
}
