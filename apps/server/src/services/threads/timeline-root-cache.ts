import { createHash } from "node:crypto";
import { gzipSync, gunzipSync, constants } from "node:zlib";
import { z } from "zod";
import {
  getLatestThreadInterruptionSequence,
  type DbConnection,
} from "@omnyo/db";
import { timelineRowSchema, type TimelineRow } from "@omnyo/server-contract";
import {
  threadStatusSchema,
  type ThreadStatus,
} from "@omnyo/domain/thread-status";
import type {
  buildThreadTimelineFromEvents,
  ThreadEventWithMeta,
} from "@omnyo/thread-view";
import {
  redactThreadHistory,
  redactThreadHistoryTimelineRows,
} from "./thread-history-redaction.js";
import { readHistoryCache } from "./history-cache-access.js";

export const TIMELINE_PROJECTION_FORMAT_VERSION = 5;

const MAX_STORED_ROOT_BYTES = 4 * 1024 * 1024;

const MAX_EXPANDED_ROOT_BYTES = 32 * 1024 * 1024;

export const completedRootProjectionSchema = z.object({
  key: z.string(),
  rootTurnId: z.string(),
  turnIds: z.array(z.string()),
  requestIds: z.array(z.string()),
  sourceSeqStart: z.number().int().nonnegative(),
  sourceSeqEnd: z.number().int().nonnegative(),
  rows: z.array(timelineRowSchema),
  expiresAt: z.number().nullable(),
  snapshot: z
    .object({
      maxSeq: z.number().int().nonnegative(),
      status: threadStatusSchema,
      interruptionSequence: z.number().int().nonnegative().nullable(),
    })
    .optional(),
});

export type CompletedRootProjection = z.infer<
  typeof completedRootProjectionSchema
>;

export const completedRootRecordSchema = z.object({
  key: z.string(),
  body: z.string(),
  expiresAt: z.number().nullable(),
});

export type CompletedRootRecord = z.infer<typeof completedRootRecordSchema>;

const storedRootSchema = z.object({
  version: z.literal(1),
  encoding: z.literal("gzip-base64"),
  expandedBytes: z.number().int().nonnegative().max(MAX_EXPANDED_ROOT_BYTES),
  content: z.string(),
});

export interface TimelineRootCacheContext {
  identity: string;
  reused: Map<string, CompletedRootProjection>;
  expandedBytes: number;
  threadId: string;
  status: ThreadStatus;
  maxSeq: number;
  snapshotIdentity?: string;
  interruptionSequence?: number | null;
}

function rootKey(identity: string, turnId: string): string {
  return `root:${createHash("sha256")
    .update(
      JSON.stringify([TIMELINE_PROJECTION_FORMAT_VERSION, identity, turnId]),
    )
    .digest("hex")}`;
}

function snapshotIdentity(
  db: DbConnection,
  cache: TimelineRootCacheContext,
): string {
  if (cache.snapshotIdentity !== undefined) return cache.snapshotIdentity;
  cache.interruptionSequence = getLatestThreadInterruptionSequence(db, {
    threadId: cache.threadId,
    maxSeq: cache.maxSeq,
  });
  cache.snapshotIdentity = JSON.stringify([
    cache.identity,
    "revisioned-parent-v1",
    cache.status,
    cache.interruptionSequence,
  ]);

  return cache.snapshotIdentity;
}

export function loadCompletedRootProjection(
  db: DbConnection,
  cache: TimelineRootCacheContext,
  turnId: string,
  maxSeq: number,
): CompletedRootProjection | null {
  const reused = cache.reused.get(turnId);

  if (reused !== undefined) return reused;

  for (const revisioned of [false, true]) {
    const key = rootKey(
      revisioned ? snapshotIdentity(db, cache) : cache.identity,
      turnId,
    );

    const stored = readHistoryCache(db, key);

    if (
      stored === null ||
      Buffer.byteLength(stored.body) > MAX_STORED_ROOT_BYTES
    )
      continue;

    try {
      const envelope = storedRootSchema.parse(JSON.parse(stored.body));

      if (
        cache.expandedBytes + envelope.expandedBytes >
        MAX_EXPANDED_ROOT_BYTES
      )
        return null;

      const json = gunzipSync(Buffer.from(envelope.content, "base64"), {
        maxOutputLength: MAX_EXPANDED_ROOT_BYTES,
      });

      if (json.byteLength !== envelope.expandedBytes) continue;

      const projection = completedRootProjectionSchema.parse(
        JSON.parse(json.toString("utf8")),
      );

      if (
        projection.key !== key ||
        projection.rootTurnId !== turnId ||
        projection.sourceSeqEnd > maxSeq
      )
        continue;

      if (revisioned !== (projection.snapshot !== undefined)) continue;

      if (
        projection.snapshot !== undefined &&
        (projection.snapshot.maxSeq > maxSeq ||
          projection.snapshot.status !== cache.status ||
          projection.snapshot.interruptionSequence !==
            cache.interruptionSequence)
      )
        continue;
      cache.expandedBytes += json.byteLength;
      cache.reused.set(turnId, projection);

      return projection;
    } catch {
      continue;
    }
  }

  return null;
}

export function prepareCompletedRootProjections(
  db: DbConnection,
  threadId: string,
  projections: readonly CompletedRootProjection[],
): CompletedRootRecord[] {
  let expandedBytes = 0;
  const records: CompletedRootRecord[] = [];

  for (const projection of projections) {
    const { rows, ...metadata } = projection;

    const sanitized = {
      ...redactThreadHistory(db, threadId, metadata, {
        invalidJsonText: "withhold",
      }),
      rows: redactThreadHistoryTimelineRows(db, threadId, rows),
    };

    const serialized = JSON.stringify(sanitized);
    const bytes = Buffer.byteLength(serialized);
    expandedBytes += bytes;

    if (expandedBytes > MAX_EXPANDED_ROOT_BYTES) break;

    const compressed = gzipSync(serialized, {
      level: constants.Z_BEST_SPEED,
    });

    const body = JSON.stringify({
      version: 1,
      encoding: "gzip-base64",
      expandedBytes: bytes,
      content: compressed.toString("base64"),
    });

    if (Buffer.byteLength(body) <= MAX_STORED_ROOT_BYTES)
      records.push({
        key: projection.key,
        body,
        expiresAt: projection.expiresAt,
      });
  }

  return records;
}

function settled(row: TimelineRow): boolean {
  if ("status" in row && row.status === "pending") return false;

  if (row.kind === "turn")
    return row.children === null || row.children.every(settled);

  if (row.kind === "work" && row.workKind === "delegation")
    return row.childRows === null || row.childRows.every(settled);

  return true;
}

const STABLE_ROOT_EVENT_TYPES = new Set([
  "turn/started",
  "turn/completed",
  "turn/input/accepted",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/toolCall/progress",
  "item/mcpToolCall/progress",
]);

export function collectCompletedRootProjections(
  db: DbConnection,
  cache: TimelineRootCacheContext,
  rows: readonly TimelineRow[],
  events: readonly ThreadEventWithMeta[],
  fetchedTurnIds: ReadonlySet<string>,
  expiresAt: number | null,
  auxiliaryState: Pick<
    ReturnType<typeof buildThreadTimelineFromEvents>,
    "activeWorkflows" | "activeBackgroundCommands" | "activeThinking"
  >,
): CompletedRootProjection[] {
  const parents = new Map<string, string | null>();
  const itemOwners = new Map<string, string>();
  const completed = new Set<string>();
  const terminal = new Set<string>();

  for (const { event } of events) {
    if (event.scope.kind !== "turn") continue;

    if (event.type === "item/started" || event.type === "item/completed")
      itemOwners.set(event.item.id, event.scope.turnId);
  }

  for (const { event } of events) {
    if (event.scope.kind !== "turn") continue;

    if (event.type === "turn/started")
      parents.set(
        event.scope.turnId,
        event.parentToolCallId == null
          ? null
          : (itemOwners.get(event.parentToolCallId) ?? "missing-parent"),
      );

    if (event.type === "turn/completed") terminal.add(event.scope.turnId);

    if (event.type === "turn/completed" && event.status === "completed")
      completed.add(event.scope.turnId);
  }

  const roots = new Map<string, string>();

  for (const turnId of parents.keys()) {
    let current: string | null | undefined = turnId;
    const seen = new Set<string>();

    while (current !== null && current !== undefined && !seen.has(current)) {
      seen.add(current);
      const parent = parents.get(current);

      if (parent === null) {
        roots.set(turnId, current);
        break;
      }

      current = parent;
    }
  }

  const result: CompletedRootProjection[] = [];
  let expandedBytes = 0;

  for (const [rootTurnId, parent] of parents) {
    if (
      parent !== null ||
      !terminal.has(rootTurnId) ||
      cache.reused.has(rootTurnId)
    )
      continue;

    const turnIds = [...roots].flatMap(([id, root]) =>
      root === rootTurnId ? [id] : [],
    );

    const members = new Set(turnIds);

    if (turnIds.some((turnId) => !fetchedTurnIds.has(turnId))) continue;

    if (
      [
        ...auxiliaryState.activeWorkflows,
        ...auxiliaryState.activeBackgroundCommands,
      ].some((row) => row.turnId === null || members.has(row.turnId))
    )
      continue;

    const memberEvents = events.filter(
      ({ event }) =>
        event.scope.kind === "turn" && members.has(event.scope.turnId),
    );

    if (
      memberEvents.some(({ event }) => !STABLE_ROOT_EVENT_TYPES.has(event.type))
    )
      continue;

    const requestIds = memberEvents.flatMap(({ event }) =>
      event.type === "turn/input/accepted" ? [event.clientRequestId] : [],
    );

    const requestSet = new Set(requestIds);

    const requestSequences = new Set(
      events.flatMap(({ event, meta }) =>
        event.type === "client/turn/requested" &&
        requestSet.has(event.requestId)
          ? [meta.seq]
          : [],
      ),
    );

    const first = memberEvents.reduce(
      (min, { meta }) => Math.min(min, meta.seq),
      [...requestSequences].reduce((min, seq) => Math.min(min, seq), Infinity),
    );

    const last = memberEvents.reduce(
      (max, { meta }) => Math.max(max, meta.seq),
      0,
    );

    if (
      events.some(
        ({ event, meta }) =>
          meta.seq >= first &&
          meta.seq <= last &&
          (event.scope.kind === "turn"
            ? !members.has(event.scope.turnId)
            : event.type !== "thread/tokenUsage/updated" &&
              event.type !== "thread/contextWindowUsage/updated" &&
              !(
                event.type === "client/turn/requested" &&
                requestSet.has(event.requestId)
              )),
      )
    )
      continue;
    const pendingItems = new Set<string>();

    for (const { event } of memberEvents) {
      if (event.type === "item/started") pendingItems.add(event.item.id);

      if (event.type === "item/completed") pendingItems.delete(event.item.id);
    }

    const projected = rows.filter(
      (row) =>
        (row.turnId !== null && members.has(row.turnId)) ||
        (row.kind === "conversation" &&
          requestSequences.has(row.sourceSeqStart)),
    );

    if (projected.length === 0) continue;

    const revisioned =
      turnIds.some((id) => !completed.has(id)) ||
      pendingItems.size > 0 ||
      !projected.every(settled);

    if (revisioned && auxiliaryState.activeThinking !== null) continue;

    const identity = revisioned ? snapshotIdentity(db, cache) : cache.identity;

    const projection: CompletedRootProjection = {
      key: rootKey(identity, rootTurnId),
      ...(revisioned
        ? {
            snapshot: {
              maxSeq: cache.maxSeq,
              status: cache.status,
              interruptionSequence: cache.interruptionSequence ?? null,
            },
          }
        : {}),
      rootTurnId,
      turnIds,
      requestIds,
      sourceSeqStart: projected.reduce(
        (min, row) => Math.min(min, row.sourceSeqStart),
        first,
      ),
      sourceSeqEnd: projected.reduce(
        (max, row) => Math.max(max, row.sourceSeqEnd),
        last,
      ),
      rows: projected,
      expiresAt,
    };

    expandedBytes += Buffer.byteLength(JSON.stringify(projection));

    if (expandedBytes > MAX_EXPANDED_ROOT_BYTES) break;
    result.push(projection);
  }

  return result;
}
