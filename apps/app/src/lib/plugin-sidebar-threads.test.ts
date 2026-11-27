import type { ThreadListEntry } from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import {
  toPendingSidebarThread,
  toPluginSidebarThread,
} from "./plugin-sidebar-threads";
import type { PendingChatSnapshot } from "./pending-chat-creations";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";

function makeThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: "A thread",
    lastReadAt: 10,
    latestAttentionAt: 5,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

describe("toPluginSidebarThread", () => {
  it("resolves the display title through the same rules Omnyo's row uses", () => {
    expect(toPluginSidebarThread(makeThread()).displayTitle).toBe("A thread");
    expect(
      toPluginSidebarThread(
        makeThread({ title: null, titleFallback: "Fallback" }),
      ).displayTitle,
    ).toBe("Fallback");
    expect(
      toPluginSidebarThread(
        makeThread({ id: "thr_abcdefghij", title: null, titleFallback: null }),
      ).displayTitle,
    ).toBe("Thread thr_abcd");

    const resources = {
      sectionNamesById: new Map([["sec_slop", "Slop Cop"]]),
      projectNamesById: new Map([["proj_1", "Omnyo"]]),
      threadById: new Map(),
    };

    expect(
      toPluginSidebarThread(
        makeThread({ title: "Review @section:sec_slop in @project:proj_1" }),
        new Map(),
        resources,
      ).displayTitle,
    ).toBe("Review Slop Cop in Omnyo");
  });

  it("maps activity counts onto the plugin-facing names", () => {
    const mapped = toPluginSidebarThread(
      makeThread({
        activity: {
          activeWorkflowCount: 2,
          activeBackgroundAgentCount: 3,
          activeBackgroundCommandCount: 4,
          activePlanModeCount: 5,
          activeGoalCount: 6,
          activeSubagentCount: 7,
        },
      }),
    );

    expect(mapped.activity).toEqual({
      workflows: 2,
      backgroundAgents: 3,
      backgroundCommands: 4,
      planMode: 5,
      goals: 6,
      experimental_subagents: 7,
    });
  });

  it("uses the server's primary work state while retaining concurrent activity", () => {
    const working = makeThreadWorkSummary({
      primary: {
        label: "working",
        reason: { code: "turn", text: "The turn is running." },
      },
      activity: [
        {
          id: "turn",
          kind: "turn",
          label: "The turn is running.",
          phase: "running",
          actor: { kind: "agent", id: null, label: "Agent" },
        },
      ],
    });

    const needsYou = makeThreadWorkSummary({
      primary: {
        label: "needs-you",
        reason: { code: "question", text: "Choose a path." },
      },
      requiredInput: [
        { id: "question", kind: "question", label: "Choose a path." },
      ],
      activity: working.activity,
    });

    const attention = toPluginSidebarThread(
      makeThread({
        work: needsYou,
        hasPendingInteraction: true,
        runtime: { displayStatus: "active" },
      }),
    );

    expect(attention.indicator).toBe("waiting-for-input");
    expect(attention.experimental_work).toBe(needsYou);
    expect(attention.experimental_work?.activity).toEqual(working.activity);
    expect(
      toPluginSidebarThread(
        makeThread({
          work: working,
          runtime: {
            displayStatus: "active",
          },
        }),
      ).indicator,
    ).toBe("runtime");

    const workflow = toPluginSidebarThread(
      makeThread({
        work: working,
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
          activeSubagentCount: 0,
        },
      }),
    );

    expect(workflow.indicator).toBe("runtime");
    expect(workflow.activity.workflows).toBe(1);
    expect(
      toPluginSidebarThread(
        makeThread({
          hasPendingInteraction: true,
          runtime: { displayStatus: "active" },
        }),
      ).indicator,
    ).toBe("open");
  });

  it("carries accessible labels from the server work summary", () => {
    expect(
      toPluginSidebarThread(
        makeThread({
          work: makeThreadWorkSummary({
            primary: {
              label: "needs-you",
              reason: { code: "question", text: "Choose a path." },
            },
          }),
          hasPendingInteraction: true,
        }),
      ).indicatorLabel,
    ).toBe("Needs you");
    const idle = toPluginSidebarThread(makeThread());
    expect(idle.indicator).toBe("open");
    expect(idle.indicatorLabel).toBe("Done");
  });

  it("keeps a failed work state independent of unreadness", () => {
    const thread = makeThread({
      status: "error",
      lastReadAt: 1,
      latestAttentionAt: 9,
      work: makeThreadWorkSummary({
        primary: {
          label: "failed",
          reason: { code: "run-failed", text: "The turn failed." },
        },
        failures: [
          { code: "run-failed", text: "The turn failed.", sourceId: null },
        ],
      }),
    });

    const mapped = toPluginSidebarThread(thread);

    expect(mapped.indicator).toBe("unread-error");
    expect(mapped.indicatorLabel).toBe("Failed");
    expect(mapped.status).toBe("error");
    expect(mapped.isUnread).toBe(true);
    expect(toPluginSidebarThread({ ...thread, lastReadAt: 9 })).toMatchObject({
      indicator: "unread-error",
      isUnread: false,
    });
  });

  it("reports unread child threads as unread", () => {
    const mapped = toPluginSidebarThread(
      makeThread({
        parentThreadId: "thr_parent",
        lastReadAt: 1,
        latestAttentionAt: 9,
      }),
    );

    expect(mapped.isUnread).toBe(true);
    expect(mapped.indicator).toBe("open");
  });

  it.each(["turn", "queue", "workflow", "agent", "command", "plugin"] as const)(
    "keeps unread attention visible during %s work, including work in launched chats",
    (kind) => {
      const thread = makeThread({
        lastReadAt: 1,
        latestAttentionAt: 9,
        work: makeThreadWorkSummary({
          primary: {
            label: "working",
            reason: { code: "owned-work", text: "Work is running." },
          },
          activity: [
            {
              id: "job",
              kind,
              label: "Work is running.",
              phase: kind === "queue" ? "queued" : "running",
              actor: { kind: "thread", id: "child", label: "Worker" },
            },
          ],
        }),
      });

      expect(toPluginSidebarThread(thread)).toMatchObject({
        indicator: "runtime",
        isUnread: true,
        lastReadAt: 1,
        latestAttentionAt: 9,
      });
      expect(
        toPluginSidebarThread({
          ...thread,
          work: makeThreadWorkSummary({
            primary: {
              label: "ready-to-archive",
              reason: { code: "complete", text: "Result is ready." },
            },
          }),
        }),
      ).toMatchObject({ indicator: "ready-to-archive", isUnread: true });
      expect(toPluginSidebarThread({ ...thread, lastReadAt: 9 }).isUnread).toBe(
        false,
      );
    },
  );

  it("treats a never-read thread as unread", () => {
    expect(
      toPluginSidebarThread(makeThread({ lastReadAt: null })).isUnread,
    ).toBe(true);
  });

  it("maps pin, archive, and environment fields", () => {
    const mapped = toPluginSidebarThread(
      makeThread({
        pinnedAt: 12,
        pinSortKey: "a0",
        archivedAt: 13,
        environmentId: "env_1",
        environmentName: "Worktree",
        environmentBranchName: "omnyo/feature",
        environmentPath: "/repos/omnyo/.worktrees/feature",
        environmentIsWorktree: true,
        environmentProviderId: "git-worktree",
        environmentWorkspaceDisplayKind: "managed-worktree",
        queuedWork: "none",
      }),
    );

    expect(mapped.isPinned).toBe(true);
    expect(mapped.pinnedAt).toBe(12);
    expect(mapped.pinSortKey).toBe("a0");
    expect(mapped.isArchived).toBe(true);
    expect(mapped.archivedAt).toBe(13);
    expect(mapped.href).toBe("/projects/proj_1/threads/thr_1");
    expect(mapped.environment).toEqual({
      id: "env_1",
      name: "Worktree",
      branchName: "omnyo/feature",
      path: "/repos/omnyo/.worktrees/feature",
      isWorktree: true,
      providerId: "git-worktree",
      workspaceDisplayKind: "managed-worktree",
    });
  });

  it("carries status, runtime status, and lineage the list sorts and groups by", () => {
    const mapped = toPluginSidebarThread(
      makeThread({
        status: "active",
        runtime: {
          displayStatus: "waiting-for-host",
        },
        lifecycleOwnerThreadId: "thr_owner",
        sourceThreadId: "thr_source",
        originKind: "fork",
      }),
    );

    expect(mapped.status).toBe("active");
    expect(mapped.runtimeStatus).toBe("waiting-for-host");
    expect(mapped.lifecycleOwnerThreadId).toBe("thr_owner");
    expect(mapped.sourceThreadId).toBe("thr_source");
  });

  it("exposes hidden threads with a flag instead of dropping them", () => {
    expect(toPluginSidebarThread(makeThread()).isHidden).toBe(false);
    expect(
      toPluginSidebarThread(makeThread({ visibility: "hidden" })).isHidden,
    ).toBe(true);
  });

  it("preserves queue facts alongside the server work state", () => {
    const blocked = makeThreadWorkSummary({
      primary: {
        label: "failed",
        reason: {
          code: "queue-failed",
          text: "Queued message failed to send.",
        },
      },
      failures: [
        {
          code: "queue-failed",
          text: "Queued message failed to send.",
          sourceId: "queued-message",
        },
      ],
    });

    const failed = toPluginSidebarThread(
      makeThread({ queuedWork: "failed", work: blocked }),
    );

    expect(failed.queuedWork).toBe("failed");
    expect(failed.indicator).toBe("unread-error");
    expect(failed.indicatorLabel).toBe("Failed");

    const waiting = toPluginSidebarThread(
      makeThread({
        queuedWork: "waiting",
        work: makeThreadWorkSummary({
          primary: {
            label: "waiting",
            reason: { code: "queue-held", text: "Waiting to send." },
          },
        }),
      }),
    );

    expect(waiting.queuedWork).toBe("waiting");
    expect(waiting.indicator).toBe("callback-waiting");
    expect(waiting.indicatorLabel).toBe("Waiting");

    const unreadAndFailed = toPluginSidebarThread(
      makeThread({
        queuedWork: "failed",
        work: blocked,
        lastReadAt: 1,
        latestAttentionAt: 9,
      }),
    );

    expect(unreadAndFailed.indicator).toBe("unread-error");
    expect(unreadAndFailed.queuedWork).toBe("failed");
    expect(unreadAndFailed.isUnread).toBe(true);
  });

  it("reports no environment when the thread has none", () => {
    expect(toPluginSidebarThread(makeThread()).environment).toBeNull();
  });

  it("carries the provider so a row can draw an agent glyph", () => {
    expect(toPluginSidebarThread(makeThread()).providerId).toBe("codex");
  });

  it("resolves the machine name for the thread's host", () => {
    const mapped = toPluginSidebarThread(
      makeThread({ environmentHostId: "host_1" }),
      new Map([["host_1", "Sawyer's MacBook"]]),
    );

    expect(mapped.host).toEqual({ id: "host_1", name: "Sawyer's MacBook" });
  });

  it("falls back to the host id when the machine is unknown", () => {
    const mapped = toPluginSidebarThread(
      makeThread({ environmentHostId: "host_gone" }),
      new Map(),
    );

    expect(mapped.host).toEqual({ id: "host_gone", name: "host_gone" });
  });

  it("reports no host when the thread has none", () => {
    expect(toPluginSidebarThread(makeThread()).host).toBeNull();
  });
});

function makePendingChat(
  overrides: Partial<PendingChatSnapshot> = {},
): PendingChatSnapshot {
  return {
    id: "pending_1",
    projectId: "proj_1",
    realThreadId: null,
    createdAt: 100,
    handoff: null,
    status: "creating",
    messages: [],
    request: {
      projectId: "proj_1",
      providerId: "codex",
      model: "gpt",
      reasoningLevel: "high",
      permissionMode: "full",
      environment: { type: "reuse", environmentId: "env_1" },
      executionInputSources: { providerId: "explicit", model: "explicit" },
      input: [{ type: "text", text: "Ship it", mentions: [] }],
      pinned: true,
    },
    ...overrides,
  };
}

describe("toPendingSidebarThread", () => {
  it("shows a chat that could not start as an unread failure", () => {
    expect(
      toPendingSidebarThread(makePendingChat({ status: "failed" })),
    ).toMatchObject({
      displayTitle: "Ship it",
      status: "error",
      runtimeStatus: "error",
      indicator: "unread-error",
      experimental_work: {
        primary: {
          label: "failed",
          reason: {
            text: "The chat could not start. Your messages were kept.",
          },
        },
      },
      isUnread: true,
      isPinned: true,
      pinnedAt: 100,
    });
  });

  it("shows a new chat that is still starting as working", () => {
    expect(toPendingSidebarThread(makePendingChat())).toMatchObject({
      status: "starting",
      runtimeStatus: "starting",
      queuedWork: "none",
    });
  });

  it("shows a new chat scheduled for later as waiting instead of starting", () => {
    const chat = makePendingChat();
    const sendAt = Date.now() + 3_600_000;

    const thread = toPendingSidebarThread({
      ...chat,
      request: chat.request === null ? null : { ...chat.request, sendAt },
    });

    expect(thread).toMatchObject({
      status: "idle",
      runtimeStatus: "idle",
      queuedWork: "waiting",
      experimental_work: {
        waits: [{ reason: "Waiting for the scheduled message time." }],
      },
    });
    expect(thread?.experimental_work?.activity).toEqual([]);
  });

  it("shows a new chat saved as a plugin draft as held instead of starting", () => {
    const chat = makePendingChat();

    const thread = toPendingSidebarThread({
      ...chat,
      request:
        chat.request === null
          ? null
          : {
              ...chat.request,
              expectedPluginWait: {
                kind: "plugin",
                pluginId: "drafts",
                reason: "Draft",
              },
            },
    });

    expect(thread).toMatchObject({
      status: "idle",
      runtimeStatus: "idle",
      queuedWork: "waiting",
      experimental_work: {
        activity: [{ label: "Draft", phase: "queued" }],
      },
    });
  });

  it("falls back to a generic title for a prompt without text", () => {
    const chat = makePendingChat();

    expect(
      toPendingSidebarThread({
        ...chat,
        request: chat.request === null ? null : { ...chat.request, input: [] },
      })?.displayTitle,
    ).toBe("New chat");
  });

  it("leaves confirmed, interrupted, and restored chats to the real list", () => {
    expect(
      toPendingSidebarThread(
        makePendingChat({ realThreadId: "thr_1", status: "opening" }),
      ),
    ).toBeNull();
    expect(
      toPendingSidebarThread(makePendingChat({ status: "interrupted" })),
    ).toBeNull();
    expect(
      toPendingSidebarThread(
        makePendingChat({ request: null, createdAt: null }),
      ),
    ).toBeNull();
  });
});
