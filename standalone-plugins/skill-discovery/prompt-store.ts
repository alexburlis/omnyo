import { randomUUID } from "node:crypto";
import type { PluginApi, ComposerDraft } from "@omnyo/plugin-sdk";
import { promptSchema, type legacyPromptImportSchema } from "./prompt-contract.ts";
import type { z } from "zod";

type PluginDatabase = ReturnType<PluginApi["storage"]["database"]>;

export const STARRED_PROMPT_MIGRATIONS = [
  `CREATE TABLE starred_prompts (
    id TEXT PRIMARY KEY,
    prompt_json TEXT NOT NULL,
    text TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE TABLE prompt_library_imports (
    source_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (source_id, prompt_id)
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_library_legacy_sources (
    source_id TEXT PRIMARY KEY,
    imported_count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_library_legacy_prompts (
    source_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    prompt_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    PRIMARY KEY (source_id, prompt_id)
  )`,
];

export interface StarredPrompt {
  id: string;
  prompt: ComposerDraft;
  createdAt: number;
  lastUsedAt: number | null;
}

interface StarredPromptRecord {
  id: string;
  prompt_json: string;
  created_at: number;
  last_used_at: number | null;
}

function fromRecord(record: StarredPromptRecord): StarredPrompt {
  const { text, mentions } = promptSchema.parse(JSON.parse(record.prompt_json));

  return {
    id: record.id,
    prompt: { text, mentions },
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
  };
}

export interface StarredPromptStore {
  list(): StarredPrompt[];
  star(prompt: ComposerDraft, now: number): StarredPrompt | null;
  unstar(id: string): boolean;
  markUsed(id: string, now: number): void;
  importLegacy(input: z.infer<typeof legacyPromptImportSchema>): number;
  hasLegacySnapshot(): boolean;
}

export function createStarredPromptStore(db: PluginDatabase): StarredPromptStore {
  const listStatement = db.prepare<[], StarredPromptRecord>(
    `SELECT id, prompt_json, created_at, last_used_at
       FROM starred_prompts
      ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC`,
  );

  const findByTextStatement = db.prepare<[string], StarredPromptRecord>(
    `SELECT id, prompt_json, created_at, last_used_at
       FROM starred_prompts WHERE text = ?`,
  );

  const insertStatement = db.prepare(
    `INSERT INTO starred_prompts (id, prompt_json, text, created_at, last_used_at)
     VALUES (?, ?, ?, ?, NULL)`,
  );

  const deleteStatement = db.prepare(`DELETE FROM starred_prompts WHERE id = ?`);

  const markUsedStatement = db.prepare(`UPDATE starred_prompts SET last_used_at = ? WHERE id = ?`);

  const importedStatement = db.prepare<[string, string], { target_id: string }>(
    "SELECT target_id FROM prompt_library_imports WHERE source_id = ? AND prompt_id = ?",
  );

  const importStatement = db.prepare(
    "INSERT INTO starred_prompts (id, prompt_json, text, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
  );

  const receiptStatement = db.prepare(
    "INSERT INTO prompt_library_imports (source_id, prompt_id, target_id) VALUES (?, ?, ?)",
  );

  const findByIdStatement = db.prepare<[string], StarredPromptRecord>(
    "SELECT id, prompt_json, created_at, last_used_at FROM starred_prompts WHERE id = ?",
  );

  const resolveId = (id: string) =>
    importedStatement.get("omnyo--prompt-library", id)?.target_id ?? id;

  const importLegacy = db.transaction((input: z.infer<typeof legacyPromptImportSchema>) => {
    let imported = 0;

    for (const item of input.prompts) {
      if (importedStatement.get(input.sourceId, item.id)) continue;
      const existing = findByTextStatement.get(item.prompt.text);
      let targetId = existing?.id ?? item.id;

      if (!existing) {
        if (findByIdStatement.get(targetId))
          throw new Error("A migrated prompt ID conflicts with an existing prompt.");
        importStatement.run(
          targetId,
          JSON.stringify(item.prompt),
          item.prompt.text,
          item.createdAt,
          item.lastUsedAt,
        );
        imported += 1;
      }

      receiptStatement.run(input.sourceId, item.id, targetId);
    }

    return imported;
  });

  const staged = db.prepare<[], StarredPromptRecord & { source_id: string }>(
    "SELECT source_id, prompt_id AS id, prompt_json, created_at, last_used_at FROM prompt_library_legacy_prompts",
  );

  importLegacy({
    sourceId: "omnyo--prompt-library",
    prompts: staged
      .all()
      .filter((row) => row.source_id === "omnyo--prompt-library")
      .map(fromRecord),
  });

  const snapshot = db.prepare<[string], { imported_count: number }>(
    "SELECT imported_count FROM prompt_library_legacy_sources WHERE source_id = ?",
  );

  return {
    hasLegacySnapshot: () => snapshot.get("omnyo--prompt-library") !== undefined,
    importLegacy,
    list: () => listStatement.all().map(fromRecord),
    star({ text, mentions }, now) {
      if (text.trim().length === 0) return null;
      const existing = findByTextStatement.get(text);

      if (existing !== undefined) return fromRecord(existing);
      const id = `prompt_${randomUUID()}`;
      insertStatement.run(id, JSON.stringify({ text, mentions }), text, now);

      return {
        id,
        prompt: { text, mentions },
        createdAt: now,
        lastUsedAt: null,
      };
    },
    unstar: (id) => deleteStatement.run(resolveId(id)).changes > 0,
    markUsed(id, now) {
      markUsedStatement.run(now, resolveId(id));
    },
  };
}
