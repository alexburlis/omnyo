// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { type PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { InstalledPluginRow } from "./InstalledPluginsTab";
import { makePluginListItem } from "@/test/fixtures/plugins";

function plugin(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return makePluginListItem({
    id: "notify",
    source: "path:/tmp/omnyo-plugin-notify",
    rootDir: "/tmp/omnyo-plugin-notify",
    version: "0.2.1",
    description: "Desktop notifications when a thread needs you.",
    name: "Notify",
    sourceDisplay: "path · /tmp/omnyo-plugin-notify",
    ...overrides,
  });
}

function renderRow(
  item: PluginListItem,
  catalogEntry?: PluginCatalogSearchEntry,
) {
  const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();

  return render(
    <MemoryRouter>
      <QueryClientWrapper>
        <InstalledPluginRow
          plugin={item}
          catalogEntry={catalogEntry}
          onUpdateClick={vi.fn()}
          onOpenPlugin={vi.fn()}
        />
      </QueryClientWrapper>
    </MemoryRouter>,
  );
}

const BB = { name: "bb", github: "get-bb", url: "https://github.com/get-bb" };

const AUTOMATIONS_ENTRY: PluginCatalogSearchEntry = {
  entryId: "automations",
  pluginId: "automations",
  displayName: "Automations",
  description: "Schedule agent work.",
  icon: "Repeat",
  iconUrl: null,
  iconTinted: false,
  screenshots: [],
  collections: [],
  source: "builtin:automations",
  repositoryUrl: "https://github.com/get-bb/bb/tree/HEAD/plugins/automations",
  marketplace: "omnyo-official",
  marketplaceDisplayName: "Omnyo Official",
  publisherKey: "omnyo-official",
  publisherLabel: "Omnyo Official",
  official: true,
  author: BB,
  installed: true,
  installedByDefault: true,
  conflictingInstallSource: null,
  compatible: true,
  incompatibleReason: null,
};

afterEach(() => {
  cleanup();
});

describe("InstalledPluginRow", () => {
  it("shows the status word and detail and marks the switch when a plugin is not running", () => {
    renderRow(
      plugin({
        status: "incompatible",
        statusDetail: "requires Omnyo >=0.38.0 <0.39.0, this is 0.39.0",
      }),
    );

    expect(screen.getByTestId("plugin-runtime-status-notify").textContent).toBe(
      "Incompatible",
    );
    expect(
      screen.getByText("requires Omnyo >=0.38.0 <0.39.0, this is 0.39.0"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("switch", {
          name: "Disable notify (incompatible, not running)",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("does not call a needs-configuration plugin not running", () => {
    renderRow(
      plugin({
        status: "needs-configuration",
        statusDetail: "Set an API token.",
      }),
    );

    expect(screen.getByText("Set an API token.")).toBeTruthy();
    expect(screen.queryByTestId("plugin-not-running-notify")).toBeNull();
  });

  it("credits a bundled plugin's original author, links the author page and badges it Official", () => {
    renderRow(
      plugin({
        id: "automations",
        name: "Automations",
        source: "builtin:automations",
        provenance: "builtin",
        publisherLabel: "Omnyo Official",
        official: true,
        author: BB,
      }),
      AUTOMATIONS_ENTRY,
    );

    expect(
      screen.getByRole("link", { name: "bb" }).getAttribute("href"),
    ).toContain("author=14%3Aomnyo-official%3Agithub%3Aget-bb");
    expect(screen.getByText("Official")).toBeTruthy();
  });

  it("badges a local checkout of a hosted plugin Official and leaves other local plugins unbadged", () => {
    renderRow(plugin({ id: "glance", official: true }));
    expect(screen.getByText("Official")).toBeTruthy();
    cleanup();
    renderRow(plugin());
    expect(screen.queryByText("Official")).toBeNull();
  });
});
