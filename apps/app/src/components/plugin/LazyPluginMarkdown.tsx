import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { cn } from "@omnyo/shared-ui/lib/utils";
import type { MarkdownProps } from "@omnyo/plugin-sdk";
import { defineSplit } from "@/lib/define-split";

export const LazyPluginMarkdown = defineSplit<MarkdownProps>({
  id: "plugin-markdown",
  load: () =>
    import("./PluginMarkdown").then((module) => module.PluginMarkdown),
  loading: ({ className }) => (
    <div
      className={cn("space-y-2", className)}
      role="status"
      aria-label="Loading Markdown"
    >
      <Skeleton className="h-4 w-full rounded-sm" />
      <Skeleton className="h-4 w-4/5 rounded-sm" />
    </div>
  ),
});
