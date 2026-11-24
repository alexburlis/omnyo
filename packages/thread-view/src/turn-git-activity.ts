import type {
  GitActivity,
  GitActivityCommit,
  GitActivityPush,
} from "@omnyo/domain";
import { plural } from "./format-helpers.js";

export type TurnGitActivityState =
  | "pushed"
  | "partly-pushed"
  | "not-pushed"
  | "push-only"
  | "none";

export interface TurnGitActivitySummary {
  state: TurnGitActivityState;
  commitCount: number;
  pushedCount: number;
  unpushedCount: number;
  commitBranch: string | null;
  pushTargets: string[];
  pushedCommitCount: number | null;
  remoteLabel: string | null;
}

interface GitRemoteRef {
  remote: string | null;
  branch: string;
}

type ParsedGitRemoteUrl =
  | { kind: "hosted"; host: string; path: string }
  | { kind: "local"; path: string };

const SHORT_GIT_SHA_LENGTH = 7;

const SCHEME_REMOTE_URL_PATTERN =
  /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:?#]+)(?::\d*)?(\/[^?#]*)?/i;

const SCP_REMOTE_URL_PATTERN = /^(?:[^@/:]+@)?([^/:]+):(.+)$/;

const LOCAL_REMOTE_PATH_PATTERN = /^(?:\/|\.{1,2}[\\/]|~|[a-z]:[\\/])/i;

const FILE_REMOTE_URL_PREFIX = "file://";

const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "ssh.github.com",
]);

const GITHUB_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function shortGitSha(sha: string): string {
  return sha.slice(0, SHORT_GIT_SHA_LENGTH);
}

export function normalizeTurnGitActivity(activity: GitActivity): GitActivity {
  const replacedByLaterCommit = new Set<string>();
  const keptNewestFirst: GitActivityCommit[] = [];

  for (let index = activity.commits.length - 1; index >= 0; index -= 1) {
    const commit = activity.commits[index];

    if (commit === undefined) continue;

    if (!replacedByLaterCommit.has(commit.sha)) keptNewestFirst.push(commit);

    if (commit.replacedSha !== null)
      replacedByLaterCommit.add(commit.replacedSha);
  }

  if (keptNewestFirst.length === activity.commits.length) return activity;

  return { ...activity, commits: keptNewestFirst.reverse() };
}

export function formatGitRefLabel(remote: string, branch: string): string {
  return remote === "origin" ? branch : `${remote}/${branch}`;
}

function normalizeHostedRepoPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

function localRepoName(path: string): string {
  const segments = path
    .replace(/[\\/]+$/, "")
    .replace(/[\\/]\.git$/i, "")
    .split(/[\\/]/);

  return (segments[segments.length - 1] ?? "").replace(/\.git$/i, "");
}

function parseGitRemoteUrl(url: string): ParsedGitRemoteUrl | null {
  const trimmed = url.trim();

  if (trimmed.toLowerCase().startsWith(FILE_REMOTE_URL_PREFIX)) {
    return {
      kind: "local",
      path: trimmed.slice(FILE_REMOTE_URL_PREFIX.length),
    };
  }

  const schemeMatch = SCHEME_REMOTE_URL_PATTERN.exec(trimmed);

  if (schemeMatch) {
    return {
      kind: "hosted",
      host: (schemeMatch[2] ?? "").toLowerCase(),
      path: normalizeHostedRepoPath(schemeMatch[3] ?? ""),
    };
  }

  if (LOCAL_REMOTE_PATH_PATTERN.test(trimmed)) {
    return { kind: "local", path: trimmed };
  }

  const scpMatch = SCP_REMOTE_URL_PATTERN.exec(trimmed);

  if (scpMatch) {
    return {
      kind: "hosted",
      host: (scpMatch[1] ?? "").toLowerCase(),
      path: normalizeHostedRepoPath(scpMatch[2] ?? ""),
    };
  }

  return null;
}

export function formatGitRemoteLabel(url: string): string {
  const parsed = parseGitRemoteUrl(url);

  const label =
    parsed === null
      ? ""
      : parsed.kind === "local"
        ? localRepoName(parsed.path)
        : parsed.path;

  return label.length > 0 ? label : url;
}

export function gitCommitWebUrl(url: string, sha: string): string | null {
  const parsed = parseGitRemoteUrl(url);

  if (parsed?.kind !== "hosted" || !GITHUB_HOSTS.has(parsed.host)) {
    return null;
  }

  const segments = parsed.path.split("/");

  if (
    segments.length !== 2 ||
    !segments.every((segment) => GITHUB_PATH_SEGMENT_PATTERN.test(segment))
  ) {
    return null;
  }

  return `https://github.com/${parsed.path}/commit/${sha}`;
}

function findGitRemoteUrl(
  activity: GitActivity,
  remoteName: string,
): string | null {
  return (
    activity.remotes.find((remote) => remote.name === remoteName)?.url ?? null
  );
}

function parseGitRemoteRef(
  ref: string,
  remoteNames: readonly string[],
): GitRemoteRef {
  let knownRemote: string | null = null;

  for (const name of remoteNames) {
    if (
      ref.startsWith(`${name}/`) &&
      (knownRemote === null || name.length > knownRemote.length)
    ) {
      knownRemote = name;
    }
  }

  if (knownRemote !== null) {
    return { remote: knownRemote, branch: ref.slice(knownRemote.length + 1) };
  }

  const slashIndex = ref.indexOf("/");

  return slashIndex > 0
    ? { remote: ref.slice(0, slashIndex), branch: ref.slice(slashIndex + 1) }
    : { remote: null, branch: ref };
}

function gitRemoteRefLabel(ref: GitRemoteRef): string {
  return ref.remote === null
    ? ref.branch
    : formatGitRefLabel(ref.remote, ref.branch);
}

export function formatGitActivityRemoteLabel(
  activity: GitActivity,
  remoteName: string,
): string | null {
  const url = findGitRemoteUrl(activity, remoteName);

  return url === null ? null : formatGitRemoteLabel(url);
}

export function gitActivityCommitWebUrl(
  activity: GitActivity,
  commit: GitActivityCommit,
): string | null {
  const remoteNames = activity.remotes.map((remote) => remote.name);

  for (const ref of commit.remoteRefs) {
    const { remote } = parseGitRemoteRef(ref, remoteNames);
    const url = remote === null ? null : findGitRemoteUrl(activity, remote);
    const webUrl = url === null ? null : gitCommitWebUrl(url, commit.sha);

    if (webUrl !== null) return webUrl;
  }

  return null;
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function turnGitActivityState(
  commitCount: number,
  unpushedCount: number,
  pushCount: number,
): TurnGitActivityState {
  if (commitCount === 0) return pushCount > 0 ? "push-only" : "none";

  if (unpushedCount === 0) return "pushed";

  return unpushedCount === commitCount ? "not-pushed" : "partly-pushed";
}

function totalPushedCommitCount(
  pushes: readonly GitActivityPush[],
): number | null {
  let total = 0;

  for (const push of pushes) {
    if (push.commitCount === null) return null;
    total += push.commitCount;
  }

  return total > 0 ? total : null;
}

export function summarizeTurnGitActivity(
  activity: GitActivity,
): TurnGitActivitySummary {
  const remoteNames = activity.remotes.map((remote) => remote.name);
  const commitCount = activity.commits.length;

  const pushedCount = activity.commits.filter(
    (commit) => commit.remoteRefs.length > 0,
  ).length;

  const unpushedCount = commitCount - pushedCount;

  const pushRefs: GitRemoteRef[] =
    activity.pushes.length > 0
      ? activity.pushes.map((push) => ({
          remote: push.remote,
          branch: push.branch,
        }))
      : activity.commits.flatMap((commit) =>
          commit.remoteRefs.map((ref) => parseGitRemoteRef(ref, remoteNames)),
        );

  const pushRemotes = distinct(
    pushRefs.flatMap((ref) => (ref.remote === null ? [] : [ref.remote])),
  );

  const onlyPushRemote = pushRemotes.length === 1 ? pushRemotes[0] : undefined;

  const commitBranches = distinct(
    activity.commits.map((commit) => commit.branch),
  );

  return {
    state: turnGitActivityState(
      commitCount,
      unpushedCount,
      activity.pushes.length,
    ),
    commitCount,
    pushedCount,
    unpushedCount,
    commitBranch:
      commitBranches.length === 1 ? (commitBranches[0] ?? null) : null,
    pushTargets: distinct(pushRefs.map(gitRemoteRefLabel)),
    pushedCommitCount: totalPushedCommitCount(activity.pushes),
    remoteLabel:
      onlyPushRemote === undefined
        ? null
        : formatGitActivityRemoteLabel(activity, onlyPushRemote),
  };
}

export function formatTurnGitActivitySentence(
  summary: TurnGitActivitySummary,
): string | null {
  const commits = `${plural(summary.commitCount, "commit")}${
    summary.commitBranch === null ? "" : ` on ${summary.commitBranch}`
  }`;

  const destination = `${summary.pushTargets.join(", ")}${
    summary.remoteLabel === null ? "" : ` (${summary.remoteLabel})`
  }`;

  switch (summary.state) {
    case "pushed":
      return `${commits}, pushed to ${destination}`;
    case "partly-pushed":
      return `${commits}, ${summary.pushedCount} pushed to ${destination}, ${summary.unpushedCount} not pushed`;
    case "not-pushed":
      return `${commits}, not pushed`;
    case "push-only":
      return summary.pushedCommitCount === null
        ? `pushed to ${destination}`
        : `pushed ${plural(summary.pushedCommitCount, "commit")} to ${destination}`;
    case "none":
      return null;
  }
}
