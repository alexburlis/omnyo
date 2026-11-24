import { and, eq } from "drizzle-orm";
import {
  events,
  environments,
  getLatestThreadSequence,
  hostDaemonSessions,
  threads,
} from "@omnyo/db";
import { threadScope, turnScope, type GitActivity } from "@omnyo/domain";
import { expect, it, vi } from "vitest";
import {
  GIT_ACTIVITY_MIN_PROTOCOL_VERSION,
  recordTurnGitActivity,
} from "../../../src/services/threads/turn-git-activity.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../../helpers/host-rpc.js";
import {
  seedEvent,
  seedThreadFixture,
  seedTurnStarted,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const PROVIDER_THREAD_ID = "provider-thread";

const WORKSPACE_PATH = "/tmp/test-environment";

const ACTIVITY: GitActivity = {
  commits: [
    {
      sha: "a".repeat(40),
      subject: "Fix the build",
      kind: "commit",
      branch: "main",
      replacedSha: null,
      committedAt: 11_000,
      remoteRefs: ["origin/main"],
    },
  ],
  pushes: [
    {
      remote: "origin",
      branch: "main",
      oldSha: "b".repeat(40),
      newSha: "a".repeat(40),
      forced: false,
      pushedAt: 45_000,
      commitCount: 1,
    },
  ],
  remotes: [{ name: "origin", url: "https://github.com/acme/repo.git" }],
};

it("reads Git activity from the command's contained repository", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedThreadFixture(harness);
    const key = { threadId: fixture.thread.id, turnId: "nested-turn" };
    const cwd = `${WORKSPACE_PATH}/nested-repository`;

    const responder = respondWith(harness, fixture, {
      ok: true,
      result: { outcome: "available", activity: ACTIVITY },
    });

    seedTurnStarted(harness.deps, key);
    seedCommand(harness, {
      ...key,
      itemId: "nested-commit",
      command: "git commit -m change",
      cwd,
      parentToolCallId: null,
      startedAt: 10_000,
      completedAt: 12_000,
    });
    seedTurnCompleted(harness, { ...key, createdAt: 13_000 });
    await recordTurnGitActivity(harness.deps, key);
    expect(responder.requests).toHaveLength(1);
    expect(responder.requests[0]?.command).toMatchObject({
      repositoryPath: cwd,
      workspaceContext: { workspacePath: WORKSPACE_PATH },
    });
    expect(
      listGitActivityEvents(harness, key.threadId)[0]?.data.workspacePath,
    ).toBe(cwd);
  });
});

it.each(["", "relative/repo", "/unrelated/repo"])(
  "does not attribute an untrusted command cwd %s",
  async (cwd) => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const key = { threadId: fixture.thread.id, turnId: "unknown-repo" };

      const responder = respondWith(harness, fixture, {
        ok: true,
        result: { outcome: "available", activity: ACTIVITY },
      });

      seedTurnStarted(harness.deps, key);
      seedCommand(harness, {
        ...key,
        itemId: "commit",
        command: "git commit -m change",
        cwd,
        parentToolCallId: null,
        startedAt: 10_000,
        completedAt: 12_000,
      });
      seedTurnCompleted(harness, { ...key, createdAt: 13_000 });
      await recordTurnGitActivity(harness.deps, key);
      expect(responder.requests).toHaveLength(0);
    });
  },
);

it("leaves overlapping commits from another chat unattributed", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedThreadFixture(harness);
    const other = seedThreadFixture(harness);
    harness.db
      .update(threads)
      .set({ environmentId: fixture.environment.id })
      .where(eq(threads.id, other.thread.id))
      .run();
    const key = { threadId: fixture.thread.id, turnId: "own-turn" };

    const responder = respondWith(harness, fixture, {
      ok: true,
      result: { outcome: "available", activity: ACTIVITY },
    });

    for (const [threadId, turnId] of [
      [key.threadId, key.turnId],
      [other.thread.id, "other-turn"],
    ] as const) {
      seedTurnStarted(harness.deps, { threadId, turnId });
      seedCommand(harness, {
        threadId,
        turnId,
        itemId: `${turnId}-commit`,
        command: "git commit -m change",
        parentToolCallId: null,
        startedAt: 10_000,
        completedAt: 12_000,
      });
    }

    seedTurnCompleted(harness, { ...key, createdAt: 13_000 });
    await recordTurnGitActivity(harness.deps, key);
    expect(responder.requests).toHaveLength(0);
  });
});

it.each([
  "git -Cnested commit -m change",
  "git --no-pager -C nested commit -m change",
  "git '-Cnested' commit -m change",
  "Set-Location nested; git commit -m change",
  "popd && git commit -m change",
  "GIT_DIR=/other/repo git commit -m change",
  "git --work-tree=/other/worktree commit -m change",
])(
  "omits Git attribution when shell repository targeting is ambiguous: %s",
  async (command) => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const key = { threadId: fixture.thread.id, turnId: "ambiguous-shell" };

      const responder = respondWith(harness, fixture, {
        ok: true,
        result: { outcome: "available", activity: ACTIVITY },
      });

      seedTurnStarted(harness.deps, key);
      seedCommand(harness, {
        ...key,
        itemId: "own-commit",
        command,
        parentToolCallId: null,
        startedAt: 10000,
        completedAt: 12000,
      });
      seedTurnCompleted(harness, { ...key, createdAt: 13000 });
      await recordTurnGitActivity(harness.deps, key);
      expect(responder.requests).toHaveLength(0);
    });
  },
);

it.each([
  {
    name: "different cwd in the same repo",
    startedAt: 10000,
    completedAt: 12000,
    expectRead: false,
  },
  {
    name: "containing interval",
    startedAt: 1000,
    completedAt: 30000,
    expectRead: false,
  },
  {
    name: "unclosed command",
    startedAt: 1000,
    completedAt: null,
    expectRead: false,
  },
  {
    name: "already completed command",
    startedAt: 1000,
    completedAt: 3000,
    expectRead: true,
  },
])(
  "handles competing same-host Git command intervals: $name",
  async ({ startedAt, completedAt, expectRead }) => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const other = seedThreadFixture(harness);
      harness.db
        .update(environments)
        .set({ hostId: fixture.host.id })
        .where(eq(environments.id, other.environment.id))
        .run();
      const key = { threadId: fixture.thread.id, turnId: "own-interval" };

      const responder = respondWith(harness, fixture, {
        ok: true,
        result: { outcome: "available", activity: ACTIVITY },
      });

      seedTurnStarted(harness.deps, key);
      seedCommand(harness, {
        ...key,
        itemId: "own-commit",
        command: "git commit -m own",
        cwd: `${WORKSPACE_PATH}/src`,
        parentToolCallId: null,
        startedAt: 10000,
        completedAt: 12000,
      });
      seedCommand(harness, {
        threadId: other.thread.id,
        turnId: "competing-turn",
        itemId: "other-commit",
        command: "git commit -m other",
        cwd: "/symlink-alias/to-repository",
        parentToolCallId: null,
        startedAt,
        completedAt,
      });
      seedTurnCompleted(harness, { ...key, createdAt: 13000 });
      await recordTurnGitActivity(harness.deps, key);
      expect(responder.requests).toHaveLength(expectRead ? 1 : 0);
    });
  },
);

it("keeps ordinary chained Git commands with a stable cwd", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedThreadFixture(harness);
    const key = { threadId: fixture.thread.id, turnId: "same-cwd-chain" };

    const responder = respondWith(harness, fixture, {
      ok: true,
      result: { outcome: "available", activity: ACTIVITY },
    });

    seedTurnStarted(harness.deps, key);
    seedCommand(harness, {
      ...key,
      itemId: "commit",
      command: "git add . && git commit -m change",
      parentToolCallId: null,
      startedAt: 10000,
      completedAt: 12000,
    });
    seedTurnCompleted(harness, { ...key, createdAt: 13000 });
    await recordTurnGitActivity(harness.deps, key);
    expect(responder.requests).toHaveLength(1);
  });
});

it.each([true, false])(
  "deduplicates shared activity across cwd groups without merging distinct activity (%s)",
  async (duplicate) => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);

      const key = {
        threadId: fixture.thread.id,
        turnId: "multiple-repositories",
      };

      const nested = `${WORKSPACE_PATH}/nested`;

      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        handle: (request) => {
          if (request.command.type !== "workspace.gitActivity")
            throw new Error("Unexpected command");
          const same = duplicate || request.command.repositoryPath !== nested;

          return {
            ok: true,
            result: {
              outcome: "available",
              activity: {
                commits: ACTIVITY.commits.map((commit) => ({
                  ...commit,
                  sha: same ? commit.sha : "c".repeat(40),
                })),
                pushes: ACTIVITY.pushes.map((push) => ({
                  ...push,
                  newSha: same ? push.newSha : "c".repeat(40),
                })),
                remotes: ACTIVITY.remotes,
              },
            },
          };
        },
      });

      seedTurnStarted(harness.deps, key);

      for (const [index, cwd] of [WORKSPACE_PATH, nested].entries()) {
        seedCommand(harness, {
          ...key,
          itemId: `commit-${index}`,
          command: "git commit -m change",
          cwd,
          parentToolCallId: null,
          startedAt: 10000,
          completedAt: 12000,
        });
      }

      seedTurnCompleted(harness, { ...key, createdAt: 13000 });
      await recordTurnGitActivity(harness.deps, key);
      expect(responder.requests).toHaveLength(2);
      expect(listGitActivityEvents(harness, key.threadId)).toHaveLength(
        duplicate ? 1 : 2,
      );
    });
  },
);

interface SeedCommandArgs {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  parentToolCallId: string | null;
  startedAt: number;
  completedAt: number | null;
  cwd?: string;
}

interface SeedBackgroundTaskArgs {
  threadId: string;
  commandItemId: string;
  type: "item/backgroundTask/progress" | "item/backgroundTask/completed";
  createdAt: number;
}

function nextSequence(harness: TestAppHarness, threadId: string): number {
  return getLatestThreadSequence(harness.db, { threadId }) + 1;
}

function seedCommand(harness: TestAppHarness, args: SeedCommandArgs): void {
  const rootItem = {
    type: "commandExecution" as const,
    id: args.itemId,
    command: args.command,
    cwd: args.cwd ?? WORKSPACE_PATH,
    approvalStatus: null,
  };

  const item =
    args.parentToolCallId === null
      ? rootItem
      : { ...rootItem, parentToolCallId: args.parentToolCallId };

  seedEvent(harness.deps, {
    threadId: args.threadId,
    sequence: nextSequence(harness, args.threadId),
    createdAt: args.startedAt,
    type: "item/started",
    scope: turnScope(args.turnId),
    providerThreadId: PROVIDER_THREAD_ID,
    data: {
      providerThreadId: PROVIDER_THREAD_ID,
      item: { ...item, status: "pending" },
    },
  });

  if (args.completedAt !== null) {
    seedEvent(harness.deps, {
      threadId: args.threadId,
      sequence: nextSequence(harness, args.threadId),
      createdAt: args.completedAt,
      type: "item/completed",
      scope: turnScope(args.turnId),
      providerThreadId: PROVIDER_THREAD_ID,
      data: {
        providerThreadId: PROVIDER_THREAD_ID,
        item: { ...item, status: "completed" },
      },
    });
  }
}

function seedBackgroundTask(
  harness: TestAppHarness,
  args: SeedBackgroundTaskArgs,
): void {
  const settled = args.type === "item/backgroundTask/completed";

  seedEvent(harness.deps, {
    threadId: args.threadId,
    sequence: nextSequence(harness, args.threadId),
    createdAt: args.createdAt,
    type: args.type,
    scope: threadScope(),
    providerThreadId: PROVIDER_THREAD_ID,
    data: {
      providerThreadId: PROVIDER_THREAD_ID,
      item: {
        type: "backgroundTask",
        id: `task-${args.commandItemId}`,
        taskType: "local_bash",
        description: "Long command",
        status: settled ? "completed" : "pending",
        taskStatus: settled ? "completed" : "running",
        skipTranscript: false,
        parentToolCallId: args.commandItemId,
      },
    },
  });
}

function seedTurnCompleted(
  harness: TestAppHarness,
  args: { threadId: string; turnId: string; createdAt: number },
): void {
  seedEvent(harness.deps, {
    threadId: args.threadId,
    sequence: nextSequence(harness, args.threadId),
    createdAt: args.createdAt,
    type: "turn/completed",
    scope: turnScope(args.turnId),
    providerThreadId: PROVIDER_THREAD_ID,
    data: { providerThreadId: PROVIDER_THREAD_ID, status: "completed" },
  });
}

function seedGitTurn(
  harness: TestAppHarness,
  args: { threadId: string; turnId: string },
): void {
  seedTurnStarted(harness.deps, {
    threadId: args.threadId,
    turnId: args.turnId,
    providerThreadId: PROVIDER_THREAD_ID,
  });
  seedCommand(harness, {
    ...args,
    itemId: `${args.turnId}-commit`,
    command: "git commit -qam 'Fix the build'",
    parentToolCallId: null,
    startedAt: 10_000,
    completedAt: 12_000,
  });
  seedTurnCompleted(harness, { ...args, createdAt: 20_000 });
}

function listGitActivityEvents(harness: TestAppHarness, threadId: string) {
  return harness.db
    .select({
      turnId: events.turnId,
      environmentId: events.environmentId,
      data: events.data,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "system/git-activity"),
      ),
    )
    .all()
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

function respondWith(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedThreadFixture>,
  result: HostRpcHandlerResult,
) {
  return registerHostRpcResponder(harness, {
    hostId: fixture.host.id,
    sessionId: fixture.session.id,
    handle: () => result,
  });
}

it("reads the turn's git command windows from the host and records the activity once", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedThreadFixture(harness);
    const threadId = fixture.thread.id;
    const turnId = "turn-git";

    const responder = respondWith(harness, fixture, {
      ok: true,
      result: { outcome: "available", activity: ACTIVITY },
    });

    const notify = vi.spyOn(harness.hub, "notifyThread");
    seedTurnStarted(harness.deps, { threadId, turnId });

    seedCommand(harness, {
      threadId,
      turnId,
      itemId: "commit",
      command: "git add -A && git commit -q -m 'Fix the build'",
      parentToolCallId: null,
      startedAt: 10_000,
      completedAt: 12_000,
    });
    seedCommand(harness, {
      threadId,
      turnId,
      itemId: "amend",
      command: "git commit -q --amend --no-edit",
      parentToolCallId: null,
      startedAt: 13_000,
      completedAt: 13_500,
    });
    seedCommand(harness, {
      threadId,
      turnId,
      itemId: "tests",
      command: "pnpm test",
      parentToolCallId: null,
      startedAt: 20_000,
      completedAt: 21_000,
    });
    seedCommand(harness, {
      threadId,
      turnId,
      itemId: "push",
      command: "git push -q origin main",
      parentToolCallId: null,
      startedAt: 30_000,
      completedAt: 31_000,
    });
    seedCommand(harness, {
      threadId,
      turnId,
      itemId: "subagent-pick",
      command: "git cherry-pick abc1234",
      parentToolCallId: "subagent-call",
      startedAt: 60_000,
      completedAt: 61_000,
    });
    seedCommand(harness, {
      threadId,
      turnId,
      itemId: "interrupted-pull",
      command: "git pull --rebase",
      parentToolCallId: null,
      startedAt: 70_000,
      completedAt: null,
    });
    seedTurnCompleted(harness, { threadId, turnId, createdAt: 80_000 });
    seedBackgroundTask(harness, {
      threadId,
      commandItemId: "push",
      type: "item/backgroundTask/progress",
      createdAt: 40_000,
    });
    seedBackgroundTask(harness, {
      threadId,
      commandItemId: "push",
      type: "item/backgroundTask/completed",
      createdAt: 50_000,
    });
    seedBackgroundTask(harness, {
      threadId,
      commandItemId: "tests",
      type: "item/backgroundTask/completed",
      createdAt: 55_000,
    });
    seedTurnStarted(harness.deps, { threadId, turnId: "turn-later" });
    seedCommand(harness, {
      threadId,
      turnId: "turn-later",
      itemId: "later-commit",
      command: "git commit -qm later",
      parentToolCallId: null,
      startedAt: 90_000,
      completedAt: 91_000,
    });

    await recordTurnGitActivity(harness.deps, { threadId, turnId });
    await recordTurnGitActivity(harness.deps, { threadId, turnId });

    expect(responder.requests.map((request) => request.command)).toEqual([
      {
        type: "workspace.gitActivity",
        environmentId: fixture.environment.id,
        workspaceContext: { workspacePath: WORKSPACE_PATH },
        windows: [
          { startMs: 8_000, endMs: 15_500 },
          { startMs: 28_000, endMs: 52_000 },
          { startMs: 58_000, endMs: 63_000 },
          { startMs: 68_000, endMs: 82_000 },
        ],
        maxCommits: 50,
        maxPushes: 50,
      },
    ]);
    expect(listGitActivityEvents(harness, threadId)).toEqual([
      {
        turnId,
        environmentId: fixture.environment.id,
        data: { workspacePath: WORKSPACE_PATH, activity: ACTIVITY },
      },
    ]);
    expect(notify).toHaveBeenCalledWith(
      threadId,
      expect.arrayContaining(["events-appended"]),
      expect.objectContaining({ eventTypes: ["system/git-activity"] }),
    );
  });
});

it("records nothing when the turn's git commands made no commits or pushes", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedThreadFixture(harness);
    const threadId = fixture.thread.id;

    const responder = respondWith(harness, fixture, {
      ok: true,
      result: {
        outcome: "available",
        activity: { commits: [], pushes: [], remotes: [] },
      },
    });

    seedGitTurn(harness, { threadId, turnId: "turn-empty" });

    await recordTurnGitActivity(harness.deps, {
      threadId,
      turnId: "turn-empty",
    });

    expect(responder.requests).toHaveLength(1);
    expect(listGitActivityEvents(harness, threadId)).toEqual([]);
  });
});

it("logs a failed host read and records nothing", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedThreadFixture(harness);
    const threadId = fixture.thread.id;
    const turnId = "turn-host-error";

    respondWith(harness, fixture, {
      ok: false,
      errorCode: "git_command_failed",
      errorMessage: "git log failed",
    });

    const warn = vi.spyOn(harness.deps.logger, "warn");
    seedGitTurn(harness, { threadId, turnId });

    await recordTurnGitActivity(harness.deps, { threadId, turnId });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, turnId }),
      "Turn git activity read failed",
    );
    expect(listGitActivityEvents(harness, threadId)).toEqual([]);
  });
});

it("skips the host read for turns without git commands and for daemons that predate it", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedThreadFixture(harness);
    const threadId = fixture.thread.id;

    const responder = respondWith(harness, fixture, {
      ok: true,
      result: { outcome: "available", activity: ACTIVITY },
    });

    seedTurnStarted(harness.deps, { threadId, turnId: "turn-plain" });
    seedCommand(harness, {
      threadId,
      turnId: "turn-plain",
      itemId: "plain-tests",
      command: "pnpm test && gh pr view",
      parentToolCallId: null,
      startedAt: 10_000,
      completedAt: 11_000,
    });
    seedTurnCompleted(harness, {
      threadId,
      turnId: "turn-plain",
      createdAt: 12_000,
    });

    await recordTurnGitActivity(harness.deps, {
      threadId,
      turnId: "turn-plain",
    });

    harness.db
      .update(hostDaemonSessions)
      .set({ protocolVersion: GIT_ACTIVITY_MIN_PROTOCOL_VERSION - 1 })
      .where(eq(hostDaemonSessions.id, fixture.session.id))
      .run();
    seedGitTurn(harness, { threadId, turnId: "turn-old-daemon" });

    await recordTurnGitActivity(harness.deps, {
      threadId,
      turnId: "turn-old-daemon",
    });

    expect(responder.requests).toEqual([]);
    expect(listGitActivityEvents(harness, threadId)).toEqual([]);
  });
});
