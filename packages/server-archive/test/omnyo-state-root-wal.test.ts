import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createConnection } from "@omnyo/db";
import {
  inspectOmnyoStateRoot,
  stageOmnyoStateRoot,
} from "../src/omnyo-state-root.js";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "./omnyo-root-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("adopts a dead SQLite owner's committed WAL and SHM without changing the source bytes", async () => {
  const fixture = await createOmnyoRootFixture();
  roots.push(fixture.root);
  const sourceDatabase = join(fixture.input.sourceDataDir, "bb.db");

  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { createConnection } from "@omnyo/db";
    const db = createConnection(process.argv[1]);
    db.$client.pragma("wal_autocheckpoint = 0");
    db.$client.prepare("INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run("tasks", "committed-wal", "preserved pending draft", 18);
    process.kill(process.pid, "SIGKILL");
  `,
      sourceDatabase,
    ],
    {
      cwd: new URL("..", import.meta.url),
      stdio: "ignore",
      timeout: 5_000,
    },
  );

  const [, signal] = await once(child, "exit");
  expect(signal).toBe("SIGKILL");
  const wal = await readFile(`${sourceDatabase}-wal`);
  const shm = await readFile(`${sourceDatabase}-shm`);
  expect(wal.byteLength).toBeGreaterThan(0);
  expect(shm.byteLength).toBeGreaterThan(0);
  const source = await inspectOmnyoStateRoot(fixture.input.sourceDataDir);
  const input = { ...fixture.input, expectedSourceDigest: source.digest };
  await stageOmnyoStateRoot(input, {
    ...omnyoRootFixtureOwners,
    async prepareDestination(stage) {
      expect(existsSync(`${stage.databasePath}-wal`)).toBe(true);
      expect(existsSync(`${stage.databasePath}-shm`)).toBe(true);
      await omnyoRootFixtureOwners.prepareDestination(stage);
    },
  });

  const destination = createConnection(
    join(input.destinationDataDir, "app.db"),
  );

  try {
    expect(
      destination.$client
        .prepare(
          "SELECT value FROM plugin_kv WHERE plugin_id = 'tasks' AND key = 'committed-wal'",
        )
        .get(),
    ).toEqual({ value: "preserved pending draft" });
    expect(
      destination.$client.pragma("integrity_check", { simple: true }),
    ).toBe("ok");
  } finally {
    destination.$client.close();
  }

  expect(await readFile(`${sourceDatabase}-wal`)).toEqual(wal);
  expect(await readFile(`${sourceDatabase}-shm`)).toEqual(shm);
  expect((await inspectOmnyoStateRoot(input.sourceDataDir)).digest).toBe(
    source.digest,
  );
});
