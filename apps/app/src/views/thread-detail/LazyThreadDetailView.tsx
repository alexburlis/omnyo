import type { ComponentProps } from "react";
import { defineSplit } from "@/lib/define-split";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { ThreadTimelineLoadingSkeleton } from "@/components/thread/timeline/ThreadTimelineLoadingSkeleton";
import { usePaneContext } from "./PaneContext";
import type { ThreadDetailView } from "./ThreadDetailView";
import { useRouteState } from "@/hooks/useRouteState";
import { isPendingChatId } from "@/lib/pending-chat-creations";
import { PendingChatRoute } from "./PendingChatRoute";

function ThreadDetailViewLoading() {
  const { isBoundedPane } = usePaneContext();

  return (
    <RouteLoadingSkeleton isBoundedPane={isBoundedPane}>
      <ThreadTimelineLoadingSkeleton />
    </RouteLoadingSkeleton>
  );
}

const SplitThreadDetailView = defineSplit<
  ComponentProps<typeof ThreadDetailView>
>({
  id: "thread-detail",
  load: () =>
    import("./ThreadDetailView").then((module) => module.ThreadDetailView),
  loading: ThreadDetailViewLoading,
});

function RoutedLazyThreadDetailView() {
  const { projectId, threadId } = useRouteState();

  if (projectId && threadId && isPendingChatId(threadId))
    return <PendingChatRoute projectId={projectId} threadId={threadId} />;

  return <SplitThreadDetailView surface="page" />;
}

export const LazyThreadDetailView = Object.assign(
  function LazyThreadDetailView(
    props: ComponentProps<typeof ThreadDetailView>,
  ) {
    if (props.surface === "page") return <RoutedLazyThreadDetailView />;

    if (isPendingChatId(props.threadId))
      return (
        <PendingChatRoute
          projectId={props.projectId}
          threadId={props.threadId}
        />
      );

    return <SplitThreadDetailView {...props} />;
  },
  { preload: SplitThreadDetailView.preload },
);
