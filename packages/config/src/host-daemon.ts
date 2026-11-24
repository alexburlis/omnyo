import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  loadCommonConfig,
  type CommonConfig,
  type LoadCommonConfigArgs,
} from "./common.js";
import {
  OMNYO_APP_URL_ENV,
  OMNYO_APP_VERSION_ENV,
  OMNYO_DEV_APP_PORT_ENV,
  OMNYO_SENTRY_DSN_ENV,
  DEFAULT_OMNYO_APP_URL,
  DEFAULT_OMNYO_APP_VERSION,
  DEFAULT_OMNYO_SENTRY_DSN,
  PUBLIC_BETA_COLLECTION_DISABLED,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";
import { loadHostDaemonPortValue } from "./ports.js";
import { validateOptionalUrl } from "./public-url.js";
import { validatePortNumber } from "./runtime.js";
import { loadServerUrlValue } from "./server-url.js";

interface HostDaemonConnectionConfig {
  OMNYO_APP_URL: string;
  OMNYO_DEV_APP_PORT?: number;
  OMNYO_HOST_DAEMON_PORT: number;
  OMNYO_SERVER_URL: string;
}

interface HostDaemonConfig extends CommonConfig, HostDaemonConnectionConfig {}

interface HostDaemonErrorReportingConfig {
  OMNYO_APP_VERSION: string;
  OMNYO_SENTRY_DSN: string;
}

interface LoadHostDaemonConnectionConfigArgs extends EnvLoaderArgs {
  hostDaemonPort?: number;
  repoRoot?: string;
  serverUrl?: string;
}

interface LoadHostDaemonConfigArgs
  extends LoadCommonConfigArgs, LoadHostDaemonConnectionConfigArgs {}

interface HostDaemonStartConfig {
  dataDir: string;
  connectionConfig: HostDaemonConnectionConfig;
}

interface LoadHostDaemonStartConfigArgs extends LoadHostDaemonConfigArgs {
  dataDir?: string;
}

function resolveHostDaemonPort(
  args: LoadHostDaemonConnectionConfigArgs,
): number {
  if (args.hostDaemonPort !== undefined) {
    return validatePortNumber({
      name: "OMNYO_HOST_DAEMON_PORT",
      value: args.hostDaemonPort,
    });
  }

  return loadHostDaemonPortValue(args);
}

export function loadHostDaemonConnectionConfig(
  args: LoadHostDaemonConnectionConfigArgs = {},
): HostDaemonConnectionConfig {
  const loader = resolveEnvLoader(args);

  const config: HostDaemonConnectionConfig = {
    OMNYO_APP_URL: validateOptionalUrl(
      "OMNYO_APP_URL",
      readEnvVarWithDefault({
        context: loader.context,
        defaultValue: DEFAULT_OMNYO_APP_URL,
        definition: OMNYO_APP_URL_ENV,
        env: loader.env,
      }),
    ),
    OMNYO_HOST_DAEMON_PORT: resolveHostDaemonPort({
      ...args,
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
    }),
    OMNYO_SERVER_URL: loadServerUrlValue({
      ...args,
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
    }),
  };

  const devAppPort = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_DEV_APP_PORT_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "OMNYO_DEV_APP_PORT",
    target: config,
    value: devAppPort,
  });

  return config;
}

export function loadHostDaemonErrorReportingConfig(
  args: EnvLoaderArgs = {},
): HostDaemonErrorReportingConfig {
  const loader = resolveEnvLoader(args);

  const configuredAppVersion = readOptionalEnvVar({
    context: loader.context,
    definition: {
      ...OMNYO_APP_VERSION_ENV,
      parse: ({ value }) => value.trim(),
    },
    env: loader.env,
  });

  return {
    OMNYO_APP_VERSION:
      configuredAppVersion === undefined || configuredAppVersion === ""
        ? DEFAULT_OMNYO_APP_VERSION
        : configuredAppVersion,
    OMNYO_SENTRY_DSN:
      PUBLIC_BETA_COLLECTION_DISABLED ||
      loader.env.OMNYO_DESKTOP_RELEASE_CHANNEL === "public-beta"
        ? ""
        : readEnvVarWithDefault({
            context: loader.context,
            defaultValue: DEFAULT_OMNYO_SENTRY_DSN,
            definition: OMNYO_SENTRY_DSN_ENV,
            env: loader.env,
          }),
  };
}

export function loadHostDaemonConfig(
  args: LoadHostDaemonConfigArgs = {},
): HostDaemonConfig {
  return {
    ...loadCommonConfig(args),
    ...loadHostDaemonConnectionConfig(args),
  };
}

export function loadHostDaemonStartConfig(
  args: LoadHostDaemonStartConfigArgs,
): HostDaemonStartConfig {
  if (args.dataDir === undefined) {
    const config = loadHostDaemonConfig(args);

    return {
      connectionConfig: config,
      dataDir: config.OMNYO_DATA_DIR,
    };
  }

  return {
    connectionConfig: loadHostDaemonConnectionConfig(args),
    dataDir: args.dataDir,
  };
}
