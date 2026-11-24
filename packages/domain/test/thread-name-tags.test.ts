import { describe, expect, it } from "vitest";
import { threadScope } from "../src/thread-event-scope.js";
import type { ThreadEvent } from "../src/provider-event.js";
import {
  fromProviderExternalThreadName,
  normalizeProviderThreadNameEvent,
  toProviderExternalThreadName,
} from "../src/thread-name-tags.js";

describe("thread name tags", () => {
  it("round-trips user-provided literal bb-prefixed titles", () => {
    const providerName = toProviderExternalThreadName("[bb] Literal");

    expect(providerName).toBe("[omnyo] [bb] Literal");
    expect(fromProviderExternalThreadName(providerName)).toBe("[bb] Literal");
  });

  it("imports one exact historical tag and preserves literal title text", () => {
    expect(fromProviderExternalThreadName("[bb] [bb] Literal")).toBe(
      "[bb] Literal",
    );
    expect(fromProviderExternalThreadName("User [bb] literal")).toBe(
      "User [bb] literal",
    );
    expect(fromProviderExternalThreadName("[omnyo] [omnyo] Literal")).toBe(
      "[omnyo] Literal",
    );
  });

  it("normalizes provider title events by stripping one omnyo tag", () => {
    const event = {
      type: "thread/name/updated",
      threadId: "t1",
      providerThreadId: "p1",
      scope: threadScope(),
      threadName: toProviderExternalThreadName("[bb] Literal"),
    } satisfies ThreadEvent;

    expect(normalizeProviderThreadNameEvent(event)).toEqual({
      ...event,
      threadName: "[bb] Literal",
    });
  });
});
