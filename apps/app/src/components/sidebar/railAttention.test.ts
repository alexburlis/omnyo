import { describe, expect, it } from "vitest";
import {
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@omnyo/client-core";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  EMPTY_RAIL_ATTENTION,
  inboxTriage,
  inboxTriageLabel,
  isRailAttentionQuiet,
  railAttentionByProject,
  railAttentionLabel,
  railChatState,
  railRoots,
  sumRailAttention,
} from "./railAttention";
import {
  railAttentionFixture,
  railAttentionFixtureThreads,
} from "./rail-attention.fixture";

describe("rail attention fixture", () => {
  it("records the indicator core resolves for every fixture thread", () => {
    expect(
      railAttentionFixtureThreads.map((thread) =>
        resolveThreadListIndicator(
          threadListIndicatorStateForThread(thread, false),
        ),
      ),
    ).toEqual(railAttentionFixture.threads.map((thread) => thread.indicator));
  });

  it("counts failed, needs-you, running and fresh roots per project", () => {
    const counts = railAttentionByProject(railAttentionFixtureThreads);

    for (const project of railAttentionFixture.projects) {
      expect({
        project: project.id,
        counts: counts.get(project.id) ?? EMPTY_RAIL_ATTENTION,
      }).toEqual({
        project: project.id,
        counts: railAttentionFixture.expected.projects[project.id],
      });
    }
  });

  it("sums every project into the Inbox totals", () => {
    expect(
      sumRailAttention(
        railAttentionByProject(railAttentionFixtureThreads).values(),
      ),
    ).toEqual(railAttentionFixture.expected.inbox);
  });

  it("counts failed and needs-you roots separately for each project's badges", () => {
    const counts = railAttentionByProject(railAttentionFixtureThreads);

    expect(
      Object.fromEntries(
        railAttentionFixture.projects.map((project) => {
          const { failed, needs } =
            counts.get(project.id) ?? EMPTY_RAIL_ATTENTION;

          return [project.id, { failed, needs }];
        }),
      ),
    ).toEqual({
      proj_omnyo: { failed: 1, needs: 1 },
      proj_web: { failed: 2, needs: 0 },
      proj_ops: { failed: 0, needs: 0 },
      proj_empty: { failed: 0, needs: 0 },
      proj_personal: { failed: 0, needs: 1 },
    });
  });
});

describe("inboxTriage", () => {
  it("keeps an execution failure visible when an optional question also exists", () => {
    const failed = makeThreadListEntry({
      id: "failed-with-question",
      work: makeThreadWorkSummary({
        primary: {
          label: "failed",
          reason: { code: "failure", text: "Usage limit reached" },
        },
        optionalInput: [
          { id: "optional", kind: "question", label: "Any preference?" },
        ],
      }),
    });

    expect(railChatState(failed)).toBe("failed");
  });

  const entry = (
    id: string,
    label:
      | "needs-you"
      | "working"
      | "failed"
      | "blocked"
      | "open"
      | "ready-to-archive",
    unread: boolean,
    parentThreadId: string | null = null,
  ) =>
    makeThreadListEntry({
      id,
      parentThreadId,
      lastReadAt: unread ? 100 : 200,
      latestAttentionAt: 200,
      work: makeThreadWorkSummary({
        primary: { label, reason: { code: "test", text: label } },
      }),
    });

  it("counts the shared fixture's roots once each, keeping unread visible beside running work", () => {
    expect(inboxTriage(railAttentionFixtureThreads)).toEqual({
      needs: 2,
      failed: 3,
      unread: 2,
      ready: 0,
    });
  });

  it("places each root in the first matching bucket: needs you, unread, then ready to archive", () => {
    expect(
      inboxTriage([
        entry("needs", "needs-you", true),
        entry("failed", "failed", false),
        entry("blocked", "blocked", false),
        entry("ready-unread", "ready-to-archive", true),
        entry("ready", "ready-to-archive", false),
        entry("ready-two", "ready-to-archive", false),
        entry("ready-parent", "ready-to-archive", false),
        entry("child-needs", "needs-you", false, "ready-parent"),
        entry("working-unread", "working", true),
        entry("open", "open", false),
      ]),
    ).toEqual({ needs: 1, failed: 1, unread: 1, ready: 3 });
  });

  it("labels the non-zero buckets for assistive technology", () => {
    expect(
      inboxTriageLabel({ needs: 1, failed: 0, unread: 2, ready: 3 }, 4),
    ).toBe("Inbox, 1 needs you, 2 unread, 3 ready to archive, 4 running");
    expect(
      inboxTriageLabel({ needs: 0, failed: 0, unread: 0, ready: 0 }, 0),
    ).toBe("Inbox");
  });
});

describe("optional decision attention", () => {
  it("counts a running root as needing you while its optional decision is open", () => {
    const work = makeThreadWorkSummary({
      primary: {
        label: "working",
        reason: { code: "owned-work", text: "Review running" },
      },
      optionalInput: [
        {
          id: "question",
          kind: "question",
          label: "Where should personal docs live?",
        },
      ],
      activity: [
        {
          id: "review",
          kind: "workflow",
          phase: "running",
          label: "Review",
          actor: { kind: "agent", id: null, label: "Agent" },
        },
      ],
    });

    const thread = makeThreadListEntry({
      id: "decision",
      projectId: "project",
      work,
    });

    expect(railChatState(thread)).toBe("needs");
    expect(railAttentionByProject([thread]).get("project")).toMatchObject({
      needs: 1,
      running: 1,
      hasRunningWork: true,
    });
    expect(inboxTriage([thread])).toEqual({
      needs: 1,
      failed: 0,
      unread: 0,
      ready: 0,
    });
    const answered = { ...thread, work: { ...work, optionalInput: [] } };
    expect(railChatState(answered)).toBe("running");
    expect(railAttentionByProject([answered]).get("project")).toMatchObject({
      needs: 0,
      running: 1,
    });
    expect(inboxTriage([answered]).needs).toBe(0);
  });

  it("ignores child decisions and work even in another project", () => {
    const parent = makeThreadListEntry({ id: "parent", projectId: "project" });

    const decision = makeThreadListEntry({
      id: "decision",
      projectId: "project",
      parentThreadId: "parent",
      work: makeThreadWorkSummary({
        optionalInput: [
          { id: "question", kind: "question", label: "Choose a location" },
        ],
      }),
    });

    const worker = makeThreadListEntry({
      id: "worker",
      projectId: "other-project",
      parentThreadId: "parent",
      work: makeThreadWorkSummary({
        primary: {
          label: "working",
          reason: { code: "owned-work", text: "Review running" },
        },
      }),
    });

    const threads = [parent, decision, worker];
    expect(railAttentionByProject(threads).get("project")).toEqual(
      EMPTY_RAIL_ATTENTION,
    );
    expect(railAttentionByProject(threads).has("other-project")).toBe(false);
    expect(inboxTriage(threads).needs).toBe(0);
  });
});

describe("railChatState", () => {
  it.each([
    ["open", "quiet", 0, 0],
    ["working", "needs", 1, 0],
    ["ready-to-archive", "quiet", 0, 1],
    ["needs-you", "needs", 1, 0],
  ] as const)(
    "counts optional input as needing you only while the server %s state runs",
    (label, state, needs, ready) => {
      const thread = makeThreadListEntry({
        id: "question",
        projectId: "project",
        lastReadAt: 200,
        latestAttentionAt: 200,
        hasPendingInteraction: label === "needs-you",
        work: makeThreadWorkSummary({
          primary: { label, reason: { code: "server", text: label } },
          requiredInput:
            label === "needs-you"
              ? [{ id: "required", kind: "permission", label: "Approve" }]
              : [],
          optionalInput: [
            { id: "optional", kind: "question", label: "Any preference?" },
          ],
        }),
      });

      expect(railChatState(thread)).toBe(state);
      expect(railAttentionByProject([thread]).get("project")?.needs).toBe(
        needs,
      );
      expect(inboxTriage([thread])).toMatchObject({ needs, ready });
    },
  );
  it("does not classify an unresolved dependency as a failed run", () => {
    expect(
      railChatState(
        makeThreadListEntry({
          work: makeThreadWorkSummary({
            primary: {
              label: "blocked",
              reason: { code: "unknown", text: "Waiting for evidence" },
            },
          }),
        }),
      ),
    ).toBe("quiet");
  });

  function work(
    primary: NonNullable<
      Parameters<typeof makeThreadWorkSummary>[0]
    >["primary"],
  ) {
    return makeThreadWorkSummary({ primary });
  }

  it("renders a read failure from its server work label", () => {
    const thread = makeThreadListEntry({
      status: "error",
      lastReadAt: 300,
      latestAttentionAt: 200,
      work: work({
        label: "failed",
        reason: { code: "run-failed", text: "The run failed." },
      }),
    });

    expect(
      resolveThreadListIndicator(
        threadListIndicatorStateForThread(thread, false),
      ),
    ).toBe("unread-error");
    expect(railChatState(thread)).toBe("failed");
    expect(railChatState({ ...thread, status: "idle" })).toBe("failed");
  });

  it("does not infer work from runtime fields when the summary is unavailable", () => {
    const thread = makeThreadListEntry({
      status: "active",
      hasPendingInteraction: true,
      work: null,
    });

    expect(railChatState(thread)).toBe("quiet");
  });

  it("preserves Working and required attention when read status changes", () => {
    for (const [label, expected] of [
      ["working", "running"],
      ["needs-you", "needs"],
    ] as const) {
      const thread = makeThreadListEntry({
        work: work({ label, reason: { code: "fixture", text: label } }),
        lastReadAt: 100,
        latestAttentionAt: 200,
      });

      expect(railChatState(thread)).toBe(expected);
      expect(railChatState({ ...thread, lastReadAt: 200 })).toBe(expected);
    }
  });
});

describe("unread activity suppression", () => {
  it.each(["turn", "queue", "workflow", "agent", "command", "plugin"] as const)(
    "keeps unread results hidden for %s activity even when a question takes priority",
    (kind) => {
      const threads = [
        makeThreadListEntry({
          id: "working",
          projectId: "active",
          work: makeThreadWorkSummary({
            primary: {
              label: "needs-you",
              reason: { code: "input", text: "Question" },
            },
            activity: [
              {
                id: "job",
                kind,
                phase: kind === "queue" ? "queued" : "running",
                label: "Job",
                actor: { kind: "agent", id: null, label: "Agent" },
              },
            ],
          }),
        }),
        makeThreadListEntry({
          id: "other",
          projectId: "active",
          latestAttentionAt: 2,
          lastReadAt: 1,
        }),
      ];

      const counts = railAttentionByProject(threads);
      const active = counts.get("active");

      if (!active) throw new Error("Missing active project");
      expect(active.hasRunningWork).toBe(true);
      expect(active.unread).toBe(1);
      expect(railAttentionLabel("active", active)).not.toContain("unread");
      expect(
        railAttentionLabel("Inbox", sumRailAttention(counts.values())),
      ).not.toContain("unread");

      const finished = railAttentionByProject(
        threads.filter((thread) => thread.id !== "working"),
      ).get("active");

      if (!finished) throw new Error("Missing completed project");
      expect(finished.hasRunningWork).toBe(false);
      expect(railAttentionLabel("active", finished)).toContain("1 unread");
    },
  );
});

describe("railRoots", () => {
  it.each(["absent", "archived", "hidden", "lifecycle owner"] as const)(
    "keeps a failed child out of attention when its parent is %s",
    (status) => {
      const child = makeThreadListEntry({
        id: "child",
        projectId: "child-project",
        parentThreadId: status === "lifecycle owner" ? null : "parent",
        lifecycleOwnerThreadId: status === "lifecycle owner" ? "parent" : null,
        lastReadAt: 100,
        latestAttentionAt: 200,
        work: makeThreadWorkSummary({
          primary: {
            label: "failed",
            reason: { code: "run-failed", text: "The child run failed." },
          },
        }),
      });

      const parent = makeThreadListEntry({
        id: "parent",
        projectId: "parent-project",
        archivedAt: status === "archived" ? 200 : null,
        visibility: status === "hidden" ? "hidden" : "visible",
      });

      const threads =
        status === "absent" || status === "lifecycle owner"
          ? [child]
          : [parent, child];

      expect(railAttentionByProject(threads).has("child-project")).toBe(false);
      expect(inboxTriage(threads).failed).toBe(0);
      expect(inboxTriage(threads).unread).toBe(0);

      const released = [
        { ...child, parentThreadId: null, lifecycleOwnerThreadId: null },
      ];

      expect(
        railAttentionByProject(released).get("child-project")?.failed,
      ).toBe(1);
      expect(inboxTriage(released).failed).toBe(1);
    },
  );

  it("uses the server's own state when a parent's family is working", () => {
    const thread = makeThreadListEntry({
      id: "parent",
      projectId: "project",
      lastReadAt: 100,
      latestAttentionAt: 200,
      work: makeThreadWorkSummary({
        primary: {
          label: "working",
          reason: { code: "owned-work", text: "Child working" },
        },
        experimental_ownState: {
          primary: {
            label: "open",
            reason: { code: "assessment-missing", text: "Open" },
          },
          hasActivity: false,
        },
      }),
    });

    expect(railAttentionByProject([thread]).get("project")).toEqual({
      ...EMPTY_RAIL_ATTENTION,
      fresh: 1,
      unread: 1,
    });
  });

  it("keeps a failed child diagnostic out of parent attention", () => {
    const roots = railRoots([
      makeThreadListEntry({ id: "parent" }),
      makeThreadListEntry({
        id: "child",
        parentThreadId: "parent",
        work: makeThreadWorkSummary({
          primary: {
            label: "failed",
            reason: { code: "failure", text: "Provider exhausted" },
          },
        }),
      }),
    ]);

    expect(roots.map((root) => [root.thread.id, root.state])).toEqual([
      ["parent", "quiet"],
    ]);
  });

  it("keeps child running and unread state out of project summaries", () => {
    const roots = railRoots([
      makeThreadListEntry({ id: "root_quiet", projectId: "proj_a" }),
      makeThreadListEntry({
        id: "kid_unread",
        projectId: "proj_a",
        parentThreadId: "root_quiet",
        lastReadAt: 100,
        latestAttentionAt: 200,
      }),
      makeThreadListEntry({ id: "root_running", projectId: "proj_a" }),
      makeThreadListEntry({
        id: "kid_running",
        projectId: "proj_a",
        parentThreadId: "root_running",
        work: makeThreadWorkSummary({
          primary: {
            label: "working",
            reason: { code: "owner", text: "A job is running." },
          },
        }),
      }),
    ]);

    expect(roots.map((root) => [root.thread.id, root.state])).toEqual([
      ["root_quiet", "quiet"],
      ["root_running", "quiet"],
    ]);
  });

  it("omits a parent cycle with no top-level chat", () => {
    const roots = railRoots([
      makeThreadListEntry({ id: "loop_a", parentThreadId: "loop_b" }),
      makeThreadListEntry({
        id: "loop_b",
        parentThreadId: "loop_a",
        status: "error",
        work: makeThreadWorkSummary({
          primary: {
            label: "failed",
            reason: { code: "run-failed", text: "The run failed." },
          },
        }),
      }),
    ]);

    expect(roots).toEqual([]);
  });
});

describe("railAttentionLabel", () => {
  it("reads the name and the non-zero counts", () => {
    expect(
      railAttentionLabel("omnyo-private", {
        failed: 1,
        needs: 2,
        running: 3,
        fresh: 0,
        unread: 0,
        hasRunningWork: true,
      }),
    ).toBe("omnyo-private, 1 failed, 2 need you, 3 running");
    expect(
      railAttentionLabel("web", {
        failed: 0,
        needs: 1,
        running: 0,
        fresh: 4,
        unread: 4,
        hasRunningWork: false,
      }),
    ).toBe("web, 1 needs you, 4 unread");
    expect(railAttentionLabel("empty", EMPTY_RAIL_ATTENTION)).toBe("empty");
  });

  it("treats a project with no counts as quiet", () => {
    expect(isRailAttentionQuiet(EMPTY_RAIL_ATTENTION)).toBe(true);
    expect(
      isRailAttentionQuiet({
        failed: 0,
        needs: 0,
        running: 0,
        fresh: 1,
        unread: 1,
        hasRunningWork: false,
      }),
    ).toBe(false);
  });
});
