import { z } from "zod";
import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  librarySchema,
  type Library,
  type LibraryApply,
  type Workspace,
} from "./library-contract.ts";
import { applyLibraryOperation, emptyLibrary } from "./library-model.ts";
import { STARRED_PROMPT_MIGRATIONS } from "./prompt-store.ts";
import { curatedReferenceMigration } from "./curated-references.ts";

const storedLibrary = z.object({ content: z.string() });

const storedPack = z.object({ collection_id: z.string() });

function keys(workspace: Workspace): [string, string] {
  return [workspace.projectId, workspace.environmentId ?? ""];
}

export function createLibraryStore(api: PluginApi) {
  const db = api.storage.database();
  api.storage.migrate(db, [
    "CREATE TABLE skill_library (project_id TEXT NOT NULL, environment_id TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (project_id, environment_id))",
    "CREATE TABLE skill_library_packs (project_id TEXT NOT NULL, environment_id TEXT NOT NULL, digest TEXT NOT NULL, collection_id TEXT NOT NULL, PRIMARY KEY (project_id, environment_id, digest))",
    curatedReferenceMigration,
    ...STARRED_PROMPT_MIGRATIONS,
  ]);

  const selectLibrary = db.prepare(
    "SELECT content FROM skill_library WHERE project_id = ? AND environment_id = ?",
  );

  const saveLibrary = db.prepare(
    "INSERT INTO skill_library (project_id, environment_id, content) VALUES (?, ?, ?) ON CONFLICT(project_id, environment_id) DO UPDATE SET content = excluded.content",
  );

  const selectPack = db.prepare(
    "SELECT collection_id FROM skill_library_packs WHERE project_id = ? AND environment_id = ? AND digest = ?",
  );

  const savePack = db.prepare(
    "INSERT INTO skill_library_packs (project_id, environment_id, digest, collection_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, environment_id, digest) DO UPDATE SET collection_id = excluded.collection_id",
  );

  function get(workspace: Workspace): Library {
    const row = selectLibrary.get(...keys(workspace));

    if (row === undefined) return emptyLibrary();

    return librarySchema.parse(JSON.parse(storedLibrary.parse(row).content));
  }

  function save(workspace: Workspace, next: Library): void {
    const content = JSON.stringify(next);

    if (Buffer.byteLength(content, "utf8") > 8 * 1024 * 1024)
      throw new Error("This library exceeds the workspace storage limit.");
    saveLibrary.run(...keys(workspace), content);
  }

  const apply = db.transaction((input: LibraryApply) => {
    const current = get(input);

    if (current.revision !== input.revision)
      throw new Error("The library changed. Reload it before saving your edit.");
    const next = applyLibraryOperation(current, input.operation);
    save(input, next);

    return next;
  });

  const registerPack = db.transaction(
    (
      workspace: Workspace,
      digest: string,
      add: (current: Library) => { library: Library; collectionId: string },
    ) => {
      const current = get(workspace);
      const row = selectPack.get(...keys(workspace), digest);

      if (row !== undefined) {
        const id = storedPack.parse(row).collection_id;

        if (current.collections.some((item) => item.id === id)) return id;
      }

      const result = add(current);
      save(workspace, result.library);
      savePack.run(...keys(workspace), digest, result.collectionId);

      return result.collectionId;
    },
  );

  const selectLibraries = db.prepare(
    "SELECT project_id, environment_id, content FROM skill_library",
  );

  const storedWorkspace = z.object({
    project_id: z.string(),
    environment_id: z.string(),
    content: z.string(),
  });

  function savedPrompts() {
    return selectLibraries.all().flatMap((value) => {
      const row = storedWorkspace.parse(value);
      const library = librarySchema.parse(JSON.parse(row.content));

      return library.prompts.map((prompt) => ({
        ...prompt,
        projectId: row.project_id,
        environmentId: row.environment_id || null,
      }));
    });
  }

  return { get, apply, registerPack, savedPrompts };
}
