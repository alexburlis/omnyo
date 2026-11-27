import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTree } from "../lib/grouping.ts";
import {
  expandedThreads,
  revealedAncestors,
  toggledChoices,
  withoutCollapsed,
} from "../lib/subchat-expansion.ts";
import { chat } from "./work-fixtures.ts";

const tree = buildTree([
  chat("mother", "open", { createdAt: 1 }),
  chat("child", "open", { parentThreadId: "mother", createdAt: 2 }),
  chat("grandchild", "open", { parentThreadId: "child", createdAt: 3 }),
  chat("other", "open", { createdAt: 4 }),
  chat("other-child", "open", { parentThreadId: "other", createdAt: 5 }),
]);

describe("subchat expansion", () => {
  it("keeps a mother chat collapsed when the mother itself is open", () => {
    assert.deepEqual([...expandedThreads(tree, revealedAncestors(tree, "mother"), {})], []);
  });

  it("reveals every ancestor of an open subchat", () => {
    assert.deepEqual([...expandedThreads(tree, revealedAncestors(tree, "grandchild"), {})].sort(), [
      "child",
      "mother",
    ]);
  });

  it("lets a stored choice override the revealed default either way", () => {
    const revealed = revealedAncestors(tree, "grandchild");
    const stored = toggledChoices(toggledChoices({}, "mother", true), "other", false);

    assert.deepEqual([...expandedThreads(tree, revealed, stored)].sort(), ["child", "other"]);
  });

  it("ignores stored choices for chats without subchats", () => {
    assert.deepEqual([...expandedThreads(tree, new Set(), { "other-child": true })], []);
  });

  it("drops only collapsed choices on the path to a newly opened subchat", () => {
    const stored = { mother: false, child: true, other: false };

    assert.deepEqual(withoutCollapsed(stored, revealedAncestors(tree, "grandchild")), {
      child: true,
      other: false,
    });
    assert.equal(withoutCollapsed(stored, new Set(["child"])), stored);
  });

  it("keeps the newest choices within its bound", () => {
    let stored: Record<string, boolean> = {};

    for (let index = 0; index < 305; index += 1)
      stored = toggledChoices(stored, `chat-${index}`, false);
    stored = toggledChoices(stored, "chat-10", true);

    const keys = Object.keys(stored);

    assert.equal(keys.length, 300);
    assert.equal(keys.at(-1), "chat-10");
    assert.equal(stored["chat-10"], false);
    assert.equal("chat-4" in stored, false);
  });
});
