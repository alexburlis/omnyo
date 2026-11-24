import {
  collectDeclaredSessionOptions,
  describeSessionOptionConflict,
  effectiveSessionOptionSelections,
  modelSessionOptionConflict,
  reconcileReasoningLevel,
  resolveServiceTierOptions,
  type AvailableModel,
  type ProviderInfo,
  type ReasoningLevel,
  type SessionOptionSelections,
  type ThreadSessionOption,
} from "@omnyo/domain";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import {
  reasoningLadderLabels,
  type ReasoningLabelSource,
} from "@/lib/reasoning-labels";

export type ModelCatalogProvider = ReasoningLabelSource &
  Pick<ProviderInfo, "serviceTiers"> & {
    capabilities: Pick<ProviderInfo["capabilities"], "supportsServiceTier">;
  };

type ModelLabelFormatter = (displayName: string) => string;

interface ResolveModelCatalogSelectionArgs {
  models: readonly AvailableModel[];
  selectedOnlyModels: readonly AvailableModel[];
  selectedModel: string;
  preferredReasoningLevel?: ReasoningLevel;
  sessionOptionSelections?: SessionOptionSelections;
  hiddenModels: ReadonlySet<string>;
  provider: ModelCatalogProvider | undefined;
  catalogIsVerified: boolean;
  formatModelLabel: ModelLabelFormatter;
}

export interface ModelPickerRows {
  modelOptions: ModelPickerOption[];
  moreModelOptions: ModelPickerOption[];
  catalogModelOptions: ModelPickerOption[];
}

interface ResolvedModelCatalogSelection extends ModelPickerRows {
  selectedModel: string;
  activeModel: AvailableModel | undefined;
  reasoningLevel: ReasoningLevel;
  reasoningOptions: PickerOption<ReasoningLevel>[];
  declaredSessionOptions: ThreadSessionOption[];
  sessionOptionSelections: SessionOptionSelections;
  requiresExplicitModel: boolean;
  isSessionOptionModelSwitch: boolean;
}

export function resolveModelReasoningLevel(
  model: AvailableModel | undefined,
  preferredReasoningLevel: ReasoningLevel,
): ReasoningLevel {
  const supportedReasoningLevels =
    model?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort) ??
    [];

  return supportedReasoningLevels.length === 0
    ? preferredReasoningLevel
    : reconcileReasoningLevel(
        preferredReasoningLevel,
        supportedReasoningLevels,
        model?.defaultReasoningEffort,
      );
}

export function modelReasoningOptions(
  model: AvailableModel | undefined,
  provider: ReasoningLabelSource | undefined,
): PickerOption<ReasoningLevel>[] {
  const seenReasoningLevels = new Set<ReasoningLevel>();

  const reasoningEfforts = (model?.supportedReasoningEfforts ?? []).filter(
    (effort) => {
      if (seenReasoningLevels.has(effort.reasoningEffort)) return false;
      seenReasoningLevels.add(effort.reasoningEffort);

      return true;
    },
  );

  const reasoningLabels = reasoningLadderLabels(reasoningEfforts, provider);

  return reasoningEfforts.map((effort, index) => ({
    value: effort.reasoningEffort,
    label: reasoningLabels[index] ?? effort.reasoningEffort,
  }));
}

function toModelPickerOption(
  model: AvailableModel,
  formatModelLabel: ModelLabelFormatter,
  sessionOptionSelections: SessionOptionSelections,
  provider: ModelCatalogProvider | undefined,
): ModelPickerOption {
  const conflict = modelSessionOptionConflict(model, sessionOptionSelections);

  return {
    value: model.model,
    label: formatModelLabel(model.displayName || model.model),
    ...(model.routeProviderId
      ? { routeProviderId: model.routeProviderId }
      : {}),
    reasoningOptions: modelReasoningOptions(model, provider),
    defaultReasoningLevel: model.defaultReasoningEffort,
    serviceTierOptions: resolveServiceTierOptions({ provider, model }),
    ...(conflict === null
      ? {}
      : {
          disabled: true,
          disabledReason: describeSessionOptionConflict(conflict),
        }),
  };
}

const NO_VISIBLE_MODELS: ReadonlySet<string> = new Set();

function projectModelPickerRows({
  primaryModels,
  secondaryModels,
  hiddenModels,
  visibleModels,
  toOption,
}: {
  primaryModels: readonly AvailableModel[];
  secondaryModels: readonly AvailableModel[];
  hiddenModels: ReadonlySet<string>;
  visibleModels: ReadonlySet<string>;
  toOption: (model: AvailableModel) => ModelPickerOption;
}): ModelPickerRows {
  const catalogModelOptions = primaryModels.map(toOption);

  const isFolded = (option: ModelPickerOption) =>
    hiddenModels.has(option.value) && !visibleModels.has(option.value);

  return {
    modelOptions: catalogModelOptions.filter((option) => !isFolded(option)),
    moreModelOptions: [
      ...catalogModelOptions.filter(isFolded),
      ...secondaryModels.map(toOption),
    ],
    catalogModelOptions,
  };
}

interface ResolveModelPickerRowsArgs {
  models: readonly AvailableModel[];
  selectedOnlyModels: readonly AvailableModel[];
  sessionOptionSelections: SessionOptionSelections;
  hiddenModels: ReadonlySet<string>;
  provider: ModelCatalogProvider | undefined;
  formatModelLabel: ModelLabelFormatter;
}

export function resolveModelPickerRows({
  models,
  selectedOnlyModels,
  sessionOptionSelections,
  hiddenModels,
  provider,
  formatModelLabel,
}: ResolveModelPickerRowsArgs): ModelPickerRows {
  const fullCatalog = [...models, ...selectedOnlyModels];

  const effectiveSelections = effectiveSessionOptionSelections(
    collectDeclaredSessionOptions(fullCatalog),
    sessionOptionSelections,
  );

  const primaryModelIds = new Set(models.map((model) => model.model));

  return projectModelPickerRows({
    primaryModels: models,
    secondaryModels: selectedOnlyModels.filter(
      (model) => !primaryModelIds.has(model.model),
    ),
    hiddenModels,
    visibleModels: NO_VISIBLE_MODELS,
    toOption: (model) =>
      toModelPickerOption(
        model,
        formatModelLabel,
        effectiveSelections,
        provider,
      ),
  });
}

export function resolveModelCatalogSelection({
  models,
  selectedOnlyModels,
  selectedModel: rawSelectedModel,
  preferredReasoningLevel,
  sessionOptionSelections: requestedSessionOptionSelections,
  hiddenModels,
  provider,
  catalogIsVerified,
  formatModelLabel,
}: ResolveModelCatalogSelectionArgs): ResolvedModelCatalogSelection {
  const fullCatalog = [...models, ...selectedOnlyModels];
  const declaredSessionOptions = collectDeclaredSessionOptions(fullCatalog);

  const sessionOptionSelections = effectiveSessionOptionSelections(
    declaredSessionOptions,
    requestedSessionOptionSelections ?? {},
  );

  const selectedModelSelection = (() => {
    if (!rawSelectedModel) return rawSelectedModel;

    if (fullCatalog.some((model) => model.model === rawSelectedModel)) {
      return rawSelectedModel;
    }

    const prefixed = fullCatalog.filter((model) =>
      model.model.endsWith(`/${rawSelectedModel}`),
    );

    return prefixed.length === 1 ? prefixed[0].model : rawSelectedModel;
  })();

  const availableModels = [...models];

  if (
    selectedModelSelection &&
    !availableModels.some((model) => model.model === selectedModelSelection)
  ) {
    const selectedOnlyModel = selectedOnlyModels.find(
      (model) => model.model === selectedModelSelection,
    );

    if (selectedOnlyModel) {
      availableModels.unshift(selectedOnlyModel);
    }
  }

  const catalogSelectedModel = (() => {
    if (selectedModelSelection) {
      return selectedModelSelection;
    }

    return (
      availableModels.find((model) => model.isDefault)?.model ??
      availableModels[0]?.model ??
      ""
    );
  })();

  const selectedModel = (() => {
    const chosen = availableModels.find(
      (model) => model.model === catalogSelectedModel,
    );

    if (
      chosen === undefined ||
      modelSessionOptionConflict(chosen, sessionOptionSelections) === null
    ) {
      return catalogSelectedModel;
    }

    const compatible = availableModels.filter(
      (model) =>
        modelSessionOptionConflict(model, sessionOptionSelections) === null,
    );

    return (
      (compatible.find((model) => model.isDefault) ?? compatible[0])?.model ??
      catalogSelectedModel
    );
  })();

  const activeModel = availableModels.find(
    (model) => model.model === selectedModel,
  );

  const reasoningOptions = modelReasoningOptions(activeModel, provider);

  const visibleModels = new Set<string>(
    [selectedModel, activeModel?.model ?? ""].filter(
      (model) => model.length > 0,
    ),
  );

  const rows = projectModelPickerRows({
    primaryModels: availableModels,
    secondaryModels: selectedOnlyModels.filter(
      (model) =>
        !availableModels.some((active) => active.model === model.model),
    ),
    hiddenModels,
    visibleModels,
    toOption: (model) =>
      toModelPickerOption(
        model,
        formatModelLabel,
        sessionOptionSelections,
        provider,
      ),
  });

  const preferredLevel = preferredReasoningLevel ?? "medium";

  const reasoningLevel = resolveModelReasoningLevel(
    activeModel,
    preferredLevel,
  );

  return {
    selectedModel,
    activeModel,
    ...rows,
    reasoningLevel,
    reasoningOptions,
    declaredSessionOptions,
    sessionOptionSelections,
    requiresExplicitModel:
      catalogIsVerified &&
      rawSelectedModel.length > 0 &&
      (catalogSelectedModel !== rawSelectedModel ||
        !availableModels.some((model) => model.model === catalogSelectedModel)),
    isSessionOptionModelSwitch: selectedModel !== catalogSelectedModel,
  };
}
