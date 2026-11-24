import { paginateTimelineContents } from "./timeline-content-pagination.js";
import type { TimelineContentCursor } from "./timeline-snapshot.js";
import type {
  TimelinePaginationCursor,
  TimelineRow,
} from "@omnyo/server-contract";

export type ThreadTimelinePageKind = "latest" | "older";

interface LatestThreadTimelinePageRequest {
  kind: "latest";
  segmentLimit: number;
}

interface OlderThreadTimelinePageRequest {
  beforeCursor: TimelinePaginationCursor;
  kind: "older";
  segmentLimit: number;
}

export type ThreadTimelinePageRequest =
  | LatestThreadTimelinePageRequest
  | OlderThreadTimelinePageRequest;

interface TimelineLogicalSegment {
  rows: TimelineRow[];
  sequenceStart: number;
}

interface PaginatedTimelineRowsResult {
  contentCursor?: TimelineContentCursor;
  contentPage?: {
    anchorSeq: number;
    start: number;
    end: number;
    total: number;
  };
  hasOlderRows: boolean;
  olderCursor: TimelinePaginationCursor | null;
  olderRowsSourceSeqEnd: number | null;
  olderRowUpdates?: TimelineRow[];
  returnedSegmentCount: number;
  rows: TimelineRow[];
}

export interface PaginateTimelineRowsArgs {
  boundRowsToSequenceWindow?: boolean;
  contentCursor?: TimelineContentCursor;
  maxLeaves: number;
  maxBytes: number;
  ownedSequenceStart: number;
  ownedSequenceEnd: number;
  knownHasOlderSegments: boolean | null;
  page: ThreadTimelinePageRequest;
  rows: readonly TimelineRow[];
}

function boundTimelineRowsToWindow(
  rows: readonly TimelineRow[],
  start: number,
  end: number,
): TimelineRow[] {
  return rows.flatMap((row): TimelineRow[] => {
    const ownsLifecycle = row.sourceSeqEnd >= start && row.sourceSeqEnd < end;

    if (row.kind === "turn" && row.children !== null) {
      const children = boundTimelineRowsToWindow(row.children, start, end);

      return children.length > 0 || ownsLifecycle ? [{ ...row, children }] : [];
    }

    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.childRows !== null
    ) {
      const childRows = boundTimelineRowsToWindow(row.childRows, start, end);

      return childRows.length > 0 || ownsLifecycle
        ? [{ ...row, childRows }]
        : [];
    }

    return ownsLifecycle ? [row] : [];
  });
}

function rowWindowOwnershipSequence(row: TimelineRow): number {
  const children =
    row.kind === "turn"
      ? row.children
      : row.kind === "work" && row.workKind === "delegation"
        ? row.childRows
        : null;

  if (children !== null && children.length > 0) {
    return Math.min(...children.map(rowWindowOwnershipSequence));
  }

  return row.sourceSeqEnd;
}

function timelineWindowCursor(sequenceStart: number): TimelinePaginationCursor {
  return {
    anchorSeq: sequenceStart,
    anchorId: `timeline-window:${sequenceStart}`,
  };
}

function buildTimelineLogicalSegments(
  args: PaginateTimelineRowsArgs,
): TimelineLogicalSegment[] {
  const { ownedSequenceStart, ownedSequenceEnd } = args;

  const bounds = [
    ownedSequenceStart,
    ...new Set(
      args.rows.flatMap((row) =>
        row.kind === "conversation" &&
        row.role === "user" &&
        row.sourceSeqStart > ownedSequenceStart &&
        row.sourceSeqStart < ownedSequenceEnd
          ? [row.sourceSeqStart]
          : [],
      ),
    ),
  ].sort((left, right) => left - right);

  const segments = bounds.map((sequenceStart): TimelineLogicalSegment => ({
    rows: [],
    sequenceStart,
  }));

  for (const row of args.rows) {
    const ownershipSequence = args.boundRowsToSequenceWindow
      ? rowWindowOwnershipSequence(row)
      : row.sourceSeqStart;

    if (
      ownershipSequence < ownedSequenceStart ||
      ownershipSequence >= ownedSequenceEnd
    ) {
      continue;
    }

    let start = 0;
    let end = bounds.length;

    while (start + 1 < end) {
      const middle = Math.floor((start + end) / 2);

      if (bounds[middle]! <= ownershipSequence) start = middle;
      else end = middle;
    }

    segments[start]!.rows.push(row);
  }

  const populated = segments.filter((segment) => segment.rows.length > 0);

  if (populated[0] !== undefined)
    populated[0].sequenceStart = ownedSequenceStart;

  return populated;
}

function timelineRowChangesFrom(
  row: TimelineRow,
  sequence: number,
): TimelineRow {
  if (row.kind === "turn" && row.children !== null) {
    return {
      ...row,
      children: timelineRowsChangedFrom(row.children, sequence),
    };
  }

  if (
    row.kind === "work" &&
    row.workKind === "delegation" &&
    row.childRows !== null
  ) {
    return {
      ...row,
      childRows: timelineRowsChangedFrom(row.childRows, sequence),
    };
  }

  return row;
}

function timelineRowsChangedFrom(
  rows: readonly TimelineRow[],
  sequence: number,
): TimelineRow[] {
  const firstChangedIndex = rows.findIndex(
    (row) => row.sourceSeqEnd >= sequence,
  );

  return firstChangedIndex === -1
    ? []
    : rows
        .slice(firstChangedIndex)
        .map((row) => timelineRowChangesFrom(row, sequence));
}

export function paginateTimelineRows(
  args: PaginateTimelineRowsArgs,
): PaginatedTimelineRowsResult {
  const { knownHasOlderSegments, page } = args;

  const rows = args.boundRowsToSequenceWindow
    ? boundTimelineRowsToWindow(
        args.rows,
        args.ownedSequenceStart,
        args.ownedSequenceEnd,
      )
    : args.rows;

  const segments = buildTimelineLogicalSegments({ ...args, rows });
  const selectedSegments = segments.slice(-page.segmentLimit);
  const returnedRows = new Map<string, TimelineRow>();
  let remainingBytes = args.maxBytes;

  const collectRows = (): TimelineRow[] => {
    const collected = new Set<string>();

    return rows.flatMap((row) => {
      const returned = returnedRows.get(row.id);

      if (returned === undefined || collected.has(row.id)) return [];
      collected.add(row.id);

      return [returned];
    });
  };

  const omittedRows = (
    omittedContentSourceSeqEnd: number | null,
    windowStart: number,
  ): Pick<
    PaginatedTimelineRowsResult,
    "olderRowUpdates" | "olderRowsSourceSeqEnd"
  > => {
    const omitted = rows.filter(
      (row) =>
        row.sourceSeqStart < args.ownedSequenceEnd && !returnedRows.has(row.id),
    );

    const changed =
      page.kind === "latest"
        ? omitted.filter((row) => row.sourceSeqEnd >= windowStart)
        : [];

    const updates = changed.map((row) =>
      timelineRowChangesFrom(row, windowStart),
    );

    const reportUpdates =
      updates.length > 0 &&
      Buffer.byteLength(JSON.stringify(updates)) <= remainingBytes;

    return {
      olderRowsSourceSeqEnd: omitted.reduce<number | null>(
        (sourceSeqEnd, row) =>
          reportUpdates && row.sourceSeqEnd >= windowStart
            ? sourceSeqEnd
            : Math.max(sourceSeqEnd ?? 0, row.sourceSeqEnd),
        omittedContentSourceSeqEnd,
      ),
      ...(reportUpdates ? { olderRowUpdates: updates } : {}),
    };
  };

  if (selectedSegments.length === 0) {
    const hasOlderRows = knownHasOlderSegments ?? false;

    return {
      hasOlderRows,
      olderCursor: hasOlderRows
        ? timelineWindowCursor(args.ownedSequenceStart)
        : null,
      ...omittedRows(null, args.ownedSequenceStart),
      returnedSegmentCount: 0,
      rows: [],
    };
  }

  let remainingLeaves = args.maxLeaves;
  let returnedSegmentCount = 0;

  for (let index = selectedSegments.length - 1; index >= 0; index -= 1) {
    const segment = selectedSegments[index]!;

    const contents = paginateTimelineContents(
      segment.rows,
      args.contentCursor?.beforeLeaf,
      remainingLeaves,
      remainingBytes,
    );

    for (const row of contents.rows) returnedRows.set(row.id, row);
    returnedSegmentCount += 1;
    remainingLeaves -= contents.end - contents.start;
    remainingBytes -= Buffer.byteLength(JSON.stringify(contents.rows));

    if (contents.start > 0 || remainingLeaves <= 0 || remainingBytes <= 0) {
      const hasOlderRows =
        contents.start > 0 ||
        index > 0 ||
        (knownHasOlderSegments ?? segments.length > selectedSegments.length);

      return {
        rows: collectRows(),
        returnedSegmentCount,
        hasOlderRows,
        olderCursor: hasOlderRows
          ? timelineWindowCursor(segment.sequenceStart)
          : null,
        ...omittedRows(contents.partialRowsSourceSeqEnd, segment.sequenceStart),
        contentCursor:
          contents.start > 0
            ? {
                beforeLeaf: contents.start,
                beforeSequence:
                  selectedSegments[index + 1]?.sequenceStart ??
                  args.ownedSequenceEnd,
              }
            : undefined,
        contentPage: {
          anchorSeq: segment.sequenceStart,
          start: contents.start,
          end: contents.end,
          total: contents.total,
        },
      };
    }
  }

  const hasOlderRows =
    knownHasOlderSegments ?? segments.length > selectedSegments.length;

  return {
    rows: collectRows(),
    returnedSegmentCount,
    hasOlderRows,
    olderCursor: hasOlderRows
      ? timelineWindowCursor(selectedSegments[0]!.sequenceStart)
      : null,
    ...omittedRows(null, selectedSegments[0]!.sequenceStart),
  };
}
