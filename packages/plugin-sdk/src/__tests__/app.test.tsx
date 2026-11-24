// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  experimental_ProjectIcon as ProjectIcon,
  experimental_ResponsiveDrawerShell as ResponsiveDrawerShell,
} from "../app.js";
import { installTestPluginRuntime } from "../testing/app.js";

interface RuntimeHost {
  __omnyoPluginRuntime?: unknown;
}

const host = globalThis as RuntimeHost;

const original = host.__omnyoPluginRuntime;

afterEach(() => {
  cleanup();
  host.__omnyoPluginRuntime = original;
});

describe("experimental_ResponsiveDrawerShell", () => {
  it("passes content, labels, and controlled dismissal through the runtime", () => {
    installTestPluginRuntime();
    const onOpenChange = vi.fn();

    const onEscapeKeyDown = vi
      .fn<(event: KeyboardEvent) => void>()
      .mockImplementationOnce((event) => event.preventDefault());

    render(
      <ResponsiveDrawerShell
        open
        srLabel="Draft"
        onOpenChange={onOpenChange}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        <input aria-label="Prompt" />
      </ResponsiveDrawerShell>,
    );

    const drawer = screen.getByRole("dialog", { name: "Draft" });
    const input = screen.getByRole("textbox", { name: "Prompt" });
    expect(drawer.contains(input)).toBe(true);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("experimental_ProjectIcon", () => {
  it("forwards the project id and sizing to the host's project icon", () => {
    installTestPluginRuntime();

    const { container } = render(
      <ProjectIcon projectId="proj_web" className="mark" />,
    );

    const mark = container.querySelector('[data-project-icon="proj_web"]');

    expect(mark?.getAttribute("class")).toBe("mark");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });

  it("fails visibly outside an Omnyo plugin runtime", () => {
    host.__omnyoPluginRuntime = undefined;

    expect(() => render(<ProjectIcon projectId="proj_web" />)).toThrow(
      /experimental_ProjectIcon needs React on the Omnyo plugin runtime/u,
    );
  });
});
