import type {
  ExperimentalThreadGit,
  ExperimentalThreadGitChanges,
  ExperimentalThreadGitCommit,
  ExperimentalThreadGitFile,
  ExperimentalThreadGitFileSource,
  ExperimentalThreadGitMergeMethod,
  PluginSidebarPullRequest,
} from "@omnyo/plugin-sdk/app";

export type ReadyThreadGit = Extract<
  ExperimentalThreadGit,
  { status: "ready" }
>;

export type GitTone = "success" | "warning" | "danger" | "merged" | "muted";

export const GIT_TONE_TEXT_CLASS: Record<GitTone, string> = {
  success: "text-success",
  warning: "text-warning-text",
  danger: "text-destructive-text",
  merged: "text-pr-merged",
  muted: "text-muted-foreground",
};

type FileStatus = ExperimentalThreadGitFile["status"];

interface FileStatusDisplay {
  letter: string;
  label: string;
  tone: GitTone;
}

const FILE_STATUS_DISPLAY: Record<FileStatus, FileStatusDisplay> = {
  M: { letter: "M", label: "Modified", tone: "warning" },
  A: { letter: "A", label: "Added", tone: "success" },
  D: { letter: "D", label: "Deleted", tone: "danger" },
  R: { letter: "R", label: "Renamed", tone: "muted" },
  C: { letter: "C", label: "Copied", tone: "muted" },
  U: { letter: "U", label: "Conflicted", tone: "danger" },
  "??": { letter: "N", label: "New", tone: "success" },
  "?": { letter: "?", label: "Unknown", tone: "muted" },
};

export interface GitFileRow {
  path: string;
  basename: string;
  directory: string;
  status: FileStatusDisplay;
  insertions: number | null;
  deletions: number | null;
  source: ExperimentalThreadGitFileSource;
}

export interface GitTally {
  insertions: number;
  deletions: number;
  complete: boolean;
}

export type GitChangeGroupId = "changes" | "newFiles" | "committed";

export interface GitChangeGroup {
  id: GitChangeGroupId;
  label: string;
  fileCount: number;
  hiddenFileCount: number;
  tally: GitTally;
  files: readonly GitFileRow[];
  commits: readonly ExperimentalThreadGitCommit[];
  defaultOpen: boolean;
}

export type GitTreeState = "clean" | "newFilesOnly" | "changed";

export type GitSyncState =
  | "noBase"
  | "inSync"
  | "ahead"
  | "behind"
  | "diverged";

export interface GitSync {
  state: GitSyncState;
  baseBranch: string | null;
  aheadCount: number;
  behindCount: number;
}

export interface GitPullRequestModel {
  number: number;
  title: string;
  url: string;
  icon: string;
  statusLabel: string;
  tone: GitTone;
}

export interface GitHeaderModel {
  branchLabel: string;
  branchShortLabel: string;
  detached: boolean;
  tree: GitTreeState;
  sync: GitSync;
  changedFileCount: number;
  newFileCount: number;
  changesTally: GitTally;
  groups: readonly GitChangeGroup[];
  pullRequest: GitPullRequestModel | null;
  accessibleLabel: string;
}

const PULL_REQUEST_ICON: Record<PluginSidebarPullRequest["state"], string> = {
  open: "GitPullRequestArrow",
  draft: "GitPullRequestDraft",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};

const PULL_REQUEST_ATTENTION: Record<
  PluginSidebarPullRequest["attention"],
  { label: string; tone: GitTone }
> = {
  checks_failed: { label: "Checks failing", tone: "danger" },
  conflicts: { label: "Has conflicts", tone: "danger" },
  changes_requested: { label: "Changes requested", tone: "danger" },
  checks_pending: { label: "Checks running", tone: "warning" },
  review_requested: { label: "Review requested", tone: "warning" },
  blocked: { label: "Blocked", tone: "warning" },
  queued: { label: "In merge queue", tone: "warning" },
  ready_to_merge: { label: "Ready to merge", tone: "success" },
  merged: { label: "Merged", tone: "merged" },
  draft: { label: "Draft", tone: "muted" },
  closed: { label: "Closed", tone: "muted" },
  none: { label: "Open", tone: "muted" },
};

export const MERGE_METHOD_LABEL: Record<
  ExperimentalThreadGitMergeMethod,
  { short: string; long: string }
> = {
  merge: { short: "Merge", long: "Create a merge commit" },
  squash: { short: "Squash", long: "Squash and merge" },
  rebase: { short: "Rebase", long: "Rebase and merge" },
};

const COUNT_FORMATTER = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

export function pluralize(count: number, singular: string, plural: string) {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

function splitPath(path: string): { basename: string; directory: string } {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");

  return slash === -1
    ? { basename: trimmed, directory: "" }
    : {
        basename: trimmed.slice(slash + 1),
        directory: trimmed.slice(0, slash),
      };
}

function toFileRow(
  file: ExperimentalThreadGitFile,
  source: ExperimentalThreadGitFileSource,
): GitFileRow {
  return {
    path: file.path,
    ...splitPath(file.path),
    status: FILE_STATUS_DISPLAY[file.status],
    insertions: file.insertions,
    deletions: file.deletions,
    source,
  };
}

function sumTally(files: readonly ExperimentalThreadGitFile[]): GitTally {
  return files.reduce<GitTally>(
    (tally, file) => ({
      insertions: tally.insertions + (file.insertions ?? 0),
      deletions: tally.deletions + (file.deletions ?? 0),
      complete:
        tally.complete && file.insertions !== null && file.deletions !== null,
    }),
    { insertions: 0, deletions: 0, complete: true },
  );
}

function splitWorkingTree(workingTree: ExperimentalThreadGitChanges) {
  const tracked = workingTree.files.filter((file) => file.status !== "??");
  const untracked = workingTree.files.filter((file) => file.status === "??");
  const untrackedTally = sumTally(untracked);

  const trackedFileCount = Math.max(
    0,
    workingTree.fileCount - untracked.length,
  );

  const hiddenTrackedCount = Math.max(0, trackedFileCount - tracked.length);

  const trackedTally: GitTally = {
    insertions: Math.max(0, workingTree.insertions - untrackedTally.insertions),
    deletions: Math.max(0, workingTree.deletions - untrackedTally.deletions),
    complete:
      workingTree.lineStatsComplete ||
      (hiddenTrackedCount === 0 && sumTally(tracked).complete),
  };

  return {
    changes: {
      fileCount: trackedFileCount,
      hiddenFileCount: hiddenTrackedCount,
      tally: trackedTally,
      files: tracked.map((file) => toFileRow(file, "workingTree")),
    },
    newFiles: {
      fileCount: untracked.length,
      hiddenFileCount: 0,
      tally: untrackedTally,
      files: untracked.map((file) => toFileRow(file, "workingTree")),
    },
  };
}

function toSync(comparison: ReadyThreadGit["comparison"]): GitSync {
  if (comparison === null) {
    return {
      state: "noBase",
      baseBranch: null,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const { aheadCount, behindCount, baseBranch } = comparison;

  const state: GitSyncState =
    aheadCount > 0 && behindCount > 0
      ? "diverged"
      : aheadCount > 0
        ? "ahead"
        : behindCount > 0
          ? "behind"
          : "inSync";

  return { state, baseBranch, aheadCount, behindCount };
}

function toPullRequest(
  pullRequest: PluginSidebarPullRequest | null,
): GitPullRequestModel | null {
  if (pullRequest === null) return null;

  const attention = PULL_REQUEST_ATTENTION[pullRequest.attention];

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    icon: PULL_REQUEST_ICON[pullRequest.state],
    statusLabel: attention.label,
    tone: attention.tone,
  };
}

function accessibleSummary(
  model: Omit<GitHeaderModel, "accessibleLabel">,
): string {
  const parts = [`Git: ${model.branchLabel}`];

  if (model.changedFileCount > 0) {
    parts.push(
      pluralize(model.changedFileCount, "changed file", "changed files"),
    );
  }

  if (model.newFileCount > 0) {
    parts.push(pluralize(model.newFileCount, "new file", "new files"));
  }

  if (model.tree === "clean") parts.push("working tree clean");

  const { sync } = model;

  if (sync.aheadCount > 0) {
    parts.push(
      `${pluralize(sync.aheadCount, "commit", "commits")} ahead of ${sync.baseBranch}`,
    );
  }

  if (sync.behindCount > 0) {
    parts.push(
      `${pluralize(sync.behindCount, "commit", "commits")} behind ${sync.baseBranch}`,
    );
  }

  if (model.pullRequest !== null) {
    parts.push(
      `pull request #${model.pullRequest.number} ${model.pullRequest.statusLabel.toLowerCase()}`,
    );
  }

  return parts.join(", ");
}

export function toGitHeaderModel(git: ReadyThreadGit): GitHeaderModel {
  const { changes, newFiles } = splitWorkingTree(git.workingTree);
  const sync = toSync(git.comparison);
  const comparison = git.comparison;

  const tree: GitTreeState =
    changes.fileCount > 0
      ? "changed"
      : newFiles.fileCount > 0
        ? "newFilesOnly"
        : "clean";

  const groups: GitChangeGroup[] = [];

  if (changes.fileCount > 0) {
    groups.push({
      id: "changes",
      label: "Changes",
      commits: [],
      defaultOpen: true,
      ...changes,
    });
  }

  if (newFiles.fileCount > 0) {
    groups.push({
      id: "newFiles",
      label: "New files",
      commits: [],
      defaultOpen: changes.fileCount === 0,
      ...newFiles,
    });
  }

  if (
    comparison !== null &&
    (comparison.aheadCount > 0 || comparison.changes.fileCount > 0)
  ) {
    groups.push({
      id: "committed",
      label: "Committed",
      fileCount: comparison.changes.fileCount,
      hiddenFileCount: Math.max(
        0,
        comparison.changes.fileCount - comparison.changes.files.length,
      ),
      tally: {
        insertions: comparison.changes.insertions,
        deletions: comparison.changes.deletions,
        complete: comparison.changes.lineStatsComplete,
      },
      files: comparison.changes.files.map((file) =>
        toFileRow(file, "comparison"),
      ),
      commits: comparison.commits,
      defaultOpen: false,
    });
  }

  const model = {
    branchLabel: git.branch ?? "Detached",
    branchShortLabel: git.branch?.split("/").pop() || "Detached",
    detached: git.branch === null,
    tree,
    sync,
    changedFileCount: changes.fileCount,
    newFileCount: newFiles.fileCount,
    changesTally: changes.tally,
    groups,
    pullRequest: toPullRequest(git.pullRequest),
  };

  return { ...model, accessibleLabel: accessibleSummary(model) };
}
