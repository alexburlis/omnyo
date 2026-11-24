import type {
  UsageStatus,
  UsageConsentRequest,
  UsageConsentResponse,
  UsagePreview,
} from "@omnyo/domain/usage-telemetry";
import type {
  WebUpdateStatus,
  WebUpdateBegin,
  WebUpdateUpload,
  WebUpdateApply,
  WebUpdateAbort,
  WebUpdateRollback,
  AttachmentDiagnostic,
  VoiceDiagnostic,
  VoiceTranscriptionContext,
} from "@omnyo/server-contract";
import type {
  MachineEnvironmentReplace,
  MachineEnvironmentSet,
  MachineEnvironmentList,
} from "@omnyo/server-contract";
import type {
  AppKeybindingOverrides,
  AppSettings,
  AppSettingsUpdate,
  ExperimentUpdates,
  Experiments,
  UiPreferenceKey,
  UiPreferenceValue,
} from "@omnyo/domain";
import type { ProviderUsageResponse } from "@omnyo/host-daemon-contract";
import {
  formatBootPartList,
  type BootPartName,
  type BootResponse,
  type WebAssetManifest,
} from "@omnyo/server-contract";
import type {
  SetAiServiceSelectionRequest,
  SystemAiServicesResponse,
  SystemAppUpdateAcknowledgeRequest,
  SystemAppUpdateApplyRequest,
  SystemAppUpdateQuery,
  SystemAppUpdateStatus,
  SystemAttentionResponse,
  SystemConfigReloadResponse,
  SystemConfigResponse,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
  SystemCliSkillsStatusResponse,
  SystemInstallCliSkillsRequest,
  SystemInstallCliSkillsResponse,
  SystemProviderStatesResponse,
  SystemProvidersQuery,
  SystemUsageLimitsQuery,
  SystemVersionQuery,
  SystemVersionResponse,
  SystemVoiceTranscriptionResponse,
  RecordTelemetryEventRequest,
  BugReportRequest,
  BugReportResponse,
  TestAiServiceRequest,
  TestAiServiceResponse,
  UiPreferenceResponse,
  UiPreferencesResponse,
} from "@omnyo/server-contract";
import { systemVoiceTranscriptionResponseSchema } from "@omnyo/server-contract";
import {
  readExecutionOptions,
  signalRequestArgs,
  type CreateSdkAreaArgs,
} from "./common.js";

export interface SystemAttentionArgs {
  signal?: AbortSignal;
}

export interface SystemConfigArgs {
  signal?: AbortSignal;
}

export interface SystemExecutionOptionsArgs extends SystemExecutionOptionsQuery {
  signal?: AbortSignal;
}

export interface SystemUsageLimitsArgs extends Omit<
  SystemUsageLimitsQuery,
  "refresh"
> {
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface SystemVersionArgs {
  force?: boolean;
  signal?: AbortSignal;
}

export interface SystemAppUpdateArgs {
  force?: boolean;
  signal?: AbortSignal;
}

export type SystemApplyAppUpdateArgs = SystemAppUpdateApplyRequest;

export type SystemAcknowledgeAppUpdateArgs = SystemAppUpdateAcknowledgeRequest;

export type SystemAppUpdateStatusResult = SystemAppUpdateStatus;

export interface SystemVoiceTranscriptionArgs {
  file: Blob;
  prompt?: string;
  signal?: AbortSignal;
  diagnostic?: VoiceTranscriptionContext;
}

export interface SystemBootArgs {
  parts?: readonly BootPartName[];
  signal?: AbortSignal;
}

export type SystemBootResult = BootResponse;

export interface SystemWebAssetsArgs {
  signal?: AbortSignal;
}

export type SystemWebAssetsResult = WebAssetManifest;

export type SystemAttentionResult = SystemAttentionResponse;

export type SystemConfigResult = SystemConfigResponse;

export type SystemAiServicesResult = SystemAiServicesResponse;

export type SystemSetAiServiceSelectionArgs = SetAiServiceSelectionRequest;

export type SystemTestAiServiceArgs = TestAiServiceRequest;

export type SystemTestAiServiceResult = TestAiServiceResponse;

export type SystemRecordTelemetryEventArgs = RecordTelemetryEventRequest;

export interface SystemRecordTelemetryEventResult {
  ok: true;
}

export type SystemReportBugArgs = BugReportRequest;

export type SystemReportBugResult = BugReportResponse;

export interface SystemAiServicesArgs {
  signal?: AbortSignal;
}

export type SystemExecutionOptionsResult = SystemExecutionOptionsResponse;

export type SystemReloadConfigResult = SystemConfigReloadResponse;

export type SystemInstallCliSkillsArgs = SystemInstallCliSkillsRequest;

export interface SystemCliSkillsStatusArgs {
  hostIds?: readonly string[];
  signal?: AbortSignal;
}

export type SystemCliSkillsStatusResult = SystemCliSkillsStatusResponse;

export type SystemInstallCliSkillsResult = SystemInstallCliSkillsResponse;

export type SystemVoiceTranscriptionResult = SystemVoiceTranscriptionResponse;

export type SystemUpdateExperimentsResult = Experiments;

export type SystemUpdateGeneralSettingsResult = AppSettings & {
  showUnhandledProviderEvents?: boolean;
};

export type SystemUpdateKeyboardSettingsResult = AppKeybindingOverrides;

export type SystemUsageLimitsResult = ProviderUsageResponse;

export interface SystemProviderStatesArgs extends SystemProvidersQuery {
  signal?: AbortSignal;
}

export type SystemProviderStatesResult = SystemProviderStatesResponse;

export type SystemVersionResult = SystemVersionResponse;

export interface SystemUiPreferencesArgs {
  signal?: AbortSignal;
}

export type SystemUiPreferencesResult = UiPreferencesResponse;

export interface SystemUpdateUiPreferenceArgs<Key extends UiPreferenceKey> {
  expectedRevision: number;
  key: Key;
  value: UiPreferenceValue<Key>;
}

export interface SystemResetUiPreferenceArgs<Key extends UiPreferenceKey> {
  key: Key;
}

export type SystemUiPreferenceResult<Key extends UiPreferenceKey> =
  UiPreferenceResponse<Key>;

export interface SystemUiPreferencesArea {
  list(args?: SystemUiPreferencesArgs): Promise<SystemUiPreferencesResult>;
  set<Key extends UiPreferenceKey>(
    args: SystemUpdateUiPreferenceArgs<Key>,
  ): Promise<SystemUiPreferenceResult<Key>>;
  reset<Key extends UiPreferenceKey>(
    args: SystemResetUiPreferenceArgs<Key>,
  ): Promise<SystemUiPreferenceResult<Key>>;
}

export interface SystemArea {
  setMachineEnvironmentVariable(
    input: MachineEnvironmentSet,
  ): Promise<MachineEnvironmentList>;
  deleteMachineEnvironmentVariable(input: {
    name: string;
  }): Promise<MachineEnvironmentList>;
  machineEnvironment(): Promise<MachineEnvironmentList>;
  replaceMachineEnvironment(
    input: MachineEnvironmentReplace,
  ): Promise<MachineEnvironmentList>;
  aiServices(args?: SystemAiServicesArgs): Promise<SystemAiServicesResult>;
  attention(args?: SystemAttentionArgs): Promise<SystemAttentionResult>;
  experimental_boot(args?: SystemBootArgs): Promise<SystemBootResult>;
  experimental_webAssets(
    args?: SystemWebAssetsArgs,
  ): Promise<SystemWebAssetsResult>;
  config(args?: SystemConfigArgs): Promise<SystemConfigResult>;
  executionOptions(
    args?: SystemExecutionOptionsArgs,
  ): Promise<SystemExecutionOptionsResult>;
  cliSkillsStatus(
    args?: SystemCliSkillsStatusArgs,
  ): Promise<SystemCliSkillsStatusResult>;
  installCliSkills(
    args: SystemInstallCliSkillsArgs,
  ): Promise<SystemInstallCliSkillsResult>;
  experimental_usageStatus(): Promise<UsageStatus>;
  experimental_usageConsent(
    input: UsageConsentRequest,
  ): Promise<UsageConsentResponse>;
  experimental_eraseUsageAnalytics(proof: string): Promise<UsageStatus>;
  experimental_usagePreview(): Promise<UsagePreview>;
  experimental_recordTelemetryEvent(
    args: SystemRecordTelemetryEventArgs,
  ): Promise<SystemRecordTelemetryEventResult>;
  experimental_reportBug(
    args: SystemReportBugArgs,
  ): Promise<SystemReportBugResult>;
  reloadConfig(): Promise<SystemReloadConfigResult>;
  setAiServiceSelection(
    args: SystemSetAiServiceSelectionArgs,
  ): Promise<SystemAiServicesResult>;
  testAiService(
    args: SystemTestAiServiceArgs,
  ): Promise<SystemTestAiServiceResult>;
  transcribeVoice(
    args: SystemVoiceTranscriptionArgs,
  ): Promise<SystemVoiceTranscriptionResult>;
  experimental_prepareVoiceInput(): Promise<{ ok: true }>;
  experimental_recordAttachmentDiagnostic(
    input: AttachmentDiagnostic,
  ): Promise<{ ok: true }>;
  experimental_recordVoiceDiagnostic(
    input: VoiceDiagnostic,
  ): Promise<{ ok: true }>;
  uiPreferences: SystemUiPreferencesArea;
  updateExperiments(
    args: ExperimentUpdates,
  ): Promise<SystemUpdateExperimentsResult>;
  updateGeneralSettings(
    args: AppSettingsUpdate,
  ): Promise<SystemUpdateGeneralSettingsResult>;
  updateKeyboardSettings(
    args: AppKeybindingOverrides,
  ): Promise<SystemUpdateKeyboardSettingsResult>;
  providerStates(
    args?: SystemProviderStatesArgs,
  ): Promise<SystemProviderStatesResult>;
  usageLimits(args?: SystemUsageLimitsArgs): Promise<SystemUsageLimitsResult>;
  version(args?: SystemVersionArgs): Promise<SystemVersionResult>;
  webUpdateStatus(): Promise<WebUpdateStatus>;
  webUpdateBegin(input: WebUpdateBegin): Promise<{ uploadId: string }>;
  webUpdateUpload(input: WebUpdateUpload): Promise<{ ok: true }>;
  webUpdateApply(input: WebUpdateApply): Promise<WebUpdateStatus>;
  webUpdateAbort(input: WebUpdateAbort): Promise<{ ok: true }>;
  webUpdateRollback(input: WebUpdateRollback): Promise<WebUpdateStatus>;
  appUpdate(args?: SystemAppUpdateArgs): Promise<SystemAppUpdateStatusResult>;
  applyAppUpdate(
    args: SystemApplyAppUpdateArgs,
  ): Promise<SystemAppUpdateStatusResult>;
  acknowledgeAppUpdate(
    args: SystemAcknowledgeAppUpdateArgs,
  ): Promise<SystemAppUpdateStatusResult>;
  cancelAppUpdate(): Promise<SystemAppUpdateStatusResult>;
}

function versionQuery(args: SystemVersionArgs | undefined): SystemVersionQuery {
  return args?.force === undefined
    ? {}
    : { force: args.force ? "true" : "false" };
}

function appUpdateQuery(
  args: SystemAppUpdateArgs | undefined,
): SystemAppUpdateQuery {
  return args?.force === undefined
    ? {}
    : { force: args.force ? "true" : "false" };
}

export function createSystemArea(args: CreateSdkAreaArgs): SystemArea {
  const { transport } = args;

  const uiPreferences: SystemUiPreferencesArea = {
    async list(input) {
      return transport.readJson(
        transport.api.v1.preferences.ui.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async set(input) {
      const body = await transport.readJson(
        transport.api.v1.preferences.ui[":key"].$put({
          json: {
            expectedRevision: input.expectedRevision,
            value: input.value,
          },
          param: { key: input.key },
        }),
      );

      return body as UiPreferenceResponse<typeof input.key>;
    },
    async reset(input) {
      const body = await transport.readJson(
        transport.api.v1.preferences.ui[":key"].$delete({
          param: { key: input.key },
        }),
      );

      return body as UiPreferenceResponse<typeof input.key>;
    },
  };

  return {
    uiPreferences,
    async setMachineEnvironmentVariable(input) {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$post({ json: input }),
      );
    },
    async deleteMachineEnvironmentVariable(input) {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$delete({
          json: input,
        }),
      );
    },
    async machineEnvironment() {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$get(),
      );
    },
    async replaceMachineEnvironment(input) {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$put({ json: input }),
      );
    },
    async attention(input) {
      return transport.readJson(
        transport.api.v1.system.attention.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async aiServices(input) {
      return transport.readJson(
        transport.api.v1.system["ai-services"].$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async setAiServiceSelection(input) {
      return transport.readJson(
        transport.api.v1.system["ai-services"].selection.$put({ json: input }),
      );
    },
    async testAiService(input) {
      return transport.readJson(
        transport.api.v1.system["ai-services"].test.$post({ json: input }),
      );
    },
    async experimental_boot(input = {}) {
      return transport.readJson(
        transport.api.v1.boot.$get(
          {
            query:
              input.parts === undefined
                ? {}
                : { parts: formatBootPartList(input.parts) },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_webAssets(input = {}) {
      return transport.readJson(
        transport.api.v1.system["web-assets"].$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async config(input) {
      return transport.readJson(
        transport.api.v1.system.config.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async executionOptions(input = {}) {
      return readExecutionOptions(transport, input);
    },
    async cliSkillsStatus(input = {}) {
      return transport.readJson(
        transport.api.v1.system["cli-skills"].$get(
          {
            query:
              input.hostIds === undefined
                ? {}
                : { hostIds: input.hostIds.join(",") },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async installCliSkills(input) {
      return transport.readJson(
        transport.api.v1.system["cli-skills"].install.$post({ json: input }),
      );
    },
    async experimental_usageStatus() {
      return transport.readJson(
        transport.api.v1.system.usage.$get({}, { init: { redirect: "error" } }),
      );
    },
    async experimental_usageConsent(input) {
      return transport.readJson(
        transport.api.v1.system.usage.consent.$post(
          { json: input },
          { init: { redirect: "error" } },
        ),
      );
    },
    async experimental_eraseUsageAnalytics(proof) {
      return transport.readJson(
        transport.api.v1.system.usage.erase.$post(
          { json: { proof } },
          { init: { redirect: "error" } },
        ),
      );
    },
    async experimental_usagePreview() {
      return transport.readJson(transport.api.v1.system.usage.preview.$get());
    },
    async experimental_recordTelemetryEvent(input) {
      return transport.readJson(
        transport.api.v1.system.telemetry.events.$post({ json: input }),
      );
    },
    async experimental_reportBug(input) {
      return transport.readJson(
        transport.api.v1.system["bug-reports"].$post({ json: input }),
      );
    },
    async reloadConfig() {
      return transport.readJson(transport.api.v1.system.config.reload.$post());
    },
    async transcribeVoice(input) {
      if (input.file.size === 0) {
        throw new Error("Audio file must not be empty");
      }

      const form = new FormData();
      form.set("file", input.file);

      if (input.prompt !== undefined) form.set("prompt", input.prompt);

      if (input.diagnostic) {
        form.set("recordingId", input.diagnostic.recordingId);
        form.set("attempt", String(input.diagnostic.attempt));
      }

      const baseUrl = transport.baseUrl.replace(/\/$/u, "");

      const response = await transport.resolve(
        transport.fetch(`${baseUrl}/api/v1/system/voice-transcription`, {
          method: "POST",
          body: form,
          signal: input.signal,
        }),
      );

      return systemVoiceTranscriptionResponseSchema.parse(
        await response.json(),
      );
    },
    async experimental_prepareVoiceInput() {
      return transport.readJson(
        transport.api.v1.system["voice-transcription"].prepare.$post(),
      );
    },
    async experimental_recordAttachmentDiagnostic(input) {
      return transport.readJson(
        transport.api.v1.system["attachment-diagnostic"].$post({ json: input }),
      );
    },
    async experimental_recordVoiceDiagnostic(input) {
      return transport.readJson(
        transport.api.v1.system["voice-diagnostic"].$post({ json: input }),
      );
    },
    async updateExperiments(input) {
      return transport.readJson(
        transport.api.v1.settings.experiments.$put({ json: input }),
      );
    },
    async updateGeneralSettings(input) {
      return transport.readJson(
        transport.api.v1.settings.general.$put({ json: input }),
      );
    },
    async updateKeyboardSettings(input) {
      return transport.readJson(
        transport.api.v1.settings.keyboard.$put({ json: input }),
      );
    },
    async providerStates(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.state.$get(
          {
            query: {
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async usageLimits(input = {}) {
      return transport.readJson(
        transport.api.v1.system["usage-limits"].$get(
          {
            query: {
              hostId: input.hostId,
              providerId: input.providerId,
              refresh:
                input.refresh === undefined
                  ? undefined
                  : input.refresh
                    ? "true"
                    : "false",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async version(input) {
      return transport.readJson(
        transport.api.v1.system.version.$get(
          { query: versionQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async webUpdateStatus() {
      return transport.readJson(transport.api.v1.system["web-update"].$get());
    },
    async webUpdateBegin(input) {
      return transport.readJson(
        transport.api.v1.system["web-update"].begin.$post({ json: input }),
      );
    },
    async webUpdateUpload(input) {
      return transport.readJson(
        transport.api.v1.system["web-update"].upload.$post({ json: input }),
      );
    },
    async webUpdateApply(input) {
      return transport.readJson(
        transport.api.v1.system["web-update"].apply.$post({ json: input }),
      );
    },
    async webUpdateAbort(input) {
      return transport.readJson(
        transport.api.v1.system["web-update"].abort.$post({ json: input }),
      );
    },
    async webUpdateRollback(input) {
      return transport.readJson(
        transport.api.v1.system["web-update"].rollback.$post({ json: input }),
      );
    },
    async appUpdate(input) {
      return transport.readJson(
        transport.api.v1.system["app-update"].$get(
          { query: appUpdateQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async applyAppUpdate(input) {
      return transport.readJson(
        transport.api.v1.system["app-update"].apply.$post({ json: input }),
      );
    },
    async acknowledgeAppUpdate(input) {
      return transport.readJson(
        transport.api.v1.system["app-update"].acknowledge.$post({
          json: input,
        }),
      );
    },
    async cancelAppUpdate() {
      return transport.readJson(
        transport.api.v1.system["app-update"].cancel.$post(),
      );
    },
  };
}
