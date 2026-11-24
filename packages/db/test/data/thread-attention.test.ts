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
  getCallbackSourceState,
  createQueuedThreadMessage,
  queuedThreadMessages,
  listNativeWorkerOwners,
  listThreadCallbacks,
  listThreadQuestions,
  threads,
} from "../../src/index.js";

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
      expect(listThreadCallbacks(db, source.id)).toMatchObject([
        { id: "external-1", sourceThreadId: null, sourceState: "unverified" },
      ]);
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

  it("projects eligible queues, human waits and worker ownership from native records", () => {
    const db = createConnection(":memory:");
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "test" });

    const { project } = createProject(db, noopNotifier, {
      name: "test",
      source: { type: "local_path", hostId: host.id, path: "/tmp" },
    });

    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    try {
      expect(getCallbackSourceState(db, null)).toBe("unverified");
      expect(getCallbackSourceState(db, source.id)).toBe("idle");

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

      expect(getCallbackSourceState(db, source.id)).toBe("waiting");
      db.update(queuedThreadMessages)
        .set({ waitingOn: JSON.stringify({ kind: "interaction" }) })
        .where(eq(queuedThreadMessages.id, queue.id))
        .run();
      expect(getCallbackSourceState(db, source.id)).toBe("needs-input");
      db.update(queuedThreadMessages)
        .set({ failureReason: "Fixture failure" })
        .where(eq(queuedThreadMessages.id, queue.id))
        .run();
      expect(getCallbackSourceState(db, source.id)).toBe("idle");

      const worker = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "active",
        visibility: "hidden",
        originPluginId: "workflows",
        lifecycleOwnerThreadId: source.id,
      });

      expect(listNativeWorkerOwners(db, [source.id]).has(source.id)).toBe(true);
      expect(getCallbackSourceState(db, source.id)).toBe("working");
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
      expect(getCallbackSourceState(db, source.id)).toBe("error");
      db.update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, source.id))
        .run();
      expect(getCallbackSourceState(db, source.id)).toBe("archived");
      db.update(threads)
        .set({ deletedAt: Date.now() })
        .where(eq(threads.id, source.id))
        .run();
      expect(getCallbackSourceState(db, source.id)).toBe("unavailable");
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
