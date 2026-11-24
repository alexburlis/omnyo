import { useMemo, useState, type CSSProperties } from "react";
import {
  allowsFastServiceTier,
  MODEL_PICKER_FAVORITES_MAX,
  type AppSettings,
  type ModelPickerFavorite,
  type ProviderInfo,
  type ReasoningLevel,
  type ServiceTier,
  type SessionOptionSelections,
} from "@omnyo/domain";
import type { SystemProvidersQuery } from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Switch } from "@omnyo/shared-ui/switch";
import type { ExperimentalProviderModelPickerValue } from "@omnyo/plugin-sdk";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import { LazyPluginProviderModelPicker } from "@/components/plugin/LazyPluginProviderModelPicker";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { stripModelBrandPrefix } from "@/components/pickers/model-brand-prefix";
import {
  buildFavoriteRows,
  type FavoritePick,
} from "@/components/pickers/favorite-bars";
import { FavoriteLevelToggle } from "@/components/pickers/model-picker-chip";
import {
  describeFavorite,
  favoriteKey,
  findCatalogRow,
  resolveFavoriteAvailability,
  type ModelFavoriteChipItem,
} from "@/components/pickers/model-favorites";
import {
  compareModelPickerLevels,
  modelPickerColumns,
  type ModelPickerColumn,
} from "@/components/pickers/model-picker-menu";
import type { ModelPickerProviderCatalog } from "@/components/pickers/model-picker-selection";
import {
  useFooterFavorites,
  useModelPickerFavorites,
  useModelPickerHiddenModelIds,
  useModelPickerHiddenModels,
  type ModelPickerFavoritesState,
} from "@/components/pickers/modelPickerPreferences";
import {
  selectedModelPickerCatalog,
  useDisabledProviderLabels,
  useModelPickerCatalogs,
} from "@/components/pickers/useModelPickerCatalogs";
import { useSystemExecutionOptions } from "@/hooks/queries/system-queries";
import { resolveModelPickerRows } from "@/hooks/thread-creation-options/model-catalog-selection";
import { formatModelLabel } from "@/hooks/thread-creation-options/selection-state";
import { useUiPreferencesLoadState } from "@/lib/ui-preferences/UiPreferencesSync";
import {
  SortableSettingsRows,
  useSortableSettingsRow,
} from "./sortable-settings-rows";

type FastModeSettings = Pick<
  AppSettings,
  "allowFastServiceTier" | "providerAllowFastServiceTier"
>;

interface ModelPickerSettingsProps {
  providers: readonly ProviderInfo[];
  generalSettings: FastModeSettings;
}

interface ProviderDisplay {
  icon: { id: string; logoUrl?: string | null } & Partial<
    Pick<ProviderInfo, "icon" | "strings">
  >;
  label: string;
}

interface HiddenModelGroup {
  providerId: string;
  models: readonly string[];
}

interface FavoriteLevelCell {
  level: ReasoningLevel;
  label: string;
  pick: FavoritePick | null;
}

interface SettingsFavoriteRow {
  key: string;
  providerId: string;
  model: string;
  modelLabel: string;
  tierLabel: string | null;
  serviceTier: ServiceTier;
  cells: readonly FavoriteLevelCell[];
  picks: readonly FavoritePick[];
  reason: string | null;
}

interface SettingsFavoriteGroup {
  providerId: string;
  rows: readonly SettingsFavoriteRow[];
  sortable: boolean;
}

const PRIMARY_ROUTING: SystemProvidersQuery = {};

const NO_SESSION_OPTIONS: SessionOptionSelections = {};

const EMPTY_DRAFT: ExperimentalProviderModelPickerValue = {
  providerId: "",
  model: "",
  reasoningLevel: "medium",
};

const ROW_LANDING_LEVEL: ReasoningLevel = "medium";

const FOOTER_FAVORITES_LABEL = "Show favorites in the composer";

function noSessionOptions(): SessionOptionSelections {
  return NO_SESSION_OPTIONS;
}

function useAddPickerProviderCatalog(
  provider: ProviderInfo | undefined,
  enabled: boolean,
): ModelPickerProviderCatalog | undefined {
  const { data, isError, isPlaceholderData } = useSystemExecutionOptions({
    providerId: provider?.id,
    enabled: enabled && provider !== undefined,
  });

  const hiddenModels = useModelPickerHiddenModelIds(provider?.id ?? "");

  return useMemo(() => {
    if (
      provider === undefined ||
      data === undefined ||
      !data.providers.some((offered) => offered.id === provider.id)
    ) {
      return undefined;
    }

    return selectedModelPickerCatalog({
      provider,
      modelCatalogIsVerified:
        !isPlaceholderData && !isError && data.modelLoadError === null,
      modelLoadFailed: isError || data.modelLoadError !== null,
      modelLoadError: data.modelLoadError,
      modelNotice: data.modelNotice,
      ...resolveModelPickerRows({
        models: data.models,
        selectedOnlyModels: data.selectedOnlyModels,
        sessionOptionSelections: NO_SESSION_OPTIONS,
        hiddenModels,
        provider,
        formatModelLabel,
      }),
    });
  }, [data, hiddenModels, isError, isPlaceholderData, provider]);
}

function useSettingsCatalogs({
  providers,
  addPickerProvider,
  enabled,
}: {
  providers: readonly ProviderInfo[];
  addPickerProvider: ProviderInfo | undefined;
  enabled: boolean;
}): ReadonlyMap<string, ModelPickerProviderCatalog> {
  const otherCatalogs = useModelPickerCatalogs({
    routing: PRIMARY_ROUTING,
    providers,
    selectedProviderId: addPickerProvider?.id ?? "",
    enabled,
    sessionOptionSelectionsForProvider: noSessionOptions,
  });

  const addPickerCatalog = useAddPickerProviderCatalog(
    addPickerProvider,
    enabled,
  );

  return useMemo(() => {
    const catalogs = new Map(
      otherCatalogs.map((catalog) => [catalog.providerId, catalog]),
    );

    if (addPickerCatalog !== undefined) {
      catalogs.set(addPickerCatalog.providerId, addPickerCatalog);
    }

    return catalogs;
  }, [addPickerCatalog, otherCatalogs]);
}

function favoriteLevelCells(
  picks: readonly FavoritePick[],
  catalog: ModelPickerProviderCatalog | undefined,
  model: string,
): FavoriteLevelCell[] {
  const row =
    catalog === undefined || catalog.status === "failed"
      ? undefined
      : findCatalogRow(catalog, model);

  const pickAt = (level: ReasoningLevel) =>
    picks.find((pick) => pick.selection.reasoningLevel === level) ?? null;

  const offered = (row?.reasoningOptions ?? []).map(
    (option): FavoriteLevelCell => ({
      level: option.value,
      label: option.label,
      pick: pickAt(option.value),
    }),
  );

  const unoffered = picks
    .filter(
      (pick) =>
        !offered.some((cell) => cell.level === pick.selection.reasoningLevel),
    )
    .map((pick): FavoriteLevelCell => ({
      level: pick.selection.reasoningLevel,
      label: pick.effortLabel,
      pick,
    }));

  return [...offered, ...unoffered].sort((a, b) =>
    compareModelPickerLevels(a.level, b.level),
  );
}

function rowReason(picks: readonly FavoritePick[]): string | null {
  for (const pick of picks) {
    if (pick.availability.state === "unavailable") {
      return pick.availability.reason;
    }
  }

  return null;
}

function buildSettingsFavoriteGroups({
  favorites,
  catalogs,
  providerOrder,
  disabledProviders,
  generalSettings,
}: {
  favorites: readonly ModelPickerFavorite[];
  catalogs: ReadonlyMap<string, ModelPickerProviderCatalog>;
  providerOrder: readonly string[];
  disabledProviders: ReadonlyMap<string, string>;
  generalSettings: FastModeSettings;
}): SettingsFavoriteGroup[] {
  const items = favorites.map((favorite): ModelFavoriteChipItem => {
    const catalog = catalogs.get(favorite.providerId);

    return {
      key: favoriteKey(favorite),
      favorite,
      selection: { ...favorite },
      description: describeFavorite(favorite, catalog),
      icon: undefined,
      availability: resolveFavoriteAvailability(favorite, {
        catalogs,
        disabledProviders,
        allowFastServiceTier: allowsFastServiceTier(
          generalSettings,
          favorite.providerId,
        ),
      }),
      current: false,
      startsNewChat: false,
    };
  });

  const order = [
    ...new Set([
      ...providerOrder,
      ...favorites.map((favorite) => favorite.providerId),
    ]),
  ];

  const groups: { providerId: string; rows: SettingsFavoriteRow[] }[] = [];

  for (const row of buildFavoriteRows(items, order, ROW_LANDING_LEVEL, null)) {
    const first = row.picks[0];

    if (first === undefined) continue;
    const { providerId, model, serviceTier } = first.selection;

    const settingsRow: SettingsFavoriteRow = {
      key: row.key,
      providerId,
      model,
      modelLabel: row.modelLabel,
      tierLabel: row.tierLabel,
      serviceTier,
      cells: favoriteLevelCells(row.picks, catalogs.get(providerId), model),
      picks: row.picks,
      reason: rowReason(row.picks),
    };

    const group = groups[groups.length - 1];

    if (group?.providerId === providerId) {
      group.rows.push(settingsRow);
    } else {
      groups.push({ providerId, rows: [settingsRow] });
    }
  }

  return groups.map((group) => ({
    ...group,
    sortable: new Set(group.rows.map((row) => row.model)).size > 1,
  }));
}

function hiddenModelLabel(
  model: string,
  catalog: ModelPickerProviderCatalog | undefined,
): string {
  const row =
    catalog?.catalogModelOptions.find((option) => option.value === model) ??
    catalog?.moreModelOptions.find((option) => option.value === model);

  return row === undefined
    ? model
    : stripModelBrandPrefix(row.label, catalog?.provider.strings?.brandPrefix);
}

function SettingsProviderIcon({
  provider,
}: {
  provider: ProviderDisplay["icon"];
}) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <ProviderIcon
        providerKind="agent"
        provider={provider}
        className={COARSE_POINTER_ICON_SIZE_CLASS}
      />
    </span>
  );
}

function ProviderGroupLabel({
  provider,
  className,
}: {
  provider: ProviderDisplay;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "col-span-full flex min-w-0 items-center gap-1.5 pb-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      <SettingsProviderIcon provider={provider.icon} />
      <span className="min-w-0 truncate">{provider.label}</span>
    </div>
  );
}

function rowName(row: SettingsFavoriteRow): string {
  return row.tierLabel === null
    ? row.modelLabel
    : `${row.modelLabel} ${row.tierLabel}`;
}

function FavoriteModelRow({
  row,
  columns,
  sortable,
  favorites,
  providerHasServiceTiers,
}: {
  row: SettingsFavoriteRow;
  columns: readonly ModelPickerColumn[];
  sortable: boolean;
  favorites: ModelPickerFavoritesState;
  providerHasServiceTiers: boolean;
}) {
  const name = rowName(row);

  const { setNodeRef, style, handle, liftClassName } = useSortableSettingsRow({
    id: row.key,
    disabled: !sortable,
    label: name,
  });

  const toggle = (cell: FavoriteLevelCell) => {
    if (cell.pick !== null) {
      favorites.remove(cell.pick.key);

      return;
    }

    favorites.add(
      {
        providerId: row.providerId,
        model: row.model,
        reasoningLevel: cell.level,
        serviceTier: row.serviceTier,
      },
      providerHasServiceTiers,
    );
  };

  const cellAt = (column: ModelPickerColumn) =>
    row.cells.find((cell) => column.levels.includes(cell.level));

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-favorite-row={row.key}
      className={cn(
        "flex flex-wrap items-center gap-x-1 rounded-md py-0.5",
        "@min-[34rem]/favorites:col-span-full @min-[34rem]/favorites:grid @min-[34rem]/favorites:grid-cols-subgrid",
        liftClassName,
      )}
    >
      {sortable ? (
        handle
      ) : (
        <span className="-ml-2 h-8 w-7 shrink-0" aria-hidden="true" />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <span className="min-w-0 truncate">{row.modelLabel}</span>
        {row.tierLabel === null ? null : (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-subtle-foreground">
            <Icon name="Zap" aria-hidden className="size-3 fill-current" />
            {row.tierLabel}
          </span>
        )}
        {row.reason === null ? null : (
          <span className="min-w-0 truncate text-xs text-subtle-foreground">
            {row.reason}
          </span>
        )}
      </div>
      <div
        className={cn(
          "order-last grid w-full gap-x-0.5 pb-1",
          "@min-[34rem]/favorites:order-none @min-[34rem]/favorites:contents",
        )}
        style={{
          gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
        }}
      >
        {columns.map((column) => {
          const cell = cellAt(column);

          if (cell === undefined) return <span key={column.level} />;
          const blocked = cell.pick === null && favorites.isFull;

          return (
            <span key={column.level} className="flex justify-center">
              <FavoriteLevelToggle
                modelLabel={name}
                levelLabel={cell.label}
                favorite={cell.pick !== null}
                disabled={blocked}
                onToggle={() => toggle(cell)}
              />
            </span>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className={`${COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS} text-muted-foreground`}
        aria-label={`Remove ${name} from favorites`}
        onClick={() => {
          for (const pick of row.picks) favorites.remove(pick.key);
        }}
      >
        <Icon name="X" />
      </Button>
    </div>
  );
}

function FavoriteGroup({
  group,
  first,
  provider,
  columns,
  favorites,
  providerHasServiceTiers,
}: {
  group: SettingsFavoriteGroup;
  first: boolean;
  provider: ProviderDisplay;
  columns: readonly ModelPickerColumn[];
  favorites: ModelPickerFavoritesState;
  providerHasServiceTiers: boolean;
}) {
  const rowsByKey = new Map(group.rows.map((row) => [row.key, row]));

  return (
    <div
      role="group"
      aria-label={`${provider.label} favorites`}
      className={cn(
        "flex flex-col",
        "@min-[34rem]/favorites:col-span-full @min-[34rem]/favorites:grid @min-[34rem]/favorites:grid-cols-subgrid",
      )}
    >
      <ProviderGroupLabel
        provider={provider}
        className={first ? undefined : "pt-3"}
      />
      <SortableSettingsRows
        ids={group.rows.map((row) => row.key)}
        disabled={!group.sortable}
        onReorder={(activeKey, overKey) => {
          const from = rowsByKey.get(activeKey);
          const to = rowsByKey.get(overKey);

          if (from !== undefined && to !== undefined) {
            favorites.moveModel(from, to);
          }
        }}
      >
        {group.rows.map((row) => (
          <FavoriteModelRow
            key={row.key}
            row={row}
            columns={columns}
            sortable={group.sortable}
            favorites={favorites}
            providerHasServiceTiers={providerHasServiceTiers}
          />
        ))}
      </SortableSettingsRows>
    </div>
  );
}

function FooterFavoritesSetting() {
  const footer = useFooterFavorites();

  return (
    <SettingsWithControl
      label={FOOTER_FAVORITES_LABEL}
      description="On desktop, favorites replace the model button as one-click chips."
    >
      <Switch
        checked={footer.shown}
        disabled={!footer.ready}
        onCheckedChange={footer.setShown}
        aria-label={FOOTER_FAVORITES_LABEL}
      />
    </SettingsWithControl>
  );
}

const FAVORITES_DESCRIPTION =
  "Favorites open first in the model picker, grouped in the provider order above. Click a level to add or remove it, or drag a model to reorder.";

const HIDDEN_DESCRIPTION =
  "Hidden models fold into “N more” in the model picker. Hide one with Edit in All models.";

export function ModelPickerSettings({
  providers,
  generalSettings,
}: ModelPickerSettingsProps) {
  const preferences = useUiPreferencesLoadState();
  const favorites = useModelPickerFavorites();
  const hidden = useModelPickerHiddenModels();
  const disabledProviders = useDisabledProviderLabels();
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const providersById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  const hiddenGroups = useMemo((): readonly HiddenModelGroup[] => {
    if (!hidden.ready) return [];

    const known = providers.flatMap((provider) => {
      const models = hidden.hiddenModels[provider.id];

      return models === undefined || models.length === 0
        ? []
        : [{ providerId: provider.id, models }];
    });

    const unknown = Object.entries(hidden.hiddenModels).flatMap(
      ([providerId, models]) =>
        providersById.has(providerId) || models.length === 0
          ? []
          : [{ providerId, models }],
    );

    return [...known, ...unknown];
  }, [hidden.hiddenModels, hidden.ready, providers, providersById]);

  const addPickerProvider = providersById.get(draft.providerId);

  const catalogs = useSettingsCatalogs({
    providers,
    addPickerProvider,
    enabled:
      preferences === "loaded" &&
      (favorites.favorites.length > 0 || hiddenGroups.length > 0),
  });

  const favoriteGroups = useMemo(
    () =>
      buildSettingsFavoriteGroups({
        favorites: favorites.favorites,
        catalogs,
        providerOrder: providers.map((provider) => provider.id),
        disabledProviders,
        generalSettings,
      }),
    [
      catalogs,
      disabledProviders,
      favorites.favorites,
      generalSettings,
      providers,
    ],
  );

  const columns = useMemo(
    () =>
      modelPickerColumns(
        favoriteGroups.flatMap((group) =>
          group.rows.map((row) => row.cells.map((cell) => cell.level)),
        ),
      ),
    [favoriteGroups],
  );

  const gridStyle = useMemo(
    (): CSSProperties => ({
      gridTemplateColumns: `1.25rem minmax(6rem, 1fr) repeat(${columns.length}, auto) 2rem`,
    }),
    [columns.length],
  );

  const providerDisplay = (providerId: string): ProviderDisplay => {
    const provider = providersById.get(providerId);

    if (provider !== undefined) {
      return { icon: provider, label: provider.displayName };
    }

    return {
      icon: { id: providerId, logoUrl: null },
      label: disabledProviders.get(providerId) ?? providerId,
    };
  };

  const hasServiceTiers = (providerId: string) =>
    providersById.get(providerId)?.capabilities.supportsServiceTier ?? false;

  const draftHasServiceTiers =
    addPickerProvider?.capabilities.supportsServiceTier ?? false;

  const draftIsFavorite =
    addPickerProvider !== undefined &&
    draft.model !== "" &&
    favorites.isFavorite(draft, draftHasServiceTiers);

  const canAdd =
    favorites.ready &&
    addPickerProvider !== undefined &&
    draft.model !== "" &&
    !draftIsFavorite &&
    !favorites.isFull;

  if (preferences !== "loaded") {
    return (
      <SettingsSection
        title="Favorite models"
        description={FAVORITES_DESCRIPTION}
      >
        {preferences === "failed" ? (
          <p className="text-sm text-destructive-text" role="alert">
            Couldn't load preferences.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title="Favorite models"
        description={FAVORITES_DESCRIPTION}
      >
        <div className="@container/favorites space-y-3">
          {favoriteGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No favorites yet. Add one below, or star a level in the model
              picker.
            </p>
          ) : (
            <div
              className="flex flex-col @min-[34rem]/favorites:grid @min-[34rem]/favorites:items-center @min-[34rem]/favorites:gap-x-1"
              style={gridStyle}
            >
              {favoriteGroups.map((group, index) => (
                <FavoriteGroup
                  key={group.providerId}
                  group={group}
                  first={index === 0}
                  provider={providerDisplay(group.providerId)}
                  columns={columns}
                  favorites={favorites}
                  providerHasServiceTiers={hasServiceTiers(group.providerId)}
                />
              ))}
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2 border-t border-border pt-3">
            <LazyPluginProviderModelPicker
              value={draft}
              onChange={setDraft}
              className="min-w-0"
            />
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={!canAdd}
              onClick={() => favorites.add(draft, draftHasServiceTiers)}
            >
              {draftIsFavorite ? "Added" : "Add favorite"}
            </Button>
          </div>
          {favorites.isFull ? (
            <p className="text-xs text-muted-foreground">
              You can keep up to {MODEL_PICKER_FAVORITES_MAX} favorites.
            </p>
          ) : null}
          <div className="border-t border-border pt-3">
            <FooterFavoritesSetting />
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Hidden models" description={HIDDEN_DESCRIPTION}>
        {hiddenGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hidden models.</p>
        ) : (
          <div className="space-y-3">
            {hiddenGroups.map((group) => {
              const provider = providerDisplay(group.providerId);
              const catalog = catalogs.get(group.providerId);

              return (
                <div
                  key={group.providerId}
                  role="group"
                  aria-label={`Hidden ${provider.label} models`}
                >
                  <ProviderGroupLabel provider={provider} />
                  <SettingsRowList>
                    {group.models.map((model) => {
                      const label = hiddenModelLabel(model, catalog);

                      return (
                        <SettingsRow key={model} className="py-1.5">
                          <span className="min-w-0 flex-1 truncate">
                            {label}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            aria-label={`Show ${label}`}
                            onClick={() =>
                              hidden.unhide(group.providerId, model)
                            }
                          >
                            Show
                          </Button>
                        </SettingsRow>
                      );
                    })}
                  </SettingsRowList>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </>
  );
}
