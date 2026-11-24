import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  defaultUiPreferences,
  PERSONAL_PROJECT_ID,
  UI_PREFERENCE_KEYS,
  type AvailableModel,
  type Host,
  type ProviderInfo,
  type ReasoningLevel,
  type UiPreferenceValue,
  type UiPreferenceValues,
} from "@omnyo/domain";
import type {
  SidebarBootstrapResponse,
  SystemExecutionOptionsResponse,
  SystemVersionResponse,
} from "@omnyo/server-contract";
import type { ProviderCliStatusResponse } from "@omnyo/host-daemon-contract";
import {
  hostProviderCliStatusQueryKey,
  hostsQueryKey,
  machineEnvironmentQueryKey,
  pluginListQueryKey,
  pluginMarketplacesQueryKey,
  serverMoveStatusQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  systemProviderCatalogQueryKey,
  systemProvidersQueryKey,
  systemVersionQueryKey,
  uiPreferencesQueryKey,
} from "../src/hooks/queries/query-keys";
import {
  buildUpdateInventoryProviderIssues,
  type UpdateInventoryMachine,
} from "../src/hooks/useUpdateInventory";
import { createAppQueryClient } from "../src/lib/query-client";
import { makeSystemConfig } from "../src/test/fixtures/system-config";
import { systemMachineProvidersQueryKey } from "../src/hooks/queries/query-keys";
import {
  MANUAL_MACHINE_PROVIDER,
  MODAL_MACHINE_PROVIDER,
} from "./machine-story-fixtures";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import {
  OmnyoAppUpdateRows,
  OmnyoUpdatesCard,
  ProviderCliUpdatesSection,
} from "../src/components/settings/UpdatesSettingsSection";
import {
  HOST_IDS,
  HOST_NAMES,
  PROJECT_IDS,
  PROJECT_NAMES,
  STORY_PROJECT_SOURCES,
  makeHost,
  makeProject,
  makeThreadListEntry,
  makeProviderCliStatus,
} from "./story-fixtures";
import codexLogoUrl from "../../../plugins/provider-codex/icons/codex.svg";
import claudeCodeLogoUrl from "../../../plugins/provider-claude-code/icons/claude-code.svg";
import cursorLogoUrl from "../../../plugins/provider-acp/icons/cursor.svg";

const STORY_GIT_HEALTH = {
  status: "logged in" as const,
  statusMessage: "gh is authenticated",
};

const STORY_GLOBAL_VARIABLES = [
  { name: "ANTHROPIC_API_KEY", value: null, secret: true as const, note: null },
  {
    name: "DATABASE_URL",
    value: null,
    secret: true as const,
    note: "Points at the staging replica, not production.",
  },
  { name: "SENTRY_DSN", value: null, secret: true as const, note: null },
];

const SETTINGS_STORY_NOW = Date.parse("2026-08-19T08:00:00.000Z");

const SETTINGS_STORY_PRIMARY_HOST = makeHost({
  createdAt: SETTINGS_STORY_NOW - 45 * 24 * 60 * 60_000,
  lastSeenAt: SETTINGS_STORY_NOW,
});

const SETTINGS_STORY_HOSTS = [
  SETTINGS_STORY_PRIMARY_HOST,
  makeHost({
    id: HOST_IDS.remote,
    name: HOST_NAMES.remote,
    maxPermissionMode: "auto",
    createdAt: SETTINGS_STORY_NOW - 18 * 24 * 60 * 60_000,
    lastSeenAt: SETTINGS_STORY_NOW - 3 * 60_000,
  }),
];

const localProviderStatus = {
  codex: makeProviderCliStatus("codex", {
    currentVersion: "0.145.0",
    latestVersion: "0.146.0",
    needsUpdate: true,
    installAction: {
      kind: "update",
      label: "Update",
      command: "codex update",
    },
  }),
  "claude-code": makeProviderCliStatus("claude-code", {
    currentVersion: "2.1.0",
    latestVersion: "2.1.0",
  }),
  "acp-cursor": makeProviderCliStatus("acp-cursor", {
    currentVersion: "0.49.0",
    latestVersion: "0.49.0",
  }),
} satisfies ProviderCliStatusResponse;

const remoteProviderStatus = {
  codex: makeProviderCliStatus("codex", {
    currentVersion: "0.145.0",
    latestVersion: "0.146.0",
    needsUpdate: true,
    installAction: {
      kind: "update",
      label: "Update",
      command: "codex update",
    },
  }),
  "claude-code": makeProviderCliStatus("claude-code", {
    currentVersion: "2.1.0",
    latestVersion: "2.1.0",
  }),
  "acp-cursor": makeProviderCliStatus("acp-cursor", {
    installed: false,
    executablePath: null,
    currentVersion: null,
    latestVersion: "0.49.0",
    installSource: undefined,
  }),
} satisfies ProviderCliStatusResponse;

const project = makeProject({
  id: PROJECT_IDS.omnyo,
  gitRemoteUrl: "git@github.com:get-bb/bb.git",
  sources: [...STORY_PROJECT_SOURCES],
});

const pierreProject = makeProject({
  id: PROJECT_IDS.pierre,
  name: PROJECT_NAMES.pierre,
  gitRemoteUrl: "https://github.com/get-bb/pierre.git",
  sources: [
    {
      id: "src_pierre_remote",
      projectId: PROJECT_IDS.pierre,
      type: "local_path",
      hostId: HOST_IDS.remote,
      path: "/home/michael/pierre",
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    },
  ],
});

const ingestProject = makeProject({
  id: PROJECT_IDS.ingest,
  name: PROJECT_NAMES.ingest,
  gitRemoteUrl: null,
  sources: [],
});

const personalProject = makeProject({
  id: PERSONAL_PROJECT_ID,
  kind: "personal",
  name: "Personal",
  sources: [],
});

const sidebarNavigation = {
  sections: [],
  groups: [],
  projects: [
    {
      ...project,
      defaultExecutionOptions: null,
      threads: [
        makeThreadListEntry({
          id: "thr_omnyo_1",
          projectId: PROJECT_IDS.omnyo,
        }),
        makeThreadListEntry({
          id: "thr_omnyo_2",
          projectId: PROJECT_IDS.omnyo,
        }),
        makeThreadListEntry({
          id: "thr_omnyo_3",
          projectId: PROJECT_IDS.omnyo,
        }),
      ],
    },
    {
      ...pierreProject,
      defaultExecutionOptions: null,
      threads: [
        makeThreadListEntry({
          id: "thr_pierre_1",
          projectId: PROJECT_IDS.pierre,
        }),
      ],
    },
    { ...ingestProject, defaultExecutionOptions: null, threads: [] },
  ],
  personalProject: {
    ...personalProject,
    defaultExecutionOptions: null,
    threads: [],
  },
  orderedProjectIds: [
    project.id,
    pierreProject.id,
    ingestProject.id,
    personalProject.id,
  ],
} satisfies SidebarBootstrapResponse;

const systemConfig = makeSystemConfig({
  primaryHostId: HOST_IDS.local,
  primaryHostPlatform: "darwin",
  voiceTranscriptionEnabled: true,
  dataDir: "/Users/michael/.omnyo",
});

const systemVersion = {
  currentVersion: "0.39.0",
  latestVersion: "0.39.0",
  currentCommit: null,
  installKind: "npm",
  source: "npm",
  updateAvailable: false,
  isDevelopment: false,
  upgradeCommand: "npx omnyo-app@latest",
} satisfies SystemVersionResponse;

const systemProviders = [
  makeProviderInfo({
    id: "codex",
    displayName: "Codex",
    logoUrl: codexLogoUrl,
  }),
  makeProviderInfo({
    id: "claude-code",
    displayName: "Claude Code",
    logoUrl: claudeCodeLogoUrl,
  }),
  makeProviderInfo({
    id: "acp-cursor",
    displayName: "Cursor",
    logoUrl: cursorLogoUrl,
  }),
] satisfies ProviderInfo[];

export const SETTINGS_STORY_MODEL_PICKER_FAVORITES: UiPreferenceValue<"modelPicker.favorites"> =
  [
    {
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "ultracode",
      serviceTier: "default",
    },
    {
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "xhigh",
      serviceTier: "default",
    },
    {
      providerId: "claude-code",
      model: "claude-sonnet-5-5",
      reasoningLevel: "high",
      serviceTier: "default",
    },
    {
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "medium",
      serviceTier: "default",
    },
  ];

export const SETTINGS_STORY_HIDDEN_MODELS: UiPreferenceValue<"modelPicker.hiddenModels"> =
  {
    codex: ["gpt-5.6-sol"],
    "claude-code": ["claude-sonnet-4-6"],
  };

const settingsStoryUiPreferenceValues: UiPreferenceValues = {
  ...defaultUiPreferences,
  "modelPicker.favorites": SETTINGS_STORY_MODEL_PICKER_FAVORITES,
  "modelPicker.hiddenModels": SETTINGS_STORY_HIDDEN_MODELS,
};

const settingsStoryUiPreferences = {
  preferences: Object.fromEntries(
    UI_PREFERENCE_KEYS.map((key) => [
      key,
      { revision: 0, value: settingsStoryUiPreferenceValues[key] },
    ]),
  ),
};

function settingsStoryModel(
  model: string,
  displayName: string,
  levels: readonly ReasoningLevel[],
  isDefault = false,
): AvailableModel {
  return {
    id: model,
    model,
    displayName,
    description: "",
    supportedReasoningEfforts: levels.map((reasoningEffort) => ({
      reasoningEffort,
      description: "",
    })),
    defaultReasoningEffort: "high",
    isDefault,
  };
}

const settingsStoryCodexModels = [
  settingsStoryModel(
    "gpt-6.1-sol",
    "GPT-6.1-Sol",
    ["low", "medium", "high", "xhigh"],
    true,
  ),
  settingsStoryModel("gpt-6-astra", "GPT-6-Astra", ["low", "medium", "high"]),
  settingsStoryModel("gpt-5.6-sol", "GPT-5.6-Sol", ["low", "medium", "high"]),
];

const settingsStoryModelsByProvider: Record<string, AvailableModel[]> = {
  codex: settingsStoryCodexModels,
  "claude-code": [
    settingsStoryModel(
      "claude-opus-5-5",
      "Opus 5.5",
      ["low", "medium", "high", "xhigh", "ultracode"],
      true,
    ),
    settingsStoryModel("claude-sonnet-5-5", "Sonnet 5.5", [
      "low",
      "medium",
      "high",
    ]),
    settingsStoryModel("claude-sonnet-4-6", "Sonnet 4.6", [
      "low",
      "medium",
      "high",
    ]),
  ],
  "acp-cursor": [settingsStoryModel("auto", "Auto", ["high"], true)],
};

function settingsStoryExecutionOptions(
  models: AvailableModel[],
): SystemExecutionOptionsResponse {
  return {
    providers: systemProviders,
    models,
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
    modelNotice: null,
  };
}

const settingsUpdateMachine = {
  host: SETTINGS_STORY_PRIMARY_HOST,
  providerStatus: localProviderStatus,
  statusPending: false,
  statusError: false,
  statusFetching: false,
  issues: buildUpdateInventoryProviderIssues(localProviderStatus),
  canRetryDaemonUpdate: false,
} satisfies UpdateInventoryMachine;

const noJobs: ReadonlySet<string> = new Set();

const noFailures = new Map<string, never>();

const noop = () => {};

export function SettingsUpdatesStory() {
  return (
    <div className="space-y-6">
      <OmnyoUpdatesCard>
        <OmnyoAppUpdateRows
          systemVersion={systemVersion}
          desktopInfo={null}
          isDesktop={false}
          onRelaunchDesktop={null}
          onRetryDesktop={null}
        />
      </OmnyoUpdatesCard>
      <ProviderCliUpdatesSection
        machines={[settingsUpdateMachine]}
        now={0}
        localDaemonHostId={null}
        serverHostId={null}
        retryPendingHostId={null}
        runningJobKey={null}
        queuedJobKeys={noJobs}
        failuresByJobKey={noFailures}
        onStartInstall={noop}
        onRetryDaemonUpdate={noop}
        onRetryAllDaemonUpdates={noop}
        onRecheckClis={noop}
      />
    </div>
  );
}

function createSettingsStoryQueryClient(hosts: Host[] = SETTINGS_STORY_HOSTS) {
  const queryClient = createAppQueryClient({
    showMutationErrorToasts: false,
    defaultOptions: {
      mutations: { retry: false },
      queries: {
        gcTime: Infinity,
        retry: false,
        staleTime: Infinity,
      },
    },
  });

  queryClient.setQueryData(hostsQueryKey(), hosts);
  queryClient.setQueryData(hostsQueryKey(true), hosts);
  queryClient.setQueryData(systemConfigQueryKey(), systemConfig);
  queryClient.setQueryData(systemProvidersQueryKey(), systemProviders);
  queryClient.setQueryData(systemVersionQueryKey(), systemVersion);
  queryClient.setQueryData(sidebarNavigationQueryKey(), sidebarNavigation);
  queryClient.setQueryData(pluginMarketplacesQueryKey(), []);
  queryClient.setQueryData(machineEnvironmentQueryKey(null), {
    builtInGit: STORY_GIT_HEALTH,
    variables: STORY_GLOBAL_VARIABLES,
    inheritedVariables: [],
  });
  queryClient.setQueryData(machineEnvironmentQueryKey(PROJECT_IDS.omnyo), {
    builtInGit: STORY_GIT_HEALTH,
    variables: [
      {
        name: "DATABASE_URL",
        value: null,
        secret: true,
        note: "Points at the Omnyo sandbox.",
      },
    ],
    inheritedVariables: STORY_GLOBAL_VARIABLES,
  });
  queryClient.setQueryData(
    hostProviderCliStatusQueryKey(HOST_IDS.local),
    localProviderStatus,
  );
  queryClient.setQueryData(
    hostProviderCliStatusQueryKey(HOST_IDS.remote),
    remoteProviderStatus,
  );
  queryClient.setQueryData(pluginListQueryKey(true), []);
  queryClient.setQueryData(serverMoveStatusQueryKey(), {
    move: null,
    lastMove: null,
  });
  queryClient.setQueryData(systemMachineProvidersQueryKey(), [
    MANUAL_MACHINE_PROVIDER,
    MODAL_MACHINE_PROVIDER,
  ]);
  queryClient.setQueryData(uiPreferencesQueryKey(), settingsStoryUiPreferences);
  queryClient.setQueryData(systemProviderCatalogQueryKey(), []);
  queryClient.setQueryData(
    systemExecutionOptionsQueryKey({
      environmentId: null,
      hostId: null,
      providerId: null,
    }),
    settingsStoryExecutionOptions(settingsStoryCodexModels),
  );

  for (const [providerId, models] of Object.entries(
    settingsStoryModelsByProvider,
  )) {
    queryClient.setQueryData(
      systemExecutionOptionsQueryKey({
        environmentId: null,
        hostId: null,
        providerId,
      }),
      settingsStoryExecutionOptions(models),
    );
  }

  return queryClient;
}

export function SettingsStoryFixtures({
  children,
  hosts = SETTINGS_STORY_HOSTS,
}: {
  children: ReactNode;
  hosts?: Host[];
}) {
  const [queryClient] = useState(() => createSettingsStoryQueryClient(hosts));
  useEffect(() => {
    queryClient.setQueryData(hostsQueryKey(), hosts);
    queryClient.setQueryData(hostsQueryKey(true), hosts);
  }, [hosts, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
