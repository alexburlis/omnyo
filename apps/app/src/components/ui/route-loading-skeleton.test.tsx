// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteLoadingSkeleton } from "./route-loading-skeleton";

const viewport = vi.hoisted(() => ({ compact: false }));

vi.mock("@omnyo/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewport.compact,
}));

afterEach(() => {
  cleanup();
  viewport.compact = false;
});

describe("RouteLoadingSkeleton", () => {
  it("bleeds through standalone page padding", () => {
    render(<RouteLoadingSkeleton isBoundedPane={false} />);

    const skeleton = screen.getByTestId("route-loading-skeleton");
    expect(skeleton.className).toContain("-mx-4");
    expect(skeleton.className).toContain("-mt-4");
    expect(skeleton.className).toContain("md:-mx-5");
    expect(skeleton.className).toContain("md:-mt-5");
    expect(skeleton.querySelector(".pl-12")).toBeNull();
  });

  it("reserves space for the sidebar button in a compact standalone page", () => {
    viewport.compact = true;
    render(<RouteLoadingSkeleton isBoundedPane={false} />);

    const skeleton = screen.getByTestId("route-loading-skeleton");

    expect(skeleton.firstElementChild?.className).toContain("pl-12");
  });

  it("keeps bounded-pane placeholders inside their pane", () => {
    render(<RouteLoadingSkeleton isBoundedPane />);

    const skeleton = screen.getByTestId("route-loading-skeleton");
    const header = skeleton.firstElementChild;

    expect(skeleton.className).not.toContain("-mx-4");
    expect(skeleton.className).not.toContain("-mt-4");
    expect(skeleton.className).not.toContain("md:-mx-5");
    expect(skeleton.className).not.toContain("md:-mt-5");
    expect(header?.className).toContain("px-4");
    expect(header?.className).not.toContain("pl-12");
  });
});
