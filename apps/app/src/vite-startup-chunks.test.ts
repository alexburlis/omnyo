import { execFile } from "node:child_process";
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
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, type Rollup } from "vite";
import { expect, it } from "vitest";
import { startupChunks } from "../vite-startup-chunks";
import { bundleStats, type BundleStats } from "../vite-bundle-stats";

const execute = promisify(execFile);

function staticClosure(
  chunks: readonly Rollup.OutputChunk[],
  entry: Rollup.OutputChunk,
): Set<string> {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const visited = new Set<string>();

  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);

    for (const imported of byName.get(name)?.imports ?? []) visit(imported);
  };

  visit(entry.fileName);

  return visited;
}

it("bundles startup roots while preserving deferred execution and heavy feature imports", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-startup-chunks-")),
  );

  try {
    const sources = {
      "package.json": '{"type":"module"}',
      "bundle-budget.json": JSON.stringify({
        onDemandPackages: { "lazy-math": "src/heavy.ts" },
      }),
      "node_modules/lazy-math/package.json":
        '{"name":"lazy-math","type":"module","exports":"./index.js","sideEffects":false}',
      "node_modules/lazy-math/index.js": "export const heavyMath = 4;",
      "src/math-barrel.ts":
        'export const math = 0; export { heavyMath } from "lazy-math";',
      "src/main.ts": [
        'import { shared } from "./shared.ts";',
        "globalThis.startupProbe = ['boot'];",
        "export const value = shared;",
        'export const start = () => import("./app-entry.tsx");',
      ].join("\n"),
      "src/shared.ts": "export const shared = 17;",
      "src/shell.ts":
        'import { shared } from "./shared.ts"; export const shell = shared + 1;',
      "src/app-entry.tsx": [
        'import { shell } from "./shell.ts";',
        "globalThis.startupProbe.push('app');",
        "export const value = shell;",
        'export const workspace = () => import("./views/SplitWorkspaceRoute.tsx");',
        'export const plugin = () => import("./lib/plugin-frontend.ts");',
      ].join("\n"),
      "src/layout.ts":
        'import { shared } from "./shared.ts"; export const layout = shared + 2;',
      "src/views/SplitWorkspaceRoute.tsx": [
        'import { layout } from "../layout.ts";',
        "globalThis.startupProbe.push('workspace');",
        "export const value = layout;",
        'export const thread = () => import("./thread-detail/ThreadDetailView.tsx");',
        'export const compose = () => import("./RootComposeView.tsx");',
      ].join("\n"),
      "src/composer.ts":
        'import { layout } from "./layout.ts"; export const composer = layout + 1;',
      "src/views/thread-detail/ThreadDetailView.tsx": [
        'import { composer } from "../../composer.ts";',
        'import { math } from "../../math-barrel.ts";',
        "globalThis.startupProbe.push('thread');",
        "export const value = composer + math;",
        'export const heavy = () => import("../../heavy.ts");',
      ].join("\n"),
      "src/views/RootComposeView.tsx": [
        'import { composer } from "../composer.ts";',
        "globalThis.startupProbe.push('compose');",
        "export const value = composer + 1;",
      ].join("\n"),
      "src/lib/plugin-frontend.ts": [
        'import { composer } from "../composer.ts";',
        "globalThis.startupProbe.push('plugin');",
        "export const value = composer + 2;",
      ].join("\n"),
      "src/heavy.ts": [
        'import { composer } from "./composer.ts";',
        'import { heavyMath } from "lazy-math";',
        "globalThis.startupProbe.push('heavy');",
        "export const value = composer + heavyMath - 1;",
      ].join("\n"),
    };

    await Promise.all(
      Object.entries(sources).map(async ([name, source]) => {
        const path = join(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, source);
      }),
    );

    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [startupChunks(), bundleStats()],
      build: {
        minify: false,
        modulePreload: false,
        target: "esnext",
        rolldownOptions: {
          input: join(root, "src/main.ts"),
          preserveEntrySignatures: "allow-extension",
          output: {
            entryFileNames: "main.mjs",
            chunkFileNames: "[name].mjs",
          },
        },
      },
    });

    if (Array.isArray(result) || !("output" in result))
      throw new Error("Expected one emitted startup bundle");

    const chunks = result.output.filter(
      (chunk): chunk is Rollup.OutputChunk => chunk.type === "chunk",
    );

    const stats: BundleStats = JSON.parse(
      await readFile(join(root, "bundle-stats.json"), "utf8"),
    );

    expect(
      stats.chunks.some((chunk) =>
        chunk.appModules.includes("src/app-entry.tsx"),
      ),
    ).toBe(true);

    const chunkFor = (suffix: string) => {
      const found = chunks.find((chunk) =>
        Object.keys(chunk.modules).some((id) => id.endsWith(suffix)),
      );

      if (!found) throw new Error(`Missing startup module ${suffix}`);

      return found;
    };

    const boot = chunkFor("/src/main.ts");
    const app = chunkFor("/src/app-entry.tsx");
    const workspace = chunkFor("/src/views/SplitWorkspaceRoute.tsx");
    const thread = chunkFor("/src/views/thread-detail/ThreadDetailView.tsx");
    const compose = chunkFor("/src/views/RootComposeView.tsx");
    const plugin = chunkFor("/src/lib/plugin-frontend.ts");
    const heavy = chunkFor("/src/heavy.ts");
    const lazyMath = chunkFor("/node_modules/lazy-math/index.js");

    expect(app.fileName).toBe("startup-shell.mjs");
    expect(workspace.fileName).toBe("startup-workspace.mjs");
    expect(thread.fileName).toBe("startup-thread.mjs");
    expect(compose.fileName).toBe("startup-compose.mjs");
    expect(plugin.fileName).toBe("startup-plugins.mjs");
    expect(staticClosure(chunks, boot)).not.toContain(app.fileName);

    for (const entry of [app, workspace, thread, compose, plugin]) {
      expect(staticClosure(chunks, entry)).not.toContain(heavy.fileName);
      expect(staticClosure(chunks, entry)).not.toContain(lazyMath.fileName);
      expect(staticClosure(chunks, entry).size).toBeLessThanOrEqual(6);
    }

    const entryUrl = pathToFileURL(join(root, "dist/main.mjs")).href;

    const script = [
      `const main = await import(${JSON.stringify(entryUrl)});`,
      "const snapshots = [globalThis.startupProbe.slice()];",
      "const app = await main.start(); snapshots.push(globalThis.startupProbe.slice());",
      "const workspace = await app.workspace();",
      "const thread = await workspace.thread(); snapshots.push(globalThis.startupProbe.slice());",
      "const compose = await workspace.compose();",
      "const plugin = await app.plugin(); snapshots.push(globalThis.startupProbe.slice());",
      "const heavy = await thread.heavy(); snapshots.push(globalThis.startupProbe.slice());",
      "console.log(JSON.stringify({snapshots, values: [main.value, app.value, workspace.value, thread.value, compose.value, plugin.value, heavy.value]}));",
    ].join("\n");

    const { stdout } = await execute(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { timeout: 5000 },
    );

    expect(JSON.parse(stdout)).toEqual({
      snapshots: [
        ["boot"],
        ["boot", "app"],
        ["boot", "app", "workspace", "thread"],
        ["boot", "app", "workspace", "thread", "compose", "plugin"],
        ["boot", "app", "workspace", "thread", "compose", "plugin", "heavy"],
      ],
      values: [17, 18, 19, 20, 21, 22, 23],
    });

    for (const [load, expected] of [
      [
        "const workspace = await app.workspace(); await workspace.compose();",
        ["boot", "app", "workspace", "compose"],
      ],
      ["await app.plugin();", ["boot", "app", "plugin"]],
    ]) {
      const { stdout: independent } = await execute(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const main = await import(${JSON.stringify(entryUrl)}); const app = await main.start(); ${load} console.log(JSON.stringify(globalThis.startupProbe));`,
        ],
        { timeout: 5000 },
      );

      expect(JSON.parse(independent)).toEqual(expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
