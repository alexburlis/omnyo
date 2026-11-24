import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { splitPrefetch } from "../vite-split-prefetch";

async function buildSplitManifest(sources: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnyo-prefetch-")));

  try {
    await Promise.all(
      Object.entries(sources).map(([name, source]) =>
        writeFile(join(root, name), source),
      ),
    );
    await build({
      root,
      base: "/app/",
      configFile: false,
      logLevel: "silent",
      plugins: [splitPrefetch()],
      build: { minify: false },
    });
    const html = await readFile(join(root, "dist/index.html"), "utf8");

    const source = html.match(
      /id="omnyo-prefetch-manifest">([^<]+)<\/script>/,
    )?.[1];

    expect(source).toBeDefined();

    const manifest: { files: string[]; splits: Record<string, number[]> } =
      JSON.parse(source!);

    for (const url of manifest.files) {
      expect(url.startsWith("/app/assets/")).toBe(true);
      expect(
        await readFile(join(root, "dist", url.slice("/app/".length)), "utf8"),
      ).not.toBe("");
    }

    return {
      html,
      urls: (id: string) =>
        (manifest.splits[id] ?? []).map((index) => manifest.files[index]),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("lists a split's module and static dependencies, minus what the page loads at boot", async () => {
  const { html, urls } = await buildSplitManifest({
    "index.html": '<script type="module" src="/main.js"></script>',
    "main.js": [
      'import { value } from "./shared.js";',
      "function defineSplit(options) { window[options.id] = options; }",
      "window.value = value;",
      'defineSplit({ id: "heavy", load: () => import("./heavy.js") });',
      'window.other = () => import("./other.js");',
    ].join("\n"),
    "shared.js": "export const value = Math.random();",
    "heavy.js":
      'import { value } from "./shared.js"; window.heavyExecuted = true; export default value;',
    "other.js": "window.otherExecuted = true;",
  });

  const heavy = urls("heavy");
  expect(heavy.some((url) => /\/heavy-[\w-]+\.js$/.test(url))).toBe(true);
  expect(heavy.some((url) => /\/index-[\w-]+\.js$/.test(url))).toBe(false);
  expect(heavy.some((url) => url?.includes("other-"))).toBe(false);
  expect(html).not.toMatch(/<link[^>]+href="[^"]*heavy-/);
});

it("finds every defineSplit and lists the chunks its import needs", async () => {
  const { urls } = await buildSplitManifest({
    "index.html": '<script type="module" src="/main.ts"></script>',
    "main.ts": [
      "function defineSplit<P>(options: { id: string; load: () => Promise<P> }) { Reflect.set(window, options.id, options); }",
      'defineSplit<() => number>({ id: "lazy-panel", load: () => import("./panel.js").then((module) => module.Panel) });',
      'defineSplit({ id: "lazy-other", load: () => import("./other.js") });',
    ].join("\n"),
    "widgets.js": "export const widget = () => Math.random();",
    "panel.js":
      'import { widget } from "./widgets.js"; export const Panel = () => widget();',
    "other.js":
      'import { widget } from "./widgets.js"; export default () => widget() + 1;',
  });

  const panel = urls("lazy-panel");
  expect(panel.some((url) => /\/panel-[\w-]+\.js$/.test(url))).toBe(true);
  expect(panel.some((url) => /\/widgets-[\w-]+\.js$/.test(url))).toBe(true);
  expect(panel.some((url) => url?.includes("other-"))).toBe(false);
  expect(panel.some((url) => /\/index-[\w-]+\.js$/.test(url))).toBe(false);
  expect(urls("lazy-other").some((url) => url?.includes("other-"))).toBe(true);
});
