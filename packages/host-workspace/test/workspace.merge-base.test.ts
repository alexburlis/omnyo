import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";
import {
  createPrimaryAndFeatureWorktree,
  initRepo,
  makeTempDir,
  mergeFeatureIntoMainWithSquash,
  removeTempDirs,
} from "./workspace-test-repos.js";

afterEach(removeTempDirs);

describe("Workspace merge-base status", () => {
  it("returns grouped status details only when merge-base data is requested", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const localOnlyStatus = await workspace.getStatus();
    expect(localOnlyStatus.mergeBase).toBeNull();
    expect(localOnlyStatus.workingTree.state).toBe("clean");

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.workingTree.state).toBe("committed_unmerged");
    expect(status.branch.currentBranch).toBe("feature");
    expect(status.branch.defaultBranch).toBe("main");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      aheadCount: 1,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
    });
    expect(status.mergeBase?.commits[0]?.subject).toBe("Feature commit");
    expect(status.mergeBase?.files).toEqual([
      { path: "README.md", status: "M", insertions: 1, deletions: 1 },
    ]);
  });

  it("reports untracked files plus committed unmerged changes as dirty_and_committed_unmerged", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "notes.txt"),
      "untracked pending\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");
    expect(status.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: true,
      aheadCount: 1,
      behindCount: 0,
    });
    expect(status.mergeBase?.files).toEqual([
      { path: "README.md", status: "M", insertions: 1, deletions: 1 },
    ]);
  });

  it("reports branches that are only behind their merge base as clean", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await runGit(["checkout", "main"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "main update\n",
      "utf8",
    );
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Main update"], { cwd: repoPath });
    await runGit(["checkout", "feature"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("clean");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
      behindCount: 1,
    });
  });

  it("does not report a multi-commit squash-merged branch as ahead of its merge base", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();

    await fs.writeFile(
      path.join(worktreePath, "feature.txt"),
      "feature extra\n",
      "utf8",
    );
    await runGit(["add", "feature.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Feature extra"], { cwd: worktreePath });

    const workspace = new Workspace(worktreePath);
    await mergeFeatureIntoMainWithSquash(
      primaryRepo,
      "feat: squash merge multi-commit feature into main",
    );

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
    });
    expect(status.mergeBase?.commits).toEqual([]);
    expect(status.mergeBase?.files).toEqual([]);
    expect(status.mergeBase?.insertions).toBe(0);
    expect(status.mergeBase?.deletions).toBe(0);
  });

  it("recognizes squash-merged branch after main advances past the squash commit", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();

    await fs.writeFile(
      path.join(worktreePath, "feature.txt"),
      "feature extra\n",
      "utf8",
    );
    await runGit(["add", "feature.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Feature extra"], { cwd: worktreePath });

    const workspace = new Workspace(worktreePath);
    await mergeFeatureIntoMainWithSquash(
      primaryRepo,
      "feat: squash merge feature into main",
    );

    await fs.writeFile(
      path.join(primaryRepo, "after-squash.txt"),
      "later\n",
      "utf8",
    );
    await runGit(["add", "after-squash.txt"], { cwd: primaryRepo });
    await runGit(["commit", "-m", "Main work after squash"], {
      cwd: primaryRepo,
    });

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
    });
    expect(status.mergeBase?.behindCount).toBeGreaterThan(0);
  });

  it("treats a branch whose commits cancel out as merged", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();

    await fs.writeFile(path.join(worktreePath, "README.md"), "hello\n", "utf8");
    await runGit(["add", "README.md"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Revert feature"], { cwd: worktreePath });

    await fs.writeFile(
      path.join(primaryRepo, "main-work.txt"),
      "main\n",
      "utf8",
    );
    await runGit(["add", "main-work.txt"], { cwd: primaryRepo });
    await runGit(["commit", "-m", "Main advance"], { cwd: primaryRepo });

    const workspace = new Workspace(worktreePath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
    });
  });

  it("still reports genuine unmerged branch commits as ahead", async () => {
    const { worktreePath } = await createPrimaryAndFeatureWorktree();
    await fs.writeFile(path.join(worktreePath, "extra.txt"), "extra\n", "utf8");
    await runGit(["add", "extra.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Feature extra"], { cwd: worktreePath });

    const workspace = new Workspace(worktreePath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: true,
      aheadCount: 2,
    });
  });

  it("does not report squash-merged branch commits as ahead of their merge base", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();

    await fs.writeFile(
      path.join(primaryRepo, "notes.txt"),
      "main work\n",
      "utf8",
    );
    await runGit(["add", "notes.txt"], { cwd: primaryRepo });
    await runGit(["commit", "-m", "Main work"], { cwd: primaryRepo });

    const workspace = new Workspace(worktreePath);
    await mergeFeatureIntoMainWithSquash(
      primaryRepo,
      "feat: squash merge feature into main",
    );

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("clean");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
      behindCount: 1,
    });
    expect(status.mergeBase?.commits).toEqual([]);
  });

  it("reports status for git repositories with no commits yet", async () => {
    const repoPath = await makeTempDir("omnyo-workspace-unborn-repo-");
    await runGit(["init", "-b", "main"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "staged.txt"),
      "staged pending\n",
      "utf8",
    );
    await runGit(["add", "staged.txt"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "notes.txt"),
      "untracked pending\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("dirty_uncommitted");
    expect(status.branch.currentBranch).toBe("main");
    expect(status.checkout).toEqual({ kind: "unborn", branchName: "main" });
    expect(status.workingTree.files).toEqual([
      {
        path: "staged.txt",
        status: "A",
        insertions: 1,
        deletions: 0,
      },
      {
        path: "notes.txt",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.workingTree.insertions).toBe(1);
    expect(status.workingTree.deletions).toBe(0);
    expect(status.workingTree.lineStatsComplete).toBe(false);
    expect(status.mergeBase).toEqual({
      mergeBaseBranch: "main",
      baseRef: null,
      aheadCount: 0,
      behindCount: 0,
      squashMergeCheckComplete: true,
      hasCommittedUnmergedChanges: false,
      commits: [],
      fileCount: 0,
      files: [],
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
    });
  });
});
