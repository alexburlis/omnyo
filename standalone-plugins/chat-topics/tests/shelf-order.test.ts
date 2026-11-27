import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTree, groupProjects, type GroupThread } from "../lib/grouping.ts";
import {
  heldShelfOrder,
  inHeldOrder,
  inShelfOrder,
  liveShelfOrder,
  shelfMove,
  type ShelfSlot,
} from "../lib/shelf-order.ts";
import { chat } from "./work-fixtures.ts";

function shelved(
  id: string,
  shelfSortKey: string | null,
  shelvedAt = 100,
  change: Partial<GroupThread> = {},
): GroupThread {
  return chat(id, "open", { shelvedAt, shelfSortKey, ...change });
}

function ids(nodes: readonly { thread: { id: string } }[]): string[] {
  return nodes.map((node) => node.thread.id);
}

function slots(...entries: [string, boolean][]): ShelfSlot[] {
  return entries.map(([id, keyed]) => ({ id, keyed }));
}

describe("Shelf order", () => {
  it("lists just-shelved chats first, then by key, then newest shelved, then id", () => {
    const tree = buildTree([
      shelved("keyed-b", "b"),
      shelved("keyed-a", "a"),
      shelved("upper", "B"),
      shelved("tie-old", "c", 10),
      shelved("tie-new", "c", 20),
      shelved("pending", null, 5),
      shelved("tie-id-2", "d", 30),
      shelved("tie-id-1", "d", 30),
      chat("active"),
    ]);

    assert.deepEqual(ids(tree.shelf), [
      "pending",
      "upper",
      "keyed-a",
      "keyed-b",
      "tie-new",
      "tie-old",
      "tie-id-1",
      "tie-id-2",
    ]);
    assert.deepEqual(ids(tree.roots), ["active"]);
  });

  it("keeps each project's Shelf in the shared key order, with sub-chats under their root", () => {
    const tree = buildTree([
      shelved("late", "c"),
      shelved("early", "a", 100, { projectId: "other" }),
      shelved("middle", "b"),
      shelved("kid", "c", 100, { parentThreadId: "late" }),
    ]);

    const shelves = new Map(
      groupProjects(tree).map((group) => [
        group.projectId,
        group.shelf?.entries.map((entry) => entry.node.thread.id),
      ]),
    );

    assert.deepEqual(shelves.get("omnyo"), ["middle", "late"]);
    assert.deepEqual(shelves.get("other"), ["early"]);
    assert.deepEqual(ids(tree.nodes.get("late")?.children ?? []), ["kid"]);
  });
});

describe("dropping a Shelf chat", () => {
  const list = slots(["a", true], ["b", true], ["c", true], ["d", true]);

  it("sends the moved chat with the neighbors it now sits between", () => {
    assert.deepEqual(shelfMove(list, "d", "b", "before"), {
      threadId: "d",
      previousThreadId: "a",
      nextThreadId: "b",
      order: ["a", "d", "b", "c"],
    });

    assert.deepEqual(shelfMove(list, "a", "c", "after"), {
      threadId: "a",
      previousThreadId: "c",
      nextThreadId: "d",
      order: ["b", "c", "a", "d"],
    });
  });

  it("uses no previous neighbor at the top and no next neighbor at the bottom", () => {
    assert.equal(shelfMove(list, "c", "a", "before")?.previousThreadId, null);
    assert.equal(shelfMove(list, "b", "d", "after")?.nextThreadId, null);
  });

  it("ignores drops that leave the order unchanged", () => {
    assert.equal(shelfMove(list, "b", "a", "after"), null);
    assert.equal(shelfMove(list, "b", "c", "before"), null);
    assert.equal(shelfMove(list, "b", "b", "after"), null);
    assert.equal(shelfMove(list, "gone", "b", "after"), null);
    assert.equal(shelfMove(list, "b", "gone", "after"), null);
  });

  it("skips just-shelved chats without a key when naming neighbors", () => {
    const fresh = slots(["new", false], ["a", true], ["b", true]);

    assert.deepEqual(shelfMove(fresh, "b", "new", "before"), {
      threadId: "b",
      previousThreadId: null,
      nextThreadId: "a",
      order: ["b", "new", "a"],
    });

    assert.deepEqual(shelfMove(fresh, "new", "b", "after")?.previousThreadId, "b");
  });
});

describe("holding a dropped Shelf order", () => {
  const dropped = ["b", "a", "c"];

  it("shows the dropped order while the request is pending", () => {
    assert.equal(heldShelfOrder({ order: dropped, settled: null }, ["a", "b", "c"]), dropped);
  });

  it("keeps showing it after success until the server order arrives", () => {
    const hold = { order: dropped, settled: ["a", "b", "c"] };

    assert.equal(heldShelfOrder(hold, ["a", "b", "c"]), dropped);
    assert.equal(heldShelfOrder(hold, ["b", "a", "c"]), null);
    assert.equal(heldShelfOrder(hold, ["c", "a", "b"]), null);
    assert.equal(heldShelfOrder(hold, ["a", "c"]), null);
  });

  it("releases at once when the server order already arrived", () => {
    assert.equal(heldShelfOrder({ order: dropped, settled: dropped }, dropped), null);
  });

  it("reads the live order of the held chats from their keys", () => {
    const threads = [
      shelved("a", "a"),
      shelved("b", "b"),
      shelved("c", "c"),
      chat("unshelved", "open", { shelfSortKey: null }),
    ];

    assert.deepEqual(liveShelfOrder(threads, ["c", "unshelved", "a"]), ["a", "c"]);
  });

  it("moves only the held chats and leaves other projects' Shelf chats in place", () => {
    const tree = buildTree([
      shelved("a", "a"),
      shelved("x", "b", 100, { projectId: "other" }),
      shelved("b", "c"),
      shelved("y", "d", 100, { projectId: "other" }),
      shelved("c", "e"),
    ]);

    assert.deepEqual(ids(inHeldOrder(tree.shelf, ["c", "a", "b"])), ["c", "x", "a", "y", "b"]);
    assert.equal(inHeldOrder(tree.shelf, null), tree.shelf);
  });
});

describe("Inbox Shelf order", () => {
  it("follows the sidebar Shelf, groups sub-chats with their root and puts unknown chats last", () => {
    const tree = buildTree([
      shelved("second", "b"),
      shelved("first", "a"),
      shelved("kid", "b", 100, { parentThreadId: "second" }),
    ]);

    const entries = ["unknown-1", "kid", "first", "unknown-2", "second"].map((threadId) => ({
      threadId,
    }));

    assert.deepEqual(
      inShelfOrder(entries, tree.shelf, (entry) => entry.threadId).map((entry) => entry.threadId),
      ["first", "kid", "second", "unknown-1", "unknown-2"],
    );
  });
});
