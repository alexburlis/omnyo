import { rejectMultipleWorkspaceSelectors } from "./shared.js";
import { z } from "zod";
import {
  aiServiceSelectionSchema,
  aiServiceSelectionsSchema,
  aiServiceStatusSchema,
  aiTaskSchema,
  aiTextTaskSchema,
  appSettingsSchema,
  appDefaultKeybindingsSchema,
  appKeybindingOverridesSchema,
  appKeybindingsSchema,
  appThemeSchema,
  availableModelSchema,
  claudeProfileSelectionSchema,
  experimentsSchema,
  featureFlagsSchema,
  jsonValueSchema,
  permissionModeSchema,
  pluginThemeMetaSchema,
  providerInfoSchema,
  usageOnboardingStepSchema,
} from "@omnyo/domain";
import {
  providerHealthSchema as providerHealthSchema,
  providerUsageSchema,
} from "@omnyo/provider-bridge-protocol/provider-maintenance";
import { hostPlatformSchema } from "@omnyo/host-daemon-contract/local";
import {
  claudeProfileIdSchema,
  claudeProfileSchema,
  claudeProfileManagementResultSchema,
} from "@omnyo/host-daemon-contract";
import { machineEnvironmentSetSchema } from "./machine-environment.js";
import { providerCommandSchema } from "./projects.js";

const claudeProfileTarget = {
  hostId: z.string().min(1),
  profileId: claudeProfileIdSchema,
};

export const systemClaudeProfilesRequestSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("list"),
        hostId: z.string().min(1),
        projectId: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("add"),
        hostId: z.string().min(1),
        label: claudeProfileSchema.shape.label,
        adoptExisting: z.literal(true).optional(),
      })
      .strict(),
    z.object({ action: z.literal("status"), ...claudeProfileTarget }).strict(),
    z.object({ action: z.literal("remove"), ...claudeProfileTarget }).strict(),
    z.object({ action: z.literal("usage"), ...claudeProfileTarget }).strict(),
    z
      .object({ action: z.literal("loginStart"), ...claudeProfileTarget })
      .strict(),
    z
      .object({ action: z.literal("loginGet"), ...claudeProfileTarget })
      .strict(),
    z
      .object({ action: z.literal("loginCancel"), ...claudeProfileTarget })
      .strict(),
    z
      .object({
        action: z.literal("defaultsSet"),
        hostId: z.string().min(1),
        projectId: z.string().min(1).optional(),
        selection: claudeProfileSelectionSchema,
      })
      .strict(),
    z.object({ action: z.literal("pilotSet"), enabled: z.boolean() }).strict(),
  ],
);

export type SystemClaudeProfilesRequest = z.infer<
  typeof systemClaudeProfilesRequestSchema
>;

export const systemClaudeProfilesResultSchema = z
  .union([
    claudeProfileManagementResultSchema,
    z
      .object({ action: z.literal("usage"), usage: providerUsageSchema })
      .strict(),
    z
      .object({
        action: z.literal("list"),
        supported: z.boolean(),
        profiles: z.array(claudeProfileSchema),
        defaultSelection: claudeProfileSelectionSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("defaultsSet"),
        defaultSelection: claudeProfileSelectionSchema,
      })
      .strict(),
    z.object({ action: z.literal("pilotSet"), enabled: z.boolean() }).strict(),
  ])
  .transform((result, context) => {
    if (result.action === "list" && !("defaultSelection" in result)) {
      context.addIssue({
        code: "custom",
        message: "Profile lists require a default selection.",
      });

      return z.NEVER;
    }

    return result;
  });

export type SystemClaudeProfilesResult = z.infer<
  typeof systemClaudeProfilesResultSchema
>;

const machineEnvironmentReplacementVariableSchema =
  machineEnvironmentSetSchema.extend({
    value: machineEnvironmentSetSchema.shape.value.nullable(),
  });

export const machineEnvironmentReplaceSchema = z
  .object({
    variables: z.array(machineEnvironmentReplacementVariableSchema),
  })
  .strict()
  .superRefine(({ variables }, context) => {
    const names = new Set<string>();

    for (const [index, variable] of variables.entries()) {
      if (names.has(variable.name)) {
        context.addIssue({
          code: "custom",
          path: ["variables", index, "name"],
          message: "Machine environment variable names must be unique",
        });
      }

      names.add(variable.name);
    }
  });

export type MachineEnvironmentReplace = z.infer<
  typeof machineEnvironmentReplaceSchema
>;

export const systemExecutionOptionsModelLoadErrorCodeSchema = z.enum([
  "provider_unavailable",
  "missing_executable",
  "auth_required",
  "timeout",
  "failed",
]);

export type SystemExecutionOptionsModelLoadErrorCode = z.infer<
  typeof systemExecutionOptionsModelLoadErrorCodeSchema
>;

export const systemExecutionOptionsModelLoadErrorSchema = z.object({
  providerId: z.string().min(1),
  code: systemExecutionOptionsModelLoadErrorCodeSchema,
  detail: z.string().min(1).nullable(),
});

export type SystemExecutionOptionsModelLoadError = z.infer<
  typeof systemExecutionOptionsModelLoadErrorSchema
>;

export const systemExecutionOptionsModelNoticeSchema = z.object({
  providerId: z.string().min(1),
  message: z.string().min(1),
  detail: z.string().min(1).nullable(),
  until: z.number().int().nonnegative().nullable(),
});

export type SystemExecutionOptionsModelNotice = z.infer<
  typeof systemExecutionOptionsModelNoticeSchema
>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
  permissionCeiling: permissionModeSchema,
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
  modelLoadError: systemExecutionOptionsModelLoadErrorSchema.nullable(),
  modelNotice: systemExecutionOptionsModelNoticeSchema.nullable().default(null),
});

export type SystemExecutionOptionsResponse = z.infer<
  typeof systemExecutionOptionsResponseSchema
>;

const systemProviderHostQueryFields = {
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
} as const;

export const systemProvidersQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    capability: z.enum(["usage"]),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);

export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    selectedModel: z.string().min(1),
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
    claudeProfileId: claudeProfileIdSchema,
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);

export type SystemExecutionOptionsQuery = z.infer<
  typeof systemExecutionOptionsQuerySchema
>;

export const systemUsageLimitsQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
  hostId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});

export type SystemUsageLimitsQuery = z.infer<
  typeof systemUsageLimitsQuerySchema
>;

export interface SystemVoiceTranscriptionForm {
  [key: string]: string | Blob;
}

export { providerInfoSchema as systemProviderInfoSchema } from "@omnyo/domain";

export type { ProviderInfo as SystemProviderInfo } from "@omnyo/domain";

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});

export type SystemVoiceTranscriptionResponse = z.infer<
  typeof systemVoiceTranscriptionResponseSchema
>;

export const systemProviderStateSchema = providerHealthSchema.extend({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  localLoginCommand: z.string().min(1).nullable(),
});

export type SystemProviderState = z.infer<typeof systemProviderStateSchema>;

export const systemProviderStatesResponseSchema = z.object({
  providers: z.array(systemProviderStateSchema),
});

export type SystemProviderStatesResponse = z.infer<
  typeof systemProviderStatesResponseSchema
>;

export const systemAiServiceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  pluginId: z.string().min(1),
  tasks: z.array(aiTaskSchema),
  automaticRank: z.number().int().nonnegative().nullable(),
  status: aiServiceStatusSchema,
});

export type SystemAiService = z.infer<typeof systemAiServiceSchema>;

export const systemAiServicesResponseSchema = z.object({
  selections: aiServiceSelectionsSchema,
  services: z.array(systemAiServiceSchema),
});

export type SystemAiServicesResponse = z.infer<
  typeof systemAiServicesResponseSchema
>;

export const setAiServiceSelectionRequestSchema = z
  .object({
    task: aiTaskSchema,
    selection: aiServiceSelectionSchema,
  })
  .strict();

export type SetAiServiceSelectionRequest = z.infer<
  typeof setAiServiceSelectionRequestSchema
>;

export const testAiServiceRequestSchema = z
  .object({ task: aiTextTaskSchema })
  .strict();

export type TestAiServiceRequest = z.infer<typeof testAiServiceRequestSchema>;

export const testAiServiceResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    pluginId: z.string().min(1),
    serviceId: z.string().min(1),
    displayName: z.string().min(1),
    text: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
  }),
]);

export type TestAiServiceResponse = z.infer<typeof testAiServiceResponseSchema>;

const onboardingEntryTelemetrySchema = z.enum(["first_run", "replay"]);

const onboardingStepTelemetryPropertiesSchema = z
  .object({
    step: usageOnboardingStepSchema,
    entry: onboardingEntryTelemetrySchema,
  })
  .strict();

export const recordTelemetryEventRequestSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("onboarding_agent_state"),
      properties: z
        .object({
          entry: onboardingEntryTelemetrySchema,
          agent_installed: z.boolean().nullable(),
          agent_ready: z.boolean().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("onboarding_sign_in"),
      properties: z
        .object({
          entry: onboardingEntryTelemetrySchema,
          failure_reason: z
            .enum(["nonzero_exit", "start_rejected", "unknown"])
            .optional(),
          outcome: z.enum([
            "started",
            "ready",
            "exited",
            "failed",
            "cancelled",
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("new_thread_submit"),
      properties: z
        .object({ outcome: z.enum(["started", "accepted", "failed"]) })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("onboarding_started"),
      properties: z
        .object({ agent_installed: z.boolean(), agent_ready: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("onboarding_step_reached"),
      properties: onboardingStepTelemetryPropertiesSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("onboarding_step_completed"),
      properties: onboardingStepTelemetryPropertiesSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("onboarding_step_skipped"),
      properties: onboardingStepTelemetryPropertiesSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("onboarding_finished"),
      properties: z
        .object({
          outcome: z.enum(["completed", "skipped"]),
          entry: onboardingEntryTelemetrySchema,
          last_step: usageOnboardingStepSchema,
        })
        .strict(),
    })
    .strict(),
]);

export type RecordTelemetryEventRequest = z.infer<
  typeof recordTelemetryEventRequestSchema
>;

export const BUG_REPORT_MESSAGE_MAX_CHARS = 4_000;

export const BUG_REPORT_EMAIL_MAX_CHARS = 254;

export const bugReportRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(BUG_REPORT_MESSAGE_MAX_CHARS),
    email: z
      .string()
      .trim()
      .max(BUG_REPORT_EMAIL_MAX_CHARS)
      .pipe(z.email())
      .optional(),
    associatedEventId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  })
  .strict();

export type BugReportRequest = z.infer<typeof bugReportRequestSchema>;

export const bugReportUnavailableReasonSchema = z.enum([
  "crash-reports-off",
  "not-configured",
]);

export type BugReportUnavailableReason = z.infer<
  typeof bugReportUnavailableReasonSchema
>;

export const bugReportResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("sent"), reportId: z.string() }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: bugReportUnavailableReasonSchema,
    })
    .strict(),
]);

export type BugReportResponse = z.infer<typeof bugReportResponseSchema>;

export const serverAccessStatusSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      pluginId: z.string().min(1).nullable(),
      availability: z
        .discriminatedUnion("status", [
          z.object({
            status: z.literal("available"),
            serverUrl: z.string().url().optional(),
          }),
          z.object({
            status: z.literal("setup-required"),
            message: z.string(),
          }),
          z.object({ status: z.literal("unavailable"), message: z.string() }),
        ])
        .nullable(),
    }),
  ),
  defaultProviderId: z.string(),
  effectiveUrl: z.string().nullable(),
  urlSource: z.enum(["setting", "OMNYO_EXTERNAL_URL"]).nullable(),
});

export type ServerAccessStatus = z.infer<typeof serverAccessStatusSchema>;

export const systemDiagnosticsConfigSchema = z.object({
  sentryDsn: z.string().min(1).optional(),
  release: z.string(),
});

export type SystemDiagnosticsConfig = z.infer<
  typeof systemDiagnosticsConfigSchema
>;

export const systemConfigResponseSchema = z.object({
  commandDefaultsByProvider: z.record(
    z.string(),
    z.array(providerCommandSchema),
  ),
  appVersion: z.string().optional(),
  diagnostics: systemDiagnosticsConfigSchema.optional(),
  serverAccess: serverAccessStatusSchema,
  generalSettings: appSettingsSchema.extend({
    showUnhandledProviderEvents: z.boolean().optional(),
  }),
  keybindings: appKeybindingsSchema,
  defaultKeybindings: appDefaultKeybindingsSchema,
  keybindingOverrides: appKeybindingOverridesSchema,
  experiments: experimentsSchema,
  performanceDiagnosticsAvailable: z.boolean(),
  appearance: appThemeSchema,
  customThemes: z.array(z.string()),
  pluginThemes: z.array(pluginThemeMetaSchema),
  featureFlags: featureFlagsSchema,
  hostDaemonPort: z.number().nullable(),
  localHelperPorts: z.array(z.number().int().min(1).max(65_535)),
  serverUrl: z.string().url(),
  primaryHostId: z.string().nullable(),
  primaryHostPlatform: hostPlatformSchema.nullable(),
  voiceTranscriptionEnabled: z.boolean(),
  dataDir: z.string(),
});

export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const systemAttentionResponseSchema = z.object({
  hasAttention: z.boolean(),
});

export type SystemAttentionResponse = z.infer<
  typeof systemAttentionResponseSchema
>;

export const themeCatalogResponseSchema = z.object({
  dir: z.string(),
  custom: z.array(z.string()),
  plugins: z.array(pluginThemeMetaSchema),
  active: appThemeSchema,
});

export type ThemeCatalogResponse = z.infer<typeof themeCatalogResponseSchema>;

export const systemVersionResponseSchema = z.object({
  currentCommit: z
    .string()
    .regex(/^[a-f0-9]{40}$/i)
    .nullable(),
  installKind: z.enum(["desktop", "npm", "source"]).nullable(),
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  source: z.enum(["npm", "private"]),
  updateAvailable: z.boolean(),
  isDevelopment: z.boolean(),
  upgradeCommand: z.string(),
});

export type SystemVersionResponse = z.infer<typeof systemVersionResponseSchema>;

export const systemVersionQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional(),
});

export type SystemVersionQuery = z.infer<typeof systemVersionQuerySchema>;

export const systemAppUpdateRevisionSchema = z.object({
  commit: z.string().nullable(),
  version: z.string(),
});

export type SystemAppUpdateRevision = z.infer<
  typeof systemAppUpdateRevisionSchema
>;

export const systemAppUpdateSupportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("supported"),
    mode: z.enum(["npm", "source", "private"]),
  }),
  z.object({
    kind: z.literal("unsupported"),
    reason: z.enum(["development", "desktop", "unmanaged"]),
  }),
]);

export type SystemAppUpdateSupport = z.infer<
  typeof systemAppUpdateSupportSchema
>;

export const systemAppUpdateAvailableSchema = z.object({
  activation: z.literal("idle-only").optional(),
  channel: z.enum(["latest", "nightly", "main", "private"]),
  commit: z.string().nullable(),
  commitCount: z.number().int().nonnegative().nullable(),
  subjects: z.array(z.string()),
  version: z.string(),
});

export type SystemAppUpdateAvailable = z.infer<
  typeof systemAppUpdateAvailableSchema
>;

export const systemAppUpdateBlockedSchema = z.object({
  code: z.string().nullable().optional(),
  message: z.string(),
  reason: z.enum([
    "detached-head",
    "not-on-main",
    "uncommitted-changes",
    "diverged",
    "fetch-failed",
    "update-unreadable",
  ]),
});

export const systemAppUpdateActivitySchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }),
  z.object({
    code: z.string().nullable().optional(),
    output: z.array(z.string()),
    phase: z.literal("preparing"),
    startedAt: z.string(),
    step: z.string(),
    targetVersion: z.string(),
  }),
  z.object({
    phase: z.literal("draining"),
    startedAt: z.string(),
    stopsRunningChatsAt: z.string(),
    targetVersion: z.string(),
  }),
  z.object({
    phase: z.literal("restarting"),
    startedAt: z.string(),
    targetCommit: z.string().nullable(),
    targetVersion: z.string(),
  }),
]);

export type SystemAppUpdateActivity = z.infer<
  typeof systemAppUpdateActivitySchema
>;

export const systemAppUpdateResultSchema = z.object({
  acknowledged: z.boolean(),
  errorCode: z.string().nullable().optional(),
  finishedAt: z.string(),
  from: systemAppUpdateRevisionSchema,
  id: z.string(),
  logTail: z.array(z.string()),
  message: z.string().nullable(),
  outcome: z.enum(["updated", "failed", "cancelled"]),
  phase: z.enum(["prepare", "install", "startup"]).nullable(),
  to: systemAppUpdateRevisionSchema,
});

export type SystemAppUpdateResult = z.infer<typeof systemAppUpdateResultSchema>;

export const systemAppUpdateStatusSchema = z.object({
  activity: systemAppUpdateActivitySchema,
  available: systemAppUpdateAvailableSchema.nullable(),
  blocked: systemAppUpdateBlockedSchema.nullable(),
  current: systemAppUpdateRevisionSchema,
  installsWhenIdle: z.boolean(),
  lastResult: systemAppUpdateResultSchema.nullable(),
  newTurnsPausedForUpdate: z.boolean(),
  runningThreadCount: z.number().int().nonnegative(),
  support: systemAppUpdateSupportSchema,
});

export type SystemAppUpdateStatus = z.infer<typeof systemAppUpdateStatusSchema>;

export const systemAppUpdateQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional(),
});

export type SystemAppUpdateQuery = z.infer<typeof systemAppUpdateQuerySchema>;

export const systemAppUpdateApplyRequestSchema = z.object({
  confirmInterruptingThreads: z.boolean(),
});

export type SystemAppUpdateApplyRequest = z.infer<
  typeof systemAppUpdateApplyRequestSchema
>;

export const systemAppUpdateAcknowledgeRequestSchema = z.object({
  id: z.string().min(1),
});

export type SystemAppUpdateAcknowledgeRequest = z.infer<
  typeof systemAppUpdateAcknowledgeRequestSchema
>;

export const systemConfigReloadResponseSchema = z.object({
  ok: z.literal(true),
});

export const cliSkillMachineStatusSchema = z.enum([
  "installed",
  "outdated",
  "missing",
  "unknown",
]);

export type CliSkillMachineStatus = z.infer<typeof cliSkillMachineStatusSchema>;

export const systemCliSkillsStatusQuerySchema = z.object({
  hostIds: z.string().optional(),
});

export type SystemCliSkillsStatusQuery = z.infer<
  typeof systemCliSkillsStatusQuerySchema
>;

export const systemCliSkillsStatusResponseSchema = z.object({
  machines: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      status: cliSkillMachineStatusSchema,
    }),
  ),
});

export type SystemCliSkillsStatusResponse = z.infer<
  typeof systemCliSkillsStatusResponseSchema
>;

export const systemInstallCliSkillsRequestSchema = z.object({
  hostIds: z.array(z.string().min(1)).min(1).max(64),
});

export type SystemInstallCliSkillsRequest = z.infer<
  typeof systemInstallCliSkillsRequestSchema
>;

export const systemInstallCliSkillsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        hostId: z.string(),
        hostName: z.string(),
        installations: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        hostId: z.string(),
        hostName: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
});

export type SystemInstallCliSkillsResponse = z.infer<
  typeof systemInstallCliSkillsResponseSchema
>;

export type SystemConfigReloadResponse = z.infer<
  typeof systemConfigReloadResponseSchema
>;

const systemEnvironmentProviderAvailabilitySchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("available") }),
    z.object({
      status: z.literal("setup-required"),
      message: z.string().min(1),
    }),
    z.object({
      status: z.literal("unavailable"),
      message: z.string().min(1),
    }),
  ],
);

export const systemEnvironmentProviderSchema = z.object({
  environmentProviderId: z.string().min(1).optional(),
  machineProviderId: z.string().min(1).nullable(),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).nullable(),
  icon: z.string().min(1).nullable(),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  requires: z.object({
    projectCheckout: z.boolean(),
    gitCheckout: z.boolean(),
    gitRemote: z.boolean(),
    projectless: z.boolean(),
  }),
  inputs: jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  availability: systemEnvironmentProviderAvailabilitySchema.nullable(),
  machineAvailability: z.record(
    z.string().min(1),
    systemEnvironmentProviderAvailabilitySchema.nullable(),
  ),
  machineInputs: jsonValueSchema.nullable().optional(),
  machineAcceptsEmptyInputs: z.boolean().optional(),
  machineProviderPluginId: z.string().min(1).optional(),
});

export type SystemEnvironmentProvider = z.infer<
  typeof systemEnvironmentProviderSchema
>;

export const systemEnvironmentProvidersResponseSchema = z.object({
  providers: z.array(systemEnvironmentProviderSchema),
});

export type SystemEnvironmentProvidersResponse = z.infer<
  typeof systemEnvironmentProvidersResponseSchema
>;

export const systemEnvironmentProvidersQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
  })
  .superRefine((query, context) => {
    if (query.hostId !== undefined && query.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["hostId"],
        message: "hostId requires projectId",
      });
    }
  });

export type SystemEnvironmentProvidersQuery = z.infer<
  typeof systemEnvironmentProvidersQuerySchema
>;

export const systemMachineProviderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  inputs: jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  supportsSuspend: z.boolean(),
});

export type SystemMachineProvider = z.infer<typeof systemMachineProviderSchema>;

export const systemMachineProvidersResponseSchema = z.object({
  providers: z.array(systemMachineProviderSchema),
});

export type SystemMachineProvidersResponse = z.infer<
  typeof systemMachineProvidersResponseSchema
>;

export const systemProviderCatalogEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  pluginEnabled: z.boolean(),
  enabled: z.boolean(),
  available: z.boolean(),
  logoUrl: z.string().nullable(),
  info: providerInfoSchema.nullable(),
});

export type SystemProviderCatalogEntry = z.infer<
  typeof systemProviderCatalogEntrySchema
>;

export const systemProviderEnabledRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

export type SystemProviderEnabledRequest = z.infer<
  typeof systemProviderEnabledRequestSchema
>;
