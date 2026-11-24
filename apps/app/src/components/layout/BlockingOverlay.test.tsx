// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_DURATION_MS,
  TRANSITION_FALLBACK_SLACK_MS,
} from "@omnyo/shared-ui/motion";
import { BlockingOverlay } from "./BlockingOverlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function overlay(open: boolean, label: string | null) {
  return (
    <BlockingOverlay open={open} aria-label="Blocking" data-test-overlay="">
      {label === null ? null : <p>{label}</p>}
    </BlockingOverlay>
  );
}

describe("BlockingOverlay", () => {
  it("enters with the modal scrim and card motion and takes focus", () => {
    render(overlay(true, "Updating"));

    const layer = screen.getByRole("dialog", { name: "Blocking" });
    expect(layer.dataset.state).toBe("open");
    expect(layer.className).toContain("data-[state=open]:animate-in");
    expect(layer.className).toContain("data-[state=open]:fade-in-0");
    expect(layer.firstElementChild?.className).toContain(
      "data-[state=open]:zoom-in-95",
    );
    expect(document.activeElement).toBe(layer);
  });

  it("keeps the last content during the exit and unmounts when it ends", () => {
    vi.useFakeTimers();
    const view = render(overlay(true, "Updating"));
    const layer = screen.getByRole("dialog", { name: "Blocking" });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      animationName: "omnyo-motion-exit",
    } as CSSStyleDeclaration);

    view.rerender(overlay(false, null));

    expect(layer.dataset.state).toBe("closed");
    expect(layer.hasAttribute("inert")).toBe(true);
    expect(layer.className).toContain("pointer-events-none");
    expect(layer.textContent).toContain("Updating");

    act(() => {
      vi.advanceTimersByTime(
        MOTION_DURATION_MS.fast + TRANSITION_FALLBACK_SLACK_MS,
      );
    });
    expect(document.querySelector("[data-test-overlay]")).toBeNull();
  });

  it("unmounts at once when no exit animation runs", () => {
    const view = render(overlay(true, "Updating"));
    view.rerender(overlay(false, null));

    expect(document.querySelector("[data-test-overlay]")).toBeNull();
  });
});
