import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import semver from "semver";
import { z } from "zod";

const PROMPT_LIBRARY_ID = "omnyo--prompt-library";

const SKILLS_ID = "skill-discovery";

const SKILLS_WITH_PROMPT_LIBRARY = ">=0.6.0";

const consolidations: ReadonlyMap<string, { id: string; range: string }> =
  new Map([
    ["needs-you", { id: "ask-user-question", range: ">=0.2.0" }],
    ["inline-vis", { id: "inline-ui", range: ">=0.4.0" }],
    [PROMPT_LIBRARY_ID, { id: SKILLS_ID, range: SKILLS_WITH_PROMPT_LIBRARY }],
  ]);

export function consolidatedPluginOwner(
  originalId: string,
  activeBundleVersion: (id: string) => string | undefined,
): string | undefined {
  const successor = consolidations.get(originalId);

  if (successor === undefined) return undefined;
  const version = activeBundleVersion(successor.id);

  return version !== undefined && semver.satisfies(version, successor.range)
    ? successor.id
    : undefined;
}

export function needsPromptLibraryAdoption(
  id: string,
  version: string,
): boolean {
  return (
    id === SKILLS_ID && semver.satisfies(version, SKILLS_WITH_PROMPT_LIBRARY)
  );
}

export function isOmnyoConsolidationSource(
  id: string,
  source: string,
  repositoryUrl: string | null | undefined,
): boolean {
  if (source === `builtin:${id}`) return true;

  return (
    (id === "inline-ui" || id === SKILLS_ID) &&
    source.startsWith("path:") &&
    (repositoryUrl ===
      `https://github.com/alexburlis/omnyo-plugins/tree/HEAD/${id}` ||
      repositoryUrl ===
        `https://github.com/alexburlis/omnyo/tree/HEAD/standalone-plugins/${id}`)
  );
}

const legacyPromptRows = z.array(
  z.object({
    id: z.string(),
    prompt_json: z.string(),
    created_at: z.number().int(),
    last_used_at: z.number().int().nullable(),
  }),
);

function readLegacyPromptRows(dataDir: string) {
  const sourcePath = join(dataDir, "plugins", PROMPT_LIBRARY_ID, "data.db");

  if (!existsSync(sourcePath)) return [];

  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const table = source
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'starred_prompts'",
      )
      .get();

    if (table === undefined) return [];

    return legacyPromptRows.parse(
      source
        .prepare(
          "SELECT id, prompt_json, created_at, last_used_at FROM starred_prompts",
        )
        .all(),
    );
  } finally {
    source.close();
  }
}

export function stageLegacyPromptLibrary(
  dataDir: string,
  target: Database.Database,
): void {
  const rows = readLegacyPromptRows(dataDir);

  target.transaction(() => {
    target.exec(`CREATE TABLE IF NOT EXISTS prompt_library_legacy_prompts (
        source_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        prompt_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        PRIMARY KEY (source_id, prompt_id)
      );
      CREATE TABLE IF NOT EXISTS prompt_library_legacy_sources (
        source_id TEXT PRIMARY KEY,
        imported_count INTEGER NOT NULL
      );`);

    const stage = target.prepare(`
        INSERT INTO prompt_library_legacy_prompts
          (source_id, prompt_id, prompt_json, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_id, prompt_id) DO UPDATE SET
          prompt_json = excluded.prompt_json,
          created_at = excluded.created_at,
          last_used_at = excluded.last_used_at
      `);

    for (const row of rows) {
      stage.run(
        PROMPT_LIBRARY_ID,
        row.id,
        row.prompt_json,
        row.created_at,
        row.last_used_at,
      );
    }

    target
      .prepare(`
      INSERT INTO prompt_library_legacy_sources (source_id, imported_count)
      VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET imported_count = excluded.imported_count
    `)
      .run(PROMPT_LIBRARY_ID, rows.length);
  })();
}
