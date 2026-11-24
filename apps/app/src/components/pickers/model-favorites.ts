import type { ComponentType } from "react";
import {
  DEFAULT_SERVICE_TIER,
  modelPickerFavoriteKey,
  reconcileServiceTier,
  type ModelPickerFavorite,
  type ServiceTier,
} from "@omnyo/domain";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import { stripModelBrandPrefix } from "./model-brand-prefix";
import type { ModelPickerOption } from "./model-picker-option";
import {
  rowOffersReasoningLevel,
  selectionServiceTier,
  type ModelPickerProviderCatalog,
  type ModelPickerSelection,
} from "./model-picker-selection";

export type { ModelPickerFavorite };

export type FavoriteAvailability =
  | { state: "ready" }
  | { state: "pending" }
  | { state: "unavailable"; reason: string };

export type FavoriteLanding =
  | { state: "ready"; selection: ModelPickerSelection }
  | Exclude<FavoriteAvailability, { state: "ready" }>;

export interface FavoriteAvailabilityContext {
  catalogs: ReadonlyMap<string, ModelPickerProviderCatalog>;
  disabledProviders: ReadonlyMap<string, string>;
  allowFastServiceTier: boolean;
}

export interface FavoriteDescription {
  modelLabel: string;
  reasoningLabel: string;
  serviceTierLabel: string | null;
  label: string;
}

export interface ModelFavoriteChipItem {
  key: string;
  favorite: ModelPickerFavorite;
  selection: Required<ModelPickerSelection>;
  description: FavoriteDescription;
  icon: ComponentType<{ className?: string }> | undefined;
  availability: FavoriteAvailability;
  current: boolean;
  startsNewChat: boolean;
}

export const FAVORITE_NOT_ON_THIS_MACHINE = "Not on this machine";

export const FAVORITE_MODELS_FAILED = "Models didn't load";

export const FAVORITE_PENDING_REASON = "Loading models";

const FAVORITE_CONFLICT_FALLBACK = "Not available with the current options";

const READY: FavoriteAvailability = { state: "ready" };

const PENDING: FavoriteAvailability = { state: "pending" };

export function favoriteKey(favorite: ModelPickerFavorite): string {
  return modelPickerFavoriteKey(favorite);
}

export function favoriteUnavailableReason(
  availability: FavoriteAvailability,
): string | null {
  if (availability.state === "unavailable") return availability.reason;

  return availability.state === "pending" ? FAVORITE_PENDING_REASON : null;
}

export function toFavorite(
  selection: ModelPickerSelection,
  providerHasServiceTiers: boolean,
): ModelPickerFavorite {
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: selection.reasoningLevel,
    serviceTier: selectionServiceTier(selection, providerHasServiceTiers),
  };
}

export function matchingFavorite<Favorite extends ModelPickerFavorite>(
  favorites: readonly Favorite[],
  selection: ModelPickerSelection,
  providerHasServiceTiers: boolean,
): Favorite | undefined {
  const tier = selectionServiceTier(selection, providerHasServiceTiers);

  const sameEffort = favorites.filter(
    (favorite) =>
      favorite.providerId === selection.providerId &&
      favorite.model === selection.model &&
      favorite.reasoningLevel === selection.reasoningLevel,
  );

  return (
    sameEffort.find(
      (favorite) =>
        selectionServiceTier(favorite, providerHasServiceTiers) === tier,
    ) ??
    sameEffort.find((favorite) => favorite.serviceTier === DEFAULT_SERVICE_TIER)
  );
}

export function favoriteSelection(
  favorite: ModelPickerFavorite,
  row: Pick<ModelPickerOption, "serviceTierOptions"> | undefined,
  currentServiceTier: ServiceTier,
  allowFastServiceTier: boolean,
): Required<ModelPickerSelection> {
  const { providerId, model, reasoningLevel } = favorite;

  if (favorite.serviceTier !== DEFAULT_SERVICE_TIER) {
    return {
      providerId,
      model,
      reasoningLevel,
      serviceTier: favorite.serviceTier,
    };
  }

  const serviceTier =
    allowFastServiceTier && row !== undefined
      ? reconcileServiceTier(currentServiceTier, row.serviceTierOptions)
      : DEFAULT_SERVICE_TIER;

  return { providerId, model, reasoningLevel, serviceTier };
}

function unavailable(reason: string): FavoriteAvailability {
  return { state: "unavailable", reason };
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function findCatalogRow(
  catalog: ModelPickerProviderCatalog,
  model: string,
): ModelPickerOption | undefined {
  return (
    catalog.modelOptions.find((row) => row.value === model) ??
    catalog.moreModelOptions.find((row) => row.value === model)
  );
}

function serviceTierLabel(
  serviceTier: ServiceTier,
  catalog: ModelPickerProviderCatalog | undefined,
  row: ModelPickerOption | undefined,
): string {
  return (
    row?.serviceTierOptions.find((option) => option.id === serviceTier)
      ?.label ??
    catalog?.provider.serviceTiers?.find((option) => option.id === serviceTier)
      ?.label ??
    titleCase(serviceTier)
  );
}

export function describeFavorite(
  favorite: ModelPickerFavorite,
  catalog: ModelPickerProviderCatalog | undefined,
): FavoriteDescription {
  const row =
    catalog === undefined ? undefined : findCatalogRow(catalog, favorite.model);

  const modelLabel =
    row === undefined
      ? favorite.model
      : stripModelBrandPrefix(
          row.label,
          catalog?.provider.strings?.brandPrefix,
        );

  const reasoningLabel =
    row?.reasoningOptions.find(
      (option) => option.value === favorite.reasoningLevel,
    )?.label ?? reasoningLevelLabel(favorite.reasoningLevel, catalog?.provider);

  const tierLabel =
    favorite.serviceTier === DEFAULT_SERVICE_TIER
      ? null
      : serviceTierLabel(favorite.serviceTier, catalog, row);

  return {
    modelLabel,
    reasoningLabel,
    serviceTierLabel: tierLabel,
    label: `${modelLabel} · ${reasoningLabel}`,
  };
}

export function resolveFavoriteAvailability(
  favorite: ModelPickerFavorite,
  context: FavoriteAvailabilityContext,
): FavoriteAvailability {
  const catalog = context.catalogs.get(favorite.providerId);

  if (catalog === undefined) {
    const providerLabel = context.disabledProviders.get(favorite.providerId);

    return unavailable(
      providerLabel === undefined
        ? FAVORITE_NOT_ON_THIS_MACHINE
        : `${providerLabel} is off`,
    );
  }

  if (catalog.status === "loading") return PENDING;

  if (catalog.status === "failed") return unavailable(FAVORITE_MODELS_FAILED);
  const row = findCatalogRow(catalog, favorite.model);

  if (row === undefined) return unavailable(FAVORITE_NOT_ON_THIS_MACHINE);

  if (
    row.reasoningOptions.length > 0 &&
    !rowOffersReasoningLevel(row, favorite.reasoningLevel)
  ) {
    const { modelLabel, reasoningLabel } = describeFavorite(favorite, catalog);

    return unavailable(`${modelLabel} has no ${reasoningLabel}`);
  }

  if (
    favorite.serviceTier !== DEFAULT_SERVICE_TIER &&
    (!context.allowFastServiceTier ||
      !row.serviceTierOptions.some(
        (option) => option.id === favorite.serviceTier,
      ))
  ) {
    return unavailable(
      `${serviceTierLabel(favorite.serviceTier, catalog, row)} isn't available`,
    );
  }

  if (row.disabled === true) {
    return unavailable(row.disabledReason ?? FAVORITE_CONFLICT_FALLBACK);
  }

  return READY;
}
