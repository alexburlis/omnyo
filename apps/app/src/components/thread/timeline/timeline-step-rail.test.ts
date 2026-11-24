import { describe, expect, it } from "vitest";
import { timelineStepRails, type TimelineStepLink } from "./timeline-step-rail";

const head: TimelineStepLink = { kind: "head", continuesTurn: true };

const work: TimelineStepLink = {
  kind: "work",
  continuesTurn: true,
  state: "idle",
};

const other: TimelineStepLink = { kind: "other" };

describe("timelineStepRails", () => {
  it("groups each message with the work that follows it and runs the line between dots", () => {
    expect(
      timelineStepRails([other, head, work, work, head, work, head]),
    ).toEqual([
      null,
      {
        role: "head",
        line: "from-dot",
        startsRun: true,
        hasWork: true,
        state: "idle",
      },
      { role: "work", line: "through", followsHead: true },
      { role: "work", line: "through", followsHead: false },
      {
        role: "head",
        line: "through",
        startsRun: false,
        hasWork: true,
        state: "idle",
      },
      { role: "work", line: "through", followsHead: true },
      {
        role: "head",
        line: "to-dot",
        startsRun: false,
        hasWork: false,
        state: "idle",
      },
    ]);
  });

  it("leaves work before the first message on the classic rail", () => {
    expect(timelineStepRails([work, work, head, work])).toEqual([
      null,
      null,
      {
        role: "head",
        line: "none",
        startsRun: true,
        hasWork: true,
        state: "idle",
      },
      { role: "work", line: "none", followsHead: true },
    ]);
  });

  it("colours a step by its strongest work state", () => {
    const rails = timelineStepRails([
      head,
      { ...work, state: "failed" },
      head,
      { ...work, state: "failed" },
      { ...work, state: "running" },
    ]);

    expect(rails[0]).toMatchObject({ role: "head", state: "failed" });
    expect(rails[2]).toMatchObject({ role: "head", state: "running" });
  });

  it("starts a new run at a turn boundary", () => {
    const rails = timelineStepRails([
      head,
      work,
      { kind: "head", continuesTurn: false },
      { kind: "work", continuesTurn: false, state: "idle" },
    ]);

    expect(rails[0]).toMatchObject({ line: "none", startsRun: true });
    expect(rails[2]).toMatchObject({ line: "none", startsRun: true });
    expect(rails[3]).toBeNull();
  });
});
