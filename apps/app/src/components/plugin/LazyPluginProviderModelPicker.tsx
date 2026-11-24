import { Skeleton } from "@omnyo/shared-ui/skeleton";
import type { ExperimentalProviderModelPickerProps } from "@omnyo/plugin-sdk";
import { defineSplit } from "@/lib/define-split";

export const LazyPluginProviderModelPicker =
  defineSplit<ExperimentalProviderModelPickerProps>({
    id: "plugin-provider-model-picker",
    load: () =>
      import("./PluginProviderModelPicker").then(
        (module) => module.PluginProviderModelPicker,
      ),
    loading: ({ className }) => (
      <div
        className={className}
        role="status"
        aria-label="Loading model picker"
      >
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    ),
  });
