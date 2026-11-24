import { describe, expect, it } from "vitest";

import {
  DISC_RANGE,
  type DiscTrack,
  discFrames,
  rangeFrames,
  reach,
  trackScale,
} from "./disc-frames";

const vw = 440;

const vh = 956;

const radius = 764;

const tail = vh * 2;

const heroTrack: DiscTrack = {
  start: 1000.4,
  length: vh * 0.62,
  center: (scroll) => ({ x: 220, y: 1300 - scroll }),
};

const pinnedTrack: DiscTrack = {
  start: 3000,
  length: vh * 0.38,
  center: () => ({ x: 220, y: 392 }),
};

const animated = (
  frames: { offset: number; scale: number }[],
  scroll: number,
) => {
  const at = scroll / DISC_RANGE;
  const after = frames.findIndex((frame) => frame.offset >= at);
  const next = frames[after];
  const previous = frames[after - 1];

  if (!next || !previous) return next?.scale ?? 0;
  const mix = (at - previous.offset) / (next.offset - previous.offset);

  return previous.scale + (next.scale - previous.scale) * mix;
};

describe("rangeFrames", () => {
  it.each([
    ["a disc anchored to scrolling content", heroTrack],
    ["a disc in a pinned layer", pinnedTrack],
  ])("keeps the scroll-linked radius of %s within half a pixel", (_, track) => {
    const screen = vh + 90;
    const frames = rangeFrames(discFrames(track, tail, vw, vh, radius, screen));

    expect(frames[0]).toEqual({ offset: 0, scroll: 0, scale: 0 });
    expect(frames.at(-1)?.offset).toBe(1);

    for (let index = 1; index < frames.length; index++) {
      expect(frames[index]?.offset).toBeGreaterThan(
        frames[index - 1]?.offset ?? 1,
      );
    }

    const end = track.start + track.length;

    for (let scroll = 0; scroll <= end + tail + 400; scroll += 0.5) {
      const exact = trackScale(track, scroll, vw, vh, radius);
      const shown = animated(frames, scroll);

      if (scroll <= end) {
        const settled = scroll <= track.start || scroll - track.start >= 0.5;
        expect(Math.abs(shown - exact) * radius).toBeLessThan(
          settled ? 0.5 : 16,
        );
      } else if (scroll >= end + 0.5 && scroll <= end + tail) {
        const { x, y } = track.center(scroll);
        expect(shown * radius).toBeGreaterThanOrEqual(reach(x, y, vw, screen));
      }
    }
  });

  it("starts a disc that begins above the page top already part-grown", () => {
    const track = { ...pinnedTrack, start: -100 };
    const frames = rangeFrames(discFrames(track, tail, vw, vh, radius));

    expect(frames[0]?.offset).toBe(0);
    expect(frames[0]?.scale).toBeCloseTo(
      trackScale(track, 0, vw, vh, radius),
      2,
    );
  });
});
