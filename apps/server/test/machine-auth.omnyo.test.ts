import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultKeyHasher } from "@better-auth/api-key";
import { eq } from "drizzle-orm";
import {
  authApiKeys,
  authUsers,
  createConnection,
  migrate,
  type DbConnection,
} from "@omnyo/db";
import { openSecretVault } from "@omnyo/secret-storage";
import { afterEach, expect, it } from "vitest";
import { createMachineAuthService } from "../src/services/machine-auth.js";

const fixtures: { dataDir: string; db: DbConnection }[] = [];

const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function fixture() {
  const dataDir = await mkdtemp(join(await realpath(tmpdir()), "omnyo-auth-"));
  const db = createConnection(":memory:");
  migrate(db);
  const result = { dataDir, db, vault: await openSecretVault(dataDir) };
  fixtures.push(result);

  return result;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.db.$client.close();
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

function principal(id: string, email: string) {
  return {
    id,
    email,
    name: "Machine Auth System",
    emailVerified: true,
    image: null,
    createdAt: new Date(1),
    updatedAt: new Date(1),
  };
}

it("issues only canonical machine keys for fresh installations", async () => {
  const f = await fixture();
  const service = await createMachineAuthService({ ...f, logger });
  const host = await service.issueDaemonHostKey({ hostId: "stable-host" });

  const enroll = await service.issueHostEnrollKey({
    hostId: "stable-host",
    enrollSource: "loopback",
  });

  expect(host.startsWith("omnyodh_")).toBe(true);
  expect(enroll.key.startsWith("omnyode_")).toBe(true);
  expect(
    f.db
      .select({ id: authUsers.id, email: authUsers.email })
      .from(authUsers)
      .all(),
  ).toEqual([
    {
      id: "omnyo-machine-auth-system-user",
      email: "machine-auth@omnyo.internal",
    },
  ]);
});

it("preserves a legacy principal ID and timestamps while adopting its display identity", async () => {
  const f = await fixture();
  f.db
    .insert(authUsers)
    .values(
      principal("bb-machine-auth-system-user", "machine-auth@bb.internal"),
    )
    .run();
  const service = await createMachineAuthService({ ...f, logger });
  await service.ensureReady();
  await service.ensureReady();
  const rows = f.db.select().from(authUsers).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: "bb-machine-auth-system-user",
    email: "machine-auth@omnyo.internal",
    createdAt: new Date(1),
  });
});

it("verifies existing hashed legacy key bytes under the actual library and denies invalid states", async () => {
  const f = await fixture();
  f.db
    .insert(authUsers)
    .values(
      principal("bb-machine-auth-system-user", "machine-auth@bb.internal"),
    )
    .run();
  const service = await createMachineAuthService({ ...f, logger });
  await service.issueDaemonHostKey({ hostId: "stable-host" });
  const issued = f.db.select().from(authApiKeys).get();

  if (!issued) throw new Error("Expected actual library-issued key");
  const legacyFixtureKey = "bbdh_" + "synthetic-legacy-fixture-key".repeat(2);
  const hash = await defaultKeyHasher(legacyFixtureKey);
  f.db
    .insert(authApiKeys)
    .values({
      ...issued,
      id: "legacy-key-id",
      key: hash,
      prefix: "bbdh_",
      start: legacyFixtureKey.slice(0, 6),
    })
    .run();
  const restarted = await createMachineAuthService({ ...f, logger });
  expect(await restarted.verifyDaemonHostKey(legacyFixtureKey)).toMatchObject({
    keyId: "legacy-key-id",
    metadata: { hostId: "stable-host" },
  });
  expect(
    f.db
      .select({ key: authApiKeys.key, referenceId: authApiKeys.referenceId })
      .from(authApiKeys)
      .where(eq(authApiKeys.id, "legacy-key-id"))
      .get(),
  ).toEqual({ key: hash, referenceId: "bb-machine-auth-system-user" });
  expect(await restarted.verifyDaemonHostKey("invalid-fixture-key")).toBeNull();
  f.db
    .update(authApiKeys)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(authApiKeys.id, "legacy-key-id"))
    .run();
  const expired = await createMachineAuthService({ ...f, logger });
  expect(await expired.verifyDaemonHostKey(legacyFixtureKey)).toBeNull();
  await service.revokeHostAuthKeys({ hostId: "stable-host" });
  expect(await service.verifyDaemonHostKey(legacyFixtureKey)).toBeNull();
});

it("refuses colliding managed principals without merging their keys or identities", async () => {
  const f = await fixture();
  f.db
    .insert(authUsers)
    .values([
      principal("bb-machine-auth-system-user", "machine-auth@bb.internal"),
      principal(
        "omnyo-machine-auth-system-user",
        "machine-auth@omnyo.internal",
      ),
    ])
    .run();
  const service = await createMachineAuthService({ ...f, logger });
  await expect(service.ensureReady()).rejects.toThrow(/collision/);
  expect(f.db.select({ id: authUsers.id }).from(authUsers).all()).toHaveLength(
    2,
  );
  expect(f.db.select().from(authApiKeys).all()).toHaveLength(0);
});
