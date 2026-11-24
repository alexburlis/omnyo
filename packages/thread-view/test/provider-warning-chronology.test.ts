import { threadScope, turnScope } from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import {
  createTimelineEventFactory,
  flattenTimelineRows,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

const warningCases = [
  { location: "before the turn", seq: 10, scope: threadScope(), inTurn: false },
  { location: "during the turn", seq: 40, scope: threadScope(), inTurn: true },
  { location: "after the answer", seq: 90, scope: threadScope(), inTurn: true },
  { location: "after the turn", seq: 110, scope: threadScope(), inTurn: false },
  {
    location: "inside turn scope",
    seq: 40,
    scope: turnScope("turn-1"),
    inTurn: true,
  },
  {
    location: "after the answer in turn scope",
    seq: 90,
    scope: turnScope("turn-1"),
    inTurn: true,
  },
];

describe.each(["collapse", "flat"] as const)(
  "%s provider warning chronology",
  (completedTurnDisplay) => {
    describe.each(["general", "config", "deprecation"] as const)(
      "%s warnings",
      (category) => {
        it.each(warningCases)(
          "preserves sequence order for a warning $location",
          ({ seq, scope, inTurn }) => {
            const event = createTimelineEventFactory({
              threadId: "thread-1",
              turnId: "turn-1",
            });

            const warning = event.providerWarning({
              seq,
              category,
              summary: "Provider notice",
            });

            const rendered = renderTimelineFixture({
              completedTurnDisplay,
              events: [
                event.turnStarted({ seq: 20 }),
                { ...warning, scope },
                event.assistantCompleted({ seq: 80, text: "Answer ready" }),
                event.turnCompleted({ seq: 100 }),
              ].sort((left, right) => left.seq - right.seq),
              projectionOptions: {
                threadStatus: "idle",
                turnMessageDetail: "full",
              },
            });

            const messageRows = flattenTimelineRows(rendered.rows).filter(
              (row) => row.kind === "system" || row.kind === "conversation",
            );

            const aboveAnswer =
              seq < 80 || (completedTurnDisplay === "collapse" && inTurn);

            expect(messageRows.map((row) => row.sourceSeqStart)).toEqual(
              aboveAnswer ? [seq, 80] : [80, seq],
            );
          },
        );
      },
    );
  },
);
