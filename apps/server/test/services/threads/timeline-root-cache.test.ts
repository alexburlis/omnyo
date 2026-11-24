import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type Thread,
  type JsonObject,
  type ThreadEventItemType,
} from "@omnyo/domain";
import {
  createConnection,
  createProject,
  createThread,
  getLatestThreadSequence,
  getThreadHistoryState,
  historyCachePath,
  historySourceIdentity,
  openHistoryCache,
  type HistoryCache,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import { buildThreadTimelineWithProfile } from "../../../src/services/threads/timeline.js";
import { clearTimelineSelectionMemo } from "../../../src/services/threads/timeline-selection-memo.js";
import {
  prepareCompletedRootProjections,
  type CompletedRootProjection,
} from "../../../src/services/threads/timeline-root-cache.js";
import { attachHistoryCacheReader } from "../../../src/services/threads/history-cache-access.js";

const fixtures = new WeakMap<
  DbConnection,
  { directory: string; cache: HistoryCache; sourceIdentity: string }
>();

function closeFixture(db: DbConnection): void {
  const fixture = fixtures.get(db);
  db.$client.close();

  if (fixture === undefined) throw new Error("Missing cache fixture");
  fixture.cache.close();
  rmSync(fixture.directory, { recursive: true, force: true });
  fixtures.delete(db);
}

function storeCompletedRootProjections(
  db: DbConnection,
  threadId: string,
  projections: readonly CompletedRootProjection[],
): void {
  const fixture = fixtures.get(db);

  if (fixture === undefined) throw new Error("Missing cache fixture");

  for (const record of prepareCompletedRootProjections(
    db,
    threadId,
    projections,
  ))
    fixture.cache.put({
      ...record,
      threadId,
      sourceIdentity: fixture.sourceIdentity,
      rewriteEpoch: getThreadHistoryState(db, threadId).rewriteEpoch,
      kind: "root",
      createdAt: Date.now(),
      sequence: getLatestThreadSequence(db, { threadId }),
    });
  expect(
    db.$client
      .prepare("SELECT COUNT(*) AS count FROM thread_timeline_records")
      .get(),
  ).toEqual({ count: 0 });
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "omnyo-root-cache-"));
  const db = createConnection(join(directory, "app.db"));
  migrate(db);
  const cache = openHistoryCache(historyCachePath(db.$client.name));
  const sourceIdentity = historySourceIdentity(db.$client.name);
  fixtures.set(db, { directory, cache, sourceIdentity });
  attachHistoryCacheReader(db, cache, sourceIdentity);
  const host = upsertHost(db, noopNotifier, { name: "root-cache-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "root-cache-project",
    source: { type: "local_path", hostId: host.id, path: "/inert/root" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "idle",
  });

  let sequence = 0;

  const emit = (
    type: Parameters<typeof insertEvents>[2][number]["type"],
    turnId: string | null,
    data: JsonObject,
    metadata: {
      parentToolCallId?: string;
      itemId?: string;
      itemKind?: ThreadEventItemType;
      providerThreadId?: string;
    } = {},
  ) => {
    sequence += 1;
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence,
        scope: turnId === null ? threadScope() : turnScope(turnId),
        providerThreadId:
          metadata.providerThreadId ??
          (turnId === null ? null : "inert-provider"),
        itemId: metadata.itemId ?? null,
        itemKind: metadata.itemKind ?? null,
        parentToolCallId: metadata.parentToolCallId ?? null,
        type,
        data: JSON.stringify(data),
      },
    ]);
  };

  const root = (turnId: string, count: number, complete = true) => {
    emit("turn/started", turnId, {});

    for (let index = 0; index < count; index += 1)
      emit("item/completed", turnId, {
        item: {
          type: "commandExecution",
          id: `${turnId}-${index}`,
          command: `inert ${index}`,
          cwd: "/inert/root",
          approvalStatus: null,
          status: "completed",
          aggregatedOutput: "α🦊漢".repeat(300),
          exitCode: 0,
          durationMs: 1,
        },
      });

    if (complete) emit("turn/completed", turnId, { status: "completed" });
  };

  return { db, thread, emit, root, maxSeq: () => sequence };
}

function build(
  db: DbConnection,
  thread: Thread,
  maxSeq: number,
  cached = false,
) {
  return buildThreadTimelineWithProfile(db, thread, {
    compactionOfferEnabled: false,
    completedTurnDisplay: "collapse",
    deferContent: true,
    eventBudget: 1500,
    includeClearedContextHistory: false,
    includeDiagnosticOperations: false,
    includeNestedRows: true,
    maxInlineOutputChars: 32_000,
    maxSeq,
    page: { kind: "latest", segmentLimit: 20 },
    cacheCompletedRoots: cached,
  });
}

function openChildFixture() {
  const fixture = setup();
  const { root, emit, thread } = fixture;
  root("giant", 300, false);
  emit(
    "item/started",
    "giant",
    {
      item: {
        type: "toolCall",
        id: "delegate",
        tool: "Agent",
        arguments: { prompt: "inert child" },
        status: "pending",
      },
    },
    { itemId: "delegate", itemKind: "toolCall" },
  );
  emit(
    "turn/started",
    "child",
    { parentToolCallId: "delegate" },
    { parentToolCallId: "delegate" },
  );
  emit(
    "item/started",
    "child",
    {
      item: {
        type: "commandExecution",
        id: "child-command",
        command: "child marker",
        cwd: "/inert/root",
        approvalStatus: null,
        status: "pending",
      },
    },
    {
      parentToolCallId: "delegate",
      itemId: "child-command",
      itemKind: "commandExecution",
    },
  );
  emit("turn/completed", "giant", { status: "completed" });

  return { ...fixture, thread: { ...thread, status: "active" as const } };
}

function payloadReads<T>(db: DbConnection, run: () => T) {
  const statement = db.$client.prepare("SELECT 1");
  const prototype = Object.getPrototypeOf(statement) as typeof statement;
  const original = prototype.all;
  let bytes = 0;
  let rows = 0;

  const spy = vi.spyOn(prototype, "all").mockImplementation(function (
    this: typeof statement,
    ...parameters
  ) {
    const result = Reflect.apply(original, this, parameters) as unknown[];

    if (/\bfrom\s+["`]?events["`]?/i.test(this.source)) {
      for (const row of result) {
        const values = Array.isArray(row)
          ? row
          : typeof row === "object" && row !== null
            ? Object.values(row)
            : [];

        for (const value of values)
          if (typeof value === "string" && value.startsWith("{")) {
            rows += 1;
            bytes += Buffer.byteLength(value);
          }
      }
    }

    return result;
  });

  try {
    return {
      result: run(),
      get bytes() {
        return bytes;
      },
      get rows() {
        return rows;
      },
    };
  } finally {
    spy.mockRestore();
  }
}

describe("canonical completed-root projection reuse", () => {
  it("preserves a saved canonical root across new active turns and status changes without decoding the giant root", async () => {
    const fixture = setup();
    const { db, thread, root, maxSeq } = fixture;

    try {
      root("giant", 300);
      const saved = build(db, thread, maxSeq());
      const prepared = build(db, thread, maxSeq(), true);
      expect(prepared.response).toEqual(saved.response);
      expect(prepared.completedRootProjections.length).toBeGreaterThan(0);
      await storeCompletedRootProjections(
        db,
        thread.id,
        prepared.completedRootProjections,
      );
      const reused = build(db, thread, maxSeq(), true);
      expect(reused.response).toEqual(saved.response);
      expect(reused.profile.decodedEventCount).toBeLessThan(10);
      root("new", 2);
      const active = { ...thread, status: "active" as const };
      const oracle = build(db, active, maxSeq());
      const mixed = build(db, active, maxSeq(), true);
      expect(mixed.response).toEqual(oracle.response);
      expect(mixed.profile.decodedEventCount).toBeLessThan(20);
      expect(JSON.stringify(mixed.response)).toContain("giant-299");
      expect(JSON.stringify(mixed.response)).toContain("new-1");
      fixture.emit("item/completed", "giant", {
        item: {
          type: "commandExecution",
          id: "late",
          command: "late completed command",
          cwd: "/inert/root",
          approvalStatus: null,
          status: "completed",
          aggregatedOutput: "late output",
          exitCode: 0,
          durationMs: 1,
        },
      });
      const changed = build(db, active, maxSeq(), true);
      expect(changed.response).toEqual(build(db, active, maxSeq()).response);
      expect(JSON.stringify(changed.response)).toContain(
        "late completed command",
      );
    } finally {
      closeFixture(db);
    }
  });

  it("retains canonical state for unsupported provider state instead of substituting a fragment", async () => {
    const { db, thread, root, emit, maxSeq } = setup();

    try {
      root("giant", 30);
      emit("provider/modelFallback", "giant", {
        originalModel: "inert-original",
        fallbackModel: "inert-fallback",
        reason: "provider",
        message: "inert switch",
      });
      const saved = build(db, thread, maxSeq());
      const prepared = build(db, thread, maxSeq(), true);
      await storeCompletedRootProjections(
        db,
        thread.id,
        prepared.completedRootProjections,
      );
      expect(build(db, thread, maxSeq(), true).response).toEqual(
        saved.response,
      );
      expect(saved.response.modelFallback?.fallbackModel).toBe(
        "inert-fallback",
      );
    } finally {
      closeFixture(db);
    }
  });
  it("reuses a revisioned completed parent with an unfinished descendant without rereading old payload", () => {
    const { db, thread, maxSeq } = openChildFixture();

    try {
      const cold = payloadReads(db, () => build(db, thread, maxSeq()));
      expect(cold.bytes).toBeGreaterThan(500_000);
      const canonical = cold.result;
      expect(JSON.stringify(canonical.response)).toContain("child marker");
      const prepared = build(db, thread, maxSeq(), true);
      expect(prepared.response).toEqual(canonical.response);
      storeCompletedRootProjections(
        db,
        thread.id,
        prepared.completedRootProjections,
      );
      clearTimelineSelectionMemo(db);

      const measured = payloadReads(db, () =>
        build(db, thread, maxSeq(), true),
      );

      expect(measured.result.response).toEqual(canonical.response);
      expect(measured.bytes).toBeLessThan(32_000);
      expect(measured.rows).toBeLessThan(20);
    } finally {
      closeFixture(db);
    }
  });

  it.each(["local_workflow", "local_bash", "reasoning"] as const)(
    "preserves active %s auxiliary state instead of caching only its transcript",
    (kind) => {
      const { db, thread, emit, maxSeq } = openChildFixture();

      try {
        if (kind === "reasoning") {
          emit(
            "item/started",
            "child",
            {
              item: {
                type: "reasoning",
                id: "child-thinking",
                summary: [],
                content: [],
              },
            },
            {
              parentToolCallId: "delegate",
              itemId: "child-thinking",
              itemKind: "reasoning",
            },
          );
          emit(
            "item/reasoning/textDelta",
            "child",
            { itemId: "child-thinking", delta: "active thinking marker" },
            {
              parentToolCallId: "delegate",
              itemId: "child-thinking",
              itemKind: "reasoning",
            },
          );
        } else {
          emit(
            "item/started",
            "child",
            {
              item: {
                type: "backgroundTask",
                id: "child-background",
                taskType: kind,
                description: "active auxiliary marker",
                status: "pending",
                taskStatus: "running",
                skipTranscript: false,
                ...(kind === "local_workflow"
                  ? { workflowName: "inert-workflow" }
                  : {}),
              },
            },
            {
              parentToolCallId: "delegate",
              itemId: "child-background",
              itemKind: "backgroundTask",
            },
          );
        }

        const canonical = build(db, thread, maxSeq());

        if (kind === "reasoning")
          expect(canonical.response.activeThinking).toEqual(
            expect.objectContaining({ id: expect.any(String) }),
          );
        else
          expect(
            kind === "local_workflow"
              ? canonical.response.activeWorkflows
              : canonical.response.activeBackgroundCommands,
          ).toHaveLength(1);

        const prepared = build(db, thread, maxSeq(), true);
        expect(prepared.response).toEqual(canonical.response);
        storeCompletedRootProjections(
          db,
          thread.id,
          prepared.completedRootProjections,
        );
        clearTimelineSelectionMemo(db);
        expect(build(db, thread, maxSeq(), true).response).toEqual(
          canonical.response,
        );
      } finally {
        closeFixture(db);
      }
    },
  );

  it.each([
    "unrelated",
    "child",
    "new-child",
    "rewrite",
    "credential",
    "status",
    "interruption",
    "past-tip",
  ] as const)(
    "validates unfinished-descendant snapshots for %s without changing canonical content",
    (change) => {
      const fixture = openChildFixture();
      const { db, emit, root, thread, maxSeq } = fixture;

      try {
        const capturedTip = maxSeq();
        const prepared = build(db, thread, capturedTip, true);
        expect(prepared.completedRootProjections.length).toBeGreaterThan(0);
        storeCompletedRootProjections(
          db,
          thread.id,
          prepared.completedRootProjections,
        );
        let currentThread: Thread = thread;
        let requestedTip = capturedTip;

        if (change === "unrelated") {
          root("unrelated", 1);
          requestedTip = maxSeq();
        }

        if (change === "child") {
          emit(
            "item/completed",
            "child",
            {
              item: {
                type: "agentMessage",
                id: "child-update",
                text: "new child output",
              },
            },
            {
              parentToolCallId: "delegate",
              itemId: "child-update",
              itemKind: "agentMessage",
            },
          );
          requestedTip = maxSeq();
        }

        if (change === "new-child") {
          emit(
            "turn/started",
            "second-child",
            { parentToolCallId: "delegate" },
            { parentToolCallId: "delegate" },
          );
          emit(
            "item/completed",
            "second-child",
            {
              item: {
                type: "agentMessage",
                id: "new-child-message",
                text: "new descendant marker",
              },
            },
            {
              parentToolCallId: "delegate",
              itemId: "new-child-message",
              itemKind: "agentMessage",
            },
          );
          requestedTip = maxSeq();
        }

        if (change === "rewrite")
          db.$client
            .prepare(
              "UPDATE events SET data = replace(data, 'child marker', 'rewritten marker') WHERE thread_id = ? AND turn_id = 'child' AND type = 'item/started'",
            )
            .run(thread.id);

        if (change === "credential") {
          emit("provider.env-resolved", null, {});
          requestedTip = maxSeq();
        }

        if (change === "status") currentThread = { ...thread, status: "idle" };

        if (change === "interruption") {
          emit("system/thread/interrupted", null, { reason: "manual-stop" });
          requestedTip = maxSeq();
        }

        if (change === "past-tip") requestedTip = capturedTip - 1;
        const canonical = build(db, currentThread, requestedTip);
        clearTimelineSelectionMemo(db);

        const measured = payloadReads(db, () =>
          build(db, currentThread, requestedTip, true),
        );

        expect(measured.result.response).toEqual(canonical.response);

        if (change === "unrelated") expect(measured.bytes).toBeLessThan(32_000);

        if (change === "child")
          expect(JSON.stringify(measured.result.response)).toContain(
            "new child output",
          );

        if (change === "new-child")
          expect(JSON.stringify(measured.result.response)).toContain(
            "new descendant marker",
          );

        if (change === "rewrite")
          expect(JSON.stringify(measured.result.response)).toContain(
            "rewritten marker",
          );
      } finally {
        closeFixture(db);
      }
    },
  );

  it("caches an older root only with the content a full build gives it", () => {
    const { db, thread, emit, maxSeq } = setup();

    try {
      let requests = 0;

      const task = (status: "pending" | "completed") => ({
        item: {
          type: "backgroundTask",
          id: "inert-task",
          taskType: "local_bash",
          description: "inert task",
          status,
          taskStatus: status === "pending" ? "running" : "completed",
          skipTranscript: false,
          parentToolCallId: "owner-call",
        },
      });

      const prompted = (turnId: string, items: number, work = () => {}) => {
        requests += 1;
        const requestId = encodeClientTurnRequestIdNumber({ value: requests });
        emit("client/turn/requested", null, {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId,
          senderThreadId: null,
          input: [{ type: "text", text: `inert ${turnId}`, mentions: [] }],
          target:
            requests === 1 ? { kind: "thread-start" } : { kind: "new-turn" },
          execution: {
            model: "inert-model",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        });
        emit("turn/started", turnId, {});
        emit("turn/input/accepted", turnId, { clientRequestId: requestId });
        work();

        for (let index = 0; index < items; index += 1)
          emit(
            "item/completed",
            turnId,
            {
              item: {
                type: "agentMessage",
                id: `${turnId}-${index}`,
                text: `inert reply ${turnId} ${index}`,
              },
            },
            { itemId: `${turnId}-${index}`, itemKind: "agentMessage" },
          );
        emit("turn/completed", turnId, { status: "completed" });
      };

      prompted("owner", 1, () => {
        emit(
          "item/completed",
          "owner",
          {
            item: {
              type: "toolCall",
              id: "owner-call",
              tool: "Bash",
              arguments: { command: "inert" },
              status: "completed",
            },
          },
          { itemId: "owner-call", itemKind: "toolCall" },
        );
        emit("item/started", "owner", task("pending"), {
          itemId: "inert-task",
          itemKind: "backgroundTask",
          parentToolCallId: "owner-call",
        });
      });

      for (let index = 0; index < 5; index += 1) prompted(`early-${index}`, 2);

      for (let index = 0; index < 25; index += 1) {
        prompted(`late-${index}`, 1);

        if (index === 20)
          emit("item/backgroundTask/completed", null, task("completed"), {
            itemId: "inert-task",
            itemKind: "backgroundTask",
            parentToolCallId: "owner-call",
            providerThreadId: "inert-provider",
          });
      }

      const windowed = build(db, thread, maxSeq(), true);
      clearTimelineSelectionMemo(db);

      const full = buildThreadTimelineWithProfile(db, thread, {
        compactionOfferEnabled: false,
        completedTurnDisplay: "collapse",
        deferContent: true,
        eventBudget: 1500,
        includeClearedContextHistory: false,
        includeDiagnosticOperations: false,
        includeNestedRows: true,
        maxInlineOutputChars: 32_000,
        maxSeq: maxSeq(),
        page: { kind: "latest", segmentLimit: 100 },
        cacheCompletedRoots: true,
      });

      const canonical = new Map(
        full.completedRootProjections.map((projection) => [
          projection.key,
          projection,
        ]),
      );

      expect(
        windowed.completedRootProjections.map(
          (projection) => projection.rootTurnId,
        ),
      ).toContain("late-24");

      for (const projection of windowed.completedRootProjections)
        expect(projection).toEqual(canonical.get(projection.key));
    } finally {
      closeFixture(db);
    }
  });
});
