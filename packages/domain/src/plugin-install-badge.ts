export const PLUGIN_NEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type PluginInstallBadge = { kind: "builtin" } | { kind: "new" };

export function pluginInstallBadge(
  plugin: {
    installed: boolean;
    installedByDefault: boolean;
    publishedAt?: string;
  },
  now: number,
): PluginInstallBadge | null {
  if (plugin.installed && plugin.installedByDefault) return { kind: "builtin" };

  const publishedAt =
    plugin.publishedAt === undefined ? NaN : Date.parse(plugin.publishedAt);

  if (now - publishedAt < PLUGIN_NEW_WINDOW_MS) return { kind: "new" };

  return null;
}
