import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTree,
  countReachable,
  familyStopping,
  groupProjects,
  inboxRoots,
  inboxSections,
  rootAttention,
  rootsInProject,
  sectionProject,
  showsUnread,
  stateOfWork,
} from "../lib/grouping.ts";
import { rowLine } from "../lib/feed.ts";
import { chat, work } from "./work-fixtures.ts";

const cases = [
  ["needs-you", "need"],
  ["failed", "failed"],
  ["working", "run"],
  ["blocked", "blk"],
  ["waiting", "que"],
  ["open", "idle"],
  ["external", "ext"],
  ["ready-to-archive", "done"],
] as const;

describe("shared work grouping", () => {
  it("starts Projects with Needs you above an expanded Running section", () => {
    const tree = buildTree([
      chat("open", "open"),
      chat("run", "working"),
      chat("need", "needs-you"),
    ]);

    const project = sectionProject(tree.roots);
    const inbox = inboxSections(tree);
    assert.deepEqual(
      project.map((section) => [section.label, section.folded, section.entries[0]?.node.thread.id]),
      [
        ["Needs you", false, "need"],
        ["Running", false, "run"],
        ["Open", false, "open"],
      ],
    );
    assert.equal(inbox[0]?.label, "Running");
    assert.equal(inbox[0]?.folded, false);
    assert.equal(inbox[0]?.roots[0]?.thread.id, "run");
    assert.deepEqual(
      new Set(inbox.slice(1).map((section) => section.label)),
      new Set(["Needs you", "Open"]),
    );
  });

  for (const [label, state] of cases) {
    it(`renders ${label} identically in Inbox and Projects`, () => {
      const tree = buildTree([chat("one", label)]);
      assert.equal(tree.nodes.get("one")?.own, state);
      assert.equal(inboxSections(tree)[0]?.roots[0]?.own, state);
      assert.equal(sectionProject(tree.roots)[0]?.entries[0]?.node.own, state);
    });
  }

  it("places External between Open and Ready to archive in Projects and the Inbox", () => {
    const tree = buildTree([
      chat("done", "ready-to-archive", { createdAt: 1 }),
      chat("ext", "external", { createdAt: 2 }),
      chat("open", "open", { createdAt: 3 }),
    ]);

    assert.deepEqual(
      sectionProject(tree.roots).map((section) => [
        section.label,
        section.entries[0]?.node.thread.id,
      ]),
      [
        ["Open", "open"],
        ["External", "ext"],
        ["Ready to archive", "done"],
      ],
    );
    assert.deepEqual(
      inboxSections(tree).map((section) => [section.label, section.roots[0]?.thread.id]),
      [
        ["Open", "open"],
        ["External", "ext"],
        ["Ready to archive", "done"],
      ],
    );
  });

  it("uses the server label even when obsolete runtime indicators disagree", () => {
    const tree = buildTree([
      chat("one", "working", {
        status: "error",
        indicator: "unread-success",
        hasPendingInteraction: true,
      }),
    ]);

    assert.equal(tree.nodes.get("one")?.own, "run");
  });

  it("marks a working family as stopping only while nothing in it still runs", () => {
    const stopping = buildTree([chat("one", "working", { status: "stopping" })]).nodes.get("one");

    const stillRunning = buildTree([
      chat("root", "working", { status: "stopping" }),
      chat("kid", "working", { status: "active", parentThreadId: "root" }),
    ]).nodes.get("root");

    const idle = buildTree([chat("one", "open", { status: "stopping" })]).nodes.get("one");

    assert.ok(stopping !== undefined && stillRunning !== undefined && idle !== undefined);
    assert.equal(familyStopping(stopping), true);
    assert.equal(familyStopping(stillRunning), false);
    assert.equal(familyStopping(idle), false);
  });

  it("shows Open when the shared summary is unavailable", () => {
    assert.equal(stateOfWork(null), "idle");
    assert.equal(
      buildTree([chat("one", "working", { work: null, status: "active" })]).nodes.get("one")?.own,
      "idle",
    );
  });

  it("keeps unreadness independent for every work label", () => {
    for (const [label, state] of cases) {
      const read = buildTree([chat("one", label)]).nodes.get("one");
      const unread = buildTree([chat("one", label, { isUnread: true })]).nodes.get("one");
      assert.ok(read && unread);
      assert.equal(read.own, state);
      assert.equal(unread.own, state);
      assert.equal(showsUnread(read), false);
      assert.equal(showsUnread(unread), true);
    }
  });

  it("keeps work visible on the Shelf without inferring postponement", () => {
    const tree = buildTree([chat("one", "working", { shelvedAt: 50 })]);
    assert.equal(tree.roots.length, 0);
    assert.equal(tree.shelf[0]?.own, "run");
    assert.equal(tree.shelf[0]?.thread.work?.postponement, null);
  });

  it("preserves required input alongside advancing activity", () => {
    const summary = work("needs-you", {
      requiredInput: [{ id: "q", kind: "question", label: "Choose the release scope" }],
      activity: [
        {
          id: "job",
          kind: "plugin",
          phase: "running",
          label: "Release job running",
          actor: { kind: "agent", id: "producer", label: "Release job" },
        },
      ],
    });

    const node = buildTree([chat("one", "needs-you", { work: summary })]).nodes.get("one");
    assert.equal(node?.own, "need");
    assert.equal(node?.thread.work?.activity[0]?.id, "job");
  });

  it("retains family ordering and promotes a child's already classified activity", () => {
    const tree = buildTree([
      chat("root", "open", { createdAt: 1 }),
      chat("older", "working", { parentThreadId: "root", createdAt: 2 }),
      chat("newer", "open", { parentThreadId: "root", createdAt: 3, isUnread: true }),
    ]);

    assert.equal(tree.roots[0]?.state, "run");
    assert.deepEqual(
      tree.roots[0]?.children.map((child) => child.thread.id),
      ["newer", "older"],
    );
    assert.equal(tree.roots[0]?.newChildren, 1);
    assert.equal(countReachable(tree.roots), 3);
  });

  it("keeps child input in the family without projecting it into project sections", () => {
    const tree = buildTree([
      chat("root"),
      chat("child", "needs-you", { parentThreadId: "root" }),
      chat("grandchild", "needs-you", { parentThreadId: "child" }),
    ]);

    assert.equal(tree.nodes.get("root")?.own, "idle");
    assert.equal(tree.nodes.get("root")?.state, "need");
    assert.deepEqual(
      inboxRoots(tree).map((node) => node.thread.id),
      ["root"],
    );
    assert.deepEqual(
      inboxSections(tree).map((section) => [
        section.id,
        section.roots.map((node) => node.thread.id),
      ]),
      [["idle", ["root"]]],
    );
    assert.deepEqual(
      tree.roots[0]?.children.map((node) => node.thread.id),
      ["child"],
    );
    assert.deepEqual(
      tree.nodes.get("child")?.children.map((node) => node.thread.id),
      ["grandchild"],
    );
    assert.equal(countReachable(inboxRoots(tree)), 3);
  });

  it("uses the shared family priority while retaining every child's evidence", () => {
    const running = work("working", {
      activity: [
        {
          id: "job",
          kind: "plugin",
          phase: "running",
          label: "Release job running",
          actor: { kind: "agent", id: "producer", label: "Release job" },
        },
      ],
    });

    const failed = work("blocked", {
      failures: [{ code: "job-failed", text: "The earlier job failed", sourceId: "earlier" }],
    });

    const tree = buildTree([
      chat("root", "ready-to-archive"),
      chat("failed", "blocked", { parentThreadId: "root", work: failed }),
      chat("running", "working", { parentThreadId: "root", work: running }),
    ]);

    assert.equal(tree.nodes.get("root")?.own, "done");
    assert.equal(tree.nodes.get("root")?.state, "run");
    assert.equal(tree.nodes.get("failed")?.thread.work?.failures[0]?.code, "job-failed");
    assert.equal(tree.nodes.get("running")?.thread.work?.activity[0]?.id, "job");
  });

  it("keeps the project section independent of family readiness", () => {
    const tree = buildTree([
      chat("root", "ready-to-archive"),
      chat("child", "open", { parentThreadId: "root" }),
    ]);

    assert.equal(tree.nodes.get("root")?.own, "done");
    assert.equal(tree.nodes.get("root")?.state, "idle");
    assert.equal(sectionProject(tree.roots)[0]?.key, "done");
  });

  it("uses top-level own work for project and Live state while preserving the full family", () => {
    const tree = buildTree([
      chat("root", "working", {
        work: work("working", {
          experimental_ownState: {
            primary: { label: "open", reason: { code: "fixture", text: "Root is open" } },
            hasActivity: false,
          },
        }),
        isUnread: true,
      }),
      chat("child", "needs-you", { parentThreadId: "root" }),
      chat("owned", "working", { lifecycleOwnerThreadId: "missing", isUnread: true }),
    ]);

    const root = tree.nodes.get("root");
    const owned = tree.nodes.get("owned");

    assert.ok(root && owned);
    assert.equal(root.state, "need");
    assert.deepEqual(rootAttention(root), {
      state: "idle",
      unread: true,
      running: false,
      asking: false,
      reason: "Root is open",
    });
    assert.equal(rootAttention(owned).running, false);
    assert.equal(rootAttention(owned).unread, false);
    assert.equal(sectionProject(tree.roots)[0]?.key, "read");
  });

  it("keeps hidden and archived chats out while preserving orphans and cycles", () => {
    const tree = buildTree([
      chat("hidden", "working", { isHidden: true }),
      chat("archived", "blocked", { isArchived: true }),
      chat("orphan", "open", { parentThreadId: "archived" }),
      chat("cycle-a", "open", { parentThreadId: "cycle-b" }),
      chat("cycle-b", "working", { parentThreadId: "cycle-a" }),
    ]);

    assert.equal(tree.nodes.size, 3);
    assert.equal(countReachable(tree.roots), 3);
  });

  it("keeps diagnostics visible without grouping exposed children as project failures", () => {
    const tree = buildTree([
      chat("missing-owner-child", "failed", { parentThreadId: "missing", projectId: "b" }),
      chat("hidden", "open", { isHidden: true }),
      chat("hidden-owner-child", "blocked", { parentThreadId: "hidden", projectId: "b" }),
      chat("archived", "open", { isArchived: true }),
      chat("archived-owner-child", "failed", { parentThreadId: "archived", projectId: "b" }),
      chat("owner", "working", { projectId: "a" }),
      chat("cross-project-child", "failed", { parentThreadId: "owner", projectId: "b" }),
      chat("independent", "failed", { projectId: "b" }),
    ]);

    const sections = sectionProject(rootsInProject(tree.roots, "b"));
    assert.deepEqual(
      sections
        .find((section) => section.key === "failed")
        ?.entries.map(({ node }) => node.thread.id),
      ["independent"],
    );
    assert.deepEqual(
      sections
        .find((section) => section.key === "read")
        ?.entries.map(({ node }) => node.thread.id)
        .sort(),
      ["archived-owner-child", "cross-project-child", "hidden-owner-child", "missing-owner-child"],
    );
    assert.deepEqual(
      inboxSections(tree)
        .find((section) => section.id === "failed")
        ?.roots.map((node) => node.thread.id),
      ["independent"],
    );
    assert.equal(tree.nodes.get("missing-owner-child")?.state, "failed");
    assert.equal(tree.nodes.get("hidden-owner-child")?.state, "blk");
    assert.equal(tree.nodes.get("cross-project-child")?.state, "failed");
    assert.equal(tree.nodes.get("owner")?.state, "run");
  });

  it("keeps a lifecycle-owned failure out of owner attention without a sidebar parent", () => {
    const tree = buildTree([
      chat("lifecycle-owned", "failed", { lifecycleOwnerThreadId: "parent" }),
      chat("independent", "failed"),
    ]);

    assert.deepEqual(
      sectionProject(tree.roots)
        .find((section) => section.key === "failed")
        ?.entries.map(({ node }) => node.thread.id),
      ["independent"],
    );
    assert.equal(tree.nodes.get("lifecycle-owned")?.state, "failed");
  });

  it("retains project grouping, pinning and cross-project family access", () => {
    const tree = buildTree([
      chat("root", "working", { projectId: "a" }),
      chat("child", "blocked", { parentThreadId: "root", projectId: "b" }),
      chat("pinned", "open", { projectId: "b", isPinned: true }),
    ]);

    assert.equal(groupProjects(tree).length, 2);
    assert.deepEqual(
      rootsInProject(tree.roots, "b")
        .map((node) => node.thread.id)
        .sort(),
      ["child", "pinned"],
    );
    assert.equal(
      sectionProject(tree.roots).find((section) => section.key === "pinned")?.entries[0]?.node
        .thread.id,
      "pinned",
    );
  });
});

it("keeps an optional question on a failed chat out of Needs you", () => {
  const summary = work("failed", {
    optionalInput: [{ id: "q", kind: "question", label: "Optional choice" }],
  });

  assert.equal(stateOfWork(summary), "failed");
});

it("separates failed and required-input families", () => {
  const tree = buildTree([chat("failed", "failed"), chat("question", "needs-you")]);
  assert.deepEqual(
    sectionProject(tree.roots).map((section) => [section.label, section.entries.length]),
    [
      ["Needs you", 1],
      ["Failed", 1],
    ],
  );
});

it("keeps a blocked child's diagnostics with its parent without raising attention", () => {
  const tree = buildTree([
    chat("root", "waiting"),
    chat("child", "blocked", { parentThreadId: "root" }),
  ]);

  assert.equal(tree.roots[0]?.state, "que");
  assert.equal(tree.nodes.get("child")?.state, "blk");
  assert.equal(tree.nodes.get("child")?.thread.work?.primary.label, "blocked");
});

it("moves only a running chat's optional choice into Needs you, leaving family state alone", () => {
  const expected = [
    ["open", "idle", "idle", "read", false, false],
    ["working", "run", "need", "need", true, true],
    ["failed", "failed", "failed", "failed", false, false],
    ["needs-you", "need", "need", "need", false, false],
  ] as const;

  for (const [label, family, state, section, running, asking] of expected) {
    const summary = work(label, {
      optionalInput: [{ id: "optional", kind: "question", label: "Optional choice" }],
      requiredInput:
        label === "needs-you"
          ? [{ id: "required", kind: "question", label: "Required choice" }]
          : [],
    });

    const tree = buildTree([chat("one", label, { work: summary })]);
    const root = tree.roots[0];
    assert.ok(root);
    assert.equal(root.state, family, label);
    assert.equal(rootAttention(root).state, state, label);
    assert.equal(rootAttention(root).running, running, label);
    assert.equal(rootAttention(root).asking, asking, label);
    assert.equal(
      rootAttention(root).reason,
      label === "failed" || label === "needs-you" ? `Recorded ${label} reason` : "Optional choice",
      label,
    );
    assert.equal(sectionProject(tree.roots)[0]?.key, section, label);
    assert.equal(root.thread.work?.optionalInput[0]?.id, "optional");
  }
});

it("puts running chats that ask the owner at the top of Needs you", () => {
  const turn = [
    {
      id: "turn:1",
      kind: "turn" as const,
      phase: "running" as const,
      label: "The agent is working.",
      actor: { kind: "agent" as const, id: null, label: "Agent" },
    },
  ];

  const question = (id: string) => [{ id, kind: "question" as const, label: `Question ${id}` }];

  const tree = buildTree([
    chat("idle-need", "needs-you", {
      createdAt: 3_000_000,
      work: work("needs-you", { requiredInput: question("idle") }),
    }),
    chat("asks-optional", "working", {
      createdAt: 1_000_000,
      work: work("working", { activity: turn, optionalInput: question("optional") }),
    }),
    chat("asks-required", "needs-you", {
      createdAt: 2_000_000,
      work: work("needs-you", { activity: turn, requiredInput: question("required") }),
    }),
    chat("plain-run", "working", { work: work("working", { activity: turn }) }),
    chat("pinned-asks", "working", {
      isPinned: true,
      work: work("working", { activity: turn, optionalInput: question("pinned") }),
    }),
  ]);

  const sections = sectionProject(tree.roots);

  assert.deepEqual(
    sections.map((section) => [section.key, section.entries.map(({ node }) => node.thread.id)]),
    [
      ["need", ["asks-required", "asks-optional", "idle-need"]],
      ["run", ["plain-run"]],
      ["pinned", ["pinned-asks"]],
    ],
  );
  assert.deepEqual(
    ["asks-required", "asks-optional", "idle-need", "plain-run", "pinned-asks"].map(
      (id) => rootAttention(tree.nodes.get(id)!).asking,
    ),
    [true, true, false, false, true],
  );
});

it("keeps a sub-chat's question on its parent row without moving the parent", () => {
  const turn = [
    {
      id: "turn:1",
      kind: "turn" as const,
      phase: "running" as const,
      label: "The agent is working.",
      actor: { kind: "agent" as const, id: null, label: "Agent" },
    },
  ];

  const tree = buildTree([
    chat("root", "working", { work: work("working", { activity: turn }) }),
    chat("child", "working", {
      parentThreadId: "root",
      work: work("working", {
        activity: turn,
        optionalInput: [{ id: "optional", kind: "question", label: "Optional choice" }],
      }),
    }),
  ]);

  const root = tree.nodes.get("root");
  assert.ok(root);
  assert.equal(rowLine(root).verb, "Open decision");
  assert.match(rowLine(root).reason ?? "", /Sub-chat child: Optional choice/u);
  assert.equal(rootAttention(root).asking, false);
  assert.equal(rootAttention(tree.nodes.get("child")!).asking, false);
  assert.equal(sectionProject(tree.roots)[0]?.key, "run");
});

it("keeps required and failed family state ahead of optional siblings", () => {
  for (const label of ["needs-you", "failed"] as const) {
    const tree = buildTree([
      chat("root", label),
      chat("optional", "open", {
        parentThreadId: "root",
        work: work("open", {
          optionalInput: [{ id: "optional", kind: "question", label: "Optional choice" }],
        }),
      }),
      chat("running", "working", { parentThreadId: "root" }),
    ]);

    assert.equal(tree.roots[0]?.state, label === "needs-you" ? "need" : "failed");
  }
});
