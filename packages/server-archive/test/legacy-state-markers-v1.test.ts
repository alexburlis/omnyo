import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createConnection, migrate } from "@omnyo/db";
import {
  readServerImportFile,
  readServerImportJournalFile,
  readServerImportJournalStatus,
  readServerMovedFile,
  writeServerImportFile,
  writeServerMovedFile,
} from "../src/markers.js";
import {
  rollBackServerImport,
  SERVER_IMPORT_BACKUP_DIR_NAME,
} from "../src/import.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnyo-legacy-marker-v1-"));
  roots.push(root);

  return root;
}

const moved = {
  version: 1 as const,
  moveId: "move-fixture",
  movedAt: 17,
  fromHostId: "old-host",
  toHostId: "new-host",
  toHostName: "fixture",
  serverUrl: "http://127.0.0.1:38886",
  mode: "direct" as const,
  connectHandle: null,
  oldCopyEntries: ["bb.db", "attachments"],
};

const imported = {
  version: 1 as const,
  kind: "manual" as const,
  moveId: null,
  activationToken: null,
  sourceDataDir: "/legacy/.bb",
  sourceServerHostId: null,
  targetHostId: null,
  serverUrl: null,
  importedEntries: ["bb.db", "attachments"],
  createdAt: 17,
  fixupsAppliedAt: null,
};

function database(path: string, value: string) {
  const db = createConnection(path);

  try {
    migrate(db);
    db.$client.exec(
      "CREATE TABLE preserved_fixture(id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.$client
      .prepare("INSERT INTO preserved_fixture VALUES (?, ?)")
      .run("stable-id", value);
  } finally {
    db.$client.close();
  }
}

function preserved(path: string) {
  const db = createConnection(path);

  try {
    return db.$client.prepare("SELECT id, value FROM preserved_fixture").get();
  } finally {
    db.$client.close();
  }
}

test("reads exact version1 legacy marker paths without rewriting bytes while current writers refuse them", async () => {
  const root = await fixture();
  const movedBytes = JSON.stringify(moved);
  const importBytes = JSON.stringify(imported);
  await writeFile(join(root, "server-moved.json"), movedBytes);
  await writeFile(join(root, "server-import.json"), importBytes);
  expect(await readServerMovedFile(root)).toEqual(moved);
  expect(await readServerImportFile(root)).toEqual(imported);
  expect(await readFile(join(root, "server-moved.json"), "utf8")).toBe(
    movedBytes,
  );
  expect(await readFile(join(root, "server-import.json"), "utf8")).toBe(
    importBytes,
  );
  await expect(writeServerMovedFile(root, moved)).rejects.toThrow();
  await expect(writeServerImportFile(root, imported)).rejects.toThrow();
  expect(await readFile(join(root, "server-moved.json"), "utf8")).toBe(
    movedBytes,
  );
  await writeFile(
    join(root, "server-moved.json"),
    JSON.stringify({ ...moved, oldCopyEntries: ["bb.db", "app.db"] }),
  );
  await expect(readServerMovedFile(root)).rejects.toThrow(/conflicting/iu);
  await writeFile(
    join(root, "server-moved.json"),
    JSON.stringify({ ...moved, oldCopyEntries: ["../bb.db"] }),
  );
  await expect(readServerMovedFile(root)).rejects.toThrow();
});

test("existing rollback owner restores the literal old SQLite file and preserves current database work", async () => {
  const root = await fixture();
  const backup = join(root, SERVER_IMPORT_BACKUP_DIR_NAME);
  await mkdir(backup);
  database(join(backup, "bb.db"), "original legacy work");
  database(join(root, "bb.db"), "interrupted import");
  database(join(root, "app.db"), "independent current work");

  const journal = JSON.stringify({
    version: 1,
    entries: ["bb.db"],
    preexistingEntries: ["bb.db"],
  });

  await writeFile(join(root, "server-import-journal.json"), journal);
  expect((await readServerImportJournalFile(root))?.entries).toEqual(["bb.db"]);
  expect(await readFile(join(root, "server-import-journal.json"), "utf8")).toBe(
    journal,
  );
  await rollBackServerImport(root);
  expect(preserved(join(root, "bb.db"))).toEqual({
    id: "stable-id",
    value: "original legacy work",
  });
  expect(preserved(join(root, "app.db"))).toEqual({
    id: "stable-id",
    value: "independent current work",
  });
  expect(await rollBackServerImport(root)).toBeNull();
});

test("refuses mismatched old and current import ownership before rollback effects", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "server-import-journal.json"),
    JSON.stringify({ version: 1, entries: ["bb.db"], preexistingEntries: [] }),
  );
  await writeServerImportFile(root, {
    ...imported,
    importedEntries: ["app.db"],
  });
  await expect(readServerImportJournalStatus(root)).rejects.toThrow(
    /conflicting/iu,
  );
  await expect(rollBackServerImport(root)).rejects.toThrow(/conflicting/iu);
  expect(
    await readFile(join(root, "server-import-journal.json"), "utf8"),
  ).toContain("bb.db");
});
