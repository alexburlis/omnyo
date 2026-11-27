import { importLegacyWireHeadersV1 } from "./legacy-wire-headers-v1.js";
import { join } from "node:path";
import { providerNativeSkillRootsSchema } from "@omnyo/domain";
import { z } from "zod";
import { omnyoStateAdmissionSchema } from "./omnyo-state-admission.js";
import {
  importLegacyManagedConfigEnvironmentV1,
  importLegacyManagedEnvFileV1,
} from "./legacy-managed-environment-v1.js";

const BUNDLED_PROVIDER_IDS = [
  "codex",
  "claude-code",
  "pi",
  "acp-cursor",
] as const;

const APP_CONFIG_FILE_NAME = "config.json";

const APP_ENV_FILE_NAME = "env.json";

export type AppManagedConfigKey =
  | "OMNYO_APP_URL"
  | "OMNYO_APP_ALIAS_URLS"
  | "OMNYO_LOG_LEVEL";

export const APP_MANAGED_CONFIG_KEYS: AppManagedConfigKey[] = [
  "OMNYO_APP_URL",
  "OMNYO_APP_ALIAS_URLS",
  "OMNYO_LOG_LEVEL",
];

export const REMOVED_AI_SERVICE_CONFIG_KEYS: readonly string[] = [
  "BB_INFERENCE",
  "BB_INFERENCE_FALLBACK",
  "BB_TRANSCRIPTION",
];

export const REMOVED_AI_SERVICE_CONFIG_MESSAGE =
  "BB_INFERENCE, BB_INFERENCE_FALLBACK, and BB_TRANSCRIPTION were removed. Choose a service with `omnyo settings ai-services set <task> <choice>`. Run `omnyo settings ai-services show` to list services.";

export const PORTABLE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY = "customAcpAgents";

const REMOVED_CUSTOM_ACP_AGENTS_MESSAGE =
  "customAcpAgents in config.json is no longer read. Declare the agents with `omnyo plugin config omnyo--provider-acp-next set customAgents '<json>'`.";

interface AppManagedConfigWarningLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface ParseAppManagedConfigOptions {
  logger?: AppManagedConfigWarningLogger;
}

const appManagedConfigValuesSchema = z
  .object({
    OMNYO_APP_URL: z.string().optional(),
    OMNYO_APP_ALIAS_URLS: z.string().optional(),
    OMNYO_LOG_LEVEL: z.string().optional(),
  })
  .strict();

const ACP_PROVIDER_ID_PATTERN = /^acp-[a-z0-9][a-z0-9-]*$/u;

const customModelProviderIdSchema = z.union([
  z.enum(BUNDLED_PROVIDER_IDS),
  z.string().regex(ACP_PROVIDER_ID_PATTERN),
]);

export const customProviderModelSchema = z
  .object({
    providerId: customModelProviderIdSchema,
    model: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();

const appManagedEnvNameSchema = z.string().regex(PORTABLE_ENV_NAME_PATTERN);

const appManagedEnvConfigSchema = z.record(appManagedEnvNameSchema, z.string());

const appManagedConfigBoundarySchema = z
  .object({
    config: appManagedConfigValuesSchema.optional(),
    customModels: z.array(z.unknown()).optional(),
    sharedSkillRoots: providerNativeSkillRootsSchema.optional(),
    serverHeaders: z
      .record(z.string(), z.string())
      .transform(importLegacyWireHeadersV1)
      .optional(),
    machineCredential: z.string().min(1).optional(),
    connectMachineId: z.string().min(1).optional(),
    serverUrl: z.string().min(1).optional(),
    stateMigration: omnyoStateAdmissionSchema.optional(),
  })
  .strict();

const currentManagedEnvFileSchema = z
  .object({
    env: appManagedEnvConfigSchema.optional(),
  })
  .strict();

export const appManagedEnvFileSchema = z.preprocess(
  importLegacyManagedEnvFileV1,
  currentManagedEnvFileSchema,
);

export type AppManagedConfigValues = z.infer<
  typeof appManagedConfigValuesSchema
>;

export type CustomProviderModel = z.infer<typeof customProviderModelSchema>;

export type AppManagedConfig = Omit<
  z.infer<typeof appManagedConfigBoundarySchema>,
  "customModels"
> & {
  customModels?: CustomProviderModel[];
};

export type AppManagedEnvConfig = z.infer<typeof appManagedEnvConfigSchema>;

export type AppManagedEnvFile = z.infer<typeof appManagedEnvFileSchema>;

function parseCustomModels(
  entries: readonly unknown[] | undefined,
  options: ParseAppManagedConfigOptions,
): CustomProviderModel[] | undefined {
  if (entries === undefined) {
    return undefined;
  }

  const customModels: CustomProviderModel[] = [];

  for (const [index, entry] of entries.entries()) {
    const result = customProviderModelSchema.safeParse(entry);

    if (!result.success) {
      options.logger?.warn(
        { error: result.error.message, index },
        "Ignoring invalid custom model config entry",
      );
      continue;
    }

    customModels.push(result.data);
  }

  return customModels;
}

function withoutRemovedAiServiceConfig(
  rawConfig: unknown,
  options: ParseAppManagedConfigOptions,
): unknown {
  if (typeof rawConfig !== "object" || rawConfig === null) return rawConfig;
  const values: unknown = Reflect.get(rawConfig, "config");

  if (typeof values !== "object" || values === null) return rawConfig;

  const removed = REMOVED_AI_SERVICE_CONFIG_KEYS.filter((key) =>
    Object.hasOwn(values, key),
  );

  if (removed.length === 0) return rawConfig;
  options.logger?.warn({ keys: removed }, REMOVED_AI_SERVICE_CONFIG_MESSAGE);

  return {
    ...rawConfig,
    config: Object.fromEntries(
      Object.entries(values).filter(([key]) => !removed.includes(key)),
    ),
  };
}

function withoutRemovedCustomAcpAgents(
  rawConfig: unknown,
  options: ParseAppManagedConfigOptions,
): unknown {
  if (
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    !Object.hasOwn(rawConfig, REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY)
  ) {
    return rawConfig;
  }

  options.logger?.warn(
    { key: REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY },
    REMOVED_CUSTOM_ACP_AGENTS_MESSAGE,
  );

  return Object.fromEntries(
    Object.entries(rawConfig).filter(
      ([key]) => key !== REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY,
    ),
  );
}

export function parseAppManagedConfig(
  rawConfig: unknown,
  options: ParseAppManagedConfigOptions = {},
): AppManagedConfig {
  const parsed = appManagedConfigBoundarySchema.parse(
    importLegacyManagedConfigEnvironmentV1(
      withoutRemovedCustomAcpAgents(
        withoutRemovedAiServiceConfig(rawConfig, options),
        options,
      ),
    ),
  );

  const customModels = parseCustomModels(parsed.customModels, options);
  const config: AppManagedConfig = {};

  if (parsed.config !== undefined) {
    config.config = parsed.config;
  }

  if (customModels !== undefined) {
    config.customModels = customModels;
  }

  if (parsed.sharedSkillRoots !== undefined) {
    config.sharedSkillRoots = parsed.sharedSkillRoots;
  }

  if (parsed.serverUrl !== undefined) {
    config.serverUrl = parsed.serverUrl;
  }

  if (parsed.serverHeaders !== undefined) {
    config.serverHeaders = parsed.serverHeaders;
  }

  if (parsed.machineCredential !== undefined) {
    config.machineCredential = parsed.machineCredential;
  }

  if (parsed.connectMachineId !== undefined) {
    config.connectMachineId = parsed.connectMachineId;
  }

  if (parsed.stateMigration !== undefined) {
    config.stateMigration = parsed.stateMigration;
  }

  return config;
}

export function formatAppConfigPath(dataDir: string): string {
  return join(dataDir, APP_CONFIG_FILE_NAME);
}

export function formatAppEnvPath(dataDir: string): string {
  return join(dataDir, APP_ENV_FILE_NAME);
}
