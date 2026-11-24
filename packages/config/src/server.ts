import type { FeatureFlags } from "@omnyo/domain";
import type { AppInstallKind, AppSourceOrigin } from "./app-install.js";
import type { AppSurface } from "./app-surface.js";
import type { AppUpdateMode } from "./app-update.js";
import {
  loadCommonConfig,
  type CommonConfig,
  type LoadCommonConfigArgs,
} from "./common.js";
import { loadDatabaseConfig, type DatabaseConfig } from "./database.js";
import { loadDevAppConfig } from "./dev-app.js";
import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
} from "./env.js";
import {
  OMNYO_APP_INSTALL_KIND_ENV,
  OMNYO_APP_SOURCE_COMMIT_ENV,
  OMNYO_APP_SOURCE_ORIGIN_ENV,
  OMNYO_APP_ALIAS_URLS_ENV,
  OMNYO_APP_URL_ENV,
  OMNYO_APP_SURFACE_ENV,
  OMNYO_APP_VERSION_ENV,
  OMNYO_EXTERNAL_URL_ENV,
  OMNYO_INHERITED_SKILLS_ROOTS_ENV,
  OMNYO_USAGE_COLLECTOR_URL_ENV,
  OMNYO_USAGE_COUNT_REGION_ENV,
  OMNYO_SENTRY_DSN_ENV,
  OMNYO_SERVER_BIND_HOST_ENV,
  OMNYO_SERVER_LAUNCH_ID_ENV,
  OMNYO_SERVER_STARTUP_HOLD_ENV,
  type ServerStartupHold,
  OMNYO_APP_UPDATE_MODE_ENV,
  OMNYO_TELEMETRY_ENV,
  OMNYO_PERF_DIAGNOSTICS_ENV,
  DEFAULT_OMNYO_APP_URL,
  DEFAULT_OMNYO_APP_SURFACE,
  DEFAULT_OMNYO_APP_VERSION,
  DEFAULT_OMNYO_EXTERNAL_URL,
  DEFAULT_OMNYO_SENTRY_DSN,
  PUBLIC_BETA_COLLECTION_DISABLED,
  DEFAULT_OMNYO_SERVER_BIND_HOST,
  DEFAULT_OMNYO_TELEMETRY,
  parseServerBindHost,
  type ServerBindHost,
} from "./env-vars.js";
import { loadFeatureFlags } from "./feature-flags.js";
import { assignIfDefined } from "./objects.js";
import { loadHostDaemonPortValue } from "./ports.js";
import { loadServerPortConfig, type ServerPortConfig } from "./server-port.js";

export interface ServerConfig
  extends CommonConfig, DatabaseConfig, ServerPortConfig {
  OMNYO_APP_INSTALL_KIND?: AppInstallKind;
  OMNYO_APP_SOURCE_COMMIT?: string;
  OMNYO_APP_SOURCE_ORIGIN?: AppSourceOrigin;
  OMNYO_APP_URL: string;
  OMNYO_APP_ALIAS_URLS: string[];
  OMNYO_APP_SURFACE: AppSurface;
  OMNYO_APP_VERSION: string;
  OMNYO_DEV_APP_PORT?: number;
  OMNYO_EXTERNAL_URL: string;
  OMNYO_HOST_DAEMON_PORT: number;
  OMNYO_INHERITED_SKILLS_ROOTS: string[];
  OMNYO_USAGE_COLLECTOR_URL?: string;
  OMNYO_USAGE_COUNT_REGION?: string;
  OMNYO_SENTRY_DSN: string;
  OMNYO_SERVER_BIND_HOST: ServerBindHost;
  OMNYO_SERVER_LAUNCH_ID?: string;
  OMNYO_SERVER_STARTUP_HOLD?: ServerStartupHold;
  OMNYO_APP_UPDATE_MODE?: AppUpdateMode;
  OMNYO_TELEMETRY: boolean;
  OMNYO_PERF_DIAGNOSTICS: boolean;
  featureFlags: FeatureFlags;
}

type LoadServerConfigArgs = LoadCommonConfigArgs;

export { parseServerBindHost };

export type { ServerBindHost };

export function loadServerConfig(
  args: LoadServerConfigArgs = {},
): ServerConfig {
  const loader = resolveEnvLoader(args);

  const commonConfig = loadCommonConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });

  const databaseConfig = loadDatabaseConfig({
    commonConfig,
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });

  const serverPortConfig = loadServerPortConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });

  const devAppConfig = loadDevAppConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
  });

  const config: ServerConfig = {
    ...commonConfig,
    ...databaseConfig,
    ...serverPortConfig,
    OMNYO_APP_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_OMNYO_APP_URL,
      definition: OMNYO_APP_URL_ENV,
      env: loader.env,
    }),
    OMNYO_APP_ALIAS_URLS: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: [],
      definition: OMNYO_APP_ALIAS_URLS_ENV,
      env: loader.env,
    }),
    OMNYO_APP_SURFACE: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_OMNYO_APP_SURFACE,
      definition: OMNYO_APP_SURFACE_ENV,
      env: loader.env,
    }),
    OMNYO_APP_VERSION: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_OMNYO_APP_VERSION,
      definition: OMNYO_APP_VERSION_ENV,
      env: loader.env,
    }),
    OMNYO_EXTERNAL_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_OMNYO_EXTERNAL_URL,
      definition: OMNYO_EXTERNAL_URL_ENV,
      env: loader.env,
    }),
    OMNYO_HOST_DAEMON_PORT: loadHostDaemonPortValue({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
      repoRoot: args.repoRoot,
    }),
    OMNYO_INHERITED_SKILLS_ROOTS: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: [],
      definition: OMNYO_INHERITED_SKILLS_ROOTS_ENV,
      env: loader.env,
    }),
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
    OMNYO_SERVER_BIND_HOST: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_OMNYO_SERVER_BIND_HOST,
      definition: OMNYO_SERVER_BIND_HOST_ENV,
      env: loader.env,
    }),
    OMNYO_PERF_DIAGNOSTICS: readEnvVarWithDefault({
      context: loader.context,
      definition: OMNYO_PERF_DIAGNOSTICS_ENV,
      env: loader.env,
      defaultValue: false,
    }),
    OMNYO_TELEMETRY:
      !PUBLIC_BETA_COLLECTION_DISABLED &&
      loader.env.OMNYO_DESKTOP_RELEASE_CHANNEL !== "public-beta" &&
      loader.env.OMNYO_POSTHOG_API_KEY !== "" &&
      loader.env.BB_POSTHOG_API_KEY !== "" &&
      readEnvVarWithDefault({
        context: loader.context,
        defaultValue: DEFAULT_OMNYO_TELEMETRY,
        definition: OMNYO_TELEMETRY_ENV,
        env: loader.env,
      }),
    featureFlags: loadFeatureFlags({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
    }),
  };

  assignIfDefined({
    key: "OMNYO_USAGE_COLLECTOR_URL",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_USAGE_COLLECTOR_URL_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "OMNYO_USAGE_COUNT_REGION",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_USAGE_COUNT_REGION_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "OMNYO_DEV_APP_PORT",
    target: config,
    value: devAppConfig.OMNYO_DEV_APP_PORT,
  });
  assignIfDefined({
    key: "OMNYO_APP_UPDATE_MODE",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_APP_UPDATE_MODE_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "OMNYO_APP_INSTALL_KIND",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_APP_INSTALL_KIND_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "OMNYO_APP_SOURCE_ORIGIN",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_APP_SOURCE_ORIGIN_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "OMNYO_APP_SOURCE_COMMIT",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_APP_SOURCE_COMMIT_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "OMNYO_SERVER_LAUNCH_ID",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_SERVER_LAUNCH_ID_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "OMNYO_SERVER_STARTUP_HOLD",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_SERVER_STARTUP_HOLD_ENV,
      env: loader.env,
    }),
  });

  return config;
}
