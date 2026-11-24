// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalThreadCompanionProps } from "@omnyo/plugin-sdk";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { WindowTitleBarSlotsContext } from "@/components/layout/window-title-bar-slots";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  ThreadCompanionHost,
  ThreadCompanionInlineSlot,
  ThreadPaneTopOverlay,
} from "./ThreadCompanions";

function Companion({ threadId, placement }: ExperimentalThreadCompanionProps) {
  const [count, setCount] = useState(0);

  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      {`${threadId} ${placement} ${count}`}
    </button>
  );
}

function registerCompanion() {
  setPluginSlotRegistrations(
    "glance",
    makePluginRegistrationSet({
      threadCompanions: [
        { id: "card", title: "Glance", icon: "GridView", component: Companion },
      ],
    }),
  );
}

function givePaneWidth(width: number) {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.threadPaneTopOverlay === undefined
        ? measure.call(this)
        : new DOMRect(0, 0, width, 0);
    },
  );
}

function Pane({ compact, focused }: { compact: boolean; focused: boolean }) {
  return (
    <CompactViewportOverrideProvider isCompactViewport={compact}>
      <ThreadCompanionHost
        threadId="thr_1"
        projectId="proj_1"
        focused={focused}
      >
        <ThreadPaneTopOverlay goal={null} goalShown={false} />
        <ThreadCompanionInlineSlot />
      </ThreadCompanionHost>
    </CompactViewportOverrideProvider>
  );
}

function renderPane({
  compact = false,
  focused = true,
}: { compact?: boolean; focused?: boolean } = {}) {
  const toolbar = document.createElement("div");
  document.body.append(toolbar);
  const store = createStore();

  const wrap = (pane: { compact: boolean; focused: boolean }) => (
    <JotaiProvider store={store}>
      <WindowTitleBarSlotsContext.Provider
        value={{
          pageTitle: null,
          pageActions: null,
          companionToolbar: toolbar,
        }}
      >
        <Pane {...pane} />
      </WindowTitleBarSlotsContext.Provider>
    </JotaiProvider>
  );

  const { rerender } = render(wrap({ compact, focused }));

  return {
    aside: () =>
      document.querySelector<HTMLElement>("[data-thread-companion-aside]")!,
    inline: () =>
      document.querySelector<HTMLElement>("[data-thread-companion-inline]")!,
    toolbar,
    rerender: (pane: { compact: boolean; focused: boolean }) =>
      rerender(wrap(pane)),
  };
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.body.replaceChildren();
});

describe("thread companions", () => {
  it("folds into the title bar when the pane has no room beside the chat", () => {
    registerCompanion();
    givePaneWidth(1200);
    const { aside, toolbar } = renderPane();

    expect(within(toolbar).getByRole("button").textContent).toBe(
      "thr_1 toolbar 0",
    );
    expect(aside().childElementCount).toBe(0);
  });

  it("floats beside the chat when there is room and keeps its state when it moves", () => {
    registerCompanion();
    givePaneWidth(1600);
    const { aside, inline, toolbar, rerender } = renderPane();

    fireEvent.click(within(aside()).getByRole("button"));
    expect(within(aside()).getByRole("button").textContent).toBe(
      "thr_1 aside 1",
    );
    expect(toolbar.childElementCount).toBe(0);

    rerender({ compact: true, focused: true });
    expect(aside().childElementCount).toBe(0);
    expect(within(inline()).getByRole("button").textContent).toBe(
      "thr_1 inline 1",
    );
  });

  it("adds no title bar toggle of its own", () => {
    registerCompanion();
    givePaneWidth(1200);
    renderPane();

    expect(screen.queryByRole("button", { name: "Glance" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders above the composer on a compact viewport", () => {
    registerCompanion();
    givePaneWidth(1600);
    const { aside, inline, toolbar } = renderPane({ compact: true });

    expect(within(inline()).getByRole("button").textContent).toBe(
      "thr_1 inline 0",
    );
    expect(aside().childElementCount).toBe(0);
    expect(toolbar.childElementCount).toBe(0);
  });

  it("leaves the toolbar to the focused pane", () => {
    registerCompanion();
    givePaneWidth(1200);
    const { toolbar } = renderPane({ focused: false });

    expect(toolbar.childElementCount).toBe(0);
    expect(screen.queryByText(/^thr_1/)).toBeNull();
  });

  it("renders nothing when no plugin registers a companion", () => {
    renderPane();

    expect(screen.queryByRole("button")).toBeNull();
  });
});
