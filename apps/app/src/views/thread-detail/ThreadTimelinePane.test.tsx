// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadTimelineSurfaceProps } from "@/components/thread/timeline/ThreadTimelineSurface";

vi.mock("@/components/thread/timeline/ThreadTimelineSurface", () => ({
  ThreadTimelineSurface: (props: ThreadTimelineSurfaceProps) => (
    <div data-testid="timeline">
      <span data-testid="plugin-panel-opener">
        {props.onOpenPluginPanel === undefined ? "missing" : "available"}
      </span>
    </div>
  ),
}));

vi.mock("@/components/thread/toc/ThreadTableOfContents", () => ({
  ThreadTableOfContents: () => <nav aria-label="Conversation outline" />,
}));

const { ThreadTimelinePane } = await import("./ThreadTimelinePane");

afterEach(cleanup);

it("forwards pane callbacks to the timeline and conversation outline", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThreadTimelinePane
        activeThinking={null}
        canSpawnChild={false}
        contextBoundarySeq={null}
        footer={null}
        hasOlderTimelineRows={false}
        isLoadingOlderTimelineRows={false}
        isStopping={false}
        isThreadTimelinePending={false}
        onLoadOlderRows={() => undefined}
        onOpenPluginPanel={() => true}
        projectId="proj_1"
        resolveMentionLink={() => null}
        showOngoingIndicator={false}
        stoppingAnchorAt={0}
        threadId="thr_1"
        threadRuntimeDisplayStatus="idle"
        timelineError={false}
        timelineRows={[]}
        unreadDividerAutoScroll={false}
        unreadDividerPlacement={null}
        workspaceRootPath={undefined}
      />
    </QueryClientProvider>,
  );

  expect(screen.getByTestId("plugin-panel-opener").textContent).toBe(
    "available",
  );
  expect(
    screen.getByRole("navigation", { name: "Conversation outline" }),
  ).not.toBeNull();
});
