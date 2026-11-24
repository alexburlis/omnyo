// @vitest-environment jsdom

import {
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  defaultAppSettings,
  PERSONAL_PROJECT_ID,
  type ThreadListEntry,
  type ThreadSessionOption,
} from "@omnyo/domain";
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithoutQueryClient,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalComposerSelection,
  NewThreadRequest,
  PluginEnvironmentProviderInputsProps,
} from "@omnyo/plugin-sdk";
import type {
  SystemEnvironmentProvider,
  SystemMachineProvider,
  ThreadResponse,
} from "@omnyo/server-contract";
import {
  NewThreadComposer,
  type NewThreadComposerState,
  type NewThreadComposerSubmission,
} from "@/components/promptbox/NewThreadComposer";
import { setComposerSelectionSettleTimeoutForTest } from "@/components/promptbox/composer-selection-settle";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { encodeReuseValue } from "@/components/pickers/environment-picker-value";
import { useRootComposeReuseEnvironment } from "@/lib/root-compose-selection";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { appQueryClient } from "@/lib/app-query-client";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import { makeProjectWithThreadsResponse } from "@/test/fixtures/projects";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  createPendingChat,
  getPendingChatSnapshot,
} from "@/lib/pending-chat-creations";
import { PendingThreadChat } from "@/views/thread-detail/PendingThreadChat";
import { RootComposeView } from "@/views/RootComposeView";
import { DefaultPaneContextProvider } from "@/views/thread-detail/PaneContext";
import { ROOT_COMPOSE_FIXED_PANEL_STATE_ID } from "@/views/RootComposePanelTabContent";
import { resetFixedPanelTabsStateForTest } from "@/lib/fixed-panel-tabs";
import {
  createEmptyFixedPanelTabsState,
  createTerminalFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
  parseFixedPanelTabsState,
  serializeFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs-state";
import { buildPluginPaletteActions } from "@/lib/command-palette/palette-plugin-actions";
import { getActiveThreadPanelOpener } from "./plugin-thread-panel-navigation";
import { PluginDetailPanelContext } from "./plugin-detail-navigation";
import { openPluginDetailsInWorkspace } from "./plugin-detail-opener";
import { PluginNewThreadComposer } from "./PluginNewThreadComposer";

function PanedRootComposeView() {
  return (
    <DefaultPaneContextProvider onRequestClose={null} navigateInPane={() => {}}>
      <RootComposeView />
    </DefaultPaneContextProvider>
  );
}

function render(element: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderWithoutQueryClient(element, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

const mocks = vi.hoisted(() => {
  const defaultHosts = [
    { id: "host_1", name: "Machine", status: "connected" },
    { id: "host_2", name: "Other machine", status: "connected" },
  ];

  return {
    defaultHosts,
    hosts: defaultHosts,
    promptBoxProps: [] as Array<Record<string, any>>,
    copyAttachments: vi.fn(),
    uploadAttachment: vi.fn(),
    projectThreads: [] as ThreadListEntry[],
    sidebarNavigationSettled: true,
    sidebarNavigationReplayed: false,
    extraProjects: [] as Array<Record<string, unknown>>,
    promptHistoryQueryOptions: [] as Array<{ enabled?: boolean } | undefined>,
    environmentProviders: [] as unknown[],
    closeTerminal: vi.fn(() => Promise.resolve()),
    plugins: [] as unknown[],
    serverAccessReady: true,
    serverDataVersion: 0,
    serverDataListeners: new Set<() => void>(),
    machineProviders: [] as SystemMachineProvider[],
    modelsLoading: false,
    permissionCeiling: undefined as
      | "accept-edits"
      | "auto"
      | "full"
      | undefined,
    modelSessionOptions: undefined as ThreadSessionOption[] | undefined,
    localHostProbe: false,
    defaultThreadMachineId: (): string | null => null,
    executionOptionsArgs: new Array<{
      enabled?: boolean;
      hostId?: string;
      environmentId?: string;
    }>(),
  };
});

vi.mock("@/views/RootComposePanelCommandHandlers", () => ({
  RootComposePanelCommandHandlers: ({
    onClose,
  }: {
    onClose: () => boolean;
  }) => {
    const details = useContext(PluginDetailPanelContext);

    return (
      <button
        data-active-detail={details?.activePluginId ?? ""}
        onClick={onClose}
      >
        Close panel command
      </button>
    );
  },
}));

vi.mock("@/components/secondary-panel/SecondaryPanelLayout", () => ({
  SecondaryPanelLayout: ({ main }: { main: ReactNode }) => main,
}));

vi.mock("@/hooks/queries/thread-terminal-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/queries/thread-terminal-queries")
    >();

  return {
    ...actual,
    useTerminals: () => ({ data: undefined }),
    useEnvironmentTerminals: () => ({ data: undefined }),
    useCloseTerminal: () => ({ mutateAsync: mocks.closeTerminal }),
  };
});

vi.mock("@/components/promptbox/NewThreadPromptBox", () => ({
  NewThreadPromptBox: (props: Record<string, any>) => {
    mocks.promptBoxProps.push(props);

    return (
      <div data-testid="new-thread-prompt-box">
        {props.modeConfig?.banner ?? null}
        {props.modeConfig?.environmentProviderInputsSlot ?? null}
      </div>
    );
  },
}));

vi.mock("@/hooks/queries/environment-provider-queries", () => ({
  useSystemEnvironmentProviders: () => ({
    providers: mocks.environmentProviders,
  }),
}));

vi.mock("@/hooks/queries/machine-provider-queries", () => ({
  useSystemMachineProviders: () => ({ providers: mocks.machineProviders }),
}));

vi.mock("@/hooks/queries/plugin-settings-queries", () => ({
  usePluginList: () => ({ data: { plugins: mocks.plugins } }),
}));

vi.mock("@/views/home-orientation/HomeOrientation", () => ({
  HomeGreeting: () => null,
  HomeStatusCards: () => null,
}));

vi.mock("@/lib/sdk", async () => {
  const { OmnyoHttpError } = await import("@omnyo/sdk/browser");

  return {
    OmnyoHttpError,
    sdk: {
      projects: { attachments: { copy: mocks.copyAttachments } },
      terminals: {
        foreground: () => Promise.resolve({ state: "idle" }),
      },
      system: {
        experimental_recordTelemetryEvent: vi
          .fn()
          .mockRejectedValue(new Error("Telemetry unavailable")),
      },
    },
  };
});

const PROJECT = makeProjectWithThreadsResponse({
  id: "proj_1",
  name: "Project One",
  defaultExecutionOptions: {
    providerId: "codex",
    model: "gpt-5.6",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "auto",
  },
  sources: [
    {
      id: "src_1",
      projectId: "proj_1",
      type: "local_path",
      hostId: "host_1",
      path: "/repo",
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "src_remote",
      projectId: "proj_1",
      type: "local_path",
      hostId: "host_2",
      path: "/remote-repo",
      isDefault: false,
      createdAt: 0,
      updatedAt: 0,
    },
  ],
});

const OTHER_PROJECT = makeProjectWithThreadsResponse({
  ...PROJECT,
  id: "proj_2",
  name: "Project Two",
  sources: [{ ...PROJECT.sources[0], id: "src_2", projectId: "proj_2" }],
});

function subscribeToServerData(onChange: () => void) {
  mocks.serverDataListeners.add(onChange);

  return () => {
    mocks.serverDataListeners.delete(onChange);
  };
}

function useServerDataSubscription() {
  useSyncExternalStore(subscribeToServerData, () => mocks.serverDataVersion);
}

async function publishServerData(change: () => void) {
  await act(async () => {
    change();
    mocks.serverDataVersion += 1;

    for (const listener of mocks.serverDataListeners) {
      listener();
    }
  });
}

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => {
    useServerDataSubscription();

    return mocks.sidebarNavigationSettled
      ? {
          data: {
            sections: [],
            projects: [
              { ...PROJECT, threads: mocks.projectThreads },
              OTHER_PROJECT,
              ...mocks.extraProjects,
            ],
            personalProject: makeProjectWithThreadsResponse({
              id: "personal",
              kind: "personal",
              name: "Personal",
              sources: [],
              threads: [],
            }),
          },
          isError: false,
          isLoading: false,
          isPending: false,
          isSuccess: true,
          isPlaceholderData: mocks.sidebarNavigationReplayed,
        }
      : {
          data: undefined,
          isError: false,
          isLoading: true,
          isPending: true,
          isSuccess: false,
          isPlaceholderData: false,
        };
  },
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: mocks.hosts }),
  selectHosts: <T,>(hosts: T[] | undefined) => hosts ?? [],
  selectPrimaryHost: (
    hosts: Array<{ id: string }> | undefined,
    primaryHostId: string | null,
  ) => hosts?.find((host) => host.id === primaryHostId) ?? hosts?.[0] ?? null,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  systemConfigQueryOptions: () => ({
    queryKey: ["system-config"],
    queryFn: async () => ({
      localHelperPorts: mocks.localHostProbe ? [38888] : [],
    }),
  }),
  useSystemProviders: () => ({ data: undefined }),
  useSystemProviderStates: () => ({ data: undefined, isPending: false }),
  useKnownProviderModelCatalogScope: () => undefined,
  useHostProviderCliStatus: () => ({ data: undefined }),
  useSystemConfig: () => {
    useServerDataSubscription();

    return {
      data: {
        primaryHostId: "host_1",
        generalSettings: {
          ...defaultAppSettings,
          defaultThreadMachineId: mocks.defaultThreadMachineId(),
        },
        serverAccess: {
          providers: [
            {
              id: "connect",
              displayName: "Omnyo connect",
              description: "Use a private Omnyo connect address.",
              pluginId: "connect",
              availability: mocks.serverAccessReady
                ? {
                    status: "available",
                    serverUrl: "https://sawyer.example.test",
                  }
                : {
                    status: "setup-required",
                    message: "Pair with Omnyo connect",
                  },
            },
          ],
          defaultProviderId: "connect",
          effectiveUrl: "https://sawyer.example.test",
          urlSource: null,
        },
      },
    };
  },
  useSystemExecutionOptions: (args: {
    enabled?: boolean;
    hostId?: string;
    environmentId?: string;
  }) => {
    mocks.executionOptionsArgs.push(args);

    return mocks.modelsLoading
      ? {
          data: undefined,
          isLoading: true,
          isError: false,
          isPlaceholderData: false,
        }
      : {
          data: {
            permissionCeiling: mocks.permissionCeiling,
            providers: [
              {
                id: "codex",
                displayName: "Codex",
                logoUrl: null,
                capabilities: {
                  supportsServiceTier: false,
                  permissionModes: ["auto", "accept-edits", "full"],
                },
                composerActions: [],
              },
              {
                id: "claude-code",
                displayName: "Claude Code",
                logoUrl: null,
                capabilities: {
                  supportsServiceTier: false,
                  permissionModes: ["auto", "accept-edits", "full"],
                },
                composerActions: [],
              },
            ],
            models: [
              {
                model: "gpt-5.6",
                displayName: "GPT-5.6",
                isDefault: true,
                sessionOptions: mocks.modelSessionOptions,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "medium" },
                  { reasoningEffort: "high" },
                ],
              },
              {
                model: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                isDefault: false,
                sessionOptions: mocks.modelSessionOptions,
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium" },
                  { reasoningEffort: "high" },
                ],
              },
            ],
            selectedOnlyModels: [],
            modelLoadError: null,
          },
          isLoading: false,
          isError: false,
          isPlaceholderData: false,
        };
  },
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadStorageFiles: () => ({
    data: undefined,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useThreadStorageFilePreview: () => ({
    data: undefined,
    error: null,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/queries/project-queries", () => ({
  stripProjectThreads: (project: unknown) => project,
  useProjectPromptHistory: (
    _projectId: unknown,
    options?: { enabled?: boolean },
  ) => {
    mocks.promptHistoryQueryOptions.push(options);

    return { data: [] };
  },
  useProjectSourceBranches: () => ({
    data: {
      branches: ["main", "release"],
      branchesTruncated: false,
      checkout: { kind: "branch", branchName: "main" },
      defaultBranch: "main",
      defaultBranchRelation: null,
      hasUncommittedChanges: false,
      operation: { kind: "none" },
      originDefaultBranch: null,
      remoteBranches: [],
      remoteBranchesTruncated: false,
      selectedBranch: null,
      defaultWorktreeBaseBranch: null,
    },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => ({
    mutateAsync: mocks.uploadAttachment,
    isPending: false,
  }),
}));

vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentions: () => ({
    triggers: [],
    suggestions: [],
    isLoading: false,
    isError: false,
    setQuery: vi.fn(),
  }),
}));

vi.mock("@/hooks/useCommandSuggestions", () => ({
  useCommandSuggestions: () => ({
    triggers: [],
    suggestions: [],
    isLoading: false,
    isError: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectConfig: () => ({
    onCreate: vi.fn(),
    disabled: true,
    isCreating: false,
  }),
  useQuickCreateProjectController: () => ({
    hostId: null,
    hostName: null,
    hosts: [],
    isAvailable: false,
    isCreating: false,
    openCreateDialog: vi.fn(),
    platform: null,
    projectPathDialog: {
      isOpen: false,
      onOpenChange: vi.fn(),
      target: null,
    },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/components/dialogs/ProjectMachineSetupDialog", () => ({
  ProjectMachineSetupDialog: () => null,
}));

vi.mock("@/views/RootComposeSecondaryContent", () => ({
  ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS: "",
  RootComposeSecondaryContent: ({ children }: { children: ReactNode }) =>
    children,
}));

function latestPromptBoxProps(): Record<string, any> {
  const props = mocks.promptBoxProps.at(-1);
  expect(props).toBeDefined();

  return props as Record<string, any>;
}

function RootReuseProbe() {
  const [reuseEnvironment, setReuseEnvironment] =
    useRootComposeReuseEnvironment();

  return (
    <button
      type="button"
      data-testid="root-reuse-probe"
      data-value={reuseEnvironment}
      onClick={() => setReuseEnvironment("reuse:env-root")}
    />
  );
}

function ForkSeedSurface({ composer }: { composer: NewThreadComposerState }) {
  const { seedEnvironmentSelectionValue } = composer;
  useEffect(() => {
    seedEnvironmentSelectionValue(encodeReuseValue("env-source"));
  }, [seedEnvironmentSelectionValue]);

  return composer.renderPromptBox({ mentionMenuPlacement: "bottom" });
}

function LocationProbe() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

function composerElement(
  seed: NewThreadRequest,
  onSubmit: (request: NewThreadRequest) => void,
  draftKey: string,
) {
  return (
    <MemoryRouter>
      <LocationProbe />
      <PluginNewThreadComposer
        draftKey={draftKey}
        defaultProjectId={seed.projectId}
        defaultProviderId={seed.providerId}
        defaultModel={seed.model}
        defaultReasoningLevel={seed.reasoningLevel}
        defaultServiceTier={seed.serviceTier}
        defaultPermissionMode={seed.permissionMode}
        defaultEnvironment={seed.environment}
        initialPrompt="review every PR for slop"
        onSubmit={onSubmit}
      />
    </MemoryRouter>
  );
}

function renderComposer(
  seed: NewThreadRequest,
  onSubmit: (request: NewThreadRequest) => void,
  draftKey: string,
) {
  return render(composerElement(seed, onSubmit, draftKey));
}

const BRANCH_INPUTS_SCHEMA = {
  type: "object",
  properties: { branch: { type: "object" } },
  required: ["branch"],
};

const CHECKOUT_PROVIDER: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "project-checkout",
  displayName: "Project checkout",
  description: "Prepare a workspace for this thread.",
  icon: "Laptop",
  logoUrl: null,
  pluginId: "environment-project-checkout",
  acceptsEmptyInputs: true,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: {
    type: "object",
    properties: { branch: { type: "object" }, path: { type: "string" } },
  },
};

const PERSONAL_WORKSPACE_PROVIDER: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "personal-workspace",
  displayName: "Personal workspace",
  description: "Prepare a workspace for this thread.",
  icon: "Folder",
  logoUrl: null,
  pluginId: "environment-personal-workspace",
  acceptsEmptyInputs: true,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: true,
  },
  inputs: null,
};

const MANAGED_WORKTREE_SUGAR_PROVIDER: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "git-worktree",
  displayName: "Worktree",
  description: "Prepare a workspace for this thread.",
  icon: "GitBranch",
  logoUrl: null,
  pluginId: "environment-git-worktree",
  acceptsEmptyInputs: false,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: BRANCH_INPUTS_SCHEMA,
};

const EMPTY_SLOT_REGISTRATIONS = {
  homepageSections: [],
  settingsSections: [],
  navPanels: [],
  threadPanelActions: [],
  sidebarFooterActions: [],
  fileOpeners: [],
  messageDirectives: [],
};

const DEFAULT_BRANCH_INPUTS = { branch: { kind: "default" } };

function WorktreeInputsControl({
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  useEffect(() => {
    if (value === null) {
      onChange({ status: "ready", value: DEFAULT_BRANCH_INPUTS });
    }
  }, [onChange, value]);

  return (
    <button
      type="button"
      data-testid="worktree-default-branch"
      onClick={() =>
        onChange({ status: "ready", value: DEFAULT_BRANCH_INPUTS })
      }
    >
      default branch
    </button>
  );
}

function registerWorktreeInputsControl(): void {
  setPluginSlotRegistrations("environment-git-worktree", {
    ...EMPTY_SLOT_REGISTRATIONS,
    environmentProviderInputs: [
      {
        environmentProviderId: "git-worktree",
        component: WorktreeInputsControl,
      },
    ],
  });
}

function CheckoutInputsControl({
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  useEffect(() => {
    if (value === null) onChange({ status: "ready", value: {} });
  }, [onChange, value]);

  return null;
}

function registerCheckoutInputsControl(): void {
  setPluginSlotRegistrations("environment-project-checkout", {
    ...EMPTY_SLOT_REGISTRATIONS,
    environmentProviderInputs: [
      {
        environmentProviderId: "project-checkout",
        component: CheckoutInputsControl,
      },
    ],
  });
}

const STORED_REQUEST: NewThreadRequest = {
  projectId: "proj_1",
  providerId: "claude-code",
  model: "gpt-5.6-sol",
  reasoningLevel: "high",
  permissionMode: "full",
  executionInputSources: {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    permissionMode: "explicit",
  },
  environment: {
    type: "provider",
    environmentProviderId: "git-worktree",
    machine: { type: "existing", hostId: "host_1" },
    inputs: { branch: { kind: "named", name: "release" } },
  },
  input: [{ type: "text", text: "review every PR for slop", mentions: [] }],
};

async function submit(): Promise<void> {
  await act(async () => {
    latestPromptBoxProps().onSubmit();
  });
}

describe("PluginNewThreadComposer seeding", () => {
  beforeEach(() => {
    resetFixedPanelTabsStateForTest();
    mocks.closeTerminal.mockClear();
    mocks.modelSessionOptions = undefined;
    mocks.promptBoxProps.length = 0;
    mocks.promptHistoryQueryOptions.length = 0;
    mocks.copyAttachments.mockReset();
    mocks.uploadAttachment.mockReset();
    mocks.projectThreads = [];
    mocks.sidebarNavigationSettled = true;
    mocks.sidebarNavigationReplayed = false;
    mocks.extraProjects = [];
    mocks.hosts = mocks.defaultHosts;
    mocks.plugins = [];
    mocks.serverAccessReady = true;
    mocks.machineProviders = [];
    mocks.modelsLoading = false;
    mocks.permissionCeiling = undefined;
    mocks.localHostProbe = false;
    mocks.defaultThreadMachineId = () => null;
    appQueryClient.clear();
    mocks.executionOptionsArgs = [];
    mocks.environmentProviders = [
      CHECKOUT_PROVIDER,
      MANAGED_WORKTREE_SUGAR_PROVIDER,
      PERSONAL_WORKSPACE_PROVIDER,
    ];
    resetPluginSlotStoreForTest();
    registerWorktreeInputsControl();
    registerCheckoutInputsControl();
    window.localStorage.clear();
    window.sessionStorage.clear();
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function newThreadElement(
    projectId: string,
    onSubmit: (request: NewThreadRequest) => void = () => undefined,
  ) {
    return (
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId={projectId}
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="new-thread"
            onSubmit={onSubmit}
          >
            {(composer) =>
              composer.renderPromptBox({ mentionMenuPlacement: "bottom" })
            }
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>
    );
  }

  it("re-renders only the prompt box, not the composer surface, while typing", () => {
    const surfaceStates: NewThreadComposerState[] = [];
    render(
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId="proj_1"
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="new-thread"
            onSubmit={() => undefined}
          >
            {(composer) => {
              surfaceStates.push(composer);

              return composer.renderPromptBox({
                mentionMenuPlacement: "bottom",
              });
            }}
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>,
    );
    act(() => {
      latestPromptBoxProps().onChange("h", []);
    });
    const surfaceRendersAfterFirstKey = surfaceStates.length;
    const promptBoxRendersAfterFirstKey = mocks.promptBoxProps.length;

    const text = "hello world";

    for (let length = 2; length <= text.length; length += 1) {
      act(() => {
        latestPromptBoxProps().onChange(text.slice(0, length), []);
      });
    }

    expect(surfaceStates.length).toBe(surfaceRendersAfterFirstKey);
    expect(mocks.promptBoxProps.length - promptBoxRendersAfterFirstKey).toBe(
      text.length - 1,
    );
    expect(latestPromptBoxProps().value).toBe("hello world");
    expect(new Set(surfaceStates.map((state) => state.promptDraft)).size).toBe(
      1,
    );
  });

  it("forwards a requested mention menu placement to the prompt box", () => {
    render(
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId="proj_1"
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="new-thread"
            onSubmit={() => undefined}
          >
            {(composer) =>
              composer.renderPromptBox({ mentionMenuPlacement: "top" })
            }
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>,
    );

    expect(latestPromptBoxProps().mentionMenuPlacement).toBe("top");
  });

  it.each([
    { projectId: "proj_1", machine: "host_2" },
    { projectId: "proj_2", machine: "host_1" },
  ])(
    "starts fresh chats in $projectId on $machine, the global machine unless it lacks the project, while preserving explicit choices",
    async ({ projectId, machine }) => {
      const submitted = vi.fn<(request: NewThreadRequest) => void>();
      mocks.defaultThreadMachineId = () => "host_2";
      const view = render(newThreadElement(projectId, submitted));
      await act(async () => {
        getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
          text: "hello",
          mentions: [],
          attachments: [],
        });
      });
      await waitFor(() => {
        expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
          "provider:project-checkout",
        );
        expect(
          latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
        ).toBe(machine);
        expect(latestPromptBoxProps().disabled).toBe(false);
      });

      await act(async () => {
        latestPromptBoxProps().modeConfig.environment.onSelectProvider(
          CHECKOUT_PROVIDER,
          "host_1",
        );
        getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
          text: "hello",
          mentions: [],
          attachments: [],
        });
      });
      await submit();
      expect(submitted).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.objectContaining({
            machine: { type: "existing", hostId: "host_1" },
          }),
        }),
      );
      view.unmount();
      render(newThreadElement(projectId));
      await waitFor(() =>
        expect(
          latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
        ).toBe(machine),
      );
    },
  );

  it("starts a project the default machine lacks on a connected machine that has it", async () => {
    const submitted = vi.fn<(request: NewThreadRequest) => void>();
    mocks.defaultThreadMachineId = () => "host_1";
    mocks.hosts = [
      ...mocks.defaultHosts,
      { id: "host_3090", name: "3090", status: "connected" },
      { id: "host_5080", name: "5080", status: "disconnected" },
    ];
    mocks.extraProjects = [
      makeProjectWithThreadsResponse({
        ...PROJECT,
        id: "proj_strato",
        name: "Stratoclash",
        sources: [
          {
            ...PROJECT.sources[0],
            id: "src_strato_5080",
            projectId: "proj_strato",
            hostId: "host_5080",
            isDefault: true,
          },
          {
            ...PROJECT.sources[0],
            id: "src_strato_3090",
            projectId: "proj_strato",
            hostId: "host_3090",
            isDefault: false,
          },
        ],
      }),
    ];
    render(newThreadElement("proj_strato", submitted));
    await act(async () => {
      getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
        text: "ship the arena",
        mentions: [],
        attachments: [],
      });
    });
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));
    await submit();
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          machine: { type: "existing", hostId: "host_3090" },
        }),
      }),
    );
  });

  function seededEnvironmentElement(
    environment: NewThreadRequest["environment"],
    onSubmit: (request: NewThreadRequest) => void,
    locks: { environment?: boolean },
  ) {
    return (
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId="proj_1"
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="component-local"
            seed={{ environment }}
            onSubmit={onSubmit}
          >
            {(composer) =>
              composer.renderPromptBox({
                mentionMenuPlacement: "bottom",
                locks,
              })
            }
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>
    );
  }

  const WORKTREE_WITHOUT_INPUTS: NewThreadRequest["environment"] = {
    type: "provider",
    environmentProviderId: "git-worktree",
    machine: { type: "existing", hostId: "host_1" },
    inputs: null,
  };

  it("submits the default worktree inputs when no inputs control mounts", async () => {
    const submitted = vi.fn<(request: NewThreadRequest) => void>();
    render(
      seededEnvironmentElement(WORKTREE_WITHOUT_INPUTS, submitted, {
        environment: true,
      }),
    );
    await act(async () => {
      getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
        text: "hello",
        mentions: [],
        attachments: [],
      });
    });
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));
    await submit();
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          environmentProviderId: "git-worktree",
          inputs: DEFAULT_BRANCH_INPUTS,
        }),
      }),
    );
  });

  it("lets a mounted inputs control replace the default worktree inputs", async () => {
    const releaseInputs = { branch: { kind: "named", name: "release" } };
    setPluginSlotRegistrations("environment-git-worktree", {
      ...EMPTY_SLOT_REGISTRATIONS,
      environmentProviderInputs: [
        {
          environmentProviderId: "git-worktree",
          component: ({ onChange }: PluginEnvironmentProviderInputsProps) => (
            <button
              type="button"
              onClick={() =>
                onChange({ status: "ready", value: releaseInputs })
              }
            >
              release branch
            </button>
          ),
        },
      ],
    });
    const submitted = vi.fn<(request: NewThreadRequest) => void>();
    render(seededEnvironmentElement(WORKTREE_WITHOUT_INPUTS, submitted, {}));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "release branch" }));
      getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
        text: "hello",
        mentions: [],
        attachments: [],
      });
    });
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));
    await submit();
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({ inputs: releaseInputs }),
      }),
    );
  });

  it("restores the environment type and machine after reload and project switching", async () => {
    const first = render(newThreadElement("proj_1"));
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        MANAGED_WORKTREE_SUGAR_PROVIDER,
        "host_2",
      );
    });
    expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
      "provider:git-worktree",
    );
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_2");
    first.rerender(newThreadElement("proj_2"));
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_1");
    first.rerender(newThreadElement("proj_1"));
    expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
      "provider:git-worktree",
    );
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_2");
    first.unmount();
    render(newThreadElement("proj_1"));
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:git-worktree",
      );
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_2");
    });
  });

  it("uses the connected client machine for both the catalog and submission target", async () => {
    mocks.localHostProbe = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          hostId: "host_2",
          connected: true,
          protocolVersion: 236,
          serverUrl: window.location.origin,
          supportsNativeFolderPicker: false,
          platform: "win32",
        }),
      ),
    );
    const onSubmit = vi.fn<(request: NewThreadRequest) => void>();
    render(newThreadElement("proj_1", onSubmit));
    await waitFor(() => {
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_2");
      expect(
        mocks.executionOptionsArgs.some((args) => args.enabled !== false),
      ).toBe(true);
      expect(
        mocks.executionOptionsArgs
          .filter((args) => args.enabled !== false)
          .every((args) => args.hostId === "host_2"),
      ).toBe(true);
    });
    await act(async () => {
      getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
        text: "Inspect the selected machine",
        mentions: [],
        attachments: [],
      });
    });
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          machine: { type: "existing", hostId: "host_2" },
        }),
      }),
    );
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectHost("host_1");
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_1");
    expect(mocks.executionOptionsArgs.at(-1)?.hostId).toBe("host_1");
  });

  it("waits for client machine discovery before probing the default server", async () => {
    mocks.localHostProbe = true;
    const status = createDeferredPromise<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => status.promise),
    );
    render(newThreadElement("proj_1"));
    expect(
      mocks.executionOptionsArgs.some((args) => args.enabled !== false),
    ).toBe(false);
    await act(async () => {
      status.resolve(
        Response.json({
          hostId: "host_2",
          connected: true,
          protocolVersion: 236,
          serverUrl: window.location.origin,
          supportsNativeFolderPicker: false,
          platform: "win32",
        }),
      );
    });
    await waitFor(() => {
      expect(mocks.executionOptionsArgs.at(-1)).toMatchObject({
        enabled: true,
        hostId: "host_2",
      });
    });
  });

  it("selects a host immediately with the tab's current environment option", async () => {
    const first = render(newThreadElement("proj_1"));
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        MANAGED_WORKTREE_SUGAR_PROVIDER,
        "host_1",
      );
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectHost("host_2");
    });
    expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
      "provider:git-worktree",
    );
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_2");

    first.unmount();
    render(newThreadElement("proj_1"));
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:git-worktree",
      );
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_2");
    });
  });

  it("selects an unconfigured host immediately and blocks submission", async () => {
    render(newThreadElement("proj_2"));
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectHost("host_2");
    });
    expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
      "provider:project-checkout",
    );
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_2");
    expect(latestPromptBoxProps().disabled).toBe(true);
  });

  it.each(["host_deleted", "host_2"])(
    "falls back when remembered machine %s cannot run the project",
    async (hostId) => {
      window.localStorage.setItem(
        "omnyo.promptbox.environment-proj_2-1",
        "provider:git-worktree",
      );
      window.localStorage.setItem("omnyo.promptbox.machine-proj_2-1", hostId);
      render(newThreadElement("proj_2"));
      await waitFor(() => {
        expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
          "provider:git-worktree",
        );
        expect(
          latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
        ).toBe("host_1");
      });
      expect(
        window.localStorage.getItem("omnyo.promptbox.machine-proj_2-1"),
      ).toBe(hostId);
    },
  );

  it("keeps a plugin composer's machine separate from the new-thread preference", async () => {
    window.localStorage.setItem("omnyo.promptbox.machine-proj_1-1", "host_2");
    renderComposer(STORED_REQUEST, () => undefined, "local-machine");
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_1");
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        CHECKOUT_PROVIDER,
        "host_1",
      );
    });
    expect(
      window.localStorage.getItem("omnyo.promptbox.machine-proj_1-1"),
    ).toBe("host_2");
  });

  it("round-trips a stored request submitted untouched", async () => {
    const submitted: NewThreadRequest[] = [];
    renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "round-trip",
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual(STORED_REQUEST);
    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe("");
    });
  });

  it("submits an initial thread token with its resolved mention range", async () => {
    const threadId = "thr_abcdefghij";
    mocks.projectThreads = [
      makeThreadListEntry({
        id: threadId,
        projectId: "proj_1",
        title: "Hand-off source",
      }),
    ];
    const onSubmit = vi.fn<(request: NewThreadRequest) => void>();
    const text = `Continue @thread:${threadId}`;
    render(
      <MemoryRouter>
        <PluginNewThreadComposer
          draftKey="initial-thread-mention"
          defaultProjectId="proj_1"
          initialPrompt={text}
          onSubmit={onSubmit}
        />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe(text);
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0].input).toEqual([
      {
        type: "text",
        text,
        mentions: [
          {
            start: 9,
            end: text.length,
            resource: {
              kind: "thread",
              threadId,
              projectId: "proj_1",
              label: "Hand-off source",
            },
          },
        ],
      },
    ]);
  });

  it("marks a provider picked in an unseeded plugin composer as explicit", async () => {
    const submitted: NewThreadRequest[] = [];
    render(
      <MemoryRouter>
        <PluginNewThreadComposer
          draftKey="picked-provider"
          defaultProjectId="proj_1"
          initialPrompt="hello"
          onSubmit={(request) => {
            submitted.push(request);
          }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().execution.provider.onChange("claude-code");
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().execution.provider.selectedId).toBe(
        "claude-code",
      );
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.providerId).toBe("claude-code");
    expect(submitted[0]?.executionInputSources.providerId).toBe("explicit");
  });

  it("puts declared agent options in the picker, keeps the mode in the footer and submits what the user chose", async () => {
    mocks.modelSessionOptions = [
      { type: "boolean", id: "daybreak", label: "Daybreak", value: false },
      {
        type: "select",
        id: "mode",
        label: "Mode",
        category: "mode",
        value: "agent",
        values: [
          { id: "agent", label: "Agent" },
          { id: "plan", label: "Plan" },
        ],
      },
    ];
    const submitted: NewThreadRequest[] = [];
    render(
      <MemoryRouter>
        <PluginNewThreadComposer
          draftKey="agent-options"
          defaultProjectId="proj_1"
          initialPrompt="hello"
          onSubmit={(request) => {
            submitted.push(request);
          }}
        />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    const pickerSections = () =>
      latestPromptBoxProps().execution.agentOptions.sections.map(
        (section: { id: string; selectedLabel: string }) => [
          section.id,
          section.selectedLabel,
        ],
      );

    const footerMenu = () =>
      latestPromptBoxProps().modeConfig.sessionOptionsControl.props;

    expect(pickerSections()).toEqual([["daybreak", "Off"]]);
    expect(
      footerMenu().options.map((option: { id: string }) => option.id),
    ).toEqual(["mode"]);

    await act(async () => {
      latestPromptBoxProps().execution.agentOptions.onChange("daybreak", true);
    });
    await act(async () => {
      footerMenu().onChange("mode", "plan");
    });
    expect(pickerSections()).toEqual([["daybreak", "On"]]);
    expect(footerMenu().options[0].value).toBe("plan");
    await submit();

    expect(submitted[0]?.sessionOptions).toEqual({
      daybreak: true,
      mode: "plan",
    });
  });

  it("submits a draft populated after an empty composer unmounts", async () => {
    const submitted: NewThreadRequest[] = [];

    const view = renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "background-transcript",
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    act(() => {
      const host = latestPromptBoxProps().pluginComposerHost;
      host.setDraft({ ...host.getCurrent(), text: "" });
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().disabledReason).toBe(
        "Enter a prompt or attach a file.",
      );
    });
    const host = latestPromptBoxProps().pluginComposerHost;
    view.unmount();
    host.setDraft({ ...host.getCurrent(), text: "Background transcript" });
    await act(async () => {
      await host.submit({ experimental_data: null }, undefined);
    });
    expect(submitted).toEqual([
      {
        ...STORED_REQUEST,
        input: [{ type: "text", text: "Background transcript", mentions: [] }],
      },
    ]);
  });

  it("binds plugin draft actions to the hosted composer instance", async () => {
    renderComposer(STORED_REQUEST, () => undefined, "host-binding");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    const host = latestPromptBoxProps().pluginComposerHost;
    expect(host.scope).toEqual({ kind: "new-thread", projectId: "proj_1" });
    expect(host.getCurrent().text).toBe("review every PR for slop");

    act(() => {
      host.setDraft({
        ...host.getCurrent(),
        text: "updated through the Composer API",
      });
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe(
        "updated through the Composer API",
      );
    });
  });

  it("preserves plugin submission data through a new-thread composer", async () => {
    const submitted: NewThreadRequest[] = [];
    renderComposer(
      STORED_REQUEST,
      (request) => submitted.push(request),
      "plugin-submission",
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    const pluginSubmission = {
      pluginId: "drafts",
      data: { kind: "draft" } as const,
    };

    await act(async () => {
      await latestPromptBoxProps().pluginComposerHost.submit(
        {
          experimental_data: pluginSubmission.data,
          experimental_expectHeld: { reason: "Saved as a draft" },
        },
        pluginSubmission,
      );
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ pluginSubmission });
    expect(submitted[0]).not.toHaveProperty("expectedPluginWait");
  });

  it("does not demote a project the replayed bootstrap does not know yet", async () => {
    mocks.sidebarNavigationReplayed = true;
    const submitted: NewThreadRequest[] = [];

    const onSubmit = (request: NewThreadRequest) => {
      submitted.push(request);
    };

    const seed = { ...STORED_REQUEST, projectId: "proj_new" };

    const { rerender } = render(
      composerElement(seed, onSubmit, "replay-unknown-project"),
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().project.value).toBe("proj_new");
    });
    expect(latestPromptBoxProps().project.isLoading).toBe(true);
    expect(latestPromptBoxProps().disabled).toBe(true);

    mocks.sidebarNavigationReplayed = false;
    mocks.extraProjects = [
      {
        ...PROJECT,
        id: "proj_new",
        name: "Project New",
        sources: [
          { ...PROJECT.sources[0], id: "src_new", projectId: "proj_new" },
        ],
      },
    ];
    rerender(composerElement(seed, onSubmit, "replay-unknown-project"));

    await waitFor(() => {
      expect(latestPromptBoxProps().project.isLoading).toBe(false);
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.projectId).toBe("proj_new");
  });

  it("treats a replayed bootstrap that knows the project as settled", async () => {
    mocks.sidebarNavigationReplayed = true;
    renderComposer(STORED_REQUEST, () => {}, "replay-known-project");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    expect(latestPromptBoxProps().project.isLoading).toBe(false);
    expect(latestPromptBoxProps().project.value).toBe("proj_1");
  });

  it("allows submitting a projectless thread", async () => {
    const submitted: NewThreadRequest[] = [];
    renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "projectless",
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
      expect(latestPromptBoxProps().project.allowNoProject).toBe(true);
    });
    await act(async () => {
      await latestPromptBoxProps().project.onChange(null);
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().project.value).toBeNull();
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      projectId: PERSONAL_PROJECT_ID,
      environment: {
        type: "provider",
        environmentProviderId: "personal-workspace",
        inputs: null,
      },
    });
  });

  it("re-seeds every selection when the seed props change, even after a user pick", async () => {
    const submitted: NewThreadRequest[] = [];

    const view = renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "re-seed",
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await act(async () => {
      latestPromptBoxProps().execution.model.onChange("gpt-5.6");
    });

    const otherRecord: NewThreadRequest = {
      ...STORED_REQUEST,
      model: "gpt-5.6-sol",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: {
          type: "unmanaged",
          path: null,
          branch: { kind: "existing", name: "release" },
        },
      },
    };

    view.rerender(
      composerElement(
        otherRecord,
        (request) => {
          submitted.push(request);
        },
        "re-seed",
      ),
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual({
      ...otherRecord,
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: "host_1" },
        inputs: { branch: { kind: "existing", name: "release" } },
      },
    });
  });

  it("re-seeds the provider inputs when the next record differs only by project", async () => {
    const submitted: NewThreadRequest[] = [];

    const onSubmit = (request: NewThreadRequest) => {
      submitted.push(request);
    };

    const view = renderComposer(STORED_REQUEST, onSubmit, "project-switch");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId("worktree-default-branch"));

    const otherProjectRecord: NewThreadRequest = {
      ...STORED_REQUEST,
      projectId: "proj_2",
    };

    view.rerender(
      composerElement(otherProjectRecord, onSubmit, "project-switch"),
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual(otherProjectRecord);
  });

  it("does not resurrect the seeded inputs after the user leaves and returns to the environment", async () => {
    const submitted: NewThreadRequest[] = [];
    renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "env-return",
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        CHECKOUT_PROVIDER,
        "host_1",
      );
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        MANAGED_WORKTREE_SUGAR_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_1" },
      inputs: DEFAULT_BRANCH_INPUTS,
    });
  });

  it("submits the displayed model from replayed project defaults", async () => {
    mocks.sidebarNavigationReplayed = true;
    const submitted: NewThreadRequest[] = [];
    render(newThreadElement("proj_1", (request) => submitted.push(request)));
    act(() => latestPromptBoxProps().onChange("hello", []));

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      projectId: "proj_1",
      providerId: "codex",
      model: "gpt-5.6",
      reasoningLevel: "medium",
      permissionMode: "auto",
      executionInputSources: {
        providerId: "client-preference",
        model: "client-preference",
        reasoningLevel: "client-preference",
      },
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        inputs: {},
      },
    });
  });

  it("does not clear the root reuse selection after a plugin submission", async () => {
    render(
      <Provider>
        <MemoryRouter>
          <RootReuseProbe />
          <PluginNewThreadComposer
            draftKey="root-reuse-isolation"
            defaultProjectId={STORED_REQUEST.projectId}
            defaultProviderId={STORED_REQUEST.providerId}
            defaultModel={STORED_REQUEST.model}
            defaultReasoningLevel={STORED_REQUEST.reasoningLevel}
            defaultPermissionMode={STORED_REQUEST.permissionMode}
            defaultEnvironment={STORED_REQUEST.environment}
            initialPrompt="plugin prompt"
            onSubmit={() => undefined}
          />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByTestId("root-reuse-probe"));
    expect(screen.getByTestId("root-reuse-probe").dataset.value).toBe(
      "reuse:env-root",
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await submit();

    expect(screen.getByTestId("root-reuse-probe").dataset.value).toBe(
      "reuse:env-root",
    );
  });

  it("derives reuse options from the sidebar bootstrap so a fork keeps its seeded worktree", async () => {
    mocks.projectThreads = [
      makeThreadListEntry({
        id: "thr_source",
        projectId: "proj_1",
        environmentId: "env-source",
        environmentHostId: "host_1",
        environmentName: "source",
        environmentBranchName: "feature/source",
        queuedWork: "none",
        environmentProviderId: "git-worktree",
      }),
    ];
    const submitted: NewThreadRequest[] = [];
    render(
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId="proj_1"
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="new-thread"
            seed={{
              initialPrompt: "fork prompt",
              environment: {
                type: "reuse",
                environmentId: "env-source",
              },
            }}
            resetKey="thr_source"
            onSubmit={(request) => {
              submitted.push(request);
            }}
          >
            {(composer) => <ForkSeedSurface composer={composer} />}
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "reuse",
      environmentId: "env-source",
    });
  });

  it("opens a new-thread plugin panel from a command and reuses its tab", async () => {
    setPluginSlotRegistrations("panel-probe", {
      ...EMPTY_SLOT_REGISTRATIONS,
      newThreadPanelActions: [
        {
          id: "inspect-project",
          title: "Project inspector",
          component: () => null,
        },
      ],
    });
    window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

    const router = createMemoryRouter(
      [{ path: "/", element: <PanedRootComposeView /> }],
      { initialEntries: ["/"] },
    );

    const view = render(
      <Provider>
        <RouterProvider router={router} />
      </Provider>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().project.value).toBe("proj_1");
    });
    const accepted: boolean[] = [];

    const [command] = buildPluginPaletteActions({
      slots: [
        {
          pluginId: "panel-probe",
          target: "app",
          generation: 1,
          defaultShortcut: null,
          id: "inspect",
          title: "Inspect project",
          run: ({ openPanel }) => {
            accepted.push(
              openPanel({
                actionId: "inspect-project",
                title: "Inspect current project",
                params: { section: "changes" },
              }),
            );
          },
        },
      ],
      threadId: null,
      projectId: null,
      openThreadPanel: getActiveThreadPanelOpener(),
    });

    await act(async () => {
      command.run();
      command.run();
    });
    expect(accepted).toEqual([true, true]);

    const panel = parseFixedPanelTabsState({
      initialValue: createEmptyFixedPanelTabsState(),
      now: Date.now(),
      storedValue: window.localStorage.getItem(
        getFixedPanelTabsStateStorageKey({
          threadId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
        }),
      ),
    });

    expect(panel.secondary.isOpen).toBe(true);
    expect(panel.secondary.tabs).toEqual([
      expect.objectContaining({
        kind: "plugin-panel",
        pluginId: "panel-probe",
        actionId: "inspect-project",
        title: "Inspect current project",
        paramsJson: '{"section":"changes"}',
      }),
    ]);
    expect(panel.secondary.activeTabId).toBe(panel.secondary.tabs[0].id);
    view.unmount();
    expect(getActiveThreadPanelOpener()).toBeNull();
  });

  it("renders the root composer with a loading project picker before the sidebar bootstrap settles", () => {
    mocks.sidebarNavigationSettled = false;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

    const router = createMemoryRouter(
      [{ path: "/", element: <PanedRootComposeView /> }],
      { initialEntries: ["/"] },
    );

    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );

    expect(screen.getByTestId("new-thread-prompt-box")).toBeTruthy();
    expect(latestPromptBoxProps().project.isLoading).toBe(true);
    expect(mocks.promptHistoryQueryOptions.length).toBeGreaterThan(0);
    expect(
      mocks.promptHistoryQueryOptions.every(
        (options) => options?.enabled === false,
      ),
    ).toBe(true);
  });

  it("applies a plugin machine target after the root composer loads", async () => {
    mocks.sidebarNavigationSettled = false;
    window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

    const router = createMemoryRouter(
      [{ path: "/", element: <PanedRootComposeView /> }],
      {
        initialEntries: [
          {
            pathname: "/",
            state: { newEnvironmentHostId: "host_2", focusPrompt: true },
          },
        ],
      },
    );

    const element = () => (
      <Provider>
        <RouterProvider router={router} />
      </Provider>
    );

    const view = render(element());

    expect(router.state.location.state).toEqual({
      newEnvironmentHostId: "host_2",
      focusPrompt: true,
    });
    mocks.sidebarNavigationSettled = true;
    view.rerender(element());

    await waitFor(() => {
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_2");
      expect(router.state.location.state).toBeNull();
    });
    expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
      "provider:project-checkout",
    );

    const selectedIndex = mocks.promptBoxProps.findIndex(
      (props) =>
        props.modeConfig.environment.selectedProviderHostId === "host_2",
    );

    expect(selectedIndex).toBeGreaterThan(0);

    const focusRequestAtSelection =
      mocks.promptBoxProps[selectedIndex].focusRequest;

    await waitFor(() => {
      expect(latestPromptBoxProps().focusRequest).not.toBe(
        focusRequestAtSelection,
      );
    });
  });

  it("reuses an environment when the plugin supplies both targets", async () => {
    mocks.projectThreads = [
      makeThreadListEntry({
        id: "thr_existing",
        projectId: "proj_1",
        environmentId: "env_existing",
        environmentHostId: "host_1",
        environmentProviderId: "git-worktree",
      }),
    ];
    window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

    const router = createMemoryRouter(
      [{ path: "/", element: <PanedRootComposeView /> }],
      {
        initialEntries: [
          {
            pathname: "/",
            state: {
              newEnvironmentHostId: "host_2",
              reuseEnvironmentId: "env_existing",
            },
          },
        ],
      },
    );

    render(
      <Provider>
        <RouterProvider router={router} />
      </Provider>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        encodeReuseValue("env_existing"),
      );
      expect(router.state.location.state).toBeNull();
    });
  });

  it("closes visible plugin details before an underlying terminal", async () => {
    const terminal = createTerminalFixedPanelTab({
      terminalId: "terminal-under-details",
    });

    const state = createEmptyFixedPanelTabsState({ lastUsedAt: Date.now() });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({
        threadId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
      }),
      serializeFixedPanelTabsState({
        state: {
          ...state,
          secondary: {
            ...state.secondary,
            tabs: [terminal],
            activeTabId: terminal.id,
            isOpen: true,
          },
        },
      }),
    );
    window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const router = createMemoryRouter([
      { path: "/", element: <PanedRootComposeView /> },
    ]);

    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );
    act(() =>
      openPluginDetailsInWorkspace({ pluginId: "docs", title: "Docs" }),
    );
    const command = screen.getByRole("button", { name: "Close panel command" });
    expect(command.dataset.activeDetail).toBe("docs");
    fireEvent.click(command);
    expect(mocks.closeTerminal).not.toHaveBeenCalled();
    expect(command.dataset.activeDetail).toBe("");
    fireEvent.click(command);
    await waitFor(() =>
      expect(mocks.closeTerminal).toHaveBeenCalledWith({
        mode: "force",
        terminalId: "terminal-under-details",
      }),
    );
  });

  it("keeps a seeded fork's exact reuse selection while the sidebar bootstrap settles", async () => {
    mocks.sidebarNavigationSettled = false;
    const submitted: NewThreadRequest[] = [];

    const seed = {
      initialPrompt: "fork prompt",
      environment: { type: "reuse" as const, environmentId: "env-source" },
    };

    const onSubmit = (request: NewThreadRequest) => {
      submitted.push(request);
    };

    const element = () => (
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId="proj_1"
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="new-thread"
            seed={seed}
            resetKey="thr_source"
            onSubmit={onSubmit}
          >
            {(composer) => <ForkSeedSurface composer={composer} />}
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>
    );

    const { rerender } = render(element());

    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        encodeReuseValue("env-source"),
      );
    });
    expect(latestPromptBoxProps().modeConfig.worktree.options).toEqual([]);

    mocks.sidebarNavigationSettled = true;
    mocks.projectThreads = [
      makeThreadListEntry({
        id: "thr_source",
        projectId: "proj_1",
        environmentId: "env-source",
        environmentHostId: "host_1",
        environmentName: "source",
        environmentBranchName: "feature/source",
        queuedWork: "none",
        environmentProviderId: "git-worktree",
      }),
    ];
    rerender(element());

    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        encodeReuseValue("env-source"),
      );
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "reuse",
      environmentId: "env-source",
    });
  });

  it("enables the project picker and prompt-history query once the sidebar bootstrap settles", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

    const router = createMemoryRouter(
      [{ path: "/", element: <PanedRootComposeView /> }],
      { initialEntries: ["/"] },
    );

    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );

    expect(latestPromptBoxProps().project.isLoading).toBe(false);
    expect(mocks.promptHistoryQueryOptions.at(-1)?.enabled).toBe(true);
  });

  it.each(["proj_other_tab", PERSONAL_PROJECT_ID])(
    "ignores another tab selecting %s",
    async (remoteProjectId) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

      const router = createMemoryRouter(
        [{ path: "/", element: <PanedRootComposeView /> }],
        { initialEntries: ["/"] },
      );

      render(
        <Provider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </Provider>,
      );
      await waitFor(() => {
        expect(latestPromptBoxProps().project.value).toBe("proj_1");
      });
      const setItem = vi.spyOn(Storage.prototype, "setItem");

      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "omnyo.root-compose.project-id",
            oldValue: "proj_1",
            newValue: remoteProjectId,
            storageArea: window.localStorage,
          }),
        );
      });

      await waitFor(() => {
        expect(setItem).not.toHaveBeenCalledWith(
          "omnyo.root-compose.project-id",
          PERSONAL_PROJECT_ID,
        );
      });
      expect(latestPromptBoxProps().project.value).toBe("proj_1");
      setItem.mockRestore();
    },
  );

  it.each(["proj_1", PERSONAL_PROJECT_ID])(
    "retains inherited project %s when remounted after another tab changes the seed",
    async (inheritedProjectId) => {
      const mountRoot = () => {
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });

        const router = createMemoryRouter(
          [{ path: "/", element: <PanedRootComposeView /> }],
          { initialEntries: ["/"] },
        );

        return render(
          <Provider>
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </Provider>,
        );
      };

      window.localStorage.setItem(
        "omnyo.root-compose.project-id",
        inheritedProjectId,
      );
      const first = mountRoot();
      await waitFor(() => {
        expect(latestPromptBoxProps().project.value).toBe(
          inheritedProjectId === PERSONAL_PROJECT_ID
            ? null
            : inheritedProjectId,
        );
      });
      first.unmount();

      const remoteProjectId =
        inheritedProjectId === "proj_1" ? PERSONAL_PROJECT_ID : "proj_1";

      window.localStorage.setItem(
        "omnyo.root-compose.project-id",
        remoteProjectId,
      );
      mountRoot();
      await waitFor(() => {
        expect(latestPromptBoxProps().project.value).toBe(
          inheritedProjectId === PERSONAL_PROJECT_ID
            ? null
            : inheritedProjectId,
        );
      });
      expect(
        window.sessionStorage.getItem("omnyo.root-compose.project-id"),
      ).toBe(inheritedProjectId);
      expect(window.localStorage.getItem("omnyo.root-compose.project-id")).toBe(
        remoteProjectId,
      );
    },
  );

  it("applies a replacing initial prompt from location state exactly once", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");
    const rootDraft = getPromptDraftAccessor({ kind: "new-thread" });
    rootDraft.setDraft({
      text: "leftover draft",
      mentions: [],
      attachments: [],
    });

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const router = createMemoryRouter(
      [{ path: "/", element: <PanedRootComposeView /> }],
      {
        initialEntries: [
          {
            pathname: "/",
            state: {
              focusPrompt: true,
              initialPrompt: "Create a kanban plugin",
              replaceInitialPrompt: true,
            },
          },
        ],
      },
    );

    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe("Create a kanban plugin");
    });
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    expect(rootDraft.getCurrent().text).toBe("Create a kanban plugin");

    const updateDepthErrors = consoleError.mock.calls.filter((call) =>
      call.some(
        (argument) =>
          typeof argument === "string" &&
          argument.includes("Maximum update depth exceeded"),
      ),
    );

    consoleError.mockRestore();
    expect(updateDepthErrors).toEqual([]);
  });

  describe("a prompt in the address", () => {
    const OFFER = { name: "Use this prompt?" };

    function mountRootAt(entry: string) {
      window.localStorage.setItem("omnyo.root-compose.project-id", "proj_1");

      const router = createMemoryRouter(
        [{ path: "/", element: <PanedRootComposeView /> }],
        { initialEntries: [entry] },
      );

      render(
        <Provider>
          <RouterProvider router={router} />
        </Provider>,
      );

      return router;
    }

    function setRootDraftText(text: string) {
      getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
        text,
        mentions: [],
        attachments: [],
      });
    }

    function rootDraftText(): string {
      return getPromptDraftAccessor({ kind: "new-thread" }).getCurrent().text;
    }

    it("is offered without changing the draft or the address", async () => {
      setRootDraftText("my own draft");

      const router = mountRootAt(
        "/?ref=share&initialPrompt=Delete%20every%20branch",
      );

      const offer = await screen.findByRole("region", OFFER);

      expect(offer.textContent).toContain("Delete every branch");
      expect(rootDraftText()).toBe("my own draft");
      expect(latestPromptBoxProps().value).toBe("my own draft");
      expect(router.state.location.search).toBe(
        "?ref=share&initialPrompt=Delete%20every%20branch",
      );
    });

    it("is added after the owner's draft when used, then leaves the address", async () => {
      setRootDraftText("my own draft");
      const router = mountRootAt("/?ref=share&initialPrompt=Look%20at%20this");

      fireEvent.click(await screen.findByRole("button", { name: "Use" }));

      await waitFor(() => {
        expect(router.state.location.search).toBe("?ref=share");
      });
      expect(rootDraftText()).toBe("my own draft\n\nLook at this");
      expect(screen.queryByRole("region", OFFER)).toBeNull();
    });

    it("fills an empty draft when used", async () => {
      const router = mountRootAt("/?initialPrompt=Look%20at%20this");

      fireEvent.click(await screen.findByRole("button", { name: "Use" }));

      await waitFor(() => {
        expect(latestPromptBoxProps().value).toBe("Look at this");
      });
      expect(router.state.location.search).toBe("");
      expect(rootDraftText()).toBe("Look at this");
    });

    it("leaves the draft alone when dismissed, then leaves the address", async () => {
      setRootDraftText("my own draft");

      const router = mountRootAt(
        "/?ref=share&initialPrompt=Delete%20every%20branch",
      );

      fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

      await waitFor(() => {
        expect(router.state.location.search).toBe("?ref=share");
      });
      expect(rootDraftText()).toBe("my own draft");
      expect(screen.queryByRole("region", OFFER)).toBeNull();
    });
  });

  it("ignores a repeated submit while the first submission is pending", async () => {
    let finishSubmit: (() => void) | null = null;

    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSubmit = resolve;
        }),
    );

    renderComposer(STORED_REQUEST, onSubmit, "repeated-submit");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    act(() => {
      latestPromptBoxProps().onSubmit();
      latestPromptBoxProps().onSubmit();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestPromptBoxProps().value).toBe("");

    await act(async () => {
      finishSubmit?.();
    });
  });

  it("accepts a second new draft before the first remote submission settles", async () => {
    const first = createDeferredPromise<void>();

    const onSubmit = vi
      .fn<(request: NewThreadRequest) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);

    renderComposer(STORED_REQUEST, onSubmit, "overlapping-new-threads");
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));

    act(() => latestPromptBoxProps().onSubmit());
    act(() => latestPromptBoxProps().onChange("next thread", []));
    act(() => latestPromptBoxProps().onSubmit());

    expect(onSubmit.mock.calls.map(([request]) => request.input)).toEqual([
      STORED_REQUEST.input,
      [{ type: "text", text: "next thread", mentions: [] }],
    ]);
    expect(latestPromptBoxProps().value).toBe("");

    await act(async () => first.resolve());
  });

  it("submits a concrete seeded model while its catalog is still loading", async () => {
    mocks.modelsLoading = true;
    const onSubmit = vi.fn();

    renderComposer(STORED_REQUEST, onSubmit, "cached-model-submit");
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        model: STORED_REQUEST.model,
        environment: STORED_REQUEST.environment,
        executionInputSources: expect.objectContaining({ model: "explicit" }),
      }),
    );
  });

  it("accepts two followups in the provisional chat and recovers a later failure to its real destination", async () => {
    const creation = createDeferredPromise<ThreadResponse>();
    const preparing = createDeferredPromise<void>();
    const firstSend = createDeferredPromise<void>();
    const secondSend = createDeferredPromise<void>();
    const create = vi.fn(() => creation.promise);

    const send = vi
      .fn()
      .mockReturnValueOnce(firstSend.promise)
      .mockReturnValueOnce(secondSend.promise);

    const request: NewThreadComposerSubmission = STORED_REQUEST;

    const pending = createPendingChat({
      queueOwner: {},
      request,
      create,
      send,
      renderer: PendingThreadChat,
      prepare: () => preparing.promise,
    });

    const view = render(
      <Provider>
        <MemoryRouter>
          <DefaultPaneContextProvider
            onRequestClose={null}
            navigateInPane={() => {}}
          >
            <PendingThreadChat pendingId={pending.id} />
          </DefaultPaneContextProvider>
        </MemoryRouter>
      </Provider>,
    );

    act(() => latestPromptBoxProps().onChange("followup one", []));
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));
    act(() => latestPromptBoxProps().onSubmit());
    act(() => latestPromptBoxProps().onChange("followup two", []));
    act(() => latestPromptBoxProps().onSubmit());

    expect(getPendingChatSnapshot(pending.id)?.messages).toHaveLength(3);
    expect(screen.getByText("review every PR for slop")).toBeTruthy();
    expect(screen.getByText("followup one")).toBeTruthy();
    expect(screen.getByText("followup two")).toBeTruthy();
    expect(latestPromptBoxProps().value).toBe("");
    expect(send).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();

    await act(async () => {
      creation.resolve(
        makeThreadResponse({
          id: "real-provisional-chat",
          projectId: request.projectId,
        }),
      );
      await pending.completion;
    });
    expect(send.mock.calls.map(([sent]) => sent.id)).toEqual([
      "real-provisional-chat",
      "real-provisional-chat",
    ]);
    expect(getPendingChatSnapshot(pending.id)?.messages).toHaveLength(3);
    view.unmount();

    const realDraft = getPromptDraftAccessor({
      kind: "thread",
      projectId: request.projectId,
      threadId: "real-provisional-chat",
    });

    realDraft.setTextAndMentions("newer real draft", []);

    await act(async () => {
      firstSend.reject(new Error("connection lost"));
      secondSend.resolve();
      preparing.resolve();
    });
    await waitFor(() =>
      expect(realDraft.getCurrent().text).toBe(
        "newer real draft\n\nfollowup one",
      ),
    );
    expect(
      getPromptDraftAccessor({
        kind: "thread",
        projectId: request.projectId,
        threadId: pending.id,
      }).getCurrent().text,
    ).toBe("");
  });

  it("submits a captured transcript with its original selection without replacing the next draft", async () => {
    const onSubmit = vi
      .fn<(request: NewThreadRequest) => Promise<void>>()
      .mockResolvedValue(undefined);

    const view = renderComposer(STORED_REQUEST, onSubmit, "captured-voice");
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));

    const capturedHost: PluginComposerHost =
      latestPromptBoxProps().pluginComposerHost;

    view.rerender(
      composerElement(
        { ...STORED_REQUEST, projectId: "proj_2", model: "gpt-5.6" },
        onSubmit,
        "captured-voice",
      ),
    );
    act(() => latestPromptBoxProps().onChange("next typed draft", []));
    await act(async () => {
      await capturedHost.submitDraft?.(
        { text: "captured transcript", mentions: [], attachments: [] },
        { experimental_data: null },
        undefined,
      );
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: STORED_REQUEST.projectId,
        model: STORED_REQUEST.model,
        environment: STORED_REQUEST.environment,
        input: [{ type: "text", text: "captured transcript", mentions: [] }],
      }),
    );
    expect(latestPromptBoxProps().value).toBe("next typed draft");
  });

  it("restores the optimistically cleared draft when submission fails", async () => {
    let failSubmit: (() => void) | null = null;

    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSubmit = () => reject(new Error("create failed"));
        }),
    );

    renderComposer(STORED_REQUEST, onSubmit, "failed-submit");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    act(() => latestPromptBoxProps().onSubmit());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(latestPromptBoxProps().value).toBe("");
    await act(async () => {
      failSubmit?.();
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().isSubmitting).toBe(false);
    });
    expect(latestPromptBoxProps().value).toBe("review every PR for slop");
  });

  it("preserves a new draft and recovers the failed submission after it", async () => {
    let failSubmit: (() => void) | null = null;

    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSubmit = () => reject(new Error("create failed"));
        }),
    );

    renderComposer(STORED_REQUEST, onSubmit, "failed-submit-new-draft");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    act(() => latestPromptBoxProps().onSubmit());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(latestPromptBoxProps().value).toBe("");
    act(() => latestPromptBoxProps().onChange("next thread", []));
    await act(async () => {
      failSubmit?.();
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().isSubmitting).toBe(false);
    });
    expect(latestPromptBoxProps().value).toBe(
      "next thread\n\nreview every PR for slop",
    );
  });

  it("accepts overlapping uploads and stays busy until every batch settles", async () => {
    const first = createDeferredPromise<PromptDraftAttachment>();
    const second = createDeferredPromise<PromptDraftAttachment>();
    mocks.uploadAttachment
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderComposer(STORED_REQUEST, vi.fn(), "concurrent-uploads");
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));

    let firstBatch: Promise<void>;
    let secondBatch: Promise<void>;
    act(() => {
      const attach = latestPromptBoxProps().attachments.onAttachFiles;
      firstBatch = attach([new File(["first"], "first.txt")]);
      secondBatch = attach([new File(["second"], "second.txt")]);
    });
    expect(mocks.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(latestPromptBoxProps().attachments.pendingUploads).toHaveLength(2);
    expect(latestPromptBoxProps().attachments.isAttaching).toBe(true);

    await act(async () => {
      second.resolve({
        type: "localFile",
        name: "second.txt",
        path: "second.txt",
        sizeBytes: 6,
      });
      await secondBatch;
    });
    expect(latestPromptBoxProps().attachments.items).toHaveLength(1);
    expect(latestPromptBoxProps().attachments.pendingUploads).toHaveLength(1);
    expect(latestPromptBoxProps().attachments.isAttaching).toBe(true);
    await act(async () => {
      await latestPromptBoxProps().project.onChange("proj_2");
    });
    expect(latestPromptBoxProps().project.value).toBe("proj_1");

    await act(async () => {
      first.reject(new Error("Failed to fetch"));
      await firstBatch;
    });
    expect(latestPromptBoxProps().attachments.isAttaching).toBe(false);
    expect(latestPromptBoxProps().attachments.pendingUploads).toHaveLength(1);
    expect(latestPromptBoxProps().attachments.pendingUploads[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        retry: expect.any(Function),
      }),
    );
    expect(latestPromptBoxProps().attachments.items).toHaveLength(1);
    expect(latestPromptBoxProps().attachments.error).toContain("first.txt");
  });

  it("accepts a file-only draft while upload waits and keeps the next draft usable", async () => {
    const upload = createDeferredPromise<PromptDraftAttachment>();
    mocks.uploadAttachment.mockReturnValue(upload.promise);
    const onSubmit = vi.fn();
    renderComposer(STORED_REQUEST, onSubmit, "accepted-pending-upload");
    await waitFor(() => expect(latestPromptBoxProps().disabled).toBe(false));
    act(() => latestPromptBoxProps().onChange("", []));
    let attaching!: Promise<PromptDraftAttachment[]>;
    act(() => {
      attaching = latestPromptBoxProps().attachments.onAttachFiles([
        new File(["file"], "notes.txt"),
      ]);
    });
    expect(latestPromptBoxProps().disabled).toBe(false);
    act(() => latestPromptBoxProps().onSubmit());
    expect(latestPromptBoxProps().attachments.pendingUploads).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => latestPromptBoxProps().onChange("next draft", []));
    expect(latestPromptBoxProps().disabled).toBe(false);

    await act(async () => {
      upload.resolve({
        type: "localFile",
        name: "notes.txt",
        path: ".omnyo/attachments/notes.txt",
        sizeBytes: 4,
      });
      await attaching;
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0].input).toEqual([
      expect.objectContaining({
        type: "localFile",
        path: ".omnyo/attachments/notes.txt",
      }),
    ]);
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("capturedUploads");
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("prepareInput");
    expect(latestPromptBoxProps().value).toBe("next draft");
    expect(latestPromptBoxProps().attachments.items).toHaveLength(0);
  });

  it("keeps the old project when attachment copying fails", async () => {
    mocks.uploadAttachment.mockResolvedValue({
      type: "localFile",
      name: "notes.txt",
      path: ".omnyo/attachments/notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    mocks.copyAttachments.mockRejectedValue(new Error("copy failed"));
    renderComposer(STORED_REQUEST, vi.fn(), "copy-failure");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await act(async () => {
      await latestPromptBoxProps().attachments.onAttachFiles([
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ]);
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().attachments.items).toHaveLength(1);
    });
    await act(async () => {
      await latestPromptBoxProps().project.onChange("proj_2");
    });

    expect(mocks.copyAttachments).toHaveBeenCalledWith({
      projectId: "proj_2",
      sourceProjectId: "proj_1",
      paths: [".omnyo/attachments/notes.txt"],
    });
    expect(latestPromptBoxProps().project.value).toBe("proj_1");
    expect(latestPromptBoxProps().attachments.items).toHaveLength(1);
  });
});

const SANDBOX_PROVIDER: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "container",
  displayName: "Docker container",
  description: "Prepare a workspace for this thread.",
  icon: "Container",
  logoUrl: null,
  pluginId: "docker-sandbox",
  acceptsEmptyInputs: false,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: {
    type: "object",
    properties: { image: { type: "string" } },
    required: ["image"],
  },
};

const OPTIONAL_INPUTS_PROVIDER: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "optional-sandbox",
  displayName: "Optional sandbox",
  description: "Prepare a workspace for this thread.",
  icon: "Container",
  logoUrl: null,
  pluginId: "optional-sandbox",
  acceptsEmptyInputs: true,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: {
    type: "object",
    properties: { image: { type: "string" } },
  },
};

const BRANCH_PROVIDER: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "branchy",
  displayName: "New branch workspace",
  description: "Prepare a workspace for this thread.",
  icon: "GitBranch",
  logoUrl: null,
  pluginId: "branchy",
  acceptsEmptyInputs: true,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

const HOST_PROVIDER: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "hosted",
  displayName: "Machine sandbox",
  description: "Prepare a workspace for this thread.",
  icon: "Server",
  logoUrl: null,
  pluginId: "hosted",
  acceptsEmptyInputs: true,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

const PROJECT_WITHOUT_CHECKOUT = {
  ...PROJECT,
  id: "proj_no_checkout",
  name: "Project Without Checkout",
  sources: [],
};

describe("NewThreadComposer environment providers", () => {
  beforeEach(() => {
    mocks.promptBoxProps.length = 0;
    mocks.projectThreads = [];
    mocks.sidebarNavigationSettled = true;
    mocks.sidebarNavigationReplayed = false;
    mocks.extraProjects = [];
    mocks.hosts = mocks.defaultHosts;
    mocks.plugins = [];
    mocks.serverAccessReady = true;
    mocks.machineProviders = [];
    mocks.environmentProviders = [CHECKOUT_PROVIDER];
    resetPluginSlotStoreForTest();
    registerCheckoutInputsControl();
    window.localStorage.clear();
    window.sessionStorage.clear();
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderUnseeded(
    onSubmit: (request: NewThreadRequest) => void,
    draftKey: string,
    projectId = "proj_1",
  ) {
    return render(
      <MemoryRouter>
        <LocationProbe />
        <PluginNewThreadComposer
          draftKey={draftKey}
          defaultProjectId={projectId}
          initialPrompt="run in the sandbox"
          onSubmit={onSubmit}
        />
      </MemoryRouter>,
    );
  }

  it.each([
    CHECKOUT_PROVIDER,
    MANAGED_WORKTREE_SUGAR_PROVIDER,
    {
      ...BRANCH_PROVIDER,
      requires: { ...BRANCH_PROVIDER.requires, projectCheckout: false },
    },
  ])(
    "omits $displayName on machines without this project's checkout",
    async (provider) => {
      mocks.environmentProviders = [provider, HOST_PROVIDER];
      const submitted: NewThreadRequest[] = [];
      renderUnseeded(
        (request) => submitted.push(request),
        "checkout-eligibility",
        OTHER_PROJECT.id,
      );
      await waitFor(() => {
        const byHost =
          latestPromptBoxProps().modeConfig.environment.providersByHostId;

        expect(
          byHost
            ?.get("host_1")
            .map((item: SystemEnvironmentProvider) => item.id),
        ).toEqual([provider.id, HOST_PROVIDER.id]);
        expect(
          byHost
            ?.get("host_2")
            .map((item: SystemEnvironmentProvider) => item.id),
        ).toEqual([HOST_PROVIDER.id]);
      });
      await act(async () => {
        latestPromptBoxProps().modeConfig.environment.onSelectProvider(
          provider,
          "host_2",
        );
      });
      expect(latestPromptBoxProps().disabled).toBe(true);
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_2");
      await submit();
      expect(submitted).toHaveLength(0);
      await act(async () => {
        latestPromptBoxProps().modeConfig.environment.onSelectProvider(
          HOST_PROVIDER,
          "host_2",
        );
      });
      await submit();
      expect(submitted[0].environment).toMatchObject({
        machine: { type: "existing", hostId: "host_2" },
      });
    },
  );

  it("blocks an explicit machine when its checkout disappears and recovers on a valid choice", async () => {
    const project = {
      ...PROJECT_WITHOUT_CHECKOUT,
      sources: [...PROJECT.sources],
    };

    mocks.extraProjects = [project];
    mocks.environmentProviders = [BRANCH_PROVIDER];
    const onSubmit = vi.fn();

    renderUnseeded(onSubmit, "checkout-disappears", project.id);

    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        BRANCH_PROVIDER,
        "host_2",
      );
    });
    expect(latestPromptBoxProps().disabled).toBe(false);
    await publishServerData(() => {
      mocks.extraProjects = [{ ...project, sources: [PROJECT.sources[0]] }];
    });
    expect(latestPromptBoxProps().disabled).toBe(true);
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_2");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        BRANCH_PROVIDER,
        "host_1",
      );
    });
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          machine: { type: "existing", hostId: "host_1" },
        }),
      }),
    );
  });

  it("uses per-machine availability without blocking a pending probe", async () => {
    const provider = {
      ...BRANCH_PROVIDER,
      machineAvailability: {
        host_1: null,
        host_2: {
          status: "unavailable" as const,
          message: "Checkout is unavailable",
        },
      },
    };

    mocks.environmentProviders = [provider];
    const onSubmit = vi.fn();
    renderUnseeded(onSubmit, "machine-availability");
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        provider,
        "host_2",
      );
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.providersByHostId.get(
        "host_2",
      )[0].availability,
    ).toEqual(provider.machineAvailability.host_2);
    expect(latestPromptBoxProps().disabled).toBe(true);
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        provider,
        "host_1",
      );
    });
    expect(latestPromptBoxProps().disabled).toBe(false);
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("updates the access banner for a composed machine without relying on plugin status", async () => {
    const composition: SystemEnvironmentProvider = {
      ...OPTIONAL_INPUTS_PROVIDER,
      machineProviderId: "qa-machine",
      machineInputs: null,
      machineAcceptsEmptyInputs: true,
    };

    mocks.environmentProviders = [CHECKOUT_PROVIDER, composition];
    mocks.machineProviders = [
      {
        id: "qa-machine",
        displayName: "QA machine",
        description: "Test machine",
        icon: "Server",
        logoUrl: null,
        pluginId: "qa",
        inputs: null,
        acceptsEmptyInputs: true,
        supportsSuspend: false,
      },
    ];
    mocks.serverAccessReady = false;
    const onSubmit = vi.fn();
    renderUnseeded(onSubmit, "live-access");
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        composition,
        null,
      );
    });
    await screen.findByText("Pair with Omnyo connect");
    expect(latestPromptBoxProps().disabled).toBe(true);
    await publishServerData(() => {
      mocks.serverAccessReady = true;
    });
    await waitFor(() =>
      expect(screen.queryByText("Pair with Omnyo connect")).toBeNull(),
    );
    expect(latestPromptBoxProps().disabled).toBe(false);
    await publishServerData(() => {
      mocks.serverAccessReady = false;
    });
    await screen.findByText("Pair with Omnyo connect");
    expect(latestPromptBoxProps().disabled).toBe(true);
  });

  it("submits the value the provider's configuration slot produced", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    setPluginSlotRegistrations("docker-sandbox", {
      ...EMPTY_SLOT_REGISTRATIONS,
      environmentProviderInputs: [
        {
          environmentProviderId: "container",
          component: ({ target, onChange }) => (
            <button
              type="button"
              data-testid="set-provider-config"
              data-target={JSON.stringify(target)}
              onClick={() =>
                onChange({ status: "ready", value: { image: "img-chosen" } })
              }
            >
              choose
            </button>
          ),
        },
      ],
    });
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-inputs");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:container",
      );
      expect(screen.getByTestId("set-provider-config")).toBeTruthy();
    });
    expect(latestPromptBoxProps().disabled).toBe(true);
    expect(
      JSON.parse(
        screen.getByTestId("set-provider-config").getAttribute("data-target")!,
      ),
    ).toEqual({ kind: "existing-host", hostId: "host_1" });
    fireEvent.click(screen.getByTestId("set-provider-config"));
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "container",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { image: "img-chosen" },
      machineChoice: "default",
    });
  });

  it("blocks a provider that declares inputs when its plugin registered no control", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-missing-control");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.inputsControlProviderIds,
    ).toEqual(new Set(["project-checkout"]));
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(true);
    });
    expect(latestPromptBoxProps().disabledReason).toBe(
      "Docker container needs its plugin's control",
    );
    await expect(submit()).resolves.toBeUndefined();
    expect(submitted).toHaveLength(0);
  });

  it("ignores a control registered by a plugin that does not own the provider", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    setPluginSlotRegistrations("impostor", {
      ...EMPTY_SLOT_REGISTRATIONS,
      environmentProviderInputs: [
        {
          environmentProviderId: "container",
          component: ({ onChange }) => (
            <button
              type="button"
              data-testid="impostor-provider-config"
              onClick={() =>
                onChange({ status: "ready", value: { image: "img-impostor" } })
              }
            >
              choose
            </button>
          ),
        },
      ],
    });
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-impostor-control");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.inputsControlProviderIds,
    ).toEqual(new Set(["project-checkout"]));
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(true);
    });
    expect(latestPromptBoxProps().disabledReason).toBe(
      "Docker container needs its plugin's control",
    );
    expect(screen.queryByTestId("impostor-provider-config")).toBe(null);
    await expect(submit()).resolves.toBeUndefined();
    expect(submitted).toHaveLength(0);
  });

  it("submits empty inputs for a provider whose schema requires nothing and has no control", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, OPTIONAL_INPUTS_PROVIDER];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-optional-inputs");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        OPTIONAL_INPUTS_PROVIDER,
        null,
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:optional-sandbox",
      );
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "optional-sandbox",
      machine: { type: "existing", hostId: "host_1" },
      inputs: {},
      machineChoice: "default",
    });
  });

  it("shows the plugin's blocked reason and prevents submit", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    setPluginSlotRegistrations("docker-sandbox", {
      ...EMPTY_SLOT_REGISTRATIONS,
      environmentProviderInputs: [
        {
          environmentProviderId: "container",
          component: ({ onChange }) => (
            <button
              type="button"
              data-testid="clear-provider-config"
              onClick={() =>
                onChange({
                  status: "blocked",
                  reason: "Choose a container image",
                })
              }
            >
              clear
            </button>
          ),
        },
      ],
    });
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-incomplete-config");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("clear-provider-config")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("clear-provider-config"));

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(true);
    });
    expect(latestPromptBoxProps().disabledReason).toBe(
      "Choose a container image",
    );
    await expect(submit()).resolves.toBeUndefined();
    expect(submitted).toHaveLength(0);
  });

  it("lets a host provider without gitCheckout use a machine that has no project checkout", async () => {
    mocks.environmentProviders = [
      CHECKOUT_PROVIDER,
      HOST_PROVIDER,
      BRANCH_PROVIDER,
    ];
    mocks.extraProjects = [PROJECT_WITHOUT_CHECKOUT];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded(
      (request) => {
        submitted.push(request);
      },
      "host-provider-no-checkout",
      PROJECT_WITHOUT_CHECKOUT.id,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().project.value).toBe(
        PROJECT_WITHOUT_CHECKOUT.id,
      );
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        BRANCH_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:branchy",
      );
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_1");
    expect(latestPromptBoxProps().disabled).toBe(true);

    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        HOST_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:hosted",
      );
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_1");
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "hosted",
      machine: { type: "existing", hostId: "host_1" },
      inputs: null,
    });
  });

  it("submits a gitCheckout provider without inputs with the row's machine and no branch picker", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, BRANCH_PROVIDER];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "branch-provider-row");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        BRANCH_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:branchy",
      );
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_1");
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "branchy",
      machine: { type: "existing", hostId: "host_1" },
      inputs: null,
    });
  });
});

describe("NewThreadComposer setSelection", () => {
  beforeEach(() => {
    resetFixedPanelTabsStateForTest();
    mocks.promptBoxProps.length = 0;
    mocks.promptHistoryQueryOptions.length = 0;
    mocks.copyAttachments.mockReset();
    mocks.uploadAttachment.mockReset();
    mocks.projectThreads = [];
    mocks.sidebarNavigationSettled = true;
    mocks.sidebarNavigationReplayed = false;
    mocks.extraProjects = [];
    mocks.hosts = mocks.defaultHosts;
    mocks.plugins = [];
    mocks.serverAccessReady = true;
    mocks.machineProviders = [];
    mocks.modelsLoading = false;
    mocks.permissionCeiling = undefined;
    mocks.environmentProviders = [
      CHECKOUT_PROVIDER,
      MANAGED_WORKTREE_SUGAR_PROVIDER,
      PERSONAL_WORKSPACE_PROVIDER,
    ];
    resetPluginSlotStoreForTest();
    registerWorktreeInputsControl();
    registerCheckoutInputsControl();
    window.localStorage.clear();
    window.sessionStorage.clear();
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  afterEach(() => {
    cleanup();
    setComposerSelectionSettleTimeoutForTest(null);
    vi.restoreAllMocks();
  });

  function RootLikeComposer({
    initialProjectId,
    lockProvider,
    onSubmit,
  }: {
    initialProjectId: string;
    lockProvider: boolean;
    onSubmit: (request: NewThreadRequest) => void;
  }) {
    const [projectId, setProjectId] = useState(initialProjectId);

    return (
      <NewThreadComposer
        projectId={projectId}
        onProjectChange={setProjectId}
        draftStorage={{ kind: "new-thread" }}
        selectionScope="new-thread"
        onSubmit={onSubmit}
      >
        {(composer) =>
          composer.renderPromptBox({
            mentionMenuPlacement: "bottom",
            ...(lockProvider ? { locks: { provider: true } } : {}),
          })
        }
      </NewThreadComposer>
    );
  }

  function rootLikeElement(
    projectId: string,
    lockProvider = false,
    onSubmit: (request: NewThreadRequest) => void = () => undefined,
  ) {
    return (
      <Provider>
        <MemoryRouter>
          <RootLikeComposer
            initialProjectId={projectId}
            lockProvider={lockProvider}
            onSubmit={onSubmit}
          />
        </MemoryRouter>
      </Provider>
    );
  }

  function executionTransitions(fromRender: number) {
    return mocks.promptBoxProps.slice(fromRender).map((props) => ({
      providerId: String(props.execution.provider.selectedId),
      model: String(props.execution.model.selected),
      reasoningLevel: String(props.execution.reasoning.value),
    }));
  }

  function expectSingleExecutionTransition(fromRender: number) {
    const transitions = executionTransitions(fromRender);

    const landed = transitions.filter(
      ({ providerId }) => providerId === "claude-code",
    );

    expect(landed.length).toBeGreaterThan(0);
    expect(
      landed.filter(
        ({ model, reasoningLevel }) =>
          model !== "gpt-5.6-sol" || reasoningLevel !== "high",
      ),
    ).toEqual([]);
    expect(
      transitions.filter(
        ({ providerId, model }) =>
          providerId === "codex" && model === "gpt-5.6-sol",
      ),
    ).toEqual([]);
  }

  function currentHost(): PluginComposerHost {
    const host = latestPromptBoxProps()
      .pluginComposerHost as PluginComposerHost;

    expect(host.setSelection).toBeDefined();

    return host;
  }

  it("tracks values changed through the visible model picker", async () => {
    render(rootLikeElement("proj_1"));
    const host = currentHost();
    const initial = host.getSelection?.();
    act(() => latestPromptBoxProps().execution.model.onChange("gpt-5.6-sol"));
    await waitFor(() => {
      expect(host.getSelection?.()?.model).toBe("gpt-5.6-sol");
    });
    expect(host.getSelection?.()).not.toBe(initial);
    expect(host.getSelection?.()?.projectId).toBe("proj_1");
  });

  async function settled(
    promise: Promise<ExperimentalComposerSelection>,
    timeout = 1_000,
  ): Promise<ExperimentalComposerSelection> {
    let result: ExperimentalComposerSelection | null = null;
    let failure: unknown = null;
    void promise.then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        failure = error;
      },
    );
    await waitFor(
      () => {
        expect(result !== null || failure !== null).toBe(true);
      },
      { timeout },
    );

    if (failure !== null) throw failure;

    return result as unknown as ExperimentalComposerSelection;
  }

  it("switches the project first and remembers the environment and machine for the new project", async () => {
    render(rootLikeElement("proj_2"));
    expect(latestPromptBoxProps().project.value).toBe("proj_2");
    const host = currentHost();

    const result = await settled(
      host.setSelection!({
        projectId: "proj_1",
        environment: {
          type: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId: "host_2" },
          inputs: null,
        },
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(host.getSelection?.()).toEqual(result);
    expect(result.environment).toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_2" },
      inputs: DEFAULT_BRANCH_INPUTS,
    });
    expect(latestPromptBoxProps().project.value).toBe("proj_1");
    expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
      "provider:git-worktree",
    );
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBe("host_2");
    expect(latestPromptBoxProps().pluginComposerHost.scope).toEqual({
      kind: "new-thread",
      projectId: "proj_1",
    });
    expect(
      window.localStorage.getItem("omnyo.promptbox.environment-proj_1-1"),
    ).toBe("provider:git-worktree");
    expect(
      window.localStorage.getItem("omnyo.promptbox.machine-proj_1-1"),
    ).toBe("host_2");
    expect(
      window.localStorage.getItem("omnyo.promptbox.environment-proj_2-1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("omnyo.promptbox.machine-proj_2-1"),
    ).toBeNull();
  });

  it("applies a host workspace path through setSelection, and a second path replaces it", async () => {
    const submitted = vi.fn<(request: NewThreadRequest) => void>();
    render(rootLikeElement("proj_1", false, submitted));
    const host = currentHost();

    const pathSelection = (path: string): ExperimentalComposerSelection => ({
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: { type: "unmanaged", path },
      },
    });

    const first = await settled(
      host.setSelection!(pathSelection("/repo/.worktrees/alpha")),
    );

    expect(first.environment).toEqual({
      type: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { path: "/repo/.worktrees/alpha" },
    });

    const second = await settled(
      host.setSelection!(pathSelection("/repo/.worktrees/beta")),
    );

    expect(second.environment).toEqual({
      type: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { path: "/repo/.worktrees/beta" },
    });
    await act(async () => {
      getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
        text: "work in beta",
        mentions: [],
        attachments: [],
      });
    });
    await submit();
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({ environment: second.environment }),
    );
  });

  it("still ignores raw provider inputs passed to setSelection", async () => {
    render(rootLikeElement("proj_1"));
    const host = currentHost();

    const result = await settled(
      host.setSelection!({
        environment: {
          type: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId: "host_1" },
          inputs: { branch: { kind: "named", name: "release" } },
        },
      }),
    );

    expect(result.environment).toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_1" },
      inputs: DEFAULT_BRANCH_INPUTS,
    });
  });

  it("leaves the project alone when a copy or upload is in flight, and still applies the rest", async () => {
    mocks.copyAttachments.mockReturnValue(new Promise(() => {}));
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "with a file",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 12,
        },
      ],
    });
    render(rootLikeElement("proj_1"));
    const host = currentHost();
    void latestPromptBoxProps().project.onChange("proj_2");
    await waitFor(() => {
      expect(mocks.copyAttachments).toHaveBeenCalledTimes(1);
    });

    const result = await settled(
      host.setSelection!({ projectId: "proj_2", permissionMode: "full" }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.permissionMode).toBe("full");
    expect(mocks.copyAttachments).toHaveBeenCalledTimes(1);
  });

  it("does not apply another project's environment when the project change is refused", async () => {
    mocks.copyAttachments.mockReturnValue(new Promise(() => {}));
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "with a file",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 12,
        },
      ],
    });
    render(rootLikeElement("proj_1"));
    const host = currentHost();

    const environmentBefore =
      latestPromptBoxProps().modeConfig.environment.value;

    void latestPromptBoxProps().project.onChange("proj_2");
    await waitFor(() => {
      expect(mocks.copyAttachments).toHaveBeenCalledTimes(1);
    });

    const result = await settled(
      host.setSelection!({
        projectId: "proj_2",
        environment: {
          type: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId: "host_2" },
          inputs: null,
        },
        permissionMode: "full",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.permissionMode).toBe("full");
    expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
      environmentBefore,
    );
    expect(
      window.localStorage.getItem("omnyo.promptbox.environment-proj_1-1"),
    ).not.toBe("provider:git-worktree");
    expect(
      window.localStorage.getItem("omnyo.promptbox.machine-proj_1-1"),
    ).not.toBe("host_2");
  });

  it("reports reconciled values instead of the requested ones", async () => {
    mocks.permissionCeiling = "auto";
    render(rootLikeElement("proj_1"));

    const result = await settled(
      currentHost().setSelection!({
        model: "gpt-5.6-sol",
        reasoningLevel: "low",
        permissionMode: "full",
      }),
    );

    expect(result).toMatchObject({
      projectId: "proj_1",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "medium",
      permissionMode: "auto",
    });
    expect(result.serviceTier).toBeUndefined();
    expect(latestPromptBoxProps().execution.model.selected).toBe("gpt-5.6-sol");
    expect(latestPromptBoxProps().execution.reasoning.value).toBe("medium");
    expect(latestPromptBoxProps().modeConfig.permission.value).toBe("auto");
    expect(window.localStorage.getItem("omnyo.promptbox.model-codex-1")).toBe(
      "gpt-5.6-sol",
    );
  });

  it("applies the model to the requested provider only after the composer lands on it", async () => {
    render(rootLikeElement("proj_1"));

    const switched = await settled(
      currentHost().setSelection!({
        providerId: "claude-code",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    );

    expect(switched).toMatchObject({
      providerId: "claude-code",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
    expect(
      window.localStorage.getItem("omnyo.promptbox.model-claude-code-1"),
    ).toBe("gpt-5.6-sol");

    const unknownProvider = await settled(
      currentHost().setSelection!({
        providerId: "not-installed",
        model: "gpt-5.6",
        reasoningLevel: "low",
      }),
    );

    expect(unknownProvider).toMatchObject({
      providerId: "claude-code",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
    expect(window.localStorage.getItem("omnyo.promptbox.provider")).toBe(
      "claude-code",
    );
    expect(
      window.localStorage.getItem("omnyo.promptbox.model-claude-code-1"),
    ).toBe("gpt-5.6-sol");
  });

  it("applies a full execution tuple in one atomic transition", async () => {
    render(rootLikeElement("proj_1"));
    const host = currentHost();
    const before = mocks.promptBoxProps.length;

    const result = await settled(
      host.setSelection!({
        providerId: "claude-code",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    );

    expect(result).toMatchObject({
      providerId: "claude-code",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
    expectSingleExecutionTransition(before);
    expect(window.localStorage.getItem("omnyo.promptbox.provider")).toBe(
      "claude-code",
    );
    expect(
      window.localStorage.getItem("omnyo.promptbox.model-claude-code-1"),
    ).toBe("gpt-5.6-sol");
  });

  it("routes a picker commit through the same tuple path as setSelection", async () => {
    render(rootLikeElement("proj_1"));
    expect(latestPromptBoxProps().execution.favoriteChips).toBe(true);
    const before = mocks.promptBoxProps.length;

    act(() =>
      latestPromptBoxProps().execution.selection.onChange({
        providerId: "claude-code",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    );

    await waitFor(() => {
      expect(currentHost().getSelection?.()).toMatchObject({
        providerId: "claude-code",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
      });
    });
    expectSingleExecutionTransition(before);
  });

  it("keeps a provider-locked composer on its provider and without footer chips", async () => {
    render(rootLikeElement("proj_1", true));
    expect(latestPromptBoxProps().execution.favoriteChips).toBe(false);

    act(() =>
      latestPromptBoxProps().execution.selection.onChange({
        providerId: "claude-code",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    );
    expect(latestPromptBoxProps().execution.provider.selectedId).toBe("codex");
    expect(latestPromptBoxProps().execution.model.selected).not.toBe(
      "gpt-5.6-sol",
    );

    act(() =>
      latestPromptBoxProps().execution.selection.onChange({
        providerId: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().execution.model.selected).toBe(
        "gpt-5.6-sol",
      );
    });
    expect(latestPromptBoxProps().execution.provider.selectedId).toBe("codex");
    expect(latestPromptBoxProps().execution.reasoning.value).toBe("high");
  });

  it("shows footer chips in a plugin composer whose provider and execution are unlocked", () => {
    renderComposer(STORED_REQUEST, () => undefined, "chips-local");
    expect(latestPromptBoxProps().execution.favoriteChips).toBe(true);
  });

  it("waits for the model catalog before reporting, bounded by the settle timeout", async () => {
    mocks.modelsLoading = true;
    const view = render(rootLikeElement("proj_1"));
    let result: ExperimentalComposerSelection | null = null;
    void currentHost().setSelection!({ permissionMode: "accept-edits" }).then(
      (value) => {
        result = value;
      },
    );
    await waitFor(() => {
      expect(
        window.localStorage.getItem("omnyo.promptbox.permission-mode"),
      ).toBe("accept-edits");
    });
    expect(result).toBeNull();

    mocks.modelsLoading = false;
    view.rerender(rootLikeElement("proj_1"));
    await waitFor(() => {
      expect(result).not.toBeNull();
    });
    expect(result).toMatchObject({
      providerId: "codex",
      model: "gpt-5.6",
      permissionMode: "accept-edits",
    });

    setComposerSelectionSettleTimeoutForTest(150);
    vi.useFakeTimers();

    try {
      mocks.modelsLoading = true;
      view.rerender(rootLikeElement("proj_1"));
      let bounded: ExperimentalComposerSelection | null = null;

      await act(async () => {
        void currentHost().setSelection!({ permissionMode: "full" }).then(
          (value) => {
            bounded = value;
          },
        );
      });
      expect(bounded).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(149));
      expect(bounded).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(bounded).toMatchObject({
        providerId: "codex",
        model: "gpt-5.6",
        permissionMode: "full",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the stored new-thread preferences alone from a plugin-embedded composer", async () => {
    window.localStorage.setItem(
      "omnyo.promptbox.model-claude-code-1",
      "gpt-5.6",
    );
    renderComposer(STORED_REQUEST, () => undefined, "selection-local");
    expect(latestPromptBoxProps().execution.model.selected).toBe("gpt-5.6-sol");

    const result = await settled(
      currentHost().setSelection!({
        model: "gpt-5.6",
        reasoningLevel: "low",
        permissionMode: "auto",
      }),
    );

    expect(result).toMatchObject({
      projectId: "proj_1",
      providerId: "claude-code",
      model: "gpt-5.6",
      reasoningLevel: "low",
      permissionMode: "auto",
    });
    expect(latestPromptBoxProps().execution.model.selected).toBe("gpt-5.6");
    expect(
      Object.keys(window.localStorage).filter((key) =>
        /^omnyo\.promptbox\.(model|reasoning|provider|service-tier|permission-mode|environment|machine)/.test(
          key,
        ),
      ),
    ).toEqual(["omnyo.promptbox.model-claude-code-1"]);
    expect(
      window.localStorage.getItem("omnyo.promptbox.model-claude-code-1"),
    ).toBe("gpt-5.6");
    expect(
      window.localStorage.getItem("omnyo.promptbox.permission-mode"),
    ).toBeNull();
  });
});
