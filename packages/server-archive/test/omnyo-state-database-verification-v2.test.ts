import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createConnection } from "@omnyo/db";
import { readConfiguredOmnyoStateAdmission } from "@omnyo/config/omnyo-state-startup";
import { readOmnyoStateAdmission } from "@omnyo/config/omnyo-state-admission";
import {
  writeJsonFileAtomically,
  writeTextFileAtomically,
} from "../src/json-file.js";
import {
  readMaintenanceHold,
  writeMaintenanceHold,
} from "../src/maintenance-hold.js";
import {
  inspectOmnyoStateRootForAdoptionV2,
  OmnyoStateWorkPendingError,
  stageOmnyoStateRoot,
  verifyOmnyoSourceDatabaseCapacityV2,
  verifyOmnyoStateRootDatabaseV2,
  type OmnyoStateRootInput,
} from "../src/omnyo-state-root.js";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "./omnyo-root-fixture.js";

const roots: string[] = [];

const macTest = test.skipIf(process.platform !== "darwin");

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function continuePending<T>(operation: () => Promise<T>): Promise<T> {
  for (let calls = 0; calls < 64; calls++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;
    }
  }

  throw new Error(
    "Database verification fixture exceeded its continuation bound",
  );
}

async function fixture() {
  const f = await createOmnyoRootFixture(undefined, "/private/tmp");
  roots.push(f.root);
  await writeFile(
    join(f.root, "database-verification-owner.json"),
    JSON.stringify({ module: import.meta.url, root: f.root }),
    { flag: "wx", mode: 0o600 },
  );
  await mkdir(f.input.jobDir, { mode: 0o700 });
  f.input.digestAlgorithm = "state-tree-v2";
  f.input.databaseVerification = "release-producer-v1";

  return f;
}

function capacityInput(input: OmnyoStateRootInput) {
  return {
    migrationId: input.migrationId,
    ownerId: input.ownerId,
    serverHostId: input.serverHostId,
    sourceDataDir: input.sourceDataDir,
    destinationDataDir: input.destinationDataDir,
    jobDir: input.jobDir,
    artifactDigest: input.artifactDigest,
    digestAlgorithm: input.digestAlgorithm,
    databaseVerification: input.databaseVerification,
  };
}

async function bindSource(f: Awaited<ReturnType<typeof fixture>>) {
  f.input.expectedSourceDigest = (
    await continuePending(() =>
      inspectOmnyoStateRootForAdoptionV2(f.input, f.input.sourceDataDir, {
        role: "source-digest",
      }),
    )
  ).digest;
}

async function databasePending(
  input: OmnyoStateRootInput,
  owners: Parameters<typeof stageOmnyoStateRoot>[1],
) {
  for (let calls = 0; calls < 64; calls++) {
    try {
      await stageOmnyoStateRoot(input, owners);
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;

      if (error.progress.phase === "database-verification") return;
      continue;
    }

    throw new Error(
      "Release-mode fixture published before its database verification producer",
    );
  }

  throw new Error("Fixture did not reach its database verification boundary");
}

function readonlyOwner(counter: { opens: number }) {
  return {
    openReadonlyDatabase(path: string) {
      counter.opens++;
      const db = createConnection(path, { readonly: true }).$client;
      expect(db.readonly).toBe(true);

      return db;
    },
  };
}

async function databaseBytes(path: string) {
  const bytes = await readFile(path);
  let wal: Buffer | null = null;
  let shmBytes: number | null = null;

  try {
    const value = await readFile(`${path}-wal`);

    if (value.length > 32) wal = value;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }

  try {
    shmBytes = (await lstat(`${path}-shm`)).size;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }

  return {
    mainSha256: createHash("sha256").update(bytes).digest("hex"),
    walSha256:
      wal === null ? null : createHash("sha256").update(wal).digest("hex"),
    shmBytes,
  };
}

function databaseRows(path: string) {
  const db = createConnection(path, { readonly: true }).$client;

  try {
    return {
      hashes: z
        .array(z.object({ hash: z.string() }))
        .parse(
          db.prepare("SELECT hash FROM __drizzle_migrations ORDER BY id").all(),
        ),
      rows: z
        .array(
          z.object({
            plugin_id: z.string(),
            key: z.string(),
            value: z.string(),
            updated_at: z.number(),
          }),
        )
        .parse(
          db
            .prepare(
              "SELECT plugin_id, key, value, updated_at FROM plugin_kv ORDER BY plugin_id, key",
            )
            .all(),
        ),
    };
  } finally {
    db.close();
  }
}

async function unpublished(input: OmnyoStateRootInput) {
  for (const path of [
    input.destinationDataDir,
    join(input.jobDir, "write-admission.json"),
  ])
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

macTest(
  "runs capacity-only before hashing then verifies a converted release database once and publishes with its first-write latch closed",
  async () => {
    const f = await fixture();
    const hold = readMaintenanceHold(f.input.sourceDataDir);

    if (hold === null) throw new Error("Missing original fixture hold");
    await writeMaintenanceHold(f.input.sourceDataDir, {
      ...hold,
      kind: "desktop-update",
    });
    const opaque = join(f.input.sourceDataDir, "capacity-must-not-hash");
    await writeFile(opaque, "unexamined ordinary work", { mode: 0o000 });
    const sourceDb = join(f.input.sourceDataDir, "bb.db");
    const originalBytes = await databaseBytes(sourceDb);
    const capacityCounter = { opens: 0 };
    const capacityOwner = readonlyOwner(capacityCounter);

    const capacity = await verifyOmnyoSourceDatabaseCapacityV2(
      capacityInput(f.input),
      {
        openReadonlyDatabase(path) {
          expect(existsSync(join(f.input.jobDir, "root-adoption.json"))).toBe(
            false,
          );
          expect(
            existsSync(join(f.input.jobDir, "root-source-digest-v2.json")),
          ).toBe(false);
          expect(path).toBe(sourceDb);

          return capacityOwner.openReadonlyDatabase(path);
        },
      },
    );

    expect(capacity).toMatchObject({
      version: 2,
      verified: true,
      capacityOnly: true,
      migrationId: f.input.migrationId,
      artifactDigest: f.input.artifactDigest,
    });
    expect(capacity.databaseBytes).toBe((await lstat(sourceDb)).size);
    expect(capacity.proofSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(capacity.durationMs).toBeGreaterThanOrEqual(0);
    expect(capacityCounter.opens).toBe(1);
    expect(
      (
        await verifyOmnyoSourceDatabaseCapacityV2(
          capacityInput(f.input),
          capacityOwner,
        )
      ).proofSha256,
    ).toBe(capacity.proofSha256);
    expect(capacityCounter.opens).toBe(1);
    const afterCapacity = await databaseBytes(sourceDb);
    expect(afterCapacity.mainSha256).toBe(originalBytes.mainSha256);

    if (originalBytes.walSha256 !== null)
      expect(afterCapacity.walSha256).toBe(originalBytes.walSha256);
    await unpublished(f.input);
    await expect(
      lstat(join(f.input.jobDir, "root-adoption.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(opaque, 0o600);
    await writeMaintenanceHold(f.input.sourceDataDir, hold);
    const originalRows = databaseRows(sourceDb);
    await bindSource(f);
    let conversions = 0;
    let inlineOpens = 0;

    const owners = {
      ...omnyoRootFixtureOwners,
      openDatabase(path: string) {
        inlineOpens++;

        return omnyoRootFixtureOwners.openDatabase(path);
      },
      async prepareDestination(
        stage: Parameters<typeof omnyoRootFixtureOwners.prepareDestination>[0],
      ) {
        conversions++;
        await omnyoRootFixtureOwners.prepareDestination(stage);
      },
    };

    await databasePending(f.input, owners);
    expect(conversions).toBe(1);
    expect(inlineOpens).toBe(0);
    await unpublished(f.input);
    await expect(
      lstat(join(f.input.jobDir, "database-verification-v2.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const stagedDb = join(f.input.jobDir, "root-staging", "app.db");
    expect(databaseRows(stagedDb)).toEqual(originalRows);
    const stagedBefore = await databaseBytes(stagedDb);
    const counter = { opens: 0 };
    const owner = readonlyOwner(counter);
    const verified = await verifyOmnyoStateRootDatabaseV2(f.input, owner);
    expect(verified).toMatchObject({
      version: 2,
      verified: true,
      capacityOnly: false,
      migrationId: f.input.migrationId,
      artifactDigest: f.input.artifactDigest,
    });
    expect(
      (await verifyOmnyoStateRootDatabaseV2(f.input, owner)).proofSha256,
    ).toBe(verified.proofSha256);
    expect(counter.opens).toBe(1);
    const stagedAfter = await databaseBytes(stagedDb);
    expect(stagedAfter.mainSha256).toBe(stagedBefore.mainSha256);

    if (stagedBefore.walSha256 !== null)
      expect(stagedAfter.walSha256).toBe(stagedBefore.walSha256);
    await continuePending(() => stageOmnyoStateRoot(f.input, owners));
    expect(conversions).toBe(1);
    expect(inlineOpens).toBe(0);

    const admission = readConfiguredOmnyoStateAdmission(
      f.input.destinationDataDir,
    );

    if (admission === undefined)
      throw new Error("Missing published fixture admission");
    expect(readOmnyoStateAdmission(admission).admission).toBe(0);
    expect(databaseRows(join(f.input.destinationDataDir, "app.db"))).toEqual(
      originalRows,
    );
    expect(databaseRows(sourceDb)).toEqual(originalRows);
    const sourceAfter = await databaseBytes(sourceDb);
    expect(sourceAfter.mainSha256).toBe(originalBytes.mainSha256);

    if (originalBytes.walSha256 !== null)
      expect(sourceAfter.walSha256).toBe(originalBytes.walSha256);
    expect(await readFile(opaque, "utf8")).toBe("unexamined ordinary work");
  },
);

macTest(
  "rejects a real converted foreign-key violation without issuing a verification receipt or admission",
  async () => {
    const f = await fixture();
    await bindSource(f);

    const owners = {
      ...omnyoRootFixtureOwners,
      async prepareDestination(
        stage: Parameters<typeof omnyoRootFixtureOwners.prepareDestination>[0],
      ) {
        await omnyoRootFixtureOwners.prepareDestination(stage);
        const db = createConnection(stage.databasePath).$client;

        try {
          db.pragma("foreign_keys = OFF");
          db.prepare(
            "INSERT INTO thread_plugin_metadata (thread_id, plugin_id, metadata_json) VALUES (?, ?, ?)",
          ).run(
            "missing-thread-fixture",
            "tasks",
            JSON.stringify({ retained: true }),
          );
          db.pragma("foreign_keys = ON");
        } finally {
          db.close();
        }
      },
    };

    await databasePending(f.input, owners);
    const stagedDb = join(f.input.jobDir, "root-staging", "app.db");
    const probe = createConnection(stagedDb, { readonly: true }).$client;

    try {
      expect(probe.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(probe.prepare("PRAGMA foreign_key_check").get()).toMatchObject({
        table: "thread_plugin_metadata",
        parent: "threads",
      });
    } finally {
      probe.close();
    }

    const counter = { opens: 0 };
    await expect(
      verifyOmnyoStateRootDatabaseV2(f.input, readonlyOwner(counter)),
    ).rejects.toThrow(/foreign|integrity/);
    expect(counter.opens).toBe(1);
    await expect(
      lstat(join(f.input.jobDir, "database-verification-v2.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await unpublished(f.input);
  },
);

macTest(
  "refuses a changed verified binding or database file without reopening SQL or opening the first-write latch",
  async () => {
    const f = await fixture();
    await bindSource(f);
    let conversions = 0;

    const owners = {
      ...omnyoRootFixtureOwners,
      async prepareDestination(
        stage: Parameters<typeof omnyoRootFixtureOwners.prepareDestination>[0],
      ) {
        conversions++;
        await omnyoRootFixtureOwners.prepareDestination(stage);
      },
    };

    await databasePending(f.input, owners);
    const counter = { opens: 0 };
    const owner = readonlyOwner(counter);
    await expect(
      verifyOmnyoStateRootDatabaseV2(
        { ...f.input, ownerId: "different-fixture-owner" },
        owner,
      ),
    ).rejects.toThrow(/owner|binding|differ/);
    expect(counter.opens).toBe(0);
    await mkdir(f.input.destinationDataDir, { mode: 0o700 });

    const collision = join(
      f.input.destinationDataDir,
      "owned-collision-fixture",
    );

    await writeFile(collision, "preserve collision bytes");
    await expect(
      verifyOmnyoStateRootDatabaseV2(f.input, owner),
    ).rejects.toThrow(/publish|collision|destination/);
    expect(counter.opens).toBe(0);
    expect(await readFile(collision, "utf8")).toBe("preserve collision bytes");
    await unlink(collision);
    await rmdir(f.input.destinationDataDir);

    const writeConnections: Array<
      ReturnType<typeof createConnection>["$client"]
    > = [];

    try {
      await expect(
        verifyOmnyoStateRootDatabaseV2(f.input, {
          openReadonlyDatabase(path) {
            const db = createConnection(path).$client;
            writeConnections.push(db);

            return db;
          },
        }),
      ).rejects.toThrow(/readonly|read.only/);
      expect(writeConnections).toHaveLength(1);
      expect(writeConnections[0]?.open).toBe(false);
    } finally {
      for (const db of writeConnections) if (db.open) db.close();
    }

    const verified = await verifyOmnyoStateRootDatabaseV2(f.input, owner);
    const receiptPath = join(f.input.jobDir, "database-verification-v2.json");
    const originalReceipt = await readFile(receiptPath, "utf8");

    const record = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(originalReceipt));

    const receiptBinding = z
      .record(z.string(), z.unknown())
      .parse(record.binding);

    expect(receiptBinding.ownerId).toBe(f.input.ownerId);
    await writeJsonFileAtomically(receiptPath, {
      ...record,
      binding: { ...receiptBinding, ownerId: "different-fixture-owner" },
    });
    await expect(
      verifyOmnyoStateRootDatabaseV2(f.input, owner),
    ).rejects.toThrow(/binding|owner|receipt|proof/);
    expect(counter.opens).toBe(1);
    await unpublished(f.input);
    await writeTextFileAtomically(receiptPath, originalReceipt, false, 0o600);
    expect(
      (await verifyOmnyoStateRootDatabaseV2(f.input, owner)).proofSha256,
    ).toBe(verified.proofSha256);
    expect(counter.opens).toBe(1);
    const stagedDb = join(f.input.jobDir, "root-staging", "app.db");
    const db = createConnection(stagedDb).$client;

    try {
      expect(
        db
          .prepare(
            "UPDATE plugin_kv SET value = ? WHERE plugin_id = ? AND key = ?",
          )
          .run(
            JSON.stringify({ changed: "after verification" }),
            "tasks",
            "migration-fixture",
          ).changes,
      ).toBe(1);
    } finally {
      db.close();
    }

    await expect(
      verifyOmnyoStateRootDatabaseV2(f.input, owner),
    ).rejects.toThrow(/changed|differ|proof|receipt/);
    expect(counter.opens).toBe(1);
    await expect(stageOmnyoStateRoot(f.input, owners)).rejects.toThrow(
      /changed|differ|proof|receipt/,
    );
    expect(conversions).toBe(1);
    await unpublished(f.input);
  },
);
