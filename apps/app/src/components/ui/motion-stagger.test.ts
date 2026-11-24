import { describe, expect, it } from "vitest";
import { getStaggerDelayMs, MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";

describe("staggered arrival", () => {
  it("steps small groups by the stagger token", () => {
    expect([0, 1, 2].map((index) => getStaggerDelayMs(index, 3))).toEqual([
      0,
      MOTION_DURATION_MS.stagger,
      MOTION_DURATION_MS.stagger * 2,
    ]);
  });

  it("starts the last item of any group within the fast duration", () => {
    for (const count of [2, 6, 12, 40]) {
      expect(getStaggerDelayMs(count - 1, count)).toBeLessThanOrEqual(
        MOTION_DURATION_MS.fast,
      );
    }
  });

  it("never delays a single item", () => {
    expect(getStaggerDelayMs(0, 1)).toBe(0);
  });
});
