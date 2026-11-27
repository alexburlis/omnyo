import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTree, continuationLabel, inboxSections } from "../lib/grouping.ts";
import { familyChildCount } from "../lib/subagents.ts";
import { chat, work } from "./work-fixtures.ts";
import { rowLine } from "../lib/feed.ts";

function handoff(
  id: string,
  from: string,
  createdAt: number,
  label: Parameters<typeof chat>[1] = "open",
) {
  return chat(id, label, { originKind: "handoff", sourceThreadId: from, createdAt });
}

function childIds(tree: ReturnType<typeof buildTree>, id: string): string[] {
  return tree.nodes.get(id)?.children.map((child) => child.thread.id) ?? [];
}

describe("continued chats", () => {
  it("groups a whole chain under its newest chat", () => {
    const tree = buildTree([
      chat("first", "open", { createdAt: 1 }),
      handoff("second", "first", 2),
      handoff("third", "second", 3),
      chat("first-agent", "open", { parentThreadId: "first", createdAt: 4 }),
    ]);

    assert.deepEqual(
      tree.roots.map((node) => node.thread.id),
      ["third"],
    );
    assert.deepEqual(childIds(tree, "third"), ["second", "first"]);
    assert.deepEqual(childIds(tree, "first"), ["first-agent"]);
    assert.equal(tree.nodes.get("first")?.continuation, true);
    assert.equal(tree.nodes.get("first")?.parentId, "third");
    assert.equal(tree.nodes.get("first-agent")?.continuation, false);
    assert.equal(tree.nodes.get("third")?.continuation, false);

    const label = (id: string) => {
      const node = tree.nodes.get(id);
      assert.ok(node);

      return continuationLabel(node);
    };

    assert.equal(label("third"), "Continues 2 earlier chats");
    assert.equal(label("first"), "Earlier chat");
    assert.equal(label("first-agent"), null);
  });

  it("keeps an earlier chat's attention on its nested row", () => {
    const tree = buildTree([
      chat("source", "needs-you", { createdAt: 1 }),
      handoff("continued", "source", 2),
    ]);

    assert.deepEqual(
      inboxSections(tree).map((section) => [
        section.label,
        section.roots.map((node) => node.thread.id),
      ]),
      [["Open", ["continued"]]],
    );
    assert.equal(tree.nodes.get("source")?.state, "need");
    assert.deepEqual(childIds(tree, "continued"), ["source"]);
  });

  for (const label of ["needs-you", "failed"] as const) {
    it(`keeps a resumed ${label} source nested without changing its working continuation`, () => {
      const source = chat("source", label, {
        createdAt: 1,
        latestAttentionAt: 1,
        lastMessageAt: 3,
        work: work(label, {
          requiredInput: [{ id: "source-question", kind: "question", label: "Choose a scope" }],
        }),
      });

      const tree = buildTree([source, handoff("continued", "source", 2, "working")]);

      assert.deepEqual(
        tree.roots.map((node) => node.thread.id),
        ["continued"],
      );
      assert.equal(tree.nodes.get("continued")?.state, "run");
      assert.deepEqual(childIds(tree, "continued"), ["source"]);
      assert.equal(tree.nodes.get("source")?.state, label === "failed" ? "failed" : "need");
      assert.equal(tree.nodes.get("source")?.thread.work?.requiredInput[0]?.id, "source-question");
    });
  }

  for (const status of ["active", "starting", "stopping"]) {
    it(`keeps an independently ${status} source nested with its own status`, () => {
      const tree = buildTree([
        chat("source", "working", { createdAt: 1, latestAttentionAt: 1, status }),
        handoff("continued", "source", 2),
      ]);

      assert.equal(tree.nodes.get("source")?.parentId, "continued");
      assert.equal(tree.nodes.get("source")?.state, "run");
      assert.equal(tree.nodes.get("continued")?.state, "idle");
    });
  }

  it("keeps a newly raised question on its source without a new message", () => {
    const tree = buildTree([
      chat("source", "needs-you", { createdAt: 1, latestAttentionAt: 3 }),
      handoff("continued", "source", 2, "working"),
    ]);

    assert.equal(tree.nodes.get("source")?.parentId, "continued");
    assert.equal(tree.nodes.get("source")?.state, "need");
    assert.equal(tree.nodes.get("continued")?.state, "run");
  });

  it("keeps a resumed middle chat in the chain with its helpers' attention", () => {
    const tree = buildTree([
      chat("first", "open", { createdAt: 1, latestAttentionAt: 1 }),
      { ...handoff("middle", "first", 2, "failed"), latestAttentionAt: 5, lastMessageAt: 4 },
      handoff("latest", "middle", 3, "working"),
      chat("helper", "needs-you", { parentThreadId: "middle", createdAt: 6 }),
    ]);

    assert.deepEqual(
      tree.roots.map((node) => node.thread.id),
      ["latest"],
    );
    assert.equal(tree.nodes.get("latest")?.state, "run");
    assert.deepEqual(childIds(tree, "latest"), ["middle", "first"]);
    assert.equal(tree.nodes.get("middle")?.state, "need");
    assert.deepEqual(childIds(tree, "middle"), ["helper"]);
    assert.deepEqual(
      tree.nodes.get("latest")?.family.map((thread) => thread.id),
      ["latest"],
    );
    assert.deepEqual(
      tree.nodes.get("middle")?.family.map((thread) => thread.id),
      ["middle", "helper"],
    );
    const latest = tree.nodes.get("latest");
    const middle = tree.nodes.get("middle");
    assert.ok(latest);
    assert.ok(middle);
    assert.equal(rowLine(latest).reason, "Recorded working reason");
    assert.equal(rowLine(middle).reason, "Sub-chat helper: Recorded needs-you reason");
  });

  it("does not count earlier chats as subchats", () => {
    const tree = buildTree([
      chat("source", "open", { createdAt: 1, activity: { experimental_subagents: 1 } }),
      handoff("continued", "source", 2, "working"),
      chat("helper", "working", { parentThreadId: "continued", createdAt: 3 }),
    ]);

    const head = tree.nodes.get("continued");
    assert.ok(head);
    assert.equal(familyChildCount(head), 2);
  });

  it("recognizes a predecessor explicitly parented under its continuation as history", () => {
    const tree = buildTree([
      chat("source", "failed", { parentThreadId: "continued", createdAt: 1 }),
      handoff("continued", "source", 2, "working"),
      chat("source-helper", "needs-you", { parentThreadId: "source", createdAt: 3 }),
      chat("current-helper", "failed", { parentThreadId: "continued", createdAt: 4 }),
    ]);

    const continued = tree.nodes.get("continued");
    assert.ok(continued);
    assert.equal(continued.state, "run");
    assert.equal(tree.nodes.get("source")?.continuation, true);
    assert.equal(tree.nodes.get("source")?.state, "need");
    assert.deepEqual(
      continued.family.map((thread) => thread.id),
      ["continued", "current-helper"],
    );
    assert.equal(rowLine(continued).reason, "Recorded working reason");
    assert.equal(tree.nodes.get("current-helper")?.state, "failed");
  });

  it("keeps the newest branch as the group and leaves older branches apart", () => {
    const tree = buildTree([
      chat("source", "open", { createdAt: 1 }),
      handoff("older", "source", 2),
      handoff("newer", "source", 3),
    ]);

    assert.deepEqual(
      tree.roots.map((node) => node.thread.id),
      ["newer", "older"],
    );
    assert.deepEqual(childIds(tree, "newer"), ["source"]);
  });

  it("pulls a shelved earlier chat under its active continuation", () => {
    const tree = buildTree([
      chat("source", "open", { createdAt: 1, shelvedAt: 5 }),
      handoff("continued", "source", 2),
    ]);

    assert.deepEqual(
      tree.roots.map((node) => node.thread.id),
      ["continued"],
    );
    assert.equal(tree.shelf.length, 0);
    assert.deepEqual(childIds(tree, "continued"), ["source"]);
  });

  it("keeps live earlier chats, pinned and nested sources out of a shelved or foreign group", () => {
    const tree = buildTree(
      [
        chat("live", "needs-you", { createdAt: 1 }),
        handoff("shelved", "live", 2),
        chat("pinned", "open", { createdAt: 1, isPinned: true }),
        handoff("from-pinned", "pinned", 2),
        chat("parent", "open", { createdAt: 1 }),
        chat("child", "open", { createdAt: 1, parentThreadId: "parent" }),
        handoff("from-child", "child", 2),
        chat("elsewhere", "open", { createdAt: 1, projectId: "other" }),
        handoff("from-elsewhere", "elsewhere", 2),
        handoff("from-missing", "missing", 2),
      ].map((thread) => (thread.id === "shelved" ? { ...thread, shelvedAt: 9 } : thread)),
    );

    assert.equal(tree.nodes.get("live")?.parentId, null);
    assert.equal(tree.nodes.get("pinned")?.parentId, null);
    assert.equal(tree.nodes.get("child")?.parentId, "parent");
    assert.equal(tree.nodes.get("elsewhere")?.parentId, null);
    assert.equal(tree.nodes.get("from-missing")?.parentId, null);
    assert.ok(tree.roots.some((node) => node.thread.id === "live"));
  });
});

it("keeps an earlier optional choice out of the continuation's current family", () => {
  const tree = buildTree([
    chat("source", "open", {
      createdAt: 1,
      work: work("open", {
        optionalInput: [{ id: "old-choice", kind: "question", label: "Earlier choice" }],
      }),
    }),
    handoff("continued", "source", 2, "working"),
  ]);

  const continued = tree.nodes.get("continued");
  assert.ok(continued);
  assert.equal(continued.state, "run");
  assert.equal(rowLine(continued).verb, "Working");
  assert.doesNotMatch(rowLine(continued).reason ?? "", /Earlier choice/u);
  assert.equal(tree.nodes.get("source")?.thread.work?.optionalInput[0]?.id, "old-choice");
});
