// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadPullRequest, WorkspaceFileStatus } from "@omnyo/domain";
import {
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
  makeWorkspaceWorkingTree,
} from "@omnyo/test-helpers";
import { makePullRequest } from "@/components/secondary-panel/ThreadMetadataContent.fixtures";
import type { WorkspaceChangedFileSelection } from "@/components/workspace/workspace-change-summary";
import {
  buildThreadGit,
  ThreadGitProvider,
  ThreadMergeBasePicker,
  type BuildThreadGitArgs,
} from "./ThreadGitContext";

afterEach(cleanup);

const modifiedFile: WorkspaceFileStatus = {
  path: "src/app.ts",
  status: "M",
  insertions: 3,
  deletions: 1,
};

const untrackedFile: WorkspaceFileStatus = {
  path: "notes.md",
  status: "??",
  insertions: 4,
  deletions: 0,
};

const committedDeletedFile: WorkspaceFileStatus = {
  path: "src/old.ts",
  status: "D",
  insertions: 0,
  deletions: 12,
};

const workspaceStatus = makeWorkspaceStatus({
  branch: { currentBranch: "omnyo/feature", defaultBranch: "main" },
  workingTree: makeWorkspaceWorkingTree({
    state: "dirty_uncommitted",
    hasUncommittedChanges: true,
    files: [modifiedFile, untrackedFile],
    insertions: 7,
    deletions: 1,
  }),
  mergeBase: makeWorkspaceMergeBase({
    mergeBaseBranch: "main",
    baseRef: "abc1234",
    aheadCount: 2,
    behindCount: 1,
    files: [committedDeletedFile],
    deletions: 12,
    commits: [
      {
        sha: "1111111111",
        shortSha: "1111111",
        subject: "First commit",
        authorName: "Ada",
        authoredAt: 1,
      },
      {
        sha: "2222222222",
        shortSha: "2222222",
        subject: "Second commit",
        authorName: "Ada",
        authoredAt: 2,
      },
    ],
  }),
});

function makeArgs(overrides: Partial<BuildThreadGitArgs> = {}) {
  const onMerge = vi.fn();
  const onOpenDiffPanel = vi.fn();

  const onOpenChangedFile =
    vi.fn<(selection: WorkspaceChangedFileSelection) => void>();

  const args: BuildThreadGitArgs = {
    phase: "ready",
    workspaceStatus,
    pullRequest: null,
    pullRequestHandlers: {
      isPending: false,
      mergeMethod: "squash",
      onMarkReady: vi.fn(),
      onMerge,
      onConvertToDraft: vi.fn(),
    },
    onCommit: null,
    onOpenChangedFile,
    onOpenDiffPanel,
    ...overrides,
  };

  return { args, onMerge, onOpenChangedFile, onOpenDiffPanel };
}

function readyGit(args: BuildThreadGitArgs) {
  const git = buildThreadGit(args);

  if (git?.status !== "ready") throw new Error("expected ready git");

  return git;
}

describe("buildThreadGit", () => {
  it.each([
    ["off", workspaceStatus, null],
    ["loading", workspaceStatus, { status: "loading" }],
    ["ready", undefined, null],
  ] as const)(
    "returns the hook value for the %s phase",
    (phase, status, expected) => {
      expect(
        buildThreadGit(makeArgs({ phase, workspaceStatus: status }).args),
      ).toEqual(expected);
    },
  );

  it("reports branch, working tree and comparison with commits newest first", () => {
    const git = readyGit(makeArgs().args);

    expect(git.branch).toBe("omnyo/feature");
    expect(git.defaultBranch).toBe("main");
    expect(git.workingTree).toEqual({
      fileCount: 2,
      insertions: 7,
      deletions: 1,
      lineStatsComplete: true,
      files: [modifiedFile, untrackedFile],
    });
    expect(git.comparison?.baseBranch).toBe("main");
    expect(git.comparison?.aheadCount).toBe(2);
    expect(git.comparison?.behindCount).toBe(1);
    expect(git.comparison?.commits.map((commit) => commit.subject)).toEqual([
      "Second commit",
      "First commit",
    ]);
    expect(git.comparison?.changes.files).toEqual([committedDeletedFile]);
  });

  it("has no comparison without a merge base", () => {
    const git = readyGit(
      makeArgs({ workspaceStatus: { ...workspaceStatus, mergeBase: null } })
        .args,
    );

    expect(git.comparison).toBeNull();
  });

  const draft = makePullRequest({
    state: "draft",
    mergeability: {
      state: "draft",
      mergeStateStatus: "DRAFT",
      mergeable: "UNKNOWN",
    },
  });

  const conflicted = makePullRequest({
    mergeability: {
      state: "conflicts",
      mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING",
    },
  });

  it.each<
    [
      string,
      ThreadPullRequest,
      { ready: boolean; merge: boolean; draft: boolean } | null,
    ]
  >([
    ["draft", draft, { ready: true, merge: false, draft: false }],
    [
      "open and mergeable",
      makePullRequest(),
      { ready: false, merge: true, draft: true },
    ],
    [
      "open with conflicts",
      conflicted,
      { ready: false, merge: false, draft: true },
    ],
    ["merged", makePullRequest({ state: "merged" }), null],
  ])(
    "offers the %s pull request only its eligible actions",
    (_label, pullRequest, expected) => {
      const { args, onMerge } = makeArgs({ pullRequest });
      const git = readyGit(args);

      expect(git.pullRequest?.number).toBe(pullRequest.number);

      if (expected === null) {
        expect(git.pullRequestActions).toBeNull();

        return;
      }

      expect(git.pullRequestActions?.mergeMethod).toBe("squash");
      expect(git.pullRequestActions?.markReady !== null).toBe(expected.ready);
      expect(git.pullRequestActions?.merge !== null).toBe(expected.merge);
      expect(git.pullRequestActions?.convertToDraft !== null).toBe(
        expected.draft,
      );

      git.pullRequestActions?.merge?.("rebase");

      expect(onMerge.mock.calls).toEqual(expected.merge ? [["rebase"]] : []);
    },
  );

  it("has no pull request or actions when the branch has none", () => {
    const git = readyGit(makeArgs().args);

    expect(git.pullRequest).toBeNull();
    expect(git.pullRequestActions).toBeNull();
  });

  it("passes the commit and diff panel actions through", () => {
    const onCommit = vi.fn();
    const { args, onOpenDiffPanel } = makeArgs({ onCommit });
    const git = readyGit(args);

    git.commit?.();
    git.openDiffPanel();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onOpenDiffPanel).toHaveBeenCalledTimes(1);
    expect(readyGit(makeArgs({ onCommit: null }).args).commit).toBeNull();
  });

  it.each([
    ["an untracked file", "notes.md", "workingTree", "??", "untracked", null],
    ["a modified file", "src/app.ts", "workingTree", "M", "uncommitted", null],
    [
      "a committed file",
      "src/old.ts",
      "comparison",
      "D",
      "committed",
      "abc1234",
    ],
    ["an unknown path", "missing.ts", "workingTree", "M", "uncommitted", null],
  ] as const)(
    "opens %s through the core changed-file handler",
    (_label, path, source, status, kind, mergeBaseRef) => {
      const { args, onOpenChangedFile } = makeArgs();
      readyGit(args).openFile({ path, source });

      expect(onOpenChangedFile).toHaveBeenCalledTimes(1);
      const [selection] = onOpenChangedFile.mock.calls[0] ?? [];
      expect(selection?.file.path).toBe(path);
      expect(selection?.file.status).toBe(status);
      expect(selection?.section.kind).toBe(kind);
      expect(selection?.section.mergeBaseRef).toBe(mergeBaseRef);
    },
  );
});

describe("ThreadMergeBasePicker", () => {
  it("renders nothing outside a thread", () => {
    const { container } = render(<ThreadMergeBasePicker />);

    expect(container.innerHTML).toBe("");
  });

  it("renders the thread's merge base branch", () => {
    render(
      <ThreadGitProvider
        value={{
          git: null,
          mergeBase: {
            branch: "release/2026-10",
            options: ["main", "release/2026-10"],
            onChange: vi.fn(),
          },
        }}
      >
        <ThreadMergeBasePicker />
      </ThreadGitProvider>,
    );

    expect(screen.getByText("release/2026-10")).not.toBeNull();
  });
});
