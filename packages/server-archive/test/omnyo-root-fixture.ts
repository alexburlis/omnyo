import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, migrate, type DbConnection } from "@omnyo/db";
import {
  inspectOmnyoStateRoot,
  type OmnyoStateRootInput,
  type OmnyoStagedStateRoot,
} from "../src/omnyo-state-root.js";
import { writeMaintenanceHold } from "../src/maintenance-hold.js";

export async function createOmnyoRootFixture(
  seed?: (db: DbConnection) => void,
  temporaryParent = tmpdir(),
) {
  const root = await mkdtemp(
    join(await realpath(temporaryParent), "omnyo-root-"),
  );

  const sourceDataDir = join(root, "legacy");
  await mkdir(join(sourceDataDir, "plugins", "tasks", "host-data"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(sourceDataDir, "host-id"), "stable-host");

  const originalConfig = JSON.stringify({
    serverUrl: "http://127.0.0.1:38886",
  });

  await writeFile(join(sourceDataDir, "config.json"), originalConfig, {
    mode: 0o600,
  });
  await writeFile(join(sourceDataDir, "user-file.txt"), "unchanged user work", {
    mode: 0o640,
  });
  await writeFile(
    join(sourceDataDir, "plugins", "tasks", "host-data", "opaque-state"),
    "preserved plugin host state",
    { mode: 0o600 },
  );
  await writeMaintenanceHold(sourceDataDir, {
    version: 1,
    id: "migration-fixture",
    ownerId: "fixture-owner",
    kind: "migration",
    phase: "held",
    serverHostId: "stable-host",
    createdAt: 17,
    artifact: { archiveSha256: "a".repeat(64), runtimeSha256: "b".repeat(64) },
  });
  const db = createConnection(join(sourceDataDir, "bb.db"));

  try {
    migrate(db);
    db.$client
      .prepare(
        "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "tasks",
        "migration-fixture",
        JSON.stringify({ draft: "unchanged draft", id: "stable-id" }),
        17,
      );
    seed?.(db);
  } finally {
    db.$client.close();
  }

  const source = await inspectOmnyoStateRoot(sourceDataDir);

  const input: OmnyoStateRootInput = {
    migrationId: "migration-fixture",
    ownerId: "fixture-owner",
    serverHostId: "stable-host",
    sourceDataDir,
    destinationDataDir: join(root, "canonical"),
    jobDir: join(root, "protected-job"),
    artifactDigest: "b".repeat(64),
    expectedSourceDigest: source.digest,
  };

  return { root, input, originalConfig };
}

export const omnyoRootFixtureOwners = {
  async prepareDestination(stage: OmnyoStagedStateRoot) {
    const db = createConnection(stage.databasePath);

    try {
      migrate(db);
    } finally {
      db.$client.close();
    }
  },
  openDatabase(path: string) {
    return createConnection(path).$client;
  },
};
