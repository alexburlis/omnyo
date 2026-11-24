import { describe, expect, it } from "vitest";

import { describeWeeklyCron } from "./schedule";

describe("describeWeeklyCron", () => {
  it("reads a weekly cron as a weekday and time", () => {
    expect(describeWeeklyCron("0 9 * * 1")).toBe("Mondays at 09:00");
    expect(describeWeeklyCron("30 17 * * 0")).toBe("Sundays at 17:30");
    expect(describeWeeklyCron("5 6 * * 7")).toBe("Sundays at 06:05");
  });

  it("leaves any other schedule to the raw expression", () => {
    expect(describeWeeklyCron("0 9 * * 1-5")).toBeNull();
    expect(describeWeeklyCron("0 9 1 * *")).toBeNull();
    expect(describeWeeklyCron("0 24 * * 1")).toBeNull();
    expect(describeWeeklyCron("61 9 * * 1")).toBeNull();
  });
});
