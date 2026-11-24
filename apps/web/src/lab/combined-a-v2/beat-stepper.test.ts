import { describe, expect, it } from "vitest";

import {
  carriesOver,
  catchTarget,
  createGestureClock,
  insideTrack,
  isNotch,
  nearestBeat,
  onPin,
  plan,
  rebaseFlick,
  stopsFor,
  touchPlan,
  type Track,
  wheelDelta,
} from "./beat-stepper";

const stops = stopsFor(1000, 1000, 6, 0.1);

const track: Track = {
  stops,
  enterBelow: 600,
  enterAbove: 2400,
  pinStart: 1000,
  pinEnd: 2000,
};

const fresh = (events: readonly (readonly [number, number])[]) => {
  const clock = createGestureClock();

  return events.flatMap(([delta, time], index) =>
    clock(delta, time) ? [index] : [],
  );
};

const momentum = (from: number, to: number, count: number, start = 0) =>
  Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);

    return [from * (to / from) ** t, start + index * 20] as const;
  });

describe("stopsFor", () => {
  it("spaces the stops evenly inside the edges of the pinned travel", () => {
    expect(stops).toEqual([1100, 1260, 1420, 1580, 1740, 1900]);
  });
});

describe("nearestBeat", () => {
  it("clamps positions outside the section to the first and last beat", () => {
    expect(nearestBeat(0, stops)).toBe(0);
    expect(nearestBeat(1330, stops)).toBe(1);
    expect(nearestBeat(5000, stops)).toBe(5);
  });
});

describe("insideTrack", () => {
  it("accepts positions between the first and last stop within tolerance", () => {
    expect(insideTrack(1095, stops)).toBe(true);
    expect(insideTrack(1500, stops)).toBe(true);
    expect(insideTrack(1905, stops)).toBe(true);
    expect(insideTrack(1080, stops)).toBe(false);
    expect(insideTrack(1920, stops)).toBe(false);
    expect(insideTrack(1500, [])).toBe(false);
  });
});

describe("onPin", () => {
  it("covers the whole pinned range, including the bands outside the stops", () => {
    expect(onPin(995, track)).toBe(true);
    expect(onPin(1040, track)).toBe(true);
    expect(onPin(1960, track)).toBe(true);
    expect(onPin(2005, track)).toBe(true);
    expect(onPin(985, track)).toBe(false);
    expect(onPin(2015, track)).toBe(false);
    expect(onPin(1500, { ...track, stops: [] })).toBe(false);
  });
});

describe("touchPlan", () => {
  it("steps past the end beat already on screen from the pinned bands", () => {
    expect(touchPlan(1040, 60, track)).toEqual({ kind: "step", beat: 1 });
    expect(touchPlan(1960, -60, track)).toEqual({ kind: "step", beat: 4 });
  });

  it("keeps plan's moves everywhere else", () => {
    expect(touchPlan(560, 60, track)).toEqual({ kind: "enter", beat: 0 });
    expect(touchPlan(1040, -60, track)).toEqual({ kind: "pass" });
    expect(touchPlan(1260, 120, track)).toEqual({ kind: "step", beat: 2 });
    expect(touchPlan(1900, 50, track)).toEqual({ kind: "release" });
  });
});

describe("catchTarget", () => {
  const down = (origin: number, release: number) => ({
    origin,
    release,
    heading: 1,
  });

  const up = (origin: number, release: number) => ({
    origin,
    release,
    heading: -1,
  });

  it("catches a flick from above at the first beat once it reaches the story", () => {
    expect(catchTarget(980, down(400, 700), track)).toBeNull();
    expect(catchTarget(1004, down(400, 700), track)).toBe(0);
    expect(catchTarget(1500, down(400, 700), track)).toBe(0);
  });

  it("lands on the first beat even when the finger dragged past it", () => {
    expect(catchTarget(1200, down(970, 1198), track)).toBe(0);
    expect(catchTarget(1310, down(900, 1300), track)).toBe(0);
    expect(catchTarget(1900, down(400, 1880), track)).toBe(0);
  });

  it("leaves a drag that carried the page through the whole story", () => {
    expect(catchTarget(2050, down(900, 2050), track)).toBeNull();
    expect(catchTarget(950, up(2100, 950), track)).toBeNull();
  });

  it("catches a flick from below at the last beat once it reaches the story", () => {
    expect(catchTarget(2020, up(2600, 2300), track)).toBeNull();
    expect(catchTarget(1996, up(2600, 2300), track)).toBe(5);
    expect(catchTarget(1800, up(2030, 1802), track)).toBe(5);
    expect(catchTarget(1690, up(2100, 1700), track)).toBe(5);
    expect(catchTarget(1120, up(2600, 1110), track)).toBe(5);
  });

  it("moves one beat ahead for flicks that started on the story", () => {
    expect(catchTarget(1300, down(1260, 1262), track)).toBe(2);
    expect(catchTarget(1200, up(1260, 1258), track)).toBe(0);
  });

  it("lets flicks leave the story and ignores taps and distant flicks", () => {
    expect(catchTarget(1950, down(1900, 1902), track)).toBeNull();
    expect(catchTarget(1050, up(1100, 1098), track)).toBeNull();
    expect(catchTarget(500, down(300, 400), track)).toBeNull();
    expect(
      catchTarget(1004, { origin: 400, release: 400, heading: 0 }, track),
    ).toBeNull();
    expect(
      catchTarget(1004, down(400, 700), { ...track, stops: [] }),
    ).toBeNull();
  });
});

describe("rebaseFlick", () => {
  const moved: Track = { ...track, pinStart: 500, pinEnd: 1000 };

  it("keeps a flick heading for the story aimed at its new edges", () => {
    expect(
      rebaseFlick({ origin: 300, release: 700, heading: 1 }, track, moved),
    ).toEqual({ origin: 491, release: 491, heading: 1 });
    expect(
      rebaseFlick({ origin: 2600, release: 2300, heading: -1 }, track, moved),
    ).toEqual({ origin: 1009, release: 1009, heading: -1 });
  });

  it("drops flicks that already reached or started on the story", () => {
    expect(
      rebaseFlick({ origin: 900, release: 1200, heading: 1 }, track, moved),
    ).toBeNull();
    expect(
      rebaseFlick({ origin: 1300, release: 1500, heading: 1 }, track, moved),
    ).toBeNull();
    expect(
      rebaseFlick({ origin: 300, release: 700, heading: -1 }, track, moved),
    ).toBeNull();
  });
});

describe("plan", () => {
  it("steps one beat in the gesture's direction from a stop", () => {
    expect(plan(1260, 120, track)).toEqual({ kind: "step", beat: 2 });
    expect(plan(1260, -3, track)).toEqual({ kind: "step", beat: 0 });
  });

  it("steps to the next stop ahead when resting between stops", () => {
    expect(plan(1300, 40, track)).toEqual({ kind: "step", beat: 2 });
    expect(plan(1300, -40, track)).toEqual({ kind: "step", beat: 1 });
  });

  it("releases control past the first and last beat", () => {
    expect(plan(1900, 50, track)).toEqual({ kind: "release" });
    expect(plan(1101, -50, track)).toEqual({ kind: "release" });
  });

  it("enters on the first beat from above and the last beat from below", () => {
    expect(plan(560, 60, track)).toEqual({ kind: "enter", beat: 0 });
    expect(plan(2450, -60, track)).toEqual({ kind: "enter", beat: 5 });
  });

  it("steps onto the nearest end beat from the pinned bands outside the stops", () => {
    expect(plan(1040, 60, track)).toEqual({ kind: "enter", beat: 0 });
    expect(plan(1040, -60, track)).toEqual({ kind: "pass" });
    expect(plan(1960, -60, track)).toEqual({ kind: "enter", beat: 5 });
    expect(plan(1960, 60, track)).toEqual({ kind: "pass" });
  });

  it("leaves scrolling alone away from the section or heading away", () => {
    expect(plan(400, 100, track)).toEqual({ kind: "pass" });
    expect(plan(900, -100, track)).toEqual({ kind: "pass" });
    expect(plan(2000, 100, track)).toEqual({ kind: "pass" });
    expect(plan(2600, -100, track)).toEqual({ kind: "pass" });
  });

  it("does nothing without stops", () => {
    expect(
      plan(100, 10, {
        stops: [],
        enterBelow: 0,
        enterAbove: 0,
        pinStart: 0,
        pinEnd: 0,
      }),
    ).toEqual({
      kind: "pass",
    });
  });
});

describe("wheelDelta", () => {
  it("converts line and page deltas to pixels", () => {
    expect(wheelDelta(3, 1, 900)).toBe(48);
    expect(wheelDelta(1, 2, 900)).toBe(900);
    expect(wheelDelta(53, 0, 900)).toBe(53);
  });
});

describe("carriesOver", () => {
  it("keeps adding slow small same-direction wheel deltas", () => {
    expect(carriesOver(2, 2, 300)).toBe(true);
    expect(carriesOver(-5, -3, 900)).toBe(true);
  });

  it("starts over after a long pause, a reversal or a completed step", () => {
    expect(carriesOver(2, 2, 1200)).toBe(false);
    expect(carriesOver(2, -2, 300)).toBe(false);
    expect(carriesOver(0, 2, 300)).toBe(false);
    expect(carriesOver(12, 2, 300)).toBe(false);
  });
});

describe("isNotch", () => {
  it("recognizes a spaced mouse-wheel notch but not a trackpad stream", () => {
    expect(isNotch(100, 130)).toBe(true);
    expect(isNotch(-100, 150)).toBe(true);
    expect(isNotch(100, 16)).toBe(false);
    expect(isNotch(12, 300)).toBe(false);
  });
});

describe("createGestureClock", () => {
  it("names why a gesture opened", () => {
    const clock = createGestureClock();

    expect(clock(40, 0)).toBe("gap");
    expect(clock(30, 16)).toBeNull();
    expect(clock(-20, 32)).toBe("turn");
    expect(clock(-20, 400)).toBe("gap");
  });

  it("treats a trackpad swipe and its momentum tail as one gesture", () => {
    const ramp = [4, 18, 60, 120].map((delta, index) => [delta, index * 16]);
    const tail = momentum(118, 2, 30, 64);

    expect(fresh([...ramp, ...tail] as [number, number][])).toEqual([0]);
  });

  it("starts a new gesture after a quiet gap", () => {
    expect(
      fresh([...momentum(100, 2, 20), ...momentum(100, 2, 20, 20 * 19 + 260)]),
    ).toEqual([0, 20]);
  });

  it("starts a new gesture when deltas grow again after decaying", () => {
    const tail = momentum(120, 3, 25);

    const next = [6, 16, 34, 70].map(
      (delta, index) => [delta, 25 * 20 + index * 16] as const,
    );

    expect(fresh([...tail, ...next])).toEqual([0, 28]);
  });

  it("ignores a single coalesced spike in a decaying tail", () => {
    const events: [number, number][] = [
      [80, 0],
      [40, 16],
      [12, 32],
      [6, 48],
      [5, 64],
      [24, 80],
      [4, 96],
      [3, 112],
    ];

    expect(fresh(events)).toEqual([0]);
  });

  it("starts a new gesture when the direction reverses", () => {
    expect(
      fresh([
        [40, 0],
        [30, 16],
        [-20, 32],
        [-30, 48],
      ]),
    ).toEqual([0, 2]);
  });

  it("counts each spaced mouse-wheel notch as its own gesture", () => {
    expect(
      fresh([
        [100, 0],
        [100, 400],
        [100, 800],
      ]),
    ).toEqual([0, 1, 2]);
  });
});
