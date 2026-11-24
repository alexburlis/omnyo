import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { expect, it } from "vitest";
import { routeModulePreload } from "../vite-route-modulepreload";

type PreloadLink = {
  rel?: string;
  href?: string;
  crossOrigin?: string | boolean;
  setAttribute: (name: string, value: string) => void;
};

function runRoutePreloadGate(source: string, pathname: string): string[] {
  const links: PreloadLink[] = [];

  const document = {
    createElement: (_tag: string): PreloadLink => ({
      setAttribute(name, value) {
        Object.assign(this, { [name]: value });
      },
    }),
    head: {
      append: (...nodes: PreloadLink[]) => links.push(...nodes),
      appendChild: (node: PreloadLink) => links.push(node),
    },
  };

  const location = { pathname };
  runInNewContext(source, { document, location, window: { location } });

  return links.map((link) => link.href ?? "");
}

it("preloads the workspace closure only when the shared route decision accepts the path", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-route-preload-")),
  );

  try {
    await Promise.all(
      Object.entries({
        "index.html": '<script type="module" src="/main.js"></script>',
        "main.js":
          'import { value } from "./shared.js"; window.value = value; window.route = import("./route.js"); window.thread = () => import("./src/views/thread-detail/ThreadDetailView.tsx"); window.other = () => import("./other.js"); window.plugin = () => import("./plugin-runtime.js");',
        "shared.js": "export const value = Math.random();",
        "route.js":
          'import { value } from "./shared.js"; import { extra } from "./route-dep.js"; window.routeLazy = () => import("./route-lazy.js"); export default value + extra;',
        "route-dep.js": "export const extra = Math.random();",
        "route-lazy.js": "window.routeLazy = true;",
        "other.js": "window.other = true;",
        "plugin-runtime.js":
          'import { extra } from "./route-dep.js"; import { runtime } from "./runtime-dep.js"; window.pluginExecuted = extra + runtime;',
        "runtime-dep.js": "export const runtime = Math.random();",
        "src/views/thread-detail/ThreadDetailView.tsx":
          'import { value } from "../../../shared.js"; import { extra } from "../../../thread-only.js"; window.threadLazy = () => import("../../../route-lazy.js"); window.threadValue = value + extra;',
        "thread-only.js": "export const extra = Math.random();",
      }).map(async ([name, source]) => {
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), source);
      }),
    );

    const result = await build({
      root,
      base: "/app/",
      configFile: false,
      logLevel: "silent",
      plugins: [routeModulePreload("route.js", ["plugin-runtime.js"])],
      build: {
        minify: false,
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (id.endsWith("/route-dep.js")) return "route-dep";

              if (id.endsWith("/runtime-dep.js")) return "runtime-dep";

              return undefined;
            },
          },
        },
      },
    });

    if (Array.isArray(result) || !("output" in result))
      throw new Error("Expected one emitted application bundle");

    const entryChunk = result.output.find(
      (chunk) => chunk.type === "chunk" && chunk.isEntry,
    );

    const runtimeChunk = result.output.find(
      (chunk) =>
        chunk.type === "chunk" &&
        Object.keys(chunk.modules).some((id) =>
          id.endsWith("/plugin-runtime.js"),
        ),
    );

    if (entryChunk?.type !== "chunk" || runtimeChunk?.type !== "chunk")
      throw new Error("Missing entry or runtime chunk");
    expect(entryChunk.imports).not.toContain(runtimeChunk.fileName);
    const html = await readFile(join(root, "dist/index.html"), "utf8");

    const staticPreloads = [
      ...html.matchAll(
        /<link rel="modulepreload" crossorigin href="([^"]+)">/g,
      ),
    ].map((match) => match[1] ?? "");

    const gateSource = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g),
    ]
      .map((match) => ({ attrs: match[1] ?? "", source: match[2] ?? "" }))
      .find(
        ({ attrs, source }) =>
          !/\bsrc=/u.test(attrs) && source.includes("modulepreload"),
      )?.source;

    expect(gateSource).toBeDefined();
    expect(
      staticPreloads.some((href) => /\/route-[\w-]+\.js$/.test(href)),
    ).toBe(false);

    const routePreloads = runRoutePreloadGate(gateSource ?? "", "/");
    expect(routePreloads.some((href) => /\/route-[\w-]+\.js$/.test(href))).toBe(
      true,
    );
    expect(
      routePreloads.some((href) => href.endsWith("/" + runtimeChunk.fileName)),
    ).toBe(true);
    expect(routePreloads.some((href) => href.includes("runtime-dep"))).toBe(
      true,
    );
    expect(routePreloads.some((href) => href.includes("route-dep"))).toBe(true);
    expect(routePreloads.some((href) => href.includes("shared"))).toBe(false);
    expect(routePreloads.some((href) => href.includes("route-lazy"))).toBe(
      false,
    );
    expect(routePreloads.some((href) => href.includes("other"))).toBe(false);
    expect(new Set(routePreloads).size).toBe(routePreloads.length);

    expect(
      routePreloads.some((href) => /\/ThreadDetailView-[\w-]+\.js$/.test(href)),
    ).toBe(false);

    const threadPreloads = runRoutePreloadGate(
      gateSource ?? "",
      "/threads/thr_direct",
    );

    expect(
      threadPreloads.some((href) =>
        /\/ThreadDetailView-[\w-]+\.js$/.test(href),
      ),
    ).toBe(true);
    expect(threadPreloads).toEqual(expect.arrayContaining(routePreloads));
    expect(threadPreloads.some((href) => href.includes("route-lazy"))).toBe(
      false,
    );
    expect(new Set(threadPreloads).size).toBe(threadPreloads.length);

    for (const href of routePreloads) {
      expect(href.startsWith("/app/assets/")).toBe(true);
    }

    for (const [pathname, shouldPreload] of [
      ["/", true],
      ["/projects/proj_direct", true],
      ["/threads/thr_direct", true],
      ["/projects/proj_direct/threads/thr_direct", true],
      ["/plugins/github/panel/work/today.md", true],
      ["/unknown-route", true],
      ["/settings", false],
      ["/extensions/plugins", false],
      ["/tools/automations", false],
      ["/archived", false],
      ["/projects/proj_direct/archived", false],
      ["/plugins/github", false],
      ["/auth/callback", false],
    ] as const) {
      const preloads = runRoutePreloadGate(gateSource ?? "", pathname);
      expect(preloads.length > 0).toBe(shouldPreload);
      const threadPath = pathname.includes("/threads/");
      expect(preloads).toEqual(
        shouldPreload ? (threadPath ? threadPreloads : routePreloads) : [],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
