import { describe, expect, it } from "vitest";
import {
  groupEventProjectionTurns,
  MissingProjectionTurnStartedError,
} from "../src/group-event-projection-turns.js";
import { buildEventProjection } from "../src/build-event-projection.js";
import {
  createTimelineEventFactory,
  fromRows,
} from "./timeline-test-harness.js";

describe("missing timeline turn starts", () => {
  it("rejects a completion whose start is absent", () => {
    const factory = createTimelineEventFactory({
      threadId: "private-thread",
      turnId: "private-turn",
    });

    let failure: unknown;

    try {
      groupEventProjectionTurns({
        delegatedTurnIds: new Set(),
        events: fromRows([factory.turnCompleted({ seq: 20 })]),
        messages: [],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      diagnostic: {
        operation: "timeline-read",
        reason: "missing-turn-start",
        source: "turn/completed",
        projectionEventCount: 1,
        projectionMessageCount: 0,
        projectionStartSequence: 20,
        projectionEndSequence: 20,
        failureSequence: 20,
        turnEventCount: 1,
        turnStartCount: 0,
        eventsOrdered: true,
        storedStart: "unknown",
      },
    });
    expect(failure).toBeInstanceOf(MissingProjectionTurnStartedError);

    if (!(failure instanceof Error))
      throw new Error("Expected projection failure");
    expect(failure.message).not.toContain("private-");
    expect(failure.stack).toContain("groupEventProjectionTurns");
  });

  it("distinguishes a start present later in unordered input", () => {
    const factory = createTimelineEventFactory({
      threadId: "thread",
      turnId: "turn",
    });

    const events = fromRows([
      factory.turnCompleted({ seq: 20 }),
      factory.turnStarted({ seq: 10 }),
    ]);

    let failure: unknown;

    try {
      groupEventProjectionTurns({
        delegatedTurnIds: new Set(),
        events,
        messages: [],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      diagnostic: {
        turnStartCount: 1,
        eventsOrdered: false,
        projectionStartSequence: 10,
      },
    });
    expect(() =>
      buildEventProjection(events, {
        threadName: "thread",
        turnMessageDetail: "full",
      }),
    ).not.toThrow();
  });
});
