import fs from "node:fs/promises";
import path from "node:path";
import type {
  GitActivity,
  GitActivityCommit,
  GitActivityPush,
  GitActivityRemote,
} from "@omnyo/domain";
import {
  runGit,
  WorkspaceError,
  type GitCommandResult,
  type GitProcessOptions,
  type RunGitOptions,
} from "./git.js";

export interface GitActivityWindow {
  startMs: number;
  endMs: number;
}

export interface ReadWorkspaceGitActivityArgs {
  workspacePath: string;
  windows: readonly GitActivityWindow[];
  maxCommits: number;
  maxPushes: number;
}

interface ReflogEntry {
  oldSha: string;
  newSha: string;
  at: number;
  message: string;
}

interface Reflog {
  name: string;
  entries: ReflogEntry[];
}

interface CommitReflogEntry extends ReflogEntry {
  kind: GitActivityCommit["kind"];
}

interface PushReflogEntry extends ReflogEntry {
  remote: string;
  branch: string;
}

type GitRunner = (
  args: string[],
  options?: Pick<RunGitOptions, "allowFailure">,
) => Promise<GitCommandResult>;

const GIT_ACTIVITY_GIT_TIMEOUT_MS = 10_000;

const WINDOW_SLACK_MS = 1_000;

const REFLOG_MTIME_SLACK_MS = 5_000;

const PUSH_REFLOG_MESSAGE = "update by push";

const REMOTE_REF_PREFIX = "refs/remotes/";

const REFLOG_LINE_PATTERN =
  /^([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) (.*) (\d+) ([+-]\d{4})\t(.*)$/u;

const NULL_OBJECT_ID_PATTERN = /^0+$/u;

const COMMIT_KIND_BY_REFLOG_MESSAGE: readonly {
  pattern: RegExp;
  kind: GitActivityCommit["kind"];
}[] = [
  { pattern: /^commit(?: \(initial\))?: /u, kind: "commit" },
  { pattern: /^commit \(amend\): /u, kind: "amend" },
  { pattern: /^commit \(merge\): /u, kind: "merge" },
  { pattern: /^cherry-pick: /u, kind: "cherry-pick" },
  { pattern: /^revert: /u, kind: "revert" },
  { pattern: /^(?:merge .+|pull(?: .+)?): Merge made by /u, kind: "merge" },
];

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isInWindows(
  at: number,
  windows: readonly GitActivityWindow[],
): boolean {
  return windows.some(
    (window) =>
      at >= window.startMs - WINDOW_SLACK_MS &&
      at <= window.endMs + WINDOW_SLACK_MS,
  );
}

function nullableObjectId(objectId: string): string | null {
  return NULL_OBJECT_ID_PATTERN.test(objectId) ? null : objectId;
}

function parseReflogEntries(
  content: string,
  windows: readonly GitActivityWindow[],
): ReflogEntry[] {
  return content.split("\n").flatMap((line) => {
    const match = REFLOG_LINE_PATTERN.exec(line);

    if (match === null) {
      return [];
    }

    const at = Number(match[4]) * 1_000;

    return isInWindows(at, windows)
      ? [{ oldSha: match[1], newSha: match[2], at, message: match[6] }]
      : [];
  });
}

async function readReflogFile(
  filePath: string,
  minMtimeMs: number,
  windows: readonly GitActivityWindow[],
): Promise<ReflogEntry[]> {
  try {
    const stats = await fs.stat(filePath);

    if (!stats.isFile() || stats.mtimeMs < minMtimeMs) {
      return [];
    }

    return parseReflogEntries(await fs.readFile(filePath, "utf8"), windows);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }
}

async function listReflogNames(root: string): Promise<string[]> {
  try {
    const names = await fs.readdir(root, { recursive: true });

    return names.map((name) => name.split(path.sep).join("/"));
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }
}

async function readReflogTree(
  root: string,
  minMtimeMs: number,
  windows: readonly GitActivityWindow[],
): Promise<Reflog[]> {
  const reflogs = await Promise.all(
    (await listReflogNames(root)).map(async (name) => ({
      name,
      entries: await readReflogFile(path.join(root, name), minMtimeMs, windows),
    })),
  );

  return reflogs.filter((reflog) => reflog.entries.length > 0);
}

function commitKindForReflogMessage(
  message: string,
): GitActivityCommit["kind"] | null {
  return (
    COMMIT_KIND_BY_REFLOG_MESSAGE.find(({ pattern }) => pattern.test(message))
      ?.kind ?? null
  );
}

function byTime(left: ReflogEntry, right: ReflogEntry): number {
  return left.at - right.at;
}

function latestCommitEntries(
  headEntries: readonly ReflogEntry[],
  maxCommits: number,
): CommitReflogEntry[] {
  const commitsBySha = new Map<string, CommitReflogEntry>();

  for (const entry of [...headEntries].sort(byTime)) {
    const kind = commitKindForReflogMessage(entry.message);

    if (kind !== null && !commitsBySha.has(entry.newSha)) {
      commitsBySha.set(entry.newSha, { ...entry, kind });
    }
  }

  return [...commitsBySha.values()].slice(-maxCommits);
}

function latestPushEntries(
  remoteReflogs: readonly Reflog[],
  maxPushes: number,
): PushReflogEntry[] {
  return remoteReflogs
    .flatMap((reflog) => {
      const [remote, ...branchSegments] = reflog.name.split("/");
      const branch = branchSegments.join("/");

      return reflog.entries.flatMap((entry) =>
        entry.message === PUSH_REFLOG_MESSAGE && branch !== ""
          ? [{ ...entry, remote, branch }]
          : [],
      );
    })
    .sort(byTime)
    .slice(-maxPushes);
}

function branchForCommit(
  commit: CommitReflogEntry,
  branchReflogs: readonly Reflog[],
): string | null {
  return (
    branchReflogs.find((reflog) =>
      reflog.entries.some(
        (entry) =>
          entry.newSha === commit.newSha &&
          entry.message === commit.message &&
          Math.abs(entry.at - commit.at) <= WINDOW_SLACK_MS,
      ),
    )?.name ?? null
  );
}

async function readCommitSubjects(
  git: GitRunner,
  shas: readonly string[],
): Promise<Map<string, string>> {
  if (shas.length === 0) {
    return new Map();
  }

  const result = await git([
    "log",
    "--no-walk",
    "--ignore-missing",
    "--format=%H%x00%s",
    ...shas,
  ]);

  return new Map(
    result.stdout.split("\n").flatMap((line) => {
      const separator = line.indexOf("\0");

      return separator === -1
        ? []
        : [[line.slice(0, separator), line.slice(separator + 1)] as const];
    }),
  );
}

async function readRemoteRefs(git: GitRunner, sha: string): Promise<string[]> {
  const result = await git([
    "for-each-ref",
    "--contains",
    sha,
    "--format=%(refname)",
    REMOTE_REF_PREFIX,
  ]);

  return result.stdout
    .split("\n")
    .flatMap((ref) =>
      ref.startsWith(REMOTE_REF_PREFIX) && !ref.endsWith("/HEAD")
        ? [ref.slice(REMOTE_REF_PREFIX.length)]
        : [],
    )
    .sort();
}

async function readCommits(
  git: GitRunner,
  entries: readonly CommitReflogEntry[],
  branchReflogs: readonly Reflog[],
): Promise<GitActivityCommit[]> {
  const subjects = await readCommitSubjects(
    git,
    entries.map((entry) => entry.newSha),
  );

  return Promise.all(
    entries
      .flatMap((entry) => {
        const subject = subjects.get(entry.newSha);

        return subject === undefined ? [] : [{ entry, subject }];
      })
      .map(async ({ entry, subject }) => ({
        sha: entry.newSha,
        subject,
        kind: entry.kind,
        branch: branchForCommit(entry, branchReflogs),
        replacedSha:
          entry.kind === "amend" ? nullableObjectId(entry.oldSha) : null,
        committedAt: entry.at,
        remoteRefs: await readRemoteRefs(git, entry.newSha),
      })),
  );
}

async function readPush(
  git: GitRunner,
  entry: PushReflogEntry,
): Promise<GitActivityPush> {
  const oldSha = nullableObjectId(entry.oldSha);

  const push = {
    remote: entry.remote,
    branch: entry.branch,
    oldSha,
    newSha: entry.newSha,
    pushedAt: entry.at,
  };

  if (oldSha === null) {
    return { ...push, forced: false, commitCount: null };
  }

  const result = await git(
    ["rev-list", "--left-right", "--count", `${oldSha}...${entry.newSha}`],
    { allowFailure: true },
  );

  if (result.exitCode !== 0) {
    return { ...push, forced: false, commitCount: null };
  }

  const [onlyOld, onlyNew] = result.stdout.trim().split(/\s+/u).map(Number);

  return { ...push, forced: onlyOld > 0, commitCount: onlyNew };
}

function withoutUrlCredentials(url: string): string {
  if (!URL.canParse(url)) {
    return url;
  }

  const parsed = new URL(url);

  if (parsed.username === "" && parsed.password === "") {
    return url;
  }

  parsed.username = "";
  parsed.password = "";

  return parsed.toString();
}

async function readRemotes(
  git: GitRunner,
  names: ReadonlySet<string>,
): Promise<GitActivityRemote[]> {
  const remotes = await Promise.all(
    [...names].sort().map(async (name) => {
      const result = await git(["remote", "get-url", name], {
        allowFailure: true,
      });

      const url = result.stdout.trim();

      return result.exitCode === 0 && url !== ""
        ? [{ name, url: withoutUrlCredentials(url) }]
        : [];
    }),
  );

  return remotes.flat();
}

async function readGitDirs(
  git: GitRunner,
  workspacePath: string,
): Promise<{ gitDir: string; commonDir: string }> {
  const result = await git([
    "rev-parse",
    "--absolute-git-dir",
    "--git-common-dir",
  ]);

  const [gitDir, commonDir] = result.stdout.trim().split(/\r?\n/u);

  if (!gitDir || !commonDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse returned no git directories for ${workspacePath}`,
    );
  }

  return {
    gitDir: path.resolve(gitDir),
    commonDir: path.resolve(workspacePath, commonDir),
  };
}

export async function readWorkspaceGitActivity(
  args: ReadWorkspaceGitActivityArgs,
  options: GitProcessOptions = {},
): Promise<GitActivity> {
  const git: GitRunner = (gitArgs, runOptions = {}) =>
    runGit(gitArgs, {
      cwd: args.workspacePath,
      timeoutMs: GIT_ACTIVITY_GIT_TIMEOUT_MS,
      ...runOptions,
      ...options,
    });

  const { gitDir, commonDir } = await readGitDirs(git, args.workspacePath);

  const minMtimeMs =
    Math.min(...args.windows.map((window) => window.startMs)) -
    REFLOG_MTIME_SLACK_MS;

  const [headEntries, branchReflogs, remoteReflogs] = await Promise.all([
    readReflogFile(path.join(gitDir, "logs", "HEAD"), minMtimeMs, args.windows),
    readReflogTree(
      path.join(commonDir, "logs", "refs", "heads"),
      minMtimeMs,
      args.windows,
    ),
    readReflogTree(
      path.join(commonDir, "logs", "refs", "remotes"),
      minMtimeMs,
      args.windows,
    ),
  ]);

  const [commits, pushes] = await Promise.all([
    readCommits(
      git,
      latestCommitEntries(headEntries, args.maxCommits),
      branchReflogs,
    ),
    Promise.all(
      latestPushEntries(remoteReflogs, args.maxPushes).map((entry) =>
        readPush(git, entry),
      ),
    ),
  ]);

  const remoteNames = new Set([
    ...pushes.map((push) => push.remote),
    ...commits.flatMap((commit) =>
      commit.remoteRefs.map((remoteRef) => remoteRef.split("/")[0]),
    ),
  ]);

  return {
    commits,
    pushes,
    remotes: await readRemotes(git, remoteNames),
  };
}
