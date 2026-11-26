import { memo, useCallback } from "react";
import type {
  PermissionMode,
  ProviderInfo,
  ProviderOptionDescriptor,
  ReasoningLevel,
  ServiceTier,
  SessionOptionSelections,
} from "@omnyo/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsModelNotice,
  SystemProvidersQuery,
} from "@omnyo/server-contract";
import type {
  ModelPickerPresentation,
  ModelPickerSelects,
} from "@/components/pickers/ModelFavoritesBar";
import {
  ModelReasoningPicker,
  type ModelReasoningPickerHandoff,
} from "@/components/pickers/ModelReasoningPicker";
import { type PickerOption } from "@/components/pickers/OptionPicker";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import type { ModelPickerSelection } from "@/components/pickers/model-picker-selection";
import type { ProviderPickerOption } from "@/components/pickers/model-brand-prefix";
import type {
  SessionOptionChoice,
  SessionOptionMenuSection,
} from "@/components/pickers/SessionOptionsMenu";

const EMPTY_SERVICE_TIER_OPTIONS: readonly ProviderOptionDescriptor[] = [];

interface ExecutionProviderConfig {
  options?: readonly ProviderPickerOption[];
  selectedId?: string;
  onChange?: (value: string) => void;
  hasMultiple?: boolean;
  sessionOptionSelectionsForProvider?: (
    providerId: string,
  ) => SessionOptionSelections;
}

interface ExecutionModelConfig {
  active?: { model: string } | null;
  selected: string;
  options: readonly ModelPickerOption[];
  moreOptions: readonly ModelPickerOption[];
  isLoading: boolean;
  loadFailed: boolean;
  loadError?: SystemExecutionOptionsModelLoadError | null;
  notice?: SystemExecutionOptionsModelNotice | null;
  onChange: (value: string) => void;
}

interface ExecutionServiceTierConfig {
  value?: ServiceTier;
  onChange: (value: ServiceTier | undefined) => void;
  supported: boolean;
  options: readonly ProviderOptionDescriptor[];
}

interface ExecutionReasoningConfig {
  value: ReasoningLevel;
  options: readonly PickerOption<ReasoningLevel>[];
  onChange: (value: ReasoningLevel) => void;
}

export interface ExecutionPermissionConfig {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
}

export interface ExecutionSelectionConfig {
  onChange: (selection: ModelPickerSelection) => void;
}

export interface ExecutionCatalogConfig {
  providers: readonly ProviderInfo[];
  verified: boolean;
  modelOptions: readonly ModelPickerOption[];
}

export interface ExecutionAgentOptionsConfig {
  sections: readonly SessionOptionMenuSection[];
  onChange: (optionId: string, value: SessionOptionChoice) => void;
}

export interface ExecutionControlsProps {
  providerRouting?: SystemProvidersQuery;
  catalog: ExecutionCatalogConfig;
  provider: ExecutionProviderConfig;
  model: ExecutionModelConfig;
  serviceTier?: ExecutionServiceTierConfig;
  agentOptions?: ExecutionAgentOptionsConfig;
  reasoning: ExecutionReasoningConfig;
  selection: ExecutionSelectionConfig;
  favoriteChips?: boolean;
  handoff?: ModelReasoningPickerHandoff;
  disabled?: boolean;
  presentation?: ModelPickerPresentation;
  selects?: ModelPickerSelects;
}

export const ExecutionControls = memo(function ExecutionControls({
  catalog,
  provider,
  providerRouting,
  model,
  serviceTier,
  agentOptions,
  reasoning,
  selection,
  favoriteChips = false,
  handoff,
  disabled,
  presentation = "footer",
  selects,
}: ExecutionControlsProps) {
  const handleServiceTierChange = serviceTier?.onChange ?? (() => {});
  const selectedProviderId = provider.selectedId ?? "";
  const applySelection = selection.onChange;

  const handleSelectionChange = useCallback(
    (next: ModelPickerSelection): boolean => {
      applySelection(next);

      return true;
    },
    [applySelection],
  );

  const canSwitchProviders = Boolean(
    provider.hasMultiple &&
    provider.onChange &&
    provider.options &&
    provider.options.length > 1,
  );

  const showModelPicker =
    model.isLoading ||
    model.loadFailed ||
    model.options.length > 0 ||
    canSwitchProviders ||
    selectedProviderId.length > 0 ||
    handoff !== undefined;

  return showModelPicker ? (
    <ModelReasoningPicker
      providers={catalog.providers}
      providerOptions={provider.options ?? []}
      providerRouting={providerRouting}
      selectedProviderId={selectedProviderId}
      onSelectedProviderChange={provider.onChange}
      hasMultipleProviders={provider.hasMultiple ?? false}
      modelValue={model.active?.model ?? model.selected}
      modelOptions={model.options}
      moreModelOptions={model.moreOptions}
      catalogModelOptions={catalog.modelOptions}
      modelCatalogIsVerified={catalog.verified}
      modelIsLoading={model.isLoading}
      modelLoadFailed={model.loadFailed}
      modelLoadError={model.loadError}
      modelNotice={model.notice}
      onModelChange={model.onChange}
      reasoningValue={reasoning.value}
      reasoningOptions={reasoning.options}
      onReasoningChange={reasoning.onChange}
      onSelectionChange={handleSelectionChange}
      serviceTierValue={serviceTier?.value}
      serviceTierOptions={
        serviceTier?.supported
          ? serviceTier.options
          : EMPTY_SERVICE_TIER_OPTIONS
      }
      onServiceTierChange={handleServiceTierChange}
      sessionOptionSelectionsForProvider={
        provider.sessionOptionSelectionsForProvider
      }
      agentSections={agentOptions?.sections}
      onAgentOptionChange={agentOptions?.onChange}
      muted
      showFavoriteChips={favoriteChips}
      disabled={disabled}
      handoff={handoff}
      presentation={presentation}
      selects={selects}
    />
  ) : null;
});
