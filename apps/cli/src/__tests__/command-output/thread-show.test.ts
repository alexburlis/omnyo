import { describe, expect, it, vi } from "vitest";
import * as domain from "@omnyo/domain";
import type * as serverContract from "@omnyo/server-contract";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  createClientMock,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("omnyo thread show command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  function makePullRequest(
    overrides: Partial<domain.ThreadPullRequest> = {},
  ): domain.ThreadPullRequest {
    return {
      number: 42,
      title: "Review thread show",
      state: "open",
      url: "https://github.com/example/omnyo/pull/42",
      baseRefName: "main",
      headRefName: "omnyo/thread-show-pr",
      updatedAt: "2026-06-24T12:00:00.000Z",
      autoMerge: false,
      inMergeQueue: false,
      checks: {
        state: "passing",
        totalCount: 3,
        passedCount: 3,
        failedCount: 0,
        pendingCount: 0,
      },
      review: {
        state: "review_required",
        reviewRequestCount: 1,
      },
      mergeability: {
        state: "mergeable",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
      },
      attention: "ready_to_merge",
      ...overrides,
    };
  }

  it.each([
    {
      flag: "archived",
      stamp: { archivedAt: 1_700_000_000_000 },
      label: "Archived:",
    },
    {
      flag: "pinned",
      stamp: { pinnedAt: 1_700_000_000_000 },
      label: "Pinned:",
    },
    {
      flag: "shelved",
      stamp: { shelvedAt: 1_700_000_000_000 },
      label: "Shelved:",
    },
  ])(
    "omnyo thread show prints $flag timestamp for $flag threads",
    async ({ flag, stamp, label }) => {
      const thread: domain.Thread = fixtures.makeThread({
        id: `thread-${flag}-1`,
        projectId: "proj-1",
        providerId: "codex",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        ...stamp,
      });

      const get = vi.fn(async () => thread);
      const timelineGet = fixtures.makeEmptyTimelineGetMock();
      stubServerApi({
        "v1.threads.:id.$get": get,
        "v1.threads.:id.timeline.$get": timelineGet,
      });

      await runCommand(["thread", "show", `thread-${flag}-1`], register);

      expect(get).toHaveBeenCalledWith({
        param: { id: `thread-${flag}-1` },
      });
      expect(timelineGet).toHaveBeenCalledWith({
        param: { id: `thread-${flag}-1` },
        query: { summaryOnly: "true" },
      });
      const lines = collectLogLines(vi.mocked(console.log));
      expect(lines.some((line) => line.includes(label))).toBe(true);
    },
  );

  it.each([{ flags: [] }, { flags: ["--work-status", "--git-diff"] }])(
    "loads independent thread details with $flags while the pull request lookup is pending",
    async ({ flags }) => {
      const thread = fixtures.makeThread({
        id: "thread-show-parallel",
        projectId: "proj-1",
        providerId: "codex",
        environmentId: "env-show-parallel",
      });

      const environment = fixtures.makeEnvironment({
        id: "env-show-parallel",
        projectId: "proj-1",
        hostId: "host-1",
      });

      let finishPullRequest = () => {};

      const pullRequest = new Promise<{ outcome: "absent" }>((resolve) => {
        finishPullRequest = () => resolve({ outcome: "absent" });
      });

      const environmentGet = vi.fn(async () => environment);
      const timelineGet = fixtures.makeEmptyTimelineGetMock();

      const statusGet = vi.fn(async () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Not a Git repository.",
      }));

      const diffGet = vi.fn(async () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Not a Git repository.",
      }));

      stubServerApi({
        "v1.environments.:id.$get": environmentGet,
        "v1.environments.:id.status.$get": statusGet,
        "v1.environments.:id.diff.$get": diffGet,
        "v1.environments.:id.pull-request.$get": () => pullRequest,
        "v1.threads.:id.$get": async () => thread,
        "v1.threads.:id.timeline.$get": timelineGet,
      });

      const command = runCommand(
        ["thread", "show", thread.id, ...flags],
        register,
      );

      try {
        await vi.waitFor(() => {
          expect(environmentGet).toHaveBeenCalled();
          expect(timelineGet).toHaveBeenCalled();

          if (flags.length > 0) {
            expect(statusGet).toHaveBeenCalled();
            expect(diffGet).toHaveBeenCalled();
          }
        });
        expect(collectLogLines(vi.mocked(console.log))).toEqual([]);
      } finally {
        finishPullRequest();
        await command;
      }

      expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
        "Pull request: none",
      );
    },
  );

  it("omnyo thread show prints the source of a handoff", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-handoff",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
      originKind: "handoff",
      sourceThreadId: "thread-source",
    });

    stubServerApi({
      "v1.threads.:id.$get": vi.fn(async () => thread),
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
    });

    await runCommand(["thread", "show", "thread-handoff"], register);

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("  Continued from: thread-source");
    expect(lines.some((line) => line.includes("Parent:"))).toBe(false);
  });

  it("omnyo thread show --self resolves from OMNYO_THREAD_ID", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-show-self");

    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-self",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "--self"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-show-self" },
    });
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("omnyo thread show --work-status prints non-git environment message", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-work-status",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-work-status",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const environment = fixtures.makeEnvironment({
      id: "env-work-status",
      projectId: "proj-1",
      hostId: "host-1",
      isGitRepo: false,
      createdAt: 1,
      updatedAt: 2,
    });

    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);

    const statusGet = vi.fn(async () => ({
      outcome: "not_applicable",
      reason: "non_git_environment",
      message: "Workspace is not a Git repository.",
    }));

    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.environments.:id.status.$get": statusGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-show-work-status", "--work-status"],
      register,
    );

    expect(statusGet).toHaveBeenCalledWith({
      param: { id: "env-work-status" },
      query: { mergeBaseBranch: "main" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Work status: Workspace is not a Git repository.",
    );
  });

  it("omnyo thread show rejects combining a thread id with --self", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-show-self");

    await expect(
      runCommand(["thread", "show", "thread-explicit", "--self"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Cannot combine a thread ID argument with --self.",
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("omnyo thread show --git-diff uses the environment base branch before the repository default", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-diff-base",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-diff-base",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const environment = fixtures.makeEnvironment({
      id: "env-diff-base",
      projectId: "proj-1",
      hostId: "host-1",
      baseBranch: "release",
      defaultBranch: "main",
      mergeBaseBranch: null,
      createdAt: 1,
      updatedAt: 2,
    });

    const gitDiff: domain.ThreadGitDiffResponse = {
      diff: "",
      files: "M\tsrc/file.ts\n",
      mergeBaseRef: "abc1234",
      shortstat: " 1 file changed, 1 insertion(+)",
      truncated: false,
    };

    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);

    const diffResponse: serverContract.EnvironmentDiffResponse = {
      outcome: "available",
      diff: gitDiff,
    };

    const diffGet = vi.fn(async () => diffResponse);
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.diff.$get": diffGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-show-diff-base", "--git-diff"],
      register,
    );

    expect(diffGet).toHaveBeenCalledWith({
      param: { id: "env-diff-base" },
      query: {
        mergeBaseBranch: "release",
        target: "all",
      },
    });
  });

  it("omnyo thread show --git-diff renders an available uncommitted diff response", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-uncommitted-diff",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-uncommitted-diff",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const environment = fixtures.makeEnvironment({
      id: "env-uncommitted-diff",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });

    const diffResponse: serverContract.EnvironmentDiffResponse = {
      outcome: "available",
      diff: {
        diff: "diff --git a/smoke.txt b/smoke.txt\nnew file mode 100644\n",
        files: "A\tsmoke.txt\n",
        mergeBaseRef: null,
        shortstat: "1 file changed\n",
        truncated: false,
      },
    };

    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const diffGet = vi.fn(async () => diffResponse);
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.diff.$get": diffGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      [
        "thread",
        "show",
        "thread-show-uncommitted-diff",
        "--git-diff",
        "--diff-target",
        "uncommitted",
      ],
      register,
    );

    expect(diffGet).toHaveBeenCalledWith({
      param: { id: "env-uncommitted-diff" },
      query: {
        target: "uncommitted",
      },
    });
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Git diff:");
    expect(output).toContain("A\tsmoke.txt");
    expect(output).toContain("Summary: 1 file changed");
    expect(output).toContain("diff --git a/smoke.txt b/smoke.txt");
  });

  it("omnyo thread show prints pull request details for the thread environment", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-pr",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-show-pr",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const environment = fixtures.makeEnvironment({
      id: "env-show-pr",
      projectId: "proj-1",
      hostId: "host-1",
      branchName: "omnyo/thread-show-pr",
      createdAt: 1,
      updatedAt: 2,
    });

    const pullRequest = makePullRequest({
      title: "Show pull requests in thread show",
      attention: "ready_to_merge",
    });

    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);

    const pullRequestGet = vi.fn(async () => ({
      outcome: "available",
      pullRequest,
    }));

    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-show-pr"], register);

    expect(pullRequestGet).toHaveBeenCalledWith({
      param: { id: "env-show-pr" },
    });
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output.indexOf("Environment:")).toBeLessThan(
      output.indexOf("Pull request:"),
    );
    expect(output).toContain(
      "Pull request: #42 open - Show pull requests in thread show",
    );
    expect(output).toContain("#42 open - Show pull requests in thread show");
    expect(output).toContain("https://github.com/example/omnyo/pull/42");
    expect(output).toContain("Branch:       omnyo/thread-show-pr -> main");
    expect(output).toContain(
      "Checks:       passing (3 passed, 0 failed, 0 pending, 3 total)",
    );
    expect(output).toContain("Review:       review_required (1 requested)");
    expect(output).toContain("Merge:        mergeable");
  });

  it("omnyo thread show reports a failed pull request lookup distinctly from none", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-pr-down",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-show-pr-down",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const environment = fixtures.makeEnvironment({
      id: "env-show-pr-down",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });

    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);

    const pullRequestGet = vi.fn(async () => ({
      outcome: "unavailable",
      message: "gh pr view failed: authentication required",
    }));

    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-show-pr-down"], register);

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Pull request: unavailable");
    expect(output).toContain("gh pr view failed: authentication required");
    expect(output).not.toContain("Pull request: none");
  });

  it("includes authoritative plugin bootstrap data in JSON when requested", async () => {
    const thread = {
      ...fixtures.makeThread({
        id: "thread-bootstrap-cli",
        projectId: "proj-1",
        providerId: "codex",
        environmentId: null,
      }),
      experimental_pluginData: [
        {
          pluginId: "card",
          method: "read",
          outcome: { ok: true, result: null },
        },
      ],
    };

    const get = vi.fn(async () => thread);
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
    });
    await runCommand(
      [
        "thread",
        "show",
        thread.id,
        "--include",
        "experimental_pluginData",
        "--json",
      ],
      register,
    );
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { include: "experimental_pluginData" },
      }),
    );
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])).thread
        .experimental_pluginData,
    ).toEqual(thread.experimental_pluginData);
  });

  it("omnyo thread show --json includes pull request details", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-json-show-pr",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-json-show-pr",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const environment = fixtures.makeEnvironment({
      id: "env-json-show-pr",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });

    const pullRequest = makePullRequest();
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);

    const pullRequestGet = vi.fn(async () => ({
      outcome: "available",
      pullRequest,
    }));

    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-json-show-pr", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      thread,
      environment: {
        ...environment,
        pullRequest: {
          status: "available",
          pullRequest,
        },
      },
      pendingTodos: null,
    });
  });

  it("omnyo thread show --json prints the thread in status payload format", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-json-show",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });

    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-json-show", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      thread,
      environment: null,
      pendingTodos: null,
    });
  });
});
