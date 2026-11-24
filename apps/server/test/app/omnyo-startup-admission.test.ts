import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  prepareOmnyoStateAdmission,
  selectOmnyoPreWriteRollback,
} from "@omnyo/config/omnyo-state-admission";
import { admitConfiguredOmnyoStateWrites } from "@omnyo/config/omnyo-state-startup";
import { initDb } from "../../src/db.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "omnyo-startup-"));
  roots.push(root);

  const admission = {
    journalPath: join(root, "admission.json"),
    binding: {
      migrationId: "fixture-v1",
      sourceDataDir: join(root, "old"),
      destinationDataDir: join(root, "new"),
      sourceDigest: "a".repeat(64),
      destinationDigest: "b".repeat(64),
      artifactDigest: "c".repeat(64),
    },
  };

  await mkdir(admission.binding.destinationDataDir);
  await writeFile(
    join(admission.binding.destinationDataDir, "config.json"),
    JSON.stringify({ stateMigration: admission }),
  );
  await prepareOmnyoStateAdmission(admission);

  return {
    admission,
    dataDir: admission.binding.destinationDataDir,
    databasePath: join(admission.binding.destinationDataDir, "app.db"),
  };
}

test("database refuses unopened migration admission before creating database or WAL", async () => {
  const f = await fixture();
  let opened: ReturnType<typeof initDb> | undefined;

  try {
    expect(() => {
      opened = initDb(f.databasePath, { dataDir: f.dataDir });
    }).toThrow(/admission/);
  } finally {
    opened?.$client.close();
  }

  expect(existsSync(f.databasePath)).toBe(false);
  expect(existsSync(`${f.databasePath}-wal`)).toBe(false);
  await selectOmnyoPreWriteRollback(f.admission);
});

test("configured startup durably closes rollback before the database's first write", async () => {
  const f = await fixture();
  await admitConfiguredOmnyoStateWrites(f.dataDir);
  const db = initDb(f.databasePath, { dataDir: f.dataDir });

  try {
    db.$client.exec("CREATE TABLE preserved_work (id TEXT PRIMARY KEY)");
    db.$client
      .prepare("INSERT INTO preserved_work VALUES (?)")
      .run("stable-id");
  } finally {
    db.$client.close();
  }

  await expect(selectOmnyoPreWriteRollback(f.admission)).rejects.toThrow(
    /forward repair/,
  );
  expect(
    JSON.parse(await readFile(f.admission.journalPath, "utf8")).admission,
  ).toBe(1);
  const reopened = initDb(f.databasePath, { dataDir: f.dataDir });

  try {
    expect(
      reopened.$client.prepare("SELECT * FROM preserved_work").all(),
    ).toEqual([{ id: "stable-id" }]);
  } finally {
    reopened.$client.close();
  }
});

test.each(["missing-journal", "rollback-selected", "different-profile"])(
  "refuses %s at the actual database boundary without replacing state",
  async (mode) => {
    const f = await fixture();

    if (mode === "missing-journal") await rm(f.admission.journalPath);

    if (mode === "rollback-selected")
      await selectOmnyoPreWriteRollback(f.admission);

    if (mode === "different-profile") {
      await admitConfiguredOmnyoStateWrites(f.dataDir);
      await writeFile(
        join(f.dataDir, "config.json"),
        JSON.stringify({
          stateMigration: {
            ...f.admission,
            binding: {
              ...f.admission.binding,
              destinationDataDir: `${f.dataDir}-foreign`,
            },
          },
        }),
      );
    }

    expect(() => initDb(f.databasePath, { dataDir: f.dataDir })).toThrow();
    expect(existsSync(f.databasePath)).toBe(false);
    expect(existsSync(`${f.databasePath}-wal`)).toBe(false);
  },
);
