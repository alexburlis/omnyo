import { describe, expect, it, vi } from "vitest";
import {
  ExploreFormatError,
  ExploreUnavailableError,
  exploreUrl,
  filterExploreItems,
  filterExploreSkills,
  filterExploreMarketplace,
  normalizeExploreQuery,
  parseExploreCatalog,
  parseExploreKey,
  parseExploreSkills,
  parseExploreMarketplace,
  readExploreCatalog,
  readExploreSkills,
  readExploreMarketplace,
  readExplorePromptText,
  type ExploreItem,
} from "../src/explore.js";

function promptItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "prompt",
    slug: "review-a-product-update",
    title: "Review a product update",
    summary: "Check a draft update before it ships.",
    publisher: "Omnyo",
    tags: ["writing", "review"],
    path: "/explore/prompts/review-a-product-update",
    preview: null,
    cta: {
      kind: "copy-prompt",
      label: "Copy prompt",
      textPath: "/explore/prompts/review-a-product-update/text",
    },
    ...overrides,
  };
}

function workflowItem(): Record<string, unknown> {
  return {
    kind: "workflow",
    slug: "weekly-content-feed",
    title: "Weekly content feed",
    summary: "Collect links every week.",
    publisher: "Omnyo",
    tags: ["research"],
    path: "/workflows/weekly-content-feed",
    preview: {
      path: "/workflows/weekly-content-feed/preview.png",
      alt: "Preview",
      width: 1200,
      height: 630,
    },
    cta: {
      kind: "get-workflow",
      label: "Get workflow",
      path: "/workflows/weekly-content-feed#get-workflow",
    },
  };
}

function pluginItem(): Record<string, unknown> {
  return {
    kind: "plugin",
    slug: "browser-automation",
    title: "Browser Automation",
    summary: "Drive a browser from a chat.",
    publisher: "Omnyo",
    tags: [],
    path: "/explore/plugins/browser-automation",
    preview: null,
    cta: {
      kind: "find-in-omnyo",
      label: "Find in Omnyo",
      pluginId: "browser-automation",
      marketplace: "omnyo-official",
      install: "omnyo plugin install browser-automation@omnyo-official",
    },
  };
}

function guideItem(): Record<string, unknown> {
  return {
    kind: "guide",
    slug: "run-an-agent-on-a-schedule",
    title: "Run an agent on a schedule",
    summary: "Automate recurring work.",
    publisher: "Omnyo",
    tags: ["automation"],
    path: "/guides/run-an-agent-on-a-schedule",
    preview: null,
    cta: {
      kind: "read-guide",
      label: "Read guide",
      path: "/guides/run-an-agent-on-a-schedule",
    },
  };
}

function catalogOf(
  ...items: Record<string, unknown>[]
): Record<string, unknown> {
  return { schemaVersion: 1, items };
}

function parsedItems(): ExploreItem[] {
  return parseExploreCatalog(
    catalogOf(workflowItem(), promptItem(), pluginItem(), guideItem()),
  ).items;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    ...init,
  });
}

function expectFormatError(value: unknown): void {
  expect(() => parseExploreCatalog(value)).toThrow(ExploreFormatError);
}

describe("parseExploreCatalog", () => {
  it("parses every item kind and drops unknown fields at every level", () => {
    const withExtras = promptItem({
      extra: "dropped",
      cta: {
        kind: "copy-prompt",
        label: "Copy prompt",
        textPath: "/explore/prompts/review-a-product-update/text",
        extra: true,
      },
    });

    const catalog = parseExploreCatalog({
      ...catalogOf(withExtras, workflowItem(), pluginItem(), guideItem()),
      extra: 1,
    });

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.items.map((item) => `${item.kind}/${item.slug}`)).toEqual([
      "prompt/review-a-product-update",
      "workflow/weekly-content-feed",
      "plugin/browser-automation",
      "guide/run-an-agent-on-a-schedule",
    ]);
    expect(catalog.items[0]).toEqual(promptItem());
    expect(catalog.items[1].preview).toEqual({
      path: "/workflows/weekly-content-feed/preview.png",
      alt: "Preview",
      width: 1200,
      height: 630,
    });
    expect(Object.keys(catalog)).toEqual(["schemaVersion", "items"]);
  });

  it("accepts an empty catalog", () => {
    expect(parseExploreCatalog(catalogOf())).toEqual({
      schemaVersion: 1,
      items: [],
    });
  });

  it("accepts skill packs in version two and keeps version one strict", () => {
    const pack = {
      kind: "skill",
      slug: "product-update-review",
      title: "Product Update Review",
      summary: "Review a release draft.",
      publisher: "Omnyo",
      tags: ["review"],
      path: "/explore/skills/product-update-review",
      preview: null,
      cta: {
        kind: "get-skill-pack",
        label: "View skill pack",
        path: "/explore/skills/product-update-review",
      },
    };

    expect(parseExploreCatalog({ schemaVersion: 2, items: [pack] })).toEqual({
      schemaVersion: 2,
      items: [pack],
    });
    expectFormatError(catalogOf(pack));
    expectFormatError({
      schemaVersion: 2,
      items: [{ ...pack, cta: { ...pack.cta, path: "//elsewhere.test/pack" } }],
    });
  });

  it.each([
    ["a non-object", "text"],
    ["an array", []],
    ["a wrong schema version", { schemaVersion: 3, items: [] }],
    ["a missing schema version", { items: [] }],
    ["non-array items", { schemaVersion: 1, items: {} }],
  ])("rejects %s", (_name, value) => {
    expectFormatError(value);
  });

  it("rejects more than 500 items", () => {
    const items = Array.from({ length: 501 }, (_, index) =>
      promptItem({ slug: `item-${index}` }),
    );

    expectFormatError(catalogOf(...items));
  });

  it.each([
    ["an unknown kind", { kind: "video" }],
    ["an uppercase slug", { slug: "Review" }],
    ["a slug with a leading hyphen", { slug: "-review" }],
    ["a slug with a double hyphen", { slug: "a--b" }],
    ["a slug longer than 64 characters", { slug: "a".repeat(65) }],
    ["an empty title", { title: "" }],
    ["a title longer than 120 characters", { title: "t".repeat(121) }],
    ["a summary longer than 400 characters", { summary: "s".repeat(401) }],
    ["an empty summary", { summary: "" }],
    ["a publisher longer than 80 characters", { publisher: "p".repeat(81) }],
    ["a non-string tag", { tags: [1] }],
    ["an empty tag", { tags: [""] }],
    ["a tag longer than 32 characters", { tags: ["t".repeat(33)] }],
    [
      "more than 12 tags",
      { tags: Array.from({ length: 13 }, (_, index) => `t${index}`) },
    ],
    ["non-array tags", { tags: "writing" }],
    ["a path without a leading slash", { path: "explore/x" }],
    ["a protocol-relative path", { path: "//evil.example/x" }],
    ["a path with whitespace", { path: "/explore/a b" }],
    ["a path with a newline", { path: "/explore/a\nb" }],
    ["a path with a backslash", { path: "/explore\\x" }],
    ["a path longer than 200 characters", { path: `/${"a".repeat(200)}` }],
    ["an absolute URL path", { path: "https://omnyohq.com/x" }],
    ["a missing preview", { preview: undefined }],
    ["a preview that is not an object", { preview: "x" }],
    [
      "a preview with an empty alt",
      { preview: { path: "/p.png", alt: "", width: 1, height: 1 } },
    ],
    [
      "a preview with a long alt",
      {
        preview: { path: "/p.png", alt: "a".repeat(301), width: 1, height: 1 },
      },
    ],
    [
      "a preview with a bad path",
      { preview: { path: "//p.png", alt: "a", width: 1, height: 1 } },
    ],
    [
      "a preview with a zero width",
      { preview: { path: "/p.png", alt: "a", width: 0, height: 1 } },
    ],
    [
      "a preview with a fractional height",
      { preview: { path: "/p.png", alt: "a", width: 1, height: 1.5 } },
    ],
    [
      "a preview with a string width",
      { preview: { path: "/p.png", alt: "a", width: "1", height: 1 } },
    ],
    [
      "a cta for another kind",
      { cta: { kind: "read-guide", label: "Read", path: "/guides/x" } },
    ],
    [
      "a cta with an empty label",
      { cta: { kind: "copy-prompt", label: "", textPath: "/t" } },
    ],
    [
      "a cta with a long label",
      { cta: { kind: "copy-prompt", label: "l".repeat(41), textPath: "/t" } },
    ],
    [
      "a cta with a bad text path",
      { cta: { kind: "copy-prompt", label: "Copy", textPath: "//t" } },
    ],
    [
      "a cta with a missing text path",
      { cta: { kind: "copy-prompt", label: "Copy" } },
    ],
    ["a missing cta", { cta: undefined }],
  ])("rejects an item with %s", (_name, overrides) => {
    expectFormatError(catalogOf(promptItem(overrides)));
  });

  it("rejects duplicate kind and slug pairs but allows the same slug under another kind", () => {
    expectFormatError(catalogOf(promptItem(), promptItem()));

    expect(() =>
      parseExploreCatalog(
        catalogOf(
          promptItem(),
          promptItem({
            kind: "guide",
            cta: { kind: "read-guide", label: "Read", path: "/g" },
          }),
        ),
      ),
    ).not.toThrow();
  });

  it("rejects plugin ctas with an invalid plugin id, marketplace or install command", () => {
    const withCta = (
      patch: Record<string, unknown>,
    ): Record<string, unknown> => {
      const item = pluginItem();

      return {
        ...item,
        cta: { ...(item.cta as Record<string, unknown>), ...patch },
      };
    };

    expectFormatError(catalogOf(withCta({ pluginId: "Bad Id" })));
    expectFormatError(catalogOf(withCta({ marketplace: "" })));
    expectFormatError(catalogOf(withCta({ install: "" })));
    expectFormatError(catalogOf(withCta({ install: "x".repeat(201) })));
  });

  it("rejects ctas bound to the wrong item kind for every kind", () => {
    const prompt = promptItem();
    const workflow = workflowItem();
    const plugin = pluginItem();
    const guide = guideItem();

    expectFormatError(catalogOf({ ...workflow, cta: prompt.cta }));
    expectFormatError(catalogOf({ ...plugin, cta: workflow.cta }));
    expectFormatError(catalogOf({ ...guide, cta: plugin.cta }));
    expectFormatError(catalogOf({ ...prompt, cta: guide.cta }));
  });
});

describe("normalizeExploreQuery", () => {
  it("collapses whitespace, bounds to 80 characters and lowercases", () => {
    expect(normalizeExploreQuery("  Weekly \t\n  FEED  ")).toBe("weekly feed");
    expect(normalizeExploreQuery("a".repeat(120))).toBe("a".repeat(80));
    expect(normalizeExploreQuery(`${"a".repeat(79)} bcd`)).toBe("a".repeat(79));
    expect(normalizeExploreQuery("   ")).toBe("");
  });
});

describe("filterExploreItems", () => {
  const items = parsedItems();

  const keys = (list: ExploreItem[]): string[] =>
    list.map((item) => `${item.kind}/${item.slug}`);

  it("returns every item in catalog order without a filter", () => {
    expect(filterExploreItems(items, {})).toEqual(items);
    expect(filterExploreItems(items, { query: "   " })).toEqual(items);
  });

  it("filters by kind", () => {
    expect(keys(filterExploreItems(items, { kind: "plugin" }))).toEqual([
      "plugin/browser-automation",
    ]);
  });

  it("matches every term case-insensitively against title, summary and tags", () => {
    expect(keys(filterExploreItems(items, { query: "BROWSER" }))).toEqual([
      "plugin/browser-automation",
    ]);
    expect(keys(filterExploreItems(items, { query: "review draft" }))).toEqual([
      "prompt/review-a-product-update",
    ]);
    expect(keys(filterExploreItems(items, { query: "automation" }))).toEqual([
      "plugin/browser-automation",
      "guide/run-an-agent-on-a-schedule",
    ]);
    expect(filterExploreItems(items, { query: "review nonexistent" })).toEqual(
      [],
    );
  });

  it("collapses whitespace in the query and combines kind with query", () => {
    expect(
      keys(filterExploreItems(items, { query: "  weekly \n  links " })),
    ).toEqual(["workflow/weekly-content-feed"]);
    expect(
      filterExploreItems(items, { kind: "guide", query: "browser" }),
    ).toEqual([]);
  });

  it("bounds the query to 80 characters before matching", () => {
    const query = `weekly ${"x".repeat(200)}`;

    expect(normalizeExploreQuery(query)).toHaveLength(80);
    expect(filterExploreItems(items, { query })).toEqual([]);
  });

  it("preserves catalog order", () => {
    expect(keys(filterExploreItems(items, { query: "e" }))).toEqual(
      keys(items),
    );
  });
});

describe("parseExploreKey", () => {
  it("splits kind/slug and rejects everything else", () => {
    expect(parseExploreKey("prompt/review-a-product-update")).toEqual({
      kind: "prompt",
      slug: "review-a-product-update",
    });

    for (const bad of [
      "",
      "prompt",
      "prompt/",
      "/x",
      "video/x",
      "prompt/X",
      "prompt/a/b",
      "Prompt/x",
      " prompt/x",
      "prompt/a b",
    ]) {
      expect(parseExploreKey(bad), bad).toBeNull();
    }
  });
});

describe("exploreUrl", () => {
  it("builds absolute URLs on the default or a given origin and rejects non-paths", () => {
    expect(exploreUrl("/explore/catalog.json")).toBe(
      "https://omnyohq.com/explore/catalog.json",
    );
    expect(exploreUrl("/explore", "https://web.test/")).toBe(
      "https://web.test/explore",
    );
    expect(() => exploreUrl("//evil.example/x")).toThrow(ExploreFormatError);
    expect(() => exploreUrl("explore")).toThrow(ExploreFormatError);
  });
});

describe("readExploreCatalog", () => {
  it("sends exactly one credential-free GET and returns the parsed catalog", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(catalogOf(promptItem())),
    );

    const catalog = await readExploreCatalog({ fetch: fetchMock });

    expect(catalog.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://omnyohq.com/explore/catalog.json?version=2");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ accept: "application/json" });
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeUndefined();
  });

  it("uses the given origin", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(catalogOf()),
    );

    await readExploreCatalog({ fetch: fetchMock, origin: "https://web.test" });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://web.test/explore/catalog.json?version=2",
    );
  });

  it("turns a non-2xx status into ExploreUnavailableError with the status and URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 404 }),
    );

    const error = await readExploreCatalog({ fetch: fetchMock }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ExploreUnavailableError);
    expect((error as ExploreUnavailableError).status).toBe(404);
    expect((error as ExploreUnavailableError).url).toBe(
      "https://omnyohq.com/explore/catalog.json?version=2",
    );
  });

  it("rejects a wrong content type", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const error = await readExploreCatalog({ fetch: fetchMock }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ExploreUnavailableError);
    expect((error as ExploreUnavailableError).status).toBe(200);
  });

  it("rejects a response without a content type", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array(0), { status: 200 }),
    );

    await expect(
      readExploreCatalog({ fetch: fetchMock }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);
  });

  it("rejects a body over 1 MiB and cancels the stream", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(512 * 1024);
    let sent = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      readExploreCatalog({ fetch: fetchMock }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(sent).toBeLessThan(10);
  });

  it("rejects a declared content length over the cap", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024),
          },
        }),
    );

    await expect(
      readExploreCatalog({ fetch: fetchMock }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);
  });

  it("turns a fetch rejection such as a redirect error into ExploreUnavailableError", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });

    const error = await readExploreCatalog({ fetch: fetchMock }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ExploreUnavailableError);
    expect((error as ExploreUnavailableError).status).toBeNull();
    expect((error as ExploreUnavailableError).message).toContain(
      "fetch failed",
    );
    expect((error as ExploreUnavailableError).cause).toBeInstanceOf(TypeError);
  });

  it("rejects invalid JSON and invalid catalogs as ExploreFormatError", async () => {
    const notJson = vi.fn<typeof fetch>(
      async () =>
        new Response("nope", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(readExploreCatalog({ fetch: notJson })).rejects.toBeInstanceOf(
      ExploreFormatError,
    );

    const wrongShape = vi.fn<typeof fetch>(async () =>
      jsonResponse({ schemaVersion: 1, items: [{}] }),
    );

    await expect(
      readExploreCatalog({ fetch: wrongShape }),
    ).rejects.toBeInstanceOf(ExploreFormatError);
  });

  it("aborts a request that outlives the timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    await expect(
      readExploreCatalog({ fetch: fetchMock, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);
  });

  it("aborts when the caller signal aborts", async () => {
    const controller = new AbortController();

    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
          controller.abort();
        }),
    );

    await expect(
      readExploreCatalog({ fetch: fetchMock, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);
  });
});

describe("readExplorePromptText", () => {
  it("requests the text route and returns the bytes unchanged including the trailing LF", async () => {
    const text = "Line one\n\nLine two with ünïcode\n";
    const fetchMock = vi.fn<typeof fetch>(async () => textResponse(text));

    const result = await readExplorePromptText("review-a-product-update", {
      fetch: fetchMock,
    });

    expect(result).toBe(text);
    expect(result.endsWith("\n")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://omnyohq.com/explore/prompts/review-a-product-update/text",
    );
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ accept: "text/plain" });
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
  });

  it("rejects an invalid slug before any fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => textResponse("x\n"));

    for (const slug of ["", "../x", "A", "a/b", "a b", "a".repeat(65)]) {
      await expect(
        readExplorePromptText(slug, { fetch: fetchMock }),
        slug,
      ).rejects.toBeInstanceOf(ExploreFormatError);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 404, wrong content type, oversize and invalid UTF-8 to visible errors", async () => {
    const notFound = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 404 }),
    );

    await expect(
      readExplorePromptText("x", { fetch: notFound }),
    ).rejects.toMatchObject({
      name: "ExploreUnavailableError",
      status: 404,
    });

    const wrongType = vi.fn<typeof fetch>(async () => jsonResponse({}));

    await expect(
      readExplorePromptText("x", { fetch: wrongType }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);

    const oversize = vi.fn<typeof fetch>(async () =>
      textResponse("a".repeat(64 * 1024 + 1)),
    );

    await expect(
      readExplorePromptText("x", { fetch: oversize }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);

    const atCap = vi.fn<typeof fetch>(async () =>
      textResponse("a".repeat(64 * 1024)),
    );

    await expect(
      readExplorePromptText("x", { fetch: atCap }),
    ).resolves.toHaveLength(64 * 1024);

    const badUtf8 = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([0xff, 0xfe, 0x0a]), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    await expect(
      readExplorePromptText("x", { fetch: badUtf8 }),
    ).rejects.toBeInstanceOf(ExploreFormatError);
  });

  it("keeps a leading byte order mark", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => textResponse("﻿hello\n"));

    await expect(
      readExplorePromptText("x", { fetch: fetchMock }),
    ).resolves.toBe("﻿hello\n");
  });
});

function publicSkill(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug: "sample-review",
    title: "Sample Review",
    category: "Testing & security",
    publisher: "example/skills",
    license: "MIT",
    keywords: ["inspection", "audit"],
    source: "github",
    sourceUrl: `https://github.com/example/skills/blob/${"a".repeat(40)}/review/SKILL.md`,
    revision: "a".repeat(40),
    sha256: "b".repeat(64),
    detailPath: "/explore/skills/source/sample-review",
    ...overrides,
  };
}

function publicCatalog(
  ...items: Record<string, unknown>[]
): Record<string, unknown> {
  return { schemaVersion: 1, items };
}

describe("public Explore skills", () => {
  it("accepts a pinned upstream and a versioned original, stripping extra fields", () => {
    const original = publicSkill({
      source: "omnyo",
      publisher: "Omnyo",
      revision: "1.0.0",
      sourceUrl:
        "https://omnyohq.com/skills/omnyo/sample-review/1.0.0/SKILL.md",
      summary: "Review a synthetic project.",
    });

    expect(
      parseExploreSkills(publicCatalog({ ...original, extra: true })).items,
    ).toEqual([original]);
    expect(parseExploreSkills(publicCatalog(publicSkill())).items).toEqual([
      publicSkill(),
    ]);
  });

  it("accepts 516 and 1024 distinct items, rejects duplicates and larger catalogs", () => {
    const rows = Array.from({ length: 1025 }, (_, index) =>
      publicSkill({
        slug: `skill-${index}`,
        detailPath: `/explore/skills/source/skill-${index}`,
      }),
    );

    expect(
      parseExploreSkills(publicCatalog(...rows.slice(0, 516))).items,
    ).toHaveLength(516);
    expect(
      parseExploreSkills(publicCatalog(...rows.slice(0, 1024))).items,
    ).toHaveLength(1024);
    expect(() => parseExploreSkills(publicCatalog(...rows))).toThrow(
      ExploreFormatError,
    );
    expect(() =>
      parseExploreSkills(publicCatalog(publicSkill(), publicSkill())),
    ).toThrow(ExploreFormatError);
  });

  it.each([
    [
      "mutable source",
      {
        sourceUrl:
          "https://github.com/example/skills/blob/main/review/SKILL.md",
      },
    ],
    ["publisher mismatch", { publisher: "other/skills" }],
    ["revision mismatch", { revision: "c".repeat(40) }],
    ["invalid revision", { revision: "[" }],
    [
      "foreign host",
      {
        sourceUrl: `https://elsewhere.test/example/skills/blob/${"a".repeat(40)}/review/SKILL.md`,
      },
    ],
    [
      "URL credentials",
      {
        sourceUrl: `https://user@github.com/example/skills/blob/${"a".repeat(40)}/review/SKILL.md`,
      },
    ],
    [
      "source query",
      {
        sourceUrl: `https://github.com/example/skills/blob/${"a".repeat(40)}/review/SKILL.md?x=1`,
      },
    ],
    ["detail mismatch", { detailPath: "/explore/skills/source/other" }],
    ["bad hash", { sha256: "invalid" }],
    ["bad keywords", { keywords: [1] }],
    [
      "unversioned original",
      {
        source: "omnyo",
        publisher: "Omnyo",
        revision: "1.0.0",
        sourceUrl: "https://omnyohq.com/skills/omnyo/sample-review/SKILL.md",
      },
    ],
    [
      "original version mismatch",
      {
        source: "omnyo",
        publisher: "Omnyo",
        revision: "1.0.1",
        sourceUrl:
          "https://omnyohq.com/skills/omnyo/sample-review/1.0.0/SKILL.md",
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(() =>
      parseExploreSkills(publicCatalog(publicSkill(overrides))),
    ).toThrow(ExploreFormatError);
  });

  it("requires schema version one and an array", () => {
    expect(() => parseExploreSkills({ schemaVersion: 2, items: [] })).toThrow(
      ExploreFormatError,
    );
    expect(() => parseExploreSkills({ schemaVersion: 1, items: {} })).toThrow(
      ExploreFormatError,
    );
  });

  it("matches all query words across the website's searchable fields", () => {
    const items = parseExploreSkills(
      publicCatalog(publicSkill({ summary: "Find the regression." })),
    ).items;

    for (const query of [
      " SAMPLE  inspection ",
      "example security",
      "review audit",
      "regression",
    ]) {
      expect(filterExploreSkills(items, { query })).toEqual(items);
    }

    expect(filterExploreSkills(items, { query: "sample missing" })).toEqual([]);
  });

  it("reads the dedicated endpoint once with the credential-free request contract", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(publicCatalog(publicSkill())),
    );

    expect((await readExploreSkills({ fetch: fetchMock })).items).toHaveLength(
      1,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://omnyohq.com/explore/skills/catalog.json",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  });

  it("rejects an oversized body, bad JSON, and HTTP failures", async () => {
    const oversized = vi.fn<typeof fetch>(
      async () =>
        new Response(" ".repeat(1024 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      readExploreSkills({ fetch: oversized }),
    ).rejects.toBeInstanceOf(ExploreUnavailableError);

    const invalid = vi.fn<typeof fetch>(
      async () =>
        new Response("not json", {
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(readExploreSkills({ fetch: invalid })).rejects.toBeInstanceOf(
      ExploreFormatError,
    );

    const unavailable = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );

    await expect(
      readExploreSkills({ fetch: unavailable }),
    ).rejects.toMatchObject({ name: "ExploreUnavailableError", status: 503 });
  });
});

function marketplaceItems() {
  return [
    { ...publicSkill(), kind: "skill" },
    {
      kind: "workflow",
      slug: "weekly-content-feed",
      title: "Weekly Content Feed",
      summary: "Reviewed drafts",
      publisher: "Omnyo",
      category: "Marketing & growth",
      keywords: ["content", "weekly"],
      detailPath: "/workflows/weekly-content-feed",
      sha256: "c".repeat(64),
      requirements: "Apple silicon Mac with Omnyo",
    },
    {
      kind: "connector",
      slug: "workspace-github",
      title: "Workspace GitHub",
      publisher: "Omnyo",
      category: "Coding & architecture",
      keywords: ["pull requests"],
      detailPath: "/explore/plugins/workspace-github",
      pluginId: "workspace-github",
      service: "GitHub",
      requirements: "GitHub sign-in",
      availability: "Included with Omnyo",
    },
  ];
}

describe("Explore marketplace", () => {
  it("parses all kinds while retaining pinned source-skill metadata", () => {
    const items = marketplaceItems();
    expect(parseExploreMarketplace({ schemaVersion: 1, items })).toEqual({
      schemaVersion: 1,
      items,
    });
    expect(
      parseExploreMarketplace({ schemaVersion: 1, items: [] }).items,
    ).toEqual([]);
  });

  it("accepts 1024 distinct entries and rejects oversized or duplicate catalogs", () => {
    const workflow = marketplaceItems()[1];

    const items = Array.from({ length: 1024 }, (_, index) => ({
      ...workflow,
      slug: `workflow-${index}`,
      detailPath: `/workflows/workflow-${index}`,
    }));

    expect(
      parseExploreMarketplace({ schemaVersion: 1, items }).items,
    ).toHaveLength(1024);

    for (const invalid of [
      { schemaVersion: 2, items: [] },
      { schemaVersion: 1, items: [...items, items[0]] },
      { schemaVersion: 1, items: [items[0], items[0]] },
    ])
      expect(() => parseExploreMarketplace(invalid)).toThrow(
        ExploreFormatError,
      );
  });

  it.each([
    [
      0,
      {
        sourceUrl:
          "https://github.com/example/skills/blob/main/review/SKILL.md",
      },
    ],
    [0, { detailPath: "/explore/skills/sample-review" }],
    [0, { category: "Other" }],
    [1, { detailPath: "/workflows/another" }],
    [1, { sha256: "bad" }],
    [1, { requirements: "" }],
    [2, { pluginId: "another" }],
    [2, { detailPath: "https://elsewhere.test/github" }],
    [2, { service: "" }],
    [2, { kind: "plugin" }],
  ])("rejects invalid kind-specific fields at index %i", (index, fields) => {
    const item = marketplaceItems()[index];
    expect(() =>
      parseExploreMarketplace({
        schemaVersion: 1,
        items: [{ ...item, ...fields }],
      }),
    ).toThrow(ExploreFormatError);
  });

  it("filters every search term across shared fields and combines exact filters", () => {
    const { items } = parseExploreMarketplace({
      schemaVersion: 1,
      items: marketplaceItems(),
    });

    expect(
      filterExploreMarketplace(items, {
        query: "  OMNYO  weekly drafts  ",
      }).map(({ kind }) => kind),
    ).toEqual(["workflow"]);
    expect(
      filterExploreMarketplace(items, { query: "github pull" }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["connector"]);
    expect(
      filterExploreMarketplace(items, {
        kind: "connector",
        category: "Coding & architecture",
        publisher: "Omnyo",
      }),
    ).toEqual([items[2]]);
    expect(filterExploreMarketplace(items, { publisher: "omnyo" })).toEqual([]);
    expect(
      filterExploreMarketplace(items, { query: "weekly unmatched" }),
    ).toEqual([]);
  });

  it("reads the separate endpoint without credentials and preserves custom origins", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ schemaVersion: 1, items: marketplaceItems() }),
    );

    await readExploreMarketplace({ fetch, origin: "https://web.test" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://web.test/explore/marketplace.json",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  });

  it("refuses unavailable, malformed, oversized, and wrong-content responses", async () => {
    const responses = [
      new Response(null, { status: 503 }),
      new Response("not json", {
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", { headers: { "content-type": "text/html" } }),
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
      }),
    ];

    for (const response of responses)
      await expect(
        readExploreMarketplace({ fetch: async () => response }),
      ).rejects.toThrow();
  });
});
