import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNodeEsmEntry,
  pruneUnreferencedChunks,
} from "../../../scripts/build-utils.mjs";

describe("pruneUnreferencedChunks", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers the native image codec to the packaged runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "omnyo-native-codec-"));
    tempDirs.push(root);
    const entry = join(root, "entry.mjs");
    const outfile = join(root, "dist", "codec.mjs");
    writeFileSync(entry, 'export const imageCodec = () => import("sharp");\n');

    await buildNodeEsmEntry({
      cleanDist: false,
      entryPoint: entry,
      outfile,
      packageRoot: root,
    });

    const module = await import(pathToFileURL(outfile).href);
    await expect(module.imageCodec()).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
  });

  it("keeps the chunks the entry reaches and removes a previous build's", async () => {
    const dist = mkdtempSync(join(tmpdir(), "omnyo-prune-chunks-"));
    tempDirs.push(dist);
    const chunkDir = join(dist, "omnyo-chunks");
    mkdirSync(chunkDir);
    const entry = join(dist, "omnyo");

    writeFileSync(
      entry,
      '#!/usr/bin/env node\nimport{a as U}from"./omnyo-chunks/chunk-A.js";U(()=>import("./omnyo-chunks/thread-B.js"));\n',
    );
    writeFileSync(
      join(chunkDir, "chunk-A.js"),
      'import{b}from"./chunk-C.js";export{b as a};\n',
    );
    writeFileSync(
      join(chunkDir, "thread-B.js"),
      'export * from "./chunk-A.js";\nimport"./chunk-D.js";\n',
    );
    writeFileSync(
      join(chunkDir, "chunk-C.js"),
      'import"./chunk-A.js";export var b=1;\n',
    );
    writeFileSync(join(chunkDir, "chunk-C.js.map"), "{}");
    writeFileSync(join(chunkDir, "chunk-D.js"), "export var d=1;\n");

    writeFileSync(join(chunkDir, "thread-OLD.js"), "export var old=1;\n");
    writeFileSync(
      join(chunkDir, "chunk-STALE.js"),
      'import"./chunk-C.js";export var s=1;\n',
    );
    writeFileSync(join(chunkDir, "chunk-STALE.js.map"), "{}");

    const removed = await pruneUnreferencedChunks({ chunkDir, entry });

    expect(removed.sort()).toEqual([
      join(chunkDir, "chunk-STALE.js"),
      join(chunkDir, "chunk-STALE.js.map"),
      join(chunkDir, "thread-OLD.js"),
    ]);
    expect(readdirSync(chunkDir).sort()).toEqual([
      "chunk-A.js",
      "chunk-C.js",
      "chunk-C.js.map",
      "chunk-D.js",
      "thread-B.js",
    ]);
  });

  it("removes nothing from a clean build", async () => {
    const dist = mkdtempSync(join(tmpdir(), "omnyo-prune-chunks-"));
    tempDirs.push(dist);
    const chunkDir = join(dist, "omnyo-chunks");
    mkdirSync(chunkDir);
    const entry = join(dist, "omnyo");
    writeFileSync(entry, 'import"./omnyo-chunks/chunk-A.js";\n');
    writeFileSync(join(chunkDir, "chunk-A.js"), "export var a=1;\n");

    await expect(pruneUnreferencedChunks({ chunkDir, entry })).resolves.toEqual(
      [],
    );
    expect(readdirSync(chunkDir)).toEqual(["chunk-A.js"]);
  });

  it("refuses to prune when the entry reaches no chunk", async () => {
    const dist = mkdtempSync(join(tmpdir(), "omnyo-prune-chunks-"));
    tempDirs.push(dist);
    const chunkDir = join(dist, "omnyo-chunks");
    mkdirSync(chunkDir);
    const entry = join(dist, "omnyo");

    writeFileSync(entry, 'import{a}from"./omnyo-chunks/chunk-A.mjs";\n');
    writeFileSync(join(chunkDir, "chunk-A.mjs"), "export var a=1;\n");

    await expect(pruneUnreferencedChunks({ chunkDir, entry })).rejects.toThrow(
      /references no chunk/,
    );
    expect(readdirSync(chunkDir)).toEqual(["chunk-A.mjs"]);
  });
});
