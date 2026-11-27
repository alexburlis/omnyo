import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InboxEntry } from "../lib/inbox.ts";
import {
  CHANGE_GUARD_MS,
  arrangeInbox,
  cardChanges,
  recentlyChanged,
  revealAbove,
  shownCards,
  orderInboxStatusRows,
  type ArrangeInput,
  type InboxLayout,
} from "../lib/inbox-layout.ts";
import { OK, card, cause, entry, question } from "./inbox-fixtures.ts";

const FREE: ArrangeInput = { focus: null, scrolledPast: false };

function on(threadId: string, scrolledPast = true): ArrangeInput {
  return { focus: { kind: "card", threadId }, scrolledPast };
}

function ids(layout: InboxLayout): string[] {
  return [...layout.order];
}

function lay(live: readonly InboxEntry[], ...steps: [readonly InboxEntry[], ArrangeInput][]) {
  let layout = arrangeInbox(null, live, FREE);

  for (const [next, input] of steps) layout = arrangeInbox(layout, next, input);

  return layout;
}

describe("Inbox order", () => {
  it("shows the server order on first layout and after every change", () => {
    const first = [entry("a"), entry("b"), entry("c")];
    const reordered = [entry("c"), entry("a"), entry("d"), entry("b")];

    assert.deepEqual(ids(lay(first)), ["a", "b", "c"]);
    assert.deepEqual(ids(lay(first, [reordered, FREE])), ["c", "a", "d", "b"]);
  });

  it("moves cards at once while the cursor is on one", () => {
    const first = [entry("a"), entry("b"), entry("c")];
    const reordered = [entry("c"), entry("a"), entry("d"), entry("b")];

    assert.deepEqual(ids(lay(first, [first, on("b")], [reordered, on("b")])), ["c", "a", "d", "b"]);
  });

  it("shows a question that arrives above the cursor at once and flags it until revealed", () => {
    const first = [entry("q1", { card: question("x") }), entry("a"), entry("b")];

    const arrived = [
      entry("q1", { card: question("x") }),
      entry("q2", { card: question("y") }),
      ...first.slice(1),
    ];

    const layout = lay(first, [first, on("b")], [arrived, on("b")]);

    assert.deepEqual(ids(layout), ["q1", "q2", "a", "b"]);
    assert.deepEqual([...layout.above], ["q2"]);

    const shown = revealAbove(layout);

    assert.deepEqual(ids(shown.layout), ["q1", "q2", "a", "b"]);
    assert.equal(shown.first, "q2");
    assert.equal(shown.layout.above.size, 0);
  });

  it("puts a new question with the others when nothing is focused, without a pill", () => {
    const first = [entry("q1", { card: question("x") }), entry("a")];

    const arrived = [
      entry("q1", { card: question("x") }),
      entry("q2", { card: question("y") }),
      entry("a"),
    ];

    const layout = lay(first, [arrived, { focus: null, scrolledPast: true }]);

    assert.deepEqual(ids(layout), ["q1", "q2", "a"]);
    assert.equal(layout.above.size, 0);
  });

  it("counts a question above the cursor until the cursor reaches it", () => {
    const first = [entry("a"), entry("b")];
    const arrived = [entry("q", { card: question("x") }), entry("a"), entry("b")];
    const layout = lay(first, [first, on("b")], [arrived, on("b")]);

    assert.deepEqual(ids(layout), ["q", "a", "b"]);
    assert.deepEqual([...layout.above], ["q"]);
    assert.equal(arrangeInbox(layout, arrived, on("q")).above.size, 0);
  });

  it("shows a question in place without a pill while its slot is in view", () => {
    const first = [entry("a"), entry("b")];
    const arrived = [entry("q", { card: question("x") }), entry("a"), entry("b")];
    const layout = lay(first, [first, on("a", false)], [arrived, on("a", false)]);

    assert.deepEqual(ids(layout), ["q", "a", "b"]);
    assert.equal(layout.above.size, 0);
  });

  it("drops the pill for a question above the cursor once its slot is in view", () => {
    const first = [entry("a"), entry("b")];
    const arrived = [entry("q", { card: question("x") }), entry("a"), entry("b")];
    const layout = lay(first, [first, on("b")], [arrived, on("b")]);

    assert.deepEqual([...layout.above], ["q"]);
    assert.equal(arrangeInbox(layout, arrived, on("b", false)).above.size, 0);
  });
});

describe("Inbox live cards", () => {
  const before = entry("a", { card: card(OK, { causes: [cause("r1")] }) });

  const after = entry("a", {
    card: card({ kind: "archive" }, { causes: [cause("r1"), cause("r2")] }),
  });

  it("shows the focused card's current content as soon as it changes", () => {
    const layout = lay(
      [before, entry("b")],
      [[before, entry("b")], on("a")],
      [[after, entry("b")], on("a")],
    );

    const [focused] = shownCards(layout, [after, entry("b")]);

    assert.equal(focused?.entry, after);
  });

  it("drops a focused card that left the Inbox at once", () => {
    const layout = lay(
      [before, entry("b"), entry("c")],
      [[before, entry("b"), entry("c")], on("a")],
      [[entry("b")], on("a")],
    );

    assert.deepEqual(ids(layout), ["b"]);
    assert.deepEqual(
      shownCards(layout, [entry("b")]).map((shown) => shown.entry.threadId),
      ["b"],
    );
  });

  it("reports only existing cards whose content changed", () => {
    const seen = new Map([
      ["a", before.latch],
      ["b", entry("b").latch],
    ]);

    assert.deepEqual(cardChanges(null, [after]), []);
    assert.deepEqual(cardChanges(seen, [after, entry("b"), entry("c")]), ["a"]);
  });

  it("ignores the primary action only within the guard after a change", () => {
    const changes = new Map([["a", 10_000]]);

    assert.equal(recentlyChanged(changes, "a", 10_000 + CHANGE_GUARD_MS - 1), true);
    assert.equal(recentlyChanged(changes, "a", 10_000 + CHANGE_GUARD_MS), false);
    assert.equal(recentlyChanged(changes, "b", 10_000), false);
  });

  it("returns the same layout for the same snapshot, so rendering stays stable", () => {
    const live = [before, entry("b")];
    const layout = lay(live, [live, on("a")]);

    assert.equal(arrangeInbox(layout, live, on("a")), layout);
    assert.equal(arrangeInbox(layout, live, on("a", false)), layout);
  });
});

describe("Inbox status group order", () => {
  it("puts each newcomer first, even if its chat is older than the existing rows", () => {
    const ready = (id: string, at: number) => ({ id, group: "ready", at });
    const oldChat = { id: "old-chat", group: "finished", at: 10 };
    const existing = [ready("older-ready", 20), ready("newer-ready", 30)];
    const start = orderInboxStatusRows(null, [oldChat, ...existing]);

    assert.deepEqual(start.get("ready"), ["newer-ready", "older-ready"]);

    const completed = orderInboxStatusRows(start, [ready(oldChat.id, oldChat.at), ...existing]);
    assert.deepEqual(completed.get("ready"), ["old-chat", "newer-ready", "older-ready"]);

    const later = orderInboxStatusRows(completed, [
      ...existing,
      ready(oldChat.id, oldChat.at),
      ready("arrived-later", 5),
    ]);

    assert.deepEqual(later.get("ready"), [
      "arrived-later",
      "old-chat",
      "newer-ready",
      "older-ready",
    ]);
  });
});
