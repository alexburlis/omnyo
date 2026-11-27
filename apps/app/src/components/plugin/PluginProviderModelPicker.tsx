import { reconcileServiceTier } from "@omnyo/domain";
import { useCallback, useEffect, useMemo } from "react";
import type {
  ExperimentalProviderModelPickerProps,
  ExperimentalProviderModelPickerValue,
} from "@omnyo/plugin-sdk";
import { ModelReasoningPicker } from "@/components/pickers/ModelReasoningPicker";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import {
  rowOffersReasoningLevel,
  type ModelPickerSelection,
} from "@/components/pickers/model-picker-selection";
import { useModelPickerCatalogs } from "@/components/pickers/useModelPickerCatalogs";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { resolvePluginExecutionRouting } from "./plugin-execution-routing";

function selectionKey(value: ExperimentalProviderModelPickerValue): string {
  return [
    value.providerId,
    value.model,
    value.reasoningLevel,
    value.serviceTier ?? "",
  ].join("\0");
}

function ignoreProviderCycle(): void {}

export function PluginProviderModelPicker({
  value,
  onChange,
  routing,
  allowProviderChange = true,
  align = "start",
  disabled,
  className,
}: ExperimentalProviderModelPickerProps) {
  const resolvedRouting = useMemo(
    () => resolvePluginExecutionRouting(routing),
    [routing],
  );

  const controlledKey = `${resolvedRouting.key}\0${selectionKey(value)}`;

  const controller = useThreadCreationOptions({
    scope: "component-local",
    initialProviderId: value.providerId,
    initialModel: value.model,
    initialReasoningLevel: value.reasoningLevel,
    initialServiceTier: value.serviceTier,
    resetKey: controlledKey,
    resolveProviderRouting: () => resolvedRouting.query,
  });

  const siblingCatalogs = useModelPickerCatalogs({
    routing: controller.executionOptionsRouting,
    providers: controller.providers,
    selectedProviderId: controller.selectedProviderId,
    enabled: allowProviderChange && disabled !== true,
    sessionOptionSelectionsForProvider:
      controller.sessionOptionSelectionsForProvider,
  });

  const emit = useCallback(
    (next: ExperimentalProviderModelPickerValue) => {
      if (selectionKey(next) !== selectionKey(value)) {
        onChange(next);
      }
    },
    [onChange, value],
  );

  useEffect(() => {
    if (
      !controller.modelCatalogIsVerified ||
      controller.selectedModel.length === 0
    ) {
      return;
    }

    emit({
      providerId: controller.selectedProviderId,
      model: controller.selectedModel,
      reasoningLevel: controller.reasoningLevel,
      ...(controller.serviceTier === undefined
        ? {}
        : { serviceTier: controller.serviceTier }),
    });
  }, [
    controller.modelCatalogIsVerified,
    controller.reasoningLevel,
    controller.selectedModel,
    controller.selectedProviderId,
    controller.serviceTier,
    emit,
  ]);

  const verifiedRows = useCallback(
    (providerId: string): readonly ModelPickerOption[] | null => {
      if (providerId === controller.selectedProviderId) {
        return controller.modelCatalogIsVerified
          ? [...controller.catalogModelOptions, ...controller.moreModelOptions]
          : null;
      }

      if (!allowProviderChange) return null;

      const catalog = siblingCatalogs.find(
        (candidate) => candidate.providerId === providerId,
      );

      return catalog?.status === "verified"
        ? [...catalog.catalogModelOptions, ...catalog.moreModelOptions]
        : null;
    },
    [
      allowProviderChange,
      controller.catalogModelOptions,
      controller.modelCatalogIsVerified,
      controller.moreModelOptions,
      controller.selectedProviderId,
      siblingCatalogs,
    ],
  );

  const handleSelectionChange = useCallback(
    (selection: ModelPickerSelection): boolean => {
      const row = verifiedRows(selection.providerId)?.find(
        (candidate) => candidate.value === selection.model,
      );

      if (row === undefined || row.disabled === true) return false;

      if (
        row.reasoningOptions.length > 0 &&
        !rowOffersReasoningLevel(row, selection.reasoningLevel)
      ) {
        return false;
      }

      const providerHasServiceTiers =
        controller.providers.find(
          (provider) => provider.id === selection.providerId,
        )?.capabilities.supportsServiceTier ?? false;

      const requestedServiceTier = selection.serviceTier ?? value.serviceTier;

      const offeredServiceTiers =
        controller.serviceTierSupportByProvider[selection.providerId] === true
          ? row.serviceTierOptions
          : [];

      emit({
        providerId: selection.providerId,
        model: selection.model,
        reasoningLevel: selection.reasoningLevel,
        ...(providerHasServiceTiers && requestedServiceTier !== undefined
          ? {
              serviceTier: reconcileServiceTier(
                requestedServiceTier,
                offeredServiceTiers,
              ),
            }
          : {}),
      });

      return true;
    },
    [
      controller.providers,
      controller.serviceTierSupportByProvider,
      emit,
      value.serviceTier,
      verifiedRows,
    ],
  );

  const handleModelChange = useCallback(
    (model: string) => {
      if (!controller.modelCatalogIsVerified) return;
      controller.setSelectedModel(model);
    },
    [controller],
  );

  const handleReasoningChange = useCallback(
    (
      reasoningLevel: ExperimentalProviderModelPickerValue["reasoningLevel"],
    ) => {
      if (!controller.modelCatalogIsVerified) return;
      emit({
        providerId: controller.selectedProviderId,
        model: controller.selectedModel,
        reasoningLevel,
        ...(controller.serviceTier === undefined
          ? {}
          : { serviceTier: controller.serviceTier }),
      });
    },
    [controller, emit],
  );

  const handleServiceTierChange = useCallback(
    (
      serviceTier: NonNullable<
        ExperimentalProviderModelPickerValue["serviceTier"]
      >,
    ) => {
      if (
        !controller.modelCatalogIsVerified ||
        !controller.supportsServiceTier
      ) {
        return;
      }

      emit({
        providerId: controller.selectedProviderId,
        model: controller.selectedModel,
        reasoningLevel: controller.reasoningLevel,
        serviceTier,
      });
    },
    [controller, emit],
  );

  return (
    <ModelReasoningPicker
      providers={controller.providers}
      providerOptions={controller.providerOptions}
      providerRouting={controller.executionOptionsRouting}
      selectedProviderId={controller.selectedProviderId}
      onSelectedProviderChange={
        allowProviderChange ? ignoreProviderCycle : undefined
      }
      onSelectionChange={handleSelectionChange}
      hasMultipleProviders={controller.hasMultipleProviders}
      modelValue={controller.selectedModel}
      modelOptions={controller.modelOptions}
      moreModelOptions={controller.moreModelOptions}
      catalogModelOptions={controller.catalogModelOptions}
      modelCatalogIsVerified={controller.modelCatalogIsVerified}
      requireVerifiedCatalog
      modelIsLoading={controller.isLoadingModels}
      modelLoadFailed={controller.modelLoadFailed}
      modelLoadError={controller.modelLoadError}
      modelNotice={controller.modelNotice}
      onModelChange={handleModelChange}
      reasoningValue={controller.reasoningLevel}
      reasoningOptions={controller.reasoningOptions}
      reasoningIsLoading={controller.isLoadingReasoning}
      onReasoningChange={handleReasoningChange}
      serviceTierValue={controller.serviceTier}
      serviceTierOptions={controller.serviceTierOptions}
      onServiceTierChange={handleServiceTierChange}
      commandShortcutsEnabled={false}
      align={align}
      disabled={disabled}
      className={className}
    />
  );
}
