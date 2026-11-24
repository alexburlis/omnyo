import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as processErrorReporting from "@omnyo/process-utils/error-reporting";
import { threadScope, turnScope, type JsonObject } from "@omnyo/domain";
import {
  createConnection,
  advanceThreadPruning,
  createProject,
  createThread,
  findThreadSearchMatches,
  getThread,
  getThreadHistoryState,
  historyCachePath,
  historySourceIdentity,
  insertEvents,
  migrate,
  noopNotifier,
  openHistoryCache,
  putThreadTimelineRecord,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import {
  ensureHistoryCache,
  persistHistoryCache,
  touchHistoryCache,
} from "../../../src/services/threads/history-cache-writer.js";
import {
  buildThreadConversationOutline,
  buildThreadTimelineWithProfile,
  buildTimelineTurnSummaryDetails,
} from "../../../src/services/threads/timeline.js";
import {
  redactThreadHistory,
  redactThreadHistoryEvent,
} from "../../../src/services/threads/thread-history-redaction.js";
import { listThreadEventRows } from "../../../src/services/threads/thread-data.js";
import {
  buildThreadTimelinePage,
  buildThreadConversationOutlinePage,
  closeThreadTimelinePageBuilders,
  findThreadSearchMatchesInWorker,
  invalidateThreadHistoryBuilders,
  loadThreadEventListBody,
  loadTimelineTurnSummaryDetails,
} from "../../../src/services/threads/timeline-page-builder.js";

function walCommits(path: string): number {
  if (!existsSync(`${path}-wal`)) return 0;
  const wal = readFileSync(`${path}-wal`);

  if (wal.length < 32) return 0;
  const pageSize = wal.readUInt32BE(8);
  let commits = 0;

  for (
    let offset = 32;
    offset + 24 + pageSize <= wal.length;
    offset += 24 + pageSize
  )
    if (wal.readUInt32BE(offset + 4) !== 0) commits += 1;

  return commits;
}

const options = {
  compactionOfferEnabled: false,
  completedTurnDisplay: "collapse" as const,
  deferContent: true,
  eventBudget: 1500,
  includeClearedContextHistory: false,
  includeDiagnosticOperations: false,
  includeNestedRows: true,
  maxInlineOutputChars: 32768,
  maxSeq: 0,
  page: { kind: "latest" as const, segmentLimit: 20 },
};

async function withDatabase(
  run: (db: DbConnection, threadId: string) => Promise<void>,
) {
  const directory = mkdtempSync(join(import.meta.dirname, ".worker-fixture-"));
  const db = createConnection(join(directory, "history.db"));
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "worker-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "worker-project",
    source: { type: "local_path", hostId: host.id, path: "/inert/worker" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "active",
  });

  try {
    await run(db, thread.id);
  } finally {
    await closeThreadTimelinePageBuilders(db);
    db.$client.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("file-backed canonical page workers", () => {
  it("reports one actionable projection failure for shared worker subscribers", async () => {
    const capture = vi
      .spyOn(processErrorReporting, "captureProcessError")
      .mockImplementation(() => {});

    try {
      await withDatabase(async (db, threadId) => {
        insertEvents(db, noopNotifier, [
          {
            threadId,
            sequence: 20,
            scope: turnScope("private-turn"),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            type: "turn/completed",
            data: JSON.stringify({
              providerThreadId: null,
              status: "completed",
            }),
          },
        ]);

        const results = await Promise.allSettled([
          buildThreadTimelinePage(db, { threadId, options }),
          buildThreadTimelinePage(db, { threadId, options }),
        ]);

        expect(results.every((result) => result.status === "rejected")).toBe(
          true,
        );
        expect(capture).toHaveBeenCalledTimes(1);
        const [failure, report] = capture.mock.calls[0]!;
        expect(failure).toBeInstanceOf(Error);

        if (!(failure instanceof Error))
          throw new Error("Expected projection failure");
        expect(failure.stack).toContain("groupEventProjectionTurns");
        expect(failure.message).not.toContain("private-turn");
        expect(report.diagnostic).toMatchObject({
          reason: "missing-turn-start",
          source: "turn/completed",
          failureSequence: 20,
          turnStartCount: 0,
          storedStart: "missing",
        });
        expect(report.diagnostic).not.toHaveProperty("threadId");
        expect(report.diagnostic).not.toHaveProperty("turnId");
      });
    } finally {
      capture.mockRestore();
    }
  });

  it("commits worker cache admissions once, preserves outline admission and rolls back a rejected batch", async () => {
    await withDatabase(async (db, threadId) => {
      insertEvents(db, noopNotifier, [
        {
          threadId,
          sequence: 1,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "system/manager/user_message",
          data: JSON.stringify({ text: "Outline from real worker" }),
        },
      ]);
      const state = getThreadHistoryState(db, threadId);
      const sourceIdentity = historySourceIdentity(db.$client.name);

      const input = {
        threadId,
        sourceIdentity,
        rewriteEpoch: state.rewriteEpoch,
        createdAt: Date.now() - 1000,
        expiresAt: null,
        sequence: 1,
        body: "safe cached output",
      };

      await ensureHistoryCache(db);
      const path = historyCachePath(db.$client.name);
      const before = walCommits(path);
      expect(
        await persistHistoryCache(db, {
          threadId,
          historyEpoch: state.epoch,
          rewriteEpoch: state.rewriteEpoch,
          records: [
            { ...input, key: "root:first", kind: "root" },
            { ...input, key: "root:second", kind: "root" },
            { ...input, key: "outline:checkpoint", kind: "outline" },
            {
              ...input,
              key: "outline:checkpoint",
              kind: "outline",
              body: "ignored same-sequence outline",
            },
          ],
        }),
      ).toEqual(["stored", "stored", "stored", "unchanged"]);
      expect(walCommits(path) - before).toBe(1);
      await expect(
        persistHistoryCache(db, {
          threadId,
          historyEpoch: state.epoch,
          rewriteEpoch: state.rewriteEpoch,
          records: [
            { ...input, key: "root:rollback", kind: "root" },
            {
              ...input,
              key: "root:first",
              kind: "root",
              body: "conflicting body",
            },
          ],
        }),
      ).rejects.toMatchObject({
        status: 503,
        body: { code: "history_cache_unavailable" },
      });
      const reader = openHistoryCache(path, { readonly: true });

      try {
        expect(
          reader.get({ key: "root:rollback", sourceIdentity, now: Date.now() }),
        ).toBeNull();
        expect(
          reader.get({
            key: "outline:checkpoint",
            sourceIdentity,
            now: Date.now(),
          })?.body,
        ).toBe(input.body);
      } finally {
        reader.close();
      }

      const outline = await buildThreadConversationOutlinePage(db, {
        threadId,
        options: {
          completedTurnDisplay: "collapse",
          includeClearedContextHistory: false,
          maxSeq: 1,
        },
      });

      expect(outline.workerThreadId).toBeGreaterThan(0);

      const oracle = buildThreadConversationOutline(
        db,
        getThread(db, threadId)!,
        {
          completedTurnDisplay: "collapse",
          includeClearedContextHistory: false,
          maxSeq: 1,
        },
      );

      expect(JSON.parse(outline.body)).toEqual(oracle);
      expect(oracle.items.map((item) => item.preview)).toEqual([
        "Outline from real worker",
      ]);

      const repeated = await buildThreadConversationOutlinePage(db, {
        threadId,
        options: {
          completedTurnDisplay: "collapse",
          includeClearedContextHistory: false,
          maxSeq: 1,
          role: "assistant",
        },
      });

      expect(JSON.parse(repeated.body)).toEqual({
        ...oracle,
        items: oracle.items.filter((item) => item.role === "assistant"),
      });
    });
  });

  it("finds thread search matches in a worker, matching the inline query", async () => {
    await withDatabase(async (db, threadId) => {
      const titled = createThread(db, noopNotifier, {
        projectId: getThread(db, threadId)!.projectId,
        providerId: "codex",
        status: "active",
        title: "Coordinator freeze investigation",
      });

      const args = { query: "freeze", limitPerGroup: 20 };
      const inline = findThreadSearchMatches(db, args);

      expect(inline.active.threads.map((entry) => entry.threadId)).toEqual([
        titled.id,
      ]);
      await expect(findThreadSearchMatchesInWorker(db, args)).resolves.toEqual(
        inline,
      );
    });
  });

  it("builds turn summary details in a worker while the event loop stays free", async () => {
    await withDatabase(async (db, threadId) => {
      const turnEvent = (
        sequence: number,
        type:
          | "turn/started"
          | "turn/completed"
          | "item/started"
          | "item/completed",
        data: JsonObject,
      ) => ({
        threadId,
        sequence,
        scope: turnScope("turn-1"),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        providerThreadId: "provider-thread-1",
        type,
        data: JSON.stringify({
          providerThreadId: "provider-thread-1",
          ...data,
        }),
      });

      const commandEvent = (
        sequence: number,
        status: "pending" | "completed",
      ) => ({
        ...turnEvent(
          sequence,
          status === "pending" ? "item/started" : "item/completed",
          {
            item: {
              type: "commandExecution",
              id: "long-command",
              command: "echo done",
              cwd: "/tmp/test",
              status,
              approvalStatus: null,
              ...(status === "completed"
                ? { exitCode: 0, aggregatedOutput: "done" }
                : {}),
            },
          },
        ),
        itemId: "long-command",
        itemKind: "commandExecution" as const,
      });

      insertEvents(db, noopNotifier, [
        turnEvent(1, "turn/started", {}),
        commandEvent(2, "pending"),
        commandEvent(3, "completed"),
        turnEvent(4, "turn/completed", { status: "completed" }),
      ]);

      const detailsOptions = {
        completedTurnDisplay: "collapse" as const,
        deferContent: false,
        includeDiagnosticOperations: false,
        itemId: null,
        sourceSeqEnd: 4,
        sourceSeqStart: 1,
        turnId: "turn-1",
      };

      const inline = redactThreadHistory(
        db,
        threadId,
        buildTimelineTurnSummaryDetails(
          db,
          getThread(db, threadId)!,
          detailsOptions,
        ),
        { invalidJsonText: "withhold" },
      );

      let ticks = 0;

      const timer = setInterval(() => {
        ticks += 1;
      }, 1);

      try {
        const built = await loadTimelineTurnSummaryDetails(db, {
          threadId,
          options: detailsOptions,
        });

        expect(JSON.parse(built.body)).toEqual(
          JSON.parse(JSON.stringify(inline)),
        );
      } finally {
        clearInterval(timer);
      }

      expect(ticks).toBeGreaterThan(0);
    });
  }, 30_000);

  it("builds event pages in a worker while the event loop stays free", async () => {
    await withDatabase(async (db, threadId) => {
      insertEvents(
        db,
        noopNotifier,
        Array.from({ length: 40 }, (_, index) => ({
          threadId,
          sequence: index + 1,
          scope: turnScope("turn-1"),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          providerThreadId: "provider-thread-1",
          type: "item/completed" as const,
          data: JSON.stringify({
            providerThreadId: "provider-thread-1",
            item: {
              type: "agentMessage",
              id: `message-${index}`,
              text: `reply ${index}`,
            },
          }),
        })),
      );

      const options = { limit: 25, order: "desc" as const, beforeSeq: 40 };

      const inline = redactThreadHistory(
        db,
        threadId,
        listThreadEventRows(db, { threadId, ...options }).map(
          redactThreadHistoryEvent,
        ),
        { invalidJsonText: "withhold" },
      );

      let ticks = 0;

      const timer = setInterval(() => {
        ticks += 1;
      }, 1);

      try {
        const built = await loadThreadEventListBody(db, { threadId, options });

        expect(JSON.parse(built.body)).toEqual(
          JSON.parse(JSON.stringify(inline)),
        );
        expect(JSON.parse(built.body)).toHaveLength(25);
      } finally {
        clearInterval(timer);
      }

      expect(ticks).toBeGreaterThan(0);
    });
  }, 30_000);

  it("rejects an in-flight timeline invalidated by compaction and rebuilds fresh history on retry", async () => {
    await withDatabase(async (db, threadId) => {
      insertEvents(db, noopNotifier, [
        {
          threadId,
          sequence: 1,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "system/manager/user_message",
          data: JSON.stringify({ text: "Before compaction" }),
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          threadId,
          sequence: index + 2,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "thread/tokenUsage/updated" as const,
          data: JSON.stringify({
            tokenUsage: { total: { totalTokens: index + 1 } },
          }),
        })),
        {
          threadId,
          sequence: 12,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "system/manager/user_message",
          data: JSON.stringify({ text: "After compaction" }),
        },
      ]);
      await ensureHistoryCache(db);
      let settled = false;
      const loading = buildThreadTimelinePage(db, { threadId, options });
      void loading.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      const rejected = expect(loading).rejects.toMatchObject({
        status: 503,
        body: { code: "timeline_unavailable", retryable: true },
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      let removed = 0;

      for (let pass = 0; pass < 10 && removed === 0; pass += 1) {
        removed += advanceThreadPruning(db, "usage", 500).removed;
      }

      expect(removed).toBeGreaterThan(0);
      invalidateThreadHistoryBuilders(db, threadId);
      await rejected;

      const retried = await buildThreadTimelinePage(db, { threadId, options });

      const expected = buildThreadTimelineWithProfile(
        db,
        getThread(db, threadId)!,
        { ...options, maxSeq: 12 },
      );

      expect(retried.workerThreadId).toBeGreaterThan(0);
      expect(retried.response).toEqual(expected.response);
      expect(
        retried.response.rows
          .filter((row) => row.kind === "conversation")
          .map((row) => row.text),
      ).toEqual(["Before compaction", "After compaction"]);
    });
  });

  it("finishes an in-flight event read when the chat's history is invalidated", async () => {
    await withDatabase(async (db, threadId) => {
      insertEvents(
        db,
        noopNotifier,
        Array.from({ length: 10 }, (_, index) => ({
          threadId,
          sequence: index + 1,
          scope: turnScope("turn-1"),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          providerThreadId: "provider-thread-1",
          type: "item/completed" as const,
          data: JSON.stringify({
            providerThreadId: "provider-thread-1",
            item: { type: "agentMessage", id: `message-${index}`, text: "x" },
          }),
        })),
      );

      const options = { limit: 5, order: "desc" as const };

      await loadThreadEventListBody(db, { threadId, options });

      const loading = loadThreadEventListBody(db, { threadId, options });
      let settled = false;

      void loading.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      while (!settled) {
        invalidateThreadHistoryBuilders(db, threadId);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(JSON.parse((await loading).body)).toHaveLength(5);
    });
  }, 30_000);

  it("opens another chat before an expensive foreground history read finishes", async () => {
    await withDatabase(async (db, threadId) => {
      const small = createThread(db, noopNotifier, {
        projectId: getThread(db, threadId)!.projectId,
        providerId: "codex",
        status: "active",
      });

      await Promise.all(
        [threadId, small.id].map((id) =>
          buildThreadTimelinePage(db, { threadId: id, options }),
        ),
      );
      const output = "large pending command output ".repeat(75_000);
      insertEvents(db, noopNotifier, [
        {
          threadId,
          sequence: 1,
          scope: turnScope("expensive"),
          providerThreadId: "inert-provider",
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "turn/started",
          data: "{}",
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          threadId,
          sequence: index + 2,
          scope: turnScope("expensive"),
          providerThreadId: "inert-provider",
          itemId: `command-${index}`,
          itemKind: "commandExecution" as const,
          parentToolCallId: null,
          type: "item/started" as const,
          data: JSON.stringify({
            item: {
              id: `command-${index}`,
              type: "commandExecution",
              command: "synthetic history workload",
              cwd: "/inert/worker",
              status: "pending",
              approvalStatus: null,
              aggregatedOutput: output,
            },
          }),
        })),
      ]);
      insertEvents(db, noopNotifier, [
        {
          threadId: small.id,
          sequence: 1,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "system/manager/user_message",
          data: JSON.stringify({ text: "Small chat is ready" }),
        },
      ]);
      const completed: string[] = [];

      const heavy = buildThreadTimelinePage(db, { threadId, options }).then(
        (result) => {
          completed.push("heavy");

          return result;
        },
      );

      const preview = buildThreadTimelinePage(db, {
        threadId,
        options: { ...options, includeNestedRows: false },
      }).then((result) => {
        completed.push("preview");

        return result;
      });

      const opened = buildThreadTimelinePage(db, {
        threadId: small.id,
        options,
      }).then((result) => {
        completed.push("small");

        return result;
      });

      const [largeResult, smallResult, previewResult] = await Promise.all([
        heavy,
        opened,
        preview,
      ]);

      expect(JSON.stringify(smallResult.response)).toContain(
        "Small chat is ready",
      );
      expect(largeResult.response.maxSeq).toBe(9);
      expect(previewResult.response.maxSeq).toBe(9);
      expect(completed).toEqual(["small", "heavy", "preview"]);
    });
  }, 30_000);

  it("captures the effective empty/latest tip in its read transaction and retains a shared subscriber when another cancels", async () => {
    await withDatabase(async (db, threadId) => {
      await ensureHistoryCache(db);
      const first = new AbortController();

      const canceled = buildThreadTimelinePage(db, {
        threadId,
        options,
        signal: first.signal,
      });

      const surviving = buildThreadTimelinePage(db, { threadId, options });
      insertEvents(db, noopNotifier, [
        {
          threadId,
          sequence: 1,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "system/manager/user_message",
          data: JSON.stringify({ text: "committed before worker capture" }),
        },
      ]);

      const canceledCheck = expect(canceled).rejects.toMatchObject({
        name: "AbortError",
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      first.abort();
      await canceledCheck;
      const built = await surviving;
      expect(built.workerThreadId).toBeGreaterThan(0);
      expect(built.response.maxSeq).toBe(1);
      const thread = getThread(db, threadId)!;

      const oracle = buildThreadTimelineWithProfile(db, thread, {
        ...options,
        maxSeq: 1,
      });

      expect(built.response).toEqual(oracle.response);
    });
  }, 30_000);

  it("retains incremental decode across coordinator and unrelated cache writes but rebuilds on a foreign rewrite", async () => {
    await withDatabase(async (db, threadId) => {
      let sequence = 0;

      const append = (
        type: "turn/started" | "item/started" | "item/agentMessage/delta",
        data: JsonObject,
      ) => {
        sequence += 1;
        insertEvents(db, noopNotifier, [
          {
            threadId,
            sequence,
            providerThreadId: "inert-provider",
            parentToolCallId: null,
            scope: turnScope("root"),
            type,
            itemId: type === "item/started" ? "message" : null,
            itemKind: type === "item/started" ? "agentMessage" : null,
            data: JSON.stringify(data),
          },
        ]);
      };

      append("turn/started", {});
      append("item/started", {
        item: {
          id: "message",
          type: "agentMessage",
          text: "",
          status: "pending",
        },
      });

      for (let index = 0; index < 200; index += 1)
        append("item/agentMessage/delta", {
          itemId: "message",
          delta: `part${index} α🦊\n`,
        });
      const first = await buildThreadTimelinePage(db, { threadId, options });

      for (let index = 0; index < 3; index += 1) {
        append("item/agentMessage/delta", {
          itemId: "message",
          delta: `next${index}\n`,
        });
        putThreadTimelineRecord(
          db,
          {
            key: `unrelated${index}`,
            threadId,
            kind: "page",
            body: "{}",
            createdAt: Date.now(),
            expiresAt: null,
          },
          { maxBytes: 8, maxEntries: 1, maxEntryBytes: 8 },
        );
        const next = await buildThreadTimelinePage(db, { threadId, options });
        expect(next.workerThreadId).toBe(first.workerThreadId);
        expect(next.profile.decodedEventCount).toBeLessThan(10);

        const oracle = buildThreadTimelineWithProfile(
          db,
          getThread(db, threadId)!,
          { ...options, maxSeq: sequence },
        );

        expect(next.response).toEqual(oracle.response);
      }

      const foreign = createConnection(db.$client.name);

      try {
        foreign.$client
          .prepare(
            "UPDATE events SET data = ? WHERE thread_id = ? AND sequence = 3",
          )
          .run(
            JSON.stringify({
              itemId: "message",
              delta: "foreign rewritten text",
            }),
            threadId,
          );
      } finally {
        foreign.$client.close();
      }

      const rebuilt = await buildThreadTimelinePage(db, { threadId, options });
      expect(rebuilt.profile.decodedEventCount).toBeGreaterThan(100);
      expect(JSON.stringify(rebuilt.response)).toContain(
        "foreign rewritten text",
      );
      expect(rebuilt.historyEpoch).not.toBe(first.historyEpoch);
    });
  }, 30_000);

  it("marks a page served from the history cache so its stored build profile is not reported again", async () => {
    await withDatabase(async (db, threadId) => {
      await ensureHistoryCache(db);
      insertEvents(db, noopNotifier, [
        {
          threadId,
          sequence: 1,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "system/manager/user_message",
          data: JSON.stringify({ text: "cached idle page" }),
        },
      ]);
      db.$client
        .prepare("UPDATE threads SET status = 'idle' WHERE id = ?")
        .run(threadId);

      const built = await buildThreadTimelinePage(db, { threadId, options });
      const served = await buildThreadTimelinePage(db, { threadId, options });

      expect(built.fromCache).toBe(false);
      expect(built.cacheAdmissions).toContain("stored");
      expect(served.fromCache).toBe(true);
      expect(served.response).toEqual(built.response);
    });
  }, 30_000);

  it("keeps a recently read cached page through count eviction and evicts an older unread record", async () => {
    await withDatabase(async (db, threadId) => {
      await ensureHistoryCache(db);
      insertEvents(db, noopNotifier, [
        {
          threadId,
          sequence: 1,
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          type: "system/manager/user_message",
          data: JSON.stringify({ text: "frequently reopened page" }),
        },
      ]);
      db.$client
        .prepare("UPDATE threads SET status = 'idle' WHERE id = ?")
        .run(threadId);
      const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

      await buildThreadTimelinePage(db, { threadId, options });
      await pause();

      const state = getThreadHistoryState(db, threadId);
      const sourceIdentity = historySourceIdentity(db.$client.name);

      const rootRecord = (key: string) => ({
        key,
        kind: "root" as const,
        threadId,
        sourceIdentity,
        rewriteEpoch: state.rewriteEpoch,
        createdAt: Date.now() - 1000,
        expiresAt: null,
        sequence: 1,
        body: "{}",
      });

      const write = (keys: readonly string[]) =>
        persistHistoryCache(db, {
          threadId,
          historyEpoch: state.epoch,
          rewriteEpoch: state.rewriteEpoch,
          records: keys.map(rootRecord),
        });

      await write(["root:unread"]);
      await pause();

      const served = await buildThreadTimelinePage(db, { threadId, options });
      expect(served.fromCache).toBe(true);
      const [pageKey] = served.cacheTouches ?? [];
      expect(pageKey).toMatch(/^page:/u);
      await touchHistoryCache(db, served.cacheTouches ?? []);
      await pause();

      await write(
        Array.from({ length: 1023 }, (_, index) => `root:fill-${index}`),
      );

      const reader = openHistoryCache(historyCachePath(db.$client.name), {
        readonly: true,
      });

      try {
        const read = (key: string) =>
          reader.get({ key, sourceIdentity, now: Date.now() });

        expect(read(pageKey!)).not.toBeNull();
        expect(read("root:unread")).toBeNull();
        expect(reader.storageUsage().records).toBe(1024);
      } finally {
        reader.close();
      }
    });
  }, 30_000);

  it("rejects an already canceled request without publishing it and allows a fresh builder after close", async () => {
    await withDatabase(async (db, threadId) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        buildThreadTimelinePage(db, {
          threadId,
          options,
          signal: controller.signal,
          priority: "background",
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await closeThreadTimelinePageBuilders(db);
      const built = await buildThreadTimelinePage(db, { threadId, options });
      expect(built.response.maxSeq).toBe(0);
      expect(built.workerThreadId).toBeGreaterThan(0);
    });
  }, 30_000);
});
