import { useCallback, useMemo } from "react";
import {
  DEFAULT_SERVICE_TIER,
  allowsFastServiceTier,
  type ProviderInfo,
  type ProviderOptionDescriptor,
  type ReasoningLevel,
  type ServiceTier,
  type SessionOptionSelections,
} from "@omnyo/domain";
import type { SystemProvidersQuery } from "@omnyo/server-contract";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useUiPreferencesLoadState } from "@/lib/ui-preferences/UiPreferencesSync";
import type { CurrentPick } from "./favorite-bars";
import type { ProviderPickerOption } from "./model-brand-prefix";
import {
  describeFavorite,
  favoriteKey,
  favoriteSelection,
  FAVORITE_MODELS_FAILED,
  findCatalogRow,
  matchingFavorite,
  resolveFavoriteAvailability,
  toFavorite,
  type FavoriteAvailability,
  type FavoriteLanding,
  type ModelFavoriteChipItem,
  type ModelPickerFavorite,
} from "./model-favorites";
import {
  landingReasoningLevel,
  type ModelPickerProviderCatalog,
  type ModelPickerSelection,
} from "./model-picker-selection";
import { useModelPickerFavorites } from "./modelPickerPreferences";
import type { PickerOption } from "./OptionPicker";
import {
  useDisabledProviderLabels,
  useModelPickerCatalogs,
} from "./useModelPickerCatalogs";

const NO_PROVIDERS: readonly ProviderInfo[] = [];

const PENDING_AVAILABILITY: FavoriteAvailability = { state: "pending" };

const LOADING_PREFERENCE: FavoritesPreference = { status: "loading" };

export type CatalogDemand = "none" | "favorites" | "browse";

export type SelectedCatalogState = Omit<
  ModelPickerProviderCatalog,
  "providerId" | "provider"
>;

export interface FavoritesStore {
  items: readonly ModelFavoriteChipItem[];
  isFull: boolean;
  isFavorite: (selection: ModelPickerSelection) => boolean;
  toggle: (selection: ModelPickerSelection) => void;
  remove: (key: string) => void;
}

export type FavoritesPreference =
  | { status: "loading" }
  | ({ status: "failed" | "ready" } & FavoritesStore);

export interface UseModelFavoritesArgs {
  routing: SystemProvidersQuery;
  providers: readonly ProviderInfo[];
  providerOptions: readonly ProviderPickerOption[];
  canSwitchProviders: boolean;
  providersSettled: boolean;
  catalogDemand: CatalogDemand;
  sessionOptionSelectionsForProvider: (
    providerId: string,
  ) => SessionOptionSelections;
  selection: ModelPickerSelection;
  reasoningOptions: readonly PickerOption<ReasoningLevel>[];
  serviceTierOptions: readonly ProviderOptionDescriptor[];
  selectedCatalog: SelectedCatalogState;
  handoff: { sourceProviderId: string; active: boolean } | undefined;
}

export interface ModelFavorites {
  catalogs: ReadonlyMap<string, ModelPickerProviderCatalog>;
  siblingCatalogs: readonly ModelPickerProviderCatalog[];
  effectiveServiceTier: ServiceTier;
  current: CurrentPick;
  preference: FavoritesPreference;
}

export function useModelFavorites({
  routing,
  providers,
  providerOptions,
  canSwitchProviders,
  providersSettled,
  catalogDemand,
  sessionOptionSelectionsForProvider,
  selection,
  reasoningOptions,
  serviceTierOptions,
  selectedCatalog,
  handoff,
}: UseModelFavoritesArgs): ModelFavorites {
  const {
    providerId: selectedProviderId,
    model: modelValue,
    reasoningLevel: reasoningValue,
    serviceTier: serviceTierValue,
  } = selection;

  const {
    status: selectedStatus,
    loadError: selectedLoadError,
    notice: selectedNotice,
    modelOptions,
    moreModelOptions,
    catalogModelOptions,
  } = selectedCatalog;

  const handoffSourceProviderId = handoff?.sourceProviderId;
  const handoffActive = handoff?.active === true;
  const loadState = useUiPreferencesLoadState();

  const {
    favorites,
    isFull,
    isFavorite: isStoredFavorite,
    toggle: toggleStoredFavorite,
    remove,
  } = useModelPickerFavorites();

  const disabledProviders = useDisabledProviderLabels();
  const systemConfig = useSystemConfig();

  const serviceTierSettings = systemConfig.data?.generalSettings;

  const catalogsEnabled =
    catalogDemand === "browse" ||
    (catalogDemand === "favorites" && favorites.length > 0);

  const providerInfoById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  const siblingProviders = useMemo(
    () =>
      canSwitchProviders
        ? providerOptions.flatMap((option) => {
            const info = providerInfoById.get(option.value);

            return info === undefined || option.value === selectedProviderId
              ? []
              : [info];
          })
        : NO_PROVIDERS,
    [canSwitchProviders, providerInfoById, providerOptions, selectedProviderId],
  );

  const siblingCatalogs = useModelPickerCatalogs({
    routing,
    providers: siblingProviders,
    selectedProviderId,
    enabled: catalogsEnabled && canSwitchProviders,
    sessionOptionSelectionsForProvider,
  });

  const selectedInfo = providerInfoById.get(selectedProviderId);

  const catalogs = useMemo(() => {
    const byProvider = new Map<string, ModelPickerProviderCatalog>();

    if (selectedInfo !== undefined) {
      byProvider.set(selectedProviderId, {
        providerId: selectedProviderId,
        provider: selectedInfo,
        status: selectedStatus,
        loadError: selectedLoadError,
        notice: selectedNotice,
        modelOptions,
        moreModelOptions,
        catalogModelOptions,
      });
    }

    for (const catalog of siblingCatalogs) {
      byProvider.set(catalog.providerId, catalog);
    }

    return byProvider;
  }, [
    catalogModelOptions,
    modelOptions,
    moreModelOptions,
    selectedInfo,
    selectedLoadError,
    selectedNotice,
    selectedProviderId,
    selectedStatus,
    siblingCatalogs,
  ]);

  const providerHasServiceTiers = useCallback(
    (providerId: string): boolean =>
      catalogs.get(providerId)?.provider.capabilities.supportsServiceTier ??
      false,
    [catalogs],
  );

  const effectiveServiceTier: ServiceTier =
    serviceTierValue !== undefined &&
    serviceTierOptions.some((option) => option.id === serviceTierValue)
      ? serviceTierValue
      : DEFAULT_SERVICE_TIER;

  const currentSelection = useMemo(
    (): ModelPickerSelection => ({
      providerId: selectedProviderId,
      model: modelValue,
      reasoningLevel: reasoningValue,
      serviceTier: effectiveServiceTier,
    }),
    [effectiveServiceTier, modelValue, reasoningValue, selectedProviderId],
  );

  const favoriteAvailability = useCallback(
    (favorite: ModelPickerFavorite): FavoriteAvailability => {
      if (!catalogs.has(favorite.providerId)) {
        if (favorite.providerId === selectedProviderId) {
          return selectedStatus === "failed"
            ? { state: "unavailable", reason: FAVORITE_MODELS_FAILED }
            : PENDING_AVAILABILITY;
        }

        if (
          !providersSettled &&
          providerOptions.some((option) => option.value === favorite.providerId)
        ) {
          return PENDING_AVAILABILITY;
        }
      }

      return resolveFavoriteAvailability(favorite, {
        catalogs,
        disabledProviders,
        allowFastServiceTier: allowsFastServiceTier(
          serviceTierSettings,
          favorite.providerId,
        ),
      });
    },
    [
      serviceTierSettings,
      catalogs,
      disabledProviders,
      providerOptions,
      providersSettled,
      selectedProviderId,
      selectedStatus,
    ],
  );

  const items = useMemo((): ModelFavoriteChipItem[] => {
    const currentFavorite = matchingFavorite(
      favorites,
      currentSelection,
      providerHasServiceTiers(selectedProviderId),
    );

    return favorites
      .filter(
        (favorite) =>
          canSwitchProviders || favorite.providerId === selectedProviderId,
      )
      .map((favorite) => {
        const catalog = catalogs.get(favorite.providerId);

        return {
          key: favoriteKey(favorite),
          favorite,
          selection: favoriteSelection(
            favorite,
            catalog === undefined
              ? undefined
              : findCatalogRow(catalog, favorite.model),
            effectiveServiceTier,
            allowsFastServiceTier(serviceTierSettings, favorite.providerId),
          ),
          description: describeFavorite(favorite, catalog),
          icon: providerOptions.find(
            (option) => option.value === favorite.providerId,
          )?.icon,
          availability: favoriteAvailability(favorite),
          current: favorite === currentFavorite,
          startsNewChat:
            handoffSourceProviderId !== undefined &&
            !handoffActive &&
            favorite.providerId !== handoffSourceProviderId,
        };
      });
  }, [
    canSwitchProviders,
    catalogs,
    currentSelection,
    effectiveServiceTier,
    favoriteAvailability,
    favorites,
    handoffActive,
    handoffSourceProviderId,
    providerHasServiceTiers,
    providerOptions,
    selectedProviderId,
    serviceTierSettings,
  ]);

  const landOn = useCallback(
    (providerId: string, model: string): FavoriteLanding => {
      const catalog = catalogs.get(providerId);

      const row =
        catalog === undefined ? undefined : findCatalogRow(catalog, model);

      const selection: ModelPickerSelection = {
        providerId,
        model,
        reasoningLevel:
          row === undefined
            ? reasoningValue
            : landingReasoningLevel(row, reasoningValue),
      };

      const availability = favoriteAvailability({
        ...selection,
        serviceTier: DEFAULT_SERVICE_TIER,
      });

      return availability.state === "ready"
        ? { state: "ready", selection }
        : availability;
    },
    [catalogs, favoriteAvailability, reasoningValue],
  );

  const current = useMemo((): CurrentPick => {
    const pick = toFavorite(
      currentSelection,
      providerHasServiceTiers(selectedProviderId),
    );

    return {
      selection: pick,
      description: describeFavorite(pick, catalogs.get(selectedProviderId)),
      icon: providerOptions.find(
        (option) => option.value === selectedProviderId,
      )?.icon,
      efforts: reasoningOptions,
      landOn,
    };
  }, [
    catalogs,
    currentSelection,
    landOn,
    providerHasServiceTiers,
    providerOptions,
    reasoningOptions,
    selectedProviderId,
  ]);

  const isFavorite = useCallback(
    (candidate: ModelPickerSelection) =>
      isStoredFavorite(
        candidate,
        providerHasServiceTiers(candidate.providerId),
      ),
    [isStoredFavorite, providerHasServiceTiers],
  );

  const toggle = useCallback(
    (candidate: ModelPickerSelection) => {
      toggleStoredFavorite(
        candidate,
        providerHasServiceTiers(candidate.providerId),
      );
    },
    [providerHasServiceTiers, toggleStoredFavorite],
  );

  const preference = useMemo(
    (): FavoritesPreference =>
      loadState === "loading"
        ? LOADING_PREFERENCE
        : {
            status: loadState === "failed" ? "failed" : "ready",
            items,
            isFull,
            isFavorite,
            toggle,
            remove,
          },
    [isFavorite, isFull, items, loadState, remove, toggle],
  );

  return {
    catalogs,
    siblingCatalogs,
    effectiveServiceTier,
    current,
    preference,
  };
}
