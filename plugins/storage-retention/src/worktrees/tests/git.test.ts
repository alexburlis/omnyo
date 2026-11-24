import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  deleteBranch,
  inspectCleanupRepo,
  inspectRepo,
  isPathWithin,
  purgeWorktree,
} from "../git.js";
import storageHost from "../../host.js";

it("composes the Worktrees host into Storage without legacy removal RPCs", () => {
  expect(storageHost.contract).toHaveProperty("cleanSaved");
  expect(storageHost.contract).toHaveProperty("managedAllocate");
  expect(storageHost.contract).toHaveProperty("housekeepingHostState");
  expect(storageHost.contract).not.toHaveProperty("removeGitWorktrees");
  expect(storageHost.contract).not.toHaveProperty("inspectGitWorktree");
  expect(storageHost.contract).not.toHaveProperty("listGitWorktrees");
  expect(storageHost.experimental_signals).toHaveProperty("git-changed");
  expect(storageHost.experimental_signals).toHaveProperty("changed");
});

it("keeps native path ownership boundaries after normalization", () => {
  const root = join(tmpdir(), "project");
  expect(isPathWithin(root, root)).toBe(true);
  expect(isPathWithin(root, join(root, "nested", "..", "checkout"))).toBe(true);
  expect(isPathWithin(root, join(root, "..", "project-other"))).toBe(false);
  expect(isPathWithin(root, join(root, ".."))).toBe(false);
});

it("rechecks ignored work and protected paths while preserving branch history", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "worktrees-guard-proof-")),
  );

  const repo = join(root, "repo");
  const lane = join(root, "lane");

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    await mkdir(repo);
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(repo, "tracked"), "retained source\n");
    await writeFile(join(repo, ".gitignore"), "ignored\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("worktree", "add", "-b", "lane", lane);
    const head = git("rev-parse", "HEAD");
    const initial = await inspectRepo(repo, []);
    const inspected = initial.worktrees.find((entry) => entry.path === lane);
    expect(inspected?.lastActivityAt).toEqual(expect.any(Number));
    expect(inspected?.unsavedCommitCount).toBe(0);
    expect(
      initial.worktrees.find((entry) => entry.path === lane)?.purgeReady,
    ).toBe(true);

    const protectedState = await inspectCleanupRepo(repo, [
      join(lane, "nested"),
    ]);

    expect(
      protectedState.worktrees.find((entry) => entry.path === lane)?.purgeReady,
    ).toBe(false);
    await writeFile(join(lane, "ignored"), "unique ignored work\n");
    await expect(purgeWorktree(repo, lane, head, [], "main")).rejects.toThrow();
    expect(await access(join(lane, "ignored"))).toBeUndefined();
    await rm(join(lane, "ignored"));
    const removed = await purgeWorktree(repo, lane, head, [], "main");
    expect(removed.removed).toBe(true);
    await expect(access(lane)).rejects.toThrow();
    expect(git("rev-parse", "lane")).toBe(head);
    await deleteBranch(repo, "lane", head, "main");
    expect(git("branch", "--list", "lane")).toBe("");
    expect(git("rev-parse", "main")).toBe(head);
  } finally {
    await rm(root, { recursive: true, force: true });
    await expect(access(root)).rejects.toThrow();
  }
});
