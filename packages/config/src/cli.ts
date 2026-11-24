import { readFileSync } from "node:fs";
import {
  formatAppConfigPath,
  parseAppManagedConfig,
} from "./managed-app-config.js";
import { resolveEnvLoader, type EnvLoaderArgs } from "./env.js";
import { loadHostDaemonPortValue } from "./ports.js";
import {
  OMNYO_LOOPBACK_HOST,
  OMNYO_PROD_HOST_DAEMON_PORT,
  OMNYO_PROD_SERVER_PORT,
  resolveConfiguredDataDir,
  resolveProdDataDir,
} from "./runtime.js";
import { loadServerUrlValue } from "./server-url.js";
import { readEnvironmentValue } from "./omnyo-environment.js";

export interface CliConfig {
  OMNYO_HOST_DAEMON_PORT: number;
  OMNYO_SERVER_URL: string;
}

interface LoadCliConfigArgs extends EnvLoaderArgs {
  repoRoot?: string;
}

const DEFAULT_CLI_SERVER_URL = `http://${OMNYO_LOOPBACK_HOST}:${OMNYO_PROD_SERVER_PORT}`;

function hasConfiguredValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return readEnvironmentValue({ env, name: key }) !== undefined;
}

export function loadCliConfig(args: LoadCliConfigArgs = {}): CliConfig {
  const loader = resolveEnvLoader(args);
  const useDevDefaults = loader.mode === "dev" && args.repoRoot !== undefined;
  let serverUrl: string;

  if (hasConfiguredValue(loader.env, "OMNYO_SERVER_URL") || useDevDefaults) {
    try {
      serverUrl = loadServerUrlValue({
        ...args,
        env: loader.env,
        homeDir: loader.context.homeDir,
        mode: loader.mode,
      });
    } catch {
      throw new Error(
        readEnvironmentValue({
          env: loader.env,
          name: "OMNYO_SERVER_URL",
        })?.trim() === ""
          ? "OMNYO_SERVER_URL must not be empty"
          : "Invalid OMNYO_SERVER_URL; expected a non-empty URL",
      );
    }
  } else {
    const configPath = formatAppConfigPath(
      resolveConfiguredDataDir({
        env: loader.env,
        homeDir: loader.context.homeDir,
        defaultDataDir: resolveProdDataDir({ homeDir: loader.context.homeDir }),
      }),
    );

    try {
      const config = parseAppManagedConfig(
        JSON.parse(readFileSync(configPath, "utf8")),
      );

      serverUrl = loadServerUrlValue({
        serverUrl: config.serverUrl ?? DEFAULT_CLI_SERVER_URL,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        serverUrl = DEFAULT_CLI_SERVER_URL;
      } else {
        throw new Error(
          `Cannot load saved Omnyo CLI server selection from ${configPath}`,
        );
      }
    }
  }

  return {
    OMNYO_HOST_DAEMON_PORT:
      hasConfiguredValue(loader.env, "OMNYO_HOST_DAEMON_PORT") || useDevDefaults
        ? loadHostDaemonPortValue({
            ...args,
            env: loader.env,
            homeDir: loader.context.homeDir,
            mode: loader.mode,
          })
        : OMNYO_PROD_HOST_DAEMON_PORT,
    OMNYO_SERVER_URL: serverUrl,
  };
}
