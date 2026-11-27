import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTree, groupProjects, type ChatTree } from "../lib/grouping.ts";
import { groupFoldKey, placeProject, type ChatGroup, type SectionRow } from "../lib/chat-groups.ts";
import { chat } from "./work-fixtures.ts";

const release: ChatGroup = { id: "g-release", projectId: "omnyo", name: "Release" };

const docs: ChatGroup = { id: "g-docs", projectId: "omnyo", name: "Docs" };

function describeRow(row: SectionRow): string | [string, string[]] {
  return row.kind === "chat"
    ? row.entry.node.thread.id
    : [row.group.name, row.members.map((member) => member.node.thread.id)];
}

function layout(tree: ChatTree, groups: readonly ChatGroup[]) {
  const project = groupProjects(tree)[0];
  assert.ok(project);
  const placed = placeProject(project, groups);

  return {
    sections: placed.sections.map((section) => [
      section.label,
      section.count,
      section.rows.map(describeRow),
    ]),
    shelf: placed.shelf?.rows.map(describeRow) ?? null,
  };
}

describe("chat group folders", () => {
  it("places a group once, in its most urgent member's section and position", () => {
    const tree = buildTree([
      chat("need-old", "needs-you", { createdAt: 1 }),
      chat("need-new", "needs-you", { createdAt: 9, groupId: release.id }),
      chat("open-a", "open", { createdAt: 5, groupId: release.id }),
      chat("open-b", "open", { createdAt: 6 }),
      chat("done-a", "ready-to-archive", { createdAt: 7, groupId: release.id }),
    ]);

    assert.deepEqual(layout(tree, [release]).sections, [
      ["Needs you", 4, [["Release", ["need-new", "open-a", "done-a"]], "need-old"]],
      ["Open", 1, ["open-b"]],
    ]);
  });

  it("keeps the folder where its lead would sort within that section", () => {
    const tree = buildTree([
      chat("open-new", "open", { createdAt: 9 }),
      chat("open-mid", "open", { createdAt: 5, groupId: docs.id }),
      chat("open-old", "open", { createdAt: 1, groupId: docs.id }),
    ]);

    assert.deepEqual(layout(tree, [docs]).sections, [
      ["Open", 3, ["open-new", ["Docs", ["open-mid", "open-old"]]]],
    ]);
  });

  it("keeps pinned and shelved members outside the folder", () => {
    const tree = buildTree([
      chat("run", "working", { createdAt: 5, groupId: release.id }),
      chat("pinned", "open", { createdAt: 6, groupId: release.id, isPinned: true }),
      chat("shelved", "open", { createdAt: 7, groupId: release.id, shelvedAt: 3 }),
    ]);

    assert.deepEqual(layout(tree, [release]), {
      sections: [
        ["Running", 1, [["Release", ["run"]]]],
        ["Pinned", 1, ["pinned"]],
      ],
      shelf: ["shelved"],
    });
  });

  it("renders no folder for a group without visible members", () => {
    const tree = buildTree([
      chat("open", "open"),
      chat("archived", "open", { groupId: release.id, isArchived: true }),
    ]);

    assert.deepEqual(layout(tree, [release]).sections, [["Open", 1, ["open"]]]);
  });

  it("treats unknown and other-project groups as ungrouped", () => {
    const foreign: ChatGroup = { id: "g-foreign", projectId: "elsewhere", name: "Foreign" };

    const tree = buildTree([
      chat("unknown", "open", { createdAt: 2, groupId: "g-missing" }),
      chat("foreign", "open", { createdAt: 1, groupId: foreign.id }),
    ]);

    assert.deepEqual(layout(tree, [foreign]).sections, [["Open", 2, ["unknown", "foreign"]]]);
  });

  it("keeps a sub-chat with its source chat whatever its own group", () => {
    const tree = buildTree([
      chat("parent", "open", { createdAt: 5 }),
      chat("child", "needs-you", { createdAt: 6, parentThreadId: "parent", groupId: release.id }),
      chat("member", "open", { createdAt: 4, groupId: release.id }),
    ]);

    const placed = layout(tree, [release]);
    assert.deepEqual(placed.sections, [["Open", 2, ["parent", ["Release", ["member"]]]]]);
    assert.deepEqual(
      tree.nodes.get("parent")?.children.map((child) => child.thread.id),
      ["child"],
    );
  });

  it("keeps a grouped chat's sub-chats under it inside the folder", () => {
    const tree = buildTree([
      chat("member", "open", { createdAt: 4, groupId: release.id }),
      chat("kid", "working", { createdAt: 5, parentThreadId: "member" }),
    ]);

    const project = groupProjects(tree)[0];
    assert.ok(project);
    const row = placeProject(project, [release]).sections[0]?.rows[0];
    assert.equal(row?.kind, "group");
    assert.deepEqual(
      row?.kind === "group" ? row.members[0]?.node.children.map((kid) => kid.thread.id) : null,
      ["kid"],
    );
  });

  it("drops a section emptied by a folder placed earlier", () => {
    const tree = buildTree([
      chat("need", "needs-you", { createdAt: 2, groupId: release.id }),
      chat("blocked", "blocked", { createdAt: 1, groupId: release.id }),
    ]);

    assert.deepEqual(layout(tree, [release]).sections, [
      ["Needs you", 2, [["Release", ["need", "blocked"]]]],
    ]);
  });

  it("persists folds under a key per group", () => {
    assert.equal(groupFoldKey("g-release"), "group:g-release");
    assert.notEqual(groupFoldKey("g-release"), groupFoldKey("g-docs"));
  });
});
