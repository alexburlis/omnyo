import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createConnection,
  migrate,
  createProject,
  createThread,
  noopNotifier,
  upsertHost,
  threadQuestions,
  threadCallbacks,
  pluginSettings,
  adoptLegacyThreadAttention,
  createQueuedThreadMessage,
  queuedThreadMessages,
  listNativeWorkerOwners,
  listThreadCallbacks,
  listThreadQuestions,
  readThreadAttentionFacts,
  threads,
  threadFailures,
  threadOwnerInputs,
  threadProducers,
  threadWaitConditions,
  threadWaits,
  type DbConnection,
} from "../../src/index.js";

function insertCallbackWait(
  db: DbConnection,
  args: { id: string; waiterId: string; sourceId: string | null },
): void {
  const now = Date.now();
  db.insert(threadWaits)
    .values({
      id: args.id,
      threadId: args.waiterId,
      key: `callback:${args.sourceId ?? args.id}`,
      generation: 1,
      kind: args.sourceId === null ? "event" : "chat",
      status: "live",
      readiness: "all",
      createdBy: "agent",
      automationId: null,
      ownerAccepted: false,
      forText: "Verify result",
      resumeText: null,
      marker: `[omnyo wait ${args.id}]`,
      deadline: now + 60_000,
      chainStartAt: now,
      nextCheckAt: null,
      checkIntervalMs: null,
      checkCount: 0,
      reminderAt: null,
      reminderReceiptId: null,
      questionId: null,
      questionRevision: null,
      coversReceiptIds: "[]",
      proposalKind: null,
      proposalReceiptId: null,
      afterWaitId: null,
      dispatchKey: null,
      dispatchQueuedMessageId: null,
      dispatchRequestId: null,
      closedReason: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    })
    .run();
  db.insert(threadWaitConditions)
    .values({
      waitId: args.id,
      conditionKey:
        args.sourceId === null
          ? `event:legacy-${args.id}`
          : `chat:${args.sourceId}`,
      kind: args.sourceId === null ? "event" : "chat",
      target: args.sourceId ?? `legacy:${args.id}`,
      label: "Source label",
      state: "pending",
      afterSeq: args.sourceId === null ? null : 7,
      result: null,
      metAt: null,
      stallWokenAt: null,
      stallReceiptId: null,
    })
    .run();
}

describe("native attention adoption", () => {
  it("adopts only missing visual preferences once after an earlier callback adoption", () => {
    const db = createConnection(":memory:");
    migrate(db);

    try {
      adoptLegacyThreadAttention(db, {
        dataDir: "/path/without/legacy/data",
        pluginId: "needs-you",
      });
      db.delete(pluginSettings).run();
      db.$client
        .prepare("DELETE FROM thread_attention_imports WHERE plugin_id = ?")
        .run("needs-you-settings-v1");
      db.insert(pluginSettings)
        .values([
          {
            pluginId: "needs-you",
            key: "needsInput",
            value: "false",
            updatedAt: 1,
          },
          {
            pluginId: "needs-you",
            key: "callbackLinks",
            value: "false",
            updatedAt: 1,
          },
          {
            pluginId: "needs-you",
            key: "intensity",
            value: '"bold"',
            updatedAt: 1,
          },
          {
            pluginId: "needs-you",
            key: "queued",
            value: '"wrong"',
            updatedAt: 1,
          },
          {
            pluginId: "needs-you",
            key: "unrelated",
            value: "true",
            updatedAt: 1,
          },
          {
            pluginId: "ask-user-question",
            key: "needsInput",
            value: "true",
            updatedAt: 2,
          },
        ])
        .run();

      expect(
        adoptLegacyThreadAttention(db, {
          dataDir: "/path/without/legacy/data",
          pluginId: "needs-you",
        }).imported,
      ).toBe(false);

      const preferences = () =>
        db
          .select()
          .from(pluginSettings)
          .where(eq(pluginSettings.pluginId, "ask-user-question"))
          .all()
          .map(({ key, value }) => ({ key, value }));

      expect(preferences()).toEqual(
        expect.arrayContaining([
          { key: "needsInput", value: "true" },
          { key: "callbackLinks", value: "false" },
          { key: "intensity", value: '"bold"' },
        ]),
      );
      expect(preferences()).toHaveLength(3);

      db.delete(pluginSettings)
        .where(eq(pluginSettings.pluginId, "ask-user-question"))
        .run();
      adoptLegacyThreadAttention(db, {
        dataDir: "/path/without/legacy/data",
        pluginId: "needs-you",
      });

      expect(preferences()).toEqual([]);
      expect(
        db
          .select()
          .from(pluginSettings)
          .where(eq(pluginSettings.pluginId, "needs-you"))
          .all(),
      ).toHaveLength(5);
    } finally {
      db.$client.close();
    }
  });

  it("preserves final Decisions revisions, answers, notes and closed states while fencing old writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnyo-attention-adoption-"));
    const db = createConnection(":memory:");
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "test" });

    const { project } = createProject(db, noopNotifier, {
      name: "test",
      source: { type: "local_path", hostId: host.id, path: directory },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    const source = join(directory, "plugins", "decisions");
    mkdirSync(source, { recursive: true });
    const legacy = new Database(join(source, "data.db"));

    try {
      legacy.exec(
        "CREATE TABLE decisions (id TEXT PRIMARY KEY, thread_id TEXT, key TEXT, question TEXT, context TEXT, multi_select INTEGER, allow_text INTEGER, options_json TEXT, state TEXT, answer_json TEXT, created_at INTEGER, answered_at INTEGER, revision INTEGER, position INTEGER)",
      );

      const options = JSON.stringify([
        { id: "a", label: "Compact", description: null, recommended: true },
        { id: "b", label: "Detailed", description: null, recommended: false },
      ]);

      const insert = legacy.prepare(
        "INSERT INTO decisions VALUES (?, ?, NULL, ?, NULL, 0, 1, ?, ?, ?, 1, NULL, 3, 0)",
      );

      insert.run(
        "dec_open",
        thread.id,
        "Before cutover",
        options,
        "open",
        null,
      );
      insert.run(
        "dec_answered",
        thread.id,
        "Answered",
        options,
        "answered",
        JSON.stringify({ optionIds: ["a"], text: "Keep details" }),
      );
      legacy
        .prepare("UPDATE decisions SET question = ? WHERE id = ?")
        .run("Final legacy question", "dec_open");
      expect(
        adoptLegacyThreadAttention(db, {
          dataDir: directory,
          pluginId: "decisions",
        }).imported,
      ).toBe(true);

      const open = db
        .select()
        .from(threadQuestions)
        .where(eq(threadQuestions.id, "dec_open"))
        .get();

      expect(open).toMatchObject({ revision: 3, state: "open" });
      expect(JSON.parse(open?.question ?? "null")).toMatchObject({
        prompt: "Final legacy question",
        additiveNotes: true,
      });
      expect(
        JSON.parse(
          db
            .select()
            .from(threadQuestions)
            .where(eq(threadQuestions.id, "dec_answered"))
            .get()?.answer ?? "null",
        ),
      ).toEqual({ selected: ["a"], freeText: "Keep details" });
      expect(() =>
        legacy.prepare("UPDATE decisions SET state = 'answered'").run(),
      ).toThrow("now native");
      db.update(threadQuestions)
        .set({ state: "skipped" })
        .where(eq(threadQuestions.id, "dec_open"))
        .run();
      expect(
        adoptLegacyThreadAttention(db, {
          dataDir: directory,
          pluginId: "decisions",
        }).imported,
      ).toBe(false);
      expect(
        db
          .select()
          .from(threadQuestions)
          .where(eq(threadQuestions.id, "dec_open"))
          .get()?.state,
      ).toBe("skipped");
      expect(
        legacy
          .prepare("SELECT state FROM decisions WHERE id = ?")
          .get("dec_open"),
      ).toEqual({ state: "open" });
    } finally {
      legacy.close();
      db.$client.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("keeps callback generations, markers and cursors and prevents completed waits reappearing", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnyo-callback-adoption-"));
    const db = createConnection(":memory:");
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "test" });

    const { project } = createProject(db, noopNotifier, {
      name: "test",
      source: { type: "local_path", hostId: host.id, path: directory },
    });

    const consumer = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    const path = join(directory, "plugins", "needs-you");
    mkdirSync(path, { recursive: true });
    const legacy = new Database(join(path, "data.db"));

    try {
      legacy.exec(
        "CREATE TABLE callback_waits (threadId TEXT PRIMARY KEY, id TEXT, sourceThreadId TEXT, reason TEXT, createdAt INTEGER, afterSeq INTEGER, matchText TEXT); CREATE TABLE external_waits (threadId TEXT PRIMARY KEY, id TEXT, sourceKey TEXT, sourceTitle TEXT, reason TEXT, createdAt INTEGER)",
      );
      legacy
        .prepare(
          "INSERT INTO callback_waits VALUES (?, 'generation-1', ?, 'Verify result', 12, 37, 'exact marker')",
        )
        .run(consumer.id, source.id);
      legacy
        .prepare(
          "INSERT INTO external_waits VALUES (?, 'external-1', 'legacy-owner', 'Manual legacy source', 'Unverified completion', 13)",
        )
        .run(source.id);
      expect(
        adoptLegacyThreadAttention(db, {
          dataDir: directory,
          pluginId: "needs-you",
        }).imported,
      ).toBe(true);
      expect(
        db
          .select()
          .from(threadCallbacks)
          .where(eq(threadCallbacks.id, "generation-1"))
          .get(),
      ).toMatchObject({
        threadId: consumer.id,
        id: "generation-1",
        sourceThreadId: source.id,
        createdAt: 12,
        afterSeq: 37,
        matchText: "exact marker",
      });
      db.delete(threadCallbacks)
        .where(eq(threadCallbacks.id, "generation-1"))
        .run();
      expect(
        db
          .select()
          .from(threadCallbacks)
          .where(eq(threadCallbacks.id, "external-1"))
          .get(),
      ).toMatchObject({ threadId: source.id, sourceThreadId: null });
      db.delete(threadCallbacks)
        .where(eq(threadCallbacks.id, "external-1"))
        .run();
      expect(
        adoptLegacyThreadAttention(db, {
          dataDir: directory,
          pluginId: "needs-you",
        }).imported,
      ).toBe(false);
      expect(db.select().from(threadCallbacks).all()).toHaveLength(0);
      expect(() => legacy.prepare("DELETE FROM callback_waits").run()).toThrow(
        "now native",
      );
    } finally {
      legacy.close();
      db.$client.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("projects owed callback waits and classifies their sources the same way in both readers", () => {
    const db = createConnection(":memory:");
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "test" });

    const { project } = createProject(db, noopNotifier, {
      name: "test",
      source: { type: "local_path", hostId: host.id, path: "/tmp" },
    });

    const create = (status: "idle" | "active") =>
      createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status,
      });

    const waiter = create("idle");
    const source = create("idle");
    const external = create("idle");
    insertCallbackWait(db, {
      id: "wait-1",
      waiterId: waiter.id,
      sourceId: source.id,
    });
    insertCallbackWait(db, {
      id: "wait-2",
      waiterId: external.id,
      sourceId: null,
    });

    const state = () => {
      const listed = listThreadCallbacks(db, waiter.id);
      const facts = readThreadAttentionFacts(db, [waiter.id]).get(waiter.id);
      expect(facts?.callbacks).toEqual(listed);

      return listed.map((callback) => callback.sourceState);
    };

    try {
      expect(listThreadCallbacks(db, waiter.id)).toEqual([
        {
          id: "wait-1",
          threadId: waiter.id,
          sourceThreadId: source.id,
          sourceTitle: expect.any(String),
          reason: "Verify result",
          createdAt: expect.any(Number),
          afterSeq: 7,
          matchText: "[omnyo wait wait-1]",
          sourceState: "idle",
        },
      ]);
      expect(listThreadCallbacks(db, external.id)).toMatchObject([
        {
          id: "wait-2",
          sourceThreadId: null,
          sourceTitle: "Source label",
          sourceState: "unverified",
        },
      ]);
      expect(listThreadCallbacks(db).map((callback) => callback.id)).toEqual([
        "wait-1",
        "wait-2",
      ]);

      const queue = createQueuedThreadMessage(db, noopNotifier, {
        threadId: source.id,
        content: [{ type: "text", text: "Complete fixture", mentions: [] }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      expect(state()).toEqual(["waiting"]);
      db.update(queuedThreadMessages)
        .set({ waitingOn: JSON.stringify({ kind: "interaction" }) })
        .where(eq(queuedThreadMessages.id, queue.id))
        .run();
      expect(state()).toEqual(["needs-input"]);
      db.update(queuedThreadMessages)
        .set({ failureReason: "Fixture failure" })
        .where(eq(queuedThreadMessages.id, queue.id))
        .run();
      expect(state()).toEqual(["idle"]);

      insertCallbackWait(db, {
        id: "wait-3",
        waiterId: source.id,
        sourceId: external.id,
      });
      expect(state()).toEqual(["waiting"]);
      db.update(threadWaits)
        .set({ status: "closed" })
        .where(eq(threadWaits.id, "wait-3"))
        .run();
      expect(state()).toEqual(["idle"]);

      const now = Date.now();
      db.insert(threadProducers)
        .values({
          id: "producer-1",
          threadId: source.id,
          kind: "goal",
          pluginId: "pursue",
          label: "Goal",
          status: "active",
          heldTurnId: null,
          heldSummary: null,
          heldUntil: null,
          endedReason: null,
          createdAt: now,
          updatedAt: now,
          endedAt: null,
        })
        .run();
      expect(state()).toEqual(["waiting"]);
      db.update(threadProducers)
        .set({ status: "ended" })
        .where(eq(threadProducers.id, "producer-1"))
        .run();
      expect(state()).toEqual(["idle"]);

      db.insert(threadOwnerInputs)
        .values({
          id: "input-1",
          threadId: source.id,
          kind: "message",
          state: "owed",
          requestId: null,
          queuedMessageId: null,
          turnId: null,
          receiptId: null,
          producerId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      expect(state()).toEqual(["waiting"]);
      db.update(threadOwnerInputs)
        .set({ state: "covered" })
        .where(eq(threadOwnerInputs.id, "input-1"))
        .run();
      expect(state()).toEqual(["idle"]);

      const worker = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "active",
        visibility: "hidden",
        originPluginId: "workflows",
        lifecycleOwnerThreadId: source.id,
      });

      expect(listNativeWorkerOwners(db, [source.id]).has(source.id)).toBe(true);
      expect(state()).toEqual(["working"]);
      db.update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, worker.id))
        .run();
      expect(listNativeWorkerOwners(db, [source.id]).has(source.id)).toBe(
        false,
      );
      db.update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, source.id))
        .run();
      expect(state()).toEqual(["error"]);
      db.insert(threadFailures)
        .values({
          id: "failure-1",
          threadId: source.id,
          turnId: null,
          requestId: null,
          waitId: null,
          state: "held",
          reason: "Rate limited",
          decisionDeadline: null,
          retryQueuedMessageId: null,
          receiptId: null,
          incidentKey: null,
          incidentLabel: null,
          resetAt: null,
          resolvedBy: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        })
        .run();
      expect(state()).toEqual(["waiting"]);
      db.update(threadFailures)
        .set({ state: "actionable" })
        .where(eq(threadFailures.id, "failure-1"))
        .run();
      expect(state()).toEqual(["error"]);
      db.update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, source.id))
        .run();
      expect(state()).toEqual(["archived"]);
      db.update(threads)
        .set({ deletedAt: Date.now() })
        .where(eq(threads.id, source.id))
        .run();
      expect(state()).toEqual(["unavailable"]);

      db.update(threadWaitConditions)
        .set({ state: "met" })
        .where(eq(threadWaitConditions.waitId, "wait-1"))
        .run();
      expect(listThreadCallbacks(db, waiter.id)).toEqual([]);
      db.update(threadWaitConditions)
        .set({ state: "pending" })
        .where(eq(threadWaitConditions.waitId, "wait-1"))
        .run();
      db.update(threadWaits)
        .set({ status: "dispatched" })
        .where(eq(threadWaits.id, "wait-1"))
        .run();
      expect(listThreadCallbacks(db, waiter.id)).toEqual([]);
      db.update(threadWaits)
        .set({ status: "live" })
        .where(eq(threadWaits.id, "wait-1"))
        .run();
      db.update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, waiter.id))
        .run();
      expect(listThreadCallbacks(db, waiter.id)).toEqual([]);
    } finally {
      db.$client.close();
    }
  });
});

describe("question answerer", () => {
  it("parses answered_by into answeredBy and keeps older rows without it null", () => {
    const db = createConnection(":memory:");
    migrate(db);

    try {
      const host = upsertHost(db, noopNotifier, { name: "test" });

      const { project } = createProject(db, noopNotifier, {
        name: "test",
        source: { type: "local_path", hostId: host.id, path: tmpdir() },
      });

      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });

      const legacyQuestion = JSON.stringify({
        key: null,
        prompt: "Which layout?",
        context: null,
        shortLabel: "Layout",
        mode: "optional",
        multiSelect: false,
        allowFreeText: true,
        additiveNotes: true,
        options: [],
      });

      const plugin = {
        kind: "plugin",
        pluginId: "chief",
        ruleId: "rule_layout",
        reason: "The owner always picks the compact layout",
      };

      for (const [id, answeredBy] of [
        ["question_owner", null],
        ["question_plugin", JSON.stringify(plugin)],
      ] as const)
        db.insert(threadQuestions)
          .values({
            id,
            threadId: thread.id,
            revision: 1,
            question: legacyQuestion,
            mode: "optional",
            key: null,
            state: "answered",
            answer: JSON.stringify({ selected: [], freeText: "Compact" }),
            queuedMessageId: null,
            answeredBy,
            createdAt: 1,
            updatedAt: 1,
          })
          .run();

      expect(
        listThreadQuestions(db, thread.id, true).map((question) => ({
          id: question.id,
          answeredBy: question.answeredBy,
          delegable: question.question.delegable,
        })),
      ).toEqual([
        { id: "question_owner", answeredBy: null, delegable: false },
        { id: "question_plugin", answeredBy: plugin, delegable: false },
      ]);
    } finally {
      db.$client.close();
    }
  });
});
