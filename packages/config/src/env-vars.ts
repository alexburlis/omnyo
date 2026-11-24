import { parseUsageCollectorOrigin } from "./usage-collector-url.js";
import { z } from "zod";
import { importLegacyWireHeadersV1 } from "./legacy-wire-headers-v1.js";
import { delimiter, isAbsolute, resolve } from "node:path";
import { defaultFeatureFlags } from "@omnyo/domain";
import { DEFAULTS } from "./defaults.js";
import {
  APP_UPDATE_MODE_ENV_NAME,
  appUpdateModeSchema,
  type AppUpdateMode,
} from "./app-update.js";
import {
  APP_INSTALL_KIND_ENV_NAME,
  APP_SOURCE_COMMIT_ENV_NAME,
  APP_SOURCE_ORIGIN_ENV_NAME,
  appInstallKindSchema,
  appSourceOriginSchema,
  type AppInstallKind,
  type AppSourceOrigin,
} from "./app-install.js";
import { defineEnvVar, type EnvVarParseArgs } from "./env.js";
import {
  APP_SURFACE_ENV_NAME,
  APP_SURFACE_WEB,
  formatAppSurfaceValues,
  parseAppSurface,
  type AppSurface,
} from "./app-surface.js";
import { validateLogLevel } from "./log-level.js";
import {
  parseAppAliasOrigins,
  validateOptionalUrl,
  validateRequiredUrl,
} from "./public-url.js";
import { OMNYO_LOOPBACK_HOST, parsePortValue } from "./runtime.js";
import { toOptionalString } from "./strings.js";

export type ServerBindHost = "127.0.0.1" | "0.0.0.0";

function parseBooleanEnvValue(args: EnvVarParseArgs): boolean {
  const normalizedValue = args.value.trim().toLowerCase();

  if (
    normalizedValue === "true" ||
    normalizedValue === "1" ||
    normalizedValue === "yes" ||
    normalizedValue === "y"
  ) {
    return true;
  }

  if (
    normalizedValue === "false" ||
    normalizedValue === "0" ||
    normalizedValue === "no" ||
    normalizedValue === "n"
  ) {
    return false;
  }

  throw new Error(`${args.name} must be a boolean`);
}

function parseAppSurfaceEnvValue(args: EnvVarParseArgs): AppSurface {
  const parsed = parseAppSurface(args.value);

  if (parsed !== undefined) {
    return parsed;
  }

  throw new Error(`${args.name} must be one of ${formatAppSurfaceValues()}`);
}

function parseAppUpdateModeEnvValue(args: EnvVarParseArgs): AppUpdateMode {
  const parsed = appUpdateModeSchema.safeParse(args.value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(
    `${args.name} must be one of ${appUpdateModeSchema.options.join(", ")}`,
  );
}

function parseAppInstallKindEnvValue(args: EnvVarParseArgs): AppInstallKind {
  const parsed = appInstallKindSchema.safeParse(args.value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(
    `${args.name} must be one of ${appInstallKindSchema.options.join(", ")}`,
  );
}

function parseAppSourceOriginEnvValue(args: EnvVarParseArgs): AppSourceOrigin {
  const parsed = appSourceOriginSchema.safeParse(args.value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(
    `${args.name} must be one of ${appSourceOriginSchema.options.join(", ")}`,
  );
}

function parseOptionalPortEnvValue(args: EnvVarParseArgs): number | undefined {
  if (args.value === "0") {
    return undefined;
  }

  return parsePortValue({
    name: args.name,
    rawPort: args.value,
  });
}

function parseOptionalTrimmedStringEnvValue(
  args: EnvVarParseArgs,
): string | undefined {
  return toOptionalString(args.value);
}

function parseStringEnvValue(args: EnvVarParseArgs): string {
  return args.value;
}

function parsePathListEnvValue(args: EnvVarParseArgs): string[] {
  return args.value
    .split(delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseNonEmptyStringEnvValue(args: EnvVarParseArgs): string {
  if (args.value.length === 0) {
    throw new Error(`${args.name} must not be empty`);
  }

  return args.value;
}

function parsePortEnvValue(args: EnvVarParseArgs): number {
  return parsePortValue({
    name: args.name,
    rawPort: args.value,
  });
}

export function parseServerBindHost(value: string): ServerBindHost {
  const trimmedValue = value.trim();

  if (trimmedValue === "127.0.0.1" || trimmedValue === "0.0.0.0") {
    return trimmedValue;
  }

  throw new Error('OMNYO_SERVER_BIND_HOST must be "127.0.0.1" or "0.0.0.0"');
}

function parseServerBindHostEnvValue(args: EnvVarParseArgs): ServerBindHost {
  return parseServerBindHost(args.value);
}

function parsePositiveIntegerEnvValue(args: EnvVarParseArgs): number {
  const parsed = Number(args.value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${args.name} must be a positive integer`);
  }

  return parsed;
}

function parseRequiredUrlEnvValue(args: EnvVarParseArgs): string {
  return validateRequiredUrl(args.name, args.value);
}

function parseOptionalUrlEnvValue(args: EnvVarParseArgs): string {
  return validateOptionalUrl(args.name, args.value);
}

function parseAppAliasOriginsEnvValue(args: EnvVarParseArgs): string[] {
  return parseAppAliasOrigins(args.name, args.value);
}

function parseLogLevelValue(args: EnvVarParseArgs): string {
  return validateLogLevel(args.value);
}

export const OMNYO_LOG_LEVEL_ENV = defineEnvVar<string>({
  description: "Log level: trace, debug, info, warn, error, fatal",
  name: "OMNYO_LOG_LEVEL",
  parse: parseLogLevelValue,
});

export const OMNYO_SERVER_PORT_ENV = defineEnvVar<number>({
  description: "HTTP port for the server",
  name: "OMNYO_SERVER_PORT",
  parse: parsePortEnvValue,
});

export const OMNYO_SERVER_BIND_HOST_ENV = defineEnvVar<ServerBindHost>({
  description: "HTTP bind host for the server",
  name: "OMNYO_SERVER_BIND_HOST",
  parse: parseServerBindHostEnvValue,
});

export const OMNYO_HOST_DAEMON_PORT_ENV = defineEnvVar<number>({
  description: "Port the host daemon listens on for local API requests",
  name: "OMNYO_HOST_DAEMON_PORT",
  parse: parsePortEnvValue,
});

export const OMNYO_SERVER_URL_ENV = defineEnvVar<string>({
  description: "URL of the Omnyo server",
  name: "OMNYO_SERVER_URL",
  parse: parseRequiredUrlEnvValue,
});

export const OMNYO_APP_VERSION_ENV = defineEnvVar<string>({
  description:
    "Version of the running omnyo-app package. The omnyo-app launcher sets this from packages/omnyo-app/package.json; defaults to a sentinel for dev/source runs.",
  name: "OMNYO_APP_VERSION",
  parse: parseNonEmptyStringEnvValue,
});

export const OMNYO_SERVER_LAUNCH_ID_ENV = defineEnvVar<string>({
  description:
    "Internal per-spawn identity the omnyo-app launcher hands its server child. The server echoes it on /health so the launcher can tell its own child apart from another Omnyo server that already owns the port.",
  name: "OMNYO_SERVER_LAUNCH_ID",
  parse: parseNonEmptyStringEnvValue,
});

const startupHoldSchema = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().min(1),
    expectedServerHostId: z.string().min(1),
    expectedDataDir: z
      .string()
      .min(1)
      .refine((value) => isAbsolute(value) && resolve(value) === value),
  })
  .strict();

export type ServerStartupHold = z.infer<typeof startupHoldSchema>;

export const OMNYO_SERVER_STARTUP_HOLD_ENV = defineEnvVar<ServerStartupHold>({
  name: "OMNYO_SERVER_STARTUP_HOLD",
  description:
    "Launch-only JSON startup maintenance ownership: id, ownerId, expectedServerHostId and absolute expectedDataDir",
  parse: ({ value }) => {
    try {
      return startupHoldSchema.parse(JSON.parse(value));
    } catch {
      throw new Error(
        "OMNYO_SERVER_STARTUP_HOLD must contain exact startup maintenance ownership",
      );
    }
  },
});

export const OMNYO_APP_UPDATE_MODE_ENV = defineEnvVar<AppUpdateMode>({
  description:
    "Internal marker the omnyo-app launcher hands its server child when it runs under the in-app update shim: npm for package installs, source for pnpm start checkouts, private for a private coordinator that restarts into staged runtimes. The server offers in-app updates only when it is set.",
  name: APP_UPDATE_MODE_ENV_NAME,
  parse: parseAppUpdateModeEnvValue,
});

export const OMNYO_APP_INSTALL_KIND_ENV = defineEnvVar<AppInstallKind>({
  description:
    "Internal marker the omnyo-app launcher hands its server child for telemetry attribution: desktop for the desktop app, npm for package installs, source for pnpm start checkouts. Absent when the server runs without the launcher.",
  name: APP_INSTALL_KIND_ENV_NAME,
  parse: parseAppInstallKindEnvValue,
});

export const OMNYO_APP_SOURCE_ORIGIN_ENV = defineEnvVar<AppSourceOrigin>({
  description:
    "Internal marker the omnyo-app launcher hands its server child for source checkouts: official when the origin remote is github.com/get-bb/bb, fork for any other origin, none without one.",
  name: APP_SOURCE_ORIGIN_ENV_NAME,
  parse: parseAppSourceOriginEnvValue,
});

export const OMNYO_APP_SOURCE_COMMIT_ENV = defineEnvVar<string>({
  description:
    "Internal marker the omnyo-app launcher hands its server child with the HEAD commit of an official source checkout. Never set for forks.",
  name: APP_SOURCE_COMMIT_ENV_NAME,
  parse: parseNonEmptyStringEnvValue,
});

export const OMNYO_APP_SURFACE_ENV = defineEnvVar<AppSurface>({
  description:
    "Internal launcher marker for telemetry attribution. Set by omnyo-app and desktop launchers.",
  name: APP_SURFACE_ENV_NAME,
  parse: parseAppSurfaceEnvValue,
});

export const OMNYO_APP_URL_ENV = defineEnvVar<string>({
  description:
    "Human-facing app/server base URL used for generated links, allowed browser origins, and the allowed DNS hostname for incoming requests. Does not control which host or port the server binds to.",
  name: "OMNYO_APP_URL",
  parse: parseOptionalUrlEnvValue,
});

export const OMNYO_APP_ALIAS_URLS_ENV = defineEnvVar<string[]>({
  description:
    "Comma-separated absolute https origins accepted as additional request hosts and browser origins beside OMNYO_APP_URL. OMNYO_APP_URL stays the canonical URL for generated links.",
  name: "OMNYO_APP_ALIAS_URLS",
  parse: parseAppAliasOriginsEnvValue,
});

export const OMNYO_EXTERNAL_URL_ENV = defineEnvVar<string>({
  description:
    "Internet-facing HTTPS base URL used for generated public links. Does not control which host or port the server binds to.",
  name: "OMNYO_EXTERNAL_URL",
  parse: parseOptionalUrlEnvValue,
});

export const OMNYO_USAGE_COLLECTOR_URL_ENV = defineEnvVar<string | undefined>({
  description:
    "Explicit first-party usage collector origin. Unset disables all usage uploads.",
  name: "OMNYO_USAGE_COLLECTOR_URL",
  parse: ({ value }) => parseUsageCollectorOrigin(value),
});

export const OMNYO_USAGE_COUNT_REGION_ENV = defineEnvVar<string | undefined>({
  description:
    "Installation jurisdiction supplied by its operator for weekly count eligibility. Missing or unreviewed jurisdictions require opt-in.",
  name: "OMNYO_USAGE_COUNT_REGION",
  parse: ({ value }) => {
    const region = value.trim().toUpperCase();

    if (!region) return undefined;

    if (!/^[A-Z]{2}$/u.test(region))
      throw new Error(
        "OMNYO_USAGE_COUNT_REGION must be a two-letter country code",
      );

    return region;
  },
});

export const OMNYO_SENTRY_DSN_ENV = defineEnvVar<string>({
  description:
    "Sentry DSN for errors-only reports from the production coordinator server and host daemon, without request, user or breadcrumb data. The coordinator's value also enables web app crash reports and chooses their project while crashReportsEnabled is on. Defaults to Omnyo's project. An empty value disables reporting from that process, and on the coordinator also disables web app reports. Requires restart.",
  name: "OMNYO_SENTRY_DSN",
  parse: parseStringEnvValue,
});

export const OMNYO_PERF_DIAGNOSTICS_ENV = defineEnvVar<boolean>({
  description:
    "Permit server performance diagnostics when the performanceDiagnostics experiment is on. Requires restart.",
  name: "OMNYO_PERF_DIAGNOSTICS",
  parse: parseBooleanEnvValue,
});

export const OMNYO_TELEMETRY_ENV = defineEnvVar<boolean>({
  description:
    "Installation-wide usage permission ceiling. Set false before startup to disable both weekly count and opt-in product analytics. True does not grant consent.",
  name: "OMNYO_TELEMETRY",
  parse: parseBooleanEnvValue,
});

export const OMNYO_FF_PLACEHOLDER_ENV = defineEnvVar<boolean>({
  description:
    "Permanent placeholder feature flag. Non-functional keep-alive so the flag system has at least one entry; do not gate behavior on it.",
  name: "OMNYO_FF_PLACEHOLDER",
  parse: parseBooleanEnvValue,
});

export const OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV = defineEnvVar<number>({
  description:
    "Max events one thread-timeline window may span. Raise far above the default to restore unbounded windows.",
  name: "OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET",
  parse: parsePositiveIntegerEnvValue,
});

export const OMNYO_DEV_APP_HOST_ENV = defineEnvVar<string>({
  description:
    "Development-only Vite bind host override for apps/app. Defaults to 127.0.0.1 when unset.",
  name: "OMNYO_DEV_APP_HOST",
  parse: parseStringEnvValue,
});

export const OMNYO_DEV_APP_PORT_ENV = defineEnvVar<number | undefined>({
  description: "Development-only Vite port for apps/app.",
  name: "OMNYO_DEV_APP_PORT",
  parse: parseOptionalPortEnvValue,
});

export const OMNYO_CLI_DIR_ENV = defineEnvVar<string | undefined>({
  description:
    "Directory containing the Omnyo CLI executable to inject into runtime shells",
  name: "OMNYO_CLI_DIR",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const OMNYO_INHERITED_SKILLS_ROOTS_ENV = defineEnvVar<string[]>({
  description:
    "Development-only path list of lower-priority inherited Omnyo skill roots",
  name: "OMNYO_INHERITED_SKILLS_ROOTS",
  parse: parsePathListEnvValue,
});

export const OMNYO_BRIDGE_DIR_ENV = defineEnvVar<string | undefined>({
  description:
    "Directory containing provider bridge bundles for the host daemon runtime",
  name: "OMNYO_BRIDGE_DIR",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const OMNYO_SERVER_HEADERS_ENV = defineEnvVar<Record<string, string>>({
  description: "Private JSON headers attached to machine server requests",
  name: "OMNYO_SERVER_HEADERS",
  parse: ({ value }) => {
    try {
      return importLegacyWireHeadersV1(
        z.record(z.string(), z.string()).parse(JSON.parse(value)),
      );
    } catch {
      throw new Error(
        "OMNYO_SERVER_HEADERS must be a JSON object with string values",
      );
    }
  },
});

export const OMNYO_CONNECT_MACHINE_CREDENTIAL_ENV = defineEnvVar<
  string | undefined
>({
  description:
    "Daemon-managed Omnyo connect credential for traversing the public machine gate",
  name: "OMNYO_CONNECT_MACHINE_CREDENTIAL",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const OMNYO_HOST_ENROLL_KEY_ENV = defineEnvVar<string | undefined>({
  description:
    "One-time enrollment token used to bootstrap a host daemon with the Omnyo server",
  name: "OMNYO_HOST_ENROLL_KEY",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const OMNYO_HOST_DAEMON_AUTO_UPDATE_ENV = defineEnvVar<boolean>({
  description:
    "Allow a remote host daemon to install the exact omnyo-app package served by its server on a newer protocol mismatch",
  name: "OMNYO_HOST_DAEMON_AUTO_UPDATE",
  parse: parseBooleanEnvValue,
});

export const OMNYO_WINDOWS_SERVICE_INSTALL_ENV = defineEnvVar<boolean>({
  description:
    "Set by the Windows machine service so the host daemon hands a verified update to the service, which installs it while no runtime file is loaded",
  name: "OMNYO_WINDOWS_SERVICE_INSTALL",
  parse: parseBooleanEnvValue,
});

export const OMNYO_HOST_DAEMON_SUPERVISED_ENV = defineEnvVar<boolean>({
  description:
    "Set by omnyo-app host-daemon --supervise so a daemon that relaunches itself after a server move keeps its launcher restarting it",
  name: "OMNYO_HOST_DAEMON_SUPERVISED",
  parse: parseBooleanEnvValue,
});

export const OMNYO_HOST_ID_ENV = defineEnvVar<string | undefined>({
  description:
    "Preferred host ID to persist for the daemon instead of generating one locally",
  name: "OMNYO_HOST_ID",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const DEFAULT_OMNYO_APP_VERSION = DEFAULTS.appVersion;

export const DEFAULT_OMNYO_APP_SURFACE = APP_SURFACE_WEB;

export const DEFAULT_OMNYO_APP_URL = "";

export const DEFAULT_OMNYO_SERVER_BIND_HOST: ServerBindHost =
  OMNYO_LOOPBACK_HOST;

export const DEFAULT_OMNYO_EXTERNAL_URL = "";

export const DEFAULT_OMNYO_TELEMETRY = true;

export {
  DEFAULT_OMNYO_SENTRY_DSN,
  PUBLIC_BETA_COLLECTION_DISABLED,
} from "./default-sentry.js";

export const DEFAULT_OMNYO_DEV_APP_HOST = "";

export const DEFAULT_OMNYO_FF_PLACEHOLDER = defaultFeatureFlags.placeholder;

export const DEFAULT_OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET =
  defaultFeatureFlags.timelineWindowEventBudget;
