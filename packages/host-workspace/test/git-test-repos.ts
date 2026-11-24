import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../src/git.js";

const tempDirs: string[] = [];

export async function initReadGitBlobRepo() {
  const repoPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "omnyo-read-git-blob-"),
  );

  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "Omnyo Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "omnyo@example.com"], {
    cwd: repoPath,
  });
  await fs.mkdir(path.join(repoPath, "docs"));
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await fs.writeFile(path.join(repoPath, "docs", "index.md"), "docs\n", "utf8");
  await fs.writeFile(path.join(repoPath, "large.txt"), "0123456789\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });

  return repoPath;
}

export async function initEmptyRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-empty-git-"));
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });

  return repoPath;
}

export async function initConflictRepo() {
  const repoPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "omnyo-git-conflict-"),
  );

  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "Omnyo Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "omnyo@example.com"], {
    cwd: repoPath,
  });
  await fs.writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  await runGit(["switch", "-c", "feature"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
  await runGit(["commit", "-am", "Feature edit"], { cwd: repoPath });
  await runGit(["switch", "main"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "main\n", "utf8");
  await runGit(["commit", "-am", "Main edit"], { cwd: repoPath });

  return repoPath;
}

export async function initDefaultBranchRemoteRepo() {
  const repoPath = await initReadGitBlobRepo();

  const remotePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "omnyo-git-remote-"),
  );

  tempDirs.push(remotePath);
  await runGit(["init", "--bare"], { cwd: remotePath });
  await runGit(["remote", "add", "origin", remotePath], { cwd: repoPath });
  await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });
  await runGit(["fetch", "origin"], { cwd: repoPath });

  return { remotePath, repoPath };
}

export async function pushRemoteMainCommit(remotePath: string) {
  const cloneParent = await fs.mkdtemp(
    path.join(os.tmpdir(), "omnyo-git-remote-clone-"),
  );

  tempDirs.push(cloneParent);
  const clonePath = path.join(cloneParent, "repo");
  await runGit(["clone", "--branch", "main", remotePath, clonePath], {
    cwd: cloneParent,
  });
  await runGit(["config", "user.name", "Omnyo Tests"], { cwd: clonePath });
  await runGit(["config", "user.email", "omnyo@example.com"], {
    cwd: clonePath,
  });
  await fs.writeFile(path.join(clonePath, "remote.txt"), "remote\n", "utf8");
  await runGit(["add", "."], { cwd: clonePath });
  await runGit(["commit", "-m", "Remote edit"], { cwd: clonePath });
  await runGit(["push", "origin", "main"], { cwd: clonePath });
}

export async function initSshRemoteRepo() {
  const repoPath = await initReadGitBlobRepo();
  const sshLogPath = path.join(repoPath, "ssh-invocations.log");
  const sshScriptPath = path.join(repoPath, "recording-ssh.sh");
  await fs.writeFile(
    sshScriptPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(sshLogPath.replaceAll("\\", "/"))}\nprintf 'GIT_TERMINAL_PROMPT=%s\\n' "\${GIT_TERMINAL_PROMPT-unset}" >> ${JSON.stringify(sshLogPath.replaceAll("\\", "/"))}\nexit 255\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  await runGit(["remote", "add", "origin", "ssh://git.invalid/repo.git"], {
    cwd: repoPath,
  });
  await runGit(
    [
      "config",
      "core.sshCommand",
      "'" + sshScriptPath.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'",
    ],
    { cwd: repoPath },
  );

  return { repoPath, sshLogPath };
}

export async function initBareWorktreeLayout() {
  const origin = await initReadGitBlobRepo();
  await runGit(["branch", "feature-a"], { cwd: origin });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-bare-layout-"));
  tempDirs.push(root);
  await runGit(["clone", "--bare", origin, ".bare"], { cwd: root });
  await fs.writeFile(path.join(root, ".git"), "gitdir: ./.bare\n", "utf8");
  await runGit(["worktree", "add", "feature-a", "feature-a"], { cwd: root });

  return { root, worktreePath: path.join(root, "feature-a") };
}

export function trackTempDir(...dirs: string[]): void {
  tempDirs.push(...dirs);
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
}
