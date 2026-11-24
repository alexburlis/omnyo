import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PLUGIN_CATALOG_CATEGORIES } from "@omnyo/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  omnyoOfficialShelfOrder,
  generateOmnyoOfficialMarketplace,
  parseOmnyoOfficialCatalogFields,
  readBundledPluginOverview,
  readPluginGitDates,
} from "../../../scripts/generate-omnyo-official-marketplace.js";
import {
  BUNDLED_MARKETPLACE_NAME,
  isBundledMarketplaceEntry,
  parseBundledMarketplaceManifestJson,
} from "../../../src/services/plugin-catalog/marketplace-manifest.js";
import { loadBundledMarketplace } from "../../../src/services/plugin-catalog/bundled-marketplace.js";
import {
  BUNDLED_PLUGINS,
  isBundledPluginEnabledByDefault,
} from "../../../src/services/plugins/builtin-registry.js";

const run = promisify(execFile);

const OMNYO_MADE_CORE_PLUGINS = new Set([
  "account-usage",
  "chat-importer",
  "composer-predictions",
  "environment-temporary-copy",
  "git",
  "wait-sources",
]);

const OMNYO_FORKS = new Set([
  "account-pool",
  "agent-annotations",
  "ask-user-question",
  "automations",
  "browser-automation",
  "concurrency-limit",
  "connect",
  "environment-project-checkout",
  "inline-vis",
  "keep-awake",
  "omnyo-account",
  "omnyo-guide",
  "prompt-library",
  "provider-claude-code",
  "provider-codex",
  "push-notifications",
  "scheduled-send",
  "side-chat",
  "thread-list",
]);

function expectedAuthor(plugin: (typeof BUNDLED_PLUGINS)[number]) {
  if (OMNYO_MADE_CORE_PLUGINS.has(plugin.name)) {
    return {
      name: "Omnyo",
      github: "alexburlis",
      url: "https://github.com/alexburlis",
    };
  }

  if (OMNYO_FORKS.has(plugin.name)) {
    return { name: "Omnyo", url: "https://omnyohq.com" };
  }

  return { name: "bb", github: "get-bb", url: "https://github.com/get-bb" };
}

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("Omnyo Official marketplace generator", () => {
  it("lists optional plugins before plugins on by default, each newest first", () => {
    expect(
      omnyoOfficialShelfOrder([
        {
          id: "new-included",
          onByDefault: true,
          publishedAt: "2026-10-09T00:00:00Z",
        },
        {
          id: "old-optional",
          onByDefault: false,
          publishedAt: "2026-07-01T00:00:00Z",
        },
        { id: "undated-optional", onByDefault: false },
        {
          id: "old-included",
          onByDefault: true,
          publishedAt: "2026-07-01T00:00:00Z",
        },
        {
          id: "new-optional",
          onByDefault: false,
          publishedAt: "2026-10-01T00:00:00Z",
        },
      ]),
    ).toEqual([
      "new-optional",
      "old-optional",
      "undated-optional",
      "new-included",
      "old-included",
    ]);
  });

  it("generates one valid v2 entry for every bundled plugin", async () => {
    const raw = await readFile(
      new URL(
        "../../../src/generated/omnyo-official-marketplace/marketplace.json",
        import.meta.url,
      ),
      "utf8",
    );

    const catalog = parseBundledMarketplaceManifestJson(
      raw,
      "generated marketplace",
    );

    const fields = parseOmnyoOfficialCatalogFields(
      JSON.parse(
        await readFile(
          new URL(
            "../../../../../plugins/omnyo-official.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
      BUNDLED_PLUGINS,
    );

    expect(catalog.name).toBe(BUNDLED_MARKETPLACE_NAME);
    expect(catalog.displayName).toBe("Omnyo Official");
    expect(catalog.categories).toEqual(PLUGIN_CATALOG_CATEGORIES);
    expect(catalog.plugins).toHaveLength(BUNDLED_PLUGINS.length);
    expect(catalog.collections).toEqual([
      {
        id: "omnyo-official",
        displayName: "Omnyo Official",
        pluginIds: omnyoOfficialShelfOrder(
          catalog.plugins.map((entry) => {
            const plugin = BUNDLED_PLUGINS.find(
              (candidate) => candidate.pluginId === entry.id,
            );

            return {
              id: entry.id,
              onByDefault:
                plugin !== undefined &&
                plugin.autoInstall &&
                isBundledPluginEnabledByDefault(plugin),
              ...(entry.publishedAt === undefined
                ? {}
                : { publishedAt: entry.publishedAt }),
            };
          }),
        ),
      },
    ]);

    for (const plugin of BUNDLED_PLUGINS) {
      const entry = catalog.plugins.find(
        (candidate) =>
          isBundledMarketplaceEntry(candidate) &&
          candidate.source.bundled.plugin === plugin.name,
      );

      expect(entry?.id).toBe(plugin.pluginId);
      expect(entry?.screenshots).toEqual(fields[plugin.name]?.screenshots);
      expect(entry?.author).toEqual(expectedAuthor(plugin));

      if (OMNYO_FORKS.has(plugin.name)) {
        expect(entry?.overview).toContain("Michael Yong");
        expect(entry?.overview).toContain("MIT");
        expect(entry?.overview).toContain("https://github.com/get-bb/bb/");
      }
    }
  });

  it("rejects missing and unknown catalog blocks", () => {
    const plugins = [
      { name: "alpha", pluginId: "alpha" },
      { name: "beta", pluginId: "beta" },
    ];

    const block = { category: "utilities", screenshots: [] };

    expect(() =>
      parseOmnyoOfficialCatalogFields({ alpha: block }, plugins),
    ).toThrow(/missing bundled plugin blocks: beta/u);
    expect(() =>
      parseOmnyoOfficialCatalogFields(
        { alpha: block, beta: block, gamma: block },
        plugins,
      ),
    ).toThrow(/unknown bundled plugin blocks: gamma/u);
  });

  it("folds a bundled plugin PLUGIN_OVERVIEW.md into its entry and rejects unsafe text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "omnyo-official-overview-"));
    cleanup.push(root);
    const pluginDirectory = path.join(root, "plugins", "sample");
    await mkdir(pluginDirectory, { recursive: true });

    expect(await readBundledPluginOverview(pluginDirectory, "sample")).toBe(
      undefined,
    );

    await writeFile(
      path.join(pluginDirectory, "PLUGIN_OVERVIEW.md"),
      "\uFEFF# Sample\r\n\r\nDoes one thing.  \r\n\r\n",
    );
    expect(await readBundledPluginOverview(pluginDirectory, "sample")).toBe(
      "# Sample\n\nDoes one thing.\n",
    );

    await writeFile(
      path.join(pluginDirectory, "PLUGIN_OVERVIEW.md"),
      "Run `omnyo keep-awake hosts <host-id>`.\n\n```sh\n<not html>\n```\n",
    );
    expect(
      await readBundledPluginOverview(pluginDirectory, "sample"),
    ).toContain("<host-id>");

    for (const [text, message] of [
      ["\n\n", /empty PLUGIN_OVERVIEW\.md/u],
      [`${"a".repeat(4001)}\n`, /maximum is 4000/u],
      ["Text <b>bold</b>\n", /raw HTML or an image/u],
      ["![logo](https://example.com/logo.png)\n", /raw HTML or an image/u],
    ] as const) {
      await writeFile(path.join(pluginDirectory, "PLUGIN_OVERVIEW.md"), text);
      await expect(
        readBundledPluginOverview(pluginDirectory, "sample"),
      ).rejects.toThrow(message);
    }
  });

  it("names the generator task when the generated document is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "omnyo-official-missing-"));
    cleanup.push(root);

    expect(() => loadBundledMarketplace([], root)).toThrow(
      "pnpm exec turbo run generate:omnyo-official-marketplace --filter=@omnyo/server",
    );
  });

  it("uses the first and last committer dates from plugin history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "omnyo-official-history-"));
    cleanup.push(root);
    const pluginDirectory = path.join(root, "plugins", "sample");
    await mkdir(pluginDirectory, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: root });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(path.join(pluginDirectory, "file.txt"), "one");
    await run("git", ["add", "."], { cwd: root });
    await run("git", ["commit", "-qm", "first"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
        GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
      },
    });
    await writeFile(path.join(pluginDirectory, "file.txt"), "two");
    await run("git", ["commit", "-qam", "last"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-02-03T04:05:06Z",
        GIT_COMMITTER_DATE: "2026-02-03T04:05:06Z",
      },
    });

    const dates = await readPluginGitDates({
      repositoryRoot: root,
      revision: "HEAD",
      pathPrefix: "plugins/",
      plugins: [{ name: "sample", pluginId: "sample" }],
      warn: (message) => {
        throw new Error(message);
      },
    });

    expect(dates.get("sample")).toEqual({
      publishedAt: "2026-01-02T03:04:05Z",
      updatedAt: "2026-02-03T04:05:06Z",
    });
  });

  it("omits dates and prints one warning in a shallow repository", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "omnyo-official-generator-"),
    );

    cleanup.push(root);
    const origin = path.join(root, "origin");
    const checkout = path.join(root, "checkout");
    await mkdir(path.join(origin, "plugins", "sample"), { recursive: true });
    await writeFile(
      path.join(origin, "plugins", "sample", "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-sample",
        version: "1.0.0",
        author: {
          name: "alexburlis",
          url: "https://github.com/alexburlis",
        },
        omnyo: {
          name: "Sample",
          description: "A sample plugin.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      path.join(origin, "plugins", "sample", "PLUGIN_OVERVIEW.md"),
      "# Sample\n\nA long-form description.\n",
    );
    await writeFile(
      path.join(origin, "plugins", "omnyo-official.json"),
      JSON.stringify({
        sample: { category: "utilities", screenshots: [] },
      }),
    );
    await run("git", ["init", "-q", "-b", "main"], { cwd: origin });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: origin,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: origin });
    await run("git", ["add", "."], { cwd: origin });
    await run("git", ["commit", "-qm", "initial"], { cwd: origin });
    await writeFile(
      path.join(origin, "plugins", "sample", "server.ts"),
      "export {};\n",
    );
    await run("git", ["add", "."], { cwd: origin });
    await run("git", ["commit", "-qm", "update"], { cwd: origin });
    await run(
      "git",
      ["clone", "-q", "--depth=1", pathToFileURL(origin).href, checkout],
      { cwd: root },
    );
    const warnings: string[] = [];
    const outputPath = path.join(checkout, "marketplace.json");

    await generateOmnyoOfficialMarketplace({
      repositoryRoot: checkout,
      catalogFieldsPath: path.join(checkout, "plugins", "omnyo-official.json"),
      outputPath,
      plugins: [
        {
          name: "sample",
          pluginId: "sample",
          autoInstall: true,
          defaultEnabled: true,
        },
      ],
      warn: (message) => warnings.push(message),
    });

    const catalog = parseBundledMarketplaceManifestJson(
      await readFile(outputPath, "utf8"),
      "shallow marketplace",
    );

    expect(catalog.plugins[0]).not.toHaveProperty("publishedAt");
    expect(catalog.plugins[0]?.author).toEqual({
      name: "alexburlis",
      github: "alexburlis",
      url: "https://github.com/alexburlis",
    });
    expect(catalog.plugins[0]).not.toHaveProperty("updatedAt");
    expect(catalog.plugins[0]?.overview).toBe(
      "# Sample\n\nA long-form description.\n",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/complete Git history is unavailable/u);
  });
});
