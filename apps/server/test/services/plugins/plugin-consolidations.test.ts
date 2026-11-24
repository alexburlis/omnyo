import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  consolidatedPluginOwner,
  stageLegacyPromptLibrary,
} from "../../../src/services/plugins/plugin-consolidations.js";

it.each([
  ["needs-you", "ask-user-question", "0.1.0", "0.2.0"],
  ["inline-vis", "inline-ui", "0.3.17", "0.4.0"],
  ["omnyo--prompt-library", "skill-discovery", "0.5.0", "0.6.0"],
])(
  "exposes %s until %s has a compatible merged version",
  (legacy, owner, oldVersion, newVersion) => {
    expect(consolidatedPluginOwner(legacy, () => undefined)).toBeUndefined();
    expect(consolidatedPluginOwner(legacy, () => oldVersion)).toBeUndefined();
    expect(
      consolidatedPluginOwner(legacy, (id) =>
        id === owner ? newVersion : undefined,
      ),
    ).toBe(owner);
    expect(
      consolidatedPluginOwner("unrelated", () => newVersion),
    ).toBeUndefined();
  },
);

it("recovers corrected legacy favorites on retry without duplicates or source mutation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-prompt-consolidation-"));
  const sourceDir = join(dataDir, "plugins", "omnyo--prompt-library");
  const target = new Database(":memory:");

  try {
    stageLegacyPromptLibrary(dataDir, target);
    expect(
      target
        .prepare("SELECT imported_count FROM prompt_library_legacy_sources")
        .get(),
    ).toEqual({
      imported_count: 0,
    });
    await mkdir(sourceDir, { recursive: true });
    const source = new Database(join(sourceDir, "data.db"));

    try {
      source.exec(`CREATE TABLE starred_prompts (
        id TEXT PRIMARY KEY, prompt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )`);
      const prompt = JSON.stringify({ text: "Keep this prompt", mentions: [] });
      source
        .prepare("INSERT INTO starred_prompts VALUES (?, ?, ?, ?)")
        .run("prompt_first", "{", 9, 12);
      stageLegacyPromptLibrary(dataDir, target);
      source
        .prepare("UPDATE starred_prompts SET prompt_json = ? WHERE id = ?")
        .run(prompt, "prompt_first");
      stageLegacyPromptLibrary(dataDir, target);
      stageLegacyPromptLibrary(dataDir, target);
      expect(
        target.prepare("SELECT * FROM prompt_library_legacy_prompts").all(),
      ).toEqual([
        {
          source_id: "omnyo--prompt-library",
          prompt_id: "prompt_first",
          prompt_json: prompt,
          created_at: 9,
          last_used_at: 12,
        },
      ]);
      expect(source.prepare("SELECT * FROM starred_prompts").all()).toEqual([
        {
          id: "prompt_first",
          prompt_json: prompt,
          created_at: 9,
          last_used_at: 12,
        },
      ]);
    } finally {
      source.close();
    }
  } finally {
    target.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
