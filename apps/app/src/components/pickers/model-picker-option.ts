import type { ProviderOptionDescriptor, ReasoningLevel } from "@omnyo/domain";
import type { PickerOption } from "./OptionPicker";

export interface ModelPickerOption extends PickerOption<string> {
  routeProviderId?: string;
  reasoningOptions: readonly PickerOption<ReasoningLevel>[];
  defaultReasoningLevel: ReasoningLevel;
  serviceTierOptions: readonly ProviderOptionDescriptor[];
}
