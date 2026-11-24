import { registerNewChatStagedCallback } from "@/lib/send-outbox/new-chat-staging";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import type { CapturedAttachmentUploads } from "./usePendingAttachmentUploads";
import { useDraftAttachmentUploads } from "@/components/thread/embedded-chat/useComposerAttachmentUploads";
import { useInitialPromptDraft } from "./mentions/initial-prompt-draft";
import { ProviderRequirementBanner } from "./banner/ProviderRequirementBanner";
import { Button } from "@omnyo/shared-ui/button";
import { recordTelemetryEvent } from "@/components/onboarding/onboarding-telemetry";
import {
  getPluginConfigurationRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import { useNavigate } from "react-router-dom";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type EnvironmentMachineSelection,
  type Host,
  type JsonValue,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type ReasoningLevel,
  type ServiceTier,
} from "@omnyo/domain";
import type {
  ExperimentalComposerSelection,
  NewThreadRequest,
  PluginEnvironmentProviderInputsChange,
} from "@omnyo/plugin-sdk";
import type {
  CreateThreadRequest,
  CreateExecutionInputSources,
  MachineChoice,
  SystemEnvironmentProvider,
  SystemExecutionOptionsModelLoadError,
} from "@omnyo/server-contract";
import type { ProjectSelectorCreateProjectConfig } from "@/components/pickers/ProjectSelector";
import {
  encodeReuseValue,
  encodeProviderValue,
  parseEnvironmentValue,
  REUSE_VALUE_WITHOUT_ENVIRONMENT,
} from "@/components/pickers/environment-picker-value";
import { providerInputsControlRequired } from "@/components/pickers/environment-provider-inputs";
import { useMachineProviderInputs } from "@/components/pickers/machine-provider-inputs";
import { formatModelLoadErrorText } from "@/components/pickers/model-load-error-message";
import {
  buildSessionOptionMenuSections,
  declaredSessionOptionViews,
  SessionOptionsMenu,
  splitSessionOptionsByPlacement,
  type SessionOptionChoices,
} from "@/components/pickers/SessionOptionsMenu";
import {
  NewThreadPromptBox,
  type NewThreadPromptBoxProps,
} from "@/components/promptbox/NewThreadPromptBox";
import {
  describeWhere,
  type NewChatDockConfig,
} from "@/components/promptbox/dock/new-chat-where";
import { rankLauncherProjects } from "@/components/promptbox/dock/project-ranking";
import { buildProviderPromptActionProps } from "@omnyo/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  type PluginComposerHost,
  useComposerHostSelection,
} from "@/components/plugin/plugin-composer-host";
import type { ExperimentalComposerSubmitOptions } from "@omnyo/plugin-sdk";
import {
  readExecutionSelection,
  readExecutionTuple,
  resolveComposerSelectionDeadline,
  useCommittedComposerState,
  waitForSettledComposerState,
  waitUntilComposerStateSettled,
  type CommittedComposerState,
} from "@/components/promptbox/composer-selection-settle";
import type { ModelPickerSelection } from "@/components/pickers/model-picker-selection";
import type { ModelPickerSelects } from "@/components/pickers/ModelFavoritesBar";
import {
  CORE_WORKSPACE_DEFAULT_INPUTS,
  newThreadEnvironmentArgsToSeed,
} from "@/components/plugin/new-thread-environment-seed";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import {
  selectHosts,
  selectPrimaryHost,
  useHosts,
} from "@/hooks/queries/host-queries";
import {
  stripProjectThreads,
  useProjectPromptHistory,
  type SidebarProject,
} from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import {
  usePromptDraftController,
  usePromptDraftInputEmpty,
  usePromptDraftSnapshot,
  restoreFailedPromptDraft,
  getPromptDraftAccessor,
  type PromptDraftController,
  type PromptDraftScope,
} from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { usePromptBoxMachinePreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { usePromptHistoryEnabled } from "@/hooks/usePromptHistoryEnabled";
import {
  arePromptDraftStatesEqual,
  getProjectStoredPromptAttachmentPaths,
  isPromptDraftEmpty,
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@omnyo/client-core";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  isProjectlessProjectId,
} from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import { prepareComposerAttachmentSubmission } from "@/lib/composer-attachment-submission";
import {
  isPendingChatId,
  reservePendingChatSubmission,
  resolvePendingThreadDraftScope,
} from "@/lib/pending-chat-creations";
import type { ComposerSendSlot } from "@/lib/composer-send-queue";
import {
  expectedPluginWait,
  type ExpectedPluginWait,
} from "@/lib/expected-plugin-wait";
import {
  buildReuseThreadOptions,
  resolveHostEnvironmentProvider,
  resolveNewThreadHostEnvironmentProvider,
  resolveProjectMachine,
  resolveRootComposeEffectiveEnvironmentValue,
  type SeededReuseEnvironment,
} from "@/views/root-compose-environment-selection";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { resolveRootComposeThreadEnvironment } from "@/views/root-compose-thread-environment";
import {
  MACHINE_SERVER_ACCESS_TITLE,
  machineServerAccessBlockedReason,
} from "@/components/machines/machine-server-access";

type NewThreadComposerSelectionScope = "new-thread" | "component-local";

const MODEL_PICKER_SELECTS: Record<
  NewThreadComposerSelectionScope,
  ModelPickerSelects
> = {
  "new-thread": "model-and-effort",
  "component-local": "model-and-effort",
};

export interface NewThreadComposerSeed {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
  environment?: NewThreadRequest["environment"];
  initialPrompt?: string;
}

interface NewThreadComposerLocks {
  project?: boolean;
  provider?: boolean;
  environment?: boolean;
  execution?: boolean;
}

type ProjectChangeOutcome = "changed" | "unchanged" | "refused";

interface NewThreadComposerSelectionState extends CommittedComposerState {
  requestedProjectId: string;
  projectId: string;
  selectedProviderId: string;
  selectedThreadModel: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  supportsServiceTier: boolean;
  permissionMode: PermissionMode;
  submissionEnvironment: NewThreadRequest["environment"] | null;
  providerIds: readonly string[];
  changeProject: (nextProjectId: string) => Promise<ProjectChangeOutcome>;
  changeEnvironment: (
    value: string,
    providerMachine: EnvironmentMachineSelection | null,
    inputs?: JsonValue,
  ) => void;
  changeProvider: (providerId: string) => void;
  changeModel: (model: string) => void;
  changeReasoning: (level: ReasoningLevel) => void;
  changeServiceTier: (tier: ServiceTier | undefined) => void;
  changeExecution: (selection: ModelPickerSelection) => void;
  changePermissionMode: (mode: PermissionMode) => void;
}

const NO_SESSION_OPTION_CHOICES: SessionOptionChoices = {};

function readNewThreadComposerSelection(
  state: NewThreadComposerSelectionState,
): ExperimentalComposerSelection {
  return {
    projectId: state.projectId,
    ...(state.submissionEnvironment === null
      ? {}
      : { environment: state.submissionEnvironment }),
    ...readExecutionSelection(state),
  };
}

interface NewThreadComposerPromptOptions {
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  banner?: ReactNode;
  header?: ReactNode;
  blockedReason?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  pluginComposerHost?: PluginComposerHost;
  textEffects?: NewThreadPromptBoxProps["textEffects"];
  allowNoProject?: boolean;
  createProject?: ProjectSelectorCreateProjectConfig;
  onRequestMachineSetup?: (host: Host) => void;
  locks?: NewThreadComposerLocks;
  mentionMenuPlacement: NewThreadPromptBoxProps["mentionMenuPlacement"];
  selectionLayout?: "footer" | "dock" | "stage";
  projectShelf?: HTMLElement | null;
  promptBoxRef?: RefObject<PromptBoxHandle | null>;
}

type ParsedEnvironment = ReturnType<typeof parseEnvironmentValue>;

export interface NewThreadComposerState {
  projectId: string;
  isProjectless: boolean;
  projects: readonly SidebarProject[] | undefined;
  sidebarNavigationError: boolean;
  currentProject: SidebarProject | undefined;
  projectSources: SidebarProject["sources"];
  connectedHostIds: ReadonlySet<string>;
  primaryHostId: string | null;
  parsedEnvironment: ParsedEnvironment;
  projectHostId: string | null;
  panelThreadId: string | null;
  selectedProviderId: string;
  promptDraft: PromptDraftController;
  focusPromptBox: () => void;
  pluginComposerHost: PluginComposerHost;
  textEffects: NewThreadPromptBoxProps["textEffects"];
  seedEnvironmentSelectionValue: (value: string) => void;
  hostSelectionReady: boolean;
  selectHostForNewEnvironment: (hostId: string) => void;
  setEnvironmentSelectionValue: (
    value: string,
    providerHostId?: string | null,
  ) => void;
  setProviderModelReasoning: (selection: ModelPickerSelection) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setServiceTier: (value: ServiceTier | undefined) => void;
  renderPromptBox: (options: NewThreadComposerPromptOptions) => ReactNode;
}

export interface NewThreadComposerSubmission extends NewThreadRequest {
  capturedUploads?: CapturedAttachmentUploads;
  prepareInput?: () => Promise<NewThreadRequest["input"]>;
  sendReservation?: ComposerSendSlot;
  pluginSubmission?: CreateThreadRequest["pluginSubmission"];
  sendAt?: number;
  expectedPluginWait?: ExpectedPluginWait;
}

export interface NewThreadComposerProps {
  projectId: string | null;
  onProjectChange: (projectId: string) => void | Promise<void>;
  draftStorage: PromptDraftScope;
  selectionScope: NewThreadComposerSelectionScope;
  seed?: NewThreadComposerSeed;
  resetKey?: string | number | null;
  preferReadyProviderWhenUnset?: boolean;
  onSubmit: (request: NewThreadComposerSubmission) => void | Promise<void>;
  focusRequest?: number;
  children: (state: NewThreadComposerState) => ReactNode;
}

function NewThreadComposerStateRenderer({
  render,
  state,
}: {
  render: NewThreadComposerProps["children"];
  state: NewThreadComposerState;
}) {
  return render(state);
}

type LiveDraftNewThreadPromptBoxProps = Omit<
  NewThreadPromptBoxProps,
  "attachments" | "history" | "mentionRanges" | "value"
> & {
  attachments: Omit<NewThreadPromptBoxProps["attachments"], "items">;
  history: Omit<NewThreadPromptBoxProps["history"], "currentDraft">;
  promptDraft: PromptDraftController;
};

function LiveDraftNewThreadPromptBox({
  attachments,
  history,
  promptDraft,
  ...promptBoxProps
}: LiveDraftNewThreadPromptBoxProps) {
  const draft = usePromptDraftSnapshot(promptDraft);

  return (
    <NewThreadPromptBox
      {...promptBoxProps}
      value={draft.text}
      mentionRanges={draft.mentions}
      history={{ ...history, currentDraft: draft }}
      attachments={{ ...attachments, items: draft.attachments }}
    />
  );
}

type ProjectDefaultsState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "resolved"; defaults: ProjectExecutionDefaults | null };

export interface ResolveNewThreadSubmitDisabledReasonArgs {
  environmentProviderInputsBlocker: string | null;
  environmentSetupRequiredReason: string | null;
  isCopyingAttachments: boolean;
  isLoadingModels: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  modelLoadError: SystemExecutionOptionsModelLoadError | null;
  projectDefaultsStatus: ProjectDefaultsState["status"];
  projectDefaultsUnavailable: boolean;
  promptInputEmpty: boolean;
  providerDisplayName: string;
  selectedProviderId: string;
  selectedThreadModel: string;
  submissionEnvironmentUnavailable: boolean;
}

export function resolveNewThreadSubmitDisabledReason({
  environmentProviderInputsBlocker,
  environmentSetupRequiredReason,
  isCopyingAttachments,
  isLoadingModels,
  isSubmitting,
  isUploading,
  modelLoadError,
  projectDefaultsStatus,
  projectDefaultsUnavailable,
  promptInputEmpty,
  providerDisplayName,
  selectedProviderId,
  selectedThreadModel,
  submissionEnvironmentUnavailable,
}: ResolveNewThreadSubmitDisabledReasonArgs): string | null {
  if (isSubmitting) return "Starting thread...";

  if (isCopyingAttachments) {
    return "Moving attachments to the selected project...";
  }

  if (isUploading) return "Uploading attachments...";

  if (projectDefaultsUnavailable) {
    return projectDefaultsStatus === "error"
      ? "Could not load the project's execution defaults."
      : "Loading the project's execution defaults...";
  }

  if (!selectedProviderId) return "Select a provider.";

  if (isLoadingModels) {
    return "Loading models from the selected machine...";
  }

  const fatalModelLoadError =
    modelLoadError?.code === "provider_unavailable" ||
    modelLoadError?.code === "missing_executable" ||
    modelLoadError?.code === "auth_required";

  if (modelLoadError && (fatalModelLoadError || !selectedThreadModel)) {
    return formatModelLoadErrorText({
      error: modelLoadError,
      providerLabel: providerDisplayName || selectedProviderId,
    });
  }

  if (!selectedThreadModel) return "Select a model.";

  if (environmentSetupRequiredReason) return environmentSetupRequiredReason;

  if (environmentProviderInputsBlocker) return environmentProviderInputsBlocker;

  if (submissionEnvironmentUnavailable) return "Select an environment.";

  if (promptInputEmpty) return "Enter a prompt or attach a file.";

  return null;
}

export function resolveNewThreadProjectDefaultsState({
  cachedDefaults,
  projectFound,
}: {
  cachedDefaults: ProjectExecutionDefaults | null | undefined;
  projectFound: boolean;
}): ProjectDefaultsState {
  if (cachedDefaults !== undefined) {
    return { status: "resolved", defaults: cachedDefaults };
  }

  if (!projectFound) return { status: "pending" };

  return { status: "resolved", defaults: null };
}

function mergeMissingPromptDraftAttachments(
  currentAttachments: readonly PromptDraftAttachment[],
  preservedAttachments: readonly PromptDraftAttachment[],
): PromptDraftAttachment[] | null {
  const existingPaths = new Set(
    currentAttachments.map((attachment) => attachment.path),
  );

  const missingAttachments = preservedAttachments.filter(
    (attachment) => !existingPaths.has(attachment.path),
  );

  return missingAttachments.length === 0
    ? null
    : [...currentAttachments, ...missingAttachments];
}

export function restorePromptDraftAfterOptionChange({
  currentDraft,
  preservedDraft,
}: {
  currentDraft: PromptDraftState;
  preservedDraft: PromptDraftState | null;
}): PromptDraftState | null {
  if (
    preservedDraft === null ||
    arePromptDraftStatesEqual(currentDraft, preservedDraft)
  ) {
    return null;
  }

  let restoredDraft = currentDraft;
  let changed = false;

  if (isPromptDraftEmpty(currentDraft) && !isPromptDraftEmpty(preservedDraft)) {
    restoredDraft = preservedDraft;
    changed = true;
  } else if (
    currentDraft.text === preservedDraft.text &&
    currentDraft.mentions !== preservedDraft.mentions &&
    JSON.stringify(currentDraft.mentions) !==
      JSON.stringify(preservedDraft.mentions)
  ) {
    restoredDraft = { ...restoredDraft, mentions: preservedDraft.mentions };
    changed = true;
  }

  const mergedAttachments = mergeMissingPromptDraftAttachments(
    restoredDraft.attachments,
    preservedDraft.attachments,
  );

  if (mergedAttachments !== null) {
    restoredDraft = { ...restoredDraft, attachments: mergedAttachments };
    changed = true;
  }

  return changed ? restoredDraft : null;
}

function useDraftPreservingOptionChange<T>(
  current: T,
  setValue: (value: T) => void,
  snapshot: () => void,
): (value: T) => void {
  return useCallback(
    (value: T) => {
      if (Object.is(current, value)) return;
      snapshot();
      setValue(value);
    },
    [current, setValue, snapshot],
  );
}

function providerInputsScopeKey(
  projectId: string,
  value: string,
  hostId: string | null,
): string {
  return `${projectId}\0${value}\0${hostId ?? ""}`;
}

function resolvePanelThreadId(
  environmentId: string | null,
  reuseThreadOptions: ReturnType<typeof buildReuseThreadOptions>,
): string | null {
  if (environmentId === null) return null;

  return (
    reuseThreadOptions.find((option) => option.environmentId === environmentId)
      ?.threads[0]?.id ?? null
  );
}

export function NewThreadComposer({
  projectId: requestedProjectId,
  onProjectChange,
  draftStorage,
  selectionScope,
  seed,
  resetKey,
  preferReadyProviderWhenUnset = false,
  onSubmit,
  focusRequest,
  children,
}: NewThreadComposerProps) {
  const navigate = useNavigate();

  const [localPromptBoxFocusRequest, setLocalPromptBoxFocusRequest] = useState<
    number | null
  >(null);

  const promptBoxFocusRequest =
    focusRequest === undefined && localPromptBoxFocusRequest === null
      ? undefined
      : `${focusRequest ?? ""}:${localPromptBoxFocusRequest ?? ""}`;

  const sidebarNavigationQuery = useSidebarNavigation();

  const projects = useMemo(
    () => sidebarNavigationQuery.data?.projects.map(stripProjectThreads),
    [sidebarNavigationQuery.data],
  );

  const requestedCandidate = requestedProjectId ?? PERSONAL_PROJECT_ID;

  const candidateKnown =
    isProjectlessProjectId(requestedCandidate) ||
    (projects?.some((project) => project.id === requestedCandidate) ?? false);

  const replayKnowsCandidate =
    !sidebarNavigationQuery.isPlaceholderData || candidateKnown;

  const sidebarNavigationSettled =
    sidebarNavigationQuery.isError ||
    (sidebarNavigationQuery.isSuccess && replayKnowsCandidate);

  const projectId = useMemo(() => {
    if (isProjectlessProjectId(requestedCandidate)) return PERSONAL_PROJECT_ID;

    if (!projects || !replayKnowsCandidate) return requestedCandidate;

    return candidateKnown ? requestedCandidate : PERSONAL_PROJECT_ID;
  }, [candidateKnown, projects, replayKnowsCandidate, requestedCandidate]);

  const isProjectless = isProjectlessProjectId(projectId);

  const currentProject = useMemo(() => {
    if (isProjectless) {
      const personalProject = sidebarNavigationQuery.data?.personalProject;

      return personalProject ? stripProjectThreads(personalProject) : undefined;
    }

    return projects?.find((project) => project.id === projectId);
  }, [isProjectless, projectId, projects, sidebarNavigationQuery.data]);

  const projectSources = useMemo(
    () => currentProject?.sources ?? [],
    [currentProject?.sources],
  );

  const projectOptions = useMemo(
    () => projects?.map(({ id, name }) => ({ id, name })) ?? [],
    [projects],
  );

  const hostsQuery = useHosts();
  const { localHostId, isLocalHostLoading } = useHostDaemon();

  const availableHosts = useMemo(
    () => selectHosts(hostsQuery.data, "persistent"),
    [hostsQuery.data],
  );

  const systemConfigQuery = useSystemConfig();

  const primaryHostId =
    selectPrimaryHost(
      availableHosts,
      systemConfigQuery.data?.primaryHostId ?? null,
    )?.id ?? null;

  const defaultThreadMachineId =
    systemConfigQuery.data?.generalSettings?.defaultThreadMachineId ?? null;

  const defaultHostId = defaultThreadMachineId ?? primaryHostId;

  const knownHostIds = useMemo(
    () => new Set(availableHosts.map((host) => host.id)),
    [availableHosts],
  );

  const connectedHostIds = useMemo(
    () =>
      new Set(
        availableHosts
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [availableHosts],
  );

  const worktreeHostNameById = useMemo(() => {
    const hosts = availableHosts;

    return hosts.length <= 1
      ? null
      : new Map(hosts.map((host) => [host.id, host.name]));
  }, [availableHosts]);

  const projectThreads = useMemo(() => {
    const navigation = sidebarNavigationQuery.data;

    if (!navigation) return undefined;

    if (isProjectless) return navigation.personalProject.threads;

    return navigation.projects.find((project) => project.id === projectId)
      ?.threads;
  }, [isProjectless, projectId, sidebarNavigationQuery.data]);

  const reuseThreadOptionsLoading =
    projectThreads === undefined && !sidebarNavigationSettled;

  const threadDerivedReuseOptions = useMemo(
    () => buildReuseThreadOptions(projectThreads ?? [], worktreeHostNameById),
    [projectThreads, worktreeHostNameById],
  );

  const { providers: registeredEnvironmentProviders } =
    useSystemEnvironmentProviders();

  const environmentProviders = useMemo(
    () =>
      registeredEnvironmentProviders?.filter((provider) =>
        isProjectless
          ? !provider.requires.projectCheckout && !provider.requires.gitRemote
          : !provider.requires.projectless,
      ),
    [isProjectless, registeredEnvironmentProviders],
  );

  const { providers: projectEnvironmentProviders } =
    useSystemEnvironmentProviders({ projectId });

  const projectGitRemoteUrl = currentProject?.gitRemoteUrl;

  const environmentProvidersByHostId = useMemo(
    () =>
      new Map(
        availableHosts.map((host) => [
          host.id,
          (environmentProviders ?? [])
            .filter(
              (provider) =>
                !provider.machineProviderId &&
                (!(
                  provider.requires.projectCheckout ||
                  provider.requires.gitCheckout
                ) ||
                  findLocalPathProjectSourceForHost(projectSources, host.id) !==
                    undefined) &&
                (!provider.requires.gitRemote || projectGitRemoteUrl != null),
            )
            .map((provider) => ({
              ...provider,
              availability:
                projectEnvironmentProviders?.find(
                  (candidate) => candidate.id === provider.id,
                )?.machineAvailability[host.id] ?? null,
            })),
        ]),
      ),
    [
      availableHosts,
      environmentProviders,
      projectEnvironmentProviders,
      projectGitRemoteUrl,
      projectSources,
    ],
  );

  const { providers: machineProviders } = useSystemMachineProviders();
  const pluginList = usePluginList({ enabled: true });

  const seedSignature = JSON.stringify([
    projectId,
    resetKey ?? null,
    seed?.providerId ?? null,
    seed?.model ?? null,
    seed?.reasoningLevel ?? null,
    seed?.serviceTier ?? null,
    seed?.permissionMode ?? null,
    seed?.environment ?? null,
  ]);

  const environmentSeed = useMemo(
    () =>
      seed?.environment === undefined
        ? null
        : newThreadEnvironmentArgsToSeed(seed.environment),
    [seed?.environment],
  );

  const seededReuseEnvironmentId = useMemo(() => {
    if (environmentSeed === null) return null;
    const parsed = parseEnvironmentValue(environmentSeed.selectionValue);

    return parsed?.type === "reuse" ? parsed.environmentId : null;
  }, [environmentSeed]);

  const seededReuseIsThreadDerived =
    seededReuseEnvironmentId !== null &&
    threadDerivedReuseOptions.some(
      (option) => option.environmentId === seededReuseEnvironmentId,
    );

  const seededReuseLookupId =
    seededReuseEnvironmentId !== null && !seededReuseIsThreadDerived
      ? seededReuseEnvironmentId
      : null;

  const seededReuseEnvironmentQuery = useEnvironment(seededReuseLookupId);

  const seededReuseEnvironmentRow =
    seededReuseLookupId !== null &&
    seededReuseEnvironmentQuery.data?.id === seededReuseLookupId &&
    seededReuseEnvironmentQuery.data.status !== "destroyed"
      ? seededReuseEnvironmentQuery.data
      : null;

  const seededReuseEnvironment = useMemo<SeededReuseEnvironment | null>(() => {
    if (seededReuseEnvironmentId === null) return null;

    if (seededReuseIsThreadDerived) {
      return { environmentId: seededReuseEnvironmentId, status: "available" };
    }

    if (seededReuseEnvironmentQuery.isPending) {
      return { environmentId: seededReuseEnvironmentId, status: "pending" };
    }

    return {
      environmentId: seededReuseEnvironmentId,
      status: seededReuseEnvironmentRow === null ? "missing" : "available",
    };
  }, [
    seededReuseEnvironmentId,
    seededReuseEnvironmentQuery.isPending,
    seededReuseEnvironmentRow,
    seededReuseIsThreadDerived,
  ]);

  const reuseThreadOptions = useMemo(() => {
    if (seededReuseEnvironmentRow === null) return threadDerivedReuseOptions;

    return [
      ...threadDerivedReuseOptions,
      {
        environmentId: seededReuseEnvironmentRow.id,
        branchName: seededReuseEnvironmentRow.branchName,
        name: seededReuseEnvironmentRow.name,
        path: seededReuseEnvironmentRow.path,
        environmentProviderId:
          seededReuseEnvironmentRow.environmentProviderId ?? null,
        hostId: seededReuseEnvironmentRow.hostId,
        hostName:
          worktreeHostNameById?.get(seededReuseEnvironmentRow.hostId) ?? null,
        threads: [],
      },
    ];
  }, [
    seededReuseEnvironmentRow,
    threadDerivedReuseOptions,
    worktreeHostNameById,
  ]);

  const { value: storedMachineId, setValue: setStoredMachineId } =
    usePromptBoxMachinePreference(projectId);

  const [activeSeedSignature, setActiveSeedSignature] = useState(seedSignature);
  const [seedOverridden, setBranchSeedOverridden] = useState(false);

  const [pickedProviderMachine, setPickedProviderMachine] = useState<{
    selectionValue: string;
    machine: EnvironmentMachineSelection;
  } | null>(null);

  if (activeSeedSignature !== seedSignature) {
    setActiveSeedSignature(seedSignature);
    setBranchSeedOverridden(false);
    setPickedProviderMachine(null);
  }

  const resolveProviderSelection = useCallback(
    (
      effectiveValue: string,
    ): {
      provider: SystemEnvironmentProvider;
      machine: EnvironmentMachineSelection | null;
      machineChoice: MachineChoice;
    } | null => {
      const parsedValue = parseEnvironmentValue(effectiveValue);

      if (parsedValue?.type !== "provider") return null;

      const provider = environmentProviders?.find(
        (candidate) => candidate.id === parsedValue.environmentProviderId,
      );

      if (provider === undefined) return null;

      if (provider.machineProviderId)
        return { provider, machine: null, machineChoice: "explicit" };

      const usable = (hostId: string | null): boolean =>
        hostId !== null &&
        knownHostIds.has(hostId) &&
        (environmentProvidersByHostId
          .get(hostId)
          ?.some(
            (candidate) =>
              candidate.id === provider.id &&
              candidate.availability?.status !== "unavailable",
          ) ??
          false);

      const picked =
        pickedProviderMachine?.selectionValue === effectiveValue
          ? pickedProviderMachine.machine
          : null;

      if (picked !== null)
        return { provider, machine: picked, machineChoice: "explicit" };

      const seeded =
        !seedOverridden &&
        environmentSeed !== null &&
        environmentSeed.selectionValue === effectiveValue
          ? environmentSeed.providerMachine
          : null;

      if (seeded !== null)
        return { provider, machine: seeded, machineChoice: "explicit" };

      const hostId = resolveProjectMachine({
        defaultThreadMachineId,
        rememberedHostId:
          selectionScope === "new-thread" && storedMachineId !== ""
            ? storedMachineId
            : null,
        localHostId,
        primaryHostId,
        sources: projectSources,
        hostOrder: availableHosts.map((host) => host.id),
        connectedHostIds,
        isUsable: usable,
      });

      return {
        provider,
        machine: hostId === null ? null : { type: "existing", hostId },
        machineChoice: "default",
      };
    },
    [
      seedOverridden,
      environmentSeed,
      environmentProviders,
      environmentProvidersByHostId,
      knownHostIds,
      pickedProviderMachine,
      defaultThreadMachineId,
      selectionScope,
      storedMachineId,
      primaryHostId,
      localHostId,
      connectedHostIds,
      projectSources,
      availableHosts,
    ],
  );

  const resolveProviderRouting = useCallback(
    (environmentSelectionValue: string) => {
      const effectiveValue = resolveRootComposeEffectiveEnvironmentValue({
        defaultThreadMachineId,
        environmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
        seededReuseEnvironment,
      });

      const providerSelection = resolveProviderSelection(effectiveValue);

      if (providerSelection !== null) {
        return providerSelection.machine?.type !== "existing"
          ? {}
          : { hostId: providerSelection.machine.hostId };
      }

      const parsed = parseEnvironmentValue(effectiveValue);

      return parsed?.type === "reuse" && parsed.environmentId !== null
        ? { environmentId: parsed.environmentId }
        : {};
    },
    [
      environmentProviders,
      isProjectless,
      knownHostIds,
      defaultThreadMachineId,
      primaryHostId,
      projectSources,
      resolveProviderSelection,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      seededReuseEnvironment,
    ],
  );

  const projectDefaultsState = resolveNewThreadProjectDefaultsState({
    cachedDefaults: currentProject?.defaultExecutionOptions,
    projectFound: currentProject !== undefined,
  });

  const projectDefaults =
    projectDefaultsState.status === "resolved"
      ? projectDefaultsState.defaults
      : undefined;

  const projectDefaultsUnavailable =
    projectDefaultsState.status !== "resolved" &&
    (seed?.providerId === undefined ||
      seed?.model === undefined ||
      seed?.reasoningLevel === undefined ||
      seed?.permissionMode === undefined);

  const providerRoutingReady =
    !isLocalHostLoading &&
    !hostsQuery.isPending &&
    !systemConfigQuery.isPending &&
    sidebarNavigationSettled &&
    environmentProviders !== undefined;

  const creationOptions = useThreadCreationOptions({
    enabled: providerRoutingReady && !projectDefaultsUnavailable,
    scope: selectionScope,
    preferenceProjectId: projectId,
    resetKey: `${projectId}\0${seedSignature}`,
    resolveProviderRouting,
    initialProviderId: seed?.providerId ?? projectDefaults?.providerId,
    preferReadyProviderWhenUnset:
      preferReadyProviderWhenUnset && projectDefaults === null,
    initialModel: seed?.model ?? projectDefaults?.model,
    initialServiceTier: seed?.serviceTier ?? projectDefaults?.serviceTier,
    initialReasoningLevel:
      seed?.reasoningLevel ?? projectDefaults?.reasoningLevel,
    initialPermissionMode:
      seed?.permissionMode ?? projectDefaults?.permissionMode,
    initialEnvironmentSelectionValue: environmentSeed?.selectionValue,
  });

  const {
    activeModel,
    catalogModelOptions,
    executionInputSources,
    executionOptionsRouting,
    environmentSelectionValue,
    hasMultipleProviders,
    isLoadingModels,
    modelCatalogIsSettled,
    modelCatalogIsVerified,
    modelLoadError,
    modelNotice,
    modelLoadFailed,
    modelOptions,
    moreModelOptions,
    permissionMode,
    permissionModeOptions,
    providerOptions,
    providers: executionProviders,
    reasoningLevel,
    reasoningOptions,
    selectedModel,
    selectedProviderComposerActions,
    selectedProviderDisplayName,
    selectedProviderId,
    serviceTier,
    serviceTierSupportByProvider,
    serviceTierOptions,
    setEnvironmentSelectionValue: setCreationEnvironmentSelectionValue,
    setPermissionMode,
    setProviderModelReasoning,
    setReasoningLevel,
    setSelectedModel,
    setSelectedProviderId,
    setServiceTier,
    supportsPermissionModeSelection,
    supportsServiceTier,
    clearReuseEnvironment,
    declaredSessionOptions,
    sessionOptionSelections,
    sessionOptionSelectionsForProvider,
    setSessionOption,
  } = creationOptions;

  const selectedThreadModel = activeModel?.model ?? selectedModel;

  const placedSessionOptions = useMemo(
    () =>
      splitSessionOptionsByPlacement(
        declaredSessionOptionViews(
          declaredSessionOptions,
          sessionOptionSelections,
          activeModel?.sessionOptions ?? [],
        ),
      ),
    [
      activeModel?.sessionOptions,
      declaredSessionOptions,
      sessionOptionSelections,
    ],
  );

  const pickerSessionOptionSections = useMemo(
    () =>
      buildSessionOptionMenuSections(
        placedSessionOptions.picker,
        NO_SESSION_OPTION_CHOICES,
      ),
    [placedSessionOptions.picker],
  );

  const providerIds = useMemo(
    () => providerOptions.map((option) => option.value),
    [providerOptions],
  );

  const promptDraft = usePromptDraftController(draftStorage);
  const textEffects = useComposerTextEffects(promptDraft.storageKey);
  const promptOptionDraftSnapshotRef = useRef<PromptDraftState | null>(null);

  const snapshotDraftBeforeOptionChange = useCallback(() => {
    const currentDraft = promptDraft.getCurrent();
    promptOptionDraftSnapshotRef.current = isPromptDraftEmpty(currentDraft)
      ? null
      : currentDraft;
  }, [promptDraft]);

  useEffect(() => {
    const preservedDraft = promptOptionDraftSnapshotRef.current;

    if (preservedDraft === null) return;
    promptOptionDraftSnapshotRef.current = null;

    const restoredDraft = restorePromptDraftAfterOptionChange({
      currentDraft: promptDraft.getCurrent(),
      preservedDraft,
    });

    if (restoredDraft !== null) promptDraft.setDraft(restoredDraft);
  });

  const [environmentProviderInputsOverride, setProviderInputsOverride] =
    useState<{ scopeKey: string; value: JsonValue | null } | null>(null);

  const [environmentProviderInputsBlocked, setProviderInputsBlocked] =
    useState<{ scopeKey: string; reason: string } | null>(null);

  const changeEnvironment = useCallback(
    (
      value: string,
      providerTarget: string | EnvironmentMachineSelection | null = null,
      inputs?: JsonValue,
    ) => {
      const providerMachine =
        typeof providerTarget === "string"
          ? { type: "existing" as const, hostId: providerTarget }
          : providerTarget;

      const currentProviderMachine =
        pickedProviderMachine?.selectionValue === value
          ? pickedProviderMachine.machine
          : null;

      const inputsScopeKey = providerInputsScopeKey(
        projectId,
        value,
        providerMachine?.type === "existing" ? providerMachine.hostId : null,
      );

      const inputsUnchanged =
        inputs === undefined ||
        (environmentProviderInputsOverride?.scopeKey === inputsScopeKey &&
          JSON.stringify(environmentProviderInputsOverride.value) ===
            JSON.stringify(inputs));

      if (
        Object.is(environmentSelectionValue, value) &&
        JSON.stringify(providerMachine) ===
          JSON.stringify(currentProviderMachine) &&
        inputsUnchanged
      ) {
        return;
      }

      snapshotDraftBeforeOptionChange();
      setBranchSeedOverridden(true);
      setPickedProviderMachine(
        providerMachine === null
          ? null
          : { selectionValue: value, machine: providerMachine },
      );

      if (inputs !== undefined) {
        setProviderInputsBlocked(null);
        setProviderInputsOverride({ scopeKey: inputsScopeKey, value: inputs });
      }

      if (
        selectionScope === "new-thread" &&
        parseEnvironmentValue(value)?.type === "provider"
      ) {
        setStoredMachineId(
          providerMachine?.type === "existing" ? providerMachine.hostId : "",
        );
      }

      setCreationEnvironmentSelectionValue(value);
    },
    [
      environmentProviderInputsOverride,
      environmentSelectionValue,
      pickedProviderMachine,
      projectId,
      setCreationEnvironmentSelectionValue,
      selectionScope,
      setStoredMachineId,
      snapshotDraftBeforeOptionChange,
    ],
  );

  const effectiveEnvironmentValue = useMemo(
    () =>
      resolveRootComposeEffectiveEnvironmentValue({
        defaultThreadMachineId,
        environmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
        seededReuseEnvironment,
      }),
    [
      environmentSelectionValue,
      environmentProviders,
      isProjectless,
      knownHostIds,
      defaultThreadMachineId,
      primaryHostId,
      projectSources,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      seededReuseEnvironment,
    ],
  );

  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(effectiveEnvironmentValue),
    [effectiveEnvironmentValue],
  );

  const providerSelection = useMemo(
    () => resolveProviderSelection(effectiveEnvironmentValue),
    [effectiveEnvironmentValue, resolveProviderSelection],
  );

  const selectedEnvironmentProvider = providerSelection?.provider;

  const inputEnvironmentProvider =
    selectedEnvironmentProvider?.environmentProviderId
      ? environmentProviders?.find(
          (provider) =>
            provider.id === selectedEnvironmentProvider.environmentProviderId,
        )
      : selectedEnvironmentProvider;

  const providerMachine = providerSelection?.machine ?? null;

  const providerMachineChoice = providerSelection?.machineChoice ?? "explicit";

  const providerHostId =
    providerMachine?.type === "existing" ? providerMachine.hostId : null;

  const selectedProviderMachineUnavailable =
    providerHostId !== null &&
    !(
      environmentProvidersByHostId
        .get(providerHostId)
        ?.some(
          (provider) =>
            provider.id === selectedEnvironmentProvider?.id &&
            provider.availability?.status !== "unavailable",
        ) ?? false
    );

  const handleSelectProvider = useCallback(
    (provider: SystemEnvironmentProvider, hostId: string | null) => {
      changeEnvironment(
        encodeProviderValue(provider.id),
        hostId === null ? null : { type: "existing", hostId },
      );
    },
    [changeEnvironment],
  );

  const selectHostForNewEnvironment = useCallback(
    (hostId: string) => {
      if (!knownHostIds.has(hostId)) return;

      const currentProviderId =
        parsedEnvironment?.type === "provider"
          ? parsedEnvironment.environmentProviderId
          : null;

      const provider = resolveNewThreadHostEnvironmentProvider({
        currentProviderId,
        providers: environmentProvidersByHostId.get(hostId) ?? [],
      });

      if (provider === null) return;
      changeEnvironment(encodeProviderValue(provider.id), hostId);
    },
    [
      changeEnvironment,
      environmentProvidersByHostId,
      knownHostIds,
      parsedEnvironment,
    ],
  );

  const selectedMachineProvider =
    providerMachine?.type === "new"
      ? machineProviders?.find(
          (provider) => provider.id === providerMachine.machineProviderId,
        )
      : undefined;

  const configurationMachineProvider =
    selectedMachineProvider ??
    (selectedEnvironmentProvider?.machineProviderId === null ||
    selectedEnvironmentProvider?.machineProviderId === undefined
      ? undefined
      : machineProviders?.find(
          (provider) =>
            provider.id === selectedEnvironmentProvider.machineProviderId,
        ));

  const configurationPlugin =
    configurationMachineProvider === undefined
      ? undefined
      : pluginList.data?.plugins.find(
          (plugin) => plugin.id === configurationMachineProvider.pluginId,
        );

  const setupRequiredProvider =
    configurationPlugin?.status === "needs-configuration" &&
    configurationMachineProvider !== undefined
      ? configurationMachineProvider
      : null;

  const projectCheckoutMissing =
    !isProjectless &&
    providerHostId !== null &&
    (selectedEnvironmentProvider?.requires.projectCheckout ||
      selectedEnvironmentProvider?.requires.gitCheckout) &&
    findLocalPathProjectSourceForHost(projectSources, providerHostId) ===
      undefined;

  const environmentSetupRequiredReason = projectCheckoutMissing
    ? `Set up ${currentProject?.name ?? "this project"} on ${availableHosts.find((host) => host.id === providerHostId)?.name ?? "the selected machine"}.`
    : setupRequiredProvider === null
      ? null
      : (configurationPlugin?.statusDetail ??
        `${setupRequiredProvider.displayName} needs setting up.`);

  const serverAccess = systemConfigQuery.data?.serverAccess;

  const machineServerAccessReason =
    selectedEnvironmentProvider?.machineProviderId == null
      ? null
      : machineServerAccessBlockedReason(serverAccess);

  const environmentProviderInputsScopeKey = providerInputsScopeKey(
    projectId,
    effectiveEnvironmentValue,
    providerHostId,
  );

  const handleProviderInputsChange = useCallback(
    (next: PluginEnvironmentProviderInputsChange) => {
      if (next.status === "blocked") {
        setProviderInputsBlocked((current) => {
          if (
            current?.scopeKey === environmentProviderInputsScopeKey &&
            current.reason === next.reason
          ) {
            return current;
          }

          return {
            scopeKey: environmentProviderInputsScopeKey,
            reason: next.reason,
          };
        });

        return;
      }

      setProviderInputsBlocked(null);
      setProviderInputsOverride((current) => {
        if (
          current?.scopeKey === environmentProviderInputsScopeKey &&
          JSON.stringify(current.value) === JSON.stringify(next.value)
        ) {
          return current;
        }

        return {
          scopeKey: environmentProviderInputsScopeKey,
          value: next.value,
        };
      });
    },
    [environmentProviderInputsScopeKey],
  );

  const activeProviderInputsOverride =
    environmentProviderInputsOverride !== null &&
    environmentProviderInputsOverride.scopeKey ===
      environmentProviderInputsScopeKey
      ? environmentProviderInputsOverride
      : null;

  const activeProviderInputsBlocked =
    environmentProviderInputsBlocked?.scopeKey ===
    environmentProviderInputsScopeKey
      ? environmentProviderInputsBlocked
      : null;

  const providerTakesInputs =
    inputEnvironmentProvider !== undefined &&
    inputEnvironmentProvider.inputs !== null;

  const pluginSlots = usePluginSlots();
  const environmentProviderInputsSlots = pluginSlots.environmentProviderInputs;

  const inputsControlProviderIds = useMemo(() => {
    const pluginIdByProviderId = new Map(
      (environmentProviders ?? []).map((provider) => [
        provider.id,
        provider.pluginId,
      ]),
    );

    const ids = new Set(
      environmentProviderInputsSlots
        .filter(
          (slot) =>
            pluginIdByProviderId.get(slot.environmentProviderId) ===
            slot.pluginId,
        )
        .map((slot) => slot.environmentProviderId),
    );

    for (const provider of environmentProviders ?? []) {
      if (
        provider.environmentProviderId &&
        ids.has(provider.environmentProviderId)
      )
        ids.add(provider.id);
    }

    return ids;
  }, [environmentProviderInputsSlots, environmentProviders]);

  const handleSelectHost = useCallback(
    (hostId: string) => {
      const provider = resolveHostEnvironmentProvider({
        currentProvider: selectedEnvironmentProvider ?? null,
        providers: environmentProvidersByHostId.get(hostId) ?? [],
        inputsControlProviderIds,
      });

      if (provider === null) return;
      changeEnvironment(encodeProviderValue(provider.id), {
        type: "existing",
        hostId,
      });
    },
    [
      changeEnvironment,
      environmentProvidersByHostId,
      inputsControlProviderIds,
      selectedEnvironmentProvider,
    ],
  );

  const environmentProviderInputsRegistration = useMemo(() => {
    if (
      inputEnvironmentProvider === undefined ||
      inputEnvironmentProvider.inputs === null
    ) {
      return undefined;
    }

    return environmentProviderInputsSlots.find(
      (slot) =>
        slot.environmentProviderId === inputEnvironmentProvider.id &&
        slot.pluginId === inputEnvironmentProvider.pluginId,
    );
  }, [environmentProviderInputsSlots, inputEnvironmentProvider]);

  const controlRequiredForSelectedProvider =
    inputEnvironmentProvider !== undefined &&
    providerInputsControlRequired(inputEnvironmentProvider);

  const submissionProviderInputs = useMemo((): JsonValue | null => {
    if (!providerTakesInputs) return null;

    if (activeProviderInputsOverride !== null) {
      return activeProviderInputsOverride.value;
    }

    const seededInputs =
      !seedOverridden &&
      environmentSeed !== null &&
      effectiveEnvironmentValue === environmentSeed.selectionValue
        ? environmentSeed.providerInputs
        : null;

    if (seededInputs !== null) return seededInputs;

    const defaultInputs =
      inputEnvironmentProvider === undefined
        ? undefined
        : CORE_WORKSPACE_DEFAULT_INPUTS.get(inputEnvironmentProvider.id);

    if (defaultInputs !== undefined) return defaultInputs;

    return environmentProviderInputsRegistration === undefined &&
      !controlRequiredForSelectedProvider
      ? {}
      : null;
  }, [
    activeProviderInputsOverride,
    controlRequiredForSelectedProvider,
    seedOverridden,
    effectiveEnvironmentValue,
    environmentSeed,
    environmentProviderInputsRegistration,
    inputEnvironmentProvider,
    providerTakesInputs,
  ]);

  const environmentInputsPending =
    providerTakesInputs &&
    environmentProviderInputsRegistration !== undefined &&
    activeProviderInputsBlocked === null &&
    submissionProviderInputs === null;

  const environmentProviderInputsBlocker =
    inputEnvironmentProvider === undefined || !providerTakesInputs
      ? null
      : activeProviderInputsBlocked !== null
        ? activeProviderInputsBlocked.reason
        : environmentProviderInputsRegistration === undefined &&
            controlRequiredForSelectedProvider
          ? `${inputEnvironmentProvider.displayName} needs its plugin's control`
          : submissionProviderInputs === null
            ? `Configure ${inputEnvironmentProvider.displayName}`
            : null;

  const environmentProviderInputsSlot = useMemo(() => {
    if (environmentProviderInputsRegistration === undefined) return null;
    const InputsComponent = environmentProviderInputsRegistration.component;

    return (
      <PluginSlotMount
        pluginId={environmentProviderInputsRegistration.pluginId}
        slotKind="environmentProviderInputs"
        slotId={environmentProviderInputsRegistration.environmentProviderId}
      >
        <InputsComponent
          projectId={isProjectless ? null : projectId}
          target={
            providerHostId === null
              ? { kind: "new-host" }
              : { kind: "existing-host", hostId: providerHostId }
          }
          value={submissionProviderInputs}
          onChange={handleProviderInputsChange}
        />
      </PluginSlotMount>
    );
  }, [
    handleProviderInputsChange,
    isProjectless,
    projectId,
    providerHostId,
    submissionProviderInputs,
    environmentProviderInputsRegistration,
  ]);

  const compositionMachineProvider =
    selectedEnvironmentProvider?.machineProviderId === undefined ||
    selectedEnvironmentProvider.machineProviderId === null ||
    selectedEnvironmentProvider.machineInputs === undefined ||
    selectedEnvironmentProvider.machineAcceptsEmptyInputs === undefined ||
    selectedEnvironmentProvider.machineProviderPluginId === undefined
      ? null
      : {
          id: selectedEnvironmentProvider.machineProviderId,
          displayName: selectedEnvironmentProvider.displayName,
          pluginId: selectedEnvironmentProvider.machineProviderPluginId,
          inputs: selectedEnvironmentProvider.machineInputs,
          acceptsEmptyInputs:
            selectedEnvironmentProvider.machineAcceptsEmptyInputs,
        };

  const seededMachineInputs =
    !seedOverridden &&
    environmentSeed?.selectionValue === effectiveEnvironmentValue &&
    environmentSeed.providerMachine?.type === "new" &&
    environmentSeed.providerMachine.machineProviderId ===
      compositionMachineProvider?.id
      ? environmentSeed.providerMachine.inputs
      : undefined;

  const machineProviderInputs = useMachineProviderInputs({
    provider: compositionMachineProvider,
    initialValue: seededMachineInputs,
    instanceId: `new-thread-${projectId}`,
  });

  const compositionMachineProviderId = compositionMachineProvider?.id ?? null;

  const compositionMachineInputsSchema =
    compositionMachineProvider?.inputs ?? null;

  const selectedEnvironment = useMemo(
    () =>
      resolveRootComposeThreadEnvironment({
        environmentValue: effectiveEnvironmentValue,
        projectId,
        environmentProviders,
        providerMachine:
          compositionMachineProviderId !== null &&
          compositionMachineInputsSchema !== null
            ? {
                type: "new",
                machineProviderId: compositionMachineProviderId,
                inputs: machineProviderInputs.value,
              }
            : providerMachine,
        providerMachineChoice,
        providerInputs: submissionProviderInputs,
      }),
    [
      effectiveEnvironmentValue,
      environmentProviders,
      projectId,
      submissionProviderInputs,
      compositionMachineInputsSchema,
      compositionMachineProviderId,
      machineProviderInputs.value,
      providerMachineChoice,
      providerMachine,
    ],
  );

  const attachmentTargetHostId =
    parsedEnvironment?.type === "reuse"
      ? (projectThreads?.find(
          (thread) => thread.environmentId === parsedEnvironment.environmentId,
        )?.environmentHostId ??
        (seededReuseEnvironmentRow?.id === parsedEnvironment.environmentId
          ? seededReuseEnvironmentRow.hostId
          : null))
      : selectedEnvironment?.type === "provider" &&
          selectedEnvironment.machine?.type === "existing"
        ? selectedEnvironment.machine.hostId
        : null;

  const initialPromptDraft = useInitialPromptDraft(seed?.initialPrompt ?? null);
  const seedInitialPrompt = promptDraft.restoreIfEmpty;

  const focusPromptBox = useCallback(() => {
    setLocalPromptBoxFocusRequest((current) => (current ?? 0) + 1);
  }, []);

  useEffect(() => {
    if (!initialPromptDraft?.text) return;
    seedInitialPrompt(initialPromptDraft);
  }, [initialPromptDraft, seedInitialPrompt]);
  const [isCopyingAttachments, setIsCopyingAttachments] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isCopyingAttachmentsRef = useRef(false);
  const isSubmittingRef = useRef(false);

  const addUploadedAttachment = useCallback(
    (attachment: PromptDraftAttachment) => {
      getPromptDraftAccessor(
        resolvePendingThreadDraftScope(draftStorage),
      ).addAttachment(attachment);
    },
    [draftStorage],
  );

  const {
    attachmentError,
    setAttachmentError,
    handleAttachFiles,
    isAttachingFiles: isUploading,
    pendingUploads,
    capturePendingUploads,
  } = useDraftAttachmentUploads({
    projectId,
    target: {
      key: promptDraft.storageKey,
      addAttachment: addUploadedAttachment,
    },
  });

  const changeProject = useCallback(
    async (nextProjectId: string | null): Promise<ProjectChangeOutcome> => {
      const nextValue = nextProjectId ?? PERSONAL_PROJECT_ID;

      if (nextValue === projectId) return "unchanged";

      if (
        isCopyingAttachmentsRef.current ||
        pendingUploads.length > 0 ||
        isSubmittingRef.current
      ) {
        return "refused";
      }

      const attachmentPaths = getProjectStoredPromptAttachmentPaths(
        promptDraft.getCurrent().attachments,
      );

      isCopyingAttachmentsRef.current = true;
      setIsCopyingAttachments(true);

      try {
        if (attachmentPaths.length > 0) {
          setAttachmentError(null);

          try {
            await sdk.projects.attachments.copy({
              projectId: nextValue,
              sourceProjectId: projectId,
              paths: attachmentPaths,
            });
          } catch (error) {
            setAttachmentError(
              getMutationErrorMessage({
                error,
                fallbackMessage:
                  "Attachments could not be moved to the selected project",
              }),
            );

            return "refused";
          }
        }

        snapshotDraftBeforeOptionChange();
        await onProjectChange(nextValue);

        return "changed";
      } finally {
        isCopyingAttachmentsRef.current = false;
        setIsCopyingAttachments(false);
      }
    },
    [
      onProjectChange,
      projectId,
      promptDraft,
      snapshotDraftBeforeOptionChange,
      pendingUploads.length,
      setAttachmentError,
    ],
  );

  const handleProjectChange = useCallback(
    async (nextProjectId: string | null) => {
      await changeProject(nextProjectId);
    },
    [changeProject],
  );

  const reuseEnvironmentId =
    parsedEnvironment?.type === "reuse"
      ? parsedEnvironment.environmentId
      : null;

  const projectHostId =
    !providerRoutingReady || reuseEnvironmentId !== null
      ? null
      : (providerHostId ?? defaultHostId);

  const panelThreadId = resolvePanelThreadId(
    reuseEnvironmentId,
    reuseThreadOptions,
  );

  const promptMentions = usePromptMentions(
    isProjectless ? undefined : projectId,
    {
      environmentId: reuseEnvironmentId,
      hostId: projectHostId,
      threadStorageThreadId: panelThreadId ?? undefined,
    },
  );

  const defaultMentionLinkResolver = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? projectId;

        return () =>
          navigate(
            getThreadRoutePath({
              projectId: targetProjectId,
              threadId: resource.threadId,
            }),
          );
      }

      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }

      return null;
    },
    [navigate, projectId],
  );

  const [commandState, setCommandState] = useState<{
    query: string | null;
    trigger: import("@omnyo/domain").PromptMentionCommandTrigger | null;
  }>({ query: null, trigger: null });

  const providerPromptActions = useMemo(
    () => buildProviderPromptActionProps(selectedProviderComposerActions),
    [selectedProviderComposerActions],
  );

  const { promptActions } = providerPromptActions;

  const commandSuggestions = useCommandSuggestions({
    projectId,
    providerId: selectedProviderId,
    commandScope: "new-thread",
    skillsTriggers: providerPromptActions.skillsTriggers,
    activeTrigger: commandState.trigger,
    promptActions,
    environmentId: reuseEnvironmentId,
    hostId: projectHostId,
    query: commandState.query,
  });

  const promptHistoryEnabled = usePromptHistoryEnabled();

  const { data: projectPromptHistory = [] } = useProjectPromptHistory(
    projectId,
    { enabled: promptHistoryEnabled && sidebarNavigationSettled },
  );

  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(projectPromptHistory),
    [projectPromptHistory],
  );

  const promptInputEmpty = usePromptDraftInputEmpty(promptDraft);

  const submitProgrammaticallyRef = useRef<
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: NewThreadComposerSubmission["pluginSubmission"],
    ) => Promise<void>
  >(async () => {});

  const submitProgrammaticallyThroughRef = useCallback(
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: NewThreadComposerSubmission["pluginSubmission"],
    ) => submitProgrammaticallyRef.current(options, pluginSubmission),
    [],
  );

  const seededExecutionInputSources = useMemo(
    (): CreateExecutionInputSources => ({
      ...(seed?.providerId !== undefined
        ? { providerId: "explicit" as const }
        : {}),
      ...(seed?.model !== undefined ? { model: "explicit" as const } : {}),
      ...(seed?.reasoningLevel !== undefined
        ? { reasoningLevel: "explicit" as const }
        : {}),
      ...(seed?.serviceTier !== undefined && supportsServiceTier && serviceTier
        ? { serviceTier: "explicit" as const }
        : {}),
      ...(seed?.permissionMode !== undefined
        ? { permissionMode: "explicit" as const }
        : {}),
    }),
    [
      seed?.model,
      seed?.permissionMode,
      seed?.providerId,
      seed?.reasoningLevel,
      seed?.serviceTier,
      serviceTier,
      supportsServiceTier,
    ],
  );

  const submissionEnvironment = selectedProviderMachineUnavailable
    ? null
    : (selectedEnvironment ??
      (selectionScope === "new-thread" ? seed?.environment : undefined) ??
      null);

  const submissionReadinessReason = resolveNewThreadSubmitDisabledReason({
    environmentProviderInputsBlocker:
      machineProviderInputs.blockedReason ?? environmentProviderInputsBlocker,
    environmentSetupRequiredReason:
      environmentSetupRequiredReason ?? machineServerAccessReason,
    isCopyingAttachments,
    isLoadingModels: isLoadingModels && selectedThreadModel.length === 0,
    isSubmitting: false,
    isUploading: false,
    modelLoadError,
    projectDefaultsStatus: projectDefaultsState.status,
    projectDefaultsUnavailable,
    promptInputEmpty: false,
    providerDisplayName: selectedProviderDisplayName,
    selectedProviderId,
    selectedThreadModel,
    submissionEnvironmentUnavailable: submissionEnvironment === null,
  });

  const submitDisabledReason =
    (isSubmitting ? "Starting thread..." : submissionReadinessReason) ??
    (promptInputEmpty && pendingUploads.length === 0
      ? "Enter a prompt or attach a file."
      : null);

  const submitDraft = useCallback(
    async (
      blockedReason: string | null,
      submitOptions: ExperimentalComposerSubmitOptions | null,
      pluginSubmission?: NewThreadComposerSubmission["pluginSubmission"],
      explicitDraft?: PromptDraftState,
      explicitUploads?: CapturedAttachmentUploads | null,
      sendReservation?: ComposerSendSlot,
    ) => {
      const submittedDraft = explicitDraft ?? promptDraft.getCurrent();
      const input = promptDraftToInput(submittedDraft);
      let heldWait: ExpectedPluginWait | undefined;
      let invalidHint: string | null = null;

      try {
        heldWait = expectedPluginWait(submitOptions, pluginSubmission);
      } catch (hintError) {
        invalidHint =
          hintError instanceof Error ? hintError.message : String(hintError);
      }

      const hasPendingUploads =
        explicitDraft === undefined
          ? pendingUploads.length > 0
          : (explicitUploads?.files.length ?? 0) > 0;

      if (
        blockedReason !== null ||
        invalidHint !== null ||
        submissionReadinessReason !== null ||
        (input.length === 0 && !hasPendingUploads) ||
        (explicitDraft === undefined && isSubmittingRef.current) ||
        projectDefaultsUnavailable ||
        submissionEnvironment === null ||
        !selectedProviderId ||
        !selectedThreadModel
      ) {
        sendReservation?.cancel();

        if (explicitDraft !== undefined) {
          explicitUploads?.restore();
          restoreFailedPromptDraft(
            resolvePendingThreadDraftScope(draftStorage),
            submittedDraft,
          );
        }

        throw new Error(
          blockedReason ??
            invalidHint ??
            submissionReadinessReason ??
            (input.length === 0
              ? "Type a message first."
              : "This composer is not ready to submit yet."),
        );
      }

      const sources: CreateExecutionInputSources = {
        providerId: "client-preference",
        model: "client-preference",
        reasoningLevel: "client-preference",
        ...executionInputSources,
        ...seededExecutionInputSources,
      };

      const uploads =
        explicitDraft === undefined
          ? capturePendingUploads()
          : (explicitUploads ?? null);

      const attachmentSubmission = prepareComposerAttachmentSubmission({
        scope: draftStorage,
        draft: submittedDraft,
        uploads,
      });

      const request: NewThreadComposerSubmission = {
        projectId,
        providerId: selectedProviderId,
        model: selectedThreadModel,
        reasoningLevel,
        permissionMode,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        ...(Object.keys(sessionOptionSelections).length > 0
          ? { sessionOptions: sessionOptionSelections }
          : {}),
        executionInputSources: sources,
        environment: submissionEnvironment,
        input: attachmentSubmission.input,
        ...(sendReservation === undefined ? {} : { sendReservation }),
        ...(uploads === null
          ? {}
          : {
              capturedUploads: uploads,
              prepareInput: attachmentSubmission.prepareInput,
            }),
        ...(submitOptions?.sendAt === undefined
          ? {}
          : { sendAt: submitOptions.sendAt }),
        ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
        ...(heldWait === undefined ? {} : { expectedPluginWait: heldWait }),
      };

      if (explicitDraft === undefined) {
        isSubmittingRef.current = true;
        setIsSubmitting(true);
      }

      setAttachmentError(null);

      const clearedSubmittedDraft =
        explicitDraft === undefined &&
        promptDraft.clearIfCurrentMatches(submittedDraft);

      recordTelemetryEvent({
        name: "new_thread_submit",
        properties: { outcome: "started" },
      });

      try {
        let submission: void | Promise<void>;

        try {
          registerNewChatStagedCallback(request, () =>
            attachmentSubmission.complete(),
          );
          submission = onSubmit(request);

          if (explicitDraft === undefined) clearReuseEnvironment();
        } finally {
          if (explicitDraft === undefined) {
            isSubmittingRef.current = false;
            setIsSubmitting(false);
          }
        }

        await submission;
        attachmentSubmission.complete();
        recordTelemetryEvent({
          name: "new_thread_submit",
          properties: { outcome: "accepted" },
        });
      } catch (submitError) {
        recordTelemetryEvent({
          name: "new_thread_submit",
          properties: { outcome: "failed" },
        });

        if (
          clearedSubmittedDraft ||
          explicitDraft !== undefined ||
          uploads !== null
        ) {
          attachmentSubmission.restoreFailed((failedDraft) =>
            restoreFailedPromptDraft(
              resolvePendingThreadDraftScope(draftStorage),
              failedDraft,
            ),
          );
        } else {
          attachmentSubmission.complete();
        }

        throw submitError;
      }
    },
    [
      clearReuseEnvironment,
      capturePendingUploads,
      pendingUploads.length,
      draftStorage,
      executionInputSources,
      onSubmit,
      permissionMode,
      projectDefaultsUnavailable,
      projectId,
      promptDraft,
      reasoningLevel,
      seededExecutionInputSources,
      submissionReadinessReason,
      submissionEnvironment,
      selectedProviderId,
      selectedThreadModel,
      serviceTier,
      sessionOptionSelections,
      setAttachmentError,
      supportsServiceTier,
    ],
  );

  const submitExplicitDraft = useCallback<
    NonNullable<PluginComposerHost["submitDraft"]>
  >(
    (draft, options, pluginSubmission, reservation, uploads) =>
      submitDraft(null, options, pluginSubmission, draft, uploads, reservation),
    [submitDraft],
  );

  const handleSubmit = useCallback(
    async (blockedReason: string | null) => {
      try {
        await submitDraft(blockedReason, null);
      } catch {}
    },
    [submitDraft],
  );

  useEffect(() => {
    submitProgrammaticallyRef.current = async (
      submitOptions,
      pluginSubmission,
    ) => {
      await submitDraft(null, submitOptions, pluginSubmission);
    };
  }, [submitDraft]);

  const handleProviderChange = useDraftPreservingOptionChange(
    selectedProviderId,
    setSelectedProviderId,
    snapshotDraftBeforeOptionChange,
  );

  const handleModelChange = useDraftPreservingOptionChange(
    selectedModel,
    setSelectedModel,
    snapshotDraftBeforeOptionChange,
  );

  const handleReasoningChange = useDraftPreservingOptionChange(
    reasoningLevel,
    setReasoningLevel,
    snapshotDraftBeforeOptionChange,
  );

  const handlePermissionChange = useDraftPreservingOptionChange(
    permissionMode,
    setPermissionMode,
    snapshotDraftBeforeOptionChange,
  );

  const handleServiceTierChange = useDraftPreservingOptionChange(
    serviceTier,
    setServiceTier,
    snapshotDraftBeforeOptionChange,
  );

  const handleWorktreeChange = useCallback(
    (environmentId: string) => {
      changeEnvironment(encodeReuseValue(environmentId));
    },
    [changeEnvironment],
  );

  const handleSelectReuse = useCallback(() => {
    changeEnvironment(REUSE_VALUE_WITHOUT_ENVIRONMENT);
  }, [changeEnvironment]);

  const pickerLocksRef = useRef<NewThreadComposerLocks>({});

  const applyExecutionTuple = useCallback(
    (selection: ModelPickerSelection) => {
      const locks = pickerLocksRef.current;

      if (
        locks.execution ||
        (locks.provider && selection.providerId !== selectedProviderId)
      ) {
        return;
      }

      const changesServiceTier =
        selection.serviceTier !== undefined &&
        serviceTierSupportByProvider[selection.providerId] === true &&
        selection.serviceTier !== serviceTier;

      if (
        selection.providerId === selectedProviderId &&
        selection.model === selectedThreadModel &&
        selection.reasoningLevel === reasoningLevel &&
        !changesServiceTier
      ) {
        return;
      }

      snapshotDraftBeforeOptionChange();
      setProviderModelReasoning(selection);
    },
    [
      reasoningLevel,
      selectedProviderId,
      selectedThreadModel,
      serviceTier,
      serviceTierSupportByProvider,
      setProviderModelReasoning,
      snapshotDraftBeforeOptionChange,
    ],
  );

  const selectionState =
    useCommittedComposerState<NewThreadComposerSelectionState>((version) => ({
      version,
      isSettled:
        providerRoutingReady &&
        modelCatalogIsSettled &&
        !environmentInputsPending,
      requestedProjectId: requestedCandidate,
      projectId,
      selectedProviderId,
      selectedThreadModel,
      reasoningLevel,
      serviceTier,
      supportsServiceTier,
      permissionMode,
      submissionEnvironment,
      providerIds,
      changeProject,
      changeEnvironment,
      changeProvider: handleProviderChange,
      changeModel: handleModelChange,
      changeReasoning: handleReasoningChange,
      changeServiceTier: handleServiceTierChange,
      changeExecution: applyExecutionTuple,
      changePermissionMode: handlePermissionChange,
    }));

  const composerSelection = useMemo(
    () => ({
      projectId,
      ...(submissionEnvironment === null
        ? {}
        : { environment: submissionEnvironment }),
      ...readExecutionSelection({
        selectedProviderId,
        selectedThreadModel,
        reasoningLevel,
        serviceTier,
        supportsServiceTier,
        permissionMode,
      }),
    }),
    [
      permissionMode,
      projectId,
      reasoningLevel,
      selectedProviderId,
      selectedThreadModel,
      serviceTier,
      submissionEnvironment,
      supportsServiceTier,
    ],
  );

  const { getSelection, subscribeSelection } = useComposerHostSelection(
    promptDraft.storageKey,
    composerSelection,
  );

  const pendingSelectionRef = useRef<Promise<unknown>>(Promise.resolve());

  const applySelection = useCallback(
    async (
      selection: ExperimentalComposerSelection,
    ): Promise<ExperimentalComposerSelection> => {
      const deadline = resolveComposerSelectionDeadline();
      const { observer } = selectionState;
      let state = await observer.waitUntil(() => true, deadline);

      const settle = async (requireSettled: boolean) => {
        state = await waitForSettledComposerState(
          selectionState,
          deadline,
          requireSettled,
        );
      };

      const ensureSettled = async () => {
        if (state.isSettled) return;
        state = await waitUntilComposerStateSettled(selectionState, deadline);
      };

      const locks = pickerLocksRef.current;
      let projectRefused = false;

      if (selection.projectId !== undefined && !locks.project) {
        const requestedProjectId = selection.projectId;
        const outcome = await state.changeProject(requestedProjectId);
        projectRefused = outcome === "refused";

        if (outcome === "changed") {
          state = await observer.waitUntil(
            (next) => next.requestedProjectId === requestedProjectId,
            deadline,
          );
        }
      }

      if (
        selection.environment !== undefined &&
        !locks.environment &&
        !projectRefused
      ) {
        const seed = newThreadEnvironmentArgsToSeed(selection.environment);

        if (seed !== null) {
          state.changeEnvironment(
            seed.selectionValue,
            seed.providerMachine,
            seed.appliedInputs,
          );
          await settle(false);
        }
      }

      if (selection.providerId !== undefined) await ensureSettled();

      const requestedTuple = readExecutionTuple(selection, state.providerIds);

      const executionTuple =
        requestedTuple !== null &&
        !locks.execution &&
        (!locks.provider ||
          requestedTuple.providerId === state.selectedProviderId)
          ? requestedTuple
          : null;

      if (executionTuple !== null) {
        state.changeExecution(executionTuple);
        await settle(true);
      } else {
        if (
          selection.providerId !== undefined &&
          !locks.provider &&
          selection.providerId !== state.selectedProviderId &&
          state.providerIds.includes(selection.providerId)
        ) {
          state.changeProvider(selection.providerId);
          await settle(true);
        }

        const providerMatches =
          selection.providerId === undefined ||
          state.selectedProviderId === selection.providerId;

        if (
          providerMatches &&
          !locks.execution &&
          selection.model !== undefined
        ) {
          await ensureSettled();
          state.changeModel(selection.model);
          await settle(false);
        }

        if (
          providerMatches &&
          !locks.execution &&
          selection.reasoningLevel !== undefined
        ) {
          await ensureSettled();
          state.changeReasoning(selection.reasoningLevel);
          await settle(false);
        }

        if (
          !locks.execution &&
          selection.serviceTier !== undefined &&
          state.supportsServiceTier
        ) {
          state.changeServiceTier(selection.serviceTier);
          await settle(false);
        }
      }

      if (!locks.execution && selection.permissionMode !== undefined) {
        state.changePermissionMode(selection.permissionMode);
        await settle(false);
      }

      await settle(true);

      return readNewThreadComposerSelection(state);
    },
    [selectionState],
  );

  const setSelection = useCallback(
    (selection: ExperimentalComposerSelection) => {
      const run = pendingSelectionRef.current.then(
        () => applySelection(selection),
        () => applySelection(selection),
      );

      pendingSelectionRef.current = run;

      return run;
    },
    [applySelection],
  );

  const rankedProjectIds = useMemo(
    () =>
      rankLauncherProjects(
        sidebarNavigationQuery.data?.projects ?? [],
        Date.now(),
      ),
    [sidebarNavigationQuery.data],
  );

  const dockConfig = useMemo<NewChatDockConfig>(
    () => ({
      where: describeWhere(
        submissionEnvironment,
        isProjectless,
        reuseThreadOptions,
      ),
      defaultThreadMachineId,
      rankedProjectIds,
      select: setSelection,
    }),
    [
      defaultThreadMachineId,
      isProjectless,
      rankedProjectIds,
      reuseThreadOptions,
      setSelection,
      submissionEnvironment,
    ],
  );

  const pluginComposerHost = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "new-thread", projectId },
      draftScope: draftStorage,
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      getSelection,
      subscribeSelection,
      setDraft: promptDraft.setDraft,
      focus: focusPromptBox,
      submit: submitProgrammaticallyThroughRef,
      submitDraft: submitExplicitDraft,
      captureAttachments: capturePendingUploads,
      ...(draftStorage.kind === "thread" &&
      isPendingChatId(draftStorage.threadId)
        ? {
            reserveSubmission: () =>
              reservePendingChatSubmission(draftStorage.threadId),
          }
        : {}),
      setSelection,
    }),
    [
      focusPromptBox,
      draftStorage,
      getSelection,
      projectId,
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      setSelection,
      subscribeSelection,
      submitProgrammaticallyThroughRef,
      submitExplicitDraft,
      capturePendingUploads,
    ],
  );

  const restoreHistoryDraft = useCallback(
    (draft: PromptDraftState) =>
      createCoreComposerActions(pluginComposerHost).restoreDraft(draft),
    [pluginComposerHost],
  );

  const renderPromptBox = useCallback(
    (options: NewThreadComposerPromptOptions) => {
      const locks = options.locks ?? {};
      pickerLocksRef.current = locks;
      const disabledReason = options.blockedReason ?? submitDisabledReason;

      return (
        <LiveDraftNewThreadPromptBox
          promptDraft={promptDraft}
          id={options.id}
          promptBoxRef={options.promptBoxRef}
          focusRequest={promptBoxFocusRequest}
          onChange={promptDraft.setTextAndMentions}
          onSubmit={() => void handleSubmit(options.blockedReason ?? null)}
          isSubmitting={isSubmitting}
          disabled={disabledReason !== null}
          disabledReason={disabledReason ?? undefined}
          placeholder={options.placeholder}
          mentionMenuPlacement={options.mentionMenuPlacement}
          autoFocus={options.autoFocus}
          pluginComposerHost={options.pluginComposerHost ?? pluginComposerHost}
          textEffects={options.textEffects ?? textEffects}
          history={{
            entries: promptHistoryDrafts,
            onSelectEntry: restoreHistoryDraft,
            resetKey: projectId,
          }}
          typeahead={{
            mention: {
              triggers: promptMentions.triggers,
              results: promptMentions.results,
              isLoading: promptMentions.isLoading,
              isRefreshing: promptMentions.isRefreshing,
              isError: promptMentions.isError,
              onQueryChange: promptMentions.setQuery,
              resolveLink:
                options.resolveMentionLink ?? defaultMentionLinkResolver,
            },
            command: {
              triggers: commandSuggestions.triggers,
              suggestions: commandSuggestions.suggestions,
              isLoading: commandSuggestions.isLoading,
              isUpdating: commandSuggestions.isUpdating,
              isError: commandSuggestions.isError,
              errorMessage: commandSuggestions.errorMessage,
              hasMore: commandSuggestions.hasMore,
              isLoadingMore: commandSuggestions.isLoadingMore,
              loadMore: commandSuggestions.loadMore,
              onQueryChange: (query, trigger) =>
                setCommandState({ query, trigger }),
            },
          }}
          attachments={{
            pendingUploads,
            projectId,
            targetHostId: attachmentTargetHostId,
            onAttachFiles: handleAttachFiles,
            onUpdate: promptDraft.updateAttachments,
            isAttaching: isUploading || isCopyingAttachments,
            error: attachmentError,
          }}
          promptActions={promptActions}
          modeConfig={{
            environment: {
              value: effectiveEnvironmentValue,
              sources: projectSources,
              disabled: locks.environment,
              isLoading: environmentProviders === undefined,
              providers: environmentProviders ?? [],
              providersByHostId: environmentProvidersByHostId,
              selectedProviderHostId: providerHostId,
              inputsControlProviderIds,
              onSelectProvider: handleSelectProvider,
              onSelectHost: handleSelectHost,
              onSelectReuse: handleSelectReuse,
              ...(!isProjectless && options.onRequestMachineSetup
                ? { onRequestMachineSetup: options.onRequestMachineSetup }
                : {}),
            },
            worktree: {
              options: reuseThreadOptions,
              value: reuseEnvironmentId,
              onChange: handleWorktreeChange,
              disabled: locks.environment,
            },
            permission: {
              value: permissionMode,
              options: permissionModeOptions,
              onChange: handlePermissionChange,
              supported: supportsPermissionModeSelection && !locks.execution,
            },
            sessionOptionsControl:
              placedSessionOptions.footer.length === 0 ||
              locks.execution ? null : (
                <SessionOptionsMenu
                  options={placedSessionOptions.footer}
                  choices={NO_SESSION_OPTION_CHOICES}
                  onChange={setSessionOption}
                />
              ),
            environmentProviderInputsSlot: locks.environment
              ? null
              : environmentProviderInputsSlot,
            machineProviderInputsSlot: locks.environment
              ? null
              : machineProviderInputs.control,
            banner:
              options.banner ??
              (machineServerAccessReason !== null ? (
                <ProviderRequirementBanner
                  title={MACHINE_SERVER_ACCESS_TITLE}
                  description={machineServerAccessReason}
                  action={
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 shrink-0 px-3"
                      onClick={() => navigate(getSettingsRoutePath("machines"))}
                    >
                      Set up machine access
                    </Button>
                  }
                />
              ) : setupRequiredProvider === null ? null : (
                <ProviderRequirementBanner
                  title={`${setupRequiredProvider.displayName} needs configuration`}
                  description={environmentSetupRequiredReason}
                  action={
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 shrink-0 px-3"
                      onClick={() =>
                        navigate(
                          getPluginConfigurationRoutePath({
                            pluginId: setupRequiredProvider.pluginId,
                          }),
                        )
                      }
                    >
                      Configure {setupRequiredProvider.displayName}
                    </Button>
                  }
                />
              )),
            header: options.header,
          }}
          project={{
            projects: projectOptions,
            value: options.allowNoProject && isProjectless ? null : projectId,
            onChange: handleProjectChange,
            allowNoProject: options.allowNoProject,
            createProject: options.createProject,
            isLoading: !sidebarNavigationSettled,
            disabled:
              locks.project ||
              isUploading ||
              isCopyingAttachments ||
              isSubmitting,
            showChevronWhenDisabled: !locks.project,
          }}
          dock={
            options.selectionLayout === "dock" ||
            options.selectionLayout === "stage"
              ? dockConfig
              : undefined
          }
          dockLayout={
            options.selectionLayout === "stage" ? "stage" : "launcher"
          }
          projectShelf={options.projectShelf ?? null}
          execution={{
            disabled: locks.execution,
            providerRouting: executionOptionsRouting,
            catalog: {
              providers: executionProviders,
              verified: modelCatalogIsVerified,
              modelOptions: catalogModelOptions,
            },
            selection: { onChange: applyExecutionTuple },
            favoriteChips: !locks.provider && !locks.execution,
            selects: MODEL_PICKER_SELECTS[selectionScope],
            provider: {
              options: providerOptions,
              selectedId: selectedProviderId,
              onChange: locks.provider ? undefined : handleProviderChange,
              hasMultiple: hasMultipleProviders,
              sessionOptionSelectionsForProvider,
            },
            model: {
              active: activeModel,
              selected: selectedModel,
              options: modelOptions,
              moreOptions: moreModelOptions,
              isLoading: isLoadingModels,
              loadFailed: modelLoadFailed,
              loadError: modelLoadError,
              notice: modelNotice,
              onChange: handleModelChange,
            },
            serviceTier: {
              value: serviceTier,
              onChange: handleServiceTierChange,
              supported: supportsServiceTier,
              options: serviceTierOptions,
            },
            reasoning: {
              value: reasoningLevel,
              options: reasoningOptions,
              onChange: handleReasoningChange,
            },
            ...(pickerSessionOptionSections.length === 0
              ? {}
              : {
                  agentOptions: {
                    sections: pickerSessionOptionSections,
                    onChange: setSessionOption,
                  },
                }),
          }}
        />
      );
    },
    [
      activeModel,
      applyExecutionTuple,
      attachmentError,
      attachmentTargetHostId,
      catalogModelOptions,
      commandSuggestions,
      defaultMentionLinkResolver,
      effectiveEnvironmentValue,
      environmentProviders,
      environmentProvidersByHostId,
      executionOptionsRouting,
      executionProviders,
      handleAttachFiles,
      handleModelChange,
      handlePermissionChange,
      handleProjectChange,
      handleProviderChange,
      handleReasoningChange,
      handleSelectProvider,
      handleSelectHost,
      handleSelectReuse,
      handleServiceTierChange,
      handleSubmit,
      handleWorktreeChange,
      hasMultipleProviders,
      isCopyingAttachments,
      isLoadingModels,
      isProjectless,
      isSubmitting,
      isUploading,
      dockConfig,
      pendingUploads,
      modelCatalogIsVerified,
      modelLoadError,
      modelNotice,
      modelLoadFailed,
      modelOptions,
      moreModelOptions,
      permissionMode,
      permissionModeOptions,
      projectId,
      projectOptions,
      projectSources,
      promptActions,
      promptBoxFocusRequest,
      promptDraft,
      promptHistoryDrafts,
      restoreHistoryDraft,
      promptMentions,
      pluginComposerHost,
      providerOptions,
      reasoningLevel,
      reasoningOptions,
      reuseEnvironmentId,
      reuseThreadOptions,
      selectedModel,
      selectedProviderId,
      selectionScope,
      serviceTier,
      sessionOptionSelectionsForProvider,
      sidebarNavigationSettled,
      supportsPermissionModeSelection,
      supportsServiceTier,
      submitDisabledReason,
      machineServerAccessReason,
      setupRequiredProvider,
      environmentSetupRequiredReason,
      navigate,
      environmentProviderInputsSlot,
      machineProviderInputs.control,
      inputsControlProviderIds,
      providerHostId,
      textEffects,
      serviceTierOptions,
      pickerSessionOptionSections,
      placedSessionOptions.footer,
      setSessionOption,
    ],
  );

  return (
    <NewThreadComposerStateRenderer
      render={children}
      state={{
        projectId,
        isProjectless,
        projects,
        sidebarNavigationError: sidebarNavigationQuery.isError,
        currentProject,
        projectSources,
        connectedHostIds,
        primaryHostId,
        parsedEnvironment,
        projectHostId,
        panelThreadId,
        selectedProviderId,
        promptDraft,
        focusPromptBox,
        pluginComposerHost,
        textEffects,
        seedEnvironmentSelectionValue: setCreationEnvironmentSelectionValue,
        hostSelectionReady: providerRoutingReady,
        selectHostForNewEnvironment,
        setEnvironmentSelectionValue: changeEnvironment,
        setProviderModelReasoning,
        setPermissionMode,
        setServiceTier,
        renderPromptBox,
      }}
    />
  );
}
