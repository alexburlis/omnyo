// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";
import { createPendingChat } from "@/lib/pending-chat-creations";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { LazyThreadDetailView } from "./LazyThreadDetailView";
import { PaneContext, type PaneContextValue } from "./PaneContext";

vi.mock("./ThreadDetailView", () => new Promise(() => {}));

afterEach(cleanup);

function paneContext(isBoundedPane: boolean): PaneContextValue {
  return {
    paneId: "main",
    isFocused: true,
    isSplitPane: isBoundedPane,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: null,
    isMaximized: false,
    onToggleMaximize: null,
    isBoundedPane,
    isTopRow: true,
    ownsWindowTopLeft: true,
    navigateInPane: () => {},
  };
}

function renderLoadingPane(isBoundedPane: boolean, isCompactViewport = false) {
  render(
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <PaneContext.Provider value={paneContext(isBoundedPane)}>
        <LazyThreadDetailView
          surface="pane"
          projectId="proj_test"
          threadId="thr_test"
          timelineEnabled
        />
      </PaneContext.Provider>
    </CompactViewportOverrideProvider>,
  );

  return screen.getByTestId("route-loading-skeleton");
}

describe("LazyThreadDetailView", () => {
  it("renders the already-loaded provisional chat without waiting for the thread chunk", async () => {
    const remote = createDeferredPromise<ThreadResponse>();

    const pending = createPendingChat({
      queueOwner: {},
      request: {
        projectId: "proj_test",
        providerId: "codex",
        model: "model-a",
        reasoningLevel: "high",
        permissionMode: "full",
        environment: { type: "reuse", environmentId: "environment-a" },
        executionInputSources: { model: "explicit" },
        input: [{ type: "text", text: "initial prompt", mentions: [] }],
      },
      create: () => remote.promise,
      send: vi.fn(),
      renderer: () => <p>Initial prompt and next composer</p>,
      prepare: async () => {},
    });

    const view = render(
      <PaneContext.Provider value={paneContext(false)}>
        <LazyThreadDetailView
          surface="pane"
          projectId="proj_test"
          threadId={pending.id}
          timelineEnabled
        />
      </PaneContext.Provider>,
    );

    expect(screen.getByText("Initial prompt and next composer")).toBeTruthy();
    expect(screen.queryByTestId("route-loading-skeleton")).toBeNull();

    view.unmount();
    remote.resolve(
      makeThreadResponse({ id: "real-lazy-chat", projectId: "proj_test" }),
    );
    await pending.completion;
  });

  it("leaves the header to the window title bar in a wide unbounded pane", () => {
    const skeleton = renderLoadingPane(false);

    expect(skeleton.firstElementChild?.className).toContain("max-w-[760px]");
    expect(skeleton.querySelector(".pl-12")).toBeNull();
  });

  it("keeps a full-page header row clear of the floating trigger on phones", () => {
    const header = renderLoadingPane(false, true).firstElementChild;

    expect(header?.className).toContain("pl-12");
  });

  it("keeps its loading skeleton inside a bounded split pane", () => {
    const header = renderLoadingPane(true).firstElementChild;

    expect(header?.className).toContain("px-4");
    expect(header?.className).not.toContain("pl-12");
  });
});
