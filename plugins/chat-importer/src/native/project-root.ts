import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectRootHint } from "../host-contract.js";

const GIT_FILE_MAX_BYTES = 64 * 1024;

type GitEntry = "directory" | "file" | null;

async function gitEntryKind(directory: string): Promise<GitEntry> {
  try {
    const stats = await fs.lstat(path.join(directory, ".git"));

    if (stats.isDirectory()) return "directory";

    return stats.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

async function readSmallText(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);

    if (!stats.isFile() || stats.size > GIT_FILE_MAX_BYTES) return null;

    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function worktreeMainRepository(
  worktreeRoot: string,
): Promise<string | null> {
  const gitFile = await readSmallText(path.join(worktreeRoot, ".git"));
  const match = gitFile?.match(/^gitdir:\s*(.+?)\s*$/m);

  if (!match?.[1]) return null;
  const gitDir = path.resolve(worktreeRoot, match[1]);
  const commonDirText = await readSmallText(path.join(gitDir, "commondir"));
  const commonDirValue = commonDirText?.trim();

  if (!commonDirValue) return null;
  const commonDir = path.resolve(gitDir, commonDirValue);

  return path.basename(commonDir) === ".git"
    ? path.dirname(commonDir)
    : commonDir;
}

export async function resolveProjectRoot(
  cwd: string,
): Promise<ProjectRootHint> {
  let directory = path.resolve(cwd);

  for (;;) {
    const kind = await gitEntryKind(directory);

    if (kind === "directory")
      return { path: directory, kind: "git", mainRepositoryPath: null };

    if (kind === "file") {
      const mainRepositoryPath = await worktreeMainRepository(directory);

      return mainRepositoryPath === null
        ? { path: directory, kind: "git", mainRepositoryPath: null }
        : { path: directory, kind: "git-worktree", mainRepositoryPath };
    }

    const parent = path.dirname(directory);

    if (parent === directory) break;
    directory = parent;
  }

  return { path: path.resolve(cwd), kind: "folder", mainRepositoryPath: null };
}

export interface CwdDescription {
  readonly cwdExists: boolean;
  readonly realCwd: string | null;
  readonly projectRoot: ProjectRootHint | null;
}

async function realDirectory(cwd: string): Promise<string | null> {
  if (!path.isAbsolute(cwd)) return null;

  try {
    const real = await fs.realpath(cwd);

    return (await fs.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export async function describeCwd(cwd: string): Promise<CwdDescription> {
  const realCwd = await realDirectory(cwd);

  return {
    cwdExists: realCwd !== null,
    realCwd,
    projectRoot: realCwd === null ? null : await resolveProjectRoot(realCwd),
  };
}
