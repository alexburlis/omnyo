import { useMemo, type ReactNode } from "react";
import { makeSystemConfig } from "../src/test/fixtures/system-config";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  defaultUiPreferences,
  UI_PREFERENCE_KEYS,
  type AvailableModel,
  type ProviderComposerAction,
  type ProviderInfo,
  type ReasoningLevel,
} from "@omnyo/domain";
import type { SystemExecutionOptionsResponse } from "@omnyo/server-contract";
import {
  hostsQueryKey,
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  uiPreferencesQueryKey,
} from "../src/hooks/queries/query-keys";
import type { PickerOption } from "../src/components/pickers/OptionPicker";
import type { ModelPickerOption } from "../src/components/pickers/model-picker-option";
import {
  STORY_CLAUDE_CODE_MORE_MODELS,
  STORY_CLAUDE_CODE_MODELS,
  STORY_CODEX_MODELS,
  STORY_PI_MODELS,
  STORY_PROVIDER_OPTIONS,
  STORY_SERVICE_TIER_SUPPORT,
} from "./story-fixtures";

const permissionModes = ["accept-edits", "auto", "full"] as const;

const STORY_COMPOSER_ACTIONS_BY_PROVIDER: Record<
  string,
  readonly ProviderComposerAction[]
> = {
  codex: [
    { kind: "skills", trigger: "/" },
    {
      kind: "plan",
      command: { trigger: "/", name: "plan", trailingText: " " },
    },
    {
      kind: "goal",
      command: { trigger: "/", name: "goal", trailingText: " " },
    },
  ],
  "claude-code": [
    { kind: "skills", trigger: "/" },
    {
      kind: "plan",
      command: { trigger: "/", name: "plan", trailingText: " " },
    },
  ],
  pi: [],
};

const STORY_PROVIDER_INFOS: ProviderInfo[] = STORY_PROVIDER_OPTIONS.map(
  (provider) => ({
    id: provider.value,
    pluginId: `provider-${provider.value}`,
    displayName: provider.label,
    logoUrl: null,
    available: true,
    maintenance: { health: true, usage: true, installation: true },
    composerActions: [
      ...(STORY_COMPOSER_ACTIONS_BY_PROVIDER[provider.value] ?? []),
    ],
    completedTurnDisplay:
      provider.value === "claude-code" ? "flat" : "collapse",
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier: STORY_SERVICE_TIER_SUPPORT[provider.value] ?? false,
      supportsNativeUserQuestion: true,
      supportsFork: true,
      supportsSessionRewind: true,
      modelCatalogScope: "workspace",
      permissionModes: [...permissionModes],
    },
  }),
);

function makeSupportedReasoningEfforts(
  reasoningOptions: readonly PickerOption<ReasoningLevel>[],
) {
  return reasoningOptions.map((option) => ({
    reasoningEffort: option.value,
    description: option.label,
  }));
}

function makeAvailableModels({
  models,
  markFirstDefault = true,
}: {
  models: readonly ModelPickerOption[];
  markFirstDefault?: boolean;
}): AvailableModel[] {
  return models.map((model, index) => ({
    id: model.value,
    model: model.value,
    displayName: model.label,
    ...(model.routeProviderId
      ? { routeProviderId: model.routeProviderId }
      : {}),
    description: "",
    supportedReasoningEfforts: makeSupportedReasoningEfforts(
      model.reasoningOptions,
    ),
    defaultReasoningEffort: model.defaultReasoningLevel,
    isDefault: markFirstDefault && index === 0,
  }));
}

function makeExecutionOptions(
  models: AvailableModel[],
  selectedOnlyModels: AvailableModel[] = [],
): SystemExecutionOptionsResponse {
  return {
    providers: STORY_PROVIDER_INFOS,
    models,
    selectedOnlyModels,
    permissionCeiling: "full",
    modelLoadError: null,
    modelNotice: null,
  };
}

function createStoryQueryClient(
  environmentIds: readonly string[],
): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
        staleTime: Infinity,
      },
    },
  });

  const executionOptionsByProviderId: Record<
    string,
    SystemExecutionOptionsResponse
  > = {
    codex: makeExecutionOptions(
      makeAvailableModels({ models: STORY_CODEX_MODELS }),
    ),
    "claude-code": makeExecutionOptions(
      makeAvailableModels({ models: STORY_CLAUDE_CODE_MODELS }),
      makeAvailableModels({
        models: STORY_CLAUDE_CODE_MORE_MODELS,
        markFirstDefault: false,
      }),
    ),
    pi: makeExecutionOptions(makeAvailableModels({ models: STORY_PI_MODELS })),
  };

  for (const environmentId of [null, ...environmentIds]) {
    for (const [providerId, executionOptions] of Object.entries(
      executionOptionsByProviderId,
    )) {
      queryClient.setQueryData<SystemExecutionOptionsResponse>(
        systemExecutionOptionsQueryKey({
          environmentId,
          hostId: null,
          providerId,
        }),
        executionOptions,
      );
    }
  }

  queryClient.setQueryData(hostsQueryKey(), []);
  queryClient.setQueryData(systemConfigQueryKey(), makeSystemConfig());
  queryClient.setQueryData(uiPreferencesQueryKey(), {
    preferences: Object.fromEntries(
      UI_PREFERENCE_KEYS.map((key) => [
        key,
        { revision: 0, value: defaultUiPreferences[key] },
      ]),
    ),
  });

  return queryClient;
}

const PRIMARY_ROUTING_ONLY: readonly string[] = [];

export function ModelPickerStoryQueryProvider({
  children,
  environmentIds = PRIMARY_ROUTING_ONLY,
}: {
  children: ReactNode;
  environmentIds?: readonly string[];
}) {
  const queryClient = useMemo(
    () => createStoryQueryClient(environmentIds),
    [environmentIds],
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
