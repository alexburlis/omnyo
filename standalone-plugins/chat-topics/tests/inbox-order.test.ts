import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INBOX_SECTION_KEYS,
  isDefaultSections,
  moveInboxSection,
  moveSection,
  normalizeHidden,
  normalizeOrder,
  resetInboxSections,
  setInboxShowEmpty,
  shownSections,
  stepSection,
} from "../lib/inbox-order.ts";

describe("inbox section order", () => {
  it("starts from the default order", () => {
    assert.deepEqual(normalizeOrder([]), [...INBOX_SECTION_KEYS]);
  });

  it("keeps a saved order, drops unknown and duplicate keys, and appends new sections", () => {
    assert.deepEqual(normalizeOrder(["run", "ready", "gone", "run", "need"]), [
      "run",
      "ready",
      "need",
      "failed",
      "finished",
      "waiting",
      "shelf",
    ]);
  });

  it("drops Ready to archive below Running", () => {
    assert.deepEqual(moveSection(INBOX_SECTION_KEYS, "ready", "run", "after"), [
      "need",
      "failed",
      "finished",
      "run",
      "ready",
      "waiting",
      "shelf",
    ]);
  });

  it("moves a section above another, including to the top", () => {
    assert.deepEqual(moveSection(INBOX_SECTION_KEYS, "shelf", "need", "before"), [
      "shelf",
      "need",
      "failed",
      "finished",
      "ready",
      "run",
      "waiting",
    ]);
  });

  it("leaves the order unchanged when dropped on itself", () => {
    assert.deepEqual(moveSection(INBOX_SECTION_KEYS, "run", "run", "before"), [
      ...INBOX_SECTION_KEYS,
    ]);
  });

  it("steps a section one place and stops at either end", () => {
    assert.deepEqual(stepSection(INBOX_SECTION_KEYS, "run", -1), [
      "need",
      "failed",
      "finished",
      "run",
      "ready",
      "waiting",
      "shelf",
    ]);
    assert.deepEqual(stepSection(INBOX_SECTION_KEYS, "need", -1), [...INBOX_SECTION_KEYS]);
    assert.deepEqual(stepSection(INBOX_SECTION_KEYS, "shelf", 1), [...INBOX_SECTION_KEYS]);
  });
});

describe("inbox section visibility", () => {
  it("never hides Needs you and ignores unknown keys", () => {
    assert.deepEqual([...normalizeHidden(["need", "ready", "gone"])], ["ready"]);
  });

  it("shows every section except the hidden ones, in order", () => {
    assert.deepEqual(
      shownSections({
        order: ["run", "need", "ready", "waiting", "shelf"],
        hidden: new Set(["ready", "shelf"]),
        showEmpty: false,
      }),
      ["run", "need", "waiting"],
    );
  });

  it("treats only the original layout as the default", () => {
    const defaults = { order: [...INBOX_SECTION_KEYS], hidden: new Set<never>(), showEmpty: false };

    assert.equal(isDefaultSections(defaults), true);
    assert.equal(isDefaultSections({ ...defaults, showEmpty: true }), false);
    assert.equal(isDefaultSections({ ...defaults, hidden: new Set(["shelf"] as const) }), false);
  });
});

describe("inbox section storage", () => {
  it("stores only the choice the owner changed, so later defaults still apply", () => {
    const stored = new Map<string, string>();

    Object.assign(globalThis, {
      window: {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => stored.set(key, value),
          removeItem: (key: string) => stored.delete(key),
        },
      },
    });

    try {
      moveInboxSection("shelf", "need", "before");
      assert.deepEqual([...stored.keys()], ["chat-topics:inbox-order"]);

      setInboxShowEmpty(true);
      assert.equal(stored.get("chat-topics:inbox-empty-sections"), "true");

      resetInboxSections();
      assert.deepEqual([...stored.keys()], []);
    } finally {
      Reflect.deleteProperty(globalThis, "window");
    }
  });
});
