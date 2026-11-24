import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  createThread,
  deleteThread,
  getLatestThreadSequence,
  getThreadHistoryState,
  historyCachePath,
  historySourceIdentity,
  migrate,
  noopNotifier,
  openHistoryCache,
  type DbConnection,
} from "@omnyo/db";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import { threadConversationOutlineResponseSchema } from "@omnyo/server-contract";
import {
  buildThreadConversationOutlinePage,
  closeThreadTimelinePageBuilders,
} from "../../../src/services/threads/timeline-page-builder.js";
import {
  ensureHistoryCache,
  persistHistoryCache,
  purgeHistoryCacheThread,
} from "../../../src/services/threads/history-cache-writer.js";
import {
  appendRows,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";

async function withWorkerThread(
  run: (fixture: Pick<TestThread, "db" | "thread">) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "omnyo-history-worker-"));
  const db = createConnection(join(directory, "app.db"));

  try {
    migrate(db);

    const thread = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
      status: "active",
    });

    await run({ db, thread });
  } finally {
    await closeThreadTimelinePageBuilders(db);
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function outline(
  db: DbConnection,
  threadId: string,
  role?: "assistant" | "user",
  priority?: "foreground" | "background",
) {
  const built = await buildThreadConversationOutlinePage(db, {
    threadId,
    priority,
    options: {
      completedTurnDisplay: "flat",
      includeClearedContextHistory: false,
      maxSeq: getLatestThreadSequence(db, { threadId }),
      role,
    },
  });

  expect(built.workerThreadId).toBeGreaterThan(0);

  return {
    built,
    response: threadConversationOutlineResponseSchema.parse(
      JSON.parse(built.body),
    ),
  };
}

function seed(
  fixture: Pick<TestThread, "db" | "thread">,
  text = "First answer",
) {
  appendRows(fixture, [
    {
      type: "client/turn/requested",
      data: {
        direction: "outbound",
        requestId: "creq_aaaaaaaaaa",
        source: "tell",
        initiator: "user",
        senderThreadId: null,
        input: [{ type: "text", text: "First question" }],
        target: { kind: "new-turn" },
        request: { method: "turn/start", params: {} },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "workspace-write",
          source: "client/turn/requested",
          serviceTier: "auto",
        },
      },
    },
    { type: "turn/started", turnId: "first" },
    {
      type: "turn/input/accepted",
      turnId: "first",
      data: { clientRequestId: "creq_aaaaaaaaaa" },
    },
    {
      type: "item/completed",
      turnId: "first",
      itemId: "answer-first",
      itemKind: "agentMessage",
      data: { item: { id: "answer-first", type: "agentMessage", text } },
    },
    { type: "turn/completed", turnId: "first", data: { status: "completed" } },
  ]);
}

describe("file-backed history outline workers", () => {
  it("cancels queued obsolete writes before acknowledging purge and keeps the newest later checkpoint without changing raw history", async () => {
    await withWorkerThread(async (fixture) => {
      const { db, thread } = fixture;
      seed(fixture);
      const original = await outline(db, thread.id);
      const firstSequence = original.response.maxSeq;
      appendRows(fixture, [
        { type: "turn/started", turnId: "queued-empty" },
        { type: "turn/started", turnId: "latest-empty" },
      ]);
      const state = getThreadHistoryState(db, thread.id);
      const sourceIdentity = historySourceIdentity(db.$client.name);
      const key = "writer-queue-contract";

      const snapshot = () =>
        db.$client
          .prepare("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence")
          .all(thread.id);

      const before = snapshot();

      const write = (sequence: number) =>
        persistHistoryCache(db, {
          threadId: thread.id,
          historyEpoch: state.epoch,
          rewriteEpoch: state.rewriteEpoch,
          records: [
            {
              key,
              threadId: thread.id,
              sourceIdentity,
              rewriteEpoch: state.rewriteEpoch,
              kind: "page",
              body: JSON.stringify({ ...original.response, maxSeq: sequence }),
              sequence,
              createdAt: Date.now(),
              expiresAt: null,
            },
          ],
        });

      await ensureHistoryCache(db);
      const blocker = new Database(historyCachePath(db.$client.name));
      let release: ReturnType<typeof setTimeout> | null = null;

      try {
        blocker.exec("BEGIN IMMEDIATE");
        expect(blocker.inTransaction).toBe(true);
        const active = write(firstSequence);
        const newestQueued = write(firstSequence + 2);
        const olderQueued = write(firstSequence + 1);
        const purge = purgeHistoryCacheThread(db, thread.id);
        release = setTimeout(() => blocker.exec("ROLLBACK"), 25);
        await Promise.all([active, newestQueued, olderQueued, purge]);

        const cache = openHistoryCache(historyCachePath(db.$client.name), {
          readonly: true,
        });

        try {
          expect(cache.storageUsage().records).toBe(0);
          const oldest = write(firstSequence);
          const newest = write(firstSequence + 2);
          const stale = write(firstSequence + 1);
          await Promise.all([oldest, newest, stale]);
          expect(
            cache.get({ key, sourceIdentity, now: Date.now() }),
          ).toMatchObject({
            sequence: firstSequence + 2,
            body: JSON.stringify({
              ...original.response,
              maxSeq: firstSequence + 2,
            }),
          });
        } finally {
          cache.close();
        }

        expect(snapshot()).toEqual(before);
        const current = await outline(db, thread.id);
        expect(current.response).toEqual({
          ...original.response,
          maxSeq: firstSequence + 2,
        });
      } finally {
        if (release !== null) clearTimeout(release);

        if (blocker.inTransaction) blocker.exec("ROLLBACK");
        blocker.close();
      }
    });
  }, 60_000);

  it("admits concurrent fresh lanes at the same outline sequence without changing either role or its anchors", async () => {
    await withWorkerThread(async (fixture) => {
      const { db, thread } = fixture;
      seed(fixture);
      const original = await outline(db, thread.id);
      await closeThreadTimelinePageBuilders(db);

      const [assistant, user] = await Promise.all([
        outline(db, thread.id, "assistant", "foreground"),
        outline(db, thread.id, "user", "background"),
      ]);

      expect(assistant.built.workerThreadId).not.toBe(
        user.built.workerThreadId,
      );
      expect(assistant.response.items).toEqual([original.response.items[1]]);
      expect(user.response.items).toEqual([original.response.items[0]]);
      expect(assistant.response.maxSeq).toBe(original.response.maxSeq);
      expect(user.response.maxSeq).toBe(original.response.maxSeq);
      await closeThreadTimelinePageBuilders(db);
      const restarted = await outline(db, thread.id);
      expect(restarted.response).toEqual(original.response);
    });
  }, 60_000);

  it("preserves exact previews, roles and anchors after worker restart without primary derived writes", async () => {
    await withWorkerThread(async (fixture) => {
      const { db, thread } = fixture;
      seed(fixture);
      const first = await outline(db, thread.id);
      expect(
        first.response.items.map(({ role, preview }) => ({ role, preview })),
      ).toEqual([
        { role: "user", preview: "First question" },
        { role: "assistant", preview: "First answer" },
      ]);
      const assistant = await outline(db, thread.id, "assistant");
      expect(assistant.response.items).toEqual([first.response.items[1]]);
      expect(
        db.$client
          .prepare("SELECT COUNT(*) AS count FROM thread_conversation_outlines")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db.$client
          .prepare("SELECT COUNT(*) AS count FROM thread_timeline_records")
          .get(),
      ).toEqual({ count: 0 });

      const cache = openHistoryCache(historyCachePath(db.$client.name), {
        readonly: true,
      });

      try {
        expect(cache.storageUsage().records).toBeGreaterThan(0);
      } finally {
        cache.close();
      }

      await closeThreadTimelinePageBuilders(db);
      appendRows(fixture, [
        { type: "turn/started", turnId: "live" },
        {
          type: "item/completed",
          turnId: "live",
          itemId: "answer-live",
          itemKind: "agentMessage",
          data: {
            item: {
              id: "answer-live",
              type: "agentMessage",
              text: "Live answer",
            },
          },
        },
      ]);
      const resumed = await outline(db, thread.id);
      expect(resumed.built.workerThreadId).not.toBe(first.built.workerThreadId);
      expect(resumed.response.items.slice(0, 2)).toEqual(first.response.items);
      expect(resumed.response.items.at(-1)?.preview).toBe("Live answer");
      db.$client
        .prepare(
          "UPDATE events SET data = json_set(data, '$.item.text', 'Rewritten answer') WHERE thread_id = ? AND item_id = 'answer-first'",
        )
        .run(thread.id);
      const rewritten = await outline(db, thread.id);
      expect(rewritten.response.items.map((item) => item.preview)).toEqual([
        "First question",
        "Rewritten answer",
        "Live answer",
      ]);
      expect(rewritten.built.historyEpoch).not.toBe(first.built.historyEpoch);
    });
  }, 60_000);

  it("redacts historical and rotated synthetic credential values before returning or persisting checkpoints", async () => {
    await withWorkerThread(async (fixture) => {
      const { db, thread } = fixture;
      appendRows(fixture, [
        {
          type: "provider.env-resolved",
          providerThreadId: "provider-memo",
          data: {
            entries: [
              {
                name: "SYNTHETIC_TOKEN",
                source: "shell",
                value: "synthetic-history-first-value",
              },
            ],
          },
        },
      ]);
      seed(fixture, "Result synthetic-history-first-value");
      const first = await outline(db, thread.id);
      expect(first.built.body).not.toContain("synthetic-history-first-value");
      appendRows(fixture, [
        {
          type: "provider.env-resolved",
          providerThreadId: "provider-memo",
          data: {
            entries: [
              {
                name: "SYNTHETIC_TOKEN",
                source: "shell",
                value: "synthetic-history-second-value",
              },
            ],
          },
        },
        { type: "turn/started", turnId: "rotated" },
        {
          type: "item/completed",
          turnId: "rotated",
          itemId: "rotated-answer",
          itemKind: "agentMessage",
          data: {
            item: {
              id: "rotated-answer",
              type: "agentMessage",
              text: "Rotation synthetic-history-first-value synthetic-history-second-value",
            },
          },
        },
      ]);
      await closeThreadTimelinePageBuilders(db);
      const rotated = await outline(db, thread.id);
      expect(
        rotated.response.items.map((item) => item.preview).join(" "),
      ).toContain("Rotation");

      for (const value of [
        "synthetic-history-first-value",
        "synthetic-history-second-value",
      ])
        expect(rotated.built.body).not.toContain(value);

      const inspection = createConnection(historyCachePath(db.$client.name), {
        readonly: true,
      });

      try {
        const stored = inspection.$client
          .prepare<[], { body: string }>(
            "SELECT body FROM history_cache_records",
          )
          .all();

        expect(stored.length).toBeGreaterThan(0);

        for (const record of stored)
          for (const value of [
            "synthetic-history-first-value",
            "synthetic-history-second-value",
          ])
            expect(record.body).not.toContain(value);
      } finally {
        inspection.$client.close();
      }
    });
  }, 60_000);

  it("acknowledges purge and never serves a deleted thread after all workers reopen", async () => {
    await withWorkerThread(async (fixture) => {
      const { db, thread } = fixture;
      seed(fixture);
      await outline(db, thread.id);
      expect(deleteThread(db, noopNotifier, thread.id)).toBe(true);
      await purgeHistoryCacheThread(db, thread.id);
      await closeThreadTimelinePageBuilders(db);
      await expect(outline(db, thread.id)).rejects.toMatchObject({
        status: 404,
      });

      const cache = openHistoryCache(historyCachePath(db.$client.name), {
        readonly: true,
      });

      try {
        expect(cache.storageUsage().records).toBe(0);
      } finally {
        cache.close();
      }
    });
  }, 60_000);

  it("reconciles a crash-surviving rewritten live thread before admission while retaining an unchanged thread checkpoint", async () => {
    await withWorkerThread(async (fixture) => {
      const { db, thread } = fixture;

      const unaffected = createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "codex",
        status: "active",
      });

      seed(fixture);
      seed({ db, thread: unaffected }, "Unaffected answer");
      await outline(db, thread.id);
      const original = await outline(db, unaffected.id);
      await closeThreadTimelinePageBuilders(db);
      const foreign = createConnection(db.$client.name);

      try {
        foreign.$client
          .prepare(
            "UPDATE events SET data = json_set(data, '$.item.text', 'Rewritten after crash') WHERE thread_id = ? AND item_id = 'answer-first'",
          )
          .run(thread.id);
      } finally {
        foreign.$client.close();
      }

      await ensureHistoryCache(db);

      const inspection = createConnection(historyCachePath(db.$client.name), {
        readonly: true,
      });

      try {
        expect(
          inspection.$client
            .prepare(
              "SELECT COUNT(*) AS count FROM history_cache_records WHERE thread_id = ?",
            )
            .get(thread.id),
        ).toEqual({ count: 0 });
        expect(
          inspection.$client
            .prepare<[string], { count: number }>(
              "SELECT COUNT(*) AS count FROM history_cache_records WHERE thread_id = ?",
            )
            .get(unaffected.id)?.count,
        ).toBeGreaterThan(0);
      } finally {
        inspection.$client.close();
      }

      expect((await outline(db, unaffected.id)).response).toEqual(
        original.response,
      );
      expect(
        (await outline(db, thread.id)).response.items.map(
          (item) => item.preview,
        ),
      ).toEqual(["First question", "Rewritten after crash"]);
    });
  }, 60_000);
});

import Database from "better-sqlite3";
