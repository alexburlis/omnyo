// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  FavoriteAvailability,
  ModelFavoriteChipItem,
} from "./model-favorites";
import { allModelsLabel, ModelFavoritesBar } from "./ModelFavoritesBar";
import type { ModelSpeed } from "./ModelSpeedControl";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function item(
  providerId: string,
  model: string,
  modelLabel: string,
  reasoningLevel: string,
  reasoningLabel: string,
  {
    current = false,
    availability = { state: "ready" },
  }: { current?: boolean; availability?: FavoriteAvailability } = {},
): ModelFavoriteChipItem {
  const favorite = {
    providerId,
    model,
    reasoningLevel,
    serviceTier: "default",
  };

  return {
    key: `${providerId}\0${model}\0${reasoningLevel}\0default`,
    favorite,
    selection: favorite,
    description: {
      modelLabel,
      reasoningLabel,
      serviceTierLabel: null,
      label: `${modelLabel} · ${reasoningLabel}`,
    },
    icon: undefined,
    availability,
    current,
    startsNewChat: false,
  };
}

function barProps(
  presentation: ComponentProps<typeof ModelFavoritesBar>["presentation"],
  onOpenModels = vi.fn(),
  onPick = vi.fn(),
  items: readonly ModelFavoriteChipItem[] = [],
  speed: ModelSpeed | null = null,
): ComponentProps<typeof ModelFavoritesBar> {
  return {
    preference: {
      status: "ready",
      items,
      isFull: false,
      isFavorite: () => false,
      toggle: vi.fn(),
      remove: vi.fn(),
    },
    current: {
      selection: {
        providerId: "claude-code",
        model: "claude-opus-5-5",
        reasoningLevel: "medium",
        serviceTier: "default",
      },
      description: {
        modelLabel: "Opus 5.5",
        reasoningLabel: "Medium",
        serviceTierLabel: null,
        label: "Opus 5.5, Medium",
      },
      icon: undefined,
      efforts: [{ value: "medium", label: "Medium" }],
      landOn: () => ({ state: "pending" }),
    },
    providerOrder: ["codex", "claude-code"],
    presentation,
    selects: "model-and-effort",
    speed,
    allModels: (hidden: number) => (
      <button type="button">{allModelsLabel(hidden)}</button>
    ),
    pill: <button type="button">Model</button>,
    onPick,
    onKeep: vi.fn(),
    onOpenModels,
  };
}

function segmentName(button: HTMLElement): string {
  const label = button.getAttribute("aria-label");

  if (label !== null) return label;
  const visible = button.cloneNode(true) as HTMLElement;
  visible.querySelectorAll("[aria-hidden]").forEach((node) => node.remove());

  return visible.textContent ?? "";
}

function segments(element: HTMLElement): string[] {
  return within(element)
    .getAllByRole("button")
    .map(
      (button) =>
        `${segmentName(button)}${button.getAttribute("aria-pressed") === "true" ? "*" : ""}`,
    );
}

const FAVORITES = [
  item("claude-code", "claude-opus-5-5", "Opus 5.5", "medium", "Medium", {
    current: true,
  }),
  item("claude-code", "claude-opus-5-5", "Opus 5.5", "high", "High"),
  item("codex", "gpt-6.1-sol", "6.1-Sol", "max", "Max"),
  item("codex", "gpt-6.1-sol", "6.1-Sol", "low", "Low"),
  item("codex", "gpt-6-astra", "6-Astra", "high", "High", {
    availability: { state: "unavailable", reason: "Not on this machine" },
  }),
];

const FAST: ModelSpeed = {
  options: [{ id: "fast", label: "Fast" }],
  value: "fast",
  onChange: vi.fn(),
};

it.each(["footer", "bar"] as const)(
  "%s: opens the picker from the model name without changing the effort",
  (presentation) => {
    const onOpenModels = vi.fn();
    const onPick = vi.fn();
    render(
      <ModelFavoritesBar {...barProps(presentation, onOpenModels, onPick)} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Change model (Opus 5.5)" }),
    );

    expect(onOpenModels).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Medium" }));

    expect(onOpenModels).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledExactlyOnceWith({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "medium",
      serviceTier: "default",
    });
  },
);

it("expands the current model and collapses every other favorite into one chip", () => {
  const onPick = vi.fn();
  render(
    <ModelFavoritesBar
      {...barProps("footer", vi.fn(), onPick, FAVORITES, FAST)}
    />,
  );

  const track = screen.getByRole("group", { name: "Model and effort" });

  expect(segments(track)).toEqual([
    "Switch to 6.1-Sol, Low",
    "Switch to 6-Astra",
    "Change model (Opus 5.5)",
    "Medium*",
    "High",
    "Fast mode, faster responses*",
    "All models",
  ]);

  fireEvent.click(
    within(track).getByRole("button", { name: "Switch to 6.1-Sol, Low" }),
  );

  expect(onPick).toHaveBeenCalledExactlyOnceWith({
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "low",
    serviceTier: "default",
  });
});

it("keeps a chip with no ready pick from applying and names the first pick's reason", () => {
  const onPick = vi.fn();
  render(
    <ModelFavoritesBar {...barProps("footer", vi.fn(), onPick, FAVORITES)} />,
  );

  const astra = screen.getByRole("button", { name: "Switch to 6-Astra" });

  expect(astra.getAttribute("aria-disabled")).toBe("true");
  expect(
    document.getElementById(astra.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toBe("Not on this machine");
  fireEvent.click(astra);
  expect(onPick).not.toHaveBeenCalled();
});

it("fits the bar from resize observations without measuring each render", () => {
  const observed = new Set<Element>();
  const notifications: (() => void)[] = [];

  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        notifications.push(() =>
          callback([], this as unknown as ResizeObserver),
        );
      }

      observe(element: Element) {
        observed.add(element);
      }

      unobserve(element: Element) {
        observed.delete(element);
      }

      disconnect() {
        observed.clear();
      }
    },
  );

  const rects = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const left = this.hasAttribute("data-favorite-track-end") ? 80 : 0;

      const width =
        this.getAttribute("role") === "group"
          ? 100
          : this.hasAttribute("data-favorite-track-overflow")
            ? 20
            : 50;

      return { left, width } as DOMRect;
    });

  const props = barProps("bar", vi.fn(), vi.fn(), [], FAST);
  const view = render(<ModelFavoritesBar {...props} />);

  view.rerender(<ModelFavoritesBar {...props} />);

  expect(rects).not.toHaveBeenCalled();
  expect(
    [...observed].some((element) =>
      element.hasAttribute("data-favorite-group"),
    ),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Change model (Opus 5.5)" }),
  ).toBeTruthy();

  act(() => {
    for (const notify of notifications) notify();
  });

  expect(rects).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Change model (Opus 5.5)" }),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Fast mode, faster responses" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
