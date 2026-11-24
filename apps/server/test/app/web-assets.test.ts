import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { webAssetManifestSchema } from "@omnyo/server-contract";
import { createApp } from "../../src/server.js";
import { WebUpdateService } from "../../src/services/system/web-update.js";
import { readJson } from "../helpers/json.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const COMPATIBILITY_HASH = "b".repeat(64);

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
}

function shell(boot: string): string {
  return `<!doctype html><html><head><script>window.inline = 1;</script><script type="module" crossorigin src="${boot}"></script><link rel="stylesheet" crossorigin href="/assets/app-CCCCCCCC.css"></head></html>`;
}

interface BuildFile {
  path: string;
  content: string;
}

function writeBuild(args: {
  sourceCommit: string;
  files: BuildFile[];
  shellRoot: (generation: string) => string;
  assetRoot: string;
}): string {
  const build = {
    schema: 1,
    sourceCommit: args.sourceCommit,
    compatibilityHash: COMPATIBILITY_HASH,
    files: args.files.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.content),
      sha256: sha256(file.content),
    })),
  };

  const generation = sha256(JSON.stringify(build));
  const shellRoot = args.shellRoot(generation);

  for (const file of args.files) {
    const target = join(
      file.path.startsWith("assets/") ? args.assetRoot : shellRoot,
      file.path,
    );

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }

  writeFileSync(join(shellRoot, "web-build.json"), JSON.stringify(build));

  return generation;
}

function generationFiles(boot: string): BuildFile[] {
  return [
    { path: "index.html", content: shell(boot) },
    { path: boot.slice(1), content: `console.log("${boot}");` },
    { path: `${boot.slice(1)}.br`, content: "compressed" },
    { path: "assets/app-CCCCCCCC.css", content: "body{}" },
    { path: "assets/Chat-DDDDDDDD.js", content: "export const chat = 1;" },
    { path: "apple-touch-icon.png", content: "png" },
  ];
}

it("publishes the packaged web version's files with an ETag that answers 304", async () => {
  const harness = await createTestAppHarness();
  const staticDir = temporaryDirectory("omnyo-web-assets-");

  const generation = writeBuild({
    sourceCommit: "a".repeat(40),
    files: generationFiles("/assets/boot-app-AAAAAAAA.js"),
    shellRoot: () => staticDir,
    assetRoot: staticDir,
  });

  const { app } = createApp(harness.deps, { staticDir });

  try {
    const response = await app.request("/api/v1/system/web-assets");

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"${generation}"`);
    expect(webAssetManifestSchema.parse(await readJson(response))).toEqual({
      generation,
      boot: ["/assets/boot-app-AAAAAAAA.js", "/assets/app-CCCCCCCC.css"],
      assets: [
        { path: "/assets/boot-app-AAAAAAAA.js", bytes: 44 },
        { path: "/assets/app-CCCCCCCC.css", bytes: 6 },
        { path: "/assets/Chat-DDDDDDDD.js", bytes: 22 },
      ],
    });

    const unchanged = await app.request("/api/v1/system/web-assets", {
      headers: { "if-none-match": `"${generation}"` },
    });

    expect(unchanged.status).toBe(304);

    const machine = await app.request("/api/v1/system/web-assets", {
      headers: { "x-omnyo-gate-auth": "machine" },
    });

    expect(machine.status).toBe(200);
  } finally {
    await harness.cleanup();
  }
});

it("announces each active web version change and publishes that version's files", async () => {
  const dataDir = temporaryDirectory("omnyo-web-assets-data-");
  const staticDir = temporaryDirectory("omnyo-web-assets-static-");
  const updates = join(dataDir, "private-web-updates");

  const baselineId = writeBuild({
    sourceCommit: "a".repeat(40),
    files: generationFiles("/assets/boot-app-AAAAAAAA.js"),
    shellRoot: () => staticDir,
    assetRoot: staticDir,
  });

  const generationRoot = (id: string) => join(updates, "generations", id);

  const first = writeBuild({
    sourceCommit: "c".repeat(40),
    files: generationFiles("/assets/boot-app-EEEEEEEE.js"),
    shellRoot: generationRoot,
    assetRoot: join(updates, "public"),
  });

  const second = writeBuild({
    sourceCommit: "d".repeat(40),
    files: generationFiles("/assets/boot-app-FFFFFFFF.js"),
    shellRoot: generationRoot,
    assetRoot: join(updates, "public"),
  });

  writeFileSync(
    join(updates, "active.json"),
    JSON.stringify({
      baselineId,
      compatibilityHash: COMPATIBILITY_HASH,
      active: { id: second, sourceCommit: "d".repeat(40) },
      previous: { id: first, sourceCommit: "c".repeat(40) },
    }),
  );

  const onActiveChanged = vi.fn();

  const service = new WebUpdateService(
    dataDir,
    staticDir,
    () => false,
    onActiveChanged,
  );

  await expect(service.assetManifest()).resolves.toMatchObject({
    generation: second,
    boot: ["/assets/boot-app-FFFFFFFF.js", "/assets/app-CCCCCCCC.css"],
  });

  await service.rollback({ expectedActive: second });

  expect(onActiveChanged).toHaveBeenCalledOnce();
  await expect(service.assetManifest()).resolves.toMatchObject({
    generation: first,
    boot: ["/assets/boot-app-EEEEEEEE.js", "/assets/app-CCCCCCCC.css"],
  });
});
