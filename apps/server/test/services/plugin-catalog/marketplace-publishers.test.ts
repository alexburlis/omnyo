import { describe, expect, it } from "vitest";
import {
  marketplacePublisherLabel,
  pluginIsOfficial,
  pluginPublisherLabel,
} from "../../../src/services/plugin-catalog/marketplace-publishers.js";

function publisherLabels(
  marketplaces: Array<{ marketplaceName: string; displayName: string }>,
): Map<string, string> {
  return new Map(
    marketplaces.map((marketplace) => [
      marketplace.marketplaceName,
      marketplacePublisherLabel(marketplace),
    ]),
  );
}

describe("marketplace publisher labels", () => {
  it("names each marketplace by its own display name", () => {
    const labels = publisherLabels([
      { marketplaceName: "acme", displayName: "Acme Plugins" },
    ]);

    expect(
      pluginPublisherLabel({
        sourceKind: "npm",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("Acme Plugins");
  });

  it("refuses the Omnyo Official label to an unrelated marketplace", () => {
    const labels = publisherLabels([
      { marketplaceName: "acme", displayName: "Omnyo Official" },
    ]);

    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("acme");
    expect(
      marketplacePublisherLabel({
        marketplaceName: "omnyo-official",
        displayName: "Omnyo Official",
      }),
    ).toBe("Omnyo Official");
  });

  it("keeps a store-installed bundled plugin on Omnyo Official", () => {
    const labels = publisherLabels([
      { marketplaceName: "acme", displayName: "Acme Plugins" },
    ]);

    expect(
      pluginPublisherLabel({
        sourceKind: "builtin",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("Omnyo Official");
  });

  it("badges bundled plugins Omnyo Official and user installs not at all", () => {
    const labels = publisherLabels([]);

    expect(
      pluginPublisherLabel({
        sourceKind: "builtin",
        provenance: "builtin",
        catalogMarketplaceName: null,
        labels,
      }),
    ).toBe("Omnyo Official");
    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "direct",
        catalogMarketplaceName: null,
        labels,
      }),
    ).toBeNull();
  });
});

describe("official plugins", () => {
  const officialPluginIds = new Set(["glance", "omnyo--git"]);

  it.each([
    ["a bundled plugin", "omnyo--git", "builtin", "builtin", null, true],
    [
      "an Omnyo Official store install",
      "browser-automation",
      "builtin",
      "catalog",
      "omnyo-official",
      true,
    ],
    [
      "a local checkout of a plugin Omnyo publishes",
      "glance",
      "path",
      "direct",
      null,
      true,
    ],
    [
      "a local plugin Omnyo does not publish",
      "my-plugin",
      "path",
      "direct",
      null,
      false,
    ],
    [
      "a third-party marketplace install that reuses an official id",
      "glance",
      "git",
      "catalog",
      "acme",
      false,
    ],
    [
      "a Git install that reuses an official id",
      "glance",
      "git",
      "direct",
      null,
      false,
    ],
  ] as const)(
    "decides %s",
    (
      _label,
      pluginId,
      sourceKind,
      provenance,
      catalogMarketplaceName,
      expected,
    ) => {
      expect(
        pluginIsOfficial({
          pluginId,
          sourceKind,
          provenance,
          catalogMarketplaceName,
          officialPluginIds,
        }),
      ).toBe(expected);
    },
  );
});
