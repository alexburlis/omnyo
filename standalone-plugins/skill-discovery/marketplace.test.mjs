import assert from "node:assert/strict";
import test from "node:test";
import {
  marketplaceCatalogSchema,
  filterMarketplace,
  marketplaceMaxBytes,
  workflowImportPath,
} from "./marketplace-contract.ts";
import { readMarketplace, matchReviewedSkills } from "./marketplace-service.ts";
import { curatedSnapshot } from "./curated-snapshot.ts";
import { catalog, skill, workflow, connector } from "./tests/marketplace-fixture.mjs";

test("catalog preserves all three kinds and rejects unsafe or inconsistent destinations", () => {
  assert.deepEqual(marketplaceCatalogSchema.parse(catalog), catalog);

  for (const item of [
    { ...skill, detailPath: "https://example.com" },
    { ...skill, sourceUrl: "javascript:alert(1)" },
    { ...skill, sourceUrl: "https://user:password@example.com/a" },
    { ...skill, setupUrl: "https://example.com/setup" },
    { ...connector, pluginId: "../sentry" },
    { ...connector, slug: "other-plugin" },
    { ...workflow, sha256: "invalid" },
    { ...skill, category: "Unreviewed" },
  ])
    assert.equal(
      marketplaceCatalogSchema.safeParse({ schemaVersion: 1, items: [item] }).success,
      false,
    );
  assert.equal(
    marketplaceCatalogSchema.safeParse({ ...catalog, items: [skill, skill] }).success,
    false,
  );
  assert.equal(marketplaceCatalogSchema.safeParse({ schemaVersion: 2, items: [] }).success, false);
  assert.equal(
    marketplaceCatalogSchema.safeParse({
      ...catalog,
      items: Array.from({ length: 1025 }, (_, index) => ({
        ...skill,
        slug: `skill-${index}`,
        detailPath: `/explore/skills/source/skill-${index}`,
      })),
    }).success,
    false,
  );
});

test("search requires every whitespace term and composes exact filters", () => {
  const filters = { query: "review WRITING", kind: "", category: "", publisher: "" };
  assert.deepEqual(filterMarketplace(catalog.items, filters), [skill]);
  assert.deepEqual(
    filterMarketplace(catalog.items, { ...filters, query: "review", kind: "workflow" }),
    [workflow],
  );
  assert.deepEqual(
    filterMarketplace(catalog.items, {
      ...filters,
      query: "",
      publisher: "Omnyo",
      category: "Coding & architecture",
    }),
    [connector],
  );
  assert.deepEqual(filterMarketplace(catalog.items, { ...filters, query: "review missing" }), []);
  assert.deepEqual(
    filterMarketplace(catalog.items, { ...filters, query: `review${" ".repeat(74)} missing` }),
    [workflow, skill],
  );
});

test("only the exact public source revision and digest receive the reviewed installer", () => {
  const expected = { "documentation-writer": "github/awesome-copilot/documentation-writer" };
  assert.deepEqual(matchReviewedSkills(catalog, curatedSnapshot), expected);

  for (const change of [
    { source: "omnyo" },
    { sourceUrl: skill.sourceUrl.replace("github/awesome-copilot", "other/repository") },
    { revision: "other-revision" },
    { sha256: "a".repeat(64) },
  ])
    assert.deepEqual(
      matchReviewedSkills({ schemaVersion: 1, items: [{ ...skill, ...change }] }, curatedSnapshot),
      {},
    );
});

test("workflow navigation uses the verified share digest prefix", () => {
  assert.equal(
    workflowImportPath(workflow),
    "/plugins/automations/automations/import/1234567890abcdef1234567890abcdef",
  );
});

test("fetch stays on the fixed origin, omits credentials and rejects redirects", async () => {
  let calls = 0;

  const result = await readMarketplace(async (url, options) => {
    calls++;
    assert.equal(url, "https://omnyohq.com/explore/marketplace.json?provider-setup=1");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);

    return new Response(JSON.stringify(catalog));
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, catalog);
});

test("fetch exposes malformed, failed and oversized responses without a fallback", async () => {
  for (const response of [
    new Response("unavailable", { status: 503 }),
    new Response("invalid JSON"),
    new Response(JSON.stringify({ schemaVersion: 2, items: [] })),
    new Response(" ".repeat(marketplaceMaxBytes + 1)),
  ]) {
    let calls = 0;
    await assert.rejects(
      readMarketplace(async () => {
        calls++;

        return response;
      }),
    );
    assert.equal(calls, 1);
  }

  await assert.rejects(
    readMarketplace(async () => {
      throw new Error("Network refused");
    }),
    /Network refused/,
  );
});
