import { createContext, useContext } from "react";
import type {
  GitBranchRefClassification,
  ThreadPullRequest,
  WorkspaceChangeStats,
  WorkspaceStatus,
} from "@omnyo/domain";
import type {
  ExperimentalThreadGit,
  ExperimentalThreadGitChanges,
  ExperimentalThreadGitFileSource,
  ExperimentalThreadGitMergeMethod,
  ExperimentalThreadGitPullRequestActions,
  ExperimentalThreadMergeBasePickerProps,
} from "@omnyo/plugin-sdk";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  BranchPicker,
  getMergeBaseBranchCandidateGroups,
} from "@/components/pickers/BranchPicker";
import {
  selectUntrackedWorkspaceFilesSection,
  selectWorkspaceAheadCommits,
  selectWorkspaceChangedFilesSections,
  type WorkspaceChangedFileSelection,
  type WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import { toPluginSidebarPullRequest } from "@/lib/plugin-sidebar-hooks";

export interface ThreadMergeBaseConfig {
  branch: string;
  branchRef?: GitBranchRefClassification | null;
  options?: readonly string[];
  remoteOptions?: readonly string[];
  optionsLoading?: boolean;
  onChange: (branch: string) => void;
  onPickerOpenChange?: (open: boolean) => void;
  onSearchQueryChange?: (query: string) => void;
}

export interface ThreadGitContextValue {
  git: ExperimentalThreadGit | null;
  mergeBase: ThreadMergeBaseConfig | null;
}

const ThreadGitContext = createContext<ThreadGitContextValue | null>(null);

export const ThreadGitProvider = ThreadGitContext.Provider;

export function useThreadGit(): ExperimentalThreadGit | null {
  return useContext(ThreadGitContext)?.git ?? null;
}

export function ThreadMergeBasePicker({
  align = "end",
  className,
}: ExperimentalThreadMergeBasePickerProps) {
  const mergeBase = useContext(ThreadGitContext)?.mergeBase ?? null;

  if (mergeBase === null) {
    return null;
  }

  const candidates = getMergeBaseBranchCandidateGroups({
    mergeBaseBranch: mergeBase.branch,
    mergeBaseBranchRef: mergeBase.branchRef,
    mergeBaseBranchOptions: mergeBase.options,
    remoteMergeBaseBranchOptions: mergeBase.remoteOptions,
  });

  return (
    <BranchPicker
      value={mergeBase.branch}
      options={candidates.options}
      remoteOptions={candidates.remoteOptions}
      variant="minimal"
      emphasizeTriggerValue={false}
      loading={mergeBase.optionsLoading}
      onChange={mergeBase.onChange}
      onOpenChange={mergeBase.onPickerOpenChange}
      onSearchQueryChange={mergeBase.onSearchQueryChange}
      className={cn("max-w-[10rem]", className)}
      muted
      popoverAlign={align}
    />
  );
}

type ThreadGitPhase = "off" | "loading" | "ready";

interface ThreadGitPullRequestHandlers {
  isPending: boolean;
  mergeMethod: ExperimentalThreadGitMergeMethod;
  onMarkReady: () => void;
  onMerge: (method: ExperimentalThreadGitMergeMethod) => void;
  onConvertToDraft: () => void;
}

export interface BuildThreadGitArgs {
  phase: ThreadGitPhase;
  workspaceStatus: WorkspaceStatus | undefined;
  pullRequest: ThreadPullRequest | null;
  pullRequestHandlers: ThreadGitPullRequestHandlers;
  onCommit: (() => void) | null;
  onOpenChangedFile: (selection: WorkspaceChangedFileSelection) => void;
  onOpenDiffPanel: () => void;
}

const LOADING_THREAD_GIT: ExperimentalThreadGit = { status: "loading" };

function toThreadGitChanges(
  stats: WorkspaceChangeStats,
): ExperimentalThreadGitChanges {
  return {
    fileCount: stats.fileCount,
    insertions: stats.insertions,
    deletions: stats.deletions,
    lineStatsComplete: stats.lineStatsComplete,
    files: stats.files,
  };
}

function buildPullRequestActions(
  pullRequest: ThreadPullRequest,
  handlers: ThreadGitPullRequestHandlers,
): ExperimentalThreadGitPullRequestActions | null {
  const isOpen = pullRequest.state === "open";
  const markReady = pullRequest.state === "draft" ? handlers.onMarkReady : null;

  const merge =
    isOpen && pullRequest.mergeability.state === "mergeable"
      ? handlers.onMerge
      : null;

  const convertToDraft = isOpen ? handlers.onConvertToDraft : null;

  if (markReady === null && merge === null && convertToDraft === null) {
    return null;
  }

  return {
    isPending: handlers.isPending,
    mergeMethod: handlers.mergeMethod,
    markReady,
    merge,
    convertToDraft,
  };
}

function emptyChangedFilesSection(
  kind: WorkspaceChangedFilesSection["kind"],
  mergeBaseRef: string | null,
): WorkspaceChangedFilesSection {
  return {
    kind,
    label: kind === "committed" ? "Committed" : "Uncommitted",
    files: [],
    mergeBaseRef,
    stats: {
      fileCount: 0,
      files: [],
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
    },
  };
}

function selectThreadGitFile(
  workspaceStatus: WorkspaceStatus,
  target: { path: string; source: ExperimentalThreadGitFileSource },
): WorkspaceChangedFileSelection {
  const sections = selectWorkspaceChangedFilesSections(workspaceStatus);

  const unknownFile = {
    path: target.path,
    status: "M",
    insertions: null,
    deletions: null,
  } as const;

  if (target.source === "comparison") {
    const section =
      sections.find((candidate) => candidate.kind === "committed") ??
      emptyChangedFilesSection(
        "committed",
        workspaceStatus.mergeBase?.baseRef ?? null,
      );

    return {
      file:
        section.files.find((file) => file.path === target.path) ?? unknownFile,
      section,
    };
  }

  const file = workspaceStatus.workingTree.files.find(
    (candidate) => candidate.path === target.path,
  );

  const section =
    (file?.status === "??"
      ? selectUntrackedWorkspaceFilesSection(workspaceStatus)
      : sections.find((candidate) => candidate.kind !== "committed")) ??
    emptyChangedFilesSection("uncommitted", null);

  return { file: file ?? unknownFile, section };
}

export function buildThreadGit(
  args: BuildThreadGitArgs,
): ExperimentalThreadGit | null {
  if (args.phase === "off") return null;

  if (args.phase === "loading") return LOADING_THREAD_GIT;

  const workspaceStatus = args.workspaceStatus;

  if (workspaceStatus === undefined) return null;

  const mergeBase = workspaceStatus.mergeBase;

  return {
    status: "ready",
    branch: workspaceStatus.branch.currentBranch,
    defaultBranch: workspaceStatus.branch.defaultBranch,
    workingTree: toThreadGitChanges(workspaceStatus.workingTree),
    comparison: mergeBase
      ? {
          baseBranch: mergeBase.mergeBaseBranch,
          aheadCount: mergeBase.aheadCount,
          behindCount: mergeBase.behindCount,
          commits: selectWorkspaceAheadCommits(workspaceStatus).map(
            (commit) => ({
              sha: commit.sha,
              shortSha: commit.shortSha,
              subject: commit.subject,
              authorName: commit.authorName,
              authoredAt: commit.authoredAt,
            }),
          ),
          changes: toThreadGitChanges(mergeBase),
        }
      : null,
    pullRequest: args.pullRequest
      ? toPluginSidebarPullRequest(args.pullRequest)
      : null,
    pullRequestActions: args.pullRequest
      ? buildPullRequestActions(args.pullRequest, args.pullRequestHandlers)
      : null,
    commit: args.onCommit,
    openFile: (target) =>
      args.onOpenChangedFile(selectThreadGitFile(workspaceStatus, target)),
    openDiffPanel: args.onOpenDiffPanel,
  };
}
