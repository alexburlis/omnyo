import { describe, expect, it } from "vitest";
import { formatQueueSendCountdown, parseSendAt } from "./send-time.js";

const NOW = Date.parse("2026-08-25T12:00:00Z");

describe("parseSendAt", () => {
  it("resolves every duration unit against the supplied clock", () => {
    expect(parseSendAt("30s", NOW)).toBe(NOW + 30_000);
    expect(parseSendAt("10m", NOW)).toBe(NOW + 600_000);
    expect(parseSendAt("2h", NOW)).toBe(NOW + 7_200_000);
    expect(parseSendAt("7d", NOW)).toBe(NOW + 604_800_000);
  });

  it("accepts fractional durations and surrounding whitespace", () => {
    expect(parseSendAt(" 1.5h ", NOW)).toBe(NOW + 5_400_000);
  });

  it("resolves an absolute ISO timestamp with an explicit offset", () => {
    expect(parseSendAt("2026-08-25T13:30:00Z", NOW)).toBe(
      Date.parse("2026-08-25T13:30:00Z"),
    );
    expect(parseSendAt("2026-08-25 13:30:00Z", NOW)).toBe(
      Date.parse("2026-08-25T13:30:00Z"),
    );
  });

  it("rejects a timestamp that has already passed", () => {
    expect(() => parseSendAt("2026-08-25T11:59:00Z", NOW)).toThrow(
      /must be in the future/,
    );
  });

  it("rejects a zero-length duration", () => {
    expect(() => parseSendAt("0m", NOW)).toThrow(/must be in the future/);
  });

  it("rejects a date with no time of day", () => {
    expect(() => parseSendAt("2026-12-01", NOW)).toThrow(/no time of day/);
  });

  it("rejects values that are neither a timestamp nor a duration", () => {
    expect(() => parseSendAt("10", NOW)).toThrow(/neither a timestamp/);
    expect(() => parseSendAt("tomorrow", NOW)).toThrow(/neither a timestamp/);
    expect(() => parseSendAt("10 minutes", NOW)).toThrow(/neither a timestamp/);
    expect(() => parseSendAt("", NOW)).toThrow(/It is empty/);
  });

  it("rejects a well-formed timestamp that is not a real date", () => {
    expect(() => parseSendAt("2026-13-01T10:00:00Z", NOW)).toThrow(
      /not a real date/,
    );
  });
});

describe("formatQueueSendCountdown", () => {
  it("distinguishes owner-held, pending and overdue timers", () => {
    expect(formatQueueSendCountdown(null, NOW)).toBe("-");
    expect(formatQueueSendCountdown(NOW + 600_000, NOW)).toBe("in 10m");
    expect(formatQueueSendCountdown(NOW - 1, NOW)).toBe("due");
  });
});
