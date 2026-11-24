import type {
  ThreadTimelineResponse,
  TimelinePaginationCursor,
  TimelineRow,
} from "@omnyo/server-contract";
import { prependOlderTimelineRows } from "@omnyo/client-core";

const MAX_HISTORY_RANGES = 128;

export interface MountedTimelineRange {
  id: string;
  rows: TimelineRow[];
  start: number;
  end: number;
  olderCursor: TimelinePaginationCursor | null;
  historySnapshot: string | undefined;
}

function nestedRows(row: TimelineRow): TimelineRow[] | null {
  if (row.kind === "turn") return row.children;

  if (row.kind === "work" && row.workKind === "delegation")
    return row.childRows;

  return null;
}

function withNestedRows(row: TimelineRow, rows: TimelineRow[]): TimelineRow {
  if (row.kind === "turn") return { ...row, children: rows };

  if (row.kind === "work" && row.workKind === "delegation")
    return { ...row, childRows: rows };

  return row;
}

function leafRows(row: TimelineRow): TimelineRow[] {
  const children = nestedRows(row);

  return children && children.length > 0 ? children.flatMap(leafRows) : [row];
}

export function mountedRangeFromPage(
  response: ThreadTimelineResponse,
  id: string,
): MountedTimelineRange {
  let start = Infinity;
  let end = -Infinity;

  for (const leaf of response.rows.flatMap(leafRows)) {
    start = Math.min(start, leaf.sourceSeqStart);
    end = Math.max(end, leaf.sourceSeqEnd);
  }

  return {
    id,
    rows: response.rows,
    start: Number.isFinite(start) ? start : response.maxSeq,
    end: Number.isFinite(end) ? end : response.maxSeq,
    olderCursor: response.timelinePage.olderCursor,
    historySnapshot: response.timelinePage.historySnapshot,
  };
}

function trimRows(
  rows: TimelineRow[],
  excluded: ReadonlySet<string>,
): TimelineRow[] {
  let changed = false;
  const result: TimelineRow[] = [];

  for (const row of rows) {
    const children = nestedRows(row);

    if (children && children.length > 0) {
      const retained = trimRows(children, excluded);

      if (retained.length === 0) {
        changed = true;
        continue;
      }

      const next = retained === children ? row : withNestedRows(row, retained);
      changed ||= next !== row;
      result.push(next);
    } else if (excluded.has(row.id)) changed = true;
    else result.push(row);
  }

  return changed ? result : rows;
}

function updateFragment(
  row: TimelineRow,
  updates: ReadonlyMap<string, TimelineRow>,
): TimelineRow {
  const update = updates.get(row.id);
  const children = nestedRows(row);
  const incomingChildren = update ? nestedRows(update) : null;

  if (!children?.length) return update ?? row;
  const childUpdates = new Map(updates);

  for (const child of incomingChildren ?? []) childUpdates.set(child.id, child);

  const nextChildren = children.map((child) =>
    updateFragment(child, childUpdates),
  );

  if (
    !update &&
    nextChildren.every((child, index) => child === children[index])
  )
    return row;

  return withNestedRows(update ?? row, nextChildren);
}

function compactMountedHistory(
  input: MountedTimelineRange[],
): MountedTimelineRange[] {
  const ranges = [...input];

  while (ranges.length > MAX_HISTORY_RANGES) {
    const [older, newer] = ranges;

    if (!older || !newer) break;
    ranges.splice(0, 2, {
      ...older,
      rows: prependOlderTimelineRows({
        olderRows: older.rows,
        loadedRows: newer.rows,
      }),
      end: newer.end,
      historySnapshot: newer.historySnapshot,
    });
  }

  return ranges;
}

export function reconcileMountedHistory(
  ranges: readonly MountedTimelineRange[],
  response: ThreadTimelineResponse,
  previousTip: number | null,
): MountedTimelineRange[] {
  const head = mountedRangeFromPage(response, `head:${response.maxSeq}`);

  if (previousTip !== null && head.start > previousTip + 1) return [head];

  const nextLeafIds = new Set(
    head.rows.flatMap(leafRows).map((leaf) => leaf.id),
  );

  const updates = new Map(
    response.timelinePage.olderRowUpdates?.map((row) => [row.id, row]),
  );

  const retained: MountedTimelineRange[] = [];

  for (const range of ranges) {
    const rows = trimRows(range.rows, nextLeafIds).map((row) =>
      updateFragment(row, updates),
    );

    if (rows.length === 0) continue;

    if (
      rows.length === range.rows.length &&
      rows.every((row, index) => row === range.rows[index])
    ) {
      retained.push(range);
      continue;
    }

    retained.push(
      mountedRangeFromPage(
        {
          ...response,
          rows,
          timelinePage: {
            ...response.timelinePage,
            historySnapshot: range.historySnapshot,
            olderCursor: range.olderCursor,
          },
        },
        range.id,
      ),
    );
  }

  const previousCursor = ranges[0]?.olderCursor ?? null;

  const keepsPreviousCursor =
    retained.length === 0 &&
    previousCursor !== null &&
    head.olderCursor !== null &&
    previousCursor.anchorSeq <= head.olderCursor.anchorSeq;

  retained.push(
    keepsPreviousCursor ? { ...head, olderCursor: previousCursor } : head,
  );

  return compactMountedHistory(retained);
}

export function prependMountedHistoryPage(
  ranges: readonly MountedTimelineRange[],
  page: MountedTimelineRange,
): MountedTimelineRange[] {
  return compactMountedHistory([page, ...ranges]);
}

export function rowsFromMountedHistory(
  ranges: readonly MountedTimelineRange[],
): TimelineRow[] {
  let rows: TimelineRow[] = [];

  for (const range of ranges)
    rows = prependOlderTimelineRows({
      loadedRows: range.rows,
      olderRows: rows,
    });

  return rows;
}
