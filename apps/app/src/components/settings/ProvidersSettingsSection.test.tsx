// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemProviderCatalogEntry } from "@omnyo/server-contract";
import type { ProviderInfo } from "@omnyo/domain";
import { defaultAppSettings } from "@omnyo/domain";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import {
  ProvidersSettingsSection,
  reorderProviderIds,
} from "./ProvidersSettingsSection";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderInfo[],
  catalog: [] as SystemProviderCatalogEntry[],
  setEnabled: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: mocks.providers, isPending: false }),
  useSystemProviderCatalog: () => ({ data: mocks.catalog, isPending: false }),
  useSystemExecutionOptions: () => ({
    data: { models: [], selectedOnlyModels: [] },
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/mutations/provider-mutations", () => ({
  useSetProviderEnabled: () => ({ mutate: mocks.setEnabled, isPending: false }),
}));

vi.mock("./ModelPickerSettings", () => ({
  ModelPickerSettings: () => null,
}));

function render(ui: ReactElement) {
  return renderView(<MemoryRouter>{ui}</MemoryRouter>);
}

function openActions(name: string) {
  fireEvent.keyDown(
    screen.getByRole("button", { name: `Actions for ${name}` }),
    { key: "Enter" },
  );
}

function provider(id: string, displayName: string): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsFork: false,
      supportsSessionRewind: false,
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
    },
  });
}

afterEach(() => {
  cleanup();
  mocks.catalog = [];
  mocks.setEnabled.mockClear();
});

describe("ProvidersSettingsSection", () => {
  it("saves faster tiers independently for capable providers", () => {
    mocks.providers = [
      provider("codex", "Codex"),
      provider("claude-code", "Claude Code"),
      provider("other", "Other"),
    ];

    for (const entry of mocks.providers.slice(0, 2))
      entry.capabilities.supportsServiceTier = true;
    const onChange = vi.fn();
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={{
          ...defaultAppSettings,
          allowFastServiceTier: false,
          providerAllowFastServiceTier: { codex: true },
        }}
        onGeneralSettingsChange={onChange}
      />,
    );

    const codex = screen.getByRole("switch", {
      name: "Allow faster Codex service tiers",
    });

    const claude = screen.getByRole("switch", {
      name: "Allow faster Claude Code service tiers",
    });

    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(claude.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.queryByRole("switch", {
        name: "Allow faster Other service tiers",
      }),
    ).toBeNull();
    fireEvent.click(claude);
    expect(onChange).toHaveBeenCalledWith({
      providerAllowFastServiceTier: { codex: true, "claude-code": true },
    });
  });

  it("shows reorder handles and writes the default as a user setting", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      provider("beta", "Beta"),
      provider("gamma", "Gamma"),
    ];
    const onChange = vi.fn();
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={onChange}
      />,
    );

    const providersSection = screen
      .getByRole("heading", { name: "Providers" })
      .closest("section");

    if (providersSection === null) throw new Error("Providers section missing");
    const rows = within(providersSection).getAllByText(/Alpha|Beta|Gamma/);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(screen.getAllByText("Default")).toHaveLength(1);

    const reorderHandles = screen.getAllByRole("button", {
      name: /Reorder (Alpha|Beta|Gamma)/,
    });

    expect(reorderHandles).toHaveLength(3);
    expect(reorderHandles[0]?.parentElement?.className).toContain(
      "group/provider-row",
    );

    openActions("Alpha");
    expect(
      screen
        .getByRole("menuitem", { name: "Make default" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    openActions("Gamma");
    fireEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
    expect(onChange).toHaveBeenLastCalledWith({
      defaultProviderId: "gamma",
    });
  });

  it("says why a provider is unavailable, links its plugin and blocks it as the default", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      {
        ...provider("beta", "Beta"),
        pluginId: "beta-plugin",
        available: false,
      },
    ];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={{ ...defaultAppSettings, defaultProviderId: "alpha" }}
        onGeneralSettingsChange={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "Plugin didn't load" })
        .getAttribute("href"),
    ).toBe("/settings/plugins/beta-plugin");
    openActions("Beta");
    expect(
      screen
        .getByRole("menuitem", { name: "Make default" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("shows each provider's finished turn display and stores only overrides", () => {
    mocks.providers = [
      {
        ...provider("claude-code", "Claude Code"),
        completedTurnDisplay: "flat",
      },
      provider("codex", "Codex"),
    ];
    const onChange = vi.fn();

    const generalSettings = {
      ...defaultAppSettings,
      providerCompletedTurnDisplay: { codex: "flat" as const },
    };

    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={generalSettings}
        onGeneralSettingsChange={onChange}
      />,
    );

    const claudeSwitch = screen.getByRole("switch", {
      name: "Collapse finished Claude Code turns",
    });

    const codexSwitch = screen.getByRole("switch", {
      name: "Collapse finished Codex turns",
    });

    const collapse = screen
      .getByRole("heading", { name: "Collapse finished turns" })
      .closest("section");

    if (collapse === null) throw new Error("Collapse section missing");
    expect(
      within(collapse).getByRole("switch", {
        name: "Collapse finished Codex turns",
      }),
    ).toBe(codexSwitch);
    expect(screen.queryByRole("heading", { name: "Fast mode" })).toBeNull();
    expect(claudeSwitch.getAttribute("aria-checked")).toBe("false");
    expect(codexSwitch.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(claudeSwitch);
    expect(onChange).toHaveBeenLastCalledWith({
      providerCompletedTurnDisplay: {
        codex: "flat",
        "claude-code": "collapse",
      },
    });

    fireEvent.click(codexSwitch);
    expect(onChange).toHaveBeenLastCalledWith({
      providerCompletedTurnDisplay: {},
    });
  });

  it("keeps a provider with a disabled plugin visible and enables it without navigating away", () => {
    mocks.providers = [provider("codex", "Codex")];
    mocks.catalog = [
      {
        id: "claude-code",
        displayName: "Claude Code",
        pluginId: "provider-claude-code",
        pluginName: "Claude Code provider",
        pluginEnabled: false,
        enabled: true,
        available: false,
        logoUrl: "/claude.svg",
        info: null,
      },
    ];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={vi.fn()}
      />,
    );

    const section = screen
      .getByRole("heading", { name: "Providers" })
      .closest("section")!;

    expect(
      within(section)
        .getAllByText(/^(Codex|Claude Code)$/)
        .map((row) => row.textContent),
    ).toEqual(["Codex", "Claude Code"]);
    expect(
      screen.queryByRole("button", { name: "Reorder Claude Code" }),
    ).toBeNull();
    expect(
      section.querySelector('[data-provider-logo="/claude.svg"]'),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Actions for Claude Code" }),
    ).toBeNull();

    const disabledGroup = screen.getByRole("group", {
      name: "Disabled providers",
    });

    fireEvent.click(
      within(disabledGroup).getByRole("button", { name: "Enable Claude Code" }),
    );
    expect(mocks.setEnabled).toHaveBeenCalledWith({
      providerId: "claude-code",
      enabled: true,
    });
    openActions("Codex");
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable" }));
    expect(mocks.setEnabled).toHaveBeenCalledWith({
      providerId: "codex",
      enabled: false,
    });
  });

  it("builds the complete picker order after a drag", () => {
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "alpha"),
    ).toEqual(["gamma", "alpha", "beta"]);
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "gamma"),
    ).toBeNull();
  });
});
