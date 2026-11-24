import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { getThread } from "./data/threads.js";
import {
  threadQuestions,
  threadCallbacks,
  threadAttentionImports,
  pluginSettings,
} from "./schema.js";
import type { DbConnection } from "./connection.js";
import {
  threadQuestionInputSchema,
  legacyAttentionDecisionSchema as legacyDecisionSchema,
  legacyAttentionOptionsSchema as legacyOptions,
  legacyAttentionAnswerSchema as legacyAnswer,
  legacyAttentionCallbackSchema as legacyCallback,
  legacyAttentionExternalSchema as legacyExternal,
  type ThreadQuestion,
} from "@omnyo/domain";

export function adoptLegacyThreadAttention(
  db: DbConnection,
  args: { dataDir: string; pluginId: "decisions" | "needs-you" },
): { imported: boolean; threadIds: string[] } {
  const { dataDir, pluginId } = args;

  const alreadyImported =
    db
      .select()
      .from(threadAttentionImports)
      .where(eq(threadAttentionImports.pluginId, pluginId))
      .get() !== undefined;

  const path = join(dataDir, "plugins", pluginId, "data.db");
  const legacy = existsSync(path) ? new Database(path) : null;
  const changed = new Set<string>();

  try {
    legacy?.pragma("busy_timeout = 5000");
    legacy?.exec("BEGIN IMMEDIATE");

    const tableExists = (name: string) =>
      legacy !== null &&
      legacy
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== undefined;

    for (const name of pluginId === "decisions"
      ? ["decisions"]
      : ["callback_waits", "external_waits"]) {
      if (legacy === null || !tableExists(name)) continue;

      for (const operation of ["INSERT", "UPDATE", "DELETE"])
        legacy.exec(
          `CREATE TRIGGER IF NOT EXISTS native_attention_${name}_${operation.toLowerCase()} BEFORE ${operation} ON ${name} BEGIN SELECT RAISE(ABORT, 'Thread attention is now native; update this plugin'); END`,
        );
    }

    db.transaction(
      (tx) => {
        if (pluginId === "needs-you") {
          const settingsImportId = "needs-you-settings-v1";

          const settingsImported = tx
            .select()
            .from(threadAttentionImports)
            .where(eq(threadAttentionImports.pluginId, settingsImportId))
            .get();

          if (settingsImported === undefined) {
            const booleanKeys = new Set([
              "needsInput",
              "unreadFailed",
              "unreadSuccess",
              "queued",
              "working",
              "callbacks",
              "callbackLinks",
            ]);

            const legacySettings = tx
              .select()
              .from(pluginSettings)
              .where(eq(pluginSettings.pluginId, "needs-you"))
              .all();

            for (const setting of legacySettings) {
              const valid = booleanKeys.has(setting.key)
                ? setting.value === "true" || setting.value === "false"
                : setting.key === "intensity" &&
                  (setting.value === '"subtle"' || setting.value === '"bold"');

              if (valid)
                tx.insert(pluginSettings)
                  .values({ ...setting, pluginId: "ask-user-question" })
                  .onConflictDoNothing()
                  .run();
            }

            tx.insert(threadAttentionImports)
              .values({ pluginId: settingsImportId, importedAt: Date.now() })
              .run();
          }
        }

        if (
          tx
            .select()
            .from(threadAttentionImports)
            .where(eq(threadAttentionImports.pluginId, pluginId))
            .get()
        )
          return;

        if (
          legacy !== null &&
          pluginId === "decisions" &&
          tableExists("decisions")
        ) {
          const rows = legacyDecisionSchema
            .array()
            .parse(
              legacy
                .prepare(
                  "SELECT * FROM decisions ORDER BY position, created_at",
                )
                .all(),
            );

          for (const row of rows) {
            if (getThread(db, row.thread_id) === null) continue;
            const options = legacyOptions.parse(JSON.parse(row.options_json));

            const answer =
              row.answer_json === null
                ? null
                : legacyAnswer.parse(JSON.parse(row.answer_json));

            const question = threadQuestionInputSchema.parse({
              key: row.key,
              prompt: row.question,
              context: row.context,
              shortLabel: row.key ?? "Question",
              mode: "optional",
              multiSelect: row.multi_select === 1,
              allowFreeText: row.allow_text === 1,
              additiveNotes: true,
              options: options.map((option) => ({
                ...option,
                value: option.id,
                preview: null,
              })),
            });

            const nativeAnswer: ThreadQuestion["answer"] =
              answer === null
                ? null
                : {
                    selected: answer.optionIds,
                    ...(answer.text === null ? {} : { freeText: answer.text }),
                  };

            tx.insert(threadQuestions)
              .values({
                id: row.id,
                threadId: row.thread_id,
                revision: row.revision,
                question: JSON.stringify(question),
                mode: "optional",
                key: row.key,
                state: row.state,
                answer:
                  nativeAnswer === null ? null : JSON.stringify(nativeAnswer),
                queuedMessageId: null,
                createdAt: row.created_at,
                updatedAt: row.answered_at ?? row.created_at,
              })
              .onConflictDoNothing()
              .run();
            changed.add(row.thread_id);
          }
        }

        if (legacy !== null && pluginId === "needs-you") {
          if (tableExists("callback_waits")) {
            for (const wait of legacyCallback
              .array()
              .parse(legacy.prepare("SELECT * FROM callback_waits").all())) {
              if (getThread(db, wait.threadId) === null) continue;
              tx.insert(threadCallbacks)
                .values({ ...wait, sourceTitle: wait.sourceThreadId })
                .onConflictDoNothing()
                .run();
              changed.add(wait.threadId);
            }
          }

          if (tableExists("external_waits")) {
            for (const wait of legacyExternal
              .array()
              .parse(legacy.prepare("SELECT * FROM external_waits").all())) {
              if (getThread(db, wait.threadId) === null) continue;
              tx.insert(threadCallbacks)
                .values({
                  ...wait,
                  sourceThreadId: null,
                  afterSeq: 0,
                  matchText: `[unverified:${wait.id}]`,
                })
                .onConflictDoNothing()
                .run();
              changed.add(wait.threadId);
            }
          }
        }

        tx.insert(threadAttentionImports)
          .values({ pluginId, importedAt: Date.now() })
          .run();
      },
      { behavior: "immediate" },
    );
    legacy?.exec("COMMIT");
  } catch (error) {
    if (legacy?.inTransaction) legacy.exec("ROLLBACK");
    throw error;
  } finally {
    legacy?.close();
  }

  return { imported: !alreadyImported, threadIds: [...changed] };
}
