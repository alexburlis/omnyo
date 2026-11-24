import { threadStatusSchema, type ThreadStatus } from "@omnyo/domain";
import { getThreadHistoryState, type DbConnection } from "@omnyo/db";
import {
  threadConversationOutlineItemSchema,
  type ThreadConversationOutlineItem,
} from "@omnyo/server-contract";
import {
  MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION,
  type ThreadEventWithMeta,
} from "@omnyo/thread-view";
import { z } from "zod";

const MAX_ENTRIES = 16;

const MAX_CHARS = 8_000_000;

const MAX_PARTS = 100_000;

const identitySchema = z.string().max(4096);

const sequenceSchema = z.number().int().nonnegative();

const rangeSchema = z
  .object({ start: sequenceSchema, end: sequenceSchema })
  .strict();

const projectionStateSchema = z
  .object({
    includeNestedEvents: z.boolean(),
    summaryCompactionEnabled: z.boolean(),
  })
  .strict();

const projectedItemSchema = z
  .object({
    item: threadConversationOutlineItemSchema,
    sourceSeqStart: sequenceSchema,
    sourceSeqEnd: sequenceSchema,
    orderIndex: sequenceSchema,
  })
  .strict();

const fragmentSchema = z
  .object({
    ranges: z.array(rangeSchema).max(MAX_PARTS),
    dependencies: z.array(identitySchema).max(MAX_PARTS),
    items: z.array(projectedItemSchema).max(MAX_PARTS),
    active: z.boolean(),
  })
  .strict();

export const conversationOutlineCheckpointSchema = z
  .object({
    version: z.literal(4),
    rewriteEpoch: identitySchema,
    threadStatus: threadStatusSchema,
    key: z.string().max(16_384),
    maxSeq: sequenceSchema,
    historySequenceStart: sequenceSchema,
    orderingBoundarySequence: sequenceSchema.nullable(),
    projectionState: projectionStateSchema,
    fragments: z.array(fragmentSchema).max(MAX_PARTS),
  })
  .strict();

export type ConversationOutlineCheckpoint = z.infer<
  typeof conversationOutlineCheckpointSchema
>;

export type ConversationOutlineProjectionState = z.infer<
  typeof projectionStateSchema
>;

export type ConversationOutlineSequenceRange = z.infer<typeof rangeSchema>;

type Fragment = z.infer<typeof fragmentSchema>;

type ProjectedItem = z.infer<typeof projectedItemSchema>;

export interface ConversationOutlineSelection {
  events: ThreadEventWithMeta[];
  delegationTurnLinks: () => { turnId: string; parentTurnId: string }[];
  pendingDelegationLinks: () => { providerThreadId: string; callId: string }[];
  project: () => (Omit<ProjectedItem, "orderIndex"> & {
    turnId: string | null;
  })[];
}

interface Entry extends ConversationOutlineCheckpoint {
  chars: number;
}

interface OutlineCache {
  entries: Map<string, Entry>;
  chars: number;
}

const caches = new WeakMap<DbConnection, OutlineCache>();

function cacheFor(db: DbConnection): OutlineCache {
  let cache = caches.get(db);

  if (cache === undefined) {
    cache = { entries: new Map(), chars: 0 };
    caches.set(db, cache);
  }

  return cache;
}

function remember(
  db: DbConnection,
  threadId: string,
  checkpoint: ConversationOutlineCheckpoint,
): void {
  const cache = cacheFor(db);
  const previous = cache.entries.get(threadId);

  if (previous !== undefined) {
    cache.chars -= previous.chars;
    cache.entries.delete(threadId);
  }

  const chars = JSON.stringify(checkpoint).length;

  if (chars > MAX_CHARS) return;
  cache.entries.set(threadId, { ...checkpoint, chars });
  cache.chars += chars;

  while (cache.entries.size > MAX_ENTRIES || cache.chars > MAX_CHARS) {
    const oldest = cache.entries.keys().next().value;

    if (oldest === undefined) break;
    cache.chars -= cache.entries.get(oldest)!.chars;
    cache.entries.delete(oldest);
  }
}

export function getConversationOutlineCheckpointState(
  db: DbConnection,
  threadId: string,
): { key: string; rewriteEpoch: string; maxSeq: number } | null {
  const entry = caches.get(db)?.entries.get(threadId);

  return entry === undefined
    ? null
    : {
        key: entry.key,
        rewriteEpoch: entry.rewriteEpoch,
        maxSeq: entry.maxSeq,
      };
}

export function captureConversationOutlineCheckpoint(
  db: DbConnection,
  threadId: string,
): ConversationOutlineCheckpoint | null {
  const entry = caches.get(db)?.entries.get(threadId);

  if (entry === undefined) return null;
  const { chars: _chars, ...checkpoint } = entry;

  return structuredClone(checkpoint);
}

export function restoreConversationOutlineCheckpoint(
  db: DbConnection,
  threadId: string,
  checkpoint: unknown,
): boolean {
  let chars: number;

  try {
    chars = JSON.stringify(checkpoint).length;
  } catch {
    return false;
  }

  if (chars > MAX_CHARS) return false;
  const parsed = conversationOutlineCheckpointSchema.safeParse(checkpoint);

  if (!parsed.success) return false;
  const value = parsed.data;

  if (
    value.historySequenceStart > value.maxSeq ||
    value.fragments.some(
      (fragment) =>
        fragment.ranges.length === 0 ||
        fragment.ranges.some(
          (range) => range.start >= range.end || range.end > value.maxSeq + 1,
        ) ||
        fragment.items.some(
          (row) =>
            row.sourceSeqStart > row.sourceSeqEnd ||
            row.sourceSeqEnd > value.maxSeq,
        ),
    )
  )
    return false;
  remember(db, threadId, value);

  return true;
}

function dependencies({ event }: ThreadEventWithMeta): string[] {
  const result: string[] = [];

  const provider =
    "providerThreadId" in event ? (event.providerThreadId ?? null) : null;

  const turnId = event.scope.kind === "turn" ? event.scope.turnId : null;

  if (turnId !== null) result.push(JSON.stringify(["turn", provider, turnId]));

  if (
    event.type === "client/turn/requested" ||
    event.type === "client/turn/rejected"
  )
    result.push(JSON.stringify(["request", event.requestId]));

  if (event.type === "turn/input/accepted")
    result.push(JSON.stringify(["request", event.clientRequestId]));

  if (
    event.type === "client/turn/requested" &&
    "expectedTurnId" in event.target &&
    event.target.expectedTurnId !== null
  ) {
    result.push(JSON.stringify(["target-turn", event.target.expectedTurnId]));
  }

  if (turnId !== null) result.push(JSON.stringify(["target-turn", turnId]));

  if (event.type === "turn/completed" && turnId !== null)
    result.push(JSON.stringify(["completed-turn", turnId]));

  const parent =
    "item" in event && "parentToolCallId" in event.item
      ? event.item.parentToolCallId
      : "parentToolCallId" in event
        ? event.parentToolCallId
        : null;

  if (parent) result.push(JSON.stringify(["call", provider, parent]));

  if ("item" in event) {
    const item = event.item;

    if (item.type === "toolCall" || item.type === "delegation")
      result.push(JSON.stringify(["call", provider, item.id]));

    if (item.type === "delegation" && item.childRef !== provider)
      result.push(JSON.stringify(["delegated-provider", item.childRef]));

    if (item.type === "backgroundTask") {
      result.push(JSON.stringify(["task", provider, item.id]));

      if (item.familyId)
        result.push(JSON.stringify(["task-family", provider, item.familyId]));
    }
  }

  return result;
}

function changedDependencies(row: ThreadEventWithMeta): string[] {
  const result = dependencies(row);

  const provider =
    "providerThreadId" in row.event ? row.event.providerThreadId : null;

  if (provider) result.push(JSON.stringify(["delegated-provider", provider]));

  return result;
}

function isThreadError({ event }: ThreadEventWithMeta): boolean {
  return (
    event.scope.kind === "thread" &&
    (event.type === "system/error" ||
      event.type === "provider/error" ||
      event.type === "system/thread/interrupted")
  );
}

function rangesFor(sequences: number[]): ConversationOutlineSequenceRange[] {
  const ranges: ConversationOutlineSequenceRange[] = [];

  for (const sequence of sequences.sort((a, b) => a - b)) {
    const last = ranges.at(-1);

    if (last !== undefined && sequence <= last.end)
      last.end = Math.max(last.end, sequence + 1);
    else ranges.push({ start: sequence, end: sequence + 1 });
  }

  return ranges;
}

function buildFragments(
  selection: ConversationOutlineSelection,
  previous?: Fragment[],
): Fragment[] {
  const events = selection.events;
  const roots = events.map((_, index) => index);

  const root = (index: number): number => {
    while (roots[index] !== index) {
      roots[index] = roots[roots[index]];
      index = roots[index];
    }

    return index;
  };

  const join = (left: number, right: number): void => {
    roots[root(right)] = root(left);
  };

  const byDependency = new Map<string, number>();
  const bySequence = new Map<number, number>();
  const byTurn = new Map<string, number>();
  const active = new Map<string, number>();
  const pending = new Map<string, number>();
  let latestTurn: number | undefined;

  for (const [index, row] of events.entries()) {
    const { event, meta } = row;
    bySequence.set(meta.seq, index);

    for (const dependency of dependencies(row)) {
      const existing = byDependency.get(dependency);

      if (existing === undefined) byDependency.set(dependency, index);
      else join(existing, index);
    }

    if (event.scope.kind === "turn") {
      byTurn.set(event.scope.turnId, index);

      if (event.type === "turn/started") {
        for (const other of active.values()) join(other, index);
        active.set(event.scope.turnId, index);
        latestTurn = index;
      } else if (event.type === "turn/completed")
        active.delete(event.scope.turnId);
    }

    if (event.type === "client/turn/requested") {
      pending.set(event.requestId, index);

      for (const other of active.values()) join(other, index);
    } else if (event.type === "turn/input/accepted")
      pending.delete(event.clientRequestId);
    else if (event.type === "client/turn/rejected")
      pending.delete(event.requestId);

    if (event.type === "system/manager/user_message")
      for (const other of active.values()) join(other, index);

    if (isThreadError(row) && latestTurn !== undefined) join(latestTurn, index);
  }

  const rows = selection.project();

  for (const row of rows) {
    const first =
      row.turnId === null
        ? bySequence.get(row.sourceSeqStart)
        : byTurn.get(row.turnId);

    const last = bySequence.get(row.sourceSeqEnd);

    if (first !== undefined && last !== undefined) join(first, last);
  }

  for (const { turnId, parentTurnId } of selection.delegationTurnLinks()) {
    const child = byTurn.get(turnId);
    const parent = byTurn.get(parentTurnId);

    if (child !== undefined && parent !== undefined) join(parent, child);
  }

  const groups = new Map<
    number,
    { fragment: Fragment; sequences: number[]; dependencies: Set<string> }
  >();

  for (const [index, row] of events.entries()) {
    const owner = root(index);
    let group = groups.get(owner);

    if (group === undefined) {
      group = {
        fragment: { ranges: [], dependencies: [], items: [], active: false },
        sequences: [],
        dependencies: new Set(),
      };
      groups.set(owner, group);
    }

    group.sequences.push(row.meta.seq);

    for (const dependency of dependencies(row))
      group.dependencies.add(dependency);
  }

  const previousDependencies = new Set(
    previous?.flatMap((fragment) => fragment.dependencies),
  );

  for (const {
    providerThreadId,
    callId,
  } of selection.pendingDelegationLinks()) {
    const call = JSON.stringify(["call", providerThreadId, callId]);

    const pendingCall = JSON.stringify([
      "pending-delegation-call",
      providerThreadId,
      callId,
    ]);

    if (
      previousDependencies.has(call) &&
      !previousDependencies.has(pendingCall)
    )
      continue;
    const index = byDependency.get(call);

    if (index === undefined) continue;
    const group = groups.get(root(index))!;
    group.dependencies.add(pendingCall);
    group.dependencies.add(
      JSON.stringify(["pending-delegation-provider", providerThreadId]),
    );
  }

  for (const index of [...active.values(), ...pending.values()])
    groups.get(root(index))!.fragment.active = true;

  if (latestTurn !== undefined)
    groups.get(root(latestTurn))!.fragment.active = true;

  for (const [orderIndex, row] of rows.entries()) {
    const index =
      row.turnId === null
        ? bySequence.get(row.sourceSeqStart)
        : byTurn.get(row.turnId);

    if (index === undefined)
      throw new Error("Conversation outline row has no source group");
    const { turnId: _turnId, ...item } = row;
    groups.get(root(index))!.fragment.items.push({ ...item, orderIndex });
  }

  return [...groups.values()].map(
    ({ fragment, sequences, dependencies: groupDependencies }) => ({
      ...fragment,
      ranges: rangesFor(sequences),
      dependencies: [...groupDependencies],
    }),
  );
}

function orderedItems(fragments: Fragment[]): ProjectedItem[] {
  return fragments
    .flatMap((fragment) => fragment.items)
    .sort((left, right) => left.orderIndex - right.orderIndex);
}

function itemsFrom(fragments: Fragment[]): ThreadConversationOutlineItem[] {
  return orderedItems(fragments).map(({ item }) => item);
}

function mergeFragments(
  previous: Fragment[],
  retained: Fragment[],
  rebuilt: Fragment[],
  maxSeq: number,
): Fragment[] | null {
  const oldRows = orderedItems(previous);

  const oldPositions = new Map(
    oldRows.map((row, index) => [row.item.id, index]),
  );

  const projected = orderedItems(rebuilt);
  let lastPosition = -1;

  for (const row of projected) {
    const position = oldPositions.get(row.item.id);

    if (position === undefined) {
      if (
        row.sourceSeqStart <= maxSeq &&
        !previous.some(
          (fragment) =>
            fragment.active &&
            fragment.ranges.some(
              (range) =>
                range.start <= row.sourceSeqStart &&
                row.sourceSeqStart < range.end,
            ),
        )
      )
        return null;
    } else {
      if (position < lastPosition) return null;
      lastPosition = position;
    }
  }

  const fragments = [...retained, ...rebuilt];

  const rowsById = new Map(
    fragments
      .flatMap((fragment) => fragment.items)
      .map((row) => [row.item.id, row]),
  );

  const order = oldRows
    .filter((row) => rowsById.has(row.item.id))
    .map((row) => row.item.id);

  for (const [index, row] of projected.entries()) {
    if (oldPositions.has(row.item.id)) continue;

    const next = projected
      .slice(index + 1)
      .find((candidate) => oldPositions.has(candidate.item.id));

    const position =
      next === undefined ? order.length : order.indexOf(next.item.id);

    if (position < 0) return null;
    order.splice(position, 0, row.item.id);
  }

  const positions = new Map(order.map((id, index) => [id, index]));

  return fragments.map((fragment) => ({
    ...fragment,
    items: fragment.items.map((row) => ({
      ...row,
      orderIndex: positions.get(row.item.id)!,
    })),
  }));
}

function targetsCompletedTurn(
  events: ThreadEventWithMeta[],
  fragments: Fragment[],
): boolean {
  const completed = new Set(
    fragments
      .flatMap((fragment) => fragment.dependencies)
      .filter((dependency) => dependency.startsWith('["completed-turn",')),
  );

  return events.some(({ event }) => {
    const turnId =
      event.scope.kind === "turn"
        ? event.scope.turnId
        : event.type === "client/turn/requested" &&
            "expectedTurnId" in event.target
          ? event.target.expectedTurnId
          : null;

    return (
      turnId !== null &&
      completed.has(JSON.stringify(["completed-turn", turnId]))
    );
  });
}

function startsPendingDelegation(
  events: ThreadEventWithMeta[],
  fragments: Fragment[],
): boolean {
  const dependencies = new Set(
    fragments.flatMap((fragment) => fragment.dependencies),
  );

  const rootRequests = new Set(
    events.flatMap(({ event }) =>
      event.type === "client/turn/requested" &&
      (event.target.kind === "new-turn" || event.target.kind === "thread-start")
        ? [event.requestId]
        : [],
    ),
  );

  const acceptedRoots = new Set(
    events.flatMap(({ event }) =>
      event.type === "turn/input/accepted" &&
      event.scope.kind === "turn" &&
      rootRequests.has(event.clientRequestId)
        ? [event.scope.turnId]
        : [],
    ),
  );

  return events.some(
    ({ event }) =>
      event.type === "turn/started" &&
      event.scope.kind === "turn" &&
      !acceptedRoots.has(event.scope.turnId) &&
      dependencies.has(
        JSON.stringify(["pending-delegation-provider", event.providerThreadId]),
      ),
  );
}

export function projectConversationOutlineIncrementally(args: {
  db: DbConnection;
  threadId: string;
  key: string;
  threadStatus: ThreadStatus;
  maxSeq: number;
  historySequenceStart: number;
  orderingBoundarySequence: number | null;
  resolveProjectionState: (
    sequenceStart: number,
    previous: ConversationOutlineProjectionState | null,
  ) => ConversationOutlineProjectionState;
  select: (
    sequenceStart: number,
    precedingAgentMessageDeltaCount: number,
    projectionState: ConversationOutlineProjectionState,
    ranges?: ConversationOutlineSequenceRange[],
  ) => ConversationOutlineSelection;
}): ThreadConversationOutlineItem[] {
  const rewriteEpoch = getThreadHistoryState(
    args.db,
    args.threadId,
  ).rewriteEpoch;

  const entry = caches.get(args.db)?.entries.get(args.threadId);

  const reusable =
    entry !== undefined &&
    entry.key === args.key &&
    entry.rewriteEpoch === rewriteEpoch &&
    entry.historySequenceStart === args.historySequenceStart &&
    entry.orderingBoundarySequence === args.orderingBoundarySequence &&
    entry.maxSeq <= args.maxSeq;

  const previousState = reusable ? entry.projectionState : null;

  const projectionState = args.resolveProjectionState(
    reusable ? entry.maxSeq + 1 : args.historySequenceStart,
    previousState,
  );

  const reuse =
    reusable &&
    previousState?.includeNestedEvents ===
      projectionState.includeNestedEvents &&
    previousState.summaryCompactionEnabled ===
      projectionState.summaryCompactionEnabled;

  if (
    reuse &&
    entry.maxSeq === args.maxSeq &&
    entry.threadStatus === args.threadStatus
  )
    return itemsFrom(entry.fragments);

  const precedingDeltas = projectionState.summaryCompactionEnabled
    ? MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION
    : 0;

  let fragments: Fragment[];

  if (!reuse) {
    fragments = buildFragments(
      args.select(args.historySequenceStart, precedingDeltas, projectionState),
    );
  } else {
    const appended = args.select(
      entry.maxSeq + 1,
      precedingDeltas,
      projectionState,
    );

    if (
      targetsCompletedTurn(appended.events, entry.fragments) ||
      startsPendingDelegation(appended.events, entry.fragments)
    ) {
      fragments = buildFragments(
        args.select(
          args.historySequenceStart,
          precedingDeltas,
          projectionState,
        ),
      );
    } else {
      const changed = new Set(appended.events.flatMap(changedDependencies));

      const affected = entry.fragments.filter(
        (fragment) =>
          fragment.active ||
          fragment.dependencies.some((dependency) => changed.has(dependency)),
      );

      if (
        appended.events.some(isThreadError) &&
        affected.length === 0 &&
        entry.fragments.length > 0
      )
        affected.push(entry.fragments.at(-1)!);

      const retained = entry.fragments.filter(
        (fragment) => !affected.includes(fragment),
      );

      const ranges = [
        ...affected.flatMap((fragment) => fragment.ranges),
        { start: entry.maxSeq + 1, end: args.maxSeq + 1 },
      ];

      if (ranges.length === 1 && appended.events.length === 0)
        fragments = entry.fragments;
      else {
        const selection = args.select(
          args.historySequenceStart,
          precedingDeltas,
          projectionState,
          ranges,
        );

        fragments =
          mergeFragments(
            entry.fragments,
            retained,
            buildFragments(selection, entry.fragments),
            entry.maxSeq,
          ) ??
          buildFragments(
            args.select(
              args.historySequenceStart,
              precedingDeltas,
              projectionState,
            ),
          );
      }
    }
  }

  remember(args.db, args.threadId, {
    version: 4,
    rewriteEpoch,
    threadStatus: args.threadStatus,
    key: args.key,
    maxSeq: args.maxSeq,
    historySequenceStart: args.historySequenceStart,
    orderingBoundarySequence: args.orderingBoundarySequence,
    projectionState,
    fragments,
  });

  return itemsFrom(fragments);
}
