import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  filterMarketplaceItems,
  marketplaceHref,
  validateMarketplaceSearch,
} from "./marketplace";
import { marketplaceItems } from "./marketplace.server";
import {
  catalogWallRows,
  facetCounts,
  highlightParts,
  marketplaceItemKey,
} from "./marketplace-view";
import { MarketplaceIndex } from "./MarketplaceIndex";

const rows = (html: string) => html.match(/class="mk-row"/gu)?.length ?? 0;

describe("Marketplace storefront", () => {
  it("keeps source and license filters in the URL contract", () => {
    const search = validateMarketplaceSearch({
      source: "omnyo",
      license: "MIT",
      category: "Design & UI",
    });

    expect(marketplaceHref(search)).toBe(
      "/explore?category=Design+%26+UI&source=omnyo&license=MIT",
    );
    expect(
      validateMarketplaceSearch({ source: "npm", license: "<x>" }),
    ).toEqual({});
    expect(
      filterMarketplaceItems(marketplaceItems, { source: "omnyo" }),
    ).toHaveLength(17);
    expect(
      filterMarketplaceItems(marketplaceItems, {
        source: "github",
        type: "workflow",
      }),
    ).toHaveLength(0);
  });

  it("counts each facet against the other active filters only", () => {
    const search = { category: "Design & UI" as const, type: "skill" as const };

    const categories = facetCounts(
      marketplaceItems,
      search,
      "category",
      ["Design & UI", "Cloud & DevOps"],
      (item) => item.category,
    );

    expect(categories[1]?.[1]).toBe(
      filterMarketplaceItems(marketplaceItems, {
        type: "skill",
        category: "Cloud & DevOps",
      }).length,
    );

    const types = facetCounts(
      marketplaceItems,
      search,
      "type",
      ["skill", "workflow"],
      (item) => item.kind,
    );

    expect(types[1]?.[1]).toBe(0);
  });

  it("builds three distinct, stable wall rows led by the featured listings", () => {
    const first = catalogWallRows(marketplaceItems, 26);

    const second = catalogWallRows(
      [
        ...marketplaceItems.filter(({ kind }) => kind !== "skill"),
        ...marketplaceItems.filter(({ kind }) => kind === "skill").reverse(),
      ],
      26,
    );

    expect(first.map((row) => row.map(marketplaceItemKey))).toEqual(
      second.map((row) => row.map(marketplaceItemKey)),
    );
    expect(first.map((row) => row[2]?.kind)).toEqual([
      "workflow",
      "connector",
      "connector",
    ]);

    const keys = first.flat().map(marketplaceItemKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(first.every((row) => row.length === 26)).toBe(true);
  });

  it("marks every query term in a title", () => {
    expect(highlightParts("PostgreSQL Code Review", "code review")).toEqual([
      { text: "PostgreSQL ", match: false },
      { text: "Code", match: true },
      { text: " ", match: false },
      { text: "Review", match: true },
    ]);
  });

  it("server-renders working search, filters and pages without JavaScript", () => {
    const full = renderToStaticMarkup(
      <MarketplaceIndex items={marketplaceItems} search={{}} />,
    );

    expect(full).toContain('action="/explore"');
    expect(rows(full)).toBe(24);
    expect(full).toContain(`href="${marketplaceHref({ page: 2 })}"`);
    expect(full).toContain(`Show 24 more of ${marketplaceItems.length - 24}`);
    expect(full).toContain('href="/explore?source=omnyo"');
    expect(full).not.toMatch(/Most installed|active this week/u);
    expect(full).toMatch(/<span class="mk-glyph" aria-hidden="true"><svg/u);

    const filtered = renderToStaticMarkup(
      <MarketplaceIndex
        items={marketplaceItems}
        search={validateMarketplaceSearch({
          category: "Design & UI",
          q: "review",
        })}
      />,
    );

    expect(rows(filtered)).toBe(
      filterMarketplaceItems(marketplaceItems, {
        category: "Design & UI",
        q: "review",
      }).length,
    );
    expect(filtered).toContain('name="category" value="Design &amp; UI"');
    expect(filtered).toContain("<mark>Review</mark>");

    const second = renderToStaticMarkup(
      <MarketplaceIndex
        items={marketplaceItems}
        search={validateMarketplaceSearch({ page: "2" })}
      />,
    );

    expect(rows(second)).toBe(24);
    expect(second).toContain(`href="${marketplaceHref({})}"`);
  });
});
