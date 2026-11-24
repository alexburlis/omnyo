import type { ReasoningLevel } from "@omnyo/domain";
import {
  compareModelPickerLevels,
  modelPickerLevelRank,
} from "./model-picker-menu";
import type { PickerOption } from "./OptionPicker";

export function nextCycleValue<T extends string>(
  options: readonly PickerOption<T>[],
  current: T,
): T | null {
  if (options.length === 0) return null;
  const index = options.findIndex((option) => option.value === current);
  const next = options[(index + 1) % options.length];

  if (next === undefined || next.value === current) return null;

  return next.value;
}

export function cyclableModelOptions<Option extends PickerOption<string>>(
  options: readonly Option[],
  hiddenModels: ReadonlySet<string>,
): Option[] {
  return options.filter(
    (option) => option.disabled !== true && !hiddenModels.has(option.value),
  );
}

export function previousCycleValue<T extends string>(
  options: readonly PickerOption<T>[],
  current: T,
): T | null {
  return nextCycleValue([...options].reverse(), current);
}

export function cycleReasoningValue(
  options: readonly PickerOption<ReasoningLevel>[],
  current: ReasoningLevel,
  direction: "forward" | "backward",
): ReasoningLevel | null {
  const currentRank = modelPickerLevelRank(current);

  if (
    currentRank === null ||
    options.some((option) => modelPickerLevelRank(option.value) === null)
  ) {
    return direction === "forward"
      ? nextCycleValue(options, current)
      : previousCycleValue(options, current);
  }

  const orderedOptions = options
    .map((option) => option.value)
    .sort(compareModelPickerLevels);

  const rankOf = (level: ReasoningLevel) => modelPickerLevelRank(level) ?? -1;

  let candidate: ReasoningLevel | undefined;

  if (direction === "forward") {
    candidate = orderedOptions.find((level) => rankOf(level) > currentRank);
    candidate ??= orderedOptions[0];
  } else {
    candidate = [...orderedOptions]
      .reverse()
      .find((level) => rankOf(level) < currentRank);
    candidate ??= orderedOptions.at(-1);
  }

  if (candidate === undefined || candidate === current) return null;

  return candidate;
}
