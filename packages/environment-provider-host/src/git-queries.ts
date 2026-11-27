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

export type DefaultBranchRelation =
  | "equal"
  | "local-behind"
  | "local-ahead"
  | "diverged"
  | "unknown";

export interface DefaultBranchRefs {
  defaultBranch: string | undefined;
  defaultBranchRelation: DefaultBranchRelation | undefined;
  originDefaultBranch: string | undefined;
}

type GitQueryRunner = (
  args: string[],
  options: GitTimeoutOptions & {
    cwd: string;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
) => Promise<GitCommandResult>;

export function resolvePreferredLocalDefaultBranch(
  localBranches: readonly string[],
  originDefaultBranchName: string | undefined,
): string | undefined {
  if (
    originDefaultBranchName &&
    localBranches.includes(originDefaultBranchName)
  ) {
    return originDefaultBranchName;
  }

  if (localBranches.includes("main")) {
    return "main";
  }

  if (localBranches.includes("master")) {
    return "master";
  }

  return localBranches[0];
}

export function parseOriginHeadBranchName(output: string): string | undefined {
  const remoteHead = output.trim();

  if (remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }

  return undefined;
}

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

  async function readLocalBranches(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<string[]> {
    const branches = await runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd, ...options },
    );

    return branches.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async function readOriginHeadBranchName(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    const originHead = await runGit(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { cwd, ...options, allowFailure: true },
    );

    return parseOriginHeadBranchName(originHead.stdout);
  }

  async function hasRef(
    cwd: string,
    ref: string,
    options: GitTimeoutOptions = {},
  ): Promise<boolean> {
    await ensureGitRepo(cwd, options);

    const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
      cwd,
      ...options,
      allowFailure: true,
    });

    return result.exitCode === 0;
  }

  async function readOriginDefaultBranch(
    cwd: string,
    localDefaultBranch: string | undefined,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    const originHeadBranch = await readOriginHeadBranchName(cwd, options);

    if (
      originHeadBranch &&
      (await hasRef(cwd, `refs/remotes/origin/${originHeadBranch}`, options))
    ) {
      return `origin/${originHeadBranch}`;
    }

    if (
      localDefaultBranch &&
      (await hasRef(cwd, `refs/remotes/origin/${localDefaultBranch}`, options))
    ) {
      return `origin/${localDefaultBranch}`;
    }

    return undefined;
  }

  async function revParseRef(
    cwd: string,
    ref: string,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    const result = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      ...options,
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      return undefined;
    }

    return result.stdout.trim() || undefined;
  }

  async function isAncestorRef(
    cwd: string,
    ancestorRef: string,
    descendantRef: string,
    options: GitTimeoutOptions = {},
  ): Promise<boolean | undefined> {
    const result = await runGit(
      ["merge-base", "--is-ancestor", ancestorRef, descendantRef],
      { cwd, ...options, allowFailure: true },
    );

    if (result.exitCode === 0) {
      return true;
    }

    if (result.exitCode === 1) {
      return false;
    }

    return undefined;
  }

  async function readBranchRelation(
    cwd: string,
    localDefaultBranch: string | undefined,
    originDefaultBranch: string | undefined,
    options: GitTimeoutOptions = {},
  ): Promise<DefaultBranchRelation | undefined> {
    if (!localDefaultBranch || !originDefaultBranch) {
      return undefined;
    }

    const localRef = `refs/heads/${localDefaultBranch}`;
    const originRef = `refs/remotes/${originDefaultBranch}`;

    const [localSha, originSha] = await Promise.all([
      revParseRef(cwd, localRef, options),
      revParseRef(cwd, originRef, options),
    ]);

    if (!localSha || !originSha) {
      return "unknown";
    }

    if (localSha === originSha) {
      return "equal";
    }

    const localIsAncestor = await isAncestorRef(
      cwd,
      localRef,
      originRef,
      options,
    );

    if (localIsAncestor === true) {
      return "local-behind";
    }

    if (localIsAncestor === undefined) {
      return "unknown";
    }

    const originIsAncestor = await isAncestorRef(
      cwd,
      originRef,
      localRef,
      options,
    );

    if (originIsAncestor === true) {
      return "local-ahead";
    }

    if (originIsAncestor === undefined) {
      return "unknown";
    }

    return "diverged";
  }

  async function readDefaultBranchRefs(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<DefaultBranchRefs> {
    await ensureGitRepo(cwd, options);
    const originHeadBranch = await readOriginHeadBranchName(cwd, options);
    const localBranches = await readLocalBranches(cwd, options);

    const defaultBranch = resolvePreferredLocalDefaultBranch(
      localBranches,
      originHeadBranch,
    );

    const originDefaultBranch = await readOriginDefaultBranch(
      cwd,
      defaultBranch,
      options,
    );

    const defaultBranchRelation = await readBranchRelation(
      cwd,
      defaultBranch,
      originDefaultBranch,
      options,
    );

    return {
      defaultBranch,
      defaultBranchRelation,
      originDefaultBranch,
    };
  }

  return {
    getGitCommonDir,
    detectGitRepoKind,
    detectGitRepo,
    detectGitSource,
    ensureGitRepo,
    getCurrentBranch,
    readLocalBranches,
    readOriginHeadBranchName,
    hasRef,
    isAncestorRef,
    readBranchRelation,
    readDefaultBranchRefs,
  };
}
