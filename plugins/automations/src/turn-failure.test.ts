import { makeTurnFailedEvent } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { isTransientTurnFailure } from "./turn-failure.js";

describe("isTransientTurnFailure", () => {
  it.each([
    ["overloaded", null, true],
    ["rate-limit", 429, true],
    ["stream-disconnected", null, true],
    ["stream-disconnected", 502, true],
    ["connection-failed", 503, true],
    ["connection-failed", 408, true],
    ["connection-failed", 499, true],
    ["connection-failed", 401, false],
    ["internal", 500, true],
    ["internal", 400, false],
    ["internal", null, false],
    ["unauthorized", 401, false],
    ["billing", 402, false],
    ["policy", null, false],
    ["unknown", null, false],
  ] as const)(
    "treats %s with status %s as transient: %s",
    (category, httpStatusCode, transient) => {
      const failure = makeTurnFailedEvent({
        errorInfo: { category, providerCode: null, httpStatusCode },
      });

      expect(isTransientTurnFailure(failure)).toBe(transient);
    },
  );

  it("treats a failure without structured error info as persistent", () => {
    expect(isTransientTurnFailure(makeTurnFailedEvent())).toBe(false);
  });
});
