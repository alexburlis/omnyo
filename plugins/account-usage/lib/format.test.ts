import { describe, expect, it } from "vitest";
import { formatReset, formatUntil, timeMarkerPercent } from "./format.ts";

const NOW = 1_789_665_000_000;

const WEEK_MINUTES = 10_080;

const WEEK_MS = WEEK_MINUTES * 60_000;

describe("time marker", () => {
  it("sits at the midpoint halfway through the window", () => {
    expect(timeMarkerPercent(NOW + WEEK_MS / 2, WEEK_MINUTES, NOW)).toBe(50);
  });

  it("is on the same remaining axis as the fill, not the elapsed one", () => {
    expect(timeMarkerPercent(NOW + (WEEK_MS * 3) / 4, WEEK_MINUTES, NOW)).toBe(
      75,
    );
  });

  it("clamps a window that is longer or shorter than the reported one", () => {
    expect(timeMarkerPercent(NOW + WEEK_MS * 2, WEEK_MINUTES, NOW)).toBe(100);
    expect(timeMarkerPercent(NOW - 1, WEEK_MINUTES, NOW)).toBe(0);
  });

  it("has no position without a reset time or a window length", () => {
    expect(timeMarkerPercent(null, WEEK_MINUTES, NOW)).toBeNull();
    expect(timeMarkerPercent(NOW + WEEK_MS, null, NOW)).toBeNull();
    expect(timeMarkerPercent(NOW + WEEK_MS, 0, NOW)).toBeNull();
  });
});

describe("reset times", () => {
  it("keeps the sentence form and offers the bare time for compact rows", () => {
    const at = NOW + (4 * 60 + 48) * 60_000;

    expect(formatReset(at, NOW)).toBe("resets in 4h 48m");
    expect(formatUntil(at, NOW)).toEqual({ relative: true, text: "4h 48m" });
    expect(formatReset(NOW + 30_000, NOW)).toBe("resets now");
    expect(formatUntil(NOW + 30_000, NOW)).toEqual({
      relative: false,
      text: "now",
    });
  });

  it("names the day for resets more than a day away", () => {
    const at = NOW + 3 * 24 * 60 * 60_000;

    const day = new Date(at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

    expect(formatReset(at, NOW)).toBe(`resets ${day}`);
    expect(formatUntil(at, NOW)).toEqual({ relative: false, text: day });
  });

  it("has no reset time without a timestamp", () => {
    expect(formatReset(null, NOW)).toBeNull();
    expect(formatUntil(null, NOW)).toBeNull();
  });
});
