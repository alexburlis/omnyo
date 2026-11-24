import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import {
  ProcessLocalQueuedLockTimeoutError,
  withProcessLocalQueuedLocks,
} from "omnyo-environment-provider-host/process-local-lock";
import { Workspace } from "../src/workspace.js";
import { WorkspaceError, runGit } from "../src/git.js";
import { withCheckoutMutationLock } from "../src/checkout-mutation-lock.js";
import {
  initRepo,
  makeTempDir,
  waitForLockContention,
  removeTempDirs,
} from "./workspace-test-repos.js";

afterEach(removeTempDirs);

describe("Workspace", () => {
  it("caps listed working-tree files, keeping tracked changes ahead of untracked files", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "a.txt"), "a\n", "utf8");
    await fs.writeFile(path.join(repoPath, "z.txt"), "z\n", "utf8");
    await runGit(["add", "a.txt", "z.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "Add tracked files"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "a.txt"), "a2\n", "utf8");
    await fs.writeFile(path.join(repoPath, "z.txt"), "z2\n", "utf8");
    await fs.mkdir(path.join(repoPath, "artifacts"));

    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(
        path.join(repoPath, "artifacts", `shot-${index}.txt`),
        `run ${index}\n`,
        "utf8",
      );
    }

    const workspace = new Workspace(repoPath);

    const status = await workspace.getStatus({ maxFiles: 3 });
    expect(status.workingTree.fileCount).toBe(7);
    expect(status.workingTree.state).toBe("dirty_uncommitted");
    expect(status.workingTree.insertions).toBe(2);
    expect(status.workingTree.deletions).toBe(2);
    expect(
      status.workingTree.files.map((file) => [file.status, file.path]),
    ).toEqual([
      ["M", "a.txt"],
      ["M", "z.txt"],
      ["??", "artifacts/shot-0.txt"],
    ]);

    const trackedOnly = await workspace.getStatus({ maxFiles: 1 });
    expect(trackedOnly.workingTree.fileCount).toBe(7);
    expect(
      trackedOnly.workingTree.files.map((file) => [file.status, file.path]),
    ).toEqual([["M", "a.txt"]]);

    const uncapped = await workspace.getStatus();
    expect(uncapped.workingTree.fileCount).toBe(7);
    expect(uncapped.workingTree.files).toHaveLength(7);
  });

  it("caps listed merge-base files while reporting the total", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });

    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      await fs.writeFile(path.join(repoPath, name), `${name}\n`, "utf8");
    }

    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature files"], { cwd: repoPath });

    const status = await new Workspace(repoPath).getStatus({
      mergeBaseBranch: "main",
      maxFiles: 2,
    });

    expect(status.mergeBase?.fileCount).toBe(3);
    expect(status.mergeBase?.files).toHaveLength(2);
    expect(status.mergeBase?.insertions).toBe(3);
  });

  it("rejects a non-positive status file cap", async () => {
    const repoPath = await initRepo();
    await expect(
      new Workspace(repoPath).getStatus({ maxFiles: 0 }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("reports clean, dirty, untracked-only, and mixed workspace states", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    expect((await workspace.getStatus()).workingTree.state).toBe("clean");

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    expect((await workspace.getStatus()).workingTree.state).toBe(
      "dirty_uncommitted",
    );

    await runGit(["reset", "--hard", "HEAD"], { cwd: repoPath });
    await runGit(["clean", "-fd"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");
    const untrackedStatus = await workspace.getStatus();
    expect(untrackedStatus.workingTree.state).toBe("untracked");
    expect(untrackedStatus.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(untrackedStatus.workingTree.insertions).toBe(0);
    expect(untrackedStatus.workingTree.deletions).toBe(0);
    expect(untrackedStatus.workingTree.lineStatsComplete).toBe(false);

    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "dirty with note\n",
      "utf8",
    );
    const mixedStatus = await workspace.getStatus();
    expect(mixedStatus.workingTree.state).toBe("dirty_uncommitted");
    expect(mixedStatus.workingTree.files).toHaveLength(2);
  });

  it("reports deleted tracked files as dirty file changes", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await fs.rm(path.join(repoPath, "README.md"));

    const status = await workspace.getStatus();
    expect(status.workingTree.state).toBe("dirty_uncommitted");
    expect(status.workingTree.files).toEqual([
      {
        path: "README.md",
        status: "D",
        insertions: 0,
        deletions: 1,
      },
    ]);
  });

  it("joins per-file numstat to a rename+modify under the new path", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await runGit(["mv", "README.md", "NOTES.md"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "NOTES.md"),
      "hello\nworld\n",
      "utf8",
    );

    const status = await workspace.getStatus();
    expect(status.workingTree.files).toEqual([
      {
        path: "NOTES.md",
        status: "R",
        insertions: 1,
        deletions: 0,
      },
    ]);
    expect(status.workingTree.insertions).toBe(1);
    expect(status.workingTree.deletions).toBe(0);
  });

  it("reports null per-file stats for binary changes and excludes them from totals", async () => {
    const repoPath = await initRepo();
    const binaryPath = path.join(repoPath, "data.bin");
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3, 0xff, 0xfe]));
    await runGit(["add", "data.bin"], { cwd: repoPath });
    await runGit(["commit", "-m", "Add binary"], { cwd: repoPath });

    await fs.writeFile(binaryPath, Buffer.from([10, 20, 30, 40, 50, 60]));
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "hello\nworld\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus();

    expect(status.workingTree.files).toEqual([
      {
        path: "README.md",
        status: "M",
        insertions: 1,
        deletions: 0,
      },
      {
        path: "data.bin",
        status: "M",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.workingTree.insertions).toBe(1);
    expect(status.workingTree.deletions).toBe(0);
  });

  it("changes the local state fingerprint when local checkout state changes", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    const initialFingerprint = await workspace.getLocalStateFingerprint();

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    const dirtyFingerprint = await workspace.getLocalStateFingerprint();
    expect(dirtyFingerprint).not.toBe(initialFingerprint);

    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    const branchFingerprint = await workspace.getLocalStateFingerprint();
    expect(branchFingerprint).not.toBe(dirtyFingerprint);
  });

  it("fingerprints an untracked path without reading its contents", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    const initialFingerprint = await workspace.getLocalStateFingerprint();

    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\n", "utf8");
    const untrackedFingerprint = await workspace.getLocalStateFingerprint();
    expect(untrackedFingerprint).not.toBe(initialFingerprint);

    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\ntwo\n", "utf8");
    expect(await workspace.getLocalStateFingerprint()).toBe(
      untrackedFingerprint,
    );
  });

  it("changes the shared git refs fingerprint only when refs change", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    const initialFingerprint = await workspace.getSharedGitRefsFingerprint();

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    const dirtyFingerprint = await workspace.getSharedGitRefsFingerprint();
    expect(dirtyFingerprint).toBe(initialFingerprint);

    await runGit(["branch", "feature"], { cwd: repoPath });
    const branchFingerprint = await workspace.getSharedGitRefsFingerprint();
    expect(branchFingerprint).not.toBe(initialFingerprint);
  });

  it("returns diff content for each supported target", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "feature plus pending\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoPath, "notes.txt"),
      "untracked pending\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    const commitSha = status.mergeBase?.commits[0]?.sha;
    expect(commitSha).toBeDefined();

    const uncommitted = await workspace.getDiff({
      target: { type: "uncommitted" },
    });

    expect(uncommitted.diff).toContain("feature plus pending");
    expect(uncommitted.diff).toContain("untracked pending");
    expect(uncommitted.files).toContain("README.md");
    expect(uncommitted.files).toContain("notes.txt");
    expect(uncommitted.shortstat).toContain("2 files changed");

    const branchCommitted = await workspace.getDiff({
      target: { type: "branch_committed", mergeBaseBranch: "main" },
    });

    expect(branchCommitted.diff).toContain("+feature");

    const all = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });

    expect(all.diff).toContain("feature plus pending");
    expect(all.diff).toContain("untracked pending");
    expect(all.files).toContain("README.md");
    expect(all.files).toContain("notes.txt");
    expect(all.shortstat).toContain("2 files changed");

    const commitOnly = await workspace.getDiff({
      target: { type: "commit", sha: commitSha! },
    });

    expect(commitOnly.diff).toContain("+feature");
  });

  it("truncates large git diff output before the process buffer fails", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      Array.from({ length: 200 }, (_, index) => `large diff line ${index}`)
        .join("\n")
        .concat("\n"),
      "utf8",
    );

    const workspace = new Workspace(repoPath);

    const diff = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
      maxDiffBytes: 128,
    });

    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.diff, "utf8")).toBeLessThanOrEqual(128);
    expect(diff.diff).toContain("diff --git");
    expect(diff.files).toContain("README.md");
    expect(diff.shortstat).toContain("1 file changed");
  });

  it("includes untracked files in one combined diff", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        await fs.writeFile(
          path.join(repoPath, `note-${index}.txt`),
          `untracked ${index}\n`,
          "utf8",
        );
      }),
    );

    const diff = await workspace.getDiff({
      target: { type: "uncommitted" },
    });

    expect(diff.diff).toContain("untracked 11");
    expect(diff.files).toContain("note-11.txt");
    expect(diff.shortstat).toContain("12 files changed");
  });

  it("bounds full-diff untracked content and reports truncation", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "a.txt"), "first\n", "utf8");
    await fs.writeFile(path.join(repoPath, "b.txt"), "second\n", "utf8");

    const diff = await new Workspace(repoPath).getDiff({
      target: { type: "uncommitted" },
      maxUntrackedFiles: 1,
    });

    expect(diff.truncated).toBe(true);
    expect(diff.files).toContain("a.txt");
    expect(diff.files).not.toContain("b.txt");
    expect(diff.diff).toContain("first");
    expect(diff.diff).not.toContain("second");
  });

  it("commits staged work", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await fs.writeFile(path.join(repoPath, "README.md"), "commit me\n", "utf8");

    const commit = await workspace.commit({
      message: "Commit from workspace",
      noVerify: false,
    });

    const head = (
      await runGit(["rev-parse", "HEAD"], { cwd: repoPath })
    ).stdout.trim();

    expect(commit.commitSha).toBe(head);
  });

  it("throws a typed no_changes error when there is nothing to commit", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await expect(
      workspace.commit({ message: "nothing to commit", noVerify: false }),
    ).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "no_changes",
    });

    await fs.writeFile(path.join(repoPath, "new.txt"), "real work\n", "utf8");

    const commit = await workspace.commit({
      message: "real commit",
      noVerify: false,
    });

    expect(typeof commit.commitSha).toBe("string");
  });

  it("serializes same-checkout mutations", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    await fs.writeFile(path.join(repoPath, "README.md"), "pending\n", "utf8");

    const lockEntered = createDeferredPromise<void>();
    const releaseLock = createDeferredPromise<void>();

    const heldLock = withCheckoutMutationLock(repoPath, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });

    await lockEntered.promise;

    let commitCompleted = false;

    const commit = workspace
      .commit({ message: "pending", noVerify: false })
      .then(() => {
        commitCompleted = true;
      });

    await waitForLockContention();

    expect(commitCompleted).toBe(false);

    releaseLock.resolve();
    await Promise.all([heldLock, commit]);

    expect(commitCompleted).toBe(true);
    expect((await workspace.getStatus()).workingTree.state).toBe("clean");
  });

  it("does not serialize different linked worktree checkout mutations", async () => {
    const repoPath = await initRepo();
    const worktreeParent = await makeTempDir("omnyo-workspace-lock-worktrees-");
    const worktreePath = path.join(worktreeParent, "feature");
    await runGit(["worktree", "add", "-b", "feature", worktreePath, "main"], {
      cwd: repoPath,
    });

    const primaryLockEntered = createDeferredPromise<void>();
    const releasePrimaryLock = createDeferredPromise<void>();

    const primaryLock = withCheckoutMutationLock(repoPath, async () => {
      primaryLockEntered.resolve();
      await releasePrimaryLock.promise;
    });

    await primaryLockEntered.promise;

    let worktreeLockEntered = false;
    await withCheckoutMutationLock(worktreePath, async () => {
      worktreeLockEntered = true;
    });

    releasePrimaryLock.resolve();
    await primaryLock;

    expect(worktreeLockEntered).toBe(true);
  });

  it("skips process-local lock waiters that time out before entry", async () => {
    const entered = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    let timedOutWorkRan = false;

    const first = withProcessLocalQueuedLocks({
      locks: [{ key: "timed-out-skip-lock", timeoutMs: 0 }],
      work: async () => {
        entered.resolve();
        await release.promise;
      },
    });

    await entered.promise;

    await expect(
      withProcessLocalQueuedLocks({
        locks: [{ key: "timed-out-skip-lock", timeoutMs: 10 }],
        work: async () => {
          timedOutWorkRan = true;
        },
      }),
    ).rejects.toBeInstanceOf(ProcessLocalQueuedLockTimeoutError);

    release.resolve();
    await first;
    await expect(
      withProcessLocalQueuedLocks({
        locks: [{ key: "timed-out-skip-lock", timeoutMs: 1000 }],
        work: async () => "after-timeout",
      }),
    ).resolves.toBe("after-timeout");
    expect(timedOutWorkRan).toBe(false);
  });

  it("rejects git mutations for non-git directories", async () => {
    const folder = await makeTempDir("omnyo-workspace-nongit-");
    const workspace = new Workspace(folder);

    expect(await workspace.currentBranch).toBeUndefined();
    await expect(
      workspace.commit({ message: "nope", noVerify: false }),
    ).rejects.toThrow(/not a git repository/u);
    await expect(workspace.getStatus()).rejects.toThrow(WorkspaceError);
  });

  it("returns null when HEAD is unavailable in an empty repository", async () => {
    const repoPath = await makeTempDir("omnyo-workspace-empty-repo-");
    await runGit(["init", "-b", "main"], { cwd: repoPath });
    await runGit(["config", "user.name", "Omnyo Tests"], { cwd: repoPath });
    await runGit(["config", "user.email", "omnyo@example.com"], {
      cwd: repoPath,
    });

    const workspace = new Workspace(repoPath);

    expect(await workspace.getHeadSha()).toBeNull();
  });
});

describe("getPullRequest", () => {
  it("reports a vanished workspace path as unavailable, not absent", async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `omnyo-missing-workspace-${process.pid}-${Date.now()}`,
    );

    const workspace = new Workspace(missingPath);
    await expect(workspace.getPullRequest()).resolves.toEqual({
      outcome: "unavailable",
      message: `Workspace path no longer exists: ${missingPath}`,
    });
  });
});
