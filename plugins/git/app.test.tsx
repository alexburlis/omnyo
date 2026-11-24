// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalThreadGit,
  ExperimentalThreadGitFile,
} from "@omnyo/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

type ReadyGit = Extract<ExperimentalThreadGit, { status: "ready" }>;

function file(
  path: string,
  status: ExperimentalThreadGitFile["status"],
  insertions: number,
  deletions: number,
): ExperimentalThreadGitFile {
  return { path, status, insertions, deletions };
}

function readyGit(overrides: Partial<ReadyGit> = {}): ReadyGit {
  return {
    status: "ready",
    branch: "feature/x",
    defaultBranch: "main",
    workingTree: {
      fileCount: 3,
      insertions: 1219,
      deletions: 88,
      lineStatsComplete: true,
      files: [
        file("src/views/header.tsx", "M", 1200, 80),
        file("src/old.ts", "D", 0, 8),
        file("notes/todo.md", "??", 19, 0),
      ],
    },
    comparison: {
      baseBranch: "main",
      aheadCount: 1,
      behindCount: 0,
      commits: [
        {
          sha: "c".repeat(40),
          shortSha: "ccccccc",
          subject: "Wire the header",
          authorName: "Ada",
          authoredAt: 1,
        },
      ],
      changes: {
        fileCount: 1,
        insertions: 4,
        deletions: 0,
        lineStatsComplete: true,
        files: [file("src/committed.ts", "A", 4, 0)],
      },
    },
    pullRequest: null,
    pullRequestActions: null,
    commit: vi.fn(),
    openFile: vi.fn(),
    openDiffPanel: vi.fn(),
    ...overrides,
  };
}

function renderControl(
  threadGit: ExperimentalThreadGit | null,
  isCompactViewport = false,
) {
  return renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_1", projectId: "proj_1", isCompactViewport },
    { threadGit },
  );
}

function openPopover(slot: ReturnType<typeof renderControl>) {
  fireEvent.click(slot.getByRole("button", { name: /^Git: / }));
}

describe("Git header control", () => {
  it("registers one thread header action", () => {
    expect(app.threadHeaderActions.map((action) => action.title)).toEqual([
      "Git",
    ]);
  });

  it("renders nothing when the thread has no git workspace", () => {
    const slot = renderControl(null);

    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.queryByRole("status")).toBeNull();
  });

  it("shows a loading placeholder before the first status", () => {
    const slot = renderControl({ status: "loading" });

    expect(slot.getByRole("status", { name: "Git: loading" })).toBeTruthy();
  });

  it("summarises a dirty branch in the trigger and keeps Commit one click away", () => {
    const git = readyGit();
    const slot = renderControl(git);

    const trigger = slot.getByRole("button", {
      name: "Git: feature/x, 2 changed files, 1 new file, 1 commit ahead of main",
    });

    expect(trigger.textContent).toBe("x+1,200 −88");

    fireEvent.click(slot.getByRole("button", { name: "Commit" }));
    expect(git.commit).toHaveBeenCalledTimes(1);
  });

  it("lists changes, new files, and committed work and opens each from its source", () => {
    const git = readyGit();
    const slot = renderControl(git);
    openPopover(slot);

    expect(slot.getByRole("button", { name: /^Changes/ })).toBeTruthy();
    expect(
      slot.queryByRole("button", { name: "New: notes/todo.md" }),
    ).toBeNull();

    fireEvent.click(
      slot.getByRole("button", { name: "Modified: src/views/header.tsx" }),
    );
    expect(git.openFile).toHaveBeenCalledWith({
      path: "src/views/header.tsx",
      source: "workingTree",
    });
    expect(slot.queryByRole("button", { name: /^Changes/ })).toBeNull();

    openPopover(slot);
    fireEvent.click(slot.getByRole("button", { name: /^New files/ }));
    fireEvent.click(slot.getByRole("button", { name: "New: notes/todo.md" }));
    expect(git.openFile).toHaveBeenLastCalledWith({
      path: "notes/todo.md",
      source: "workingTree",
    });

    openPopover(slot);
    fireEvent.click(
      slot.getByRole("button", { name: /^Committed.*1 commit ahead of main/ }),
    );
    expect(slot.getByText("Wire the header")).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: "Added: src/committed.ts" }),
    );
    expect(git.openFile).toHaveBeenLastCalledWith({
      path: "src/committed.ts",
      source: "comparison",
    });
  });

  it("shows the merge base picker and opens the diff panel", () => {
    const git = readyGit();
    const slot = renderControl(git);
    openPopover(slot);

    expect(
      slot
        .getByTestId("omnyo-thread-merge-base-picker")
        .getAttribute("data-align"),
    ).toBe("end");

    fireEvent.click(slot.getByRole("button", { name: "Review all changes" }));
    expect(git.openDiffPanel).toHaveBeenCalledTimes(1);
  });

  it("offers more files through the diff panel when the host caps the list", () => {
    const git = readyGit({
      workingTree: {
        fileCount: 40,
        insertions: 10,
        deletions: 0,
        lineStatsComplete: true,
        files: [file("a.ts", "M", 10, 0)],
      },
    });

    const slot = renderControl(git);
    openPopover(slot);

    fireEvent.click(slot.getByRole("button", { name: "39 more files" }));
    expect(git.openDiffPanel).toHaveBeenCalledTimes(1);
  });

  it("reports a clean branch that is up to date", () => {
    const slot = renderControl(
      readyGit({
        workingTree: {
          fileCount: 0,
          insertions: 0,
          deletions: 0,
          lineStatsComplete: true,
          files: [],
        },
        comparison: {
          baseBranch: "main",
          aheadCount: 0,
          behindCount: 0,
          commits: [],
          changes: {
            fileCount: 0,
            insertions: 0,
            deletions: 0,
            lineStatsComplete: true,
            files: [],
          },
        },
        commit: null,
      }),
    );

    expect(slot.queryByRole("button", { name: "Commit" })).toBeNull();
    openPopover(slot);
    expect(slot.getByText("Working tree clean")).toBeTruthy();
    expect(slot.getByText("Up to date with main")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Commit…" })).toBeNull();
  });

  it("moves Commit into the panel on a compact viewport", () => {
    const git = readyGit();
    const slot = renderControl(git, true);

    expect(slot.queryByRole("button", { name: "Commit" })).toBeNull();
    openPopover(slot);
    fireEvent.click(slot.getByRole("button", { name: "Commit…" }));
    expect(git.commit).toHaveBeenCalledTimes(1);
  });

  it("merges the pull request with the thread's merge method", () => {
    const merge = vi.fn();

    const slot = renderControl(
      readyGit({
        pullRequest: {
          experimental_autoMerge: false,
          experimental_inMergeQueue: false,
          experimental_checks: { state: "passing" },
          experimental_review: { state: "approved" },
          experimental_mergeability: { state: "mergeable" },
          number: 12,
          title: "Add the git header",
          url: "https://github.com/acme/app/pull/12",
          state: "open",
          attention: "ready_to_merge",
        },
        pullRequestActions: {
          isPending: false,
          mergeMethod: "squash",
          markReady: null,
          merge,
          convertToDraft: null,
        },
      }),
    );

    expect(
      slot.getByRole("button", { name: /pull request #12 ready to merge$/ }),
    ).toBeTruthy();
    openPopover(slot);
    expect(slot.getByText("Ready to merge")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Squash" }));
    expect(merge).toHaveBeenCalledWith("squash");
  });
});
