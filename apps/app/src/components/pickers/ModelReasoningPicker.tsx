import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactElement,
} from "react";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsModelNotice,
  SystemProvidersQuery,
} from "@omnyo/server-contract";
import {
  reconcileServiceTier,
  allowsFastServiceTier,
  type ProviderInfo,
  type ProviderOptionDescriptor,
  type ReasoningLevel,
  type ServiceTier,
  type SessionOptionSelections,
} from "@omnyo/domain";
import {
  stripModelBrandPrefix,
  type ProviderPickerOption,
} from "./model-brand-prefix";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { Input } from "@omnyo/shared-ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@omnyo/shared-ui/option-display";
import { type PickerOption } from "./OptionPicker";
import type { ModelPickerOption } from "./model-picker-option";
import {
  modelPickerColumns,
  MODEL_PICKER_MENU_WIDTH_CLASS_NAME,
  modelPickerNavEntries,
  modelPickerRowKey,
  modelPickerVisibleRows,
  splitModelLabelTag,
  stepRowReasoningLevel,
  type ModelPickerMatrixBody,
  type ModelPickerMatrixGroup,
  type ModelPickerMatrixRow,
} from "./model-picker-menu";
import {
  resolveModelPickerNotice,
  type ModelPickerNotice,
} from "./model-notice";
import type { ModelPickerMatrixFavoritesNotice } from "./ModelPickerMatrix";
import { ModelReasoningMenu } from "./ModelReasoningMenuSplit";
import {
  MODEL_SPEED_BUTTON_CLASS_NAME,
  ModelSpeedControl,
  ModelSpeedIcon,
  type ModelSpeed,
} from "./ModelSpeedControl";
import { useResetPickerScroll } from "./useResetPickerScroll";
import { formatModelLoadErrorText } from "./model-load-error-message";
import {
  useAppCommandContext,
  useAppCommandHandler,
  useAppCommandRunner,
  useAppCommandShortcut,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { appCommandTarget } from "@/lib/app-command-targets";
import { isEditableKeyboardTarget } from "@/lib/app-keybindings";
import { shellHaptic } from "@/lib/native-shell/native-shell";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  APP_COMPOSER_SELECTOR,
  resolveComposerCommandScope,
} from "@/lib/composer-command-ownership";
import {
  ownsModelPickerCycleChord,
  resolveModelPickerToggle,
  type ModelPickerScope,
} from "./modelPickerToggle";
import {
  cyclableModelOptions,
  cycleReasoningValue,
  nextCycleValue,
  previousCycleValue,
} from "./modelPickerCycle";
import type {
  SessionOptionChoice,
  SessionOptionMenuSection,
} from "./SessionOptionsMenu";
import {
  landingReasoningLevel,
  modelPickerCatalogStatus,
  rowOffersReasoningLevel,
  rowReasoningLevelInColumn,
  type ModelPickerProviderCatalog,
  type ModelPickerSelection,
} from "./model-picker-selection";
import type { ModelFavoriteChipItem } from "./model-favorites";
import {
  useFooterFavorites,
  useModelPickerHiddenModels,
} from "./modelPickerPreferences";
import { useModelFavorites, type CatalogDemand } from "./useModelFavorites";
import { searchModelPickerGroups } from "./model-picker-search";
import {
  ALL_MODELS_COUNT_CLASS_NAME,
  AllModelsIcon,
  allModelsLabel,
  FAVORITE_BAR_ICON_SEGMENT_CLASS_NAME,
  ModelFavoritesBar,
  type FavoriteKeepActivation,
  type ModelPickerPresentation,
  type ModelPickerSelects,
} from "./ModelFavoritesBar";
import {
  buildFavoriteRows,
  favoriteLanding,
  type FavoritePick,
  type FavoriteRow,
  type FavoriteSelection,
} from "./favorite-bars";
import { usePickerModal } from "./use-picker-modal";

const NO_AGENT_SECTIONS: readonly SessionOptionMenuSection[] = [];

const NO_FAVORITE_ROWS: readonly FavoriteRow[] = [];

const NO_GROUPS: readonly ModelPickerMatrixGroup[] = [];

const NO_NOTICES: ReadonlyMap<string, ModelPickerNotice> = new Map();

const NO_SESSION_OPTION_SELECTIONS: SessionOptionSelections = {};

const NO_ROUTING: SystemProvidersQuery = {};

const NO_MODEL_OPTIONS: readonly ModelPickerOption[] = [];

const NO_FAVORITE_ITEMS: readonly ModelFavoriteChipItem[] = [];

const NO_KEYS: ReadonlySet<string> = new Set();

const EMPTY_SERVICE_TIER_OPTIONS: readonly ProviderOptionDescriptor[] = [];

function ignoreAgentOptionChange(): void {}

function noSessionOptionSelections(): SessionOptionSelections {
  return NO_SESSION_OPTION_SELECTIONS;
}

export interface ModelReasoningPickerHandoff {
  sourceProviderId: string;
  active: boolean;
  onStart: () => void;
  onExit: () => void;
}

const FAILED_TO_LOAD_MODELS_LABEL = "Failed to load models";

const MODEL_CYCLE_COMMANDS = [
  "modelPicker.cycleModel",
  "modelPicker.cycleModelBackward",
] as const;

const PROVIDER_CYCLE_COMMANDS = [
  "modelPicker.cycleProvider",
  "modelPicker.cycleProviderBackward",
] as const;

const REASONING_CYCLE_COMMANDS = [
  "modelPicker.cycleReasoning",
  "modelPicker.cycleReasoningBackward",
] as const;

const HANDOFF_DRAWER_TOP_CLASS_NAME =
  "[&>[data-persistent-drawer-handle]]:w-full [&>[data-persistent-drawer-handle]]:rounded-t-xl [&>[data-persistent-drawer-handle]]:bg-background";

const COMPACT_SEARCH_DRAWER_CLASS_NAME = "h-[min(40rem,85dvh)]";

const COMPACT_FAVORITES_DRAWER_CLASS_NAME =
  "max-h-[min(40rem,85dvh,calc(92dvh-var(--omnyo-drawer-keyboard-inset,0px)))]";

const TOOLBAR_BUTTON_CLASS_NAME = cn(
  "flex h-7 shrink-0 items-center justify-center rounded-sm text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 max-md:pointer-coarse:h-9",
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
);

interface GroupSource {
  providerId: string;
  option: ProviderPickerOption | undefined;
  label: string;
  brandPrefix: string | undefined;
  selected: boolean;
  state: "loading" | "error" | "ready";
  error: SystemExecutionOptionsModelLoadError | null;
  notice: SystemExecutionOptionsModelNotice | null;
  committable: boolean;
  rows: readonly ModelPickerOption[];
  moreRows: readonly ModelPickerOption[];
  catalogRows: readonly ModelPickerOption[];
  hidden: ReadonlySet<string>;
}

interface LandingOverride {
  key: string;
  level: ReasoningLevel;
}

type PickerView = "favorites" | "all";

interface PickerViewSession {
  entry: PickerView;
  view: PickerView;
  fromFavorites: boolean;
}

function siblingGroupSource(
  option: ProviderPickerOption,
  catalog: ModelPickerProviderCatalog | undefined,
  providersSettled: boolean,
  hidden: ReadonlySet<string>,
): GroupSource {
  const base = {
    providerId: option.value,
    option,
    label: option.label,
    brandPrefix: option.brandPrefix,
    selected: false,
    notice: catalog?.notice ?? null,
    hidden,
  };

  if (catalog === undefined) {
    return {
      ...base,
      state: providersSettled ? "error" : "loading",
      error: null,
      committable: false,
      rows: NO_MODEL_OPTIONS,
      moreRows: NO_MODEL_OPTIONS,
      catalogRows: NO_MODEL_OPTIONS,
    };
  }

  return {
    ...base,
    state:
      catalog.status === "loading"
        ? "loading"
        : catalog.status === "failed"
          ? "error"
          : "ready",
    error: catalog.loadError,
    committable: catalog.status === "verified",
    rows: catalog.modelOptions,
    moreRows: catalog.moreModelOptions,
    catalogRows: catalog.catalogModelOptions,
  };
}

function matrixRowKeyFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;

  return (
    target.closest<HTMLElement>("[data-model-matrix-row]")?.dataset
      .modelMatrixRow ?? null
  );
}

interface ModelReasoningPickerProps {
  providerRouting?: SystemProvidersQuery;
  providers: readonly ProviderInfo[];
  providerOptions: readonly ProviderPickerOption[];
  selectedProviderId: string;
  onSelectedProviderChange?: (value: string) => void;
  hasMultipleProviders: boolean;
  modelValue: string;
  modelOptions: readonly ModelPickerOption[];
  moreModelOptions?: readonly ModelPickerOption[];
  catalogModelOptions: readonly ModelPickerOption[];
  modelCatalogIsVerified: boolean;
  requireVerifiedCatalog?: boolean;
  modelIsLoading?: boolean;
  modelLoadFailed?: boolean;
  modelLoadError?: SystemExecutionOptionsModelLoadError | null;
  modelNotice?: SystemExecutionOptionsModelNotice | null;
  onModelChange: (value: string) => void;
  reasoningValue: ReasoningLevel;
  reasoningOptions: readonly PickerOption<ReasoningLevel>[];
  onReasoningChange: (value: ReasoningLevel) => void;
  onSelectionChange: (selection: ModelPickerSelection) => boolean;
  serviceTierValue: ServiceTier | undefined;
  serviceTierOptions: readonly ProviderOptionDescriptor[];
  onServiceTierChange: (value: ServiceTier) => void;
  sessionOptionSelectionsForProvider?: (
    providerId: string,
  ) => SessionOptionSelections;
  agentSections?: readonly SessionOptionMenuSection[];
  onAgentOptionChange?: (optionId: string, value: SessionOptionChoice) => void;
  commandShortcutsEnabled?: boolean;
  showFavoriteChips?: boolean;
  className?: string;
  muted?: boolean;
  modal?: boolean;
  align?: "start" | "center" | "end";
  disabled?: boolean;
  handoff?: ModelReasoningPickerHandoff;
  presentation?: ModelPickerPresentation;
  selects?: ModelPickerSelects;
}

export function ModelReasoningPicker({
  providers,
  providerOptions,
  providerRouting,
  selectedProviderId,
  onSelectedProviderChange,
  hasMultipleProviders,
  modelValue,
  modelOptions,
  moreModelOptions = NO_MODEL_OPTIONS,
  catalogModelOptions,
  modelCatalogIsVerified,
  requireVerifiedCatalog = false,
  modelIsLoading = false,
  modelLoadFailed = false,
  modelLoadError,
  modelNotice,
  onModelChange,
  reasoningValue,
  reasoningOptions,
  onReasoningChange,
  onSelectionChange,
  serviceTierValue,
  serviceTierOptions,
  onServiceTierChange,
  sessionOptionSelectionsForProvider = noSessionOptionSelections,
  agentSections = NO_AGENT_SECTIONS,
  onAgentOptionChange = ignoreAgentOptionChange,
  commandShortcutsEnabled = true,
  showFavoriteChips = false,
  className,
  muted,
  modal: modalProp,
  align = "start",
  disabled,
  handoff,
  presentation = "footer",
  selects = "model-and-effort",
}: ModelReasoningPickerProps) {
  const showsEffort = selects === "model-and-effort";
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const commandRunner = useAppCommandRunner();
  const { modal, modalHostRef } = usePickerModal(modalProp);
  const [open, setOpen] = useState(false);

  const [pickerMode, setPickerMode] =
    useState<ModelPickerSelects>("model-and-effort");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusComposerOnCloseRef = useRef(false);
  const registeredToggleShortcut = useAppCommandShortcut("modelPicker.toggle");

  const toggleShortcut = commandShortcutsEnabled
    ? registeredToggleShortcut
    : null;

  const toggleCommandProps =
    commandShortcutsEnabled && !disabled
      ? appCommandTarget("modelPicker.toggle")
      : {};

  const [searchQuery, setSearchQuery] = useState("");
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isSearching = searchQuery.trim().length > 0;
  const navId = useId();
  const gridId = `${navId}-grid`;

  const optionDomId = useCallback(
    (index: number) => `${navId}-opt-${index}`,
    [navId],
  );

  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [searchCursorVisible, setSearchCursorVisible] = useState(false);

  const [landingOverride, setLandingOverride] =
    useState<LandingOverride | null>(null);

  const [editing, setEditing] = useState(false);

  const [viewSession, setViewSession] = useState<PickerViewSession | null>(
    null,
  );

  const [starredRowKey, setStarredRowKey] = useState<string | null>(null);
  const focusViewRef = useRef<PickerView | null>(null);

  const [expandedGroups, setExpandedGroups] =
    useState<ReadonlySet<string>>(NO_KEYS);

  const [revealedFavoriteKey, setRevealedFavoriteKey] = useState<string | null>(
    null,
  );

  const [catalogIntent, setCatalogIntent] = useState(false);

  const {
    hiddenFor,
    hide: hideModel,
    unhide: unhideModel,
  } = useModelPickerHiddenModels();

  const footerFavorites = useFooterFavorites();

  const selectedProvider = providerOptions.find(
    (p) => p.value === selectedProviderId,
  );

  const ProviderIcon = selectedProvider?.icon;
  const selectedModelOption = modelOptions.find((m) => m.value === modelValue);
  const systemConfig = useSystemConfig();

  const serviceTiersAllowed = allowsFastServiceTier(
    systemConfig.data?.generalSettings,
    selectedProviderId,
  );

  const effectiveServiceTierOptions = serviceTiersAllowed
    ? serviceTierOptions
    : EMPTY_SERVICE_TIER_OPTIONS;

  const selectedModelLabel =
    selectedModelOption?.label ??
    (systemConfig.data?.generalSettings.streamerMode !== false && modelValue
      ? "Selected model"
      : modelValue);

  const hasSelectedModel = selectedModelLabel.trim().length > 0;
  const selectedProviderLabel = selectedProvider?.label ?? selectedProviderId;

  const selectedModelLoadErrorMatches =
    modelLoadError?.providerId === selectedProviderId;

  const selectedModelLoadFailed =
    modelLoadFailed || selectedModelLoadErrorMatches;

  const handoffSourceProviderId = handoff?.sourceProviderId;
  const handoffActive = handoff?.active === true;

  const canSwitchProviders =
    hasMultipleProviders &&
    onSelectedProviderChange !== undefined &&
    providerOptions.length > 1;

  const providersSettled =
    providers.length > 0 || selectedModelLoadFailed || !modelIsLoading;

  const selectedHidden = hiddenFor(selectedProviderId);

  const selectedVerified =
    modelCatalogIsVerified && !modelIsLoading && !selectedModelLoadFailed;

  const selectedAwaitingVerification =
    requireVerifiedCatalog &&
    !modelCatalogIsVerified &&
    !selectedModelLoadFailed;

  const selectedLoadError = selectedModelLoadErrorMatches
    ? (modelLoadError ?? null)
    : null;

  const selectedNotice =
    modelNotice?.providerId === selectedProviderId ? modelNotice : null;

  const catalogDemand: CatalogDemand = disabled
    ? "none"
    : open || catalogIntent
      ? "browse"
      : "favorites";

  const favorites = useModelFavorites({
    routing: providerRouting ?? NO_ROUTING,
    providers,
    providerOptions,
    canSwitchProviders,
    providersSettled,
    catalogDemand,
    sessionOptionSelectionsForProvider,
    selection: {
      providerId: selectedProviderId,
      model: modelValue,
      reasoningLevel: reasoningValue,
      serviceTier: serviceTierValue,
    },
    reasoningOptions,
    serviceTierOptions: effectiveServiceTierOptions,
    selectedCatalog: {
      status: modelPickerCatalogStatus({
        verified: selectedVerified,
        failed: selectedModelLoadFailed,
      }),
      loadError: selectedLoadError,
      notice: selectedNotice,
      modelOptions,
      moreModelOptions,
      catalogModelOptions,
    },
    handoff,
  });

  const { siblingCatalogs, effectiveServiceTier } = favorites;

  const favoritesStore =
    favorites.preference.status === "loading" ? null : favorites.preference;

  const preferencesReady = favoritesStore !== null;
  const favoriteItems = favoritesStore?.items ?? NO_FAVORITE_ITEMS;

  const defaultView: PickerView =
    favoriteItems.length === 0 ? "all" : "favorites";

  const entryView: PickerView =
    pickerMode === "model" ? "all" : (viewSession?.entry ?? defaultView);

  const browseView: PickerView =
    pickerMode === "model" ? "all" : (viewSession?.view ?? defaultView);

  useLayoutEffect(() => {
    if (!open || viewSession !== null) return;
    setViewSession({
      entry: defaultView,
      view: defaultView,
      fromFavorites: false,
    });
  }, [defaultView, open, viewSession]);

  const currentIsFavorite =
    favoritesStore?.isFavorite(favorites.current.selection) ?? false;

  const canToggleCurrentFavorite =
    favoritesStore !== null &&
    favorites.catalogs.has(selectedProviderId) &&
    hasSelectedModel &&
    !modelIsLoading &&
    (currentIsFavorite || !favoritesStore.isFull);

  const toggleCurrentFavorite = () => {
    if (favoritesStore === null || !canToggleCurrentFavorite) return;
    favoritesStore.toggle(favorites.current.selection);
  };

  const toggleFavoritePick = (row: FavoriteRow, pick: FavoritePick) => {
    if (pick.pinned) {
      favoritesStore?.remove(pick.key);

      return;
    }

    setStarredRowKey(row.key);
    toggleCurrentFavorite();
  };

  const providerOrder = useMemo(
    () => providerOptions.map((option) => option.value),
    [providerOptions],
  );

  const showsFavoriteRows = preferencesReady && browseView === "favorites";
  const shadowCurrent = canToggleCurrentFavorite ? favorites.current : null;

  const favoriteRows = useMemo(
    (): readonly FavoriteRow[] =>
      showsFavoriteRows
        ? buildFavoriteRows(
            favoriteItems,
            providerOrder,
            reasoningValue,
            shadowCurrent,
          ).map((row) =>
            landingOverride?.key === row.key
              ? {
                  ...row,
                  landing: favoriteLanding(row.picks, landingOverride.level),
                }
              : row,
          )
        : NO_FAVORITE_ROWS,
    [
      favoriteItems,
      landingOverride,
      providerOrder,
      reasoningValue,
      shadowCurrent,
      showsFavoriteRows,
    ],
  );

  const shadowRowKey =
    favoriteRows.find((row) => row.picks.some((pick) => !pick.pinned))?.key ??
    null;

  const starRowKey = shadowRowKey ?? starredRowKey;

  const switcherFavorites =
    showFavoriteChips &&
    footerFavorites.shown &&
    !(showsEffort && isCompactViewport)
      ? favoritesStore
      : null;

  const groupSources = useMemo((): GroupSource[] => {
    const selectedSource: GroupSource = {
      providerId: selectedProviderId,
      option: selectedProvider,
      label: selectedProviderLabel,
      brandPrefix: selectedProvider?.brandPrefix,
      selected: true,
      state:
        modelIsLoading || selectedAwaitingVerification
          ? "loading"
          : modelOptions.length + moreModelOptions.length === 0 &&
              selectedModelLoadFailed
            ? "error"
            : "ready",
      error: selectedLoadError,
      notice: selectedNotice,
      committable:
        !modelIsLoading && (!requireVerifiedCatalog || modelCatalogIsVerified),
      rows: modelOptions,
      moreRows: moreModelOptions,
      catalogRows: catalogModelOptions,
      hidden: selectedHidden,
    };

    if (!canSwitchProviders) return [selectedSource];

    const siblingById = new Map(
      siblingCatalogs.map((catalog) => [catalog.providerId, catalog]),
    );

    return providerOptions.map((option) =>
      option.value === selectedProviderId
        ? selectedSource
        : siblingGroupSource(
            option,
            siblingById.get(option.value),
            providersSettled,
            hiddenFor(option.value),
          ),
    );
  }, [
    canSwitchProviders,
    catalogModelOptions,
    hiddenFor,
    modelCatalogIsVerified,
    modelIsLoading,
    modelOptions,
    moreModelOptions,
    providerOptions,
    providersSettled,
    requireVerifiedCatalog,
    selectedAwaitingVerification,
    selectedHidden,
    selectedLoadError,
    selectedModelLoadFailed,
    selectedNotice,
    selectedProvider,
    selectedProviderId,
    selectedProviderLabel,
    siblingCatalogs,
  ]);

  const noticesByProvider = useMemo((): ReadonlyMap<
    string,
    ModelPickerNotice
  > => {
    if (!open) return NO_NOTICES;

    const now = Date.now();
    const notices = new Map<string, ModelPickerNotice>();

    for (const source of groupSources) {
      const notice = resolveModelPickerNotice(source.notice, now);

      if (notice !== null) notices.set(source.providerId, notice);
    }

    return notices;
  }, [groupSources, open]);

  const favoriteNotices = useMemo((): ModelPickerMatrixFavoritesNotice[] => {
    const providerIds = new Set([
      selectedProviderId,
      ...favoriteItems.map((item) => item.favorite.providerId),
    ]);

    return groupSources.flatMap((source) => {
      const notice = noticesByProvider.get(source.providerId);

      return notice === undefined || !providerIds.has(source.providerId)
        ? []
        : [{ notice, icon: source.option?.icon }];
    });
  }, [favoriteItems, groupSources, noticesByProvider, selectedProviderId]);

  const groups = useMemo((): ModelPickerMatrixGroup[] => {
    const toRow = (
      source: GroupSource,
      option: ModelPickerOption,
      searchLevel: ReasoningLevel | null,
    ): ModelPickerMatrixRow => {
      const key = modelPickerRowKey(source.providerId, option.value);

      const searchLanding =
        searchLevel === null
          ? null
          : rowReasoningLevelInColumn(option, searchLevel);

      const landingLevel =
        landingOverride !== null &&
        landingOverride.key === key &&
        rowOffersReasoningLevel(option, landingOverride.level)
          ? landingOverride.level
          : (searchLanding ?? landingReasoningLevel(option, reasoningValue));

      return {
        key,
        providerId: source.providerId,
        option,
        label: stripModelBrandPrefix(option.label, source.brandPrefix),
        hidden: source.hidden.has(option.value),
        selected: source.selected && option.value === modelValue,
        selectable: source.committable && option.disabled !== true,
        landingLevel,
      };
    };

    const toGroup = (
      source: GroupSource,
      body: ModelPickerMatrixBody,
    ): ModelPickerMatrixGroup => ({
      providerId: source.providerId,
      label: source.label,
      icon: source.option?.icon,
      installUrl: source.option?.installUrl,
      newChat:
        handoffSourceProviderId !== undefined &&
        source.providerId !== handoffSourceProviderId,
      notice: noticesByProvider.get(source.providerId) ?? null,
      body,
    });

    if (isSearching) {
      const result = searchModelPickerGroups(
        groupSources
          .filter((source) => source.state === "ready")
          .map((source) => ({
            providerId: source.providerId,
            providerLabel: source.label,
            brandPrefix: source.brandPrefix,
            rows: source.rows,
            moreRows: source.moreRows,
            source,
          })),
        searchQuery,
      );

      return result.groups.map(({ group, rows }) =>
        toGroup(group.source, {
          kind: "rows",
          rows: rows.map((option) =>
            toRow(group.source, option, result.reasoningLevel),
          ),
          more: null,
        }),
      );
    }

    return groupSources.map((source) => {
      if (source.state === "loading")
        return toGroup(source, { kind: "loading" });

      if (source.state === "error") {
        return toGroup(source, { kind: "error", error: source.error });
      }

      const visible = editing ? source.catalogRows : source.rows;
      const visibleIds = new Set(visible.map((option) => option.value));

      const more = source.moreRows.filter(
        (option) => !visibleIds.has(option.value),
      );

      if (visible.length === 0 && more.length === 0) {
        return toGroup(source, { kind: "empty" });
      }

      return toGroup(source, {
        kind: "rows",
        rows: (pickerMode === "model" ? [...visible, ...more] : visible).map(
          (option) => toRow(source, option, null),
        ),
        more:
          pickerMode === "model" || more.length === 0
            ? null
            : {
                count: more.length,
                expanded: expandedGroups.has(source.providerId),
                rows: more.map((option) => toRow(source, option, null)),
              },
      });
    });
  }, [
    editing,
    expandedGroups,
    groupSources,
    handoffSourceProviderId,
    isSearching,
    landingOverride,
    modelValue,
    noticesByProvider,
    pickerMode,
    reasoningValue,
    searchQuery,
  ]);

  const visibleGroups = browseView === "all" ? groups : NO_GROUPS;

  const columns = useMemo(
    () =>
      modelPickerColumns([
        ...favoriteRows.map((row) =>
          row.picks.map((pick) => pick.selection.reasoningLevel),
        ),
        ...modelPickerVisibleRows(visibleGroups).map((row) =>
          row.option.reasoningOptions.map((option) => option.value),
        ),
      ]),
    [favoriteRows, visibleGroups],
  );

  const navEntries = useMemo(
    () =>
      modelPickerNavEntries(
        favoriteRows,
        browseView === "favorites",
        visibleGroups,
      ),
    [browseView, favoriteRows, visibleGroups],
  );

  const navIndexByKey = useMemo(
    () => new Map(navEntries.map((entry, index) => [entry.key, index])),
    [navEntries],
  );

  const entriesByKey = useMemo(
    () => new Map(navEntries.map((entry) => [entry.key, entry])),
    [navEntries],
  );

  const selectedRowKey = modelPickerRowKey(selectedProviderId, modelValue);

  const startKey =
    favoriteRows.find((row) => row.current)?.key ??
    (browseView === "favorites"
      ? (navEntries[0]?.key ?? null)
      : selectedRowKey);

  const effectiveCursorKey =
    cursorKey ?? (isSearching ? (navEntries[0]?.key ?? null) : startKey);

  const highlightedIndex =
    effectiveCursorKey === null
      ? -1
      : (navIndexByKey.get(effectiveCursorKey) ?? -1);

  const highlightedKey = highlightedIndex >= 0 ? effectiveCursorKey : null;

  const triggerModelLabel = modelIsLoading
    ? "Loading models..."
    : hasSelectedModel
      ? stripModelBrandPrefix(selectedModelLabel, selectedProvider?.brandPrefix)
      : selectedModelLoadFailed
        ? modelOptions.length > 0 ||
          (selectedModelLoadErrorMatches && canSwitchProviders)
          ? "Select model"
          : FAILED_TO_LOAD_MODELS_LABEL
        : modelOptions.length === 0
          ? canSwitchProviders
            ? "Select model"
            : "No models available"
          : "Select model";

  const triggerModelValueIsDestructive =
    triggerModelLabel === FAILED_TO_LOAD_MODELS_LABEL;

  const { base: triggerModelBase, tag: triggerModelTag } =
    splitModelLabelTag(triggerModelLabel);

  const selectedReasoningOption = reasoningOptions.find(
    (r) => r.value === reasoningValue,
  );

  const triggerReasoningLabel =
    hasSelectedModel && showsEffort
      ? (selectedReasoningOption?.label ?? null)
      : null;

  const serviceTierModelReady =
    modelOptions.length > 0 &&
    !modelIsLoading &&
    !selectedModelLoadFailed &&
    !selectedAwaitingVerification;

  const selectedServiceTierOption =
    hasSelectedModel && serviceTierModelReady
      ? effectiveServiceTierOptions.find(
          (option) => option.id === serviceTierValue,
        )
      : undefined;

  const showReasoningStep =
    reasoningOptions.length > 0 &&
    hasSelectedModel &&
    !modelIsLoading &&
    !selectedModelLoadFailed;

  const resetBrowseState = useCallback(() => {
    setSearchCursorVisible(false);
    setSearchQuery("");
    setCursorKey(null);
    setLandingOverride(null);
    setEditing(false);
    setExpandedGroups(NO_KEYS);
    setRevealedFavoriteKey(null);
    setViewSession(null);
    setStarredRowKey(null);
  }, []);

  const openAllModels = useCallback((query: string) => {
    focusViewRef.current = "all";
    setViewSession((current) => ({
      entry: current?.entry ?? "favorites",
      view: "all",
      fromFavorites: true,
    }));
    setCursorKey(null);
    setLandingOverride(null);
    setSearchCursorVisible(query.length > 0);
    setSearchQuery(query);
  }, []);

  const showFavorites = useCallback(() => {
    focusViewRef.current = "favorites";
    setViewSession((current) => ({
      entry: current?.entry ?? "all",
      view: "favorites",
      fromFavorites: false,
    }));
    setSearchQuery("");
    setSearchCursorVisible(false);
    setCursorKey(null);
    setLandingOverride(null);
    setEditing(false);
  }, []);

  useLayoutEffect(() => {
    const target = focusViewRef.current;

    if (target === null) return;
    focusViewRef.current = null;
    (target === "all" ? searchInputRef.current : listRef.current)?.focus();
  });

  const handleMobileContentAnimationEnd = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        resetBrowseState();
      }
    },
    [resetBrowseState],
  );

  const focusComposer = useCallback(
    (): boolean => commandRunner.dispatch("composer.focus", triggerRef.current),
    [commandRunner],
  );

  const refocusComposerAfterClose = useCallback(() => {
    const trigger = triggerRef.current;

    if (
      isPointerCoarse ||
      trigger === null ||
      trigger.closest(APP_COMPOSER_SELECTOR) === null
    ) {
      return;
    }

    if (isCompactViewport) {
      window.requestAnimationFrame(() => {
        focusComposer();
      });

      return;
    }

    focusComposerOnCloseRef.current = true;
  }, [focusComposer, isCompactViewport, isPointerCoarse]);

  const applySelection = useCallback(
    (selection: ModelPickerSelection) => {
      if (!onSelectionChange(selection)) return false;

      if (
        selection.providerId !== selectedProviderId ||
        selection.model !== modelValue ||
        selection.reasoningLevel !== reasoningValue ||
        (selection.serviceTier !== undefined &&
          selection.serviceTier !== serviceTierValue)
      ) {
        shellHaptic("selection");
      }

      return true;
    },
    [
      modelValue,
      onSelectionChange,
      reasoningValue,
      selectedProviderId,
      serviceTierValue,
    ],
  );

  const commitAndClose = useCallback(
    (selection: ModelPickerSelection) => {
      if (!applySelection(selection)) return;
      setOpen(false);
      refocusComposerAfterClose();
    },
    [applySelection, refocusComposerAfterClose],
  );

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      if (!focusComposerOnCloseRef.current) return;
      focusComposerOnCloseRef.current = false;

      if (focusComposer()) event.preventDefault();
    },
    [focusComposer],
  );

  const commitRow = useCallback(
    (row: ModelPickerMatrixRow, level: ReasoningLevel) => {
      if (!row.selectable) return;
      commitAndClose({
        providerId: row.providerId,
        model: row.option.value,
        reasoningLevel: level,
      });
    },
    [commitAndClose],
  );

  const keepBarFavorite = (
    selection: FavoriteSelection,
    { focused }: FavoriteKeepActivation,
  ) => {
    if (favoritesStore === null || favoritesStore.isFavorite(selection)) return;
    favoritesStore.toggle(selection);

    if (!focused || focusComposer()) return;
    triggerRef.current?.focus();
  };

  const applyMenuFavorite = (pick: FavoritePick) => {
    if (pick.availability.state !== "ready") return;
    commitAndClose(pick.selection);
  };

  const toggleMore = useCallback((providerId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);

      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }

      return next;
    });
  }, []);

  const cellSelection = useCallback(
    (
      row: ModelPickerMatrixRow,
      level: ReasoningLevel,
    ): ModelPickerSelection => ({
      providerId: row.providerId,
      model: row.option.value,
      reasoningLevel: level,
      serviceTier: reconcileServiceTier(
        effectiveServiceTier,
        row.option.serviceTierOptions,
      ),
    }),
    [effectiveServiceTier],
  );

  const isFavoriteCell = useCallback(
    (row: ModelPickerMatrixRow, level: ReasoningLevel) =>
      favoritesStore?.isFavorite(cellSelection(row, level)) ?? false,
    [cellSelection, favoritesStore],
  );

  const toggleFavoriteCell = useCallback(
    (row: ModelPickerMatrixRow, level: ReasoningLevel) => {
      favoritesStore?.toggle(cellSelection(row, level));
    },
    [cellSelection, favoritesStore],
  );

  const toggleHidden = useCallback(
    (row: ModelPickerMatrixRow) => {
      if (row.hidden) {
        unhideModel(row.providerId, row.option.value);
      } else {
        hideModel(row.providerId, row.option.value);
      }
    },
    [hideModel, unhideModel],
  );

  const handlePointerNavigation = useCallback(() => {
    setSearchCursorVisible(false);
    setCursorKey(null);
    setLandingOverride(null);
  }, []);

  const startHandoff = useCallback(() => {
    handoff?.onStart();
    setOpen(false);
    refocusComposerAfterClose();
  }, [handoff, refocusComposerAfterClose]);

  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  const isSplitPane = paneContext?.isSplitPane ?? false;

  const resolveCommandScope = useCallback(
    (target: EventTarget | null): ModelPickerScope => {
      const scope = resolveComposerCommandScope({
        composer: triggerRef.current?.closest(APP_COMPOSER_SELECTOR) ?? null,
        target,
        isFocusedPane,
      });

      return {
        ...scope,
        disabled: disabled ?? false,
        isSplitPane,
        editableOutsideComposer:
          !scope.caretInThisComposer &&
          !scope.caretInOtherComposer &&
          isEditableKeyboardTarget(target),
      };
    },
    [disabled, isFocusedPane, isSplitPane],
  );

  useEffect(() => {
    if (!open) return;

    const closeWhenWindowBlurs = () => setOpen(false);

    window.addEventListener("blur", closeWhenWindowBlurs);

    return () => window.removeEventListener("blur", closeWhenWindowBlurs);
  }, [open]);

  useAppCommandContext(
    "modelPickerOpen",
    commandShortcutsEnabled && open && !disabled,
  );

  const ownsCycleChord = (target: EventTarget | null): boolean =>
    commandShortcutsEnabled &&
    ownsModelPickerCycleChord({ open, ...resolveCommandScope(target) });

  useAppCommandHandler(
    "modelPicker.toggle",
    ({ target }) => {
      if (!commandShortcutsEnabled) return false;

      const action = resolveModelPickerToggle({
        open,
        ...resolveCommandScope(target),
      });

      if (action === "ignore") return false;

      if (action === "open") setPickerMode("model-and-effort");
      setOpen(action === "open");

      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    MODEL_CYCLE_COMMANDS,
    (index, { target }) => {
      if (!ownsCycleChord(target)) return false;
      const options = cyclableModelOptions(modelOptions, selectedHidden);

      const next =
        index === 0
          ? nextCycleValue(options, modelValue)
          : previousCycleValue(options, modelValue);

      if (next !== null) onModelChange(next);

      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    PROVIDER_CYCLE_COMMANDS,
    (index, { target }) => {
      if (!ownsCycleChord(target)) return false;

      if (canSwitchProviders && onSelectedProviderChange !== undefined) {
        const next =
          index === 0
            ? nextCycleValue(providerOptions, selectedProviderId)
            : previousCycleValue(providerOptions, selectedProviderId);

        if (next !== null) onSelectedProviderChange(next);
      }

      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    REASONING_CYCLE_COMMANDS,
    (index, { target }) => {
      if (!ownsCycleChord(target)) return false;

      const next = cycleReasoningValue(
        reasoningOptions,
        reasoningValue,
        index === 0 ? "forward" : "backward",
      );

      if (next !== null) onReasoningChange(next);

      return true;
    },
    50,
    commandShortcutsEnabled,
  );

  const stepSelectedReasoning = (
    event: KeyboardEvent<HTMLElement>,
    direction: 1 | -1,
  ) => {
    if (!showReasoningStep) return;

    if (!reasoningOptions.some((option) => option.value === reasoningValue)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const next = stepRowReasoningLevel(
      reasoningOptions,
      reasoningValue,
      direction,
    );

    if (next !== null) onReasoningChange(next);
  };

  const moveCursor = (direction: 1 | -1) => {
    const total = navEntries.length;

    if (total === 0) return;

    const nextIndex =
      highlightedIndex < 0
        ? direction === 1
          ? 0
          : total - 1
        : (highlightedIndex + direction + total) % total;

    setCursorKey(navEntries[nextIndex].key);
    setLandingOverride(null);
  };

  const hasModifier = (event: KeyboardEvent<HTMLElement>) =>
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

  const handleTriggerKeyDown: KeyboardEventHandler<HTMLElement> = (event) => {
    if (
      event.defaultPrevented ||
      hasModifier(event) ||
      disabled ||
      !showsEffort ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    ) {
      return;
    }

    stepSelectedReasoning(event, event.key === "ArrowRight" ? 1 : -1);
  };

  const handleContentKeyDown: KeyboardEventHandler<HTMLElement> = (event) => {
    if (
      browseView === "favorites" &&
      !event.defaultPrevented &&
      !disabled &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.length === 1 &&
      event.key.trim() !== "" &&
      !isEditableKeyboardTarget(event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
      openAllModels(event.key);

      return;
    }

    if (event.defaultPrevented || hasModifier(event) || disabled) return;
    const target = event.target;
    const inSearch = target === searchInputRef.current;

    if (isEditableKeyboardTarget(target) && !inSearch) return;

    const navigable =
      inSearch || target === listRef.current || target === event.currentTarget;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!navigable) return;
      event.preventDefault();
      event.stopPropagation();
      moveCursor(event.key === "ArrowDown" ? 1 : -1);

      return;
    }

    if (event.key === "Enter") {
      if (!navigable || editing || highlightedIndex < 0) return;
      const entry = navEntries[highlightedIndex];
      event.preventDefault();
      event.stopPropagation();

      if (entry.kind === "more") {
        toggleMore(entry.providerId);

        return;
      }

      if (entry.kind === "all") {
        openAllModels("");

        return;
      }

      if (entry.kind === "favorite") {
        if (entry.row.landing !== null) applyMenuFavorite(entry.row.landing);

        return;
      }

      commitRow(entry.row, entry.row.landingLevel);

      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    if (
      pickerMode === "model" ||
      editing ||
      (inSearch && searchQuery.length > 0)
    )
      return;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const rowKey = matrixRowKeyFromTarget(target) ?? highlightedKey;
    const entry = rowKey === null ? undefined : entriesByKey.get(rowKey);

    if (entry?.kind === "all") {
      if (direction === 1) {
        event.preventDefault();
        event.stopPropagation();
        openAllModels("");
      }

      return;
    }

    if (entry?.kind === "favorite") {
      event.preventDefault();
      event.stopPropagation();

      const ready = entry.row.picks.flatMap((pick) =>
        pick.availability.state === "ready"
          ? [
              {
                value: pick.selection.reasoningLevel,
                label: pick.effortLabel,
              },
            ]
          : [],
      );

      const next =
        entry.row.landing === null
          ? null
          : stepRowReasoningLevel(
              ready,
              entry.row.landing.selection.reasoningLevel,
              direction,
            );

      setCursorKey(entry.row.key);

      if (next !== null)
        setLandingOverride({ key: entry.row.key, level: next });

      return;
    }

    const row = entry?.kind === "row" ? entry.row : undefined;

    if (rowKey !== null && row === undefined) return;

    if (row !== undefined && !row.selected) {
      event.preventDefault();
      event.stopPropagation();

      const next = stepRowReasoningLevel(
        row.option.reasoningOptions,
        row.landingLevel,
        direction,
      );

      setCursorKey(row.key);

      if (next !== null) setLandingOverride({ key: row.key, level: next });

      return;
    }

    stepSelectedReasoning(event, direction);
  };

  const handleQueryChange = useCallback((value: string) => {
    setSearchCursorVisible(true);
    setSearchQuery(value);
    setCursorKey(null);
    setLandingOverride(null);
  }, []);

  const handleTriggerIntent = useCallback(() => {
    ModelReasoningMenu.intentProps.onFocus();
    setCatalogIntent(true);
  }, []);

  const TriggerIcon =
    hasSelectedModel || modelIsLoading ? ProviderIcon : undefined;

  const selectedModelLoadErrorText =
    selectedModelLoadErrorMatches && modelLoadError
      ? formatModelLoadErrorText({
          error: modelLoadError,
          providerLabel: selectedProviderLabel,
        })
      : "Could not load models.";

  const triggerTitleModelLabel = modelIsLoading
    ? "Loading models..."
    : selectedModelLoadFailed
      ? selectedModelLoadErrorText
      : triggerModelLabel;

  const triggerTitle = [
    `${selectedProviderLabel}: ${triggerTitleModelLabel}`,
    triggerReasoningLabel ? ` · ${triggerReasoningLabel} reasoning` : "",
    selectedServiceTierOption
      ? ` (${selectedServiceTierOption.label} mode)`
      : "",
  ].join("");

  const labelTrigger = (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      size="sm"
      aria-label={
        toggleShortcut
          ? `Provider, model and reasoning (${toggleShortcut.label})`
          : "Provider, model and reasoning"
      }
      aria-keyshortcuts={toggleShortcut?.ariaKeyshortcuts}
      {...toggleCommandProps}
      disabled={disabled}
      onClick={() => setPickerMode("model-and-effort")}
      onPointerEnter={handleTriggerIntent}
      onFocus={handleTriggerIntent}
      onPointerDown={handleTriggerIntent}
      onKeyDown={handleTriggerKeyDown}
      className={cn(
        OPTION_BASE_CLASS_NAME,
        OPTION_INTERACTIVE_CLASS_NAME,
        muted && OPTION_MUTED_CLASS_NAME,
        muted && "font-normal",
        disabled && "cursor-default disabled:opacity-100",
        className,
      )}
    >
      <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME} title={triggerTitle}>
        {modelIsLoading ? (
          <>
            {TriggerIcon ? (
              <TriggerIcon className="size-4 shrink-0" />
            ) : (
              <Icon
                name="Spinner"
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            )}
            <span className="sr-only">Loading models</span>
            <Skeleton
              aria-hidden
              data-model-loading-placeholder="trigger-model"
              className="h-3 w-10 shrink-0 rounded-sm"
            />
            {showsEffort ? (
              <Skeleton
                aria-hidden
                data-model-loading-placeholder="trigger-reasoning"
                className="h-3 w-8 shrink-0 rounded-sm"
              />
            ) : null}
          </>
        ) : selectedServiceTierOption && disabled ? (
          <span
            role="img"
            aria-label={`${selectedServiceTierOption.label} mode`}
            className="inline-flex shrink-0 text-subtle-foreground"
          >
            <ModelSpeedIcon tier={selectedServiceTierOption.id} active />
          </span>
        ) : TriggerIcon ? (
          <TriggerIcon className="size-4 shrink-0" />
        ) : null}
        {modelIsLoading ? null : (
          <>
            <span
              className={cn(
                "min-w-0 truncate",
                triggerModelValueIsDestructive && "text-destructive-text",
              )}
            >
              {triggerModelBase}
            </span>
            {triggerModelTag ? (
              <span className="shrink-0 text-subtle-foreground">
                {triggerModelTag}
              </span>
            ) : null}
            {triggerReasoningLabel ? (
              <span
                className="shrink-0 text-subtle-foreground"
                data-promptbox-hide-compact=""
              >
                {triggerReasoningLabel}
              </span>
            ) : null}
          </>
        )}
      </span>
      {disabled ? null : (
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3.5 shrink-0",
            muted ? "text-subtle-foreground/75" : "text-muted-foreground",
          )}
        />
      )}
      <AppCommandShortcutHint
        shortcut={disabled ? null : toggleShortcut}
        className="ml-1"
      />
    </Button>
  );

  const allModelsTrigger = (hidden: number) => (
    <button
      ref={triggerRef}
      type="button"
      aria-label={
        toggleShortcut
          ? `${allModelsLabel(hidden)} (${toggleShortcut.label})`
          : allModelsLabel(hidden)
      }
      aria-keyshortcuts={toggleShortcut?.ariaKeyshortcuts}
      {...toggleCommandProps}
      onClick={() => setPickerMode("model-and-effort")}
      onPointerEnter={handleTriggerIntent}
      onFocus={handleTriggerIntent}
      onPointerDown={handleTriggerIntent}
      onKeyDown={handleTriggerKeyDown}
      className={FAVORITE_BAR_ICON_SEGMENT_CLASS_NAME}
    >
      {hidden === 0 ? null : (
        <span className={ALL_MODELS_COUNT_CLASS_NAME}>+{hidden}</span>
      )}
      <AllModelsIcon />
    </button>
  );

  if (disabled) return labelTrigger;

  const activeServiceTierOptions = serviceTierModelReady
    ? effectiveServiceTierOptions
    : EMPTY_SERVICE_TIER_OPTIONS;

  const picker = (trigger: ReactElement) => (
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger ref={modalHostRef} asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        mobileTitle={handoffActive ? "Handoff to new thread" : "Model"}
        mobileClassName={cn(
          browseView === "all"
            ? COMPACT_SEARCH_DRAWER_CLASS_NAME
            : COMPACT_FAVORITES_DRAWER_CLASS_NAME,
          handoffActive && HANDOFF_DRAWER_TOP_CLASS_NAME,
        )}
        onKeyDown={handleContentKeyDown}
        onEscapeKeyDown={(event) => {
          if (browseView !== "all" || viewSession?.fromFavorites !== true) {
            return;
          }

          event.preventDefault();
          showFavorites();
        }}
        onMobileContentAnimationEnd={handleMobileContentAnimationEnd}
        onCloseAutoFocus={handleCloseAutoFocus}
        autoFocusRef={entryView === "all" ? searchInputRef : listRef}
        className={cn(
          "flex min-h-0 flex-col p-0",
          isCompactViewport
            ? "flex-1 overflow-y-hidden"
            : cn(
                MODEL_PICKER_MENU_WIDTH_CLASS_NAME,
                "max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] overflow-hidden",
              ),
        )}
      >
        <ResetBrowseStateOnContentUnmount onReset={resetBrowseState} />
        {handoffActive && handoff !== undefined ? (
          <HandoffModeHeader onBack={handoff.onExit} />
        ) : null}
        {browseView === "all" ? (
          <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
            {pickerMode === "model" || !preferencesReady ? null : (
              <button
                type="button"
                aria-label="Back to favorites"
                onClick={showFavorites}
                className={cn(
                  TOOLBAR_BUTTON_CLASS_NAME,
                  "w-7 max-md:pointer-coarse:w-9",
                )}
              >
                <Icon name="ChevronLeft" aria-hidden className="size-3.5" />
              </button>
            )}
            <ModelSearchInput
              inputRef={searchInputRef}
              query={searchQuery}
              onQueryChange={handleQueryChange}
              gridId={gridId}
              activeOptionId={
                highlightedIndex >= 0
                  ? optionDomId(highlightedIndex)
                  : undefined
              }
            />
            {preferencesReady && pickerMode !== "model" ? (
              <Button
                type="button"
                size="xs"
                variant={editing ? "default" : "ghost"}
                onClick={() => setEditing((current) => !current)}
                className={cn(
                  "mr-0.5 shrink-0",
                  !editing && "text-muted-foreground",
                )}
              >
                <Icon name={editing ? "Check" : "Edit"} aria-hidden />
                {editing ? "Done" : "Edit"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {browseView === "all" &&
        editing &&
        preferencesReady &&
        pickerMode !== "model" ? (
          <p
            data-model-picker-edit-hint=""
            className="flex w-0 min-w-full shrink-0 items-start gap-1.5 border-b border-border bg-state-hover px-3 py-1.5 text-xs text-muted-foreground"
          >
            <Icon
              name="Star"
              aria-hidden
              className="mt-0.5 size-3 shrink-0 text-subtle-foreground"
            />
            <span className="min-w-0">
              Star the levels you want in Favorites. Use the eye to move models
              you rarely use under “more”.
            </span>
          </p>
        ) : null}

        <ModelReasoningMenu
          key={browseView}
          matrix={{
            listRef,
            gridId,
            optionId: optionDomId,
            activeDescendantId:
              browseView !== "all" && highlightedIndex >= 0
                ? optionDomId(highlightedIndex)
                : undefined,
            favorites:
              favoritesStore === null || browseView !== "favorites"
                ? null
                : {
                    rows: favoriteRows,
                    notices: favoriteNotices,
                    star:
                      starRowKey === null
                        ? null
                        : {
                            rowKey: starRowKey,
                            pressed: currentIsFavorite,
                            disabled: !canToggleCurrentFavorite,
                            onToggle: () => {
                              setStarredRowKey(starRowKey);
                              toggleCurrentFavorite();
                            },
                          },
                    revealedKey: revealedFavoriteKey,
                    onPick: applyMenuFavorite,
                    onTogglePick: toggleFavoritePick,
                    onReveal: setRevealedFavoriteKey,
                    onConceal: () => setRevealedFavoriteKey(null),
                  },
            favoriteMenu:
              favoritesStore === null || pickerMode === "model"
                ? null
                : { full: favoritesStore.isFull },
            allModels:
              browseView === "favorites"
                ? { onOpen: () => openAllModels("") }
                : null,
            groups: visibleGroups,
            columns: pickerMode === "model" ? [] : columns,
            navIndexByKey,
            open,
            highlightedKey,
            cursorVisible:
              (isSearching && searchCursorVisible) || cursorKey !== null,
            reasoningValue,
            editing,
            isSearching,
            isFavoriteCell,
            onCommit: commitRow,
            onToggleMore: toggleMore,
            onToggleHidden: toggleHidden,
            onToggleFavorite: toggleFavoriteCell,
            onPointerNavigation: handlePointerNavigation,
          }}
          agentSections={pickerMode === "model" ? [] : agentSections}
          onAgentOptionChange={onAgentOptionChange}
          onStartHandoff={
            handoff !== undefined && !handoffActive ? startHandoff : null
          }
        />
      </PopoverContent>
    </Popover>
  );

  const speed: ModelSpeed | null =
    activeServiceTierOptions.length === 0
      ? null
      : {
          options: activeServiceTierOptions,
          value: serviceTierValue,
          onChange: onServiceTierChange,
        };

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1",
        presentation === "footer" && "max-md:flex-nowrap",
      )}
    >
      {switcherFavorites === null ? (
        <>
          {picker(labelTrigger)}
          {speed === null ? null : (
            <ModelSpeedControl
              speed={speed}
              className={MODEL_SPEED_BUTTON_CLASS_NAME}
            />
          )}
        </>
      ) : (
        <ModelFavoritesBar
          preference={switcherFavorites}
          current={favorites.current}
          providerOrder={providerOrder}
          presentation={presentation}
          selects={selects}
          speed={speed}
          allModels={(hidden) => picker(allModelsTrigger(hidden))}
          pill={picker(labelTrigger)}
          onPick={applySelection}
          onKeep={keepBarFavorite}
          onOpenModels={() => {
            setPickerMode("model");
            setEditing(false);
            handleTriggerIntent();
            setOpen(true);
          }}
        />
      )}
    </div>
  );
}

function HandoffModeHeader({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1 bg-background px-2 pb-1 pt-1.5">
      <button
        type="button"
        aria-label="Exit handoff"
        onClick={onBack}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
          CONTROL_PRESS_TRANSITION,
          CONTROL_PRESS_FEEDBACK,
        )}
      >
        <Icon name="X" className="size-3.5" aria-hidden />
      </button>
      <span className="min-w-0 truncate text-xs font-normal text-subtle-foreground">
        Handoff to new thread
      </span>
    </div>
  );
}

function ResetBrowseStateOnContentUnmount({
  onReset,
}: {
  onReset: () => void;
}) {
  useEffect(() => onReset, [onReset]);

  return null;
}

interface ModelSearchInputProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  gridId: string;
  activeOptionId: string | undefined;
}

function ModelSearchInput({
  inputRef,
  query,
  onQueryChange,
  gridId,
  activeOptionId,
}: ModelSearchInputProps) {
  return (
    <div className="relative min-w-0 flex-1">
      <Icon
        name="Search"
        className="pointer-events-none absolute left-1.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search models"
        aria-label="Search models"
        role="combobox"
        aria-expanded
        aria-haspopup="grid"
        aria-controls={gridId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        className="h-7 border-0 bg-transparent pl-8 pr-2 text-xs text-foreground placeholder:text-subtle-foreground shadow-none focus-visible:ring-0"
      />
    </div>
  );
}
