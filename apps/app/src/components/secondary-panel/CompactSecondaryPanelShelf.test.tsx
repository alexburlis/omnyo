// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactSecondaryPanelShelf } from "./CompactSecondaryPanelShelf";
import { MobilePanelTabPager } from "./MobilePanelTabPager";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { getCompactSecondaryPanelPresentation } from "@/components/ui/secondary-panel-shelf-visibility";

function createTouch(clientX: number, clientY: number): Touch {
  return { identifier: 1, clientX, clientY } as Touch;
}

function createTouchList(...touches: Touch[]): TouchList {
  const touchList = {
    length: touches.length,
    item: (index: number) => touches[index] ?? null,
  };

  touches.forEach((touch, index) => {
    Object.defineProperty(touchList, index, { value: touch });
  });

  return touchList as unknown as TouchList;
}

function fireTouch(
  target: Element | Window,
  type: "touchstart" | "touchmove" | "touchend",
  touch: Touch,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: {
      value: type === "touchend" ? createTouchList() : createTouchList(touch),
    },
    changedTouches: { value: createTouchList(touch) },
  });
  fireEvent(target, event);
}

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function renderShelf(open: boolean, onClose = vi.fn()) {
  const view = render(
    <CompactSecondaryPanelShelf
      open={open}
      onClose={onClose}
      srLabel="Right panel"
    >
      <div data-testid="panel-body" />
    </CompactSecondaryPanelShelf>,
  );

  return { ...view, onClose };
}

describe("CompactSecondaryPanelShelf", () => {
  it("anchors to the right edge rather than the bottom", () => {
    renderShelf(true);

    const shelf = screen.getByTestId("secondary-panel-shelf");
    expect(shelf.className).toContain("right-0");
    expect(shelf.className).toContain("inset-y-0");
    expect(shelf.className).not.toContain("bottom-0");
  });

  it("keeps portaled panel controls inside the device safe area", () => {
    renderShelf(true);

    const shelf = screen.getByTestId("secondary-panel-shelf");
    expect(shelf.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(shelf.className).toContain("pr-[env(safe-area-inset-right)]");
    expect(shelf.className).toContain(
      "pb-[var(--omnyo-safe-area-bottom,env(safe-area-inset-bottom))]",
    );
    expect(shelf.className).toContain("pl-[env(safe-area-inset-left)]");
  });

  it("fills the viewport and slides in from the right edge instead of resizing", () => {
    const { rerender } = renderShelf(false);
    const shelf = screen.getByTestId("secondary-panel-shelf");
    expect(shelf.dataset.state).toBe("closed");
    expect(shelf.className).toContain("w-full");
    expect(shelf.className).toContain("translate-x-full");
    expect(shelf.className).toContain("data-[state=full]:translate-x-0");
    expect(shelf.className).not.toContain("width_");
    expect(shelf.className).toContain(
      "[transition:translate_var(--motion-duration-drawer)_var(--motion-ease-sheet)]",
    );

    rerender(
      <CompactSecondaryPanelShelf open onClose={vi.fn()} srLabel="Right panel">
        <div data-testid="panel-body" />
      </CompactSecondaryPanelShelf>,
    );
    expect(screen.getByTestId("secondary-panel-shelf").dataset.state).toBe(
      "full",
    );
  });

  it("stacks the full page panel above app chrome and below shared overlays", () => {
    renderShelf(true);

    const shelf = screen.getByTestId("secondary-panel-shelf");
    expect(shelf.style.zIndex).toBe(
      String(APP_OVERLAY_LAYER.secondaryPanelFullPage),
    );
    expect(APP_OVERLAY_LAYER.secondaryPanelFullPage).toBeGreaterThan(
      APP_OVERLAY_LAYER.sidebarTrigger,
    );
    expect(APP_OVERLAY_LAYER.sharedPortaledOverlay).toBeGreaterThan(
      APP_OVERLAY_LAYER.secondaryPanelFullPage,
    );
  });

  it("finishes a closing swipe whose touched node remounts mid-drag", () => {
    const onClose = vi.fn();

    const view = (version: number) => (
      <CompactSecondaryPanelShelf open onClose={onClose} srLabel="Right panel">
        <div key={version} data-testid="panel-body" />
      </CompactSecondaryPanelShelf>
    );

    const { rerender } = render(view(1));
    const shelf = screen.getByTestId("secondary-panel-shelf");
    Object.defineProperty(shelf, "clientWidth", { value: 300 });
    const body = screen.getByTestId("panel-body");

    fireTouch(body, "touchstart", createTouch(60, 160));
    fireTouch(window, "touchmove", createTouch(100, 162));
    rerender(view(2));
    expect(body.isConnected).toBe(false);
    fireTouch(body, "touchmove", createTouch(240, 164));
    fireTouch(body, "touchend", createTouch(240, 164));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("yields a closing swipe that a nested handler claims while the touched node stays mounted", () => {
    const onClose = vi.fn();
    render(
      <CompactSecondaryPanelShelf open onClose={onClose} srLabel="Right panel">
        <div data-testid="claimer">
          <div data-testid="panel-body" />
        </div>
      </CompactSecondaryPanelShelf>,
    );
    const shelf = screen.getByTestId("secondary-panel-shelf");
    Object.defineProperty(shelf, "clientWidth", { value: 300 });
    screen
      .getByTestId("claimer")
      .addEventListener("touchmove", (event) => event.preventDefault(), {
        passive: false,
      });
    const body = screen.getByTestId("panel-body");

    fireTouch(body, "touchstart", createTouch(60, 160));
    fireTouch(body, "touchmove", createTouch(240, 164));
    fireTouch(body, "touchend", createTouch(240, 164));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("navigates tab swipes without dismissing while preserving body dismissal", () => {
    const onClose = vi.fn();

    const tabs = ["README.md", "package.json", "AGENTS.md"].map((label) => ({
      id: label,
      label,
      ariaLabel: label,
      leadingVisual: null,
      onSelect: vi.fn(),
      onClose: null,
    }));

    render(
      <CompactSecondaryPanelShelf open onClose={onClose} srLabel="Right panel">
        <MobilePanelTabPager
          activeTabId="package.json"
          fixedTabs={[]}
          tabs={tabs}
          newTabControl={null}
        />
        <div data-testid="panel-body" />
      </CompactSecondaryPanelShelf>,
    );
    const shelf = screen.getByTestId("secondary-panel-shelf");
    Object.defineProperty(shelf, "clientWidth", { value: 390 });
    const tab = screen.getByRole("button", { name: "package.json" });

    for (const endX of [280, 40]) {
      fireTouch(tab, "touchstart", createTouch(160, 20));
      fireTouch(tab, "touchmove", createTouch(endX, 20));
      fireTouch(tab, "touchend", createTouch(endX, 20));
      expect(onClose).not.toHaveBeenCalled();
    }

    expect(tabs[0].onSelect).toHaveBeenCalledOnce();
    expect(tabs[2].onSelect).toHaveBeenCalledOnce();

    const body = screen.getByTestId("panel-body");
    fireTouch(body, "touchstart", createTouch(60, 160));
    fireTouch(body, "touchmove", createTouch(240, 164));
    fireTouch(body, "touchend", createTouch(240, 164));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(["before touch", "after long press"])(
    "preserves text selection established %s instead of dismissing",
    (timing) => {
      const { onClose } = renderShelf(true);
      const shelf = screen.getByTestId("secondary-panel-shelf");
      const body = screen.getByTestId("panel-body");
      body.textContent = "Select this preview text";
      Object.defineProperty(shelf, "clientWidth", { value: 300 });

      const selectText = () => {
        const range = document.createRange();
        range.selectNodeContents(body);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        expect(document.getSelection()?.toString()).toBe(
          "Select this preview text",
        );
      };

      if (timing === "before touch") selectText();
      fireTouch(body, "touchstart", createTouch(60, 160));

      if (timing === "after long press") selectText();
      fireTouch(window, "touchmove", createTouch(240, 164));
      fireTouch(window, "touchend", createTouch(240, 164));

      expect(onClose).not.toHaveBeenCalled();
      expect(window.getSelection()?.toString()).toBe(
        "Select this preview text",
      );

      window.getSelection()?.removeAllRanges();
      fireTouch(body, "touchstart", createTouch(60, 160));
      fireTouch(window, "touchmove", createTouch(240, 164));
      fireTouch(window, "touchend", createTouch(240, 164));
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it("clears only its selected text on close so reopening restores swiping", () => {
    const onClose = vi.fn();

    const view = (open: boolean) => (
      <>
        <div data-testid="outside-selection">Outside selection</div>
        <CompactSecondaryPanelShelf
          open={open}
          onClose={onClose}
          srLabel="Right panel"
        >
          <div data-testid="panel-body">Preview selection</div>
        </CompactSecondaryPanelShelf>
      </>
    );

    const selectContents = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    };

    const { rerender } = render(view(true));

    selectContents(screen.getByTestId("outside-selection"));
    rerender(view(false));
    expect(window.getSelection()?.toString()).toBe("Outside selection");

    rerender(view(true));
    const shelf = screen.getByTestId("secondary-panel-shelf");
    Object.defineProperty(shelf, "clientWidth", { value: 300 });
    selectContents(screen.getByTestId("panel-body"));
    rerender(view(false));
    expect(window.getSelection()?.isCollapsed).toBe(true);

    rerender(view(true));
    fireTouch(shelf, "touchstart", createTouch(60, 160));
    fireTouch(window, "touchmove", createTouch(240, 164));
    fireTouch(window, "touchend", createTouch(240, 164));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a closing swipe from the left browser edge", () => {
    const { onClose } = renderShelf(true);
    const shelf = screen.getByTestId("secondary-panel-shelf");
    Object.defineProperty(shelf, "clientWidth", { value: 300 });

    fireTouch(shelf, "touchstart", createTouch(12, 160));
    fireTouch(window, "touchmove", createTouch(180, 164));
    fireTouch(window, "touchend", createTouch(180, 164));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("hides the closed shelf so it cannot cover the sidebar shelf", () => {
    renderShelf(false);

    const shelf = screen.getByTestId("secondary-panel-shelf");
    expect(shelf.dataset.state).toBe("closed");
    expect(shelf.style.zIndex).toBe(String(APP_OVERLAY_LAYER.secondaryPanel));
    expect(shelf.className).toContain("data-[state=closed]:invisible");
    expect(shelf.className).toContain(
      "data-[state=closed]:[transition:translate_var(--motion-duration-drawer)_var(--motion-ease-sheet),visibility_0s_linear_var(--motion-duration-drawer)]",
    );
    expect(shelf.className).toContain("motion-reduce:transition-none!");
  });

  it("moves the shelf with the finger and settles it with the page inset", () => {
    const inset = document.createElement("main");
    inset.dataset.sidebar = "inset";
    document.body.appendChild(inset);
    const { onClose } = renderShelf(true);
    const shelf = screen.getByTestId("secondary-panel-shelf");
    Object.defineProperty(shelf, "clientWidth", { value: 300 });

    fireTouch(shelf, "touchstart", createTouch(60, 160));
    fireTouch(window, "touchmove", createTouch(210, 162));
    expect(shelf.style.translate).toBe("150px");
    expect(shelf.style.transition).toBe("none");
    expect(inset.style.translate).toBe("-150px");
    expect(inset.style.transition).toBe("none");

    fireTouch(window, "touchend", createTouch(210, 162));
    expect(onClose).toHaveBeenCalledOnce();
    expect(shelf.style.translate).toBe("300px");
    expect(inset.style.translate).toBe("0px");
    expect(shelf.style.transition).toMatch(
      /^translate \d+ms var\(--motion-ease-sheet\), visibility 0s linear \d+ms$/,
    );
    expect(inset.style.transition).toMatch(
      /^translate \d+ms var\(--motion-ease-sheet\)$/,
    );
    inset.remove();
  });

  it("marks the shelf inert while closed and interactive while open", () => {
    const { rerender } = renderShelf(false);
    expect(
      screen.getByTestId("secondary-panel-shelf").hasAttribute("inert"),
    ).toBe(true);

    rerender(
      <CompactSecondaryPanelShelf open onClose={vi.fn()} srLabel="Right panel">
        <div data-testid="panel-body" />
      </CompactSecondaryPanelShelf>,
    );
    expect(
      screen.getByTestId("secondary-panel-shelf").hasAttribute("inert"),
    ).toBe(false);
  });

  it("publishes the presentation so the page knows when to move aside", () => {
    const { rerender, unmount } = renderShelf(true);
    expect(getCompactSecondaryPanelPresentation()).toBe("full");

    rerender(
      <CompactSecondaryPanelShelf
        open={false}
        onClose={vi.fn()}
        srLabel="Right panel"
      >
        <div data-testid="panel-body" />
      </CompactSecondaryPanelShelf>,
    );
    expect(getCompactSecondaryPanelPresentation()).toBe("closed");

    rerender(
      <CompactSecondaryPanelShelf open onClose={vi.fn()} srLabel="Right panel">
        <div data-testid="panel-body" />
      </CompactSecondaryPanelShelf>,
    );
    expect(getCompactSecondaryPanelPresentation()).toBe("full");

    unmount();
    expect(getCompactSecondaryPanelPresentation()).toBe("closed");
  });

  it("closes on Escape only while open", () => {
    const { onClose, rerender } = renderShelf(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <CompactSecondaryPanelShelf open onClose={onClose} srLabel="Right panel">
        <div data-testid="panel-body" />
      </CompactSecondaryPanelShelf>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("contains focus, yields to nested overlays, and restores the trigger", () => {
    function FocusShelf() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open right panel
          </button>
          <CompactSecondaryPanelShelf
            open={open}
            onClose={() => setOpen(false)}
            srLabel="Right panel"
          >
            <button type="button">First action</button>
            <button type="button">Last action</button>
          </CompactSecondaryPanelShelf>
        </>
      );
    }

    render(<FocusShelf />);
    const trigger = screen.getByRole("button", { name: "Open right panel" });
    trigger.focus();
    fireEvent.click(trigger);
    const shelf = screen.getByRole("dialog", { name: "Right panel" });
    expect(document.activeElement).toBe(shelf);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First action" }),
    );
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Last action" }),
    );

    const nestedAction = document.createElement("button");
    nestedAction.setAttribute("data-omnyo-portaled-overlay", "");
    nestedAction.addEventListener("keydown", (event) => {
      if (event.key === "Escape") event.preventDefault();
    });
    document.body.appendChild(nestedAction);
    nestedAction.focus();
    fireEvent.keyDown(nestedAction, { key: "Tab" });
    expect(document.activeElement).toBe(nestedAction);
    fireEvent.keyDown(nestedAction, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Right panel" })).not.toBeNull();
    nestedAction.remove();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(shelf.getAttribute("data-state")).toBe("closed");
    expect(shelf.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("renders outside the transformed page so it does not slide with it", () => {
    renderShelf(true);

    const shelf = screen.getByTestId("secondary-panel-shelf");
    expect(shelf.closest('[data-sidebar="inset"]')).toBeNull();
    expect(shelf.parentElement).toBe(document.body);
  });
});
