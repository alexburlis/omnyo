import {
  experimental_runVcsProcess as runVcsProcess,
  experimental_sanitizeInheritedChildProcessEnv as sanitizeInheritedChildProcessEnv,
  experimental_spawnPortableOutputProcess as spawnPortableOutputProcess,
} from "@omnyo/plugin-sdk/host";
import {
  createGitQueries,
  type GitCommandResult,
  type GitProcessOptions,
  type GitTimeoutOptions,
} from "./git-queries.js";

export type { GitCommandResult, GitProcessOptions } from "./git-queries.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const USES_PROCESS_GROUPS = process.platform !== "win32";

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "WorkspaceError";
  }
}

export interface RunGitOptions extends GitProcessOptions {
  cwd: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export type GitRepositoryState = "not_git" | "no_commits" | "has_commits";

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

interface GitOutputBuffer {
  append: (chunk: Buffer) => boolean;
  read: () => string;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

function describeCommand(args: string[]): string {
  return `git ${args.join(" ")}`;
}

function createGitCommandCancelledError(
  args: string[],
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    `${describeCommand(args)} was cancelled`,
    { cause },
  );
}

function createGitCommandFailedError(
  args: string[],
  stderr: string,
  cause?: unknown,
): WorkspaceError {
  const detail = stderr ? `: ${stderr}` : "";

  return new WorkspaceError(
    "git_command_failed",
    `${describeCommand(args)} failed${detail}`,
    { cause },
  );
}

function resolveGitProcessEnv(options: RunGitOptions): NodeJS.ProcessEnv {
  return {
    ...sanitizeInheritedChildProcessEnv({
      env: process.env,
      ...(options.shellPath !== undefined
        ? { shellPath: options.shellPath }
        : {}),
    }),
    ...options.env,
  };
}

function createGitOutputBuffer(maxBytes: number): GitOutputBuffer {
  const chunks: Buffer[] = [];
  let size = 0;

  return {
    append(chunk: Buffer): boolean {
      size += chunk.length;

      if (size > maxBytes) {
        return false;
      }

      chunks.push(chunk);

      return true;
    },
    read(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

export function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    return Promise.reject(
      createGitCommandCancelledError(args, options.signal.reason),
    );
  }

  return runVcsProcess("git", args, () => runGitAdmitted(args, options), {
    signal: options.signal,
    priority: "background",
  }).catch((error: unknown) => {
    if (options.signal?.aborted)
      throw createGitCommandCancelledError(args, error);
    throw error;
  });
}

function runGitAdmitted(
  args: string[],
  options: RunGitOptions,
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    const stdout = createGitOutputBuffer(maxOutputBytes);
    const stderr = createGitOutputBuffer(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawnPortableOutputProcess({
      command: "git",
      args,
      cwd: options.cwd,
      detached: USES_PROCESS_GROUPS,
      env: resolveGitProcessEnv(options),
    });

    const signalGit = (signal: NodeJS.Signals): void => {
      if (USES_PROCESS_GROUPS && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);

          return;
        } catch {}
      }

      child.kill(signal);
    };

    const onAbort = (): void => {
      signalGit("SIGTERM");
    };

    const release = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      options.signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: WorkspaceError): void => {
      if (settled) {
        return;
      }

      settled = true;
      release();
      reject(error);
    };

    const succeed = (result: GitCommandResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      release();
      resolve(result);
    };

    const readInto = (buffer: GitOutputBuffer) => {
      return (chunk: Buffer): void => {
        if (!buffer.append(chunk)) {
          overflowed = true;
          signalGit("SIGKILL");
        }
      };
    };

    child.stdout.on("data", readInto(stdout));
    child.stderr.on("data", readInto(stderr));

    child.on("error", (error) => {
      if (options.signal?.aborted) {
        fail(createGitCommandCancelledError(args, error));

        return;
      }

      if (options.allowFailure === true) {
        succeed({ stdout: "", stderr: "", exitCode: 1 });

        return;
      }

      fail(createGitCommandFailedError(args, "", error));
    });

    child.on("close", (code) => {
      if (options.signal?.aborted) {
        fail(createGitCommandCancelledError(args, options.signal.reason));

        return;
      }

      if (timedOut) {
        fail(
          new WorkspaceError(
            "git_command_timeout",
            `${describeCommand(args)} timed out after ${options.timeoutMs}ms`,
          ),
        );

        return;
      }

      if (overflowed) {
        fail(
          new WorkspaceError(
            "git_command_failed",
            `${describeCommand(args)} produced more than ${maxOutputBytes} bytes of output`,
          ),
        );

        return;
      }

      const result: GitCommandResult = {
        stdout: stdout.read(),
        stderr: stderr.read(),
        exitCode: code ?? 1,
      };

      if (result.exitCode === 0 || options.allowFailure === true) {
        succeed(result);

        return;
      }

      fail(createGitCommandFailedError(args, trimOutput(result.stderr)));
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        signalGit("SIGTERM");
      }, options.timeoutMs);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const gitQueries = createGitQueries(runGit, WorkspaceError);

export const { getGitCommonDir, detectGitRepo, getCurrentBranch } = gitQueries;

const { detectGitSource, ensureGitRepo } = gitQueries;

export async function readGitRepositoryState(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepositoryState> {
  if (!(await detectGitSource(cwd, options))) {
    return "not_git";
  }

  const result = await runGit(["rev-list", "--all", "--max-count=1"], {
    cwd,
    ...options,
  });

  return trimOutput(result.stdout).length > 0 ? "has_commits" : "no_commits";
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

export async function readDefaultBranch(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  await ensureGitRepo(cwd, options);
  const originHeadBranch = await readOriginHeadBranchName(cwd, options);

  if (originHeadBranch !== undefined) {
    return originHeadBranch;
  }

  return resolvePreferredLocalDefaultBranch(
    await readLocalBranches(cwd, options),
    undefined,
  );
}

export async function hasRef(
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

export async function findWorktreeForBranch(
  cwd: string,
  branchName: string,
  options: GitTimeoutOptions = {},
): Promise<string | null> {
  await ensureGitRepo(cwd, options);

  const result = await runGit(["worktree", "list", "--porcelain"], {
    cwd,
    ...options,
  });

  let worktreePath: string | null = null;

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktreePath = line.slice("worktree ".length);
    } else if (
      line === `branch refs/heads/${branchName}` &&
      worktreePath !== null
    ) {
      return worktreePath;
    }
  }

  return null;
}

function resolvePreferredLocalDefaultBranch(
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

async function readOriginHeadBranchName(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd, ...options, allowFailure: true },
  );

  const remoteHead = trimOutput(originHead.stdout);

  if (remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }

  return undefined;
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

  return trimOutput(result.stdout) || undefined;
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

export async function readBranchRelation(
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

export interface ResolveDefaultBaseBranchArgs {
  defaultBranch: string | null;
  defaultBranchRelation: DefaultBranchRelation | null;
  originDefaultBranch: string | null;
}

export function resolveDefaultBaseBranch(
  args: ResolveDefaultBaseBranchArgs,
): string | null {
  if (!args.originDefaultBranch) {
    return args.defaultBranch;
  }

  if (!args.defaultBranch) {
    return args.originDefaultBranch;
  }

  if (
    args.defaultBranchRelation === "equal" ||
    args.defaultBranchRelation === "local-behind"
  ) {
    return args.originDefaultBranch;
  }

  return args.defaultBranch;
}

export async function readDefaultBranchRefs(
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
