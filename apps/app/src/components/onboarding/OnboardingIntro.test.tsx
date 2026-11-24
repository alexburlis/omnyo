// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingIntro } from "./OnboardingIntro";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startIntro() {
  const onDone = vi.fn();
  const view = render(<OnboardingIntro onDone={onDone} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return { onDone, root: view.container.querySelector(".omnyo-intro") };
}

describe("OnboardingIntro", () => {
  it("plays the full intro, then hands over to setup", async () => {
    const { onDone, root } = await startIntro();

    expect(root?.getAttribute("data-state")).toBe("playing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("skips straight to setup on a key press or click", async () => {
    const { onDone, root } = await startIntro();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(root?.getAttribute("data-state")).toBe("leaving");

    if (root !== null && root !== undefined) fireEvent.pointerDown(root);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
    expect(onDone).toHaveBeenCalledOnce();
  });
});
