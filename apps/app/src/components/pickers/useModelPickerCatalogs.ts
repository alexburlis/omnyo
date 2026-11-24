import { useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { ProviderInfo, SessionOptionSelections } from "@omnyo/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsModelNotice,
  SystemExecutionOptionsResponse,
  SystemProvidersQuery,
} from "@omnyo/server-contract";
import {
  systemExecutionOptionsQueryOptions,
  useSystemProviderCatalog,
} from "@/hooks/queries/system-queries";
import {
  resolveModelPickerRows,
  type ModelPickerRows,
} from "@/hooks/thread-creation-options/model-catalog-selection";
import { formatModelLabel } from "@/hooks/thread-creation-options/selection-state";
import {
  useHostListRealtimeSubscription,
  useSystemRealtimeSubscription,
} from "@/hooks/useRealtimeSubscription";
import {
  modelPickerCatalogStatus,
  type ModelPickerProviderCatalog,
} from "./model-picker-selection";
import { modelPickerHiddenModelsAtom } from "./modelPickerPreferences";

export interface UseModelPickerCatalogsArgs {
  routing: SystemProvidersQuery;
  providers: readonly ProviderInfo[];
  selectedProviderId: string;
  enabled: boolean;
  sessionOptionSelectionsForProvider: (
    providerId: string,
  ) => SessionOptionSelections;
}

export interface SelectedModelPickerCatalogArgs extends ModelPickerRows {
  provider: ProviderInfo;
  modelCatalogIsVerified: boolean;
  modelLoadFailed: boolean;
  modelLoadError: SystemExecutionOptionsModelLoadError | null;
  modelNotice: SystemExecutionOptionsModelNotice | null;
}

interface CatalogQueryState {
  data: SystemExecutionOptionsResponse | undefined;
  isError: boolean;
  isPlaceholderData: boolean;
}

const NO_ROWS: ModelPickerRows = {
  modelOptions: [],
  moreModelOptions: [],
  catalogModelOptions: [],
};

const NO_HIDDEN_MODELS: ReadonlySet<string> = new Set();

function combineCatalogQueries(
  results: UseQueryResult<SystemExecutionOptionsResponse>[],
): CatalogQueryState[] {
  return results.map((result) => ({
    data: result.data,
    isError: result.isError,
    isPlaceholderData: result.isPlaceholderData,
  }));
}

function siblingCatalog(
  provider: ProviderInfo,
  state: CatalogQueryState | undefined,
  hiddenModels: ReadonlySet<string>,
  sessionOptionSelections: SessionOptionSelections,
): ModelPickerProviderCatalog {
  const data = state?.data;

  const offersProvider =
    data?.providers.some((offered) => offered.id === provider.id) ?? false;

  const loadError = offersProvider ? (data?.modelLoadError ?? null) : null;

  const settled =
    data !== undefined && state?.isPlaceholderData === false && offersProvider;

  const rows =
    data === undefined || !offersProvider
      ? NO_ROWS
      : resolveModelPickerRows({
          models: data.models,
          selectedOnlyModels: data.selectedOnlyModels,
          sessionOptionSelections,
          hiddenModels,
          provider,
          formatModelLabel,
        });

  return {
    providerId: provider.id,
    provider,
    status: modelPickerCatalogStatus({
      verified: settled && state?.isError === false && loadError === null,
      failed:
        state?.isError === true ||
        loadError !== null ||
        (data !== undefined && !offersProvider),
    }),
    loadError,
    notice: offersProvider ? (data?.modelNotice ?? null) : null,
    ...rows,
  };
}

export function selectedModelPickerCatalog({
  provider,
  modelCatalogIsVerified,
  modelLoadFailed,
  modelLoadError,
  modelNotice,
  modelOptions,
  moreModelOptions,
  catalogModelOptions,
}: SelectedModelPickerCatalogArgs): ModelPickerProviderCatalog {
  return {
    providerId: provider.id,
    provider,
    status: modelPickerCatalogStatus({
      verified: modelCatalogIsVerified,
      failed: modelLoadFailed,
    }),
    loadError: modelLoadError,
    notice: modelNotice,
    modelOptions,
    moreModelOptions,
    catalogModelOptions,
  };
}

export function useModelPickerCatalogs({
  routing,
  providers,
  selectedProviderId,
  enabled,
  sessionOptionSelectionsForProvider,
}: UseModelPickerCatalogsArgs): readonly ModelPickerProviderCatalog[] {
  useSystemRealtimeSubscription({ enabled });
  useHostListRealtimeSubscription({ enabled });

  const environmentId = routing.environmentId ?? null;
  const hostId = routing.hostId ?? null;

  const siblings = useMemo(
    () => providers.filter((provider) => provider.id !== selectedProviderId),
    [providers, selectedProviderId],
  );

  const states = useQueries({
    queries: siblings.map((provider) => ({
      ...systemExecutionOptionsQueryOptions({
        environmentId,
        hostId,
        providerId: provider.id,
        writeLastKnown: false,
      }),
      enabled,
    })),
    combine: combineCatalogQueries,
  });

  const hiddenModels = useAtomValue(modelPickerHiddenModelsAtom);

  return useMemo(
    () =>
      siblings.map((provider, index) => {
        const hidden = hiddenModels[provider.id];

        return siblingCatalog(
          provider,
          states[index],
          hidden === undefined ? NO_HIDDEN_MODELS : new Set(hidden),
          sessionOptionSelectionsForProvider(provider.id),
        );
      }),
    [hiddenModels, sessionOptionSelectionsForProvider, siblings, states],
  );
}

export function useDisabledProviderLabels(): ReadonlyMap<string, string> {
  const { data } = useSystemProviderCatalog();

  return useMemo(
    () =>
      new Map(
        (data ?? [])
          .filter((entry) => !entry.enabled || !entry.pluginEnabled)
          .map((entry) => [entry.id, entry.displayName]),
      ),
    [data],
  );
}
