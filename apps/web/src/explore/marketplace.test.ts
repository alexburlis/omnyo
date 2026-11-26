import { describe, expect, it } from "vitest";

import { workflowCatalog } from "../workflow-catalog/entries.server";
import {
  filterMarketplaceItems,
  marketplaceHref,
  marketplacePage,
  validateMarketplaceSearch,
} from "./marketplace";
import { marketplaceItems, marketplaceResponse } from "./marketplace.server";
import { publicSkills } from "./public-skill-catalog.server";

describe("Marketplace catalog", () => {
  it("projects the existing source skills and published workflows with both connectors", async () => {
    const response = marketplaceResponse(true);
    const body: unknown = await response.json();

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(body).toEqual({ schemaVersion: 1, items: marketplaceItems });
    expect(marketplaceItems.filter(({ kind }) => kind === "skill")).toEqual(
      publicSkills.map((skill) => ({ ...skill, kind: "skill" })),
    );
    expect(publicSkills).toHaveLength(519);
    expect(
      marketplaceItems.flatMap((item) =>
        item.kind === "workflow"
          ? [
              {
                slug: item.slug,
                sha256: item.sha256,
              },
            ]
          : [],
      ),
    ).toEqual(
      workflowCatalog.listings.map(({ slug }) => ({
        slug,
        sha256: workflowCatalog.detail(slug)?.release.sha256,
      })),
    );
    expect(
      marketplaceItems.flatMap((item) =>
        item.kind === "connector" ? [item.detailPath] : [],
      ),
    ).toEqual(["/explore/plugins/workspace-github", "/explore/plugins/sentry"]);
  });

  it("lists Poteto Mode with provider setup for clients that support it", async () => {
    const potetoMode = marketplaceItems.find(
      ({ slug }) => slug === "poteto-mode",
    );

    expect(potetoMode).toMatchObject({
      kind: "skill",
      license: "MIT",
      setupUrl: expect.stringMatching(
        /^https:\/\/github\.com\/cursor\/plugins\/blob\/.+\/pstack\/README\.md#install$/u,
      ),
    });
    await expect(marketplaceResponse().json()).resolves.toMatchObject({
      items: expect.not.arrayContaining([
        expect.objectContaining({ slug: "poteto-mode" }),
      ]),
    });
  });

  it("finds more than one kind and preserves filters in page links", () => {
    const matches = filterMarketplaceItems(marketplaceItems, {
      q: "  ReVIEW ",
    });

    expect(new Set(matches.map(({ kind }) => kind))).toEqual(
      new Set(["workflow", "connector", "skill"]),
    );

    const search = validateMarketplaceSearch({
      type: "skill",
      category: "Coding & architecture",
      page: "2",
    });

    const result = marketplacePage(marketplaceItems, search);

    expect(result.page).toBe(2);
    expect(result.items).toHaveLength(24);
    expect(
      result.items.every(
        (item) => item.kind === "skill" && item.category === search.category,
      ),
    ).toBe(true);
    expect(marketplaceHref(search)).toBe(
      "/explore?type=skill&category=Coding+%26+architecture&page=2",
    );
    expect(
      filterMarketplaceItems(marketplaceItems, {
        type: "connector",
        publisher: "Omnyo",
      }),
    ).toHaveLength(2);
  });
});
