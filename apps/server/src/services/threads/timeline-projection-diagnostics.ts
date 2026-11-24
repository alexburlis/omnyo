import {
  listStoredTurnStartedRowsByTurnIdsUpToSequence,
  type DbConnection,
} from "@omnyo/db";
import { MissingProjectionTurnStartedError } from "@omnyo/thread-view";
import type { TimelineProjectionDiagnosticContext } from "@omnyo/process-utils/error-reporting-privacy";
import { z } from "zod";

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const timelineProjectionDiagnosticSchema = z.object({
  operation: z.literal("timeline-read"),
  stage: z.literal("execute"),
  failureClass: z.literal("internal"),
  outcome: z.literal("terminal"),
  reason: z.literal("missing-turn-start"),
  source: z.enum(["turn/completed", "turn/input/accepted", "message"]),
  projectionEventCount: sequence,
  projectionMessageCount: sequence,
  projectionStartSequence: sequence,
  projectionEndSequence: sequence,
  failureSequence: sequence,
  turnEventCount: sequence,
  turnStartCount: sequence,
  eventsOrdered: z.boolean(),
  storedStart: z.enum([
    "unknown",
    "missing",
    "before-window",
    "in-window",
    "after-failure",
  ]),
  storedStartSequence: sequence.optional(),
});

export function withTimelineProjectionDiagnostics<T>(
  db: DbConnection,
  build: () => T,
): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof MissingProjectionTurnStartedError) {
      const start = listStoredTurnStartedRowsByTurnIdsUpToSequence(db, {
        threadId: error.threadId,
        turnIds: [error.turnId],
        sequenceCutoff: Number.MAX_SAFE_INTEGER,
      })[0];

      error.diagnostic.storedStart =
        start === undefined
          ? "missing"
          : start.sequence > error.diagnostic.failureSequence
            ? "after-failure"
            : start.sequence < error.diagnostic.projectionStartSequence
              ? "before-window"
              : "in-window";

      if (start !== undefined)
        error.diagnostic.storedStartSequence = start.sequence;
    }

    throw error;
  }
}

export function timelineProjectionDiagnostic(
  error: unknown,
): TimelineProjectionDiagnosticContext | undefined {
  return error instanceof MissingProjectionTurnStartedError
    ? error.diagnostic
    : undefined;
}
