import type { CSSProperties } from "react";
import type { ThreadTimelineViewRow } from "@omnyo/thread-view";
import { isFoldedTurnRow } from "./timeline-turn-activity";

export type TimelineRowRhythm =
  | "first"
  | "within"
  | "turn"
  | "turn-after-quiet";

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

const RHYTHM_SPACING_STEPS: Record<TimelineRowRhythm, number> = {
  first: 0,
  within: 2,
  turn: 6,
  "turn-after-quiet": 4,
};

export function timelineRowRhythmStyle(
  rhythm: TimelineRowRhythm | null,
): CSSProperties | undefined {
  if (rhythm === null || rhythm === "first") {
    return undefined;
  }

  return {
    marginTop: `calc(var(--spacing) * ${RHYTHM_SPACING_STEPS[rhythm]})`,
  };
}

function isUserRow(row: ThreadTimelineViewRow): boolean {
  return row.kind === "conversation" && row.role === "user";
}

function startsTurn(
  row: ThreadTimelineViewRow,
  previous: ThreadTimelineViewRow,
): boolean {
  if (row.kind === "conversation" && row.role === "user") {
    return row.turnRequest.kind === "message";
  }

  if (isUserRow(previous)) {
    return false;
  }

  return (
    row.turnId !== null &&
    previous.turnId !== null &&
    row.turnId !== previous.turnId
  );
}

export function findReceiptedAnswerIds(
  rows: readonly ThreadTimelineViewRow[],
): ReadonlySet<string> {
  const foldedTurnIds = new Set<string>();
  const answerIds = new Set<string>();

  for (const row of rows) {
    if (isFoldedTurnRow(row)) {
      foldedTurnIds.add(row.turnId);
      continue;
    }

    if (
      row.kind === "conversation" &&
      row.role === "assistant" &&
      row.turnId !== null &&
      foldedTurnIds.has(row.turnId)
    ) {
      answerIds.add(row.id);
    }
  }

  return answerIds.size === 0 ? EMPTY_IDS : answerIds;
}

export function timelineRowRhythm({
  previous,
  quietAnswerIds,
  row,
}: {
  previous: ThreadTimelineViewRow | undefined;
  quietAnswerIds: ReadonlySet<string>;
  row: ThreadTimelineViewRow;
}): TimelineRowRhythm {
  if (previous === undefined) {
    return "first";
  }

  if (!startsTurn(row, previous)) {
    return "within";
  }

  return quietAnswerIds.has(previous.id) ? "turn-after-quiet" : "turn";
}
