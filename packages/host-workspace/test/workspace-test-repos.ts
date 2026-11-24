import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceChangeStats } from "@omnyo/domain";
import { runGit } from "../src/git.js";

const tempDirs: string[] = [];

export type DiffStats = {
  filesCount: number;
  insertions: number;
  deletions: number;
};

export function waitForLockContention(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
}

export async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("omnyo-workspace-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "Omnyo Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "omnyo@example.com"], {
    cwd: repoPath,
  });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "README.md"], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });

  return repoPath;
}

function parseFirstIntegerMatch(text: string, pattern: RegExp): number {
  const value = Number.parseInt(text.match(pattern)?.[1] ?? "0", 10);

  return Number.isFinite(value) ? value : 0;
}

export function parseShortstat(shortstat: string): DiffStats {
  return {
    filesCount: parseFirstIntegerMatch(shortstat, /(\d+)\s+files?\s+changed/u),
    insertions: parseFirstIntegerMatch(shortstat, /(\d+)\s+insertions?\(\+\)/u),
    deletions: parseFirstIntegerMatch(shortstat, /(\d+)\s+deletions?\(-\)/u),
  };
}

export function tallyWorkspaceStats(stats: WorkspaceChangeStats): DiffStats {
  return {
    filesCount: stats.fileCount,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

type PrimaryAndFeatureWorktree = {
  primaryRepo: string;
  worktreePath: string;
};

export async function createPrimaryAndFeatureWorktree(): Promise<PrimaryAndFeatureWorktree> {
  const primaryRepo = await initRepo();

  const worktreeParent = await makeTempDir(
    "omnyo-workspace-squash-worktree-parent-",
  );

  const worktreePath = path.join(worktreeParent, "feature");
  await runGit(["worktree", "add", "-b", "feature", worktreePath, "main"], {
    cwd: primaryRepo,
  });
  await fs.writeFile(path.join(worktreePath, "README.md"), "squash\n", "utf8");
  await runGit(["add", "README.md"], { cwd: worktreePath });
  await runGit(["commit", "-m", "Feature work"], { cwd: worktreePath });

  return { primaryRepo, worktreePath };
}

export async function mergeFeatureIntoMainWithSquash(
  primaryRepo: string,
  message: string,
): Promise<void> {
  await runGit(["merge", "--squash", "feature"], { cwd: primaryRepo });
  await runGit(["commit", "--no-verify", "-m", message], {
    cwd: primaryRepo,
  });
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
}
