import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isScrolledPast } from "../lib/scrolled-past.ts";

describe("Inbox question slot visibility", () => {
  it("counts a slot below the sticky toolbar as in view at the top of the list", () => {
    assert.equal(isScrolledPast({ slotTop: 140, viewTop: 100, inset: 40 }), false);
    assert.equal(isScrolledPast({ slotTop: 100, viewTop: 100, inset: 0 }), false);
  });

  it("counts a slot hidden under the toolbar or above the list as scrolled past", () => {
    assert.equal(isScrolledPast({ slotTop: 120, viewTop: 100, inset: 40 }), true);
    assert.equal(isScrolledPast({ slotTop: -300, viewTop: 100, inset: 0 }), true);
  });

  it("ignores only a sub-pixel rounding sliver at the edge", () => {
    assert.equal(isScrolledPast({ slotTop: 139.6, viewTop: 100, inset: 40 }), false);
    assert.equal(isScrolledPast({ slotTop: 139, viewTop: 100, inset: 40 }), true);
  });
});
