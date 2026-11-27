import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createLibraryStore } from "./library-store.ts";
import { createPromptService } from "./prompt-service.ts";
import { createStarredPromptStore } from "./prompt-store.ts";
import { legacyPromptImportSchema } from "./prompt-contract.ts";

const globalSearch = {
  query: "",
  scope: "global",
  projectId: null,
  threadId: null,
  composer: "follow-up",
};

const draft = (text) => ({ text, mentions: [] });

const legacy = (id, text) => ({ id, prompt: draft(text), createdAt: 12, lastUsedAt: 24 });

function setup(t, history = [], stage = []) {
  const db = new Database(":memory:");
  t.after(() => db.close());

  if (stage.length) {
    db.exec(
      "CREATE TABLE prompt_library_legacy_prompts (source_id TEXT NOT NULL, prompt_id TEXT NOT NULL, prompt_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, PRIMARY KEY(source_id,prompt_id))",
    );

    for (const row of stage)
      db.prepare("INSERT INTO prompt_library_legacy_prompts VALUES (?, ?, ?, ?, ?)").run(
        "omnyo--prompt-library",
        row.id,
        JSON.stringify(row.prompt),
        row.createdAt,
        row.lastUsedAt,
      );
  }

  const pages = [];

  const api = {
    storage: {
      database: () => db,
      migrate: (database, statements) => statements.forEach((sql) => database.exec(sql)),
    },
    sdk: {
      plugins: { list: async () => ({ plugins: [] }) },
      projects: { list: async () => [{ id: "project", name: "Project" }] },
      experimental_promptHistory: {
        list: async (args) => {
          pages.push(args);
          const offset = Number(args.cursor ?? 0);
          const end = offset + Number(args.limit);

          return {
            entries: history.slice(offset, end),
            nextCursor: end < history.length ? String(end) : null,
          };
        },
      },
    },
  };

  const library = createLibraryStore(api);

  return { db, api, library, history, pages, service: createPromptService(api, library) };
}

test("imports staged stars with original identity and metadata, and never resurrects an unstarred import", async (t) => {
  const row = legacy("legacy-id", "Read @notes");
  row.prompt.mentions = [
    {
      kind: "path",
      from: 5,
      to: 11,
      label: "notes",
      path: "notes",
      source: "workspace",
      entryKind: "file",
    },
  ];
  const { service, db } = setup(t, [], [row]);
  assert.deepEqual(await service.listStarred(), [row]);
  assert.deepEqual(await service.promptLibraryStatus(), { version: 1 });
  assert.deepEqual(
    service.importLegacyPrompts({ sourceId: "omnyo--prompt-library", prompts: [row] }),
    { imported: 0 },
  );
  assert.deepEqual(await service.unstar({ id: row.id }), { unstarred: true });
  assert.equal(createStarredPromptStore(db).list().length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM prompt_library_legacy_prompts").get().count,
    1,
  );
});

test("deduplicates legacy text and keeps old IDs working for mark-used and unstar", async (t) => {
  const { service } = setup(t);
  const current = await service.star({ prompt: draft("Review this") });
  service.importLegacyPrompts({
    sourceId: "omnyo--prompt-library",
    prompts: [legacy("old", "Review this")],
  });
  assert.equal((await service.listStarred()).length, 1);
  await service.markUsed({ id: "old" });
  assert.equal((await service.listStarred())[0].id, current.id);
  assert.ok((await service.listStarred())[0].lastUsedAt > 24);
  assert.deepEqual(await service.unstar({ id: "old" }), { unstarred: true });
  service.importLegacyPrompts({
    sourceId: "omnyo--prompt-library",
    prompts: [legacy("old", "Review this")],
  });
  assert.equal((await service.listStarred()).length, 0);
});

test("rejects a conflicting migration atomically without discarding either source", async (t) => {
  const { service } = setup(t);
  const current = await service.star({ prompt: draft("Existing text") });
  assert.throws(
    () =>
      service.importLegacyPrompts({
        sourceId: "omnyo--prompt-library",
        prompts: [legacy("first", "Would be imported"), legacy(current.id, "Different text")],
      }),
    /conflicts/,
  );
  assert.deepEqual(
    (await service.listStarred()).map((row) => row.prompt.text),
    ["Existing text"],
  );
});

test("searches saved and pack-imported prompts without changing workspace libraries or legacy results", async (t) => {
  const { service, library } = setup(t);
  const workspace = { projectId: "project", environmentId: null };

  const saved = library.apply({
    ...workspace,
    revision: 0,
    operation: {
      kind: "prompt.create",
      title: "Release",
      body: "Review release",
      skillId: "review",
    },
  });

  library.registerPack({ projectId: "other", environmentId: "env" }, "digest", (current) => ({
    library: { ...current, prompts: [{ id: "packed", title: "Imported", body: "Review package" }] },
    collectionId: "pack",
  }));
  assert.equal((await service.search({ ...globalSearch, query: "review" })).prompts.length, 2);
  assert.deepEqual(
    (
      await service.search({
        ...globalSearch,
        scope: "project",
        projectId: "project",
        environmentId: null,
      })
    ).prompts.map((row) => row.id),
    [saved.prompts[0].id],
  );
  assert.equal(
    (await service.searchLegacy({ ...globalSearch, query: "review" })).prompts.length,
    0,
  );
  assert.deepEqual(library.get(workspace), saved);
});

test("pages all user history and keeps cached history through later disappearance", async (t) => {
  const history = Array.from({ length: 1005 }, (_, index) => ({
    id: `history-${index}`,
    createdAt: 2000 - index,
    projectId: "project",
    threadId: "thread",
    scope: "thread",
    input: [{ type: "text", text: index === 1004 ? "old zebra" : `Prompt ${index}`, mentions: [] }],
  }));

  const { service, pages } = setup(t, history);
  assert.equal(
    (await service.search({ ...globalSearch, query: "zebra" })).prompts[0].id,
    "history-1004",
  );
  assert.deepEqual(
    pages.map((page) => page.limit),
    ["1000", "1000"],
  );
  history.splice(0);
  assert.equal(
    (await service.search({ ...globalSearch, query: "zebra" })).prompts[0].id,
    "history-1004",
  );
  assert.equal(pages.at(-1).limit, "100");
});

test("retains history attachments and shifts mentions across text chunks", async (t) => {
  const { service } = setup(t, [
    {
      id: "history",
      createdAt: 1,
      projectId: "project",
      threadId: "thread",
      scope: "thread",
      input: [
        { type: "text", text: "Read", mentions: [] },
        {
          type: "text",
          text: "@notes",
          mentions: [{ start: 0, end: 6, resource: { type: "path", path: "notes", kind: "file" } }],
        },
        { type: "localFile", path: "notes.md", name: "notes.md", sourceProjectId: "project" },
      ],
    },
  ]);

  const [row] = (await service.search(globalSearch)).prompts;
  assert.equal(row.prompt.text, "Read\n\n@notes");
  assert.equal(row.prompt.mentions[0].from, 6);
  assert.equal(row.prompt.attachments[0].path, "notes.md");
});

test("readiness waits for RPC migration and retries a failed read without duplicate stars", async (t) => {
  const { api, service } = setup(t);
  api.sdk.plugins.list = async () => ({
    plugins: [{ id: "omnyo--prompt-library", enabled: true, status: "running", version: "0.2.0" }],
  });
  let calls = 0;
  api.sdk.plugins.callRpc = async ({ method }) => {
    assert.equal(method, "exportStarred");
    calls += 1;

    if (calls === 1) throw new Error("Temporary read failure");

    return [legacy("old", "Retry me")];
  };

  await assert.rejects(service.promptLibraryStatus(), /Temporary/);
  assert.deepEqual(await service.promptLibraryStatus(), { version: 1 });
  assert.equal((await service.listStarred())[0].id, "old");
  assert.equal(calls, 2);
  assert.throws(() => legacyPromptImportSchema.parse({ sourceId: "other", prompts: [] }));
});

test("a late legacy plugin is imported after an earlier readiness check found none", async (t) => {
  const { api, service } = setup(t);
  assert.deepEqual(await service.promptLibraryStatus(), { version: 1 });
  api.sdk.plugins.list = async () => ({
    plugins: [{ id: "omnyo--prompt-library", enabled: true, status: "running", version: "0.2.0" }],
  });
  let exports = 0;
  api.sdk.plugins.callRpc = async () => {
    exports += 1;

    return [legacy("late", "Late favorite")];
  };

  assert.deepEqual(await service.promptLibraryStatus(), { version: 1 });
  assert.equal((await service.listStarred())[0].id, "late");
  assert.equal(exports, 1);
});

test("installed legacy remains unready until it can export or core proves a complete snapshot", async (t) => {
  const { api, service, db } = setup(t);
  api.sdk.plugins.list = async () => ({
    plugins: [
      { id: "omnyo--prompt-library", enabled: false, status: "disabled", version: "0.1.0" },
    ],
  });
  await assert.rejects(service.promptLibraryStatus(), /waiting for its saved prompts/);
  db.prepare("INSERT INTO prompt_library_legacy_sources VALUES (?, ?)").run(
    "omnyo--prompt-library",
    0,
  );
  assert.deepEqual(await service.promptLibraryStatus(), { version: 1 });
});
