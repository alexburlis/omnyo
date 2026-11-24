import {
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  type ThreadTimelineProjectionCheckpoint,
} from "@omnyo/thread-view";
import type { ThreadEventType } from "@omnyo/domain";
import {
  findTimelineWindowBudgetFloorSequence,
  findStoredTimelineWindowByteBudgetFloor,
  getLatestThreadSequence,
  getThreadHistoryEpoch,
  listStoredEventRowsInSequenceRange,
  scopedItemRefKey,
  type DbConnection,
  type TimelineWindowHint,
  type StoredEventRow,
} from "@omnyo/db";
import type {
  ThreadTimelinePageKind,
  ThreadTimelinePageRequest,
} from "./timeline-pagination.js";

export type ThreadTimelineEventSelectionStrategy = "full" | "standard-window";

export interface TimelineEventRowSelection {
  reusedRootTurnIds?: string[];
  fetchedTurnIds: ReadonlySet<string>;
  boundRowsToSequenceWindow: boolean;
  contextOnlyInterruptionSequences: ReadonlySet<number>;
  orderingBoundarySequence: number | null;
  ownedSequenceStart: number;
  ownedSequenceEnd: number;
  knownHasOlderSegments: boolean | null;
  paginationPage: ThreadTimelinePageRequest;
  responsePageKind: ThreadTimelinePageKind;
  rows: StoredEventRow[];
  headStateRows: StoredEventRow[];
  strategy: ThreadTimelineEventSelectionStrategy;
}

export interface StandardTimelineEventRowSelection {
  hints: readonly TimelineWindowHint[];
  selection: TimelineEventRowSelection;
}

export interface TimelineBudgetFloor {
  sequence: number | undefined;
}

export const TIMELINE_SELECTION_EVENT_DATA_BYTE_LIMIT = 4 * 1024 * 1024;

export interface LatestTimelineSelectionMemoArgs {
  rootCacheIdentity?: string;
  epochSequenceStart: number;
  eventBudget: number;
  excludeDiagnosticEvents: boolean;
  maxInlineOutputChars: number;
  maxSeq: number;
  page: ThreadTimelinePageRequest;
  threadId: string;
}

export interface LatestTimelineSelectionLookup {
  appendedRows: StoredEventRow[] | null;
  budgetFloor: TimelineBudgetFloor | null;
  generation: string;
  selection: TimelineEventRowSelection | null;
  projection: LatestTimelineProjectionMemo | null;
}

export interface LatestTimelineProjectionMemo {
  agentMessageDeltaCount: number;
  checkpoint: ThreadTimelineProjectionCheckpoint;
  key: string;
  maxSeq: number;
}

interface TimelineSelectionMemoEntry {
  hints: readonly TimelineWindowHint[];
  appendableTurnIds: ReadonlySet<string>;
  dataChars: number;
  epochSequenceStart: number;
  generation: string;
  maxSeq: number;
  selection: TimelineEventRowSelection;
  projection: LatestTimelineProjectionMemo | null;
  threadId: string;
}

interface TimelineSelectionMemo {
  dataChars: number;
  entries: Map<string, TimelineSelectionMemoEntry>;
}

export const TIMELINE_SELECTION_MEMO_MAX_ENTRIES = 16;

const TIMELINE_SELECTION_MEMO_MAX_DATA_CHARS = 16_000_000;

const TIMELINE_SELECTION_MEMO_MAX_APPENDED_ROWS = 512;

const APPENDABLE_EVENT_TYPES: ReadonlySet<ThreadEventType> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/toolCall/progress",
  "item/mcpToolCall/progress",
]);

const IGNORABLE_EVENT_TYPES: ReadonlySet<ThreadEventType> = new Set(
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
);

const selectionMemos = new WeakMap<DbConnection, TimelineSelectionMemo>();

export function clearTimelineSelectionMemo(db: DbConnection): void {
  selectionMemos.delete(db);
}

export function countTimelineSelectionMemoEntries(db: DbConnection): number {
  return selectionMemos.get(db)?.entries.size ?? 0;
}

export function selectTimelineWindowStart(
  hints: readonly TimelineWindowHint[],
  budgetFloorSequence: number | undefined,
  segmentLimit: number,
  epochSequenceStart: number,
): number {
  if (budgetFloorSequence === undefined && hints.length <= segmentLimit) {
    return epochSequenceStart;
  }

  const affordable = hints.filter(
    (hint) =>
      budgetFloorSequence === undefined || hint.sequence >= budgetFloorSequence,
  );

  return (
    affordable[Math.min(segmentLimit, affordable.length) - 1]?.sequence ??
    hints[0]?.sequence ??
    budgetFloorSequence ??
    epochSequenceStart
  );
}

function getSelectionMemo(db: DbConnection): TimelineSelectionMemo {
  let memo = selectionMemos.get(db);

  if (memo === undefined) {
    memo = { dataChars: 0, entries: new Map() };
    selectionMemos.set(db, memo);
  }

  return memo;
}

function dataCharsOfRows(rows: readonly StoredEventRow[]): number {
  let chars = 0;

  for (const row of rows) {
    chars += row.data.length;
  }

  return chars;
}

function deleteMemoEntry(memo: TimelineSelectionMemo, key: string): void {
  const entry = memo.entries.get(key);

  if (entry === undefined) return;
  memo.entries.delete(key);
  memo.dataChars -= retainedDataCharsOfEntry(entry);
}

function retainedDataCharsOfEntry(entry: TimelineSelectionMemoEntry): number {
  return entry.dataChars * (entry.projection === null ? 1 : 2);
}

function deleteThreadMemoEntries(
  memo: TimelineSelectionMemo,
  threadId: string,
  keep: (entry: TimelineSelectionMemoEntry) => boolean,
): void {
  for (const [key, entry] of memo.entries) {
    if (entry.threadId === threadId && !keep(entry)) {
      deleteMemoEntry(memo, key);
    }
  }
}

function storeMemoEntry(
  memo: TimelineSelectionMemo,
  key: string,
  entry: TimelineSelectionMemoEntry,
): void {
  deleteMemoEntry(memo, key);
  const retainedDataChars = retainedDataCharsOfEntry(entry);

  if (retainedDataChars > TIMELINE_SELECTION_MEMO_MAX_DATA_CHARS) return;
  memo.entries.set(key, entry);
  memo.dataChars += retainedDataChars;

  while (
    memo.entries.size > TIMELINE_SELECTION_MEMO_MAX_ENTRIES ||
    memo.dataChars > TIMELINE_SELECTION_MEMO_MAX_DATA_CHARS
  ) {
    const oldest = memo.entries.keys().next().value;

    if (oldest === undefined) break;
    deleteMemoEntry(memo, oldest);
  }
}

function selectionMemoKey(args: LatestTimelineSelectionMemoArgs): string {
  return JSON.stringify([
    args.threadId,
    args.rootCacheIdentity ?? null,
    args.page.segmentLimit,
    args.eventBudget,
    args.maxInlineOutputChars,
    args.excludeDiagnosticEvents,
    args.epochSequenceStart,
  ]);
}

function isAppendableRow(
  row: StoredEventRow,
  appendableTurnIds: ReadonlySet<string>,
): boolean {
  return (
    APPENDABLE_EVENT_TYPES.has(row.type) &&
    row.scopeKind === "turn" &&
    row.turnId !== null &&
    appendableTurnIds.has(row.turnId) &&
    row.parentToolCallId === null &&
    row.itemKind === null
  );
}

function isIgnorableRow(row: StoredEventRow): boolean {
  return IGNORABLE_EVENT_TYPES.has(row.type) && row.parentToolCallId === null;
}

function listAppendableRows(
  db: DbConnection,
  args: LatestTimelineSelectionMemoArgs,
  entry: TimelineSelectionMemoEntry,
): StoredEventRow[] | null {
  if (
    args.maxSeq < entry.maxSeq ||
    args.maxSeq - entry.maxSeq > TIMELINE_SELECTION_MEMO_MAX_APPENDED_ROWS ||
    getLatestThreadSequence(db, { threadId: args.threadId }) !== args.maxSeq
  ) {
    return null;
  }

  const appendedRows = listStoredEventRowsInSequenceRange(db, {
    afterSequence: entry.maxSeq,
    limit: TIMELINE_SELECTION_MEMO_MAX_APPENDED_ROWS + 1,
    maxInlineOutputChars: args.maxInlineOutputChars,
    threadId: args.threadId,
    throughSequence: args.maxSeq,
  });

  if (appendedRows.length > TIMELINE_SELECTION_MEMO_MAX_APPENDED_ROWS) {
    return null;
  }

  const appendableRows: StoredEventRow[] = [];

  const retainedItems = entry.selection.boundRowsToSequenceWindow
    ? new Set(
        entry.selection.rows.flatMap((row) =>
          row.itemId === null
            ? []
            : [
                scopedItemRefKey({
                  itemId: row.itemId,
                  scopeKind: row.scopeKind,
                  turnId: row.turnId,
                }),
              ],
        ),
      )
    : null;

  for (const row of appendedRows) {
    if (isAppendableRow(row, entry.appendableTurnIds)) {
      if (
        retainedItems !== null &&
        (row.itemId === null ||
          !retainedItems.has(
            scopedItemRefKey({
              itemId: row.itemId,
              scopeKind: row.scopeKind,
              turnId: row.turnId,
            }),
          ))
      ) {
        return null;
      }

      appendableRows.push(row);
    } else if (!isIgnorableRow(row)) {
      return null;
    }
  }

  return appendableRows;
}

export function forgetLatestTimelineSelections(
  db: DbConnection,
  threadId: string,
): void {
  const memo = selectionMemos.get(db);

  if (memo === undefined) return;
  deleteThreadMemoEntries(memo, threadId, () => false);
}

export function lookupLatestTimelineSelection(
  db: DbConnection,
  args: LatestTimelineSelectionMemoArgs,
): LatestTimelineSelectionLookup {
  const generation = getThreadHistoryEpoch(db, args.threadId);

  const miss: LatestTimelineSelectionLookup = {
    appendedRows: null,
    budgetFloor: null,
    generation,
    selection: null,
    projection: null,
  };

  const memo = selectionMemos.get(db);
  const key = selectionMemoKey(args);
  const entry = memo?.entries.get(key);

  if (
    memo === undefined ||
    entry === undefined ||
    entry.generation !== generation
  ) {
    return miss;
  }

  const appendableRows = listAppendableRows(db, args, entry);

  if (appendableRows === null) {
    return miss;
  }

  const eventFloor = findTimelineWindowBudgetFloorSequence(db, {
    threadId: args.threadId,
    sequenceStart: args.epochSequenceStart,
    beforeSequence: args.maxSeq + 1,
    eventBudget: args.eventBudget,
    excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
    excludeDiagnosticEvents: args.excludeDiagnosticEvents,
  });

  const dataFloor = findStoredTimelineWindowByteBudgetFloor(db, {
    threadId: args.threadId,
    sequenceStart: eventFloor ?? args.epochSequenceStart,
    beforeSequence: args.maxSeq + 1,
    excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
    excludeDiagnosticEvents: args.excludeDiagnosticEvents,
    maxInlineOutputChars: args.maxInlineOutputChars,
    maxDataBytes: TIMELINE_SELECTION_EVENT_DATA_BYTE_LIMIT,
  });

  const budgetFloor: TimelineBudgetFloor = {
    sequence:
      dataFloor.kind === "fits"
        ? eventFloor
        : Math.max(
            eventFloor ?? args.epochSequenceStart,
            dataFloor.sequenceStart,
          ),
  };

  const hintedSequenceStart = selectTimelineWindowStart(
    entry.hints,
    budgetFloor.sequence,
    args.page.segmentLimit,
    args.epochSequenceStart,
  );

  const sequenceStart = entry.selection.boundRowsToSequenceWindow
    ? Math.max(
        hintedSequenceStart,
        budgetFloor.sequence ?? args.epochSequenceStart,
      )
    : hintedSequenceStart;

  if (sequenceStart !== entry.selection.ownedSequenceStart) {
    return { ...miss, budgetFloor };
  }

  const selection: TimelineEventRowSelection = {
    ...entry.selection,
    ownedSequenceEnd: args.maxSeq + 1,
    paginationPage: args.page,
    rows: entry.selection.rows.concat(appendableRows),
  };

  storeMemoEntry(memo, key, {
    ...entry,
    dataChars: entry.dataChars + dataCharsOfRows(appendableRows),
    maxSeq: args.maxSeq,
    projection: null,
    selection,
  });

  return {
    ...miss,
    appendedRows: appendableRows,
    budgetFloor,
    selection,
    projection:
      entry.projection?.maxSeq === entry.maxSeq ? entry.projection : null,
  };
}

export function rememberLatestTimelineSelection(
  db: DbConnection,
  args: LatestTimelineSelectionMemoArgs,
  lookup: LatestTimelineSelectionLookup,
  result: StandardTimelineEventRowSelection,
): void {
  const memo = getSelectionMemo(db);
  deleteThreadMemoEntries(
    memo,
    args.threadId,
    (entry) => entry.epochSequenceStart === args.epochSequenceStart,
  );
  storeMemoEntry(memo, selectionMemoKey(args), {
    hints: result.hints,
    appendableTurnIds: result.selection.fetchedTurnIds,
    dataChars:
      dataCharsOfRows(result.selection.rows) +
      dataCharsOfRows(result.selection.headStateRows),
    epochSequenceStart: args.epochSequenceStart,
    generation: lookup.generation,
    maxSeq: args.maxSeq,
    projection: null,
    selection: result.selection,
    threadId: args.threadId,
  });
}

export function rememberLatestTimelineProjection(
  db: DbConnection,
  args: LatestTimelineSelectionMemoArgs,
  projection: LatestTimelineProjectionMemo,
): void {
  const memo = selectionMemos.get(db);
  const key = selectionMemoKey(args);
  const entry = memo?.entries.get(key);

  if (
    memo === undefined ||
    entry === undefined ||
    entry.maxSeq !== args.maxSeq ||
    projection.maxSeq !== args.maxSeq
  ) {
    return;
  }

  const next = { ...entry, projection };

  if (retainedDataCharsOfEntry(next) > TIMELINE_SELECTION_MEMO_MAX_DATA_CHARS) {
    return;
  }

  storeMemoEntry(memo, key, next);
}
