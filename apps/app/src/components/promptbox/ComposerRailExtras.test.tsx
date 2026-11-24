// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { ComposerRailExtras } from "./ComposerRailExtras";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps crowded controls usable in overflow and restores them when space returns", () => {
  let availableWidth = 400;
  const resizeCallbacks = new Set<() => void>();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => availableWidth,
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      readonly targets = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {}
      readonly trigger = () =>
        this.callback(
          [...this.targets].map((target) => ({
            target,
            contentRect: target.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          })),
          this,
        );
      observe(target: Element) {
        this.targets.add(target);
        resizeCallbacks.add(this.trigger);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        resizeCallbacks.delete(this.trigger);
        this.targets.clear();
      }
    },
  );
  const action = vi.fn();
  render(
    <ComposerRailExtras>
      <button type="button" onClick={action}>
        Compact history
      </button>
    </ComposerRailExtras>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Compact history" }));
  expect(action).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "More composer controls" }),
  ).toBeNull();
  act(() => {
    availableWidth = 100;

    for (const callback of [...resizeCallbacks]) callback();
  });
  expect(screen.queryByRole("button", { name: "Compact history" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "More composer controls" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Compact history" }));
  expect(action).toHaveBeenCalledTimes(2);
  act(() => {
    availableWidth = 400;

    for (const callback of [...resizeCallbacks]) callback();
  });
  expect(
    screen.queryByRole("button", { name: "More composer controls" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Compact history" }));
  expect(action).toHaveBeenCalledTimes(3);
});

it("keeps one resize observer while its parent re-renders with fresh controls", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
  let observers = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor() {
        observers += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  const controls = () => (
    <ComposerRailExtras>
      <button type="button">Compact history</button>
    </ComposerRailExtras>
  );

  const view = render(controls());

  for (let index = 0; index < 5; index += 1) view.rerender(controls());

  expect(observers).toBe(1);
  expect(screen.getByRole("button", { name: "Compact history" })).toBeTruthy();
});

it("restores collapsed controls once they need less room", () => {
  let requiredWidth = 300;
  const resizeCallbacks = new Set<() => void>();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    () => requiredWidth,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {}
      readonly trigger = () => this.callback([], this);
      observe() {
        resizeCallbacks.add(this.trigger);
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.trigger);
      }
    },
  );
  render(
    <ComposerRailExtras>
      <button type="button">Compact history</button>
    </ComposerRailExtras>,
  );
  expect(
    screen.getByRole("button", { name: "More composer controls" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Compact history" })).toBeNull();
  act(() => {
    requiredWidth = 120;

    for (const callback of [...resizeCallbacks]) callback();
  });
  expect(
    screen.queryByRole("button", { name: "More composer controls" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Compact history" })).toBeTruthy();
});

it("keeps every control inline on a phone instead of an overflow sheet", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <ComposerRailExtras>
        <button type="button">Suggest a reply</button>
      </ComposerRailExtras>
    </CompactViewportOverrideProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "More composer controls" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Suggest a reply" })).toBeTruthy();
});
