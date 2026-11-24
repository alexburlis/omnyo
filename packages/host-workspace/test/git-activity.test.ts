import fs from "node:fs/promises";
import path from "node:path";
import { gitActivitySchema, type GitActivity } from "@omnyo/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWorkspaceGitActivity } from "../src/git-activity.js";
import { runGit } from "../src/git.js";
import { makeTempDir, removeTempDirs } from "./workspace-test-repos.js";

const BASE_SECONDS = 1_700_000_000;

const TURN_WINDOW = {
  startMs: (BASE_SECONDS + 100) * 1_000,
  endMs: (BASE_SECONDS + 200) * 1_000,
};

const REMOTE_URL_WITH_CREDENTIALS =
  "https://omnyo-agent:secret-token@git.example.com/acme/repo.git";

interface Scenario {
  repoPath: string;
  worktreePath: string;
  originalAddSha: string;
  amendedAddSha: string;
  rebasedTipSha: string;
  mergeSha: string;
  activity: GitActivity;
}

let gitConfigPath = "";

let scenario: Scenario;

function gitEnv(offsetSeconds: number): NodeJS.ProcessEnv {
  const date = `@${BASE_SECONDS + offsetSeconds} +0000`;

  return {
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "gc.auto",
    GIT_CONFIG_VALUE_2: "0",
    GIT_AUTHOR_NAME: "Omnyo Tests",
    GIT_AUTHOR_EMAIL: "omnyo@example.com",
    GIT_COMMITTER_NAME: "Omnyo Tests",
    GIT_COMMITTER_EMAIL: "omnyo@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

async function git(
  cwd: string,
  atSeconds: number,
  args: string[],
): Promise<string> {
  const result = await runGit(args, { cwd, env: gitEnv(atSeconds) });

  return result.stdout.trim();
}

async function buildScenario(): Promise<Scenario> {
  const root = await makeTempDir("omnyo-git-activity-");
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const worktreePath = path.join(root, "worktree");
  gitConfigPath = path.join(root, "empty.gitconfig");
  await fs.writeFile(gitConfigPath, "", "utf8");

  await git(root, 0, ["init", "-q", "--bare", remotePath]);
  await git(root, 0, ["init", "-q", "-b", "main", repoPath]);
  await git(repoPath, 0, ["remote", "add", "origin", remotePath]);
  await git(repoPath, 10, ["commit", "-q", "--allow-empty", "-m", "Before"]);
  await fs.writeFile(path.join(repoPath, "a.txt"), "a\n", "utf8");
  await git(repoPath, 100, ["add", "a.txt"]);
  await git(repoPath, 100, ["commit", "-q", "-m", "Add a"]);
  const originalAddSha = await git(repoPath, 100, ["rev-parse", "HEAD"]);
  await git(repoPath, 101, ["commit", "-q", "--amend", "-m", "Add a, amended"]);
  await git(repoPath, 102, ["revert", "--no-edit", "HEAD"]);

  const sideSha = await git(repoPath, 103, [
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "Side work",
  ]);

  await git(repoPath, 104, ["cherry-pick", "--allow-empty", sideSha]);

  const parallelSha = await git(repoPath, 105, [
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD~1",
    "-m",
    "Parallel work",
  ]);

  await git(repoPath, 106, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge parallel work",
    parallelSha,
  ]);

  await git(repoPath, 107, ["checkout", "-q", "--detach"]);
  await git(repoPath, 108, ["commit", "-q", "--allow-empty", "-m", "Detached"]);
  await git(repoPath, 109, ["checkout", "-q", "main"]);
  await git(repoPath, 110, ["reset", "-q", "--hard", "HEAD"]);
  await git(repoPath, 111, ["commit", "-q", "--allow-empty", "-m", "Rebased"]);
  await git(repoPath, 112, ["rebase", "-q", "-f", "HEAD~1"]);
  await git(repoPath, 120, ["push", "-q", "origin", "main~4:refs/heads/main"]);
  await git(repoPath, 121, ["push", "-q", "origin", "main"]);
  await git(repoPath, 122, ["push", "-q", "-f", "origin", "main~1:main"]);
  await git(repoPath, 122, ["remote", "set-head", "origin", "main"]);

  const [amendedAddSha, rebasedTipSha, mergeSha] = (
    await git(repoPath, 122, ["rev-parse", "main~4", "main", "main~1"])
  ).split("\n");

  await git(repoPath, 130, ["commit", "-q", "--allow-empty", "-m", "Unpushed"]);
  await git(repoPath, 130, ["branch", "copy-of-unpushed"]);
  await git(repoPath, 300, ["commit", "-q", "--allow-empty", "-m", "After"]);

  await git(repoPath, 300, [
    "remote",
    "set-url",
    "origin",
    REMOTE_URL_WITH_CREDENTIALS,
  ]);

  await git(repoPath, 150, [
    "worktree",
    "add",
    "-q",
    "-b",
    "worktree-branch",
    worktreePath,
    "main",
  ]);

  await git(worktreePath, 151, [
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Worktree work",
  ]);

  const activity = await readWorkspaceGitActivity({
    workspacePath: repoPath,
    windows: [TURN_WINDOW],
    maxCommits: 50,
    maxPushes: 50,
  });

  return {
    repoPath,
    worktreePath,
    originalAddSha,
    amendedAddSha,
    rebasedTipSha,
    mergeSha,
    activity,
  };
}

beforeAll(async () => {
  scenario = await buildScenario();
});

afterAll(async () => {
  await removeTempDirs();
});

describe("readWorkspaceGitActivity", () => {
  it("reports commits made inside the windows and skips other reflog actions", () => {
    expect(
      scenario.activity.commits.map((commit) => ({
        subject: commit.subject,
        kind: commit.kind,
        branch: commit.branch,
      })),
    ).toEqual([
      { subject: "Add a", kind: "commit", branch: "main" },
      { subject: "Add a, amended", kind: "amend", branch: "main" },
      { subject: 'Revert "Add a, amended"', kind: "revert", branch: "main" },
      { subject: "Side work", kind: "cherry-pick", branch: "main" },
      { subject: "Merge parallel work", kind: "merge", branch: "main" },
      { subject: "Detached", kind: "commit", branch: null },
      { subject: "Rebased", kind: "commit", branch: "main" },
      { subject: "Unpushed", kind: "commit", branch: "main" },
    ]);
  });

  it("links an amend to the commit it replaced and times commits from the reflog", () => {
    const [original, amended] = scenario.activity.commits;

    expect(original).toMatchObject({
      sha: scenario.originalAddSha,
      replacedSha: null,
      committedAt: TURN_WINDOW.startMs,
    });
    expect(amended).toMatchObject({
      sha: scenario.amendedAddSha,
      replacedSha: scenario.originalAddSha,
      committedAt: TURN_WINDOW.startMs + 1_000,
    });
  });

  it("reports the remote-tracking refs that contain each commit after the pushes", () => {
    expect(
      Object.fromEntries(
        scenario.activity.commits.map((commit) => [
          commit.subject,
          commit.remoteRefs,
        ]),
      ),
    ).toEqual({
      "Add a": [],
      "Add a, amended": ["origin/main"],
      'Revert "Add a, amended"': ["origin/main"],
      "Side work": ["origin/main"],
      "Merge parallel work": ["origin/main"],
      Detached: [],
      Rebased: [],
      Unpushed: [],
    });
  });

  it("reports new-branch, fast-forward and forced pushes in order", () => {
    expect(scenario.activity.pushes).toEqual([
      {
        remote: "origin",
        branch: "main",
        oldSha: null,
        newSha: scenario.amendedAddSha,
        forced: false,
        pushedAt: (BASE_SECONDS + 120) * 1_000,
        commitCount: null,
      },
      {
        remote: "origin",
        branch: "main",
        oldSha: scenario.amendedAddSha,
        newSha: scenario.rebasedTipSha,
        forced: false,
        pushedAt: (BASE_SECONDS + 121) * 1_000,
        commitCount: 5,
      },
      {
        remote: "origin",
        branch: "main",
        oldSha: scenario.rebasedTipSha,
        newSha: scenario.mergeSha,
        forced: true,
        pushedAt: (BASE_SECONDS + 122) * 1_000,
        commitCount: 0,
      },
    ]);
  });

  it("reports remote urls without their credentials", () => {
    expect(scenario.activity.remotes).toEqual([
      { name: "origin", url: "https://git.example.com/acme/repo.git" },
    ]);
  });

  it("returns activity that satisfies the wire schema", () => {
    expect(gitActivitySchema.parse(scenario.activity)).toEqual(
      scenario.activity,
    );
  });

  it("reads a linked worktree's commits from that worktree's own HEAD log", async () => {
    const activity = await readWorkspaceGitActivity({
      workspacePath: scenario.worktreePath,
      windows: [TURN_WINDOW],
      maxCommits: 50,
      maxPushes: 50,
    });

    expect(
      activity.commits.map((commit) => ({
        subject: commit.subject,
        branch: commit.branch,
      })),
    ).toEqual([{ subject: "Worktree work", branch: "worktree-branch" }]);
  });

  it("keeps only the latest commits and pushes within the limits", async () => {
    const activity = await readWorkspaceGitActivity({
      workspacePath: scenario.repoPath,
      windows: [TURN_WINDOW],
      maxCommits: 2,
      maxPushes: 1,
    });

    expect(activity.commits.map((commit) => commit.subject)).toEqual([
      "Rebased",
      "Unpushed",
    ]);
    expect(activity.pushes.map((push) => push.newSha)).toEqual([
      scenario.mergeSha,
    ]);
  });
});
