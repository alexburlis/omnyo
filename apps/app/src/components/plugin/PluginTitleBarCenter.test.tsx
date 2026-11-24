// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { PluginTitleBarCenter } from "./PluginTitleBarCenter";

function island(label: string) {
  return function Island() {
    return <span>{label}</span>;
  };
}

function renderCenter() {
  return render(
    <MemoryRouter>
      <PluginTitleBarCenter className="justify-self-center" />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
});

describe("PluginTitleBarCenter", () => {
  it("mounts every registration in plugin load order inside its plugin root", () => {
    setPluginSlotRegistrations(
      "beta",
      registrationSet({
        titleBarCenters: [
          { id: "first", component: island("beta first") },
          { id: "second", component: island("beta second") },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "alpha",
      registrationSet({
        titleBarCenters: [{ id: "live", component: island("alpha live") }],
      }),
    );

    const { container } = renderCenter();

    const center = container.querySelector<HTMLElement>(
      "[data-omnyo-plugin-title-bar-center]",
    );

    expect(center?.textContent).toBe("alpha livebeta firstbeta second");
    expect(center?.className).toContain("justify-self-center");
    expect(center?.className).toContain("[-webkit-app-region:no-drag]");
    expect(
      screen
        .getByText("alpha live")
        .closest("[data-omnyo-plugin]")
        ?.getAttribute("data-omnyo-plugin"),
    ).toBe("alpha");
    expect(
      screen
        .getByText("beta second")
        .closest("[data-omnyo-plugin]")
        ?.getAttribute("data-omnyo-plugin"),
    ).toBe("beta");
  });

  it("hides only the registration that crashes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    function Crashes(): never {
      throw new Error("island crashed");
    }

    setPluginSlotRegistrations(
      "broken",
      registrationSet({
        titleBarCenters: [
          { id: "crashes", component: Crashes },
          { id: "steady", component: island("steady island") },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "fine",
      registrationSet({
        titleBarCenters: [{ id: "fine", component: island("fine island") }],
      }),
    );

    renderCenter();

    expect(screen.getByText("steady island")).toBeDefined();
    expect(screen.getByText("fine island")).toBeDefined();
    expect(screen.queryByText("plugin broken crashed")).toBeNull();
  });

  it("renders nothing when no plugin registers center content", () => {
    setPluginSlotRegistrations(
      "status",
      registrationSet({
        sidebarFooterCards: [{ id: "card", component: island("card") }],
      }),
    );

    const { container } = renderCenter();

    expect(container.innerHTML).toBe("");
  });
});
