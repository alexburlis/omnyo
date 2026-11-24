import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { inventoryRepository } from "../../../scripts/omnyo-inventory.mjs";

const roots = [];

function initialize(root) {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("enumerates marker-free, changed, removed and new files without lexical assumptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-census-"));
  roots.push(root);
  initialize(root);
  await writeFile(join(root, "plain.txt"), "current");
  await writeFile(join(root, "neutral.png"), Buffer.from([0, 1, 2]));
  const first = await inventoryRepository("core", root, []);
  expect(first.files.map(({ path }) => path)).toEqual([
    "neutral.png",
    "plain.txt",
  ]);
  await writeFile(join(root, "plain.txt"), "changed");
  await rm(join(root, "neutral.png"));
  await writeFile(join(root, "new.txt"), "new");
  const second = await inventoryRepository("core", root, first.files);
  expect(second.files.map(({ path, delta }) => [path, delta])).toEqual([
    ["neutral.png", "removed"],
    ["new.txt", "added"],
    ["plain.txt", "changed"],
  ]);
  expect(
    second.files.find(({ path }) => path === "plain.txt").disposition,
  ).toBe("unclassified");
});

test("refuses to read protected files or follow symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-census-"));
  roots.push(root);
  initialize(root);
  await writeFile(join(root, ".env.fixture"), "synthetic");
  await mkdir(join(root, "owned"));
  await writeFile(join(root, "owned", "source"), "unchanged");
  await symlink(join(root, "owned", "source"), join(root, "link"));
  const result = await inventoryRepository("core", root, []);
  expect(
    result.files.find(({ path }) => path === ".env.fixture"),
  ).toMatchObject({ state: "protected-not-read" });
  expect(result.files.find(({ path }) => path === "link")).toMatchObject({
    state: "symlink-not-followed",
  });
  expect(await readFile(join(root, "owned", "source"), "utf8")).toBe(
    "unchanged",
  );
});
