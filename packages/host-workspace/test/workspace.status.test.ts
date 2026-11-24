import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";
import {
  createPrimaryAndFeatureWorktree,
  initRepo,
  makeTempDir,
  parseShortstat,
  tallyWorkspaceStats,
  removeTempDirs,
} from "./workspace-test-repos.js";

afterEach(removeTempDirs);

describe("Workspace working-tree status", () => {
  it("aligns committed-only status stats with all and committed diffs", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.workingTree.files).toEqual([]);
    const mergeBase = status.mergeBase;
    expect(mergeBase).not.toBeNull();

    if (!mergeBase) {
      throw new Error("Expected merge-base status");
    }

    const allChanges = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });

    const committedChanges = await workspace.getDiff({
      target: { type: "branch_committed", mergeBaseBranch: "main" },
    });

    const bannerStats = tallyWorkspaceStats(mergeBase);

    expect(bannerStats).toEqual(parseShortstat(allChanges.shortstat));
    expect(bannerStats).toEqual(parseShortstat(committedChanges.shortstat));
  });

  it("marks status line stats incomplete when untracked content is omitted", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "hello\npending\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.mergeBase?.files ?? []).toEqual([]);

    const allChanges = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });

    const uncommittedChanges = await workspace.getDiff({
      target: { type: "uncommitted" },
    });

    const bannerStats = tallyWorkspaceStats(status.workingTree);

    expect(status.workingTree.lineStatsComplete).toBe(false);
    expect(bannerStats).toEqual({
      filesCount: 2,
      insertions: 1,
      deletions: 0,
    });
    expect(parseShortstat(allChanges.shortstat)).toEqual({
      filesCount: 2,
      insertions: 2,
      deletions: 0,
    });
    expect(parseShortstat(uncommittedChanges.shortstat)).toEqual(
      parseShortstat(allChanges.shortstat),
    );
  });

  it("enriches small untracked status snapshots within file and byte budgets", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "hello\npending\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\ntwo\n", "utf8");

    const statusBefore = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });

    const status = await new Workspace(repoPath).getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1024,
    });

    expect(status.workingTree.files).toEqual([
      {
        path: "README.md",
        status: "M",
        insertions: 1,
        deletions: 0,
      },
      {
        path: "notes.txt",
        status: "??",
        insertions: 2,
        deletions: 0,
      },
    ]);
    expect(status.workingTree).toMatchObject({
      insertions: 3,
      deletions: 0,
      lineStatsComplete: true,
    });

    const statusAfter = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });

    expect(statusAfter.stdout).toBe(statusBefore.stdout);
  });

  it("keeps tracked deletion stats separate from an untracked replacement at the same path", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(
      path.join(repoPath, "replacement.txt"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    await runGit(["add", "replacement.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "Add replacement target"], {
      cwd: repoPath,
    });
    await runGit(["rm", "--cached", "replacement.txt"], { cwd: repoPath });

    const status = await new Workspace(repoPath).getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1024,
    });

    expect(status.workingTree.files).toEqual([
      {
        path: "replacement.txt",
        status: "D",
        insertions: 0,
        deletions: 3,
      },
      {
        path: "replacement.txt",
        status: "??",
        insertions: 3,
        deletions: 0,
      },
    ]);
    expect(status.workingTree).toMatchObject({
      insertions: 3,
      deletions: 3,
      lineStatsComplete: true,
    });
  });

  it("enriches eligible untracked files when another entry is a nested repository", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\ntwo\n", "utf8");
    const nestedRepoPath = path.join(repoPath, "vendor");
    await fs.mkdir(nestedRepoPath);
    await runGit(["init", "-b", "main"], { cwd: nestedRepoPath });
    await fs.writeFile(path.join(nestedRepoPath, "inside.txt"), "inside\n");

    const status = await new Workspace(repoPath).getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1024,
    });

    expect(status.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
        insertions: 2,
        deletions: 0,
      },
      {
        path: "vendor/",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.workingTree).toMatchObject({
      insertions: 2,
      deletions: 0,
      lineStatsComplete: false,
    });
  });

  it("leaves untracked status stats unknown when either enrichment budget is exceeded", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "one.txt"), "one\n", "utf8");
    await fs.writeFile(path.join(repoPath, "two.txt"), "two\n", "utf8");
    const workspace = new Workspace(repoPath);

    const overFileBudget = await workspace.getStatus({
      maxUntrackedLineStatFiles: 1,
      maxUntrackedLineStatBytes: 1024,
    });

    const overByteBudget = await workspace.getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1,
    });

    for (const status of [overFileBudget, overByteBudget]) {
      expect(status.workingTree.lineStatsComplete).toBe(false);
      expect(
        status.workingTree.files
          .filter((file) => file.status === "??")
          .every((file) => file.insertions === null && file.deletions === null),
      ).toBe(true);
    }
  });

  it("keeps tracked status totals explicitly incomplete in a mixed workspace", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "feature\npending\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");

    const allChanges = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });

    const uncommittedChanges = await workspace.getDiff({
      target: { type: "uncommitted" },
    });

    const bannerStats = tallyWorkspaceStats(status.workingTree);

    expect(status.workingTree.lineStatsComplete).toBe(false);
    expect(bannerStats).not.toEqual(
      parseShortstat(uncommittedChanges.shortstat),
    );
    expect(bannerStats).not.toEqual(parseShortstat(allChanges.shortstat));
  });
});

const statusReadOptions = {
  mergeBaseBranch: "main",
  maxUntrackedLineStatFiles: 50,
  maxUntrackedLineStatBytes: 8 * 1024 * 1024,
};

async function countGitProcesses<T>(
  run: () => Promise<T>,
): Promise<{ result: T; gitProcesses: number }> {
  const tracePath = path.join(
    await makeTempDir("omnyo-workspace-trace-"),
    "trace.json",
  );

  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;

  try {
    const result = await run();

    const events = (await fs.readFile(tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; sid: string });

    return {
      result,
      gitProcesses: events.filter(
        (event) => event.event === "start" && !event.sid.includes("/"),
      ).length,
    };
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
}

describe("Workspace status reads", () => {
  it("reads an unchanged dirty worktree again with at most four git processes", async () => {
    const { worktreePath } = await createPrimaryAndFeatureWorktree();
    await fs.writeFile(path.join(worktreePath, "README.md"), "edited\n");
    await fs.writeFile(path.join(worktreePath, "notes.txt"), "a\nb\n");
    const workspace = new Workspace(worktreePath);
    const first = await workspace.getStatus(statusReadOptions);

    const again = await countGitProcesses(() =>
      workspace.getStatus(statusReadOptions),
    );

    expect(again.result).toEqual(first);
    expect(again.gitProcesses).toBeLessThanOrEqual(4);
  });

  it("reads against a base that trails origin again with at most four git processes", async () => {
    const repoPath = await initRepo();

    const staleMain = (
      await runGit(["rev-parse", "HEAD"], { cwd: repoPath })
    ).stdout.trim();

    await fs.writeFile(path.join(repoPath, "base.txt"), "new base\n");
    await runGit(["add", "base.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "Base update"], { cwd: repoPath });
    await runGit(["update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd: repoPath,
    });
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await runGit(["update-ref", "refs/heads/main", staleMain], {
      cwd: repoPath,
    });
    await fs.writeFile(path.join(repoPath, "feature.txt"), "feature\n");
    await runGit(["add", "feature.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature"], { cwd: repoPath });
    const workspace = new Workspace(repoPath);
    const first = await workspace.getStatus(statusReadOptions);

    const again = await countGitProcesses(() =>
      workspace.getStatus(statusReadOptions),
    );

    expect(first.mergeBase?.aheadCount).toBe(1);
    expect(again.result).toEqual(first);
    expect(again.gitProcesses).toBeLessThanOrEqual(4);
  });

  it("reports a detached checkout without a current branch", async () => {
    const repoPath = await initRepo();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    await runGit(["switch", "--detach", "HEAD"], { cwd: repoPath });
    const workspace = new Workspace(repoPath);

    const status = await workspace.getStatus(statusReadOptions);

    expect(status.checkout).toEqual({
      kind: "detached",
      headSha: head.stdout.trim(),
    });
    expect(status.branch.currentBranch).toBeNull();
  });

  it("reflects new commits, base movement and untracked edits between reads", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();

    await fs.writeFile(path.join(worktreePath, "notes.txt"), "a\n");
    const workspace = new Workspace(worktreePath);
    const before = await workspace.getStatus(statusReadOptions);

    expect(before.mergeBase).toMatchObject({ aheadCount: 1, behindCount: 0 });
    expect(before.workingTree.files).toContainEqual({
      path: "notes.txt",
      status: "??",
      insertions: 1,
      deletions: 0,
    });

    await fs.writeFile(path.join(worktreePath, "notes.txt"), "a\nb\nc\n");
    await fs.writeFile(path.join(worktreePath, "second.txt"), "x\n");
    await runGit(["add", "second.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Second feature commit"], {
      cwd: worktreePath,
    });
    await fs.writeFile(path.join(primaryRepo, "base.txt"), "base\n");
    await runGit(["add", "base.txt"], { cwd: primaryRepo });
    await runGit(["commit", "-m", "Main moves"], { cwd: primaryRepo });

    const after = await workspace.getStatus(statusReadOptions);

    expect(after.mergeBase).toMatchObject({ aheadCount: 2, behindCount: 1 });
    expect(after.mergeBase?.commits.map((commit) => commit.subject)).toEqual([
      "Feature work",
      "Second feature commit",
    ]);
    expect(after.workingTree.files).toContainEqual({
      path: "notes.txt",
      status: "??",
      insertions: 3,
      deletions: 0,
    });
  });
});
