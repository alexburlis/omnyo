import { describe, expect, it } from "vitest";

import {
  filterExploreItems as sdkFilter,
  filterExploreMarketplace,
  parseExploreMarketplace,
  readExploreMarketplace,
  normalizeExploreQuery as sdkNormalize,
  parseExploreCatalog,
  readExploreCatalog,
  readExplorePromptText,
} from "../../../../packages/sdk/src/explore";
import {
  exploreKey,
  filterExploreItems,
  normalizeExploreQuery,
} from "./catalog";
import { createExploreCatalog } from "./catalog.server";
import { exploreOwners } from "./entries.server";
import { filterMarketplaceItems } from "./marketplace";
import { marketplaceItems, marketplaceResponse } from "./marketplace.server";
import { exploreRecords } from "./records.server";

const catalog = createExploreCatalog({
  activation: "active",
  records: exploreRecords,
  owners: exploreOwners,
});

const ORIGIN = "https://omnyohq.com";

function candidateFetch(requests: { url: string; init?: RequestInit }[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    requests.push({ url: url.href, init });

    if (url.origin !== ORIGIN)
      throw new Error(`Unexpected origin ${url.origin}`);

    if (url.pathname === "/explore/marketplace.json")
      return marketplaceResponse(
        url.searchParams.get("provider-setup") === "1",
      );

    if (url.pathname === "/explore/catalog.json")
      return catalog.catalogResponse(
        url.searchParams.get("version") === "2" ? 2 : 1,
      );

    const text = /^\/explore\/prompts\/([^/]+)\/text$/u.exec(url.pathname);

    return text?.[1]
      ? catalog.promptTextResponse(text[1])
      : new Response(null, { status: 404 });
  };
}

describe("web emitter and SDK reader", () => {
  it("reads the complete Marketplace with website and SDK filter parity", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const json: unknown = await marketplaceResponse(true).json();

    expect(parseExploreMarketplace(json)).toEqual({
      schemaVersion: 1,
      items: marketplaceItems,
    });

    const { items } = await readExploreMarketplace({
      fetch: candidateFetch(requests),
    });

    expect(items).toEqual(marketplaceItems);
    expect(requests.map(({ url }) => url)).toEqual([
      `${ORIGIN}/explore/marketplace.json?provider-setup=1`,
    ]);
    expect(requests[0]?.init?.credentials).toBe("omit");
    expect(requests[0]?.init?.redirect).toBe("error");

    for (const query of [
      "",
      "  ReVIEW  ",
      "code review",
      "documentation writer",
    ]) {
      for (const kind of [
        undefined,
        "skill",
        "workflow",
        "connector",
      ] as const) {
        expect(filterExploreMarketplace(items, { kind, query })).toEqual(
          filterMarketplaceItems(marketplaceItems, { type: kind, q: query }),
        );
      }
    }
  });

  it("parses the published projection without loss", async () => {
    const json: unknown = await catalog.catalogResponse(2).json();

    expect(parseExploreCatalog(json)).toEqual({
      schemaVersion: 2,
      items: catalog.items,
    });
  });

  it("keeps the original catalog readable with all four established kinds", async () => {
    const json: unknown = await catalog.catalogResponse().json();

    expect(parseExploreCatalog(json)).toEqual({
      schemaVersion: 1,
      items: catalog.items.filter(({ kind }) => kind !== "skill"),
    });
  });

  it.each([
    {
      kind: undefined,
      query: "  \t ",
      normalized: "",
      keys: [
        "workflow/weekly-content-feed",
        "prompt/review-a-product-update",
        "skill/product-update-review",
        "skill/customer-lab",
        "plugin/browser-automation",
        "guide/run-an-agent-on-a-schedule",
      ],
    },
    {
      kind: undefined,
      query: "  RELEASE \n notes ",
      normalized: "release notes",
      keys: ["prompt/review-a-product-update", "skill/product-update-review"],
    },
    {
      kind: "skill",
      query: "",
      normalized: "",
      keys: ["skill/product-update-review", "skill/customer-lab"],
    },
    {
      kind: "guide",
      query: "schedule agent",
      normalized: "schedule agent",
      keys: ["guide/run-an-agent-on-a-schedule"],
    },
    {
      kind: "guide",
      query: "browser",
      normalized: "browser",
      keys: [],
    },
    {
      kind: "plugin",
      query: `${"BROWSER ".repeat(10)}unmatched`,
      normalized: "browser ".repeat(10).trim(),
      keys: ["plugin/browser-automation"],
    },
  ] as const)(
    "filters $kind with query $query",
    ({ kind, query, normalized, keys }) => {
      expect(normalizeExploreQuery(query)).toBe(normalized);
      expect(sdkNormalize(query)).toBe(normalized);
      expect(
        filterExploreItems(catalog.items, { kind, query }).map(exploreKey),
      ).toEqual(keys);
      expect(sdkFilter(catalog.items, { kind, query }).map(exploreKey)).toEqual(
        keys,
      );
    },
  );

  it("reads the catalog and exact prompt bytes through a public request", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetch = candidateFetch(requests);
    const read = await readExploreCatalog({ fetch });

    const text = await readExplorePromptText("review-a-product-update", {
      fetch,
    });

    const served = await catalog
      .promptTextResponse("review-a-product-update")
      .text();

    expect(read.items).toEqual(catalog.items);
    expect(text).toBe(served);
    expect(text).toBe(exploreOwners.prompt("review-a-product-update")?.body);
    expect(requests.map(({ url }) => url)).toEqual([
      `${ORIGIN}/explore/catalog.json?version=2`,
      `${ORIGIN}/explore/prompts/review-a-product-update/text`,
    ]);

    for (const { init } of requests) {
      expect([...new Headers(init?.headers).keys()]).toEqual(["accept"]);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
    }
  });
});
