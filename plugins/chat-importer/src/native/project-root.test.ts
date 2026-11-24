import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeCwd, resolveProjectRoot } from "./project-root.js";

let root = "";

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "chat-importer-root-")),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function makeRepository(name: string): Promise<string> {
  const repository = path.join(root, name);

  await fs.mkdir(path.join(repository, ".git", "worktrees"), {
    recursive: true,
  });

  return repository;
}

describe("resolveProjectRoot", () => {
  it("walks up to the repository that owns a nested folder", async () => {
    const repository = await makeRepository("repo");
    const nested = path.join(repository, "packages", "web");

    await fs.mkdir(nested, { recursive: true });

    await expect(resolveProjectRoot(nested)).resolves.toEqual({
      path: repository,
      kind: "git",
      mainRepositoryPath: null,
    });
  });

  it("maps a linked worktree to its main repository through gitdir and commondir", async () => {
    const repository = await makeRepository("main");
    const adminDir = path.join(repository, ".git", "worktrees", "feature");
    const worktree = path.join(root, "worktrees", "feature");

    await fs.mkdir(adminDir, { recursive: true });
    await fs.writeFile(path.join(adminDir, "commondir"), "../..\n");
    await fs.mkdir(path.join(worktree, "src"), { recursive: true });
    await fs.writeFile(
      path.join(worktree, ".git"),
      `gitdir: ${path.relative(worktree, adminDir)}\n`,
    );

    await expect(
      resolveProjectRoot(path.join(worktree, "src")),
    ).resolves.toEqual({
      path: worktree,
      kind: "git-worktree",
      mainRepositoryPath: repository,
    });
  });

  it("treats a .git file without commondir, such as a submodule, as its own repository", async () => {
    const parent = await makeRepository("parent");
    const moduleDir = path.join(parent, ".git", "modules", "child");
    const child = path.join(parent, "child");

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(path.join(child, ".git"), `gitdir: ${moduleDir}\n`);

    await expect(resolveProjectRoot(child)).resolves.toEqual({
      path: child,
      kind: "git",
      mainRepositoryPath: null,
    });
  });

  it("falls back to the folder itself outside any repository", async () => {
    const folder = path.join(root, "notes");

    await fs.mkdir(folder);

    await expect(resolveProjectRoot(folder)).resolves.toEqual({
      path: folder,
      kind: "folder",
      mainRepositoryPath: null,
    });
  });
});

describe("describeCwd", () => {
  it("reports a missing folder without a project root", async () => {
    await expect(describeCwd(path.join(root, "gone"))).resolves.toEqual({
      cwdExists: false,
      realCwd: null,
      projectRoot: null,
    });
  });

  it("resolves a symlinked folder to the repository it points at", async () => {
    const repository = await makeRepository("real");
    const nested = path.join(repository, "packages");
    const link = path.join(root, "link");

    await fs.mkdir(nested);
    await fs.symlink(repository, link);

    await expect(describeCwd(path.join(link, "packages"))).resolves.toEqual({
      cwdExists: true,
      realCwd: nested,
      projectRoot: { path: repository, kind: "git", mainRepositoryPath: null },
    });
  });
});
