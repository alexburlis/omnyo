import { defineSplit } from "@/lib/define-split";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";

export const LazyPluginsOverview = defineSplit<
  import("./PluginsOverview").PluginsOverviewProps
>({
  id: "plugins-overview",
  load: () =>
    import("./PluginsOverview").then((module) => module.PluginsOverview),
  loading: () => <RouteLoadingSkeleton isBoundedPane={false} />,
});
