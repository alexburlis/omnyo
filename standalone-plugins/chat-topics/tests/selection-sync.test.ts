import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adoptsHostClear, orderedSelection, sameSelection } from "../lib/selection-sync.ts";

describe("publishing the list selection to Omnyo", () => {
  it("publishes selected chats in display order, then any that scrolled out", () => {
    assert.deepEqual(orderedSelection(new Set(["c", "z", "a"]), ["a", "b", "c"]), ["a", "c", "z"]);
  });

  it("publishes nothing when the selection is cleared", () => {
    assert.deepEqual(orderedSelection(null, ["a", "b"]), []);
  });

  it("skips writes that repeat the last published selection", () => {
    assert.equal(sameSelection(["a", "b"], ["a", "b"]), true);
    assert.equal(sameSelection(["a", "b"], ["b", "a"]), false);
    assert.equal(sameSelection([], []), true);
  });

  it("adopts a clear Omnyo made to the selection the list published", () => {
    assert.equal(adoptsHostClear(["a", "b"], [], ["a", "b"]), true);
    assert.equal(adoptsHostClear(["b", "a"], [], ["a", "b"]), true);
  });

  it("ignores stale echoes and unchanged or non-empty host selections", () => {
    assert.equal(adoptsHostClear(["a"], [], ["a", "c"]), false);
    assert.equal(adoptsHostClear([], [], ["a"]), false);
    assert.equal(adoptsHostClear(["a"], ["a"], ["a"]), false);
    assert.equal(adoptsHostClear(["a"], [], []), false);
  });
});
