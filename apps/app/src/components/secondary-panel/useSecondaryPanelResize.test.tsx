// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { Panel, PanelGroup } from "react-resizable-panels";
import { afterEach, expect, it, vi } from "vitest";
import {
  PREVIEW_SECONDARY_PANEL_WIDTH_PERCENT,
  secondaryPanelWidthPercentAtom,
  widenSecondaryPanelForPreviewAtom,
} from "./threadSecondaryPanelAtoms";
import { useSecondaryPanelResize } from "./useSecondaryPanelResize";

vi.mock("react-resizable-panels", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);

  return require(
    join(
      dirname(require.resolve("react-resizable-panels/package.json")),
      "dist/react-resizable-panels.browser.development.cjs.js",
    ),
  );
});

afterEach(cleanup);

it("sizes a lazily mounted surface from its clamped panel instead of the saved width", () => {
  function LoadedPanel() {
    const {
      secondaryPanelRef,
      secondaryResizablePanelRef,
      handleSecondaryPanelResize,
    } = useSecondaryPanelResize({
      isConversationCollapsed: false,
      isSecondaryPanelOpen: true,
      onPanelWidthChange: () => {},
      panelId: "secondary",
      renderAsDrawer: false,
    });

    return (
      <Panel
        id="secondary"
        ref={secondaryResizablePanelRef}
        minSize={30}
        maxSize={70}
        defaultSize={90}
        onResize={handleSecondaryPanelResize}
      >
        <aside ref={secondaryPanelRef} data-testid="surface" />
      </Panel>
    );
  }

  function Harness({ loaded }: { loaded: boolean }) {
    return (
      <PanelGroup direction="horizontal">
        <Panel id="main" minSize={30} defaultSize={10} />
        {loaded ? (
          <LoadedPanel />
        ) : (
          <Panel id="secondary" minSize={30} maxSize={70} defaultSize={90} />
        )}
      </PanelGroup>
    );
  }

  const { rerender } = render(<Harness loaded={false} />);
  rerender(<Harness loaded />);
  const surface = screen.getByTestId("surface");
  expect(surface.parentElement?.getAttribute("data-panel-size")).toBe("70.0");
  expect(surface.style.getPropertyValue("--secondary-swipe-width")).toBe(
    "70cqw",
  );
  const setProperty = vi.spyOn(surface.style, "setProperty");
  rerender(<Harness loaded />);
  expect(setProperty).not.toHaveBeenCalled();
});

it("grows an open panel to the preview width and never shrinks a wider one", () => {
  const store = createStore();
  store.set(secondaryPanelWidthPercentAtom, 40);

  function OpenPanel({ collapsed }: { collapsed: boolean }) {
    const {
      secondaryPanelRef,
      secondaryResizablePanelRef,
      handleSecondaryPanelResize,
    } = useSecondaryPanelResize({
      isConversationCollapsed: collapsed,
      isSecondaryPanelOpen: true,
      onPanelWidthChange: () => {},
      panelId: "secondary",
      renderAsDrawer: false,
    });

    return (
      <PanelGroup direction="horizontal">
        <Panel id="main" order={1} minSize={20} defaultSize={60} />
        <Panel
          id="secondary"
          order={2}
          ref={secondaryResizablePanelRef}
          minSize={20}
          maxSize={80}
          defaultSize={40}
          onResize={handleSecondaryPanelResize}
        >
          <aside ref={secondaryPanelRef} data-testid="surface" />
        </Panel>
      </PanelGroup>
    );
  }

  const panelSize = () =>
    screen
      .getByTestId("surface")
      .parentElement?.getAttribute("data-panel-size");

  const { rerender } = render(
    <Provider store={store}>
      <OpenPanel collapsed={false} />
    </Provider>,
  );

  expect(panelSize()).toBe("40.0");
  act(() => store.set(widenSecondaryPanelForPreviewAtom));
  expect(store.get(secondaryPanelWidthPercentAtom)).toBe(
    PREVIEW_SECONDARY_PANEL_WIDTH_PERCENT,
  );
  expect(panelSize()).toBe("60.0");
  act(() => store.set(secondaryPanelWidthPercentAtom, 75));
  act(() => store.set(widenSecondaryPanelForPreviewAtom));
  expect(store.get(secondaryPanelWidthPercentAtom)).toBe(75);
  expect(panelSize()).toBe("75.0");
  rerender(
    <Provider store={store}>
      <OpenPanel collapsed />
    </Provider>,
  );
  act(() => store.set(secondaryPanelWidthPercentAtom, 30));
  expect(panelSize()).toBe("75.0");
});
