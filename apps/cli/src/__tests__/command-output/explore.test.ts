import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerExploreCommand } from "../../commands/explore.js";

const PROMPT_TEXT = "Review this product update.\n\nList what is unclear.\n";

const CATALOG = {
  schemaVersion: 2,
  items: [
    {
      kind: "workflow",
      slug: "weekly-content-feed",
      title: "Weekly content feed",
      summary: "Collect links every week.",
      publisher: "Omnyo",
      tags: ["research"],
      path: "/workflows/weekly-content-feed",
      preview: null,
      cta: {
        kind: "get-workflow",
        label: "Get workflow",
        path: "/workflows/weekly-content-feed#get-workflow",
      },
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ],
};

const SKILLS_CATALOG = {
  schemaVersion: 1,
  items: [
    {
      slug: "sample-review",
      title: "Sample Review",
      category: "Testing & security",
      publisher: "example/skills",
      license: "MIT",
      keywords: ["inspection"],
      source: "github",
      sourceUrl: `https://github.com/example/skills/blob/${"a".repeat(40)}/review/SKILL.md`,
      revision: "a".repeat(40),
      sha256: "b".repeat(64),
      detailPath: "/explore/skills/source/sample-review",
    },
  ],
};

const MARKETPLACE_CATALOG = {
  schemaVersion: 1,
  items: [
    { ...SKILLS_CATALOG.items[0], kind: "skill" },
    {
      kind: "workflow",
      slug: "weekly-content-feed",
      title: "Weekly Content Feed",
      summary: "Reviewed drafts",
      publisher: "Omnyo",
      category: "Marketing & growth",
      keywords: ["content"],
      detailPath: "/workflows/weekly-content-feed",
      sha256: "c".repeat(64),
      requirements: "Apple silicon Mac",
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
      requirements: "Sign in to GitHub",
      availability: "Included with Omnyo",
    },
  ],
};

function fixtureFetch(
  overrides: { catalogStatus?: number; textStatus?: number } = {},
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);

    if (
      url === "https://omnyohq.com/explore/marketplace.json?provider-setup=1"
    ) {
      return new Response(JSON.stringify(MARKETPLACE_CATALOG), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://omnyohq.com/explore/skills/catalog.json") {
      return new Response(JSON.stringify(SKILLS_CATALOG), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://omnyohq.com/explore/catalog.json?version=2") {
      return overrides.catalogStatus === undefined
        ? new Response(JSON.stringify(CATALOG), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          })
        : new Response(null, { status: overrides.catalogStatus });
    }

    if (
      url === "https://omnyohq.com/explore/prompts/review-a-product-update/text"
    ) {
      return overrides.textStatus === undefined
        ? new Response(PROMPT_TEXT, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        : new Response(null, { status: overrides.textStatus });
    }

    return new Response(null, { status: 404 });
  });
}

function registrar(fetchMock: typeof fetch): CommandRegistrar {
  return (program) => registerExploreCommand(program, { fetch: fetchMock });
}

function errorOutput(): string {
  return collectLogLines(vi.mocked(console.error)).join("\n");
}

function parsedStdout(): unknown {
  return JSON.parse(collectLogLines(vi.mocked(console.log)).join("\n"));
}

describe("omnyo explore command output", () => {
  setupCommandOutputTestEnvironment();

  it("browses all marketplace kinds without changing the public wire records", async () => {
    const fetch = fixtureFetch();
    await runCommand(["explore", "marketplace", "--json"], registrar(fetch));
    expect(parsedStdout()).toEqual({ items: MARKETPLACE_CATALOG.items });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://omnyohq.com/explore/marketplace.json?provider-setup=1",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
    });
  });

  it("combines marketplace search, category, publisher, and kind filters", async () => {
    await runCommand(
      [
        "explore",
        "marketplace",
        "--type",
        "connector",
        "--category",
        "Coding & architecture",
        "--publisher",
        "Omnyo",
        "--query",
        "GITHUB pull",
        "--json",
      ],
      registrar(fixtureFetch()),
    );
    expect(parsedStdout()).toEqual({ items: [MARKETPLACE_CATALOG.items[2]] });
  });

  it("prints marketplace types, publishers and absolute detail links", async () => {
    await runCommand(["explore", "marketplace"], registrar(fixtureFetch()));
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toMatch(/TYPE\s+TITLE\s+PUBLISHER\s+URL/);
    expect(output).toContain(
      "https://omnyohq.com/explore/plugins/workspace-github",
    );
    expect(output).toContain(
      "https://omnyohq.com/workflows/weekly-content-feed",
    );
  });

  it("reports an empty marketplace search", async () => {
    await runCommand(
      ["explore", "marketplace", "--query", "unmatched-result"],
      registrar(fixtureFetch()),
    );
    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
      "No Marketplace items match.",
    );
  });

  it.each([
    ["explore", "marketplace", "--text"],
    ["explore", "marketplace", "--type", "plugin"],
    ["explore", "marketplace", "--category", "Other"],
    ["explore", "skills", "--publisher", "Omnyo"],
    ["explore", "--category", "Agent workflows"],
  ])(
    "refuses unsupported marketplace option combinations before fetching: %s",
    async (...args) => {
      const fetch = fixtureFetch();
      await expect(runCommand(args, registrar(fetch))).rejects.toThrow(
        "process.exit:1",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["http", "schema"])(
    "reports marketplace %s failure without a fallback request",
    async (failure) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        failure === "http"
          ? new Response(null, { status: 503 })
          : new Response(JSON.stringify({ schemaVersion: 2, items: [] }), {
              headers: { "content-type": "application/json" },
            }),
      );

      await expect(
        runCommand(["explore", "marketplace", "--json"], registrar(fetch)),
      ).rejects.toThrow("process.exit:1");
      expect(parsedStdout()).toMatchObject({
        ok: false,
        error: { code: "explore_unavailable" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("lists every item as a table of key, title and absolute URL", async () => {
    await runCommand(["explore"], registrar(fixtureFetch()));

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toMatch(/KEY\s+TITLE\s+URL/);
    expect(output).toMatch(
      /workflow\/weekly-content-feed\s+Weekly content feed\s+https:\/\/omnyohq\.com\/workflows\/weekly-content-feed$/m,
    );
    expect(output).toMatch(
      /prompt\/review-a-product-update\s+Review a product update\s+https:\/\/omnyohq\.com\/explore\/prompts\/review-a-product-update$/m,
    );
    expect(output).toContain("plugin/browser-automation");
    expect(output).toContain("guide/run-an-agent-on-a-schedule");
    expect(output).toContain("skill/product-update-review");
  });

  it("prints items with an absolute url as JSON", async () => {
    await runCommand(["explore", "--json"], registrar(fixtureFetch()));

    expect(parsedStdout()).toEqual({
      items: CATALOG.items.map((item) => ({
        ...item,
        url: `https://omnyohq.com${item.path}`,
      })),
    });
  });

  it("filters by --type and --query", async () => {
    await runCommand(
      ["explore", "--type", "plugin", "--json"],
      registrar(fixtureFetch()),
    );

    expect(
      (parsedStdout() as { items: { slug: string }[] }).items.map(
        (item) => item.slug,
      ),
    ).toEqual(["browser-automation"]);

    vi.mocked(console.log).mockClear();
    await runCommand(
      ["explore", "--query", "  REVIEW   draft "],
      registrar(fixtureFetch()),
    );

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("prompt/review-a-product-update");
    expect(output).not.toContain("weekly-content-feed");
  });

  it("says when nothing matches and prints an empty JSON list", async () => {
    await runCommand(
      ["explore", "--query", "zzz-nothing"],
      registrar(fixtureFetch()),
    );
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "No Explore items match.",
    ]);

    vi.mocked(console.log).mockClear();
    await runCommand(
      ["explore", "--query", "zzz-nothing", "--json"],
      registrar(fixtureFetch()),
    );
    expect(parsedStdout()).toEqual({ items: [] });
  });

  it.each([
    [
      "prompt/review-a-product-update",
      [
        "Review a product update",
        "Type: prompt · By Omnyo",
        "Check a draft update before it ships.",
        "URL: https://omnyohq.com/explore/prompts/review-a-product-update",
        "Prompt text: omnyo explore prompt/review-a-product-update --text",
      ],
    ],
    [
      "workflow/weekly-content-feed",
      [
        "Weekly content feed",
        "Type: workflow · By Omnyo",
        "Collect links every week.",
        "URL: https://omnyohq.com/workflows/weekly-content-feed",
        "Get the workflow: https://omnyohq.com/workflows/weekly-content-feed#get-workflow",
      ],
    ],
    [
      "plugin/browser-automation",
      [
        "Browser Automation",
        "Type: plugin · By Omnyo",
        "Drive a browser from a chat.",
        "URL: https://omnyohq.com/explore/plugins/browser-automation",
        "Find it in Omnyo under Plugins, or run: omnyo plugin install browser-automation@omnyo-official",
      ],
    ],
    [
      "guide/run-an-agent-on-a-schedule",
      [
        "Run an agent on a schedule",
        "Type: guide · By Omnyo",
        "Automate recurring work.",
        "URL: https://omnyohq.com/guides/run-an-agent-on-a-schedule",
        "Read the guide: https://omnyohq.com/guides/run-an-agent-on-a-schedule",
      ],
    ],
    [
      "skill/product-update-review",
      [
        "Product Update Review",
        "Type: skill · By Omnyo",
        "Review a release draft.",
        "URL: https://omnyohq.com/explore/skills/product-update-review",
        "View the skill pack: https://omnyohq.com/explore/skills/product-update-review",
      ],
    ],
  ])("shows %s with its next step", async (key, lines) => {
    await runCommand(["explore", key], registrar(fixtureFetch()));

    expect(collectLogLines(vi.mocked(console.log))).toEqual(lines);
  });

  it("prints one item as JSON with an absolute url", async () => {
    await runCommand(
      ["explore", "plugin/browser-automation", "--json"],
      registrar(fixtureFetch()),
    );

    expect(parsedStdout()).toEqual({
      item: {
        ...CATALOG.items[2],
        url: "https://omnyohq.com/explore/plugins/browser-automation",
      },
    });
  });

  it("writes the prompt text byte for byte through one process.stdout.write call", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const fetchMock = fixtureFetch();

    await runCommand(
      ["explore", "prompt/review-a-product-update", "--text"],
      registrar(fetchMock),
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(PROMPT_TEXT);
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no key", ["explore", "--text"]],
    ["a non-prompt key", ["explore", "plugin/browser-automation", "--text"]],
    ["an invalid key", ["explore", "nope", "--text"]],
    [
      "--json",
      ["explore", "prompt/review-a-product-update", "--text", "--json"],
    ],
    [
      "--type",
      [
        "explore",
        "prompt/review-a-product-update",
        "--text",
        "--type",
        "prompt",
      ],
    ],
    [
      "--query",
      ["explore", "prompt/review-a-product-update", "--text", "--query", "x"],
    ],
  ])("rejects --text with %s before any request", async (_name, args) => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const fetchMock = fixtureFetch();

    await expect(runCommand(args, registrar(fetchMock))).rejects.toThrow(
      "process.exit:1",
    );

    expect(write).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --type with the valid types", async () => {
    const fetchMock = fixtureFetch();

    await expect(
      runCommand(
        ["explore", "--type", "video", "--json"],
        registrar(fetchMock),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(errorOutput()).toContain("prompt, workflow, skill, plugin, guide");
    expect(parsedStdout()).toMatchObject({
      ok: false,
      error: { code: "invalid_value" },
    });
  });

  it("rejects an invalid key and a key combined with filters", async () => {
    const fetchMock = fixtureFetch();

    await expect(
      runCommand(["explore", "Prompt/X"], registrar(fetchMock)),
    ).rejects.toThrow("process.exit:1");
    expect(errorOutput()).toContain("Invalid Explore key 'Prompt/X'");

    await expect(
      runCommand(
        ["explore", "prompt/review-a-product-update", "--type", "prompt"],
        registrar(fetchMock),
      ),
    ).rejects.toThrow("process.exit:1");

    await expect(
      runCommand(
        ["explore", "prompt/review-a-product-update", "--query", "x"],
        registrar(fetchMock),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing item as explore_not_found", async () => {
    await expect(
      runCommand(
        ["explore", "prompt/missing", "--json"],
        registrar(fixtureFetch()),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(parsedStdout()).toMatchObject({
      ok: false,
      error: { code: "explore_not_found" },
    });
  });

  it("reports an unpublished catalog as explore_unavailable with the URL and status", async () => {
    await expect(
      runCommand(
        ["explore", "--json"],
        registrar(fixtureFetch({ catalogStatus: 404 })),
      ),
    ).rejects.toThrow("process.exit:1");

    const envelope = parsedStdout() as {
      ok: boolean;
      error: { code: string; message: string; hint: string };
    };

    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("explore_unavailable");
    expect(envelope.error.message).toContain(
      "https://omnyohq.com/explore/catalog.json",
    );
    expect(envelope.error.message).toContain("HTTP 404");
    expect(envelope.error.hint).toContain("https://omnyohq.com");
    expect(errorOutput()).toContain("HTTP 404");
  });

  it("reports an unavailable prompt text route", async () => {
    await expect(
      runCommand(
        ["explore", "prompt/review-a-product-update", "--text"],
        registrar(fixtureFetch({ textStatus: 404 })),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(errorOutput()).toContain(
      "/explore/prompts/review-a-product-update/text",
    );
  });

  it("reports an unknown prompt key with --text as explore_not_found", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await expect(
      runCommand(
        ["explore", "prompt/review-a-product-updat", "--text"],
        registrar(fixtureFetch()),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(errorOutput()).toContain(
      "No Explore item 'prompt/review-a-product-updat'.",
    );
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("reports --text against an unpublished catalog as explore_unavailable", async () => {
    await expect(
      runCommand(
        ["explore", "prompt/review-a-product-update", "--text"],
        registrar(fixtureFetch({ catalogStatus: 404, textStatus: 404 })),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(errorOutput()).toContain("/explore/catalog.json");
    expect(errorOutput()).toContain("HTTP 404");
  });

  it("reports an invalid catalog as explore_unavailable", async () => {
    const badCatalog = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ schemaVersion: 1, items: [{}] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      runCommand(["explore", "--json"], registrar(badCatalog)),
    ).rejects.toThrow("process.exit:1");

    expect(parsedStdout()).toMatchObject({
      ok: false,
      error: { code: "explore_unavailable" },
    });
  });

  it("lists public source skills with their detail URL", async () => {
    const fetchMock = fixtureFetch();
    await runCommand(["explore", "skills"], registrar(fetchMock));
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toMatch(/SLUG\s+TITLE\s+PUBLISHER\s+URL/);
    expect(output).toContain("sample-review");
    expect(output).toContain(
      "https://omnyohq.com/explore/skills/source/sample-review",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("filters skills by words across publisher, category, and keywords and emits JSON", async () => {
    await runCommand(
      [
        "explore",
        "skills",
        "--query",
        " EXAMPLE security inspection ",
        "--json",
      ],
      registrar(fixtureFetch()),
    );
    expect(parsedStdout()).toEqual({ items: SKILLS_CATALOG.items });
  });

  it("reports empty skill matches in text and JSON", async () => {
    await runCommand(
      ["explore", "skills", "--query", "absent"],
      registrar(fixtureFetch()),
    );
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "No Explore skills match.",
    ]);
    vi.mocked(console.log).mockClear();
    await runCommand(
      ["explore", "skills", "--query", "absent", "--json"],
      registrar(fixtureFetch()),
    );
    expect(parsedStdout()).toEqual({ items: [] });
  });

  it.each(["text", "type"])(
    "rejects incompatible skill option %s before fetching",
    async (option) => {
      const flags = option === "text" ? ["--text"] : ["--type", "skill"];
      const fetchMock = fixtureFetch();
      await expect(
        runCommand(["explore", "skills", ...flags], registrar(fetchMock)),
      ).rejects.toThrow("process.exit:1");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("reports public skill catalog failures through explore_unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );

    await expect(
      runCommand(["explore", "skills", "--json"], registrar(fetchMock)),
    ).rejects.toThrow("process.exit:1");
    expect(parsedStdout()).toMatchObject({
      ok: false,
      error: { code: "explore_unavailable" },
    });
    expect(errorOutput()).toContain("/explore/skills/catalog.json");
  });

  it.each(["explore", "marketplace"])(
    "sends no Omnyo caller headers with the default %s fetch",
    async (mode) => {
      vi.stubEnv("OMNYO_THREAD_ID", "thread-secret");
      vi.stubEnv("OMNYO_AUTOMATION_ID", "automation-secret");
      vi.stubEnv("OMNYO_AUTOMATION_RUN_ID", "run-secret");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubEnv("https_proxy", "");
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("http_proxy", "");

      const globalFetch = vi.mocked(globalThis.fetch);

      globalFetch.mockImplementation(
        async () =>
          new Response(
            JSON.stringify(
              mode === "marketplace" ? MARKETPLACE_CATALOG : CATALOG,
            ),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );

      await runCommand(
        mode === "marketplace"
          ? ["explore", "marketplace", "--json"]
          : ["explore", "--json"],
        (program) => registerExploreCommand(program),
      );

      expect(globalFetch).toHaveBeenCalledTimes(1);
      const [url, init] = globalFetch.mock.calls[0];
      expect(new URL(String(url)).origin).toBe("https://omnyohq.com");
      expect(init?.headers).toEqual({ accept: "application/json" });
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
    },
  );
});
