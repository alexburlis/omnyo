import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contentPaths } from "../landing/content-links";
import { sitemapPaths, sitemapXml } from "../server/sitemap";
import { workflowCatalog } from "../workflow-catalog/entries.server";
import { exploreActivation } from "./activation.server";
import {
  exploreKey,
  explorePluginPath,
  explorePromptPath,
  explorePromptTextPath,
  exploreSkillPath,
  filterExploreItems,
  normalizeExploreQuery,
  validateExploreSearch,
} from "./catalog";
import {
  createExploreCatalog,
  isCanonicalPromptText,
  type ExploreOwners,
  type ExploreRecord,
} from "./catalog.server";
import { exploreCatalog, exploreOwners } from "./entries.server";
import { promptSources } from "./prompts.server";
import { exploreRecords } from "./records.server";
import {
  createExploreSkillSource,
  exploreSkillSource,
} from "./skill-packs.server";

const active = (
  records: readonly ExploreRecord[] = exploreRecords,
  owners: ExploreOwners = exploreOwners,
) => createExploreCatalog({ activation: "active", records, owners });

const DRAFT_MARKER = "draft-marker-7f3c9e21";

const draftPrompt = {
  slug: "draft-prompt",
  title: `Draft ${DRAFT_MARKER}`,
  summary: `Unpublished ${DRAFT_MARKER}`,
  usage: "Paste it.",
  body: `Secret body ${DRAFT_MARKER}\n`,
  sample: { label: "x", input: [], findings: [], revision: "x" },
};

const withDraft: readonly ExploreRecord[] = [
  ...exploreRecords.map((record) =>
    record.kind === "workflow"
      ? {
          ...record,
          related: [{ kind: "prompt" as const, slug: "draft-prompt" }],
        }
      : record,
  ),
  {
    kind: "prompt",
    slug: "draft-prompt",
    state: "draft",
    position: 1,
    tags: [DRAFT_MARKER],
    related: [],
  },
];

const draftOwners: ExploreOwners = {
  ...exploreOwners,
  prompt: (slug) =>
    slug === draftPrompt.slug ? draftPrompt : exploreOwners.prompt(slug),
};

const HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "x-content-type-options": "nosniff",
};

describe("curated Explore seed", () => {
  it("resolves every published record to its owner in curated order", () => {
    const catalog = active();

    expect(catalog.unresolved).toEqual([]);
    expect(catalog.items.map(exploreKey)).toEqual([
      "workflow/weekly-content-feed",
      "prompt/review-a-product-update",
      "skill/product-update-review",
      "skill/customer-lab",
      "plugin/browser-automation",
      "guide/run-an-agent-on-a-schedule",
    ]);
  });

  it("uses each owner's canonical page and published action", () => {
    const byKey = new Map(
      active().items.map((item) => [exploreKey(item), item]),
    );

    const workflow = workflowCatalog.detail("weekly-content-feed");

    expect(byKey.get("workflow/weekly-content-feed")).toMatchObject({
      title: workflow?.listing.title,
      summary: workflow?.listing.description,
      path: "/workflows/weekly-content-feed",
      preview: { path: "/workflows/weekly-content-feed/preview.png" },
      cta: {
        kind: "get-workflow",
        path: "/workflows/weekly-content-feed#get-workflow",
      },
    });
    expect(byKey.get("guide/run-an-agent-on-a-schedule")).toMatchObject({
      title: "Run an agent on a schedule",
      path: "/guides/run-an-agent-on-a-schedule",
      cta: { kind: "read-guide", path: "/guides/run-an-agent-on-a-schedule" },
    });
    expect(contentPaths()).toContain("/guides/run-an-agent-on-a-schedule");
    expect(byKey.get("prompt/review-a-product-update")).toMatchObject({
      path: explorePromptPath("review-a-product-update"),
      cta: {
        kind: "copy-prompt",
        textPath: explorePromptTextPath("review-a-product-update"),
      },
    });
    expect(byKey.get("plugin/browser-automation")).toMatchObject({
      title: "Browser Automation",
      publisher: "Omnyo",
      path: explorePluginPath("browser-automation"),
      cta: {
        kind: "find-in-omnyo",
        pluginId: "browser-automation",
        marketplace: "omnyo-official",
        install: "omnyo plugin install browser-automation@omnyo-official",
      },
    });
  });

  it("offers the guide as the workflow's next step only while active", () => {
    expect(active().relatedFor("workflow", "weekly-content-feed")).toEqual([
      {
        kind: "guide",
        title: "Run an agent on a schedule",
        path: "/guides/run-an-agent-on-a-schedule",
      },
    ]);
    expect(
      createExploreCatalog({
        activation: "inactive",
        records: exploreRecords,
        owners: exploreOwners,
      }).relatedFor("workflow", "weekly-content-feed"),
    ).toEqual([]);
    expect(active().relatedFor("guide", "missing")).toEqual([]);
  });

  it("keeps keys and canonical paths unique", () => {
    const items = active().items;

    expect(new Set(items.map(exploreKey)).size).toBe(items.length);
    expect(new Set(items.map(({ path }) => path)).size).toBe(items.length);
  });

  it("serves the committed prompt file byte for byte", async () => {
    const file = readFileSync(
      new URL("./prompts/review-a-product-update.txt", import.meta.url),
    );

    const response = active().promptTextResponse("review-a-product-update");
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(promptSources[0]?.body).toBe(file.toString("utf8"));
    expect(bytes.equals(file)).toBe(true);
    expect(isCanonicalPromptText(file.toString("utf8"))).toBe(true);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      ...HEADERS,
      "content-type": "text/plain; charset=utf-8",
    });
  });

  it("serves the skill pack only at the published path and exact digest", async () => {
    const catalog = active();
    const slug = "product-update-review";
    const detail = catalog.skillDetail(slug);

    if (!detail) throw new Error("Missing skill pack");

    const file = readFileSync(
      new URL("./product-update-review.json", import.meta.url),
    );

    const digest = createHash("sha256").update(file).digest("hex");
    const response = catalog.skillFileResponse(slug, digest);

    expect(detail.item.path).toBe(exploreSkillPath(slug));
    expect(detail.release.sha256).toBe(digest);
    expect(catalog.sitemapPaths).toContain(exploreSkillPath(slug));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(file);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      ...HEADERS,
      "content-type": "application/octet-stream",
      "content-disposition":
        'attachment; filename="product-update-review.omnyoskillpack"',
    });
    expect(catalog.skillFileResponse(slug, "abcd").status).toBe(404);
    expect(catalog.skillFileResponse("unknown", digest).status).toBe(404);

    const draft = active(
      exploreRecords.map((record) =>
        record.kind === "skill" ? { ...record, state: "draft" } : record,
      ),
    );

    expect(draft.skillFileResponse(slug, digest).status).toBe(404);
    expect(draft.skillDetail(slug)).toBeUndefined();
    expect(draft.sitemapPaths).not.toContain(exploreSkillPath(slug));
  });

  it("rejects a release whose bytes disagree with its pin and blocks withdrawn bytes", () => {
    const slug = "product-update-review";
    const source = exploreSkillSource(slug);
    const current = source?.release(source.detail.sha256);

    if (!current || current.state !== "current")
      throw new Error("Missing release");

    expect(() =>
      createExploreSkillSource([{ ...current, bytes: "{}" }]),
    ).toThrow("Invalid release");

    const sha256 = "a".repeat(64);

    const catalog = active(exploreRecords, {
      ...exploreOwners,
      skill: () =>
        createExploreSkillSource([current, { state: "withdrawn", sha256 }]),
    });

    expect(catalog.skillFileResponse(slug, sha256).status).toBe(410);
    expect(catalog.skillFileResponse(slug, current.sha256).status).toBe(200);
  });

  it("links related items only to visible items", () => {
    const prompt = active().promptDetail("review-a-product-update");

    expect(prompt?.related).toEqual([
      {
        kind: "workflow",
        title: "Weekly Content Feed",
        path: "/workflows/weekly-content-feed",
      },
    ]);
  });
});

describe("activation", () => {
  it("binds the served catalog to the committed source flag", async () => {
    expect(exploreCatalog.activation).toBe(exploreActivation);

    if (exploreActivation === "inactive") {
      expect(exploreCatalog.items).toEqual([]);
      expect(exploreCatalog.sitemapPaths).toEqual([]);
      expect(exploreCatalog.catalogResponse().status).toBe(404);
    } else {
      expect(exploreCatalog.items.length).toBe(6);
      expect(exploreCatalog.catalogResponse().status).toBe(200);
    }
  });

  it("exposes nothing while inactive", async () => {
    const catalog = createExploreCatalog({
      activation: "inactive",
      records: exploreRecords,
      owners: exploreOwners,
    });

    expect(catalog.items).toEqual([]);
    expect(catalog.sitemapPaths).toEqual([]);
    expect(catalog.promptDetail("review-a-product-update")).toBeUndefined();
    expect(catalog.pluginDetail("browser-automation")).toBeUndefined();

    for (const response of [
      catalog.catalogResponse(),
      catalog.promptTextResponse("review-a-product-update"),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      });
    }
  });
});

describe("published projection", () => {
  it("keeps a draft out of every entry point", async () => {
    const catalog = active(withDraft, draftOwners);
    const json = await catalog.catalogResponse().text();
    const text = catalog.promptTextResponse("draft-prompt");

    expect(json).not.toContain(DRAFT_MARKER);
    expect(text.status).toBe(404);
    expect(await text.text()).toBe("");
    expect(catalog.promptDetail("draft-prompt")).toBeUndefined();
    expect(JSON.stringify(catalog.sitemapPaths)).not.toContain("draft-prompt");
    expect(JSON.stringify(catalog.items)).not.toContain(DRAFT_MARKER);
    expect(
      JSON.stringify(catalog.promptDetail("review-a-product-update")),
    ).not.toContain(DRAFT_MARKER);
  });

  it("hides an unavailable owner and its related links without breaking others", () => {
    const catalog = active(exploreRecords, {
      ...exploreOwners,
      workflow: () => undefined,
    });

    expect(catalog.unresolved).toEqual([
      { kind: "workflow", slug: "weekly-content-feed" },
    ]);
    expect(catalog.items.map(exploreKey)).not.toContain(
      "workflow/weekly-content-feed",
    );
    expect(catalog.promptDetail("review-a-product-update")?.related).toEqual(
      [],
    );
    expect(catalog.items).toHaveLength(5);
  });

  it("hides a prompt whose text is not canonical", () => {
    for (const body of ["Line\r\n", "No newline", "Two\n\n", "  \n"]) {
      const catalog = active(exploreRecords, {
        ...exploreOwners,
        prompt: (slug) => {
          const prompt = exploreOwners.prompt(slug);

          return prompt && { ...prompt, body };
        },
      });

      expect(catalog.promptDetail("review-a-product-update")).toBeUndefined();
      expect(catalog.unresolved).toEqual([
        { kind: "prompt", slug: "review-a-product-update" },
      ]);
    }
  });

  it("hides a plugin whose manifest identity differs from the record", () => {
    const catalog = active(exploreRecords, {
      ...exploreOwners,
      plugin: (slug) => {
        const plugin = exploreOwners.plugin(slug);

        return plugin && { ...plugin, pluginId: "browser-control" };
      },
    });

    expect(catalog.pluginDetail("browser-automation")).toBeUndefined();
  });

  it("rejects duplicate keys, invalid slugs and dangling references", () => {
    const [first] = exploreRecords;

    if (!first) throw new Error("No seed records");

    expect(() => active([first, first])).toThrow(/duplicate/u);
    expect(() => active([{ ...first, slug: "Weekly" }])).toThrow(/Invalid/u);
    expect(() =>
      active([{ ...first, related: [{ kind: "guide", slug: "missing" }] }]),
    ).toThrow(/references unknown guide\/missing/u);
    expect(() => active([{ ...first, tags: ["x".repeat(33)] }])).toThrow(
      /tags/u,
    );
  });

  it("serves the catalog JSON with discovery-safe headers", async () => {
    const response = active().catalogResponse();

    const body = (await response.json()) as {
      schemaVersion: number;
      items: unknown[];
    };

    expect(Object.fromEntries(response.headers)).toMatchObject({
      ...HEADERS,
      "content-type": "application/json; charset=utf-8",
    });
    expect(body.schemaVersion).toBe(1);
    expect(body.items).toEqual(
      active().items.filter(({ kind }) => kind !== "skill"),
    );
  });

  it("refuses unknown, uppercase and traversal slugs", () => {
    const catalog = active();

    for (const slug of ["unknown", "REVIEW-A-PRODUCT-UPDATE", "../x", ""]) {
      expect(catalog.promptTextResponse(slug).status).toBe(404);
      expect(catalog.promptDetail(slug)).toBeUndefined();
      expect(catalog.pluginDetail(slug)).toBeUndefined();
    }

    expect(catalog.pluginDetail("review-a-product-update")).toBeUndefined();
    expect(catalog.promptDetail("browser-automation")).toBeUndefined();
  });
});

describe("discovery", () => {
  it("adds only Explore-owned pages to the sitemap once", () => {
    const catalog = active();
    const owned = [...workflowCatalog.sitemapPaths, ...contentPaths()];

    expect(catalog.sitemapPaths).toEqual([
      "/explore",
      "/explore/prompts/review-a-product-update",
      "/explore/skills/product-update-review",
      "/explore/skills/customer-lab",
      "/explore/plugins/browser-automation",
    ]);
    expect(catalog.sitemapPaths.filter((path) => owned.includes(path))).toEqual(
      [],
    );

    const xml = sitemapXml("https://example.test", [
      ...sitemapPaths(),
      ...(exploreActivation === "inactive" ? catalog.sitemapPaths : []),
    ]);

    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
      ([, loc]) => loc,
    );

    expect(new Set(locs).size).toBe(locs.length);
  });

  it("filters by type and by every search term in title, summary and tags", () => {
    const items = active().items;

    const keys = (filter: Parameters<typeof filterExploreItems>[1]) =>
      filterExploreItems(items, filter).map(exploreKey);

    expect(keys({ kind: "plugin" })).toEqual(["plugin/browser-automation"]);
    expect(keys({ query: "  RELEASE   notes " })).toEqual([
      "prompt/review-a-product-update",
      "skill/product-update-review",
    ]);
    expect(keys({ query: "schedule agent" })).toEqual([
      "guide/run-an-agent-on-a-schedule",
    ]);
    expect(keys({ kind: "guide", query: "browser" })).toEqual([]);
    expect(keys({})).toEqual(items.map(exploreKey));
  });

  it("allowlists the type and bounds the query", () => {
    expect(validateExploreSearch({ type: "plugin", q: "  Browser " })).toEqual({
      type: "plugin",
      q: "browser",
    });
    expect(validateExploreSearch({ type: "marketplace", q: 42 })).toEqual({
      q: "42",
    });
    expect(validateExploreSearch({ q: "   " })).toEqual({});
    expect(normalizeExploreQuery("x".repeat(200))).toHaveLength(80);
  });
});
