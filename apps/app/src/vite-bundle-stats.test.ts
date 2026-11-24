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
import { build } from "vite";
import { expect, it } from "vitest";
import { bundleStats, type BundleStats } from "../vite-bundle-stats";
import { startupChunks } from "../vite-startup-chunks";

it("records emitted HTML boot scripts after Vite removes import-only entries", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-bundle-stats-")),
  );

  try {
    const sources = {
      "bundle-budget.json": '{"onDemandPackages":{}}',
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": [
        'import { value } from "./shared.ts";',
        "globalThis.fixture = value;",
        'globalThis.start = () => import("./app-entry.tsx");',
      ].join("\n"),
      "src/shared.ts": "export const value = 17;",
      "src/app-entry.tsx": [
        'import { value } from "./shared.ts";',
        "globalThis.fixture = value + 1;",
      ].join("\n"),
    };

    await Promise.all(
      Object.entries(sources).map(async ([name, source]) => {
        const path = join(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, source);
      }),
    );

    await build({
      root,
      base: "/app/",
      configFile: false,
      logLevel: "silent",
      plugins: [startupChunks(), bundleStats()],
      build: {
        minify: false,
        chunkImportMap: true,
      },
    });

    const stats: BundleStats = JSON.parse(
      await readFile(join(root, "bundle-stats.json"), "utf8"),
    );

    expect(stats.bootChunks.length).toBeGreaterThan(0);
    expect(
      stats.bootChunks.some((chunk) => chunk.fileName === stats.entry),
    ).toBe(true);

    const app = stats.chunks.find((chunk) =>
      chunk.appModules.includes("src/app-entry.tsx"),
    );

    expect(app).toBeDefined();
    expect(stats.bootChunks.map((chunk) => chunk.fileName)).not.toContain(
      app?.fileName,
    );
    expect(
      stats.routeClosures.AppShell?.chunks.map((chunk) => chunk.fileName),
    ).toContain(app?.fileName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
