import { advanceThreadPruning } from "../src/data/thread-pruning.js";
import {
  findEnvironmentPathClaim,
  listProviderLifecycleEnvironments,
  releaseFinishedEnvironmentPreparationOwners,
} from "../src/data/environments.js";
import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type ClientTurnRequestId,
} from "@omnyo/domain";
import {
  createConnection,
  type DbConnection,
  type SlowDbQueryLogger,
  type SlowDbQueryLogFields,
} from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { noopNotifier } from "../src/notifier.js";
import {
  createPendingInteraction,
  getPendingInteractionByProviderRequest,
} from "../src/data/pending-interactions.js";
import {
  appendDaemonEventsInTransaction,
  findLastCompletedRootStoredTurn,
  getFirstParentedTimelineBoundarySequence,
  getLatestStoredThreadEventOfTypes,
  getTimelineGroupingContextChangesInRange,
  hasStoredSpawnAgentToolCall,
  hasStoredTerminalClientTurnRequestEvent,
  listStoredEventRowsInSequenceRange,
  getLastStoredProviderThreadId,
  getLastStoredTurnRequestEvent,
  insertEvents,
  listActiveBackgroundTaskCountsByThreadIds,
  listItemEventSpansByItems,
  listLatestBackgroundTaskStateRowsByItemIds,
  listOpenTurnInputAcceptedRowsByThreadIds,
  listLatestThreadStateEventRowsByThreadIds,
  listLatestOpenBackgroundTaskStateRowsForThread,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  listStoredBufferedTextDeltaRowsByItems,
  listStoredClientTurnRequestIdsInRange,
  listStoredConversationOutlineEventRows,
  listStoredDelegatingItemRowsByItemIds,
  listStoredItemLifecycleRowsByItems,
  type ScopedItemRef,
  listStoredEventRows,
  listStoredEventRowsByParentToolCallIds,
  listStoredTurnCompletedKeys,
  listThreadEventSuffixBackgroundSettlementRows,
  listTodoSnapshotEventRowsForThread,
  pruneContextWindowUsageEventsInTransaction,
  pruneTokenUsageEventsInTransaction,
} from "../src/data/events.js";
import {
  MAX_COMPLETED_EVENT_OUTPUT_MIGRATION_EVENT_DATA_BYTES,
  migrateNextCompletedEventItemOutput,
  migrateNextLegacyImageGenerationOutput,
  pruneClosedSessions,
} from "../src/data/sweeps.js";
import { COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS } from "../src/retained-event-output.js";
import {
  deleteExpiredRetainedEventOutputs,
  hydrateRetainedEventOutputRows,
} from "../src/data/retained-event-outputs.js";
import { getDatabaseMaintenanceActivity } from "../src/data/maintenance.js";
import { replaceStoredProviderModelCatalog } from "../src/data/provider-model-catalogs.js";
import { openSession } from "../src/data/sessions.js";
import {
  listDueScheduledQueuedThreadMessages,
  listQueuedThreadMessagesByWaitHolder,
} from "../src/data/queued-thread-messages.js";
import { listEnvironments } from "../src/data/environments.js";
import { upsertHost } from "../src/data/hosts.js";
import { createProject } from "../src/data/projects.js";
import {
  createThread,
  listRunningThreads,
  listArchivedThreadsPendingTeardown,
  listThreadsWithPendingInteractionState,
} from "../src/data/threads.js";
import {
  countTerminalSessions,
  listTerminalSessions,
} from "../src/data/terminal-sessions.js";

type SqliteParameter = string | number | bigint | Buffer | null;

type LoggedSqlPredicate = (fields: SlowDbQueryLogFields) => boolean;

type CloseSessionAtParameters = ["closed", number, number, string];

interface CloseSessionAtArgs {
  closedAt: number;
  db: DbConnection;
  sessionId: string;
}

interface LoggedDebug {
  fields: SlowDbQueryLogFields;
  message: string;
}

interface QueryPlanRow {
  detail: string;
  id: number;
  notused: number;
  parent: number;
}

interface IndexNameRow {
  name: string;
}

interface IdentifiedRow {
  id: string;
}

interface TestDb {
  db: DbConnection;
  host: IdentifiedRow;
  logger: CapturingSlowQueryLogger;
  project: IdentifiedRow;
  thread: IdentifiedRow;
}

interface FindOnlyDebugLogArgs {
  logger: CapturingSlowQueryLogger;
  predicate: LoggedSqlPredicate;
}

interface QueryPlanDetailsArgs {
  db: DbConnection;
  params: readonly SqliteParameter[];
  sql: string;
}

interface AssertEmittedQueryPlanUsesIndexArgs {
  db: DbConnection;
  debugLog: LoggedDebug;
  indexName: string;
  params: readonly SqliteParameter[];
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  readonly debugLogs: LoggedDebug[] = [];

  info: SlowDbQueryLogger["info"] = (fields, message) => {
    this.debugLogs.push({ fields, message });
  };

  clear(): void {
    this.debugLogs.length = 0;
  }
}

function setup(): TestDb {
  const logger = new CapturingSlowQueryLogger();

  const db = createConnection(":memory:", {
    slowQueryLogger: logger,
    slowQueryThresholdMs: 0,
  });

  migrate(db);

  const host = upsertHost(db, noopNotifier, {
    name: "query-plan-host",
  });

  const { project } = createProject(db, noopNotifier, {
    name: "query-plan-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/query-plan" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  logger.clear();

  return { db, host, logger, project, thread };
}

function closeSessionAt(args: CloseSessionAtArgs): void {
  args.db.$client
    .prepare<CloseSessionAtParameters>(
      `
        UPDATE host_daemon_sessions
        SET status = ?, closed_at = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .run("closed", args.closedAt, args.closedAt, args.sessionId);
}

function findOnlyDebugLog(args: FindOnlyDebugLogArgs): LoggedDebug {
  const matches = args.logger.debugLogs.filter((debugLog) =>
    args.predicate(debugLog.fields),
  );

  expect(matches.map((debugLog) => debugLog.fields.sql)).toHaveLength(1);
  const debugLog = matches[0];

  if (!debugLog) {
    throw new Error("Expected one matching SQL debug log");
  }

  return debugLog;
}

interface CapturedStatement {
  params: SqliteParameter[];
  sql: string;
}

function captureStatements(
  db: DbConnection,
  run: () => void,
): CapturedStatement[] {
  const captured: CapturedStatement[] = [];
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      const originalAll = statement.all.bind(statement);
      const originalGet = statement.get.bind(statement);
      const originalRun = statement.run.bind(statement);
      statement.all = (...params: unknown[]) => {
        captured.push({ params: params as SqliteParameter[], sql: source });

        return originalAll(...params);
      };

      statement.get = (...params: unknown[]) => {
        captured.push({ params: params as SqliteParameter[], sql: source });

        return originalGet(...params);
      };

      statement.run = (...params: unknown[]) => {
        captured.push({ params: params as SqliteParameter[], sql: source });

        return originalRun(...params);
      };

      return statement;
    },
  });

  try {
    run();
  } finally {
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      writable: true,
      value: originalPrepare,
    });
  }

  return captured;
}

function queryPlanDetails(args: QueryPlanDetailsArgs): string {
  const planRows = args.db.$client
    .prepare<SqliteParameter[], QueryPlanRow>(`EXPLAIN QUERY PLAN ${args.sql}`)
    .all(...args.params);

  return planRows.map((row) => row.detail).join("\n");
}

function assertEmittedQueryPlanUsesIndex(
  args: AssertEmittedQueryPlanUsesIndexArgs,
): void {
  expect(args.debugLog.fields.bindingArgumentCount).toBe(args.params.length);

  const details = queryPlanDetails({
    db: args.db,
    params: args.params,
    sql: args.debugLog.fields.sql,
  });

  expect(
    details.includes(`USING INDEX ${args.indexName}`) ||
      details.includes(`USING COVERING INDEX ${args.indexName}`),
  ).toBe(true);
}

function expectNoThreadOnlyEventSeek(details: string): void {
  expect(details).not.toMatch(
    /USING (?:COVERING )?INDEX events_\w+ \(thread_id=\?\)$/mu,
  );
}

describe("slow query index plans", () => {
  it("seeks scoped lifecycle backfill without scanning unrelated chat history", () => {
    const { db, project, thread } = setup();

    try {
      const otherThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      const fixture = (
        sequence: number,
        scope: ReturnType<typeof turnScope> | ReturnType<typeof threadScope>,
        itemId: string,
        type:
          | "item/started"
          | "item/completed"
          | "item/backgroundTask/completed",
        threadId = thread.id,
      ) => ({
        threadId,
        sequence,
        scope,
        type,
        itemId,
        itemKind: "toolCall" as const,
        parentToolCallId: null,
        data: JSON.stringify({
          item: { id: itemId, result: `output-${sequence}` },
        }),
      });

      insertEvents(db, noopNotifier, [
        fixture(1, turnScope("turn-a"), "shared", "item/started"),
        fixture(2, turnScope("turn-a"), "shared", "item/completed"),
        fixture(3, turnScope("turn-b"), "shared", "item/started"),
        fixture(4, turnScope("turn-b"), "shared", "item/completed"),
        fixture(5, threadScope(), "shared", "item/started"),
        fixture(6, threadScope(), "shared", "item/completed"),
        fixture(
          7,
          turnScope("turn-a"),
          "shared",
          "item/backgroundTask/completed",
        ),
        fixture(8, turnScope("turn-a"), "other", "item/started"),
        fixture(9, turnScope("turn-a"), "other", "item/completed"),
        fixture(
          1,
          turnScope("turn-a"),
          "shared",
          "item/started",
          otherThread.id,
        ),
        ...Array.from({ length: 1000 }, (_, index) => ({
          threadId: thread.id,
          sequence: index + 100,
          scope: turnScope("unrelated"),
          type: "item/agentMessage/delta" as const,
          itemId: "unrelated-message",
          itemKind: null,
          parentToolCallId: null,
          data: '{"itemId":"unrelated-message","delta":"synthetic"}',
        })),
      ]);

      const shared = {
        itemId: "shared",
        scopeKind: "turn",
        turnId: "turn-a",
      } satisfies ScopedItemRef;

      const cases: { items: ScopedItemRef[]; sequences: number[] }[] = [
        {
          items: [shared, { ...shared, itemId: "other" }, shared],
          sequences: [1, 2, 8, 9],
        },
        {
          items: [
            shared,
            { itemId: "shared", scopeKind: "thread", turnId: null },
            shared,
          ],
          sequences: [1, 2, 5, 6],
        },
        { items: [{ ...shared, itemId: "missing" }], sequences: [] },
      ];

      for (const { items, sequences } of cases) {
        const captured = captureStatements(db, () => {
          const rows = listStoredItemLifecycleRowsByItems(db, {
            threadId: thread.id,
            items,
            maxInlineOutputChars: null,
          });

          expect(rows.map((row) => row.sequence)).toEqual(sequences);
        });

        expect(captured).toHaveLength(1);
        const details = queryPlanDetails({ db, ...captured[0]! });
        expect(details).toContain(
          "events_item_lifecycle_thread_item_sequence_idx (thread_id=? AND item_id=?)",
        );
        expectNoThreadOnlyEventSeek(details);
      }
    } finally {
      db.$client.close();
    }
  });

  it("seeks each buffered-delta item's turn instead of walking the thread", () => {
    const { db, project, thread } = setup();

    try {
      const otherThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      const fixture = (
        sequence: number,
        scope: ReturnType<typeof turnScope> | ReturnType<typeof threadScope>,
        itemId: string,
        type:
          | "item/started"
          | "item/completed"
          | "item/agentMessage/delta"
          | "item/plan/delta"
          | "item/reasoning/textDelta",
        threadId = thread.id,
      ) => ({
        threadId,
        sequence,
        scope,
        type,
        itemId,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId, delta: `delta-${sequence}` }),
      });

      insertEvents(db, noopNotifier, [
        fixture(1, turnScope("turn-1"), "item-1", "item/started"),
        fixture(2, turnScope("turn-1"), "item-1", "item/agentMessage/delta"),
        fixture(3, turnScope("turn-2"), "item-1", "item/agentMessage/delta"),
        fixture(4, turnScope("turn-2"), "item-2", "item/reasoning/textDelta"),
        fixture(5, threadScope(), "item-3", "item/plan/delta"),
        fixture(6, turnScope("turn-1"), "item-1", "item/completed"),
        fixture(11, turnScope("turn-1"), "item-1", "item/agentMessage/delta"),
        fixture(
          2,
          turnScope("turn-1"),
          "item-1",
          "item/agentMessage/delta",
          otherThread.id,
        ),
      ]);

      const items: ScopedItemRef[] = [
        { itemId: "item-1", scopeKind: "turn", turnId: "turn-1" },
        { itemId: "item-2", scopeKind: "turn", turnId: "turn-2" },
        { itemId: "item-3", scopeKind: "thread", turnId: null },
      ];

      const cases = [
        { items: items.slice(0, 1), sequences: [2] },
        { items, sequences: [2, 4, 5] },
      ];

      for (const { items: scopedItems, sequences } of cases) {
        const captured = captureStatements(db, () => {
          expect(
            listStoredBufferedTextDeltaRowsByItems(db, {
              beforeSequence: 10,
              items: scopedItems,
              threadId: thread.id,
            }).map((row) => row.sequence),
          ).toEqual(sequences);
        });

        expect(captured).toHaveLength(1);

        const searches = queryPlanDetails({ db, ...captured[0]! })
          .split("\n")
          .filter((detail) => detail.startsWith("SEARCH"));

        expect(searches).toEqual(
          scopedItems.map(
            () =>
              "SEARCH events USING INDEX events_thread_turn_type_item_sequence_idx (thread_id=? AND turn_id=? AND type=? AND item_id=? AND sequence<?)",
          ),
        );
      }
    } finally {
      db.$client.close();
    }
  });

  it("checks spawn-agent history without reading unrelated event payloads", () => {
    const { db, thread } = setup();

    try {
      const captured = captureStatements(db, () => {
        expect(hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
      });

      expect(captured).toHaveLength(1);
      expect(queryPlanDetails({ db, ...captured[0]! })).toContain(
        "USING INDEX events_delegating_item_lookup_idx (thread_id=?)",
      );
      db.$client
        .prepare(`INSERT INTO events
        (id, thread_id, scope_kind, sequence, type, item_kind, data, created_at)
        VALUES (?, ?, 'thread', ?, 'item/started', ?, ?, 0)`)
        .run(
          "ordinary-tool",
          thread.id,
          1,
          "toolCall",
          JSON.stringify({ item: { tool: "exec" } }),
        );
      expect(hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
      db.$client
        .prepare(`INSERT INTO events
        (id, thread_id, scope_kind, sequence, type, item_kind, data, created_at)
        VALUES (?, ?, 'thread', 3, 'item/completed', 'delegation', ?, 0)`)
        .run(
          "delegation",
          thread.id,
          JSON.stringify({ item: { tool: "spawnAgent" } }),
        );
      expect(hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
      db.$client
        .prepare(`INSERT INTO events
        (id, thread_id, scope_kind, sequence, type, item_kind, data, created_at)
        VALUES (?, ?, 'thread', ?, 'item/completed', ?, ?, 0)`)
        .run(
          "spawn-tool",
          thread.id,
          2,
          "toolCall",
          JSON.stringify({ item: { tool: "spawnAgent" } }),
        );
      expect(hasStoredSpawnAgentToolCall(db, thread.id)).toBe(true);
      expect(hasStoredSpawnAgentToolCall(db, "other-thread")).toBe(false);
      db.$client.prepare("DELETE FROM events WHERE id = ?").run("spawn-tool");
      expect(hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
    } finally {
      db.$client.close();
    }
  });

  it("resolves a provider session with two indexed lookups regardless of history length", () => {
    const { db, thread } = setup();

    try {
      insertEvents(
        db,
        noopNotifier,
        Array.from({ length: 50 }, (_, index) => ({
          threadId: thread.id,
          sequence: index + 1,
          scope: threadScope(),
          providerThreadId: "provider-owner-plan",
          type: "thread/identity" as const,
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ providerThreadId: "provider-owner-plan" }),
        })),
      );

      const captured = captureStatements(db, () => {
        expect(getLastStoredProviderThreadId(db, thread.id)).toBe(
          "provider-owner-plan",
        );
      });

      expect(captured).toHaveLength(2);
      const [identityQuery, ownerQuery] = captured;
      expect(queryPlanDetails({ db, ...identityQuery! })).toContain(
        "USING INDEX events_thread_type_sequence_idx",
      );
      expect(queryPlanDetails({ db, ...ownerQuery! })).toContain(
        "USING INDEX events_provider_identity_idx",
      );
    } finally {
      db.$client.close();
    }
  });

  it("finds the latest turn request by type without walking the turn's later events", () => {
    const { db, thread } = setup();

    try {
      const event = (
        sequence: number,
        type: "client/turn/requested" | "client/turn/start" | "item/completed",
        data: object,
      ) => ({
        threadId: thread.id,
        sequence,
        scope: threadScope(),
        type,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify(data),
      });

      insertEvents(db, noopNotifier, [
        event(1, "client/turn/requested", { requestId: "first" }),
        event(2, "client/turn/start", {
          input: [{ type: "text", text: "go" }],
        }),
        event(3, "client/turn/start", {}),
        ...Array.from({ length: 50 }, (_, index) =>
          event(index + 4, "item/completed", { text: "x".repeat(200) }),
        ),
      ]);

      const captured = captureStatements(db, () => {
        expect(getLastStoredTurnRequestEvent(db, thread.id)).toMatchObject({
          sequence: 2,
          type: "client/turn/start",
        });
      });

      expect(captured).toHaveLength(3);

      for (const query of captured) {
        const details = queryPlanDetails({ db, ...query });
        expect(details).toContain(
          "USING INDEX events_thread_type_sequence_idx (thread_id=? AND type=?)",
        );
        expectNoThreadOnlyEventSeek(details);
      }
    } finally {
      db.$client.close();
    }
  });

  it("seeks accepted inputs past each thread's latest interruption", () => {
    const { db, thread } = setup();

    try {
      const captured = captureStatements(db, () => {
        listOpenTurnInputAcceptedRowsByThreadIds(db, {
          threadIds: [thread.id, "missing"],
        });
      });

      expect(captured).toHaveLength(1);
      const query = captured[0]!;
      expect(queryPlanDetails({ db, ...query })).toContain(
        "events_thread_type_sequence_idx (thread_id=? AND type=? AND sequence>?)",
      );
    } finally {
      db.$client.close();
    }
  });

  it.each([null, "/tmp/claimed"])(
    "indexes active environment claims for path %s",
    (path) => {
      const { db } = setup();

      const captured = captureStatements(db, () => {
        expect(
          findEnvironmentPathClaim(db, "host_test", path, null),
        ).toBeNull();
      });

      expect(captured).toHaveLength(1);
      const query = captured[0]!;

      const details = queryPlanDetails({
        db,
        params: query.params,
        sql: query.sql,
      });

      expect(details).toContain("USING INDEX environments_claim_idx");
      expect(details).not.toContain("SCAN environments");
    },
  );

  it("finds due scheduled queued messages through the partial due index", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      expect(listDueScheduledQueuedThreadMessages(db, 1_000)).toEqual([]);
    });

    expect(captured).toHaveLength(1);

    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });

    expect(details).toMatch(/USING INDEX queued_thread_messages_due_idx/u);
    expect(details).not.toMatch(/SCAN queued_thread_messages/u);

    db.$client.close();
  });

  it("finds a plugin's held queued messages through the partial holder index", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      expect(
        listQueuedThreadMessagesByWaitHolder(db, "plugin:limiter"),
      ).toEqual([]);
    });

    expect(captured).toHaveLength(1);

    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });

    expect(details).toMatch(
      /USING INDEX queued_thread_messages_wait_holder_idx/u,
    );
    expect(details).not.toMatch(/SCAN queued_thread_messages/u);

    db.$client.close();
  });

  it("finds a provider's own environment through the provider/instance index", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      expect(
        listEnvironments(db, {
          environmentProviderId: "git-worktree",
          instanceKey: "thr_1",
          statuses: ["provisioning", "ready", "error"],
        }),
      ).toEqual([]);
    });

    expect(captured).toHaveLength(1);

    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });

    expect(details).toMatch(/USING INDEX environments_provider_instance_idx/u);
    expect(details).not.toMatch(/SCAN environments/u);

    db.$client.close();
  });

  it("finds the occupying threads through the archived/status index", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      listRunningThreads(db);
    });

    expect(captured).toHaveLength(1);

    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });

    expect(details).toMatch(/USING INDEX threads_archived_status_idx/u);
    expect(details).not.toMatch(/SCAN threads/u);

    db.$client.close();
  });

  it.each([
    { afterSequence: undefined, limit: 25, queryCount: 2 },
    { afterSequence: 20, limit: 25, queryCount: 2 },
    { afterSequence: 20, limit: undefined, queryCount: 1 },
  ])(
    "uses the thread/type/sequence index for filtered event pages after $afterSequence with limit $limit",
    ({ afterSequence, limit, queryCount }) => {
      const { db, thread } = setup();

      const captured = captureStatements(db, () => {
        expect(
          listStoredEventRows(db, {
            afterSequence,
            beforeSequence: 100,
            limit,
            order: "desc",
            threadId: thread.id,
            types: ["provider/error", "turn/completed"],
          }),
        ).toEqual([]);
      });

      expect(captured).toHaveLength(queryCount);

      for (const query of captured) {
        const details = queryPlanDetails({
          db,
          params: query.params,
          sql: query.sql,
        });

        expect(details).toMatch(/USING INDEX events_thread_type_sequence_idx/u);
        expect(details).not.toMatch(/events_thread_sequence_idx/u);
      }

      db.$client.close();
    },
  );

  it("looks up completed turns by thread and turn key", () => {
    const { db, thread } = setup();
    insertEvents(
      db,
      noopNotifier,
      ["turn-plan-1", "turn-plan-2", "turn-plan-3"].flatMap((turnId, index) => [
        {
          threadId: thread.id,
          sequence: index * 2 + 1,
          type: "turn/started" as const,
          scope: turnScope(turnId),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ providerThreadId: "provider-plan" }),
        },
        ...(turnId === "turn-plan-2"
          ? []
          : [
              {
                threadId: thread.id,
                sequence: index * 2 + 2,
                type: "turn/completed" as const,
                scope: turnScope(turnId),
                itemId: null,
                itemKind: null,
                parentToolCallId: null,
                data: JSON.stringify({
                  providerThreadId: "provider-plan",
                  status: "completed",
                }),
              },
            ]),
      ]),
    );

    const captured = captureStatements(db, () => {
      expect(
        listStoredTurnCompletedKeys(db, {
          keys: [
            { threadId: thread.id, turnId: "turn-plan-1" },
            { threadId: thread.id, turnId: "turn-plan-3" },
          ],
        }),
      ).toEqual([
        { threadId: thread.id, turnId: "turn-plan-1" },
        { threadId: thread.id, turnId: "turn-plan-3" },
      ]);
    });

    const fullChunkCaptured = captureStatements(db, () => {
      listStoredTurnCompletedKeys(db, {
        keys: Array.from({ length: 250 }, (_, index) => ({
          threadId: thread.id,
          turnId: `turn-plan-${index + 1}`,
        })),
      });
    });

    expect(captured).toHaveLength(1);
    expect(fullChunkCaptured).toHaveLength(1);

    for (const query of [captured[0]!, fullChunkCaptured[0]!]) {
      const details = queryPlanDetails({ db, ...query });
      expect(details).toContain("MULTI-INDEX OR");
      expect(details).toContain(
        "events_thread_turn_type_item_sequence_idx (thread_id=? AND turn_id=? AND type=?)",
      );
      expect(details).not.toContain("turn_id>?");
      expect(details).not.toMatch(/SCAN events/u);
    }

    db.$client.close();
  });

  it("loads daemon item lifecycle state through the targeted partial index", () => {
    const { db, thread } = setup();
    const turnId = "turn-lifecycle-plan";
    const itemId = "item-lifecycle-plan";

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope(turnId),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ providerThreadId: "provider-plan" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        scope: turnScope(turnId),
        itemId,
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider-plan",
          item: { type: "agentMessage", id: itemId, text: "done" },
        }),
      },
    ]);

    const captured = captureStatements(db, () => {
      db.transaction(
        (tx) =>
          appendDaemonEventsInTransaction(tx, [
            {
              threadId: thread.id,
              environmentId: null,
              type: "item/completed",
              scope: turnScope(turnId),
              itemId,
              itemKind: "agentMessage",
              parentToolCallId: null,
              providerThreadId: "provider-plan",
              data: JSON.stringify({
                providerThreadId: "provider-plan",
                item: { type: "agentMessage", id: itemId, text: "done" },
              }),
            },
          ]),
        { behavior: "immediate" },
      );
    });

    const lifecycleQueries = captured.filter((entry) =>
      entry.sql.includes("requested_item"),
    );

    expect(lifecycleQueries).toHaveLength(1);

    const [query] = lifecycleQueries;

    if (!query) {
      throw new Error("Expected the daemon item lifecycle SQL");
    }

    expect(query.params).toEqual([thread.id, itemId]);

    const details = queryPlanDetails({ db, ...query });

    expect(
      details.match(/events_item_lifecycle_thread_item_sequence_idx/gu),
    ).toHaveLength(2);
    expect(details).toContain(
      "SEARCH reopening USING INDEX events_background_task_thread_type_item_sequence_idx (thread_id=? AND type=? AND item_id=? AND sequence>?)",
    );
    expect(details).not.toMatch(/SCAN (?:lifecycle|candidate|reopening)/u);

    db.$client.close();
  });

  it("resolves root turn starts for the parented boundary through the turn index", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      expect(
        getFirstParentedTimelineBoundarySequence(db, {
          maxSeq: 10,
          sequenceStart: 0,
          threadId: thread.id,
        }),
      ).toBeNull();
    });

    const query = captured.find((entry) => entry.sql.includes("root_start"));

    if (!query) {
      throw new Error("Expected the parented timeline boundary SQL");
    }

    const details = queryPlanDetails({
      db,
      params: query.params,
      sql: query.sql,
    });

    expect(details).toMatch(
      /SEARCH root_start (?:EXISTS )?USING (?:COVERING )?INDEX events_thread_turn_type_item_sequence_idx \(thread_id=\? AND turn_id=\? AND type=\?\)/u,
    );
    expect(details).toMatch(
      /SEARCH events USING COVERING INDEX events_parent_tool_call_thread_parent_sequence_idx \(thread_id=\? AND parent_tool_call_id>\?\)/u,
    );
    expect(details.indexOf("SCAN nested_history")).toBeGreaterThanOrEqual(0);
    expect(details.indexOf("SCAN nested_history")).toBeLessThan(
      details.indexOf("INDEX events_delegating_item_lookup_idx"),
    );
    expect(details).toMatch(
      /SEARCH events USING (?:COVERING )?INDEX events_delegating_item_lookup_idx/u,
    );

    db.$client.close();
  });

  it.each([
    {
      name: "probes appended grouping-context rows",
      run: (db: DbConnection, threadId: string) =>
        getTimelineGroupingContextChangesInRange(db, {
          afterSequence: 10,
          threadId,
          throughSequence: 30,
        }),
    },
    {
      name: "lists rows in a sequence range",
      run: (db: DbConnection, threadId: string) =>
        listStoredEventRowsInSequenceRange(db, {
          afterSequence: 10,
          limit: 513,
          maxInlineOutputChars: 32_000,
          threadId,
          throughSequence: 30,
        }),
    },
  ])("$name through the thread sequence index", ({ run }) => {
    const { db, thread } = setup();

    const [query] = captureStatements(db, () => run(db, thread.id));

    if (!query) {
      throw new Error("Expected the sequence-range SQL");
    }

    expect(queryPlanDetails({ db, ...query }).split("\n")).toEqual([
      "SEARCH events USING INDEX events_thread_sequence_idx (thread_id=? AND sequence>? AND sequence<?)",
    ]);

    db.$client.close();
  });

  it("loads parented timeline rows through the normalized parent index", () => {
    const { db, thread } = setup();

    const [query] = captureStatements(db, () => {
      expect(
        listStoredEventRowsByParentToolCallIds(db, {
          maxInlineOutputChars: null,
          parentToolCallIds: ["parent-tool-call"],
          threadId: thread.id,
        }),
      ).toEqual([]);
    });

    if (!query) {
      throw new Error("Expected the parented timeline row lookup SQL");
    }

    expect(
      queryPlanDetails({ db, params: query.params, sql: query.sql }),
    ).toMatch(
      /SEARCH events USING INDEX events_parent_tool_call_thread_parent_sequence_idx/u,
    );

    db.$client.close();
  });

  it("seeks each missing delegating parent through the thread-and-item index", () => {
    const { db, thread } = setup();

    const lifecycle = [
      ["tool-a", "toolCall", "item/started"],
      ["delegation-b", "delegation", "item/started"],
      ["command-c", "commandExecution", "item/started"],
      ["tool-a", "toolCall", "item/completed"],
      ["command-c", "commandExecution", "item/completed"],
      ["delegation-b", "delegation", "item/completed"],
    ] as const;

    insertEvents(
      db,
      noopNotifier,
      lifecycle.map(([itemId, itemKind, type], index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type,
        scope: threadScope(),
        itemId,
        itemKind,
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: itemId, type: itemKind } }),
      })),
    );

    const delegatingRows = listStoredEventRowsInSequenceRange(db, {
      afterSequence: 0,
      limit: lifecycle.length,
      maxInlineOutputChars: 32_000,
      threadId: thread.id,
      throughSequence: lifecycle.length,
    }).filter((row) => row.itemKind !== "commandExecution");

    const [query] = captureStatements(db, () => {
      expect(
        listStoredDelegatingItemRowsByItemIds(db, {
          itemIds: ["delegation-b", "command-c", "tool-a"],
          maxInlineOutputChars: 32_000,
          threadId: thread.id,
        }),
      ).toEqual(delegatingRows);
    });

    if (!query) {
      throw new Error("Expected the delegating item lookup SQL");
    }

    expect(queryPlanDetails({ db, ...query })).toContain(
      "SEARCH events USING INDEX events_delegating_item_lookup_idx (thread_id=? AND item_id=?)",
    );

    db.$client.close();
  });

  it("seeks latest background-task and delegation state by item", () => {
    const { db, thread } = setup();

    const lifecycle = [
      ["bg-a", "backgroundTask", "item/started"],
      ["delegation-b", "delegation", "item/started"],
      ["bg-a", "backgroundTask", "item/backgroundTask/progress"],
      ["delegation-b", "delegation", "item/delegation/progress"],
      ["command-c", "commandExecution", "item/started"],
      ["bg-a", "backgroundTask", "item/backgroundTask/completed"],
      ["delegation-b", "delegation", "item/delegation/completed"],
    ] as const;

    insertEvents(
      db,
      noopNotifier,
      lifecycle.map(([itemId, itemKind, type], index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type,
        scope: threadScope(),
        itemId,
        itemKind,
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: itemId, type: itemKind } }),
      })),
    );

    const lookup = (beforeSequence?: number) =>
      listLatestBackgroundTaskStateRowsByItemIds(db, {
        beforeSequence,
        itemIds: ["delegation-b", "command-c", "bg-a"],
        threadId: thread.id,
      }).map((row) => [row.itemId, row.type]);

    const [query] = captureStatements(db, () => {
      expect(lookup()).toEqual([
        ["bg-a", "item/backgroundTask/completed"],
        ["delegation-b", "item/delegation/completed"],
      ]);
    });

    expect(lookup(6)).toEqual([
      ["bg-a", "item/backgroundTask/progress"],
      ["delegation-b", "item/delegation/progress"],
    ]);

    if (!query) {
      throw new Error("Expected the background-task state lookup SQL");
    }

    const details = queryPlanDetails({ db, ...query });
    expect(details).toContain(
      "SEARCH events USING COVERING INDEX events_background_task_thread_type_item_sequence_idx (thread_id=? AND type=? AND item_id=?)",
    );
    expect(details).toContain(
      "SEARCH events USING INDEX events_delegating_item_lookup_idx (thread_id=? AND item_id=?)",
    );
    expectNoThreadOnlyEventSeek(details);

    db.$client.close();
  });

  it("probes settled background tasks by item when listing open tasks", () => {
    const { db, host, thread } = setup();

    const lifecycle = [
      ["bg-open", "item/started"],
      ["bg-done", "item/started"],
      ["bg-open", "item/backgroundTask/progress"],
      ["bg-done", "item/backgroundTask/completed"],
    ] as const;

    insertEvents(
      db,
      noopNotifier,
      lifecycle.map(([itemId, type], index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type,
        scope: threadScope(),
        itemId,
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: itemId, type: "backgroundTask" } }),
      })),
    );

    const captured = captureStatements(db, () => {
      expect(
        listOpenBackgroundTaskItemRowsForThread(db, {
          threadId: thread.id,
        }).map((row) => row.itemId),
      ).toEqual(["bg-open"]);
      listOpenBackgroundTaskItemRowsForHost(db, { hostId: host.id });
    });

    expect(captured).toHaveLength(2);

    for (const query of captured) {
      const details = queryPlanDetails({ db, ...query });
      expect(details).toMatch(
        /SEARCH \w+_settlement USING COVERING INDEX events_background_task_thread_type_item_sequence_idx \(thread_id=\? AND type=\? AND item_id=\?\)/u,
      );
      expect(details).toMatch(
        /SEARCH \w+_reopening USING INDEX events_background_task_thread_type_item_sequence_idx \(thread_id=\? AND type=\? AND item_id=\? AND sequence>\?\)/u,
      );
      expectNoThreadOnlyEventSeek(details);
    }

    db.$client.close();
  });

  it("seeks each carried settlement's item events by thread and item", () => {
    const { db, thread } = setup();

    const itemEvent = (
      sequence: number,
      type:
        | "item/started"
        | "item/backgroundTask/progress"
        | "item/backgroundTask/completed"
        | "item/delegation/completed",
      itemId: string,
      itemKind: "backgroundTask" | "delegation" = "backgroundTask",
    ) => ({
      threadId: thread.id,
      sequence,
      type,
      scope: threadScope(),
      itemId,
      itemKind,
      parentToolCallId: null,
      data: JSON.stringify({
        providerThreadId: "provider-plan",
        item: {
          type: itemKind,
          id: itemId,
          status:
            type === "item/started" || type === "item/backgroundTask/progress"
              ? "pending"
              : "completed",
        },
      }),
    });

    insertEvents(db, noopNotifier, [
      itemEvent(1, "item/started", "task"),
      itemEvent(2, "item/started", "delegation", "delegation"),
      itemEvent(3, "item/started", "reopened-task"),
      itemEvent(4, "item/backgroundTask/completed", "reopened-task"),
      itemEvent(5, "item/backgroundTask/progress", "reopened-task"),
      itemEvent(6, "item/started", "settled-task"),
      itemEvent(7, "item/backgroundTask/completed", "settled-task"),
      itemEvent(8, "item/started", "suffix-reopened-task"),
      itemEvent(9, "item/delegation/completed", "delegation", "delegation"),
      itemEvent(10, "item/backgroundTask/completed", "task"),
      itemEvent(11, "item/backgroundTask/completed", "reopened-task"),
      itemEvent(12, "item/backgroundTask/completed", "settled-task"),
      itemEvent(13, "item/backgroundTask/completed", "suffix-reopened-task"),
      itemEvent(14, "item/backgroundTask/progress", "suffix-reopened-task"),
    ]);

    const captured = captureStatements(db, () => {
      expect(
        listThreadEventSuffixBackgroundSettlementRows(db, {
          threadId: thread.id,
          cutoffSequence: 9,
          oldMaxSequence: 14,
        }).map((row) => row.sequence),
      ).toEqual([9, 10, 11]);
    });

    const plans = captured.map((query) => queryPlanDetails({ db, ...query }));

    for (const details of plans) {
      expectNoThreadOnlyEventSeek(details);
    }

    const settlementSeek =
      "SEARCH events USING INDEX events_thread_type_sequence_idx (thread_id=? AND type=? AND sequence>? AND sequence<?)";

    const backgroundTaskItemSeek = expect.stringMatching(
      /^SEARCH \w+(?: EXISTS)? USING (?:COVERING )?INDEX events_background_task_thread_type_item_sequence_idx \(thread_id=\? AND type=\? AND item_id=\? AND sequence[<>]\?/u,
    );

    const delegationItemSeek = expect.stringMatching(
      /^SEARCH \w+(?: EXISTS)? USING (?:COVERING )?INDEX events_delegating_item_lookup_idx \(thread_id=\? AND item_id=\? AND sequence[<>]\?/u,
    );

    expect(
      plans.map((details) =>
        details.split("\n").filter((detail) => detail.startsWith("SEARCH")),
      ),
    ).toEqual([
      [settlementSeek, ...Array(5).fill(backgroundTaskItemSeek)],
      [settlementSeek, ...Array(3).fill(delegationItemSeek)],
    ]);

    db.$client.close();
  });

  it("finds a terminal client turn request event through the type index", () => {
    const { db, thread } = setup();
    const acceptedRequestId = encodeClientTurnRequestIdNumber({ value: 1 });
    const rejectedRequestId = encodeClientTurnRequestIdNumber({ value: 2 });
    const pendingRequestId = encodeClientTurnRequestIdNumber({ value: 3 });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/input/accepted",
        scope: turnScope("turn-1"),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ clientRequestId: acceptedRequestId }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/rejected",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: rejectedRequestId }),
      },
    ]);

    const has = (requestId: ClientTurnRequestId) =>
      hasStoredTerminalClientTurnRequestEvent(db, {
        requestId,
        threadId: thread.id,
      });

    const [query] = captureStatements(db, () => {
      expect(has(pendingRequestId)).toBe(false);
    });

    expect(has(acceptedRequestId)).toBe(true);
    expect(has(rejectedRequestId)).toBe(true);

    if (!query) {
      throw new Error("Expected the terminal client turn request SQL");
    }

    const details = queryPlanDetails({ db, ...query });
    expect(details).toContain(
      "SEARCH events USING INDEX events_thread_type_sequence_idx (thread_id=? AND type=?)",
    );
    expectNoThreadOnlyEventSeek(details);

    db.$client.close();
  });

  it("reads full background-task history from the partial index and then only appended events", () => {
    const { db, thread } = setup();

    const list = () =>
      listActiveBackgroundTaskCountsByThreadIds(db, {
        threadIds: [thread.id],
      });

    const appendTurnStarted = (sequence: number) =>
      insertEvents(db, noopNotifier, [
        {
          threadId: thread.id,
          sequence,
          type: "turn/started",
          scope: turnScope(`turn-count-cache-${sequence}`),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ providerThreadId: "provider-plan" }),
        },
      ]);

    const captured = captureStatements(db, () => {
      appendTurnStarted(1);
      list();
      list();
      appendTurnStarted(2);
      list();
    });

    const itemStateQueries = captured.filter((entry) =>
      entry.sql.includes("touched.item_id"),
    );

    const fullScans = itemStateQueries.filter((entry) =>
      entry.sql.includes(
        "SELECT DISTINCT item_id FROM events INDEXED BY events_background_task_thread_type_item_sequence_idx",
      ),
    );

    const appendedScans = itemStateQueries.filter((entry) =>
      entry.sql.includes(
        "SELECT DISTINCT item_id FROM events INDEXED BY events_thread_sequence_idx",
      ),
    );

    expect(itemStateQueries).toHaveLength(2);
    expect(fullScans).toHaveLength(1);
    expect(appendedScans).toHaveLength(1);

    const [fullScan] = fullScans;
    const [appendedScan] = appendedScans;

    if (!fullScan || !appendedScan) {
      throw new Error("Expected both background-task item state SQL shapes");
    }

    const fullDetails = queryPlanDetails({ db, ...fullScan });
    const appendedDetails = queryPlanDetails({ db, ...appendedScan });

    expect(fullDetails).toContain(
      "SEARCH events USING COVERING INDEX events_background_task_thread_type_item_sequence_idx (thread_id=? AND type=? AND item_id>?)",
    );
    expect(appendedDetails).toContain(
      "SEARCH events USING INDEX events_thread_sequence_idx (thread_id=? AND sequence>?)",
    );

    const stampQuery = captured.find(
      (entry) =>
        entry.sql.includes("thread_history_epochs") &&
        entry.sql.includes("json_each"),
    );

    if (!stampQuery) {
      throw new Error("Expected the thread event stamp SQL");
    }

    expect(queryPlanDetails({ db, ...stampQuery })).not.toMatch(
      /SCAN thread_history_epochs/u,
    );

    for (const details of [fullDetails, appendedDetails]) {
      expect(details).toContain(
        "SEARCH events USING COVERING INDEX events_background_task_thread_type_item_sequence_idx (thread_id=? AND type=? AND item_id=?)",
      );
      expect(details).toContain(
        "SEARCH active_event USING INDEX events_thread_sequence_idx (thread_id=? AND sequence=?)",
      );
      expect(details).not.toMatch(/SCAN events|SCAN active_event/u);
    }

    db.$client.close();
  });

  it("uses selective indexes for conversation-outline events", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      listStoredConversationOutlineEventRows(db, {
        sequenceStart: 0,
        threadId: thread.id,
      });
    });

    const outline = captured.filter((query) =>
      query.sql.includes('from "events"'),
    );

    expect(outline).toHaveLength(1);
    const [query] = outline;
    expect(query?.params).toEqual([
      thread.id,
      0,
      "client/turn/requested",
      "client/turn/rejected",
      "turn/input/accepted",
      "turn/started",
      "turn/completed",
      "system/manager/user_message",
      "system/thread/interrupted",
      "system/error",
      "provider/error",
      "item/agentMessage/delta",
      "item/plan/delta",
      thread.id,
      0,
      "item/completed",
      "agentMessage",
      "plan",
      thread.id,
      0,
      "item/started",
      "item/completed",
      "item/backgroundTask/progress",
      "item/backgroundTask/completed",
      "item/delegation/progress",
      "item/delegation/completed",
      "backgroundTask",
      "delegation",
      "toolCall",
      "delegation",
      "item/started",
    ]);

    const details = queryPlanDetails({
      db,
      params: query?.params ?? [],
      sql: query?.sql ?? "",
    });

    expect(
      details.match(/USING INDEX events_thread_type_sequence_idx/gu),
    ).toHaveLength(1);
    expect(
      details.match(/USING INDEX events_thread_type_item_kind_sequence_idx/gu),
    ).toHaveLength(2);
    expect(details).toMatch(
      /USING INDEX events_item_lifecycle_thread_item_sequence_idx/u,
    );
    expect(details).toMatch(
      /USING COVERING INDEX events_background_task_thread_type_item_sequence_idx/u,
    );
    expect(details).not.toMatch(/SCAN events/u);

    db.$client.close();
  });

  it("loads the newest plan snapshot through the kind-based plan-steps index", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      expect(
        listTodoSnapshotEventRowsForThread(db, { threadId: thread.id }),
      ).toEqual([]);
    });

    const query = captured.find((entry) => entry.sql.includes("planSteps"));

    if (!query) {
      throw new Error("Expected the plan snapshot SQL");
    }

    expect(query.sql).not.toContain("json_extract");
    expect(query.sql).not.toContain("tool_name");
    expect(query.params).toEqual([thread.id, 1]);
    expect(
      queryPlanDetails({ db, params: query.params, sql: query.sql }),
    ).toContain("events_plan_steps_thread_sequence_idx");

    db.$client.close();
  });

  it.each([
    {
      name: "getLatestStoredThreadEventOfTypes",
      run: (db: DbConnection, threadId: string) =>
        getLatestStoredThreadEventOfTypes(db, {
          afterSequence: 0,
          threadId,
          types: ["system/thread/interrupted", "turn/started"],
        }),
      plan: [
        "SEARCH events USING INDEX events_thread_type_sequence_idx (thread_id=? AND type=? AND sequence>?)",
      ],
    },
    {
      name: "listStoredClientTurnRequestIdsInRange",
      run: (db: DbConnection, threadId: string) =>
        listStoredClientTurnRequestIdsInRange(db, {
          seqEnd: 10,
          seqStart: 1,
          threadId,
        }),
      plan: [
        "SEARCH events USING INDEX events_thread_type_sequence_idx (thread_id=? AND type=? AND sequence>? AND sequence<?)",
      ],
    },
    {
      name: "findLastCompletedRootStoredTurn",
      run: (db: DbConnection, threadId: string) =>
        findLastCompletedRootStoredTurn(db, { threadId }),
      plan: [
        "SEARCH events USING INDEX events_thread_type_sequence_idx (thread_id=? AND type=?)",
        "SEARCH completed USING COVERING INDEX events_thread_turn_type_item_sequence_idx (thread_id=? AND turn_id=? AND type=?)",
      ],
    },
  ])(
    "$name seeks its event types instead of walking the thread",
    (testCase) => {
      const { db, thread } = setup();

      const captured = captureStatements(db, () => {
        testCase.run(db, thread.id);
      });

      expect(captured).toHaveLength(1);
      const [query] = captured;

      if (!query) {
        throw new Error(`Expected the ${testCase.name} SQL`);
      }

      const details = queryPlanDetails({ db, ...query }).split("\n");
      expect(
        details.filter((line) => !line.startsWith("USE TEMP B-TREE")),
      ).toEqual(testCase.plan);

      db.$client.close();
    },
  );

  it("resolves open background-task state without per-row subqueries", () => {
    const { db, thread } = setup();

    const [query] = captureStatements(db, () => {
      listLatestOpenBackgroundTaskStateRowsForThread(db, {
        threadId: thread.id,
      });
    });

    if (!query) throw new Error("Expected the open background-task lookup SQL");

    const params = [
      thread.id,
      thread.id,
      "backgroundTask",
      "item/started",
      "item/backgroundTask/progress",
      "item/backgroundTask/completed",
      "item/started",
      "item/backgroundTask/progress",
    ];

    expect(query.params).toEqual(params);

    const details = queryPlanDetails({ db, ...query });

    expect(details).toContain(
      "events_background_task_thread_type_item_sequence_idx",
    );
    expect(details).not.toMatch(/CORRELATED/);
    expectNoThreadOnlyEventSeek(details);

    db.$client.close();
  });

  it("uses the closed-session prune index for emitted delete SQL", () => {
    const { db, host, logger } = setup();
    const now = Date.now();

    const staleSession = openSession(db, {
      hostId: host.id,
      instanceId: "closed-prune-query-plan",
      hostName: "query-plan-host",
      dataDir: "/tmp/query-plan-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const closedBefore = now - 5_000;
    closeSessionAt({
      closedAt: now - 10_000,
      db,
      sessionId: staleSession.id,
    });
    logger.clear();

    pruneClosedSessions(db, { closedBefore, limit: 100 });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("DELETE FROM host_daemon_sessions"),
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "host_daemon_sessions_closed_prune_idx",
      params: ["closed", closedBefore, 100],
    });
    db.$client.close();
  });

  it("skips removed environments in the provider lifecycle sweep", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      expect(
        listProviderLifecycleEnvironments(db, "git-worktree", {
          pluginId: "environment-git-worktree",
          teardownMessage: "blocked",
        }),
      ).toEqual([]);
    });

    expect(captured).toHaveLength(1);

    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });

    expect(details).toContain(
      "USING INDEX environments_provider_lifecycle_idx",
    );
    expect(details).not.toContain("SCAN environments");
    db.$client.close();
  });

  it("releases preparation owners through the owner index", () => {
    const { db, logger } = setup();
    releaseFinishedEnvironmentPreparationOwners(db);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith('update "environments" set "owner_thread_id"'),
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "environments_owner_thread_idx",
      params: [null, "removed"],
    });
    db.$client.close();
  });

  it("uses the provider request index for pending interaction lookups", () => {
    const { db, logger, thread } = setup();
    createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-provider-request-query-plan",
      providerId: "codex",
      providerThreadId: "provider-thread-query-plan",
      providerRequestId: "request-query-plan",
      payload: "{}",
    });
    logger.clear();

    expect(
      getPendingInteractionByProviderRequest(db, {
        providerId: "codex",
        providerThreadId: "provider-thread-query-plan",
        providerRequestId: "request-query-plan",
      }),
    ).toMatchObject({
      threadId: thread.id,
    });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.includes('from "pending_interactions"') &&
        fields.sql.includes('"provider_request_id" = ?'),
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "pending_interactions_provider_request_idx",
      params: [
        "provider",
        "codex",
        "provider-thread-query-plan",
        "request-query-plan",
      ],
    });

    db.$client.close();
  });

  it.each([
    ["agentMessage", "item/agentMessage/delta"],
    ["reasoning", "item/reasoning/textDelta"],
  ] as const)(
    "does not parse %s completion payloads for retention support",
    (itemKind, deltaType) => {
      const { db, thread } = setup();

      try {
        insertEvents(
          db,
          noopNotifier,
          [1, 2, 3].map((sequence) => ({
            data: "{}",
            itemId: "item",
            itemKind: sequence === 3 ? itemKind : null,
            parentToolCallId: null,
            scope: turnScope("support-turn"),
            sequence,
            threadId: thread.id,
            type: sequence === 3 ? "item/completed" : deltaType,
          })),
        );

        const statements = captureStatements(db, () => {
          expect(advanceThreadPruning(db, "resolved-items").removed).toBe(1);
        });

        const supportQueries = statements.filter((statement) =>
          /from events indexed by events_thread_turn_type_item_sequence_idx/i.test(
            statement.sql,
          ),
        );

        expect(supportQueries.length).toBeGreaterThan(0);

        for (const statement of supportQueries) {
          const instructions = db.$client
            .prepare<SqliteParameter[], { p4: string | null }>(
              `EXPLAIN ${statement.sql}`,
            )
            .all(...statement.params);

          expect(instructions.some((row) => row.p4?.startsWith("json_"))).toBe(
            false,
          );
        }
      } finally {
        db.$client.close();
      }
    },
  );

  it("discovers archived teardown work without walking archived thread history", () => {
    const { db } = setup();

    try {
      const captured = captureStatements(db, () => {
        listArchivedThreadsPendingTeardown(db);
      });

      const statement = captured[0]!;
      const details = queryPlanDetails({ db, ...statement });
      expect(details).toMatch(/SEARCH threads USING INDEX \S+ \(status=\?\)/);
      expect(details).toContain(
        "SEARCH threads USING INDEX sqlite_autoindex_threads_1 (id=?)",
      );
      expect(details).not.toContain("CORRELATED SCALAR SUBQUERY");
      expect(details).not.toContain("SCAN threads");
      expect(details).not.toContain("SCAN terminal_sessions");
    } finally {
      db.$client.close();
    }
  });

  it("lists live terminals without walking exited session history", () => {
    const { db } = setup();

    try {
      const statements = captureStatements(db, () => {
        listTerminalSessions(db, { scope: { kind: "all" }, visible: true });
      });

      const details = queryPlanDetails({ db, ...statements[0]! });
      expect(details).not.toContain("SCAN terminal_sessions");
      expect(details).toMatch(
        /SEARCH terminal_sessions USING INDEX \S+ \(status=\?\)/,
      );
    } finally {
      db.$client.close();
    }
  });

  it("counts standalone terminals by host and live status", () => {
    const { db, host } = setup();

    try {
      const statements = captureStatements(db, () => {
        countTerminalSessions(db, {
          scope: { kind: "host-path", hostId: host.id, cwd: null },
          visible: true,
        });
      });

      const details = queryPlanDetails({ db, ...statements[0]! });
      expect(details).not.toContain("SCAN terminal_sessions");
      expect(details).toMatch(
        /SEARCH terminal_sessions USING INDEX \S+ \(host_id=\? AND status=\?\)/,
      );
    } finally {
      db.$client.close();
    }
  });

  it("uses the active-thread maintenance index for emitted idle checks", () => {
    const { db, logger } = setup();
    logger.clear();

    const statements = captureStatements(db, () => {
      getDatabaseMaintenanceActivity(db);
    });

    expect(statements).toHaveLength(1);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.includes('from "threads"') &&
        fields.sql.includes('"threads"."deleted_at" is null'),
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "threads_active_maintenance_idx",
      params: statements[0]!.params,
    });

    db.$client.close();
  });

  it("uses the thread and sequence index for search segment suffix deletes", () => {
    const { db } = setup();

    const details = queryPlanDetails({
      db,
      params: ["thread-query-plan", 10, 20],
      sql: `
        DELETE FROM thread_search_segments
        WHERE thread_id = ?
          AND source_seq >= ?
          AND source_seq <= ?
      `,
    });

    expect(details).toMatch(
      /USING (?:COVERING )?INDEX thread_search_segments_thread_source_seq_idx/,
    );
    expect(details).not.toContain("SCAN thread_search_segments");

    db.$client.close();
  });

  it("uses selective indexes for completed output migration cursor and event scans", () => {
    const { db, logger, thread } = setup();
    const createdBefore = Date.now();

    const commandOutput =
      "command-head-" +
      "a".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-command-tail";

    insertEvents(db, noopNotifier, [
      {
        createdAt: createdBefore - 10_000,
        data: JSON.stringify({
          item: {
            aggregatedOutput: commandOutput,
            id: "cmd-truncation-query-plan",
            type: "commandExecution",
          },
        }),
        itemId: "cmd-truncation-query-plan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        scope: turnScope("turn_truncation_query_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);

    const insertedEvent = db.$client
      .prepare<[string, number], IdentifiedRow>(
        "SELECT id FROM events WHERE thread_id = ? AND sequence = ?",
      )
      .get(thread.id, 1);

    if (!insertedEvent) {
      throw new Error("Expected completed output query-plan event");
    }

    logger.clear();

    migrateNextCompletedEventItemOutput(db, {
      itemKind: "commandExecution",
      limit: 10,
      migratedAt: createdBefore,
      outputPath: "aggregatedOutput",
    });

    const cursorDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('from "maintenance_scan_cursors"') &&
        fields.bindingArgumentCount === 2,
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: cursorDebugLog,
      indexName: "sqlite_autoindex_maintenance_scan_cursors_1",
      params: [
        "legacy_completed_event_output_sidecar:v1:commandExecution:aggregatedOutput",
        "legacy_completed_event_output_sidecar_window:v1:commandExecution:aggregatedOutput",
      ],
    });

    const scanDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.startsWith("SELECT id, created_at FROM events") &&
        fields.sql.includes("ORDER BY created_at, id") &&
        fields.bindingArgumentCount === 6,
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: scanDebugLog,
      indexName: "events_completed_item_truncation_idx",
      params: ["item/completed", "commandExecution", createdBefore, 0, "", 10],
    });

    const candidateDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.startsWith(
          "SELECT id, created_at, created_at AS scan_created_at, data, thread_id FROM events",
        ) &&
        fields.bindingArgumentCount === 14,
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: candidateDebugLog,
      indexName: "events_completed_item_truncation_idx",
      params: [
        "item/completed",
        "commandExecution",
        createdBefore,
        0,
        "",
        createdBefore - 10_000,
        insertedEvent.id,
        MAX_COMPLETED_EVENT_OUTPUT_MIGRATION_EVENT_DATA_BYTES,
        "$.item.aggregatedOutput",
        "$.item.truncation.aggregatedOutput",
        "$.item.type",
        "commandExecution",
        "$.item.aggregatedOutput",
        COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
      ],
    });

    db.$client.close();
  });

  it("bounds legacy image generation migration with the event primary key", () => {
    const { db, logger, thread } = setup();
    const migratedAt = Date.now();
    insertEvents(db, noopNotifier, [
      {
        createdAt: migratedAt - 10_000,
        data: JSON.stringify({
          providerId: "codex",
          rawType: "item/completed",
          rawEvent: {
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              item: {
                failure: null,
                id: "legacy-image-query-plan",
                result: "i".repeat(
                  COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1,
                ),
                revisedPrompt: "Draw an indexed image",
                savedPath: "/tmp/indexed.png",
                status: "completed",
                transparentBackground: false,
                type: "imageGeneration",
              },
            },
          },
        }),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        scope: turnScope("turn_legacy_image_query_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "provider/unhandled",
      },
    ]);

    const insertedEvent = db.$client
      .prepare<[string, number], IdentifiedRow>(
        "SELECT id FROM events WHERE thread_id = ? AND sequence = ?",
      )
      .get(thread.id, 1);

    if (!insertedEvent) {
      throw new Error("Expected legacy image generation query-plan event");
    }

    logger.clear();

    migrateNextLegacyImageGenerationOutput(db, {
      limit: 10,
      migratedAt,
    });

    const scanDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.startsWith("SELECT id, 0 AS created_at FROM events") &&
        fields.sql.includes("ORDER BY id") &&
        fields.bindingArgumentCount === 2,
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: scanDebugLog,
      indexName: "sqlite_autoindex_events_1",
      params: ["", 10],
    });

    const candidateDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.startsWith(
          "SELECT id, created_at, 0 AS scan_created_at, data, thread_id FROM events",
        ) &&
        fields.bindingArgumentCount === 9,
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: candidateDebugLog,
      indexName: "sqlite_autoindex_events_1",
      params: [
        "",
        insertedEvent.id,
        "provider/unhandled",
        migratedAt,
        MAX_COMPLETED_EVENT_OUTPUT_MIGRATION_EVENT_DATA_BYTES,
        "item/completed",
        "item/completed",
        "imageGeneration",
        COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
      ],
    });

    db.$client.close();
  });

  it("uses the retained-output primary key for hydration", () => {
    const { db, logger, thread } = setup();
    const now = 1_800_000_000_000;
    insertEvents(db, noopNotifier, [
      {
        createdAt: now,
        data: JSON.stringify({
          item: {
            aggregatedOutput: "x".repeat(
              COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1,
            ),
            id: "retained-hydration-plan",
            type: "commandExecution",
          },
        }),
        itemId: "retained-hydration-plan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        scope: turnScope("turn_retained_hydration_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    const [stored] = listStoredEventRows(db, { threadId: thread.id });

    if (!stored) {
      throw new Error("Expected retained hydration event");
    }

    logger.clear();

    hydrateRetainedEventOutputRows(db, [stored], now);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('from "retained_event_outputs"') &&
        fields.sql.includes('"event_id" in'),
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "sqlite_autoindex_retained_event_outputs_1",
      params: [stored.id, now],
    });

    db.$client.close();
  });

  it("uses the expiry and primary-key indexes for bounded cleanup", () => {
    const { db, logger, thread } = setup();
    const now = 1_800_000_000_000;
    insertEvents(db, noopNotifier, [
      {
        createdAt: now,
        data: JSON.stringify({
          item: {
            aggregatedOutput: "x".repeat(
              COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1,
            ),
            id: "retained-expiry-plan",
            type: "commandExecution",
          },
        }),
        itemId: "retained-expiry-plan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        scope: turnScope("turn_retained_expiry_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    const [stored] = listStoredEventRows(db, { threadId: thread.id });

    if (!stored) {
      throw new Error("Expected retained expiry event");
    }

    const expiredAtOrBefore = Number.MAX_SAFE_INTEGER;
    logger.clear();

    deleteExpiredRetainedEventOutputs(db, {
      expiredAtOrBefore,
      limit: 1,
    });

    const selection = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('from "retained_event_outputs"') &&
        fields.sql.includes('order by "retained_event_outputs"."expires_at"'),
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: selection,
      indexName: "retained_event_outputs_expiry_idx",
      params: [expiredAtOrBefore, 1],
    });

    const deletion = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith('delete from "retained_event_outputs"'),
    });

    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: deletion,
      indexName: "sqlite_autoindex_retained_event_outputs_1",
      params: [stored.id],
    });

    db.$client.close();
  });

  it("pins maintenance discovery to the typed sequence index", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/diff/updated",
        scope: turnScope("pruning-turn"),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: "{}",
        createdAt: 1,
      },
    ]);

    const statements = captureStatements(db, () => {
      advanceThreadPruning(db, "turn-diffs");
    });

    const discovery = statements.find((statement) =>
      statement.sql.includes(
        "FROM events INDEXED BY events_thread_type_sequence_idx",
      ),
    );

    expect(discovery).toBeDefined();

    if (!discovery) throw new Error("Missing maintenance discovery query");
    expect(queryPlanDetails({ db, ...discovery })).toContain(
      "USING INDEX events_thread_type_sequence_idx",
    );
    expect(discovery.sql).toContain("LIMIT ?");
    db.$client.close();
  });

  it("bounds delta support probes with the consolidated scope index", () => {
    const { db, logger, thread } = setup();
    const turnId = "turn_resolved_delta_query_plan";
    const itemId = "call_resolved_delta_query_plan";
    insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({ output: "first", parentToolCallId: "parent" }),
        itemId,
        itemKind: null,
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 1,
        threadId: thread.id,
        type: "item/commandExecution/outputDelta",
      },
      {
        data: JSON.stringify({ output: "second", parentToolCallId: "parent" }),
        itemId,
        itemKind: null,
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 2,
        threadId: thread.id,
        type: "item/commandExecution/outputDelta",
      },
      {
        data: JSON.stringify({
          item: {
            aggregatedOutput: "firstsecond",
            id: itemId,
            parentToolCallId: "parent",
            type: "commandExecution",
          },
        }),
        itemId,
        itemKind: "commandExecution",
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 3,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    logger.clear();

    const statements = captureStatements(db, () => {
      expect(advanceThreadPruning(db, "resolved-items").removed).toBe(1);
    });

    const discovery = statements.find((statement) =>
      statement.sql.includes("WITH candidate_ids AS MATERIALIZED"),
    );

    if (!discovery) throw new Error("Missing typed delta candidate discovery");
    const discoveryPlan = queryPlanDetails({ db, ...discovery });
    expect(
      discoveryPlan.match(
        /USING COVERING INDEX events_thread_type_sequence_idx/gu,
      ),
    ).toHaveLength(4);
    expect(discoveryPlan).toContain("USING INTEGER PRIMARY KEY (rowid=?)");
    expect(discoveryPlan).not.toContain("events_thread_sequence_idx");

    const supportQueries = statements.filter((statement) =>
      /from events indexed by events_thread_turn_type_item_sequence_idx/i.test(
        statement.sql,
      ),
    );

    expect(supportQueries.length).toBeGreaterThan(0);

    for (const statement of supportQueries) {
      expect(queryPlanDetails({ db, ...statement })).toContain(
        "USING INDEX events_thread_turn_type_item_sequence_idx",
      );
      expect(statement.sql).toMatch(/LIMIT \?/i);
    }

    const pruneQuery = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("DELETE FROM events"),
    });

    expect(pruneQuery.fields.sql).toContain("WHERE id IN");
    expect(pruneQuery.fields.bindingArgumentCount).toBeLessThanOrEqual(500);
    expect(pruneQuery.fields.sql).not.toContain("json_extract");

    db.$client.close();
  });

  it("discovers token usage keepers without reading payloads or computing unused byte totals", () => {
    const { db, thread } = setup();

    try {
      insertEvents(
        db,
        noopNotifier,
        [1, 2].map((sequence) => ({
          data: JSON.stringify({ tokenUsage: { modelContextWindow: 200000 } }),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          scope: turnScope("usage-turn"),
          sequence,
          threadId: thread.id,
          type: "thread/tokenUsage/updated" as const,
        })),
      );
      advanceThreadPruning(db, "usage");
      advanceThreadPruning(db, "usage");

      const statements = captureStatements(db, () => {
        const result = advanceThreadPruning(db, "usage");
        expect(result.scanned).toBe(2);
        expect(result.removed).toBe(0);
        expect(result.removedBytes).toBe(0);
        expect(result.cursor.latestRootSequence).toBe(2);
      });

      for (const statement of statements) {
        const instructions = db.$client
          .prepare<SqliteParameter[], { p4: string | null }>(
            `EXPLAIN ${statement.sql}`,
          )
          .all(...statement.params);

        expect(
          instructions.filter((row) => /^(json_|sum\()/u.test(row.p4 ?? "")),
        ).toEqual([]);
      }
    } finally {
      db.$client.close();
    }
  });

  it.each([
    {
      eventType: "thread/contextWindowUsage/updated" as const,
      prune: pruneContextWindowUsageEventsInTransaction,
    },
    {
      eventType: "thread/tokenUsage/updated" as const,
      prune: pruneTokenUsageEventsInTransaction,
    },
  ])(
    "bounds the outer $eventType deletion to candidate primary keys",
    ({ eventType, prune }) => {
      const { db, thread } = setup();

      try {
        insertEvents(
          db,
          noopNotifier,
          Array.from({ length: 32 }, (_, index) => ({
            data: "{}",
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            scope: turnScope("usage-delete-plan"),
            sequence: index + 1,
            threadId: thread.id,
            type: eventType,
          })),
        );
        const rows = listStoredEventRows(db, { threadId: thread.id });

        const statements = captureStatements(db, () => {
          expect(
            prune(db, {
              afterSequence: 0,
              candidateIds: rows.map((row) => row.id),
              threadId: thread.id,
              throughSequence: 32,
              usageKeepers: {
                latestContextSequence: 0,
                latestRootSequence: 31,
              },
            }),
          ).toBe(30);
        });

        expect(
          listStoredEventRows(db, { threadId: thread.id }).map(
            (row) => row.sequence,
          ),
        ).toEqual([31, 32]);

        const deletion = statements.find((statement) =>
          statement.sql.startsWith("DELETE FROM events"),
        );

        if (!deletion) throw new Error("Missing usage snapshot deletion");

        const plan = db.$client
          .prepare<SqliteParameter[], QueryPlanRow>(
            `EXPLAIN QUERY PLAN ${deletion.sql}`,
          )
          .all(...deletion.params);

        expect(
          plan.find(
            (row) =>
              row.parent === 0 && row.detail.startsWith("SEARCH events "),
          )?.detail,
        ).toBe("SEARCH events USING INDEX sqlite_autoindex_events_1 (id=?)");
      } finally {
        db.$client.close();
      }
    },
  );

  it("rescans only state rows newer than the cached scan watermark", () => {
    const { db, project, thread } = setup();

    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const stateEvents = (sequenceStart: number) =>
      [thread, otherThread].flatMap((stateThread, threadIndex) =>
        Array.from({ length: 64 }, (_, index) => ({
          data: JSON.stringify(
            index === 0 && sequenceStart === 1
              ? { goal: `goal-${threadIndex}` }
              : { kind: "other-plugin/state", payload: { index } },
          ),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          scope: threadScope(),
          sequence: sequenceStart + index,
          threadId: stateThread.id,
          type:
            index === 0 && sequenceStart === 1
              ? ("thread/goal/updated" as const)
              : ("thread/extensionState/updated" as const),
        })),
      );

    insertEvents(db, noopNotifier, stateEvents(1));

    const lookup = () =>
      captureStatements(db, () => {
        expect(
          listLatestThreadStateEventRowsByThreadIds(db, {
            threadIds: [thread.id, otherThread.id],
            kind: "provider-codex/goal",
          }).map((row) => row.sequence),
        ).toEqual([1, 1]);
      }).find((entry) => entry.sql.includes("after_sequence"));

    const cold = lookup();

    insertEvents(db, noopNotifier, stateEvents(65));

    const warm = lookup();

    if (!cold || !warm) {
      throw new Error("Expected the latest-thread-state scan SQL");
    }

    expect(cold.params).toContain(
      JSON.stringify([
        [thread.id, -1],
        [otherThread.id, -1],
      ]),
    );
    expect(warm.params).toContain(
      JSON.stringify([
        [thread.id, 64],
        [otherThread.id, 64],
      ]),
    );

    const details = queryPlanDetails({
      db,
      params: warm.params,
      sql: warm.sql,
    });

    expect(
      details.match(
        /USING (?:COVERING )?INDEX events_thread_state_thread_sequence_idx \(thread_id=\? AND sequence>\?\)/gu,
      ),
    ).toHaveLength(1);
    expect(details).not.toMatch(
      /USING (?:COVERING )?INDEX events_thread_sequence_idx/u,
    );
    expect(details).not.toContain("USE TEMP B-TREE");

    db.$client.close();
  });

  it("serves the thread-list pending probe from its covering index without a GROUP BY sort", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      listThreadsWithPendingInteractionState(db, { includeHidden: false });
    });

    const statement = captured.find(
      (entry) =>
        entry.sql.includes('from "threads"') &&
        entry.sql.includes("pending_interactions"),
    );

    if (!statement) {
      throw new Error("Expected the thread-list SQL");
    }

    const details = queryPlanDetails({
      db,
      params: statement.params,
      sql: statement.sql,
    });

    expect(details).toContain(
      "USING COVERING INDEX pending_interactions_thread_status_created_idx",
    );
    expect(details).not.toContain("USE TEMP B-TREE FOR GROUP BY");

    db.$client.close();
  });

  it("drops redundant events indexes after creating their consolidated replacement", () => {
    const { db } = setup();

    const indexRows = db.$client
      .prepare<[], IndexNameRow>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
      )
      .all();

    const indexNames = indexRows.map((row) => row.name);

    expect(indexNames).toContain("events_thread_turn_type_item_sequence_idx");
    expect(indexNames).toContain("events_completed_item_truncation_idx");
    expect(indexNames).not.toContain("events_thread_turn_sequence_idx");
    expect(indexNames).not.toContain("events_thread_item_id_sequence_idx");
    expect(indexNames).not.toContain(
      "events_thread_turn_type_item_kind_item_idx",
    );

    const [statement] = captureStatements(db, () =>
      listItemEventSpansByItems(db, {
        threadId: "query-plan-thread",
        items: ["turn-1", "turn-2"].map((turnId) => ({
          itemId: turnId,
          scopeKind: "turn",
          turnId,
        })),
      }),
    );

    expect(queryPlanDetails({ db, ...statement! })).toContain(
      "events_thread_turn_type_item_sequence_idx",
    );

    db.$client.close();
  });

  it("prunes stored provider model catalogs through the primary-key prefix", () => {
    const { db, host, logger } = setup();
    const pruneWorkspaceRowsFetchedBefore = 10_000;

    const isCatalogDelete = (fields: SlowDbQueryLogFields): boolean =>
      fields.operation === "run" &&
      fields.sql.startsWith('delete from "provider_model_catalogs"');

    logger.clear();

    replaceStoredProviderModelCatalog(db, {
      row: {
        hostId: host.id,
        providerId: "acp-pi-acp",
        scopeKey: "/w/current",
        fingerprint: "catalog-prune-plan",
        modelsJson: "[]",
        selectedOnlyModelsJson: "[]",
        fetchedAt: 20_000,
      },
      pruneWorkspaceRowsFetchedBefore,
    });

    const prune = findOnlyDebugLog({ logger, predicate: isCatalogDelete });

    const pruneParams = [
      host.id,
      "acp-pi-acp",
      "",
      pruneWorkspaceRowsFetchedBefore,
    ];

    expect(prune.fields.bindingArgumentCount).toBe(pruneParams.length);

    const pruneDetails = queryPlanDetails({
      db,
      params: pruneParams,
      sql: prune.fields.sql,
    });

    expect(pruneDetails).toMatch(
      /USING (COVERING )?INDEX sqlite_autoindex_provider_model_catalogs_1 \(host_id=\? AND provider_id=\?\)/u,
    );
    expect(pruneDetails).not.toMatch(/SCAN provider_model_catalogs/u);

    db.$client.close();
  });
});
