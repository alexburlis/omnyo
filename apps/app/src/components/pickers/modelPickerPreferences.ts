import { useCallback, useMemo } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  DEFAULT_SERVICE_TIER,
  MODEL_PICKER_FAVORITES_MAX,
  type ModelPickerFavorite,
} from "@omnyo/domain";
import { reorderStoredOrder } from "@/lib/stored-order";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import { useUiPreferencesReady } from "@/lib/ui-preferences/UiPreferencesSync";
import { favoriteKey, matchingFavorite, toFavorite } from "./model-favorites";
import { modelPickerRowKey } from "./model-picker-menu";
import type { ModelPickerSelection } from "./model-picker-selection";

export const modelPickerFavoritesAtom = createSyncedPreferenceAtom(
  "modelPicker.favorites",
);

export const modelPickerHiddenModelsAtom = createSyncedPreferenceAtom(
  "modelPicker.hiddenModels",
);

export const modelPickerFooterFavoritesAtom = createSyncedPreferenceAtom(
  "modelPicker.footerFavorites",
);

type HiddenModels = Record<string, string[]>;

const NO_HIDDEN_MODELS: ReadonlySet<string> = new Set();

const NO_FAVORITES: readonly ModelPickerFavorite[] = [];

export interface ModelPickerFavoritesState {
  ready: boolean;
  favorites: readonly ModelPickerFavorite[];
  isFull: boolean;
  isFavorite: (
    selection: ModelPickerSelection,
    providerHasServiceTiers: boolean,
  ) => boolean;
  toggle: (
    selection: ModelPickerSelection,
    providerHasServiceTiers: boolean,
  ) => void;
  add: (
    selection: ModelPickerSelection,
    providerHasServiceTiers: boolean,
  ) => void;
  remove: (key: string) => void;
  moveModel: (from: FavoriteModelRef, to: FavoriteModelRef) => void;
}

export type FavoriteModelRef = Pick<
  ModelPickerFavorite,
  "providerId" | "model"
>;

export interface ModelPickerHiddenModelsState {
  ready: boolean;
  hiddenModels: Readonly<Record<string, readonly string[]>>;
  hiddenFor: (providerId: string) => ReadonlySet<string>;
  hide: (providerId: string, model: string) => void;
  unhide: (providerId: string, model: string) => void;
}

export interface FooterFavoritesState {
  ready: boolean;
  shown: boolean;
  setShown: (shown: boolean) => void;
}

function addFavorite(
  favorites: ModelPickerFavorite[],
  favorite: ModelPickerFavorite,
): ModelPickerFavorite[] {
  const key = favoriteKey(favorite);

  if (
    favorites.length >= MODEL_PICKER_FAVORITES_MAX ||
    favorites.some((existing) => favoriteKey(existing) === key)
  ) {
    return favorites;
  }

  return [...favorites, favorite];
}

function removeFavorite(
  favorites: ModelPickerFavorite[],
  key: string,
): ModelPickerFavorite[] {
  const next = favorites.filter((favorite) => favoriteKey(favorite) !== key);

  return next.length === favorites.length ? favorites : next;
}

function favoriteModelKey(favorite: FavoriteModelRef): string {
  return modelPickerRowKey(favorite.providerId, favorite.model);
}

function moveFavoriteModel(
  favorites: ModelPickerFavorite[],
  from: FavoriteModelRef,
  to: FavoriteModelRef,
): ModelPickerFavorite[] {
  const models = [...new Set(favorites.map(favoriteModelKey))];

  const nextModels = reorderStoredOrder({
    activeId: favoriteModelKey(from),
    overId: favoriteModelKey(to),
    order: models,
    visibleIds: models,
  });

  if (nextModels === null) return favorites;
  const rank = new Map(nextModels.map((key, index) => [key, index]));

  return [...favorites].sort(
    (a, b) =>
      (rank.get(favoriteModelKey(a)) ?? 0) -
      (rank.get(favoriteModelKey(b)) ?? 0),
  );
}

function hideModel(
  hiddenModels: HiddenModels,
  providerId: string,
  model: string,
): HiddenModels {
  const current = hiddenModels[providerId] ?? [];

  if (current.includes(model)) return hiddenModels;

  return { ...hiddenModels, [providerId]: [...current, model] };
}

function unhideModel(
  hiddenModels: HiddenModels,
  providerId: string,
  model: string,
): HiddenModels {
  const current = hiddenModels[providerId];

  if (current === undefined || !current.includes(model)) return hiddenModels;
  const remaining = current.filter((hidden) => hidden !== model);
  const next = { ...hiddenModels };

  if (remaining.length === 0) {
    delete next[providerId];
  } else {
    next[providerId] = remaining;
  }

  return next;
}

export function useModelPickerFavorites(): ModelPickerFavoritesState {
  const ready = useUiPreferencesReady();
  const [storedFavorites, setFavorites] = useAtom(modelPickerFavoritesAtom);

  const isFavorite = useCallback(
    (selection: ModelPickerSelection, providerHasServiceTiers: boolean) =>
      matchingFavorite(storedFavorites, selection, providerHasServiceTiers) !==
      undefined,
    [storedFavorites],
  );

  const add = useCallback(
    (selection: ModelPickerSelection, providerHasServiceTiers: boolean) => {
      const favorite = toFavorite(selection, providerHasServiceTiers);
      setFavorites((favorites) => addFavorite(favorites, favorite));
    },
    [setFavorites],
  );

  const remove = useCallback(
    (key: string) => {
      setFavorites((favorites) => removeFavorite(favorites, key));
    },
    [setFavorites],
  );

  const toggle = useCallback(
    (selection: ModelPickerSelection, providerHasServiceTiers: boolean) => {
      const match = matchingFavorite(
        storedFavorites,
        selection,
        providerHasServiceTiers,
      );

      if (match !== undefined) {
        remove(favoriteKey(match));

        return;
      }

      const favorite: ModelPickerFavorite = {
        providerId: selection.providerId,
        model: selection.model,
        reasoningLevel: selection.reasoningLevel,
        serviceTier: DEFAULT_SERVICE_TIER,
      };

      setFavorites((favorites) => addFavorite(favorites, favorite));
    },
    [remove, setFavorites, storedFavorites],
  );

  const moveModel = useCallback(
    (from: FavoriteModelRef, to: FavoriteModelRef) => {
      setFavorites((favorites) => moveFavoriteModel(favorites, from, to));
    },
    [setFavorites],
  );

  return {
    ready,
    favorites: ready ? storedFavorites : NO_FAVORITES,
    isFull: storedFavorites.length >= MODEL_PICKER_FAVORITES_MAX,
    isFavorite,
    toggle,
    add,
    remove,
    moveModel,
  };
}

export function useModelPickerHiddenModelIds(
  providerId: string,
): ReadonlySet<string> {
  const models = useAtomValue(modelPickerHiddenModelsAtom)[providerId];

  return useMemo(
    () => (models === undefined ? NO_HIDDEN_MODELS : new Set(models)),
    [models],
  );
}

export function useModelPickerHiddenModels(): ModelPickerHiddenModelsState {
  const ready = useUiPreferencesReady();
  const [hiddenModels, setHiddenModels] = useAtom(modelPickerHiddenModelsAtom);

  const hiddenSets = useMemo(
    () =>
      new Map(
        Object.entries(hiddenModels).map(([providerId, models]) => [
          providerId,
          new Set(models),
        ]),
      ),
    [hiddenModels],
  );

  const hiddenFor = useCallback(
    (providerId: string): ReadonlySet<string> =>
      (ready ? hiddenSets.get(providerId) : undefined) ?? NO_HIDDEN_MODELS,
    [hiddenSets, ready],
  );

  const hide = useCallback(
    (providerId: string, model: string) => {
      setHiddenModels((current) => hideModel(current, providerId, model));
    },
    [setHiddenModels],
  );

  const unhide = useCallback(
    (providerId: string, model: string) => {
      setHiddenModels((current) => unhideModel(current, providerId, model));
    },
    [setHiddenModels],
  );

  return { ready, hiddenModels, hiddenFor, hide, unhide };
}

export function useFooterFavorites(): FooterFavoritesState {
  const ready = useUiPreferencesReady();
  const [shown, setShown] = useAtom(modelPickerFooterFavoritesAtom);

  return { ready, shown, setShown };
}
