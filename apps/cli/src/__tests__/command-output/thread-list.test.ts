import { describe, expect, it, vi } from "vitest";
import * as domain from "@omnyo/domain";
import {
  setupCommandOutputTestEnvironment,
  collectLogPayloads,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

function makeThreadListEntry(
  overrides: Parameters<typeof fixtures.makeThread>[0],
): domain.ThreadListEntry {
  return {
    ...fixtures.makeThread(overrides),
    runtime: { displayStatus: "idle" },
    work: null,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
      activeSubagentCount: 0,
    },
    queuedWork: "none",
    pinSortKey: null,
    shelfSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentWorkspaceDisplayKind: "other",
  };
}

describe("omnyo thread list command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("omnyo thread list supports parent-thread filtering", async () => {
    const list = vi.fn(async () => []);
    stubServerApi({ "v1.threads.$get": list });

    await runCommand(
      [
        "thread",
        "list",
        "--project",
        "proj-1",
        "--parent-thread",
        "thread-manager-1",
      ],
      register,
    );

    expect(list).toHaveBeenCalledWith({
      query: {
        projectId: "proj-1",
        parentThreadId: "thread-manager-1",
      },
    });
  });

  it("omnyo thread list narrows to repeated --thread IDs", async () => {
    const list = vi.fn(async () => []);
    stubServerApi({ "v1.threads.$get": list });

    await runCommand(
      ["thread", "list", "--thread", "thr_a", "--thread", "thr_b", "--json"],
      register,
    );

    expect(list).toHaveBeenCalledWith({
      query: { threadIds: "thr_a,thr_b" },
    });
  });

  it("omnyo thread list accepts a removed machine ID without looking it up among active machines", async () => {
    const list = vi.fn(async () => []);
    const hosts = vi.fn(async () => []);
    stubServerApi({
      "v1.threads.$get": list,
      "v1.hosts.$get": hosts,
    });

    await runCommand(
      ["thread", "list", "--machine", "host_removed123", "--json"],
      register,
    );

    expect(list).toHaveBeenCalledWith({ query: { hostId: "host_removed123" } });
    expect(hosts).not.toHaveBeenCalled();
  });

  it("omnyo thread list opts into hidden threads explicitly", async () => {
    const list = vi.fn(async () => []);
    stubServerApi({ "v1.threads.$get": list });

    await runCommand(["thread", "list", "--include-hidden"], register);

    expect(list).toHaveBeenCalledWith({
      query: { includeHidden: "true" },
    });
  });

  it("omnyo thread list --shelved asks for shelved threads only", async () => {
    const list = vi.fn(async () => []);
    stubServerApi({ "v1.threads.$get": list });

    await runCommand(["thread", "list", "--shelved", "--json"], register);

    expect(list).toHaveBeenCalledWith({
      query: { shelved: "true" },
    });
  });

  it("omnyo thread list refuses --archived with --shelved", async () => {
    const list = vi.fn(async () => []);
    stubServerApi({ "v1.threads.$get": list });

    await expect(
      runCommand(["thread", "list", "--archived", "--shelved"], register),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Cannot combine --archived with --shelved.",
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("omnyo thread list rejects invalid parent-thread values", async () => {
    const list = vi.fn(async () => []);
    stubServerApi({ "v1.threads.$get": list });

    await expect(
      runCommand(
        [
          "thread",
          "list",
          "--project",
          "proj-1",
          "--parent-thread",
          "thread/invalid",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      'Error: Invalid ID from --parent-thread: "thread/invalid". IDs must contain only letters, digits, hyphens, and underscores.',
    );
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    {
      flag: "archived",
      stamp: { archivedAt: 1 },
      table:
        "ID                 Title  Project  Status         \n-----------------  -----  -------  ---------------\nthread-archived-1  -      Alpha    Open (archived)",
    },
    {
      flag: "pinned",
      stamp: { pinnedAt: 1 },
      table:
        "ID               Title  Project  Status       \n---------------  -----  -------  -------------\nthread-pinned-1  -      Alpha    Open (pinned)",
    },
    {
      flag: "shelved",
      stamp: { shelvedAt: 1 },
      table:
        "ID                Title  Project  Status        \n----------------  -----  -------  --------------\nthread-shelved-1  -      Alpha    Open (shelved)",
    },
  ])(
    "omnyo thread list renders $flag status in the shared borderless table",
    async ({ flag, stamp, table }) => {
      const list = vi.fn(async () => [
        makeThreadListEntry({
          id: `thread-${flag}-1`,
          projectId: "proj-1",
          providerId: "codex",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
          ...stamp,
        }),
      ]);

      stubServerApi({
        "v1.threads.$get": list,
        "v1.projects.$get": async () => [{ id: "proj-1", name: "Alpha" }],
      });

      await runCommand(["thread", "list"], register);

      expect(list).toHaveBeenCalledWith({
        query: {},
      });
      expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
        "",
        table,
        "",
      ]);
    },
  );

  it("omnyo thread list hides the personal project label", async () => {
    const list = vi.fn(async () => [
      makeThreadListEntry({
        id: "thread-personal-1",
        projectId: domain.PERSONAL_PROJECT_ID,
        providerId: "codex",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      }),
    ]);

    stubServerApi({
      "v1.threads.$get": list,
      "v1.projects.$get": async () => [],
    });

    vi.stubEnv("OMNYO_PROJECT_ID", undefined);
    await runCommand(["thread", "list"], register);

    expect(list).toHaveBeenCalledWith({
      query: {},
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID                 Title  Project  Status      \n-----------------  -----  -------  ------------\nthread-personal-1  -      -        Open        ",
      "",
    ]);
  });

  it("omnyo thread list prints the thread title, fallback, and project name (#1648)", async () => {
    const list = vi.fn(async () => [
      makeThreadListEntry({
        id: "thr_a9niqhjj9c",
        projectId: "proj_bsst4jxfwv",
        providerId: "codex",
        status: "idle",
        title: "Investigate flaky login test",
        titleFallback: "Reply only with ok.",
        createdAt: 1,
        updatedAt: 1,
      }),
      makeThreadListEntry({
        id: "thr_uwfzqywzsz",
        projectId: "proj_bsst4jxfwv",
        providerId: "codex",
        status: "idle",
        title: null,
        titleFallback: "Reply only with ok.\nThis is the second QA thread.",
        createdAt: 1,
        updatedAt: 1,
      }),
      makeThreadListEntry({
        id: "thr_unknownproj",
        projectId: "proj_missing",
        providerId: "codex",
        status: "idle",
        title: "x".repeat(80),
        titleFallback: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    ]);

    const projects = vi.fn(async () => [{ id: "proj_bsst4jxfwv", name: "qa" }]);
    stubServerApi({ "v1.threads.$get": list, "v1.projects.$get": projects });

    await runCommand(["thread", "list"], register);

    expect(projects).toHaveBeenCalledWith({
      query: { includePersonal: "false" },
    });
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    const lines = output.split("\n");
    expect(lines[1]).toMatch(/^ID\s+Title\s+Project\s+Status/);
    expect(output).toContain("Investigate flaky login test");
    expect(output).toContain(
      "Reply only with ok. This is the second QA thread.",
    );
    expect(output).toContain(`${"x".repeat(59)}…`);
    expect(output).not.toContain("x".repeat(60));
    expect(output).toMatch(
      /thr_a9niqhjj9c\s+Investigate flaky login test\s+qa\s+Open/,
    );
    expect(output).toMatch(/thr_unknownproj\s+x+…\s+proj_missing\s+Open/);
  });

  it("omnyo thread list --json does not fetch projects", async () => {
    const list = vi.fn(async () => []);
    const projects = vi.fn(async () => []);
    stubServerApi({ "v1.threads.$get": list, "v1.projects.$get": projects });

    await runCommand(["thread", "list", "--json"], register);

    expect(projects).not.toHaveBeenCalled();
  });

  it("omnyo thread list does not infer parent-thread from OMNYO_THREAD_ID", async () => {
    const list = vi.fn(async () => []);

    stubServerApi({ "v1.threads.$get": list });

    vi.stubEnv("OMNYO_PROJECT_ID", "proj-env");
    vi.stubEnv("OMNYO_THREAD_ID", "thread-current");
    await runCommand(["thread", "list"], register);

    expect(list).toHaveBeenCalledWith({
      query: {},
    });
  });
});
