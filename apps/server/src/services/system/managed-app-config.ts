import { readFile } from "node:fs/promises";
import {
  appManagedEnvFileSchema,
  formatAppConfigPath,
  formatAppEnvPath,
  parseAppManagedConfig,
  type AppManagedConfig,
  type AppManagedEnvConfig,
  type AppManagedEnvFile,
} from "@omnyo/config/managed-app-config";
import {
  parseAppAliasOrigins,
  validateOptionalUrl,
} from "@omnyo/config/public-url";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";

interface ApplyOmnyoAppManagedConfigArgs {
  baseConfig: ServerRuntimeConfig;
  managedConfig: AppManagedConfig;
  targetConfig: ServerRuntimeConfig;
}

interface ReadOmnyoAppManagedConfigArgs {
  configPath: string;
  logger?: ServerLogger;
}

interface ReadOmnyoAppManagedEnvArgs {
  envPath: string;
}

interface CreateOmnyoAppManagedConfigReloaderArgs {
  config: ServerRuntimeConfig;
  hub: NotificationHub;
  logger: ServerLogger;
}

interface ReloadOmnyoAppManagedConfigArgs {
  notify: boolean;
}

export interface OmnyoAppManagedConfigReloader {
  reload(args: ReloadOmnyoAppManagedConfigArgs): Promise<void>;
}

interface ApplyManagedProcessEnvArgs {
  baseEnv: NodeJS.ProcessEnv;
  managedEnv: AppManagedEnvConfig;
  managedKeys: Set<string>;
}

function cloneRuntimeConfig(config: ServerRuntimeConfig): ServerRuntimeConfig {
  return { ...config };
}

function replaceRuntimeConfig(
  targetConfig: ServerRuntimeConfig,
  nextConfig: ServerRuntimeConfig,
): void {
  if (nextConfig.appUrl === undefined) {
    delete targetConfig.appUrl;
  }

  Object.assign(targetConfig, nextConfig);
}

function setOptionalAppUrl(
  config: ServerRuntimeConfig,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete config.appUrl;

    return;
  }

  config.appUrl = value;
}

function applyManagedProcessEnv(args: ApplyManagedProcessEnvArgs): void {
  for (const key of args.managedKeys) {
    const baseValue = args.baseEnv[key];

    if (baseValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baseValue;
    }
  }

  args.managedKeys.clear();

  for (const [key, value] of Object.entries(args.managedEnv)) {
    process.env[key] = value;
    args.managedKeys.add(key);
  }
}

export function applyOmnyoAppManagedConfig(
  args: ApplyOmnyoAppManagedConfigArgs,
): void {
  const managedConfig = args.managedConfig.config ?? {};

  args.targetConfig.customModels =
    args.managedConfig.customModels ?? args.baseConfig.customModels;
  args.targetConfig.sharedSkillRoots =
    args.managedConfig.sharedSkillRoots ?? args.baseConfig.sharedSkillRoots;

  args.targetConfig.appAliasOrigins =
    managedConfig.OMNYO_APP_ALIAS_URLS !== undefined
      ? parseAppAliasOrigins(
          "OMNYO_APP_ALIAS_URLS",
          managedConfig.OMNYO_APP_ALIAS_URLS,
        )
      : args.baseConfig.appAliasOrigins;

  setOptionalAppUrl(
    args.targetConfig,
    managedConfig.OMNYO_APP_URL !== undefined
      ? validateOptionalUrl("OMNYO_APP_URL", managedConfig.OMNYO_APP_URL)
      : args.baseConfig.appUrl,
  );
}

async function readOmnyoAppManagedConfig(
  args: ReadOmnyoAppManagedConfigArgs,
): Promise<AppManagedConfig> {
  try {
    const rawConfig = await readFile(args.configPath, "utf8");

    return parseAppManagedConfig(JSON.parse(rawConfig), {
      logger: args.logger,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function readOmnyoAppManagedEnv(
  args: ReadOmnyoAppManagedEnvArgs,
): Promise<AppManagedEnvFile> {
  try {
    const rawConfig = await readFile(args.envPath, "utf8");

    return appManagedEnvFileSchema.parse(JSON.parse(rawConfig));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function createOmnyoAppManagedConfigReloader(
  args: CreateOmnyoAppManagedConfigReloaderArgs,
): Promise<OmnyoAppManagedConfigReloader> {
  const baseConfig = cloneRuntimeConfig(args.config);
  const baseEnv = { ...process.env };
  const configPath = formatAppConfigPath(args.config.dataDir);
  const envPath = formatAppEnvPath(args.config.dataDir);
  const managedEnvKeys = new Set<string>();

  async function reload(
    reloadArgs: ReloadOmnyoAppManagedConfigArgs,
  ): Promise<void> {
    const managedConfig = await readOmnyoAppManagedConfig({
      configPath,
      logger: args.logger,
    });

    const managedEnvFile = await readOmnyoAppManagedEnv({ envPath });
    const nextConfig = cloneRuntimeConfig(args.config);
    applyOmnyoAppManagedConfig({
      baseConfig,
      managedConfig,
      targetConfig: nextConfig,
    });
    applyManagedProcessEnv({
      baseEnv,
      managedEnv: managedEnvFile.env ?? {},
      managedKeys: managedEnvKeys,
    });
    replaceRuntimeConfig(args.config, nextConfig);

    if (reloadArgs.notify) {
      args.hub.notifySystem(["config-changed"]);
    }
  }

  try {
    await reload({ notify: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(
      { configPath, error: message },
      "Ignoring invalid Omnyo managed config during startup",
    );
  }

  return {
    reload,
  };
}
