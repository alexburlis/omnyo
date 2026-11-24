// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRowAge, formatThreadAge } from "./ThreadRowAge.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

describe("formatThreadAge", () => {
  it.each([
    [30_000, "now"],
    [MINUTE, "1m"],
    [52 * MINUTE, "52m"],
    [HOUR, "1h"],
    [21 * HOUR, "21h"],
    [DAY, "1d"],
    [5 * DAY, "5d"],
    [7 * DAY, "1w"],
    [29 * DAY, "4w"],
    [30 * DAY, "1mo"],
    [48 * DAY, "1mo"],
    [364 * DAY, "12mo"],
    [400 * DAY, "1y"],
  ])("formats %d ms as %s", (elapsed, expected) => {
    expect(
      formatThreadAge(1_000_000_000_000 - elapsed, 1_000_000_000_000),
    ).toBe(expected);
  });

  it("treats a future timestamp as now", () => {
    expect(formatThreadAge(2_000, 1_000)).toBe("now");
  });
});

describe("ThreadRowAge", () => {
  it("shows when the chat started and advances without a new message", () => {
    const now = 1_000_000_000_000;
    const createdAt = now - 52 * MINUTE;
    vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
    renderSlot({ component: ThreadRowAge }, { createdAt });
    const time = document.querySelector("time[data-sidebar-thread-age]");
    expect(time?.textContent).toBe("52m");
    expect(time?.getAttribute("datetime")).toBe(
      new Date(createdAt).toISOString(),
    );
    expect(time?.getAttribute("title")).toContain("Started");
    act(() => vi.advanceTimersByTime(8 * MINUTE));
    expect(time?.textContent).toBe("1h");
  });
});
