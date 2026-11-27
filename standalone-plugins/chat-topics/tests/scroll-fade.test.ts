import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scrollFadeEdges } from "../lib/scroll-fade.ts";

const view = { clientHeight: 400, scrollHeight: 1000 };

describe("sidebar scroll fades", () => {
  it("shows no fade when the content fits or overflows by a rounding sliver", () => {
    assert.deepEqual(scrollFadeEdges({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 }), {
      top: false,
      bottom: false,
    });
    assert.deepEqual(scrollFadeEdges({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }), {
      top: false,
      bottom: false,
    });
    assert.deepEqual(scrollFadeEdges({ scrollTop: 2, scrollHeight: 402, clientHeight: 400 }), {
      top: false,
      bottom: false,
    });
  });

  it("fades only the edge that has content behind it", () => {
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: 0 }), { top: false, bottom: true });
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: 300 }), { top: true, bottom: true });
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: 600 }), { top: true, bottom: false });
  });

  it("treats positions within two pixels of an end as that end", () => {
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: 1.5 }), { top: false, bottom: true });
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: 599.5 }), { top: true, bottom: false });
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: 2.5 }), { top: true, bottom: true });
  });

  it("keeps the far edge faded while elastic scrolling overshoots an end", () => {
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: -40 }), { top: false, bottom: true });
    assert.deepEqual(scrollFadeEdges({ ...view, scrollTop: 640 }), { top: true, bottom: false });
  });
});
