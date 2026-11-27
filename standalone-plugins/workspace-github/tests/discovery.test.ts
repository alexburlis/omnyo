import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import host from "../host";

it("discovers nested checkouts and git worktrees without scanning dependencies or following symlinks", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-discovery-"));
  const root = join(scratch, "project");
  const primary = join(root, "apps", "desktop");
  const worktree = join(root, "desktop-review");
  const secondary = join(root, "web");
  const outside = join(scratch, "outside");
  const dependency = join(root, "node_modules", "dependency");
  const dataDirectory = join(root, ".omnyo", "plugins", "installed");

  const git = (path: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-C", path, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { stdio: "pipe" },
    );

  const createRepo = (path: string, remote: string) => {
    mkdirSync(path, { recursive: true });
    git(path, "init");
    git(path, "remote", "add", "origin", remote);
  };

  const harness = experimental_createHostEntryHarness(host);

  try {
    mkdirSync(join(root, ".git", "claude"), { recursive: true });
    mkdirSync(join(root, "apps", ".git", "claude"), { recursive: true });
    createRepo(primary, "git@github.com:acme/desktop.git");
    git(
      primary,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    git(primary, "worktree", "add", "--detach", worktree);
    createRepo(secondary, "https://github.com/acme/web.git");
    createRepo(outside, "https://github.com/acme/outside.git");
    createRepo(dependency, "https://github.com/acme/dependency.git");
    createRepo(dataDirectory, "https://github.com/acme/installed.git");
    symlinkSync(outside, join(root, "linked"), "dir");
    const result = await harness.experimental_call("discover", { roots: [root, primary] });
    expect(result.repos.map((repo) => repo.repo).sort()).toEqual(["acme/desktop", "acme/web"]);
    expect(result.problems).toEqual([]);

    const missing = await harness.experimental_call("discover", {
      roots: [join(scratch, "missing")],
    });

    expect(missing.repos).toEqual([]);
    expect(missing.problems).toHaveLength(1);
  } finally {
    await harness.experimental_dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("skips orphaned worktree pointers and keeps scanning after one folder fails", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-orphans-"));
  const root = join(scratch, "project");
  const orphan = join(root, "docs", "kept-worktree");
  const broken = join(root, "docs", "unreadable-origin");
  const real = join(root, "web");
  const harness = experimental_createHostEntryHarness(host);

  try {
    mkdirSync(join(root, ".git", "claude"), { recursive: true });
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, ".git"), `gitdir: ${join(scratch, "gone", "worktrees", "kept")}\n`);
    mkdirSync(join(broken, "not-a-gitdir"), { recursive: true });
    writeFileSync(join(broken, ".git"), "gitdir: not-a-gitdir\n");
    mkdirSync(real, { recursive: true });
    execFileSync("git", ["-C", real, "init"], { stdio: "pipe" });
    execFileSync(
      "git",
      ["-C", real, "remote", "add", "origin", "https://github.com/acme/web.git"],
      {
        stdio: "pipe",
      },
    );

    const result = await harness.experimental_call("discover", { roots: [root] });

    expect(result.repos.map((repo) => repo.repo)).toEqual(["acme/web"]);
    expect(result.problems).toEqual([
      `Could not inspect ${broken}: its Git origin could not be read`,
    ]);
  } finally {
    await harness.experimental_dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});
