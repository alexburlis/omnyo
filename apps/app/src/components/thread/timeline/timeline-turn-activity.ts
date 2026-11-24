import {
  APP_UPDATE_INTERRUPTION_TITLE,
  type ThreadTimelineViewRow,
  type TimelineViewTurnRow,
} from "@omnyo/thread-view";

type TimelineViewSourceSystemRow = Extract<
  ThreadTimelineViewRow,
  { kind: "system" }
>;

export interface TurnActivityLine {
  duration: string | null;
  diffStats: { added: number; removed: number } | null;
  warningCount: number;
  failureCount: number;
}

const SECOND_MS = 1_000;

const MINUTE_MS = 60 * SECOND_MS;

const HOUR_MS = 60 * MINUTE_MS;

const DETAILED_DURATION_LIMIT_MS = 10 * MINUTE_MS;

export function formatWorkedDuration(durationMs: number): string {
  if (durationMs < MINUTE_MS) {
    return `${Math.max(1, Math.round(durationMs / SECOND_MS))}s`;
  }

  if (durationMs < DETAILED_DURATION_LIMIT_MS) {
    const totalSeconds = Math.round(durationMs / SECOND_MS);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  if (durationMs < HOUR_MS) {
    return `${Math.floor(durationMs / MINUTE_MS)}m`;
  }

  const hours = Math.floor(durationMs / HOUR_MS);
  const minutes = Math.floor((durationMs % HOUR_MS) / MINUTE_MS);

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function addDiffStats(
  rows: readonly ThreadTimelineViewRow[],
  total: { added: number; removed: number; files: number },
): void {
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "file-change") {
      total.added += row.change.diffStats.added;
      total.removed += row.change.diffStats.removed;
      total.files += 1;
    } else if (row.kind === "bundle-summary" || row.kind === "step-summary") {
      addDiffStats(row.children, total);
    }
  }
}

function turnDiffStats(
  row: TimelineViewTurnRow,
): { added: number; removed: number } | null {
  if (row.children === null) return null;
  const total = { added: 0, removed: 0, files: 0 };
  addDiffStats(row.children, total);

  if (total.files === 0 || total.added + total.removed === 0) return null;

  return { added: total.added, removed: total.removed };
}

export function isFoldedTurnRow(
  row: ThreadTimelineViewRow,
): row is TimelineViewTurnRow {
  return row.kind === "turn" && row.status !== "pending";
}

export function buildTurnActivityLine(
  row: TimelineViewTurnRow,
): TurnActivityLine {
  const activity = row.activity;

  return {
    duration:
      row.completedAt === null
        ? null
        : formatWorkedDuration(row.completedAt - row.startedAt),
    diffStats: turnDiffStats(row),
    warningCount: (activity?.warnings ?? 0) + (row.absorbedRows?.length ?? 0),
    failureCount: activity?.failures ?? 0,
  };
}

function isWarningRow(
  row: ThreadTimelineViewRow,
): row is TimelineViewSourceSystemRow {
  return (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    (row.operationKind === "warning" || row.operationKind === "deprecation")
  );
}

function findFoldedTurnHolding(
  foldedTurns: readonly TimelineViewTurnRow[],
  warning: TimelineViewSourceSystemRow,
): TimelineViewTurnRow | null {
  const latest = foldedTurns.at(-1);

  if (latest === undefined) return null;

  const segments = foldedTurns.filter((turn) => turn.turnId === latest.turnId);
  const seq = warning.sourceSeqStart;

  const isInsideTurn =
    seq >= Math.min(...segments.map((turn) => turn.sourceSeqStart)) &&
    seq <= Math.max(...segments.map((turn) => turn.sourceSeqEnd));

  if (!isInsideTurn) return null;

  return segments.filter((turn) => turn.sourceSeqStart <= seq).at(-1) ?? null;
}

function findFollowingFoldedTurn(
  rows: readonly ThreadTimelineViewRow[],
  warningIndex: number,
): TimelineViewTurnRow | null {
  for (let index = warningIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];

    if (row === undefined) return null;

    if (isFoldedTurnRow(row)) return row;

    const isSkippable =
      (row.kind === "system" && !isUpdatePauseRow(row)) ||
      (row.kind === "conversation" && row.role === "user");

    if (!isSkippable) return null;
  }

  return null;
}

export function foldWarningsIntoFinishedTurns(
  rows: readonly ThreadTimelineViewRow[],
): readonly ThreadTimelineViewRow[] {
  const absorbedByTurnId = new Map<string, TimelineViewSourceSystemRow[]>();

  const kept: ThreadTimelineViewRow[] = [];
  const foldedTurns: TimelineViewTurnRow[] = [];

  for (const [index, row] of rows.entries()) {
    if (isFoldedTurnRow(row)) {
      foldedTurns.push(row);
      kept.push(row);
      continue;
    }

    if (!isWarningRow(row)) {
      kept.push(row);
      continue;
    }

    const target =
      findFoldedTurnHolding(foldedTurns, row) ??
      findFollowingFoldedTurn(rows, index);

    if (target === null) {
      kept.push(row);
      continue;
    }

    const absorbed = absorbedByTurnId.get(target.id) ?? [];
    absorbed.push(row);
    absorbedByTurnId.set(target.id, absorbed);
  }

  if (absorbedByTurnId.size === 0) return rows;

  return kept.map((row) => {
    if (row.kind !== "turn") return row;

    const absorbedRows = absorbedByTurnId.get(row.id);

    return absorbedRows === undefined ? row : { ...row, absorbedRows };
  });
}

export function isUpdatePauseRow(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "thread-interrupted" &&
    row.title === APP_UPDATE_INTERRUPTION_TITLE
  );
}

export function findUpdatePauseResumedAt(
  rows: readonly ThreadTimelineViewRow[],
  afterIndex: number,
): number | null {
  for (let index = afterIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];

    if (row !== undefined && row.kind !== "system") return row.startedAt;
  }

  return null;
}

export function formatUpdatePauseLabel(resumedAt: number | null): string {
  if (resumedAt === null) return "Paused for an Omnyo update";

  const time = new Date(resumedAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return `Paused for an Omnyo update · resumed ${time}`;
}
