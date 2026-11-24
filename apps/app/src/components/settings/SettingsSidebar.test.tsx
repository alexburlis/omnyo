// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  installNativeShellForTest,
  removeNativeShellForTest,
} from "@/test/native-shell-test-utils";
import { SETTINGS_NAV_SECTIONS } from "./settings-sections";
import { SettingsSidebarContent } from "./SettingsSidebar";

const configurablePlugin = {
  icon: null,
  id: "linear",
  label: "Linear",
};

function renderSidebar(activePluginId: string | null = null) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SettingsSidebarContent
          isResizing={false}
          navigation={{
            activePluginId,
            activeSection: activePluginId === null ? "general" : null,
            pluginEntries: [configurablePlugin],
            sections: SETTINGS_NAV_SECTIONS,
          }}
          onResizeMouseDown={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  removeNativeShellForTest();
});

describe("SettingsSidebarContent phone settings", () => {
  it("leads with the phone's servers and settings inside the mobile shell", () => {
    const shell = installNativeShellForTest();
    renderSidebar();

    const label = screen.getByText("This phone");

    const row = screen.getByRole("button", {
      name: "Servers and phone settings",
    });

    const general = screen.getByRole("link", { name: "General" });

    expect(row.dataset.testid).toBe("settings-nav-native-device");
    expect(
      label.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      row.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(row);
    expect(shell.messages()).toContainEqual({
      type: "open-native",
      screen: "device-settings",
    });
  });

  it("has no phone group in a plain browser", () => {
    renderSidebar();
    expect(screen.queryByText("This phone")).toBeNull();
    expect(screen.queryByTestId("settings-nav-native-device")).toBeNull();
  });
});

describe("SettingsSidebarContent plugin navigation", () => {
  it("offers installed-plugin management and configurable plugin settings", () => {
    renderSidebar();
    expect(
      screen
        .getByRole("link", { name: "Installed plugins" })
        .getAttribute("href"),
    ).toBe("/settings/plugins");
    expect(
      screen.getByRole("link", { name: "Linear" }).getAttribute("href"),
    ).toBe("/settings/plugins/linear");
    expect(
      screen.queryByRole("button", { name: /Other installed plugins/ }),
    ).toBeNull();
  });

  it("marks the active plugin settings page", () => {
    renderSidebar("linear");
    expect(
      screen.getByRole("link", { name: "Linear" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});
