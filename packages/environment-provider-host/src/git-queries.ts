import path from "node:path";

export interface GitProcessOptions {
  shellPath?: string;
}

export interface GitTimeoutOptions extends GitProcessOptions {
  timeoutMs?: number;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRepoKind = "work-tree" | "bare" | "none";

type GitQueryRunner = (
  args: string[],
  options: GitTimeoutOptions & {
    cwd: string;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
) => Promise<GitCommandResult>;

export function createGitQueries(
  runGit: GitQueryRunner,
  WorkspaceError: new (code: string, message: string) => Error,
) {
  async function getGitCommonDir(
    cwd: string,
    options: GitProcessOptions & { signal?: AbortSignal } = {},
  ): Promise<string> {
    const result = await runGit(["rev-parse", "--git-common-dir"], {
      cwd,
      ...options,
    });

    const commonDir = result.stdout.trim();

    if (!commonDir) {
      throw new WorkspaceError(
        "git_command_failed",
        `git rev-parse --git-common-dir returned no path for ${cwd}`,
      );
    }

    return path.resolve(cwd, commonDir);
  }

  async function detectGitRepoKind(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<GitRepoKind> {
    const result = await runGit(
      ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"],
      { cwd, ...options, allowFailure: true },
    );

    if (result.exitCode !== 0) {
      return "none";
    }

    const [insideWorkTree, bare] = result.stdout.trim().split("\n");

    if (insideWorkTree === "true") {
      return "work-tree";
    }

    if (bare === "true") {
      return "bare";
    }

    return "none";
  }

  async function detectGitRepo(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<boolean> {
    return (await detectGitRepoKind(cwd, options)) === "work-tree";
  }

  async function detectGitSource(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<boolean> {
    return (await detectGitRepoKind(cwd, options)) !== "none";
  }

  async function ensureGitRepo(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<void> {
    if (await detectGitSource(cwd, options)) {
      return;
    }

    throw new WorkspaceError(
      "not_git_repo",
      `Path is not a git repository: ${cwd}`,
    );
  }

  async function getCurrentBranch(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    if (!(await detectGitRepo(cwd, options))) {
      return undefined;
    }

    const result = await runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        cwd,
        ...options,
        allowFailure: true,
      },
    );

    if (result.exitCode !== 0) {
      return undefined;
    }

    const branchName = result.stdout.trim();

    return branchName || undefined;
  }

  return {
    getGitCommonDir,
    detectGitRepoKind,
    detectGitRepo,
    detectGitSource,
    ensureGitRepo,
    getCurrentBranch,
  };
}
