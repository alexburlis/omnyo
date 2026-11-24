import { z } from "zod";
import { initialUsageConsent, usageConsentSchema } from "./usage-telemetry.js";
import { completedTurnDisplaySchema } from "./completed-turn-display.js";
import { isValidGitBranchName } from "./git-checkout.js";
import { permissionModeSchema, type PermissionMode } from "./shared-types.js";

export const MANAGED_BRANCH_PREFIX_MAX_LENGTH = 64;

export const DEFAULT_MANAGED_BRANCH_PREFIX = "omnyo/";

export const managedBranchPrefixSchema = z
  .string()
  .max(MANAGED_BRANCH_PREFIX_MAX_LENGTH)
  .refine((prefix) => isValidGitBranchName(`${prefix}slug-thr_id`), {
    message: "Prefix must start a valid git branch name",
  });

const modelPermissionModesSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), permissionModeSchema),
);

export const appSettingsSchema = z
  .object({
    showKeyboardHints: z.boolean(),
    autoUpdateProviderClisOnStartup: z.boolean().default(true),
    showGitChanges: z.boolean(),
    steerActiveThreadOnEnter: z.boolean(),
    confirmThreadArchive: z.boolean(),
    showDiagnosticEvents: z.boolean(),
    keepHistoryAfterContextClear: z.boolean(),
    compactExpiredCache: z.boolean().default(true),
    providerOrder: z.array(z.string().min(1)),
    defaultProviderId: z.string().min(1).nullable(),
    defaultThreadMachineId: z.string().min(1).nullable(),
    defaultPermissionMode: permissionModeSchema.default("auto"),
    modelPermissionModes: modelPermissionModesSchema.default({}),
    providerCompletedTurnDisplay: z.record(
      z.string().min(1),
      completedTurnDisplaySchema,
    ),
    streamerMode: z.boolean(),
    allowFastServiceTier: z.boolean(),
    providerAllowFastServiceTier: z
      .record(z.string().min(1), z.boolean())
      .default({}),
    telemetryEnabled: z.boolean(),
    usageConsent: usageConsentSchema.default(initialUsageConsent),
    crashReportsEnabled: z.boolean().default(true),
    managedBranchPrefix: managedBranchPrefixSchema,
    machineServerUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);

        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      })
      .nullable(),
    machineGitCredentialsEnabled: z.boolean(),
    defaultMachineAccess: z.string().min(1).nullable(),
    onboardingCompletedAt: z.string().min(1).nullable(),
  })
  .strict();

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  showKeyboardHints: true,
  autoUpdateProviderClisOnStartup: true,
  showGitChanges: true,
  steerActiveThreadOnEnter: true,
  confirmThreadArchive: true,
  showDiagnosticEvents: false,
  keepHistoryAfterContextClear: false,
  compactExpiredCache: true,
  providerOrder: [],
  defaultProviderId: null,
  defaultThreadMachineId: null,
  defaultPermissionMode: "auto",
  modelPermissionModes: {},
  providerCompletedTurnDisplay: {},
  streamerMode: false,
  allowFastServiceTier: true,
  providerAllowFastServiceTier: {},
  telemetryEnabled: true,
  usageConsent: initialUsageConsent,
  crashReportsEnabled: true,
  managedBranchPrefix: DEFAULT_MANAGED_BRANCH_PREFIX,
  machineServerUrl: null,
  defaultMachineAccess: null,
  machineGitCredentialsEnabled: true,
  onboardingCompletedAt: null,
};

export const disabledProviderIdsSchema = z.array(z.string().min(1));

export const appSettingsUpdateSchema = z.union([
  appSettingsSchema.extend({
    autoUpdateProviderClisOnStartup: z.boolean().optional(),
    defaultThreadMachineId: z.string().min(1).nullable().optional(),
    defaultPermissionMode: permissionModeSchema.optional(),
    modelPermissionModes: modelPermissionModesSchema.optional(),
    allowFastServiceTier: z.boolean().optional(),
    providerAllowFastServiceTier: z
      .record(z.string().min(1), z.boolean())
      .optional(),
    telemetryEnabled: z.boolean().optional(),
    usageConsent: usageConsentSchema.optional(),
    crashReportsEnabled: z.boolean().optional(),
    confirmThreadArchive: z.boolean().optional(),
    showGitChanges: z.boolean().optional(),
    keepHistoryAfterContextClear: z.boolean().optional(),
    compactExpiredCache: z.boolean().optional(),
    showUnhandledProviderEvents: z.boolean().optional(),
    onboardingCompletedAt: z.string().min(1).nullable().optional(),
  }),
  appSettingsSchema.omit({ showDiagnosticEvents: true }).extend({
    autoUpdateProviderClisOnStartup: z.boolean().optional(),
    defaultThreadMachineId: z.string().min(1).nullable().optional(),
    defaultPermissionMode: permissionModeSchema.optional(),
    modelPermissionModes: modelPermissionModesSchema.optional(),
    allowFastServiceTier: z.boolean().optional(),
    providerAllowFastServiceTier: z
      .record(z.string().min(1), z.boolean())
      .optional(),
    telemetryEnabled: z.boolean().optional(),
    usageConsent: usageConsentSchema.optional(),
    crashReportsEnabled: z.boolean().optional(),
    confirmThreadArchive: z.boolean().optional(),
    showGitChanges: z.boolean().optional(),
    keepHistoryAfterContextClear: z.boolean().optional(),
    compactExpiredCache: z.boolean().optional(),
    showUnhandledProviderEvents: z.boolean(),
    onboardingCompletedAt: z.string().min(1).nullable().optional(),
  }),
]);

export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;

export function newThreadPermissionMode(
  settings:
    | Pick<AppSettings, "defaultPermissionMode" | "modelPermissionModes">
    | undefined,
  providerId: string,
  model: string | null,
): PermissionMode {
  return (
    (model === null
      ? undefined
      : settings?.modelPermissionModes[providerId]?.[model]) ??
    settings?.defaultPermissionMode ??
    "auto"
  );
}

export function allowsFastServiceTier(
  settings:
    | Partial<
        Pick<
          AppSettings,
          "allowFastServiceTier" | "providerAllowFastServiceTier"
        >
      >
    | undefined,
  providerId: string,
): boolean {
  return (
    settings?.providerAllowFastServiceTier?.[providerId] ??
    settings?.allowFastServiceTier ??
    true
  );
}
