import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledPluginDefinition {
  name: string;
  pluginId: string;
  autoInstall: boolean;
  defaultEnabled: boolean;
}

export interface BundledPluginRegistration extends BundledPluginDefinition {
  rootDir: string;
}

interface ResolveBuiltinPluginRootPathArgs {
  moduleDir: string;
  name: string;
}

export const BUILTIN_PLUGINS_DIRECTORY_NAME = "builtin-plugins";

export const BUILTIN_PLUGIN_ID_PREFIX = "omnyo--";

const REPO_PLUGINS_DIRECTORY_NAME = "plugins";

export const BUILTIN_PLUGINS: readonly BundledPluginDefinition[] = [
  {
    name: "storage-retention",
    pluginId: "omnyo--storage-retention",
    defaultEnabled: true,
  },
  {
    name: "omnyo-guide",
    pluginId: "omnyo-guide",
    defaultEnabled: true,
  },
  {
    name: "account-pool",
    pluginId: "account-pool",
    defaultEnabled: true,
  },
  {
    name: "composer-predictions",
    pluginId: "omnyo--composer-predictions",
    defaultEnabled: true,
  },
  {
    name: "account-usage",
    pluginId: "omnyo--account-usage",
    defaultEnabled: true,
  },
  {
    name: "git",
    pluginId: "omnyo--git",
    defaultEnabled: true,
  },
  {
    name: "wait-sources",
    pluginId: "omnyo--wait-sources",
    defaultEnabled: true,
  },
  {
    name: "ask-user-question",
    pluginId: "ask-user-question",
    defaultEnabled: true,
  },
  {
    name: "automations",
    pluginId: "automations",
    defaultEnabled: true,
  },
  {
    name: "omnyo-account",
    pluginId: "omnyo-account",
    defaultEnabled: true,
  },
  {
    name: "connect",
    pluginId: "connect",
    defaultEnabled: true,
  },
  {
    name: "environment-project-checkout",
    pluginId: "environment-project-checkout",
    defaultEnabled: true,
  },
  {
    name: "environment-git-worktree",
    pluginId: "environment-git-worktree",
    defaultEnabled: true,
  },
  {
    name: "environment-personal-workspace",
    pluginId: "environment-personal-workspace",
    defaultEnabled: true,
  },
  {
    name: "environment-temporary-copy",
    pluginId: "environment-temporary-copy",
    defaultEnabled: true,
  },
  {
    name: "custom-instructions",
    pluginId: "custom-instructions",
    defaultEnabled: true,
  },
  {
    name: "plugin-api-tester",
    pluginId: "plugin-api-tester",
    defaultEnabled: false,
  },
  {
    name: "inline-vis",
    pluginId: "inline-vis",
    defaultEnabled: true,
  },
  {
    name: "monaco-editor",
    pluginId: "monaco-editor",
    defaultEnabled: false,
  },
  {
    name: "pdf-preview",
    pluginId: "pdf-preview",
    defaultEnabled: true,
  },
  {
    name: "provider-codex",
    pluginId: "provider-codex",
    defaultEnabled: true,
  },
  {
    name: "provider-claude-code",
    pluginId: "provider-claude-code",
    defaultEnabled: true,
  },
  {
    name: "provider-pi",
    pluginId: "provider-pi",
    defaultEnabled: false,
  },
  {
    name: "provider-usage",
    pluginId: "omnyo--provider-usage",
    defaultEnabled: false,
  },
  {
    name: "provider-acp",
    pluginId: "provider-acp",
    defaultEnabled: false,
  },
  {
    name: "provider-acp-next",
    pluginId: "omnyo--provider-acp-next",
    defaultEnabled: false,
  },
  {
    name: "keep-awake",
    pluginId: "keep-awake",
    defaultEnabled: true,
  },
  {
    name: "plugin-api-docs",
    pluginId: "plugin-api-docs",
    defaultEnabled: false,
  },
  {
    name: "provider-retry",
    pluginId: "provider-retry",
    defaultEnabled: true,
  },
  {
    name: "push-notifications",
    pluginId: "push-notifications",
    defaultEnabled: true,
  },
  {
    name: "secrets",
    pluginId: "secrets",
    defaultEnabled: true,
  },
  {
    name: "drafts",
    pluginId: "drafts",
    defaultEnabled: true,
  },
  {
    name: "thread-list",
    pluginId: "thread-list",
    defaultEnabled: true,
  },
  {
    name: "prompt-library",
    pluginId: "omnyo--prompt-library",
    defaultEnabled: true,
  },
  {
    name: "scheduled-send",
    pluginId: "scheduled-send",
    defaultEnabled: true,
  },
  {
    name: "agent-annotations",
    pluginId: "agent-annotations",
    defaultEnabled: true,
  },
  {
    name: "concurrency-limit",
    pluginId: "concurrency-limit",
    defaultEnabled: true,
  },
  {
    name: "side-chat",
    pluginId: "side-chat",
    defaultEnabled: true,
  },
  {
    name: "workflows",
    pluginId: "workflows",
    defaultEnabled: true,
  },
  {
    name: "browser-automation",
    pluginId: "browser-automation",
    defaultEnabled: true,
  },
  {
    name: "chat-importer",
    pluginId: "omnyo--chat-importer",
    defaultEnabled: true,
  },
].map((plugin): BundledPluginDefinition => ({
  ...plugin,
  autoInstall: true,
}));

export const OFFICIAL_PLUGINS = [
  {
    name: "environment-modal-sandbox",
    pluginId: "environment-modal-sandbox",
    defaultEnabled: true,
  },
  {
    name: "docs",
    pluginId: "simple-notes",
    defaultEnabled: true,
  },
  {
    name: "memory",
    pluginId: "memory",
    defaultEnabled: true,
  },
  {
    name: "tasks",
    pluginId: "tasks",
    defaultEnabled: true,
  },
  {
    name: "theme-preview",
    pluginId: "theme-preview",
    defaultEnabled: true,
  },
].map((plugin): BundledPluginDefinition => ({
  ...plugin,
  autoInstall: false,
}));

export const BUNDLED_PLUGINS: readonly BundledPluginDefinition[] = [
  ...BUILTIN_PLUGINS,
  ...OFFICIAL_PLUGINS,
];

const DISABLED_BY_DEFAULT_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "chat-topics",
  "chief",
]);

export function isBundledPluginEnabledByDefault(
  plugin: Pick<BundledPluginDefinition, "pluginId" | "defaultEnabled">,
): boolean {
  return (
    plugin.defaultEnabled &&
    !DISABLED_BY_DEFAULT_PLUGIN_IDS.has(plugin.pluginId)
  );
}

export function isRemovableBundledPlugin(
  plugin: Pick<BundledPluginDefinition, "autoInstall">,
): boolean {
  return !plugin.autoInstall;
}

export interface BundledPluginReplacement {
  pluginId: string;
  replaces: string;
  carriedSettings: readonly string[];
}

export const BUNDLED_PLUGIN_REPLACEMENTS: readonly BundledPluginReplacement[] =
  [
    {
      pluginId: "omnyo--provider-acp-next",
      replaces: "provider-acp",
      carriedSettings: ["customAgents"],
    },
  ];

const builtinPluginsModuleDir = path.dirname(fileURLToPath(import.meta.url));

export function builtinPluginSource(name: string): string {
  return `builtin:${name}`;
}

export function resolveBuiltinPluginRootPathForModuleDir(
  args: ResolveBuiltinPluginRootPathArgs,
): string {
  const preparedCandidate = path.resolve(
    args.moduleDir,
    "../../../packages/bundled-plugins/dist",
    args.name,
  );

  if (existsSync(preparedCandidate)) return preparedCandidate;

  const packagedCandidate = path.resolve(
    args.moduleDir,
    BUILTIN_PLUGINS_DIRECTORY_NAME,
    args.name,
  );

  if (existsSync(packagedCandidate)) return packagedCandidate;

  const builtCheckoutCandidate = path.resolve(
    args.moduleDir,
    "../../..",
    REPO_PLUGINS_DIRECTORY_NAME,
    args.name,
  );

  if (existsSync(builtCheckoutCandidate)) return builtCheckoutCandidate;

  return path.resolve(
    args.moduleDir,
    "../../../../..",
    REPO_PLUGINS_DIRECTORY_NAME,
    args.name,
  );
}

export function resolveBuiltinPluginRootPath(name: string): string {
  return resolveBuiltinPluginRootPathForModuleDir({
    moduleDir: builtinPluginsModuleDir,
    name,
  });
}

export function listBundledPluginRegistrations(): BundledPluginRegistration[] {
  return BUNDLED_PLUGINS.map((plugin) => ({
    ...plugin,
    rootDir: resolveBuiltinPluginRootPath(plugin.name),
  }));
}
