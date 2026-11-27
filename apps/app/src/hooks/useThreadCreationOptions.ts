import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AvailableModel,
  PermissionMode,
  ProviderComposerAction,
  ProviderInfo,
  ProviderModelCatalogScope,
  ProviderOptionDescriptor,
  ReasoningLevel,
  ServiceTier,
  SessionOptionSelections,
  SessionOptionValue,
  ThreadSessionOption,
} from "@omnyo/domain";
import type {
  CreateExecutionInputSources,
  ExecutionInputFieldSource,
  ExistingThreadExecutionInputSources,
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsModelNotice,
  SystemProvidersQuery,
} from "@omnyo/server-contract";
import {
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
} from "@omnyo/client-core";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import type { ModelPickerSelection } from "@/components/pickers/model-picker-selection";
import { useModelPickerHiddenModelIds } from "@/components/pickers/modelPickerPreferences";
import type { ProviderPickerOption } from "@/components/pickers/model-brand-prefix";
import {
  encodeProviderValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { useRootComposeReuseEnvironment } from "@/lib/root-compose-selection";
import { getProviderIconInfo } from "@/lib/provider-icon";
import {
  DEFAULT_SERVICE_TIER,
  allowsFastServiceTier,
  newThreadPermissionMode,
  permissionModeRank,
  providerModelCatalogDependsOnWorkspace,
  reconcileServiceTier,
  resolveServiceTierOptions,
} from "@omnyo/domain";
import { selectPrimaryHost, useHosts } from "./queries/host-queries";
import {
  useKnownProviderModelCatalogScope,
  useSystemProviderStates,
  useSystemConfig,
  useSystemExecutionOptions,
} from "./queries/system-queries";
import {
  usePromptBoxEnvironmentPreference,
  usePromptBoxModelPreference,
  usePromptBoxPermissionModePreference,
  usePromptBoxProviderPreference,
  usePromptBoxReasoningLevelPreference,
  usePromptBoxSessionOptionsPreference,
  usePromptBoxSessionOptionsPreferences,
  usePromptBoxServiceTierPreference,
  useSetPromptBoxProviderModelReasoningPreference,
} from "./thread-creation-options/persisted-selection-fields";
import {
  buildExecutionInputSources,
  formatModelLabel,
  getInitialThreadPromptSelections,
  resolvePermissionModeSelection,
  syncUntouchedThreadPromptSelections,
  type ScopedExecutionInputSources,
  type ThreadPromptField,
  type ThreadPromptSelections,
  type UseComponentLocalCreationOptions,
  type UseNewThreadCreationOptions,
  type UsePromptModelReasoningOptions,
  updateThreadPromptSelections,
} from "./thread-creation-options/selection-state";
import {
  resolveModelCatalogSelection,
  resolveModelReasoningLevel,
} from "./thread-creation-options/model-catalog-selection";
import {
  useClaudeAccounts,
  type ClaudeProfileSelection,
} from "./useClaudeAccounts";

export { formatModelLabel };

const EMPTY_PROVIDERS: ProviderInfo[] = [];

const NO_SESSION_OPTION_SELECTIONS: SessionOptionSelections = {};

const EMPTY_COMPOSER_ACTIONS: ProviderComposerAction[] = [];

const EMPTY_SERVICE_TIER_OPTIONS: readonly ProviderOptionDescriptor[] = [];

const NO_PROVIDER_IDS: readonly string[] = [];

const DEFAULT_SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = ["full"];

const PERMISSION_CEILING_REASON =
  "Above the selected machine's permission limit. Change it in Settings → Machines.";

type StringSelectionSetter = (value: string) => void;

type ServiceTierSelectionSetter = (value: ServiceTier | undefined) => void;

type ReasoningLevelSelectionSetter = (value: ReasoningLevel) => void;

type PermissionModeSelectionSetter = (value: PermissionMode) => void;

type ClearSelectionHandler = () => void;

interface ModelReasoningSelection {
  model: string;
  reasoningLevel: ReasoningLevel;
}

type ProviderModelReasoningSelectionSetter = (
  selection: ModelPickerSelection,
) => void;

type SessionOptionSelectionsForProvider = (
  providerId: string,
) => SessionOptionSelections;

interface UseThreadCreationOptionsResult<TExecutionInputSources> {
  claudeProfileSelection: ClaudeProfileSelection | undefined;
  executionOptionsRouting: SystemProvidersQuery;
  selectedProviderId: string;
  setSelectedProviderId: StringSelectionSetter;
  setProviderModelReasoning: ProviderModelReasoningSelectionSetter;
  providers: readonly ProviderInfo[];
  providerOptions: ProviderPickerOption[];
  hasMultipleProviders: boolean;
  selectedProviderDisplayName: string;
  selectedProviderComposerActions: readonly ProviderComposerAction[];
  selectedModel: string;
  setSelectedModel: StringSelectionSetter;
  serviceTier: ServiceTier | undefined;
  setServiceTier: ServiceTierSelectionSetter;
  reasoningLevel: ReasoningLevel;
  setReasoningLevel: ReasoningLevelSelectionSetter;
  permissionMode: PermissionMode;
  setPermissionMode: PermissionModeSelectionSetter;
  environmentSelectionValue: string;
  setEnvironmentSelectionValue: StringSelectionSetter;
  clearReuseEnvironment: ClearSelectionHandler;
  activeModel: AvailableModel | undefined;
  modelOptions: ModelPickerOption[];
  moreModelOptions: ModelPickerOption[];
  catalogModelOptions: ModelPickerOption[];
  isLoadingModels: boolean;
  isLoadingReasoning: boolean;
  modelLoadFailed: boolean;
  modelLoadError: SystemExecutionOptionsModelLoadError | null;
  modelNotice: SystemExecutionOptionsModelNotice | null;
  modelCatalogIsVerified: boolean;
  modelCatalogIsSettled: boolean;
  reasoningOptions: PickerOption<ReasoningLevel>[];
  declaredSessionOptions: ThreadSessionOption[];
  sessionOptionSelections: SessionOptionSelections;
  sessionOptionSelectionsForProvider: SessionOptionSelectionsForProvider;
  setSessionOption: (optionId: string, value: SessionOptionValue) => void;
  permissionModeOptions: PickerOption<PermissionMode>[];
  supportsPermissionModeSelection: boolean;
  permissionModeIsVerified: boolean;
  supportsServiceTier: boolean;
  serviceTierSupportByProvider: Record<string, boolean>;
  serviceTierOptions: readonly ProviderOptionDescriptor[];
  executionInputSources: TExecutionInputSources;
}

interface ResolveThreadCreationProviderRoutingArgs {
  environmentId?: string;
  environmentHostId?: string;
  environmentSelectionValue: string;
  modelCatalogScope?: ProviderModelCatalogScope;
  scope: "component-local" | "new-thread";
}

function resolveThreadCreationProviderRouting({
  environmentId,
  environmentHostId,
  environmentSelectionValue,
  modelCatalogScope,
  scope,
}: ResolveThreadCreationProviderRoutingArgs): SystemProvidersQuery {
  if (scope === "component-local") {
    if (environmentId === undefined) {
      return {};
    }

    if (
      environmentHostId !== undefined &&
      !providerModelCatalogDependsOnWorkspace(modelCatalogScope)
    ) {
      return { hostId: environmentHostId };
    }

    return { environmentId };
  }

  const parsed = parseEnvironmentValue(environmentSelectionValue);

  if (parsed?.type === "reuse" && parsed.environmentId !== null) {
    return { environmentId: parsed.environmentId };
  }

  return {};
}

const NO_MODEL_LOAD_ERROR: SystemExecutionOptionsModelLoadError | null = null;

type InitialReadyProviderResolution =
  | { status: "unresolved" }
  | { status: "resolved"; providerId: string | null };

const LEGACY_MANAGED_WORKTREE_VALUE = /^host:[^:]+:worktree$/;

const LEGACY_HOST_LOCAL_VALUE = /^host:[^:]+:local$/;

function migrateLegacyStoredEnvironmentValue(stored: string): string {
  if (LEGACY_MANAGED_WORKTREE_VALUE.test(stored)) {
    return encodeProviderValue(GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID);
  }

  if (LEGACY_HOST_LOCAL_VALUE.test(stored)) {
    return encodeProviderValue(PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID);
  }

  return stored;
}

export function sanitizeStoredEnvironmentValue(stored: string): string {
  if (!stored) return "";
  const migrated = migrateLegacyStoredEnvironmentValue(stored);
  const parsed = parseEnvironmentValue(migrated);

  if (parsed?.type === "reuse") return "";

  return migrated;
}

export function useThreadCreationOptions(
  options: UseComponentLocalCreationOptions,
): UseThreadCreationOptionsResult<ExistingThreadExecutionInputSources>;
export function useThreadCreationOptions(
  options?: UseNewThreadCreationOptions,
): UseThreadCreationOptionsResult<CreateExecutionInputSources>;
export function useThreadCreationOptions(
  options: UsePromptModelReasoningOptions,
): UseThreadCreationOptionsResult<ScopedExecutionInputSources>;
export function useThreadCreationOptions(
  options?: UsePromptModelReasoningOptions,
): UseThreadCreationOptionsResult<ScopedExecutionInputSources> {
  const {
    claudeProfile,
    automaticClaudeProfile,
    claudeProjectId,
    resolveClaudeProfileHostId,
    enabled = true,
    environmentId,
    environmentHostId,
    initialEnvironmentSelectionValue,
    initialModel,
    initialProviderId,
    initialPermissionMode,
    initialReasoningLevel,
    initialServiceTier,
    preferReadyProviderWhenUnset = false,
    preferenceProjectId,
    resolveProviderRouting,
    resetKey,
    scope = "new-thread",
    sessionOptionSelections: sessionOptionSelectionsOverride,
  } = options ?? {};

  const { setValue: setStoredProviderId, value: storedProviderId } =
    usePromptBoxProviderPreference();

  const setStoredProviderModelReasoning =
    useSetPromptBoxProviderModelReasoningPreference();

  const { setValue: setStoredServiceTier, value: storedServiceTier } =
    usePromptBoxServiceTierPreference();

  const { setValue: setStoredPermissionMode, value: storedPermissionMode } =
    usePromptBoxPermissionModePreference();

  const {
    setValue: setStoredEnvironmentSelectionValue,
    value: storedEnvironmentSelectionValue,
  } = usePromptBoxEnvironmentPreference(preferenceProjectId);

  const [rootComposeReuseValue, setRootComposeReuseValue] =
    useRootComposeReuseEnvironment();

  const [threadSelections, setThreadSelections] =
    useState<ThreadPromptSelections>(() =>
      getInitialThreadPromptSelections({
        initialEnvironmentSelectionValue,
        initialModel,
        initialProviderId,
        initialPermissionMode,
        initialReasoningLevel,
        initialServiceTier,
      }),
    );

  const [initialReadyProvider, setInitialReadyProvider] =
    useState<InitialReadyProviderResolution>({ status: "unresolved" });

  const localProviderSelectionsRef = useRef<
    Map<string, ModelReasoningSelection>
  >(new Map());

  const [localProvidersUsingDefaults, setLocalProvidersUsingDefaults] =
    useState<ReadonlySet<string>>(() => new Set());

  const touchedThreadFieldsRef = useRef<Set<ThreadPromptField>>(new Set());

  const threadResetKeyRef = useRef<string | number | null | undefined>(
    resetKey,
  );

  const usesLocalThreadSelections = scope !== "new-thread";
  const usesStoredCreateSelections = scope === "new-thread";

  const [newThreadPermissionSelection, setNewThreadPermissionSelection] =
    useState<{ key: string; value: PermissionMode } | null>(null);

  const nextThreadSelections = useMemo(
    () =>
      getInitialThreadPromptSelections({
        initialEnvironmentSelectionValue,
        initialModel,
        initialProviderId,
        initialPermissionMode,
        initialReasoningLevel,
        initialServiceTier,
      }),
    [
      initialEnvironmentSelectionValue,
      initialModel,
      initialProviderId,
      initialPermissionMode,
      initialReasoningLevel,
      initialServiceTier,
    ],
  );

  const renderedThreadSelections = useMemo(() => {
    if (!usesLocalThreadSelections) {
      return nextThreadSelections;
    }

    if (threadResetKeyRef.current !== resetKey) {
      return nextThreadSelections;
    }

    return syncUntouchedThreadPromptSelections({
      currentSelections: threadSelections,
      nextSelections: nextThreadSelections,
      touchedFields: touchedThreadFieldsRef.current,
    });
  }, [
    nextThreadSelections,
    resetKey,
    threadSelections,
    usesLocalThreadSelections,
  ]);

  const selectedProviderIdBeforeReadyFallback = usesStoredCreateSelections
    ? storedProviderId || renderedThreadSelections.selectedProviderId
    : renderedThreadSelections.selectedProviderId;

  const rawServiceTier = usesStoredCreateSelections
    ? storedServiceTier || renderedThreadSelections.serviceTier
    : renderedThreadSelections.serviceTier;

  const rawPermissionMode = usesStoredCreateSelections
    ? storedPermissionMode || renderedThreadSelections.permissionMode
    : renderedThreadSelections.permissionMode;

  const rawEnvironmentSelectionValue =
    scope === "new-thread"
      ? (rootComposeReuseValue ??
        sanitizeStoredEnvironmentValue(storedEnvironmentSelectionValue))
      : renderedThreadSelections.environmentSelectionValue;

  const knownModelCatalogScope = useKnownProviderModelCatalogScope(
    selectedProviderIdBeforeReadyFallback,
  );

  const executionOptionsQueryEnabled = enabled;

  const routingSelectionKey = JSON.stringify([
    scope,
    resetKey,
    environmentId,
    rawEnvironmentSelectionValue,
    selectedProviderIdBeforeReadyFallback,
  ]);

  const [catalogRouting, setCatalogRouting] = useState(() => ({
    selectionKey: routingSelectionKey,
    routing: resolveThreadCreationProviderRouting({
      environmentId,
      environmentHostId,
      environmentSelectionValue: rawEnvironmentSelectionValue,
      modelCatalogScope: knownModelCatalogScope,
      scope,
    }),
  }));

  let defaultCatalogRouting = catalogRouting.routing;

  if (catalogRouting.selectionKey !== routingSelectionKey) {
    defaultCatalogRouting = resolveThreadCreationProviderRouting({
      environmentId,
      environmentHostId,
      environmentSelectionValue: rawEnvironmentSelectionValue,
      modelCatalogScope: knownModelCatalogScope,
      scope,
    });
    setCatalogRouting({
      selectionKey: routingSelectionKey,
      routing: defaultCatalogRouting,
    });
  }

  const executionOptionsRouting = resolveProviderRouting
    ? resolveProviderRouting(rawEnvironmentSelectionValue)
    : defaultCatalogRouting;

  const canResolveReadyProvider =
    executionOptionsQueryEnabled &&
    scope === "new-thread" &&
    preferReadyProviderWhenUnset &&
    selectedProviderIdBeforeReadyFallback.length === 0;

  const shouldResolveReadyProvider =
    canResolveReadyProvider && initialReadyProvider.status === "unresolved";

  const providerStatesQuery = useSystemProviderStates({
    enabled: shouldResolveReadyProvider,
    ...executionOptionsRouting,
    poll: false,
  });

  const queriedReadyProviderId = shouldResolveReadyProvider
    ? providerStatesQuery.data?.providers.find(
        (provider) => provider.status === "ready",
      )?.providerId
    : undefined;

  const readyProviderId =
    initialReadyProvider.status === "resolved"
      ? (initialReadyProvider.providerId ?? undefined)
      : queriedReadyProviderId;

  useEffect(() => {
    if (!shouldResolveReadyProvider || providerStatesQuery.isPending) {
      return;
    }

    setInitialReadyProvider((current) =>
      current.status === "resolved"
        ? current
        : {
            status: "resolved",
            providerId: queriedReadyProviderId ?? null,
          },
    );
  }, [
    providerStatesQuery.isPending,
    queriedReadyProviderId,
    shouldResolveReadyProvider,
  ]);

  const rawSelectedProviderId =
    selectedProviderIdBeforeReadyFallback || readyProviderId || "";

  const executionOptionsProviderId = executionOptionsQueryEnabled
    ? rawSelectedProviderId || undefined
    : undefined;

  const hostsQuery = useHosts();
  const systemConfig = useSystemConfig();

  const claudeHostId = resolveClaudeProfileHostId
    ? resolveClaudeProfileHostId(executionOptionsRouting)
    : (environmentHostId ??
      executionOptionsRouting.hostId ??
      selectPrimaryHost(
        hostsQuery.data ?? [],
        systemConfig.data?.primaryHostId ?? null,
      )?.id ??
      null);

  const claudeAccounts = useClaudeAccounts({
    hostId: claudeHostId,
    projectId: claudeProjectId ?? preferenceProjectId ?? "",
    enabled: enabled && rawSelectedProviderId === "claude-code",
  });

  const defaultClaudeProfile = claudeAccounts.data?.defaultSelection;

  const readyClaudeProfiles = automaticClaudeProfile
    ? (claudeAccounts.data?.profiles.filter(
        ({ status }) => status === "ready",
      ) ?? [])
    : [];

  const catalogClaudeProfile =
    (defaultClaudeProfile?.kind === "profile"
      ? readyClaudeProfiles.find(
          ({ id }) => id === defaultClaudeProfile.profileId,
        )
      : undefined) ?? readyClaudeProfiles[0];

  const claudeProfileSelection =
    claudeProfile ??
    (automaticClaudeProfile
      ? catalogClaudeProfile === undefined
        ? undefined
        : { kind: "profile" as const, profileId: catalogClaudeProfile.id }
      : defaultClaudeProfile);

  const claudeProfileId =
    rawSelectedProviderId === "claude-code" &&
    claudeProfileSelection?.kind === "profile"
      ? claudeProfileSelection.profileId
      : undefined;

  const profileModelsReady =
    rawSelectedProviderId !== "claude-code" ||
    claudeProfile !== undefined ||
    (claudeAccounts.ready && (automaticClaudeProfile || !claudeAccounts.error));

  const executionOptionsQuery = useSystemExecutionOptions({
    enabled: executionOptionsQueryEnabled && profileModelsReady,
    ...executionOptionsRouting,
    providerId: executionOptionsProviderId,
    claudeProfileId,
  });

  const providers = executionOptionsQuery.data?.providers ?? EMPTY_PROVIDERS;

  const isLoadingModels =
    executionOptionsQueryEnabled &&
    (executionOptionsQuery.isLoading ||
      (executionOptionsQuery.isPlaceholderData &&
        (executionOptionsQuery.data?.models.length ?? 0) === 0));

  const modelLoadError =
    executionOptionsQuery.data?.modelLoadError ?? NO_MODEL_LOAD_ERROR;

  const modelLoadFailed =
    executionOptionsQuery.isError || modelLoadError !== null;

  const modelCatalogIsVerified =
    executionOptionsQuery.data !== undefined &&
    !executionOptionsQuery.isPlaceholderData &&
    !executionOptionsQuery.isError &&
    modelLoadError === null;

  const modelCatalogIsSettled =
    !executionOptionsQueryEnabled ||
    executionOptionsQuery.isError ||
    (executionOptionsQuery.data !== undefined &&
      !executionOptionsQuery.isPlaceholderData);

  const permissionModeIsVerified =
    executionOptionsQuery.data !== undefined &&
    !executionOptionsQuery.isPlaceholderData &&
    !executionOptionsQuery.isError;

  const hasMultipleProviders = providers.length >= 2;

  const effectiveProviderId = useMemo(() => {
    if (!modelCatalogIsSettled && providers.length === 0) {
      return rawSelectedProviderId;
    }

    if (
      rawSelectedProviderId &&
      providers.some((provider) => provider.id === rawSelectedProviderId)
    ) {
      return rawSelectedProviderId;
    }

    return providers[0]?.id ?? "";
  }, [modelCatalogIsSettled, providers, rawSelectedProviderId]);

  const { setValue: setStoredSelectedModel, value: storedSelectedModel } =
    usePromptBoxModelPreference(effectiveProviderId);

  const { setValue: setStoredReasoningLevel, value: storedReasoningLevel } =
    usePromptBoxReasoningLevelPreference(effectiveProviderId);

  const {
    setValue: setStoredSessionOptions,
    value: storedSessionOptionSelections,
  } = usePromptBoxSessionOptionsPreference(effectiveProviderId);

  const [localSessionOptions, setLocalSessionOptions] = useState<{
    key: string;
    selections: SessionOptionSelections;
  }>({ key: "", selections: NO_SESSION_OPTION_SELECTIONS });

  const localSessionOptionsKey = `${String(resetKey ?? "")}:${effectiveProviderId}`;

  const localSessionOptionSelections =
    localSessionOptions.key === localSessionOptionsKey
      ? localSessionOptions.selections
      : NO_SESSION_OPTION_SELECTIONS;

  const requestedSessionOptionSelections =
    sessionOptionSelectionsOverride ??
    (usesStoredCreateSelections
      ? storedSessionOptionSelections
      : localSessionOptionSelections);

  const providerIds = useMemo(
    () => providers.map((provider) => provider.id),
    [providers],
  );

  const storedSessionOptionSelectionsByProvider =
    usePromptBoxSessionOptionsPreferences(
      usesStoredCreateSelections &&
        sessionOptionSelectionsOverride === undefined
        ? providerIds
        : NO_PROVIDER_IDS,
    );

  const sessionOptionSelectionsForProvider = useCallback(
    (providerId: string): SessionOptionSelections => {
      if (sessionOptionSelectionsOverride !== undefined) {
        return sessionOptionSelectionsOverride;
      }

      if (usesStoredCreateSelections) {
        return (
          storedSessionOptionSelectionsByProvider.get(providerId) ??
          NO_SESSION_OPTION_SELECTIONS
        );
      }

      return localSessionOptions.key ===
        `${String(resetKey ?? "")}:${providerId}`
        ? localSessionOptions.selections
        : NO_SESSION_OPTION_SELECTIONS;
    },
    [
      localSessionOptions,
      resetKey,
      sessionOptionSelectionsOverride,
      storedSessionOptionSelectionsByProvider,
      usesStoredCreateSelections,
    ],
  );

  const hiddenModels = useModelPickerHiddenModelIds(effectiveProviderId);

  const effectiveProviderMatchesInitialProvider =
    effectiveProviderId.length > 0 &&
    effectiveProviderId === renderedThreadSelections.selectedProviderId;

  const rawSelectedModel = usesStoredCreateSelections
    ? storedSelectedModel ||
      (effectiveProviderMatchesInitialProvider
        ? renderedThreadSelections.selectedModel
        : "")
    : renderedThreadSelections.selectedModel;

  const preferredReasoningLevel: ReasoningLevel | undefined =
    usesStoredCreateSelections
      ? storedReasoningLevel ||
        (effectiveProviderMatchesInitialProvider
          ? initialReasoningLevel
          : undefined)
      : localProvidersUsingDefaults.has(effectiveProviderId)
        ? undefined
        : renderedThreadSelections.reasoningLevel;

  const selectedProviderInfo = useMemo(
    () => providers.find((p) => p.id === effectiveProviderId),
    [effectiveProviderId, providers],
  );

  const providerOptions = useMemo(
    (): ProviderPickerOption[] =>
      providers.map((p) => ({
        value: p.id,
        label: p.displayName,
        icon: getProviderIconInfo("agent", p.id, p)?.icon,
        ...(p.strings?.brandPrefix === undefined
          ? {}
          : { brandPrefix: p.strings.brandPrefix }),
        ...(p.strings?.planModeCopy === undefined
          ? {}
          : { planModeCopy: p.strings.planModeCopy }),
        ...(p.strings?.installUrl === undefined
          ? {}
          : { installUrl: p.strings.installUrl }),
      })),
    [providers],
  );

  const activeProviderCapabilities = selectedProviderInfo?.capabilities;

  const selectedProviderComposerActions =
    selectedProviderInfo?.composerActions ?? EMPTY_COMPOSER_ACTIONS;

  const serviceTierSettings = systemConfig.data?.generalSettings;

  const allowFastServiceTier = allowsFastServiceTier(
    serviceTierSettings,
    selectedProviderInfo?.id ?? "",
  );

  const supportsServiceTier =
    allowFastServiceTier &&
    (activeProviderCapabilities?.supportsServiceTier ?? false);

  const permissionModes: readonly PermissionMode[] =
    activeProviderCapabilities?.permissionModes ??
    DEFAULT_SUPPORTED_PERMISSION_MODES;

  const supportsPermissionModeSelection =
    usesStoredCreateSelections || permissionModes.length > 1;

  const routedHostCeiling = useMemo(() => {
    const hosts = hostsQuery.data;

    if (!hosts) return null;

    const routedHostId =
      executionOptionsRouting.hostId ??
      selectPrimaryHost(hosts, systemConfig.data?.primaryHostId ?? null)?.id ??
      null;

    if (routedHostId === null) return null;

    return (
      hosts.find((host) => host.id === routedHostId)?.maxPermissionMode ?? null
    );
  }, [
    executionOptionsRouting.hostId,
    hostsQuery.data,
    systemConfig.data?.primaryHostId,
  ]);

  const routedCeiling = executionOptionsQuery.isPlaceholderData
    ? undefined
    : executionOptionsQuery.data?.permissionCeiling;

  const permissionCeiling: PermissionMode =
    routedCeiling ?? routedHostCeiling ?? "full";

  const allowedPermissionModes = useMemo(
    () =>
      permissionModes.filter(
        (mode) =>
          permissionModeRank(mode) <= permissionModeRank(permissionCeiling),
      ),
    [permissionCeiling, permissionModes],
  );

  const permissionModeOptions = useMemo(
    () =>
      PERMISSION_MODE_OPTIONS.filter(
        (option) =>
          usesStoredCreateSelections || permissionModes.includes(option.value),
      ).map((option) =>
        !permissionModes.includes(option.value)
          ? {
              ...option,
              disabled: true,
              disabledReason:
                "This provider does not support this approval mode",
            }
          : permissionModeRank(option.value) >
              permissionModeRank(permissionCeiling)
            ? {
                ...option,
                disabled: true,
                disabledReason: PERMISSION_CEILING_REASON,
              }
            : option,
      ),
    [permissionCeiling, permissionModes, usesStoredCreateSelections],
  );

  const serviceTierSupportByProvider = useMemo(() => {
    const supportByProvider: Record<string, boolean> = {};

    for (const provider of providers) {
      supportByProvider[provider.id] =
        allowsFastServiceTier(serviceTierSettings, provider.id) &&
        provider.capabilities.supportsServiceTier;
    }

    return supportByProvider;
  }, [serviceTierSettings, providers]);

  const baseCatalogSelection = useMemo(
    () =>
      resolveModelCatalogSelection({
        models: executionOptionsQuery.data?.models ?? [],
        selectedOnlyModels:
          executionOptionsQuery.data?.selectedOnlyModels ?? [],
        selectedModel: rawSelectedModel,
        preferredReasoningLevel,
        sessionOptionSelections: requestedSessionOptionSelections,
        hiddenModels,
        provider: selectedProviderInfo,
        catalogIsVerified: modelCatalogIsVerified,
        formatModelLabel,
      }),
    [
      executionOptionsQuery.data?.models,
      executionOptionsQuery.data?.selectedOnlyModels,
      hiddenModels,
      modelCatalogIsVerified,
      preferredReasoningLevel,
      rawSelectedModel,
      requestedSessionOptionSelections,
      selectedProviderInfo,
    ],
  );

  const needsSelectedModelDiscovery =
    modelCatalogIsVerified &&
    baseCatalogSelection.activeModel?.reasoningDiscovery === "unknown";

  const selectedModelQuery = useSystemExecutionOptions({
    enabled:
      executionOptionsQueryEnabled &&
      profileModelsReady &&
      needsSelectedModelDiscovery,
    ...executionOptionsRouting,
    providerId: effectiveProviderId,
    claudeProfileId,
    selectedModel: baseCatalogSelection.selectedModel || undefined,
  });

  const isLoadingReasoning =
    executionOptionsQueryEnabled &&
    needsSelectedModelDiscovery &&
    !selectedModelQuery.isError &&
    (selectedModelQuery.isPending || selectedModelQuery.isPlaceholderData);

  const selectedCatalog =
    needsSelectedModelDiscovery &&
    !selectedModelQuery.isPlaceholderData &&
    selectedModelQuery.data?.modelLoadError === null
      ? selectedModelQuery.data
      : executionOptionsQuery.data;

  const modelNotice =
    selectedCatalog?.modelNotice ??
    executionOptionsQuery.data?.modelNotice ??
    null;

  const {
    selectedModel,
    activeModel,
    modelOptions,
    moreModelOptions,
    catalogModelOptions,
    reasoningLevel,
    reasoningOptions,
    declaredSessionOptions,
    sessionOptionSelections,
    requiresExplicitModel,
    isSessionOptionModelSwitch,
  } = useMemo(
    () =>
      selectedCatalog === executionOptionsQuery.data
        ? baseCatalogSelection
        : resolveModelCatalogSelection({
            models: selectedCatalog?.models ?? [],
            selectedOnlyModels: selectedCatalog?.selectedOnlyModels ?? [],
            selectedModel: rawSelectedModel,
            preferredReasoningLevel,
            sessionOptionSelections: requestedSessionOptionSelections,
            hiddenModels,
            provider: selectedProviderInfo,
            catalogIsVerified: modelCatalogIsVerified,
            formatModelLabel,
          }),
    [
      baseCatalogSelection,
      executionOptionsQuery.data,
      selectedCatalog,
      hiddenModels,
      modelCatalogIsVerified,
      preferredReasoningLevel,
      rawSelectedModel,
      requestedSessionOptionSelections,
      selectedProviderInfo,
    ],
  );

  const setSessionOption = useCallback(
    (optionId: string, value: SessionOptionValue) => {
      if (usesStoredCreateSelections) {
        setStoredSessionOptions({
          ...storedSessionOptionSelections,
          [optionId]: value,
        });

        return;
      }

      setLocalSessionOptions({
        key: localSessionOptionsKey,
        selections: { ...localSessionOptionSelections, [optionId]: value },
      });
    },
    [
      localSessionOptionSelections,
      localSessionOptionsKey,
      setStoredSessionOptions,
      storedSessionOptionSelections,
      usesStoredCreateSelections,
    ],
  );

  const serviceTierOptions = useMemo(
    () =>
      allowFastServiceTier
        ? resolveServiceTierOptions({
            provider: selectedProviderInfo,
            model: activeModel,
          })
        : EMPTY_SERVICE_TIER_OPTIONS,
    [activeModel, allowFastServiceTier, selectedProviderInfo],
  );

  const serviceTier = useMemo(() => {
    if (!activeProviderCapabilities?.supportsServiceTier) {
      return undefined;
    }

    if (serviceTierOptions.length === 0) {
      return DEFAULT_SERVICE_TIER;
    }

    return rawServiceTier === undefined
      ? undefined
      : reconcileServiceTier(rawServiceTier, serviceTierOptions);
  }, [
    activeProviderCapabilities?.supportsServiceTier,
    rawServiceTier,
    serviceTierOptions,
  ]);

  const permissionSelectionKey = `${effectiveProviderId}\0${selectedModel}`;

  const usesExplicitNewPermission =
    newThreadPermissionSelection?.key === permissionSelectionKey;

  const newPermissionDefault =
    !usesStoredCreateSelections ||
    systemConfig.data?.generalSettings === undefined
      ? rawPermissionMode
      : initialPermissionMode !== undefined &&
          (initialProviderId === undefined ||
            initialProviderId === effectiveProviderId)
        ? initialPermissionMode
        : newThreadPermissionMode(
            systemConfig.data?.generalSettings,
            effectiveProviderId,
            selectedModel,
          );

  const permissionMode = usesStoredCreateSelections
    ? usesExplicitNewPermission
      ? newThreadPermissionSelection.value
      : newPermissionDefault
    : resolvePermissionModeSelection({
        rawPermissionMode,
        permissionModes:
          allowedPermissionModes.length > 0
            ? allowedPermissionModes
            : permissionModes,
      });

  const environmentSelectionValue = rawEnvironmentSelectionValue;

  const touchedFieldsPendingReset =
    usesLocalThreadSelections && threadResetKeyRef.current !== resetKey;

  const fellBackFromUnofferedProvider =
    rawSelectedProviderId.length > 0 &&
    effectiveProviderId.length > 0 &&
    effectiveProviderId !== rawSelectedProviderId;

  const effectiveInitialProviderSource: ExecutionInputFieldSource | undefined =
    fellBackFromUnofferedProvider ||
    (canResolveReadyProvider &&
      readyProviderId !== undefined &&
      effectiveProviderId === readyProviderId)
      ? "client-preference"
      : undefined;

  const executionInputSources = useMemo(
    () =>
      buildExecutionInputSources({
        effectiveValues: {
          selectedProviderId: effectiveProviderId,
          selectedModel,
          serviceTier,
          reasoningLevel,
          permissionMode,
        },
        forceExplicitModel: requiresExplicitModel || isSessionOptionModelSwitch,
        initialProviderSource: effectiveInitialProviderSource,
        scope,
        storedValues: {
          selectedProviderId: storedProviderId,
          selectedModel: storedSelectedModel,
          serviceTier: storedServiceTier,
          reasoningLevel: storedReasoningLevel,
          permissionMode: storedPermissionMode,
        },
        touchedFields: touchedFieldsPendingReset
          ? new Set<ThreadPromptField>()
          : touchedThreadFieldsRef.current,
      }),
    [
      effectiveProviderId,
      effectiveInitialProviderSource,
      isSessionOptionModelSwitch,
      requiresExplicitModel,
      permissionMode,
      reasoningLevel,
      scope,
      selectedModel,
      serviceTier,
      storedPermissionMode,
      storedProviderId,
      storedReasoningLevel,
      storedSelectedModel,
      storedServiceTier,
      touchedFieldsPendingReset,
    ],
  );

  useLayoutEffect(() => {
    if (!usesLocalThreadSelections) return;

    if (threadResetKeyRef.current !== resetKey) {
      threadResetKeyRef.current = resetKey;
      touchedThreadFieldsRef.current = new Set();
      localProviderSelectionsRef.current = new Map();
      setLocalProvidersUsingDefaults(new Set());
      setThreadSelections(nextThreadSelections);

      return;
    }

    setThreadSelections((currentSelections) =>
      syncUntouchedThreadPromptSelections({
        currentSelections,
        nextSelections: nextThreadSelections,
        touchedFields: touchedThreadFieldsRef.current,
      }),
    );
  }, [nextThreadSelections, resetKey, usesLocalThreadSelections]);

  const setSelectedProviderId = useCallback(
    (value: string) => {
      touchedThreadFieldsRef.current.add("selectedProviderId");

      if (usesStoredCreateSelections) {
        if (effectiveProviderId.length > 0) {
          setStoredSelectedModel(selectedModel);
          setStoredReasoningLevel(reasoningLevel);
        }

        setStoredProviderId(value);

        return;
      }

      touchedThreadFieldsRef.current.add("selectedModel");
      touchedThreadFieldsRef.current.add("reasoningLevel");

      if (effectiveProviderId.length > 0) {
        localProviderSelectionsRef.current.set(effectiveProviderId, {
          model: selectedModel,
          reasoningLevel,
        });
      }

      const rememberedSelection = localProviderSelectionsRef.current.get(value);
      setLocalProvidersUsingDefaults((current) => {
        const next = new Set(current);

        if (rememberedSelection) {
          next.delete(value);
        } else {
          next.add(value);
        }

        return next;
      });
      setThreadSelections((currentSelections) => ({
        ...currentSelections,
        selectedProviderId: value,
        selectedModel: rememberedSelection?.model ?? "",
        reasoningLevel:
          rememberedSelection?.reasoningLevel ??
          currentSelections.reasoningLevel,
      }));
    },
    [
      effectiveProviderId,
      reasoningLevel,
      selectedModel,
      setStoredReasoningLevel,
      setStoredSelectedModel,
      setStoredProviderId,
      usesStoredCreateSelections,
    ],
  );

  const setProviderModelReasoning = useCallback(
    ({
      providerId,
      model,
      reasoningLevel: nextReasoningLevel,
      serviceTier: nextServiceTier,
    }: ModelPickerSelection) => {
      const writesServiceTier =
        nextServiceTier !== undefined &&
        serviceTierSupportByProvider[providerId] === true;

      touchedThreadFieldsRef.current.add("selectedProviderId");
      touchedThreadFieldsRef.current.add("selectedModel");
      touchedThreadFieldsRef.current.add("reasoningLevel");

      if (writesServiceTier) {
        touchedThreadFieldsRef.current.add("serviceTier");
      }

      if (usesStoredCreateSelections) {
        if (
          effectiveProviderId.length > 0 &&
          effectiveProviderId !== providerId
        ) {
          setStoredSelectedModel(selectedModel);
          setStoredReasoningLevel(reasoningLevel);
        }

        setStoredProviderModelReasoning({
          providerId,
          model,
          reasoningLevel: nextReasoningLevel,
        });
        setStoredProviderId(providerId);

        if (writesServiceTier) setStoredServiceTier(nextServiceTier);

        return;
      }

      if (
        effectiveProviderId.length > 0 &&
        effectiveProviderId !== providerId
      ) {
        localProviderSelectionsRef.current.set(effectiveProviderId, {
          model: selectedModel,
          reasoningLevel,
        });
      }

      localProviderSelectionsRef.current.set(providerId, {
        model,
        reasoningLevel: nextReasoningLevel,
      });
      setLocalProvidersUsingDefaults((current) => {
        if (!current.has(providerId)) return current;
        const next = new Set(current);
        next.delete(providerId);

        return next;
      });
      setThreadSelections((currentSelections) => ({
        ...currentSelections,
        selectedProviderId: providerId,
        selectedModel: model,
        reasoningLevel: nextReasoningLevel,
        ...(writesServiceTier ? { serviceTier: nextServiceTier } : {}),
      }));
    },
    [
      effectiveProviderId,
      reasoningLevel,
      selectedModel,
      serviceTierSupportByProvider,
      setStoredProviderId,
      setStoredProviderModelReasoning,
      setStoredReasoningLevel,
      setStoredSelectedModel,
      setStoredServiceTier,
      usesStoredCreateSelections,
    ],
  );

  const setSelectedModel = useCallback(
    (value: string) => {
      touchedThreadFieldsRef.current.add("selectedModel");

      const nextModel =
        executionOptionsQuery.data?.models.find(
          (model) => model.model === value,
        ) ??
        executionOptionsQuery.data?.selectedOnlyModels.find(
          (model) => model.model === value,
        );

      const nextReasoningLevel = resolveModelReasoningLevel(
        nextModel,
        reasoningLevel,
      );

      if (usesStoredCreateSelections) {
        setStoredProviderModelReasoning({
          providerId: effectiveProviderId,
          model: value,
          reasoningLevel: nextReasoningLevel,
        });

        return;
      }

      setLocalProvidersUsingDefaults((current) => {
        if (!current.has(effectiveProviderId)) return current;
        const next = new Set(current);
        next.delete(effectiveProviderId);

        return next;
      });
      localProviderSelectionsRef.current.set(effectiveProviderId, {
        model: value,
        reasoningLevel: nextReasoningLevel,
      });
      setThreadSelections((currentSelections) => ({
        ...currentSelections,
        selectedModel: value,
        reasoningLevel: nextReasoningLevel,
      }));
    },
    [
      effectiveProviderId,
      executionOptionsQuery.data?.models,
      executionOptionsQuery.data?.selectedOnlyModels,
      reasoningLevel,
      setStoredProviderModelReasoning,
      usesStoredCreateSelections,
    ],
  );

  const setServiceTier = useCallback(
    (value: ServiceTier | undefined) => {
      touchedThreadFieldsRef.current.add("serviceTier");

      if (usesStoredCreateSelections) {
        setStoredServiceTier(value ?? "");

        return;
      }

      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "serviceTier",
          value,
        }),
      );
    },
    [setStoredServiceTier, usesStoredCreateSelections],
  );

  const setReasoningLevel = useCallback(
    (value: ReasoningLevel) => {
      touchedThreadFieldsRef.current.add("reasoningLevel");

      if (usesStoredCreateSelections) {
        setStoredReasoningLevel(value);

        return;
      }

      setLocalProvidersUsingDefaults((current) => {
        if (!current.has(effectiveProviderId)) return current;
        const next = new Set(current);
        next.delete(effectiveProviderId);

        return next;
      });
      localProviderSelectionsRef.current.set(effectiveProviderId, {
        model: selectedModel,
        reasoningLevel: value,
      });
      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "reasoningLevel",
          value,
        }),
      );
    },
    [
      effectiveProviderId,
      selectedModel,
      setStoredReasoningLevel,
      usesStoredCreateSelections,
    ],
  );

  const setPermissionMode = useCallback(
    (value: PermissionMode) => {
      touchedThreadFieldsRef.current.add("permissionMode");

      if (usesStoredCreateSelections) {
        setNewThreadPermissionSelection({ key: permissionSelectionKey, value });
        setStoredPermissionMode(value);

        return;
      }

      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "permissionMode",
          value,
        }),
      );
    },
    [
      permissionSelectionKey,
      setStoredPermissionMode,
      usesStoredCreateSelections,
    ],
  );

  const setEnvironmentSelectionValue = useCallback(
    (value: string) => {
      if (scope === "new-thread") {
        const parsed = parseEnvironmentValue(value);

        if (parsed?.type === "reuse") {
          setRootComposeReuseValue(value);

          return;
        }

        setRootComposeReuseValue(null);
        setStoredEnvironmentSelectionValue(value);

        return;
      }

      touchedThreadFieldsRef.current.add("environmentSelectionValue");
      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "environmentSelectionValue",
          value,
        }),
      );
    },
    [scope, setRootComposeReuseValue, setStoredEnvironmentSelectionValue],
  );

  const clearReuseEnvironment = useCallback(() => {
    if (scope !== "new-thread") return;
    setRootComposeReuseValue(null);
  }, [scope, setRootComposeReuseValue]);

  return {
    claudeProfileSelection,
    executionOptionsRouting,
    selectedProviderId: effectiveProviderId,
    setSelectedProviderId,
    setProviderModelReasoning,
    providers,
    providerOptions,
    hasMultipleProviders,
    selectedProviderDisplayName:
      selectedProviderInfo?.displayName ?? effectiveProviderId,
    selectedProviderComposerActions,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    permissionMode,
    setPermissionMode,
    environmentSelectionValue,
    setEnvironmentSelectionValue,
    clearReuseEnvironment,
    activeModel,
    modelOptions,
    moreModelOptions,
    catalogModelOptions,
    isLoadingModels,
    isLoadingReasoning,
    modelLoadFailed,
    modelLoadError,
    modelNotice,
    modelCatalogIsVerified,
    modelCatalogIsSettled,
    reasoningOptions,
    declaredSessionOptions,
    sessionOptionSelections,
    sessionOptionSelectionsForProvider,
    setSessionOption,
    permissionModeOptions,
    supportsPermissionModeSelection,
    permissionModeIsVerified,
    supportsServiceTier,
    serviceTierSupportByProvider,
    serviceTierOptions,
    executionInputSources,
  };
}
