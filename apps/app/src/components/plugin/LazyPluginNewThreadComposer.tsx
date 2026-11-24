import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { cn } from "@omnyo/shared-ui/lib/utils";
import type { NewThreadComposerProps } from "@omnyo/plugin-sdk";
import { defineSplit } from "@/lib/define-split";

export const LazyPluginNewThreadComposer = defineSplit<NewThreadComposerProps>({
  id: "plugin-new-thread-composer",
  load: () =>
    import("./PluginNewThreadComposer").then(
      (module) => module.PluginNewThreadComposer,
    ),
  loading: ({ className, layout = "contained" }) => (
    <div
      className={cn(
        layout === "contained"
          ? "flex h-full min-h-0 flex-col justify-end"
          : "flex flex-col",
        className,
      )}
      role="status"
      aria-label="Loading composer"
    >
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  ),
});
