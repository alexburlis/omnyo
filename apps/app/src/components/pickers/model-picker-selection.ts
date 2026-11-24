import {
  DEFAULT_SERVICE_TIER,
  reconcileReasoningLevel,
  type ProviderInfo,
  type ReasoningLevel,
  type ServiceTier,
} from "@omnyo/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsModelNotice,
} from "@omnyo/server-contract";
import { sameModelPickerColumn } from "./model-picker-menu";
import type { ModelPickerOption } from "./model-picker-option";

export interface ModelPickerSelection {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier?: ServiceTier;
}

export type ModelPickerCatalogStatus = "loading" | "verified" | "failed";

export interface ModelPickerProviderCatalog {
  providerId: string;
  provider: ProviderInfo;
  status: ModelPickerCatalogStatus;
  loadError: SystemExecutionOptionsModelLoadError | null;
  notice: SystemExecutionOptionsModelNotice | null;
  modelOptions: readonly ModelPickerOption[];
  moreModelOptions: readonly ModelPickerOption[];
  catalogModelOptions: readonly ModelPickerOption[];
}

export function modelPickerCatalogStatus(args: {
  verified: boolean;
  failed: boolean;
}): ModelPickerCatalogStatus {
  if (args.verified) return "verified";

  return args.failed ? "failed" : "loading";
}

export function selectionServiceTier(
  selection: Pick<ModelPickerSelection, "serviceTier">,
  providerHasServiceTiers: boolean,
): ServiceTier {
  return providerHasServiceTiers
    ? (selection.serviceTier ?? DEFAULT_SERVICE_TIER)
    : DEFAULT_SERVICE_TIER;
}

export function rowOffersReasoningLevel(
  row: Pick<ModelPickerOption, "reasoningOptions">,
  level: ReasoningLevel,
): boolean {
  return row.reasoningOptions.some((option) => option.value === level);
}

export function rowReasoningLevelInColumn(
  row: Pick<ModelPickerOption, "reasoningOptions">,
  level: ReasoningLevel,
): ReasoningLevel | null {
  if (rowOffersReasoningLevel(row, level)) return level;

  return (
    row.reasoningOptions.find((option) =>
      sameModelPickerColumn(option.value, level),
    )?.value ?? null
  );
}

export function landingReasoningLevel(
  row: Pick<ModelPickerOption, "reasoningOptions" | "defaultReasoningLevel">,
  currentLevel: ReasoningLevel,
): ReasoningLevel {
  if (row.reasoningOptions.length === 0) return currentLevel;

  const sameColumn = rowReasoningLevelInColumn(row, currentLevel);

  if (sameColumn !== null) return sameColumn;

  return reconcileReasoningLevel(
    currentLevel,
    row.reasoningOptions.map((option) => option.value),
    row.defaultReasoningLevel,
  );
}
