import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "@omnyo/host-workspace";
import { discoverProjectIcons } from "./project-icon-search.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-icon-search-"));
  roots.push(root);

  return root;
}

async function file(root: string, name: string) {
  const full = path.join(root, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, "icon");
}

describe("discoverProjectIcons", () => {
  it("does not crawl untracked generated trees inside repositories without icons", async () => {
    const root = await fixture();
    await runGit(["init", "-q"], { cwd: root });
    await file(root, "build/deep/assets/icon.png");

    const result = await discoverProjectIcons({
      root,
      excludeNames: [],
      limit: 100,
    });

    expect(result).toEqual({ files: [], truncated: false });
  });
  it("filters excluded paths, deleted files and symbolic links in the index", async () => {
    const root = await fixture();
    await runGit(["init", "-q"], { cwd: root });
    await file(root, "assets/vendor/icon.png");
    await file(root, "gone/icon.png");
    await file(root, "real/icon.png");
    await fs.symlink("real/icon.png", path.join(root, "icon.png"));
    await runGit(["add", "."], { cwd: root });
    await fs.unlink(path.join(root, "gone/icon.png"));

    const result = await discoverProjectIcons({
      root,
      excludeNames: ["assets/vendor"],
      limit: 100,
    });

    expect(result.files.map((entry) => entry.path)).toEqual(["real/icon.png"]);
  });
  it("ignores metadata-only git stubs and finds a nested repository", async () => {
    const root = await fixture();
    await file(root, ".git/info/exclude");
    await file(root, "app/icon.svg");
    await runGit(["init", "-q"], { cwd: path.join(root, "app") });
    await runGit(["add", "icon.svg"], { cwd: path.join(root, "app") });
    expect(
      (
        await discoverProjectIcons({ root, excludeNames: [], limit: 100 })
      ).files.map((entry) => entry.path),
    ).toEqual(["app/icon.svg"]);
  });
  it("discovers child repositories beneath a valid umbrella repository", async () => {
    const root = await fixture();
    await runGit(["init", "-q"], { cwd: root });
    await file(root, "app/icon.svg");
    await runGit(["init", "-q"], { cwd: path.join(root, "app") });
    await runGit(["add", "icon.svg"], { cwd: path.join(root, "app") });
    expect(
      (
        await discoverProjectIcons({ root, excludeNames: [], limit: 100 })
      ).files.map((entry) => entry.path),
    ).toEqual(["app/icon.svg"]);
  });
  it("uses nested repository indexes without walking generated files", async () => {
    const root = await fixture();
    await file(root, "app/assets/icon.png");
    await runGit(["init", "-q"], { cwd: path.join(root, "app") });
    await runGit(["add", "assets/icon.png"], { cwd: path.join(root, "app") });
    await file(root, "app/build/favicon.png");
    await file(root, ".build/icon.png");

    const result = await discoverProjectIcons({
      root,
      excludeNames: [],
      limit: 100,
    });

    expect(result.files.map((entry) => entry.path)).toEqual([
      "app/assets/icon.png",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("a large generated directory cannot starve a sibling icon", async () => {
    const root = await fixture();
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => file(root, `a-build/${i}.bin`)),
    );
    await file(root, "z-app/assets/icon.png");

    const result = await discoverProjectIcons({
      root,
      excludeNames: [],
      limit: 100,
    });

    expect(result.files.map((entry) => entry.path)).toContain(
      "z-app/assets/icon.png",
    );
    expect(result.truncated).toBe(true);
  });
});
