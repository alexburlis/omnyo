import type { ReasoningLevel } from "@omnyo/domain";
import type { SystemExecutionOptionsModelLoadError } from "@omnyo/server-contract";
import { ModelPickerStoryQueryProvider } from "../../../.ladle/model-picker-query-provider";
import {
  STORY_PROVIDER_INFOS,
  STORY_PROVIDER_OPTIONS,
} from "../../../.ladle/story-fixtures";
import { ModelReasoningPicker } from "./ModelReasoningPicker";
import type { PickerOption } from "./OptionPicker";
import type { ProviderPickerOption } from "./model-brand-prefix";

export default {
  title: "pickers/Model Load Error States",
};

const INSTALL_URLS: Record<string, string> = {
  codex: "https://developers.openai.com/codex/cli",
  "claude-code": "https://claude.com/claude-code",
};

const BRAND_PREFIXES: Record<string, string> = {
  codex: "GPT-",
  "claude-code": "Claude ",
};

const providerOptions: readonly ProviderPickerOption[] =
  STORY_PROVIDER_OPTIONS.map((option) => ({
    ...option,
    ...(BRAND_PREFIXES[option.value]
      ? { brandPrefix: BRAND_PREFIXES[option.value] }
      : {}),
    ...(INSTALL_URLS[option.value]
      ? { installUrl: INSTALL_URLS[option.value] }
      : {}),
  }));

const reasoningOptions: readonly PickerOption<ReasoningLevel>[] = [
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

interface EmptyCatalogPickerProps {
  error: SystemExecutionOptionsModelLoadError | null;
  loading?: boolean;
  modelValue?: string;
  providerId?: string;
}

function EmptyCatalogPicker({
  error,
  loading = false,
  modelValue = "gpt-5.5",
  providerId = "codex",
}: EmptyCatalogPickerProps) {
  return (
    <ModelPickerStoryQueryProvider>
      <div
        className="flex h-[300px] w-[760px] items-start p-4"
        data-app-composer
      >
        <ModelReasoningPicker
          providers={STORY_PROVIDER_INFOS}
          providerOptions={providerOptions}
          selectedProviderId={providerId}
          onSelectedProviderChange={() => {}}
          hasMultipleProviders
          modelValue={modelValue}
          modelOptions={[]}
          moreModelOptions={[]}
          catalogModelOptions={[]}
          modelCatalogIsVerified={false}
          modelIsLoading={loading}
          modelLoadError={error}
          onModelChange={() => {}}
          reasoningValue="medium"
          reasoningOptions={reasoningOptions}
          onReasoningChange={() => {}}
          onSelectionChange={() => true}
          serviceTierValue={undefined}
          serviceTierOptions={[]}
          onServiceTierChange={() => {}}
          modal={false}
        />
      </div>
    </ModelPickerStoryQueryProvider>
  );
}

export function MissingCli() {
  return (
    <EmptyCatalogPicker
      error={{
        providerId: "codex",
        code: "missing_executable",
        detail:
          "Omnyo could not find the Codex CLI on this machine. Install Codex (https://developers.openai.com/codex/cli) or put `codex` on PATH, then retry.",
      }}
    />
  );
}

export function HostOffline() {
  return (
    <EmptyCatalogPicker
      error={{
        providerId: "codex",
        code: "failed",
        detail: "Host is not connected",
      }}
    />
  );
}

export function ProbeTimedOut() {
  return (
    <EmptyCatalogPicker
      error={{
        providerId: "codex",
        code: "timeout",
        detail: "Timed out waiting for command result",
      }}
    />
  );
}

export function NotSignedIn() {
  return (
    <EmptyCatalogPicker
      providerId="claude-code"
      modelValue="claude-opus-4-7"
      error={{
        providerId: "claude-code",
        code: "auth_required",
        detail:
          "Claude Code credentials expired. Run `claude` to sign in again.",
      }}
    />
  );
}

export function ProviderPluginUnavailable() {
  return (
    <EmptyCatalogPicker
      error={{
        providerId: "codex",
        code: "provider_unavailable",
        detail: null,
      }}
    />
  );
}

export function CatalogLoading() {
  return <EmptyCatalogPicker error={null} loading />;
}
