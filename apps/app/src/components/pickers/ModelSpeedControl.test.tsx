// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ServiceTier } from "@omnyo/domain";
import { ModelSpeedControl, type ModelSpeed } from "./ModelSpeedControl";

afterEach(cleanup);

const fast = { id: "fast", label: "Fast" };

const ultrafast = { id: "ultrafast", label: "Ultrafast" };

function speed(overrides: Partial<ModelSpeed>): ModelSpeed {
  return {
    options: [fast],
    value: "default",
    onChange: vi.fn(),
    ...overrides,
  };
}

function renderSpeed(
  overrides: Partial<ModelSpeed>,
  onChange: (value: ServiceTier) => void = vi.fn(),
) {
  return render(
    <ModelSpeedControl
      speed={speed({ ...overrides, onChange })}
      className=""
    />,
  );
}

it("toggles the primary tier from one button without a menu", () => {
  const onChange = vi.fn();
  const view = renderSpeed({ value: "default" }, onChange);

  const button = screen.getByRole("button", {
    name: "Fast mode, faster responses",
  });

  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  expect(onChange).toHaveBeenLastCalledWith("fast");

  view.rerender(
    <ModelSpeedControl
      speed={speed({ value: "fast", onChange })}
      className=""
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Fast mode, faster responses" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(
    screen.getByRole("button", { name: "Fast mode, faster responses" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("default");
});

it("names the active tier and returns to default from any tier", () => {
  const onChange = vi.fn();
  renderSpeed({ options: [fast, ultrafast], value: "ultrafast" }, onChange);

  const button = screen.getByRole("button", {
    name: "Ultrafast mode, faster responses",
  });

  expect(button.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(button);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("default");
});

it("offers Fast first and otherwise the first tier the model has", () => {
  const onChange = vi.fn();
  const view = renderSpeed({ options: [ultrafast, fast] }, onChange);

  fireEvent.click(
    screen.getByRole("button", { name: "Fast mode, faster responses" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("fast");

  view.rerender(
    <ModelSpeedControl
      speed={speed({ options: [ultrafast], onChange })}
      className=""
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Ultrafast mode, faster responses" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("ultrafast");
});

it.each(["default", "ultrafast"])(
  "shows two bolts for the Ultrafast-only toggle when the saved tier is %s",
  (value) => {
    renderSpeed({ options: [ultrafast], value });

    const button = screen.getByRole("button", {
      name: "Ultrafast mode, faster responses",
      pressed: value === "ultrafast",
    });

    expect(button.querySelectorAll("svg")).toHaveLength(2);
  },
);

it("renders nothing when the model has no faster tier", () => {
  renderSpeed({ options: [], value: "fast" });

  expect(screen.queryByRole("button")).toBeNull();
});

it("steps from Fast to Ultrafast before returning to the default tier", () => {
  const onChange = vi.fn();
  const view = renderSpeed({ options: [fast, ultrafast] }, onChange);

  fireEvent.click(
    screen.getByRole("button", { name: "Fast mode, faster responses" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("fast");

  view.rerender(
    <ModelSpeedControl
      speed={speed({ options: [fast, ultrafast], value: "fast", onChange })}
      className=""
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Fast mode, faster responses" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("ultrafast");

  view.rerender(
    <ModelSpeedControl
      speed={speed({
        options: [fast, ultrafast],
        value: "ultrafast",
        onChange,
      })}
      className=""
    />,
  );
  expect(
    document
      .querySelector("[data-speed-tier]")
      ?.getAttribute("data-speed-tier"),
  ).toBe("ultrafast");
  fireEvent.click(
    screen.getByRole("button", { name: "Ultrafast mode, faster responses" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("default");
});

it("describes what the faster tier does, preferring the provider's own words", () => {
  const view = renderSpeed({ options: [fast], value: "default" });

  expect(
    screen
      .getByRole("button", { name: "Fast mode, faster responses" })
      .getAttribute("aria-description"),
  ).toContain("faster service tier");

  view.rerender(
    <ModelSpeedControl
      speed={speed({
        options: [{ ...fast, description: "1.5x speed" }],
        value: "default",
      })}
      className=""
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Fast mode, faster responses" })
      .getAttribute("aria-description"),
  ).toBe("1.5x speed");
});
