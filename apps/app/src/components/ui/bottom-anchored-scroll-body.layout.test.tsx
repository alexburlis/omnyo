// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";

class ResizeObserverMock implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderBody(scrollOverlay?: ReactNode) {
  const view = render(
    <BottomAnchoredScrollBody
      footer={<div>Footer</div>}
      maxWidthClassName="max-w-none"
      scrollOverlay={scrollOverlay}
    >
      <div data-timeline-row-id="row-a">row-a</div>
    </BottomAnchoredScrollBody>,
  );

  const viewport = view.container.querySelector<HTMLElement>(
    "[data-page-scroll-viewport]",
  );

  if (!viewport) throw new Error("Scroll body did not render its viewport");

  const contentWrapper = view.container.querySelector<HTMLElement>(
    "[data-page-content-column]",
  );

  if (!contentWrapper) throw new Error("Scroll body did not render a column");

  return { container: view.container, viewport, contentWrapper };
}

describe("BottomAnchoredScrollBody native anchoring", () => {
  it("turns off browser scroll anchoring so one owner positions content", () => {
    const { viewport, container } = renderBody();

    expect(viewport.style.overflowAnchor).toBe("none");
    expect(container.querySelector(".scroll-bottom-anchor")).toBeNull();
  });
});

describe("BottomAnchoredScrollBody page landmarks", () => {
  it("marks only the centred content column, inside its scroll viewport", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const { container, contentWrapper } = renderBody(<nav>Overlay</nav>);

    expect([
      ...container.querySelectorAll("[data-page-content-column]"),
    ]).toEqual([contentWrapper]);
    expect(contentWrapper.classList).toContain("mx-auto");
    expect(contentWrapper.classList).toContain("max-w-none");
    expect(
      contentWrapper.closest("[data-page-scroll-viewport]"),
    ).not.toBeNull();
  });
});

describe("BottomAnchoredScrollBody grid", () => {
  it("stacks the scroll port and overlay in one explicit minmax(auto,1fr) row", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const { container } = renderBody(<nav>Overlay</nav>);
    const scrollPort = container.querySelector(".thread-scrollbar");
    const overlay = container.querySelector("[data-scroll-overlay]");
    const grid = scrollPort?.parentElement;

    expect(overlay?.parentElement).toBe(grid);
    expect(grid?.classList).toContain("grid");
    expect(
      [...(grid?.classList ?? [])].filter((token) =>
        token.startsWith("grid-rows-"),
      ),
    ).toEqual(["grid-rows-[minmax(auto,1fr)]"]);

    for (const item of [scrollPort, overlay]) {
      expect([...(item?.classList ?? [])]).toEqual(
        expect.arrayContaining(["row-start-1", "col-start-1", "min-h-0"]),
      );
    }
  });
});
