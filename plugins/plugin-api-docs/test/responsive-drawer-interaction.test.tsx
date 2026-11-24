// @vitest-environment jsdom
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import anatomy from "../src/anatomy-manifest.json";
import {
  ResponsiveDrawerWireframe,
  SurfaceMapContext,
} from "../src/wireframes";

const frames = new Map<number, FrameRequestCallback>();

let frameId = 0;

beforeEach(() => {
  const runtime: unknown = Reflect.get(globalThis, "__omnyoPluginRuntime");

  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !("pluginSdkApp" in runtime)
  )
    throw new Error("The Guide SDK runtime is not installed");
  const app = runtime.pluginSdkApp;

  if (typeof app !== "object" || app === null)
    throw new Error("The Guide SDK app runtime is not installed");

  vi.stubGlobal("__omnyoPluginRuntime", {
    ...runtime,
    react: React,
    pluginSdkApp: {
      ...app,
      experimental_ResponsiveDrawerShell: ResponsiveDrawerShell,
    },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);

    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  cleanup();
  frames.clear();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "opens the Guide drawer through the SDK and retains its draft (mobile=%s)",
  (mobile) => {
    const select = vi.fn();
    const app = document.createElement("main");
    document.body.append(app);
    const contract = anatomy.surfaceFixtures["responsive-drawer"];

    try {
      render(
        <SurfaceMapContext.Provider
          value={{
            activeId: null,
            setActiveId: () => {},
            numberOf: () => 1,
            onSelect: select,
          }}
        >
          <ResponsiveDrawerWireframe mobile={mobile} />
        </SurfaceMapContext.Provider>,
        { container: app },
      );

      for (const label of contract.labels.anchor)
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
      fireEvent.click(
        screen.getByRole("link", { name: /shared compact drawer/ }),
      );
      expect(select.mock.calls).toEqual([["responsive-drawer"]]);
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
      const dialog = screen.getByRole("dialog", { name: "Plugin drawer" });
      expect(screen.queryByRole("textbox", { name: "Draft note" })).toBeNull();

      for (let frame = 0; frame < 2; frame++)
        act(() => {
          const pending = [...frames.values()];
          frames.clear();

          for (const callback of pending) callback(0);
        });

      const input = screen.getByRole<HTMLInputElement>("textbox", {
        name: "Draft note",
      });

      expect(
        document.getElementById(dialog.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBe("Your draft stays here when you close this drawer.");
      expect(screen.getByRole("button", { name: "Close drawer" })).toBeTruthy();
      expect(app.hasAttribute("inert")).toBe(false);
      expect(app.hasAttribute("aria-hidden")).toBe(false);
      fireEvent.change(input, { target: { value: "Finish the review" } });
      fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));

      for (const label of contract.labels.outcome)
        expect(screen.getByRole("status").textContent).toBe(label);
      expect(input.isConnected).toBe(true);
      expect(
        input
          .closest("[data-persistent-drawer-content]")
          ?.hasAttribute("inert"),
      ).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Reopen drawer" }));
      expect(screen.getByRole("textbox", { name: "Draft note" })).toBe(input);
      expect(input.value).toBe("Finish the review");
      expect(select.mock.calls).toEqual([["responsive-drawer"]]);
    } finally {
      cleanup();
      app.remove();
    }
  },
);
