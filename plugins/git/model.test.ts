import { describe, expect, it } from "vitest";
import type {
  ExperimentalThreadGitChanges,
  ExperimentalThreadGitComparison,
  ExperimentalThreadGitFile,
  PluginSidebarPullRequest,
} from "@omnyo/plugin-sdk/app";
import { toGitHeaderModel, type ReadyThreadGit } from "./model";

function file(
  path: string,
  status: ExperimentalThreadGitFile["status"],
  insertions: number | null = 1,
  deletions: number | null = 0,
): ExperimentalThreadGitFile {
  return { path, status, insertions, deletions };
}

function changes(
  files: ExperimentalThreadGitFile[],
  overrides: Partial<ExperimentalThreadGitChanges> = {},
): ExperimentalThreadGitChanges {
  return {
    fileCount: files.length,
    insertions: files.reduce((sum, f) => sum + (f.insertions ?? 0), 0),
    deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    lineStatsComplete: files.every(
      (f) => f.insertions !== null && f.deletions !== null,
    ),
    files,
    ...overrides,
  };
}

function comparison(
  overrides: Partial<ExperimentalThreadGitComparison> = {},
): ExperimentalThreadGitComparison {
  return {
    baseBranch: "main",
    aheadCount: 0,
    behindCount: 0,
    commits: [],
    changes: changes([]),
    ...overrides,
  };
}

function pullRequest(
  overrides: Partial<PluginSidebarPullRequest> = {},
): PluginSidebarPullRequest {
  return {
    experimental_autoMerge: false,
    experimental_inMergeQueue: false,
    experimental_checks: { state: "passing" },
    experimental_review: { state: "none" },
    experimental_mergeability: { state: "mergeable" },
    number: 12,
    title: "Add the git header",
    url: "https://github.com/acme/app/pull/12",
    state: "open",
    attention: "none",
    ...overrides,
  };
}

function git(overrides: Partial<ReadyThreadGit> = {}): ReadyThreadGit {
  return {
    status: "ready",
    branch: "feature/x",
    defaultBranch: "main",
    workingTree: changes([]),
    comparison: comparison(),
    pullRequest: null,
    pullRequestActions: null,
    commit: null,
    openFile: () => {},
    openDiffPanel: () => {},
    ...overrides,
  };
}

describe("toGitHeaderModel working tree split", () => {
  it("separates tracked changes from new files and recomputes their totals", () => {
    const model = toGitHeaderModel(
      git({
        workingTree: changes([
          file("src/app.ts", "M", 10, 2),
          file("src/old.ts", "D", 0, 30),
          file("notes/todo.md", "??", 5, 0),
        ]),
      }),
    );

    expect(model.tree).toBe("changed");
    expect(model.changedFileCount).toBe(2);
    expect(model.newFileCount).toBe(1);
    expect(model.changesTally).toEqual({
      insertions: 10,
      deletions: 32,
      complete: true,
    });

    const [tracked, untracked] = model.groups;
    expect(tracked?.id).toBe("changes");
    expect(tracked?.files.map((row) => row.path)).toEqual([
      "src/app.ts",
      "src/old.ts",
    ]);
    expect(untracked?.id).toBe("newFiles");
    expect(untracked?.tally).toEqual({
      insertions: 5,
      deletions: 0,
      complete: true,
    });
    expect(untracked?.files[0]?.status.letter).toBe("N");
    expect(untracked?.defaultOpen).toBe(false);
  });

  it.each([
    {
      name: "capped list attributes unlisted files to Changes",
      workingTree: changes([file("a.ts", "M"), file("new.ts", "??")], {
        fileCount: 75,
        insertions: 900,
        deletions: 40,
      }),
      changesCount: 74,
      hidden: 73,
      newCount: 1,
      complete: true,
    },
    {
      name: "incomplete line stats on a hidden tracked file mark Changes incomplete",
      workingTree: changes([file("a.ts", "M")], {
        fileCount: 3,
        lineStatsComplete: false,
      }),
      changesCount: 3,
      hidden: 2,
      newCount: 0,
      complete: false,
    },
    {
      name: "a binary new file leaves Changes complete",
      workingTree: changes([
        file("a.ts", "M"),
        file("logo.png", "??", null, null),
      ]),
      changesCount: 1,
      hidden: 0,
      newCount: 1,
      complete: true,
    },
  ])("$name", ({ workingTree, changesCount, hidden, newCount, complete }) => {
    const model = toGitHeaderModel(git({ workingTree }));
    const tracked = model.groups.find((group) => group.id === "changes");

    expect(tracked?.fileCount).toBe(changesCount);
    expect(tracked?.hiddenFileCount).toBe(hidden);
    expect(model.newFileCount).toBe(newCount);
    expect(model.changesTally.complete).toBe(complete);
  });

  it("opens New files by default when there are no tracked changes", () => {
    const model = toGitHeaderModel(
      git({ workingTree: changes([file("draft.md", "??")]) }),
    );

    expect(model.tree).toBe("newFilesOnly");
    expect(model.groups.map((group) => [group.id, group.defaultOpen])).toEqual([
      ["newFiles", true],
    ]);
  });

  it("names a file by basename with its directory kept separately", () => {
    const model = toGitHeaderModel(
      git({
        workingTree: changes([
          file("build-94YtN4/internal/composer-view.js", "M"),
          file("README.md", "A"),
        ]),
      }),
    );

    expect(
      model.groups[0]?.files.map((row) => [row.basename, row.directory]),
    ).toEqual([
      ["composer-view.js", "build-94YtN4/internal"],
      ["README.md", ""],
    ]);
  });
});

describe("toGitHeaderModel sync state", () => {
  it.each([
    { compared: null, state: "noBase" },
    { compared: comparison(), state: "inSync" },
    { compared: comparison({ aheadCount: 3 }), state: "ahead" },
    { compared: comparison({ behindCount: 2 }), state: "behind" },
    {
      compared: comparison({ aheadCount: 3, behindCount: 2 }),
      state: "diverged",
    },
  ] as const)("reports $state", ({ compared, state }) => {
    expect(toGitHeaderModel(git({ comparison: compared })).sync.state).toBe(
      state,
    );
  });

  it("shows committed work vs the base with its commits", () => {
    const commits = [
      {
        sha: "b".repeat(40),
        shortSha: "bbbbbbb",
        subject: "Second",
        authorName: "Ada",
        authoredAt: 2,
      },
      {
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        subject: "First",
        authorName: "Ada",
        authoredAt: 1,
      },
    ];

    const model = toGitHeaderModel(
      git({
        comparison: comparison({
          aheadCount: 2,
          commits,
          changes: changes([file("src/a.ts", "M", 4, 1)], { fileCount: 5 }),
        }),
      }),
    );

    expect(model.tree).toBe("clean");
    const committed = model.groups.find((group) => group.id === "committed");
    expect(committed?.commits.map((commit) => commit.subject)).toEqual([
      "Second",
      "First",
    ]);
    expect(committed?.files[0]?.source).toBe("comparison");
    expect(committed?.hiddenFileCount).toBe(4);
    expect(committed?.defaultOpen).toBe(false);
  });

  it("omits every group when the branch is clean and in sync", () => {
    expect(toGitHeaderModel(git()).groups).toEqual([]);
  });
});

describe("toGitHeaderModel pull request", () => {
  it.each([
    { attention: "checks_failed", tone: "danger", label: "Checks failing" },
    { attention: "conflicts", tone: "danger", label: "Has conflicts" },
    {
      attention: "changes_requested",
      tone: "danger",
      label: "Changes requested",
    },
    { attention: "checks_pending", tone: "warning", label: "Checks running" },
    {
      attention: "review_requested",
      tone: "warning",
      label: "Review requested",
    },
    { attention: "ready_to_merge", tone: "success", label: "Ready to merge" },
    { attention: "merged", tone: "merged", label: "Merged" },
    { attention: "draft", tone: "muted", label: "Draft" },
    { attention: "none", tone: "muted", label: "Open" },
  ] as const)("colours $attention as $tone", ({ attention, tone, label }) => {
    const model = toGitHeaderModel(
      git({ pullRequest: pullRequest({ attention }) }),
    );

    expect(model.pullRequest?.tone).toBe(tone);
    expect(model.pullRequest?.statusLabel).toBe(label);
  });

  it.each([
    { state: "open", icon: "GitPullRequestArrow" },
    { state: "draft", icon: "GitPullRequestDraft" },
    { state: "merged", icon: "GitMerge" },
    { state: "closed", icon: "GitPullRequestClosed" },
  ] as const)("uses the $state glyph", ({ state, icon }) => {
    expect(
      toGitHeaderModel(git({ pullRequest: pullRequest({ state }) })).pullRequest
        ?.icon,
    ).toBe(icon);
  });
});

describe("toGitHeaderModel accessible label", () => {
  it("summarises the branch, changes, sync, and pull request in words", () => {
    const model = toGitHeaderModel(
      git({
        workingTree: changes([file("a.ts", "M"), file("b.ts", "??")], {
          fileCount: 61,
        }),
        comparison: comparison({ aheadCount: 3 }),
        pullRequest: pullRequest({ attention: "checks_failed" }),
      }),
    );

    expect(model.accessibleLabel).toBe(
      "Git: feature/x, 60 changed files, 1 new file, 3 commits ahead of main, pull request #12 checks failing",
    );
  });

  it("shortens a prefixed branch to its last segment for the trigger", () => {
    const model = toGitHeaderModel(
      git({ branch: "feature/git-header-redesign" }),
    );

    expect(model.branchLabel).toBe("feature/git-header-redesign");
    expect(model.branchShortLabel).toBe("git-header-redesign");
  });

  it("names a detached HEAD", () => {
    const model = toGitHeaderModel(git({ branch: null }));

    expect(model.branchLabel).toBe("Detached");
    expect(model.branchShortLabel).toBe("Detached");
    expect(model.accessibleLabel).toBe("Git: Detached, working tree clean");
  });
});
