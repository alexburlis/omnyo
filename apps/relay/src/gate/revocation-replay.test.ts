import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { account, machine, server, session, user } from "@omnyo/connect-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Deps,
  createConnectCode,
  disconnectServer,
  redeemConnectCode,
} from "../account/api.js";
import { type RelayDatabase, openRelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { FakeTunnels } from "./gate-test-harness.js";
import {
  isGitHubAccountBlocked,
  isUserBlocked,
  suspendUser,
} from "../user-blocks.js";
import {
  JOURNAL_RETENTION_MS,
  MAX_JOURNAL_LINE_BYTES,
  type RevocationJournal,
  RevocationJournalError,
  createRetirementRecorder,
  createRevocationJournal,
  replayRevocationJournal,
  revokeMachine,
  revokeServerByCredential,
} from "./revocation.js";
import { randomToken, sha256HexOf } from "./signed-token.js";

const NOW = Date.UTC(2026, 10, 9, 12, 0);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let root: string;

let databasePath: string;

let database: RelayDatabase;

let journal: RevocationJournal;

function open(): RelayDatabase {
  return openRelayDatabase(
    databasePath,
    sourceMigrationDirectories(),
    () => NOW,
  );
}

function seedOwner(userId: string): void {
  const at = new Date(NOW);

  database.db
    .insert(user)
    .values({
      id: userId,
      name: "owner",
      email: `${userId}@example.test`,
      emailVerified: true,
      image: null,
      githubLogin: "owner",
      createdAt: at,
      updatedAt: at,
    })
    .run();
}

function seedServer(userId: string, serverId: string, credential: string) {
  database.db
    .insert(server)
    .values({
      id: serverId,
      userId,
      name: "home",
      subdomain: "home",
      credentialHash: sha256HexOf(credential),
      version: null,
      lastSeenAt: null,
      createdAt: new Date(NOW),
      revokedAt: null,
    })
    .run();
}

function addSession(userId: string): string {
  const id = randomUUID();

  database.db
    .insert(session)
    .values({
      id,
      token: randomToken(),
      expiresAt: new Date(NOW + WEEK_MS),
      ipAddress: null,
      userAgent: null,
      userId,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })
    .run();

  return id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-replay-"));
  databasePath = join(root, "relay.sqlite");
  database = open();
  journal = createRevocationJournal(join(root, "revocations.jsonl"));
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("revocation journal replay", () => {
  it("re-applies revocations lost to a restore and clears sessions once", () => {
    const userId = randomUUID();
    const serverId = randomUUID();
    const machineId = randomUUID();
    const credential = randomToken();
    const at = new Date(NOW);

    seedOwner(userId);
    seedServer(userId, serverId, credential);
    database.db
      .insert(machine)
      .values({
        id: machineId,
        userId,
        name: "phone",
        subdomain: null,
        credentialHash: sha256HexOf(randomToken()),
        lastSeenAt: null,
        createdAt: at,
        revokedAt: null,
      })
      .run();
    addSession(userId);

    const backupPath = join(root, "backup.sqlite");
    database.sqlite.prepare("VACUUM INTO ?").run(backupPath);

    const deps = {
      db: database.db,
      tunnels: new FakeTunnels(),
      journal,
      now: () => NOW,
    };

    expect(revokeMachine(deps, { userId, machineId })).toBe(true);
    expect(revokeServerByCredential(deps, credential)?.serverId).toBe(serverId);

    database.close();
    copyFileSync(backupPath, databasePath);
    database = open();

    expect(replayRevocationJournal(database.db, journal)).toEqual({
      entries: 2,
      applied: 2,
      sessionsCleared: 1,
    });

    const restoredServer = database.db
      .select()
      .from(server)
      .where(eq(server.id, serverId))
      .get();

    const restoredMachine = database.db
      .select()
      .from(machine)
      .where(eq(machine.id, machineId))
      .get();

    expect(restoredServer?.revokedAt?.getTime()).toBe(NOW);
    expect(restoredServer?.credentialHash).toBeNull();
    expect(restoredMachine?.revokedAt?.getTime()).toBe(NOW);
    expect(database.db.select().from(session).all()).toHaveLength(0);

    const keptSession = addSession(userId);

    expect(replayRevocationJournal(database.db, journal)).toEqual({
      entries: 2,
      applied: 0,
      sessionsCleared: 0,
    });
    expect(
      database.db
        .select({ id: session.id })
        .from(session)
        .all()
        .map((row) => row.id),
    ).toEqual([keptSession]);
  });

  it("leaves a server re-paired after its revocations untouched", async () => {
    const userId = randomUUID();
    const serverId = randomUUID();
    const credential = randomToken();

    seedOwner(userId);
    seedServer(userId, serverId, credential);
    addSession(userId);

    const gateDeps = {
      db: database.db,
      tunnels: new FakeTunnels(),
      journal,
      now: () => NOW,
    };

    const accountDeps: Deps = {
      db: database.db,
      appUrl: "https://relay.example",
      serverUrlTemplate: "https://{label}.relay.example",
      closeTunnel: async () => {},
      recordRevocation: (revocation) =>
        journal.append({ ...revocation, at: NOW }),
      tunnelConnected: null,
    };

    async function repair(): Promise<string> {
      const issued = await createConnectCode(accountDeps, userId, {
        serverId,
      });

      if ("error" in issued) throw new Error(issued.error);
      const redeemed = await redeemConnectCode(accountDeps, issued.code);

      if ("error" in redeemed) throw new Error(redeemed.error);

      return redeemed.credential;
    }

    expect(revokeServerByCredential(gateDeps, credential)?.serverId).toBe(
      serverId,
    );

    const repaired = await repair();

    expect(await disconnectServer(accountDeps, userId, serverId)).toEqual({
      ok: true,
    });

    const current = await repair();

    expect(journal.entries()).toEqual([
      expect.objectContaining({
        kind: "server",
        credentialHash: sha256HexOf(credential),
      }),
      expect.objectContaining({
        kind: "server",
        credentialHash: sha256HexOf(repaired),
      }),
    ]);
    expect(replayRevocationJournal(database.db, journal)).toEqual({
      entries: 2,
      applied: 0,
      sessionsCleared: 0,
    });

    const row = database.db
      .select()
      .from(server)
      .where(eq(server.id, serverId))
      .get();

    expect(row?.credentialHash).toBe(sha256HexOf(current));
    expect(row?.revokedAt).toBeNull();
    expect(database.db.select().from(session).all()).toHaveLength(1);
  });
});

describe("account entries in the revocation journal", () => {
  function linkGitHub(userId: string, githubId: string): void {
    database.db
      .insert(account)
      .values({
        id: `account-${userId}`,
        accountId: githubId,
        providerId: "github",
        userId,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      })
      .run();
  }

  it("re-applies blocks, unblocks and deletions in order, and changes nothing on a normal restart", () => {
    seedOwner("u1");
    linkGitHub("u1", "4242");
    addSession("u1");
    journal.append({
      kind: "user-block",
      githubId: "4242",
      userId: "u1",
      reason: "spam",
      at: NOW,
    });
    journal.append({
      kind: "user-block",
      githubId: "5151",
      userId: null,
      reason: null,
      at: NOW,
    });
    journal.append({
      kind: "user-unblock",
      githubId: "5151",
      userId: null,
      at: NOW + 1,
    });

    expect(replayRevocationJournal(database.db, journal)).toEqual({
      entries: 3,
      applied: 1,
      sessionsCleared: 1,
    });
    expect(isUserBlocked(database.db, "u1")).toBe(true);
    expect(isGitHubAccountBlocked(database.db, "5151")).toBe(false);
    expect(replayRevocationJournal(database.db, journal)).toEqual({
      entries: 3,
      applied: 0,
      sessionsCleared: 0,
    });

    journal.append({
      kind: "user-delete",
      githubId: "4242",
      userId: "u1",
      at: NOW + 2,
    });

    expect(replayRevocationJournal(database.db, journal)).toMatchObject({
      applied: 1,
    });
    expect(database.db.select().from(user).all()).toEqual([]);
    expect(isGitHubAccountBlocked(database.db, "4242")).toBe(true);
  });

  it("lifts a block that a restored backup still holds once the journal says it was lifted", () => {
    seedOwner("u1");
    linkGitHub("u1", "4242");
    suspendUser(database.db, { userId: "u1", reason: null, now: NOW });
    journal.append({
      kind: "user-block",
      githubId: "4242",
      userId: "u1",
      reason: null,
      at: NOW,
    });
    journal.append({
      kind: "user-unblock",
      githubId: "4242",
      userId: "u1",
      at: NOW + 1,
    });

    replayRevocationJournal(database.db, journal);

    expect(isUserBlocked(database.db, "u1")).toBe(false);
  });
});

describe("address retirements in the revocation journal", () => {
  function snapshot(): string {
    const copy = join(root, "before-release.sqlite");
    database.sqlite.exec(`VACUUM INTO '${copy}'`);

    return copy;
  }

  function restore(copy: string): void {
    database.close();
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    copyFileSync(copy, databasePath);
    database = open();
  }

  function addServer(userId: string, serverId: string, label: string): void {
    database.db
      .insert(server)
      .values({
        id: serverId,
        userId,
        name: label,
        subdomain: label,
        credentialHash: null,
        version: null,
        lastSeenAt: null,
        createdAt: new Date(NOW),
        revokedAt: null,
      })
      .run();
  }

  it("keeps an address retired when a restored backup predates both its claim and its release", () => {
    seedOwner("u1");
    seedOwner("u2");
    const backup = snapshot();
    const record = createRetirementRecorder(database.db, journal);

    addServer("u1", "s-work", "owner-work");
    database.db.delete(server).where(eq(server.id, "s-work")).run();

    expect(record()).toBe(1);
    expect(record()).toBe(0);

    restore(backup);
    expect(replayRevocationJournal(database.db, journal).applied).toBe(1);
    expect(() => addServer("u2", "s-taken", "owner-work")).toThrow(
      /relay label retired/u,
    );
    expect(createRetirementRecorder(database.db, journal)()).toBe(0);
  });

  it("journals a later release of an address that was journaled before", () => {
    seedOwner("u1");
    const record = createRetirementRecorder(database.db, journal);

    addServer("u1", "s-first", "owner-again");
    database.db.delete(server).where(eq(server.id, "s-first")).run();
    expect(record()).toBe(1);

    database.sqlite
      .prepare(
        "UPDATE relay_retired_label SET retired_at = retired_at - 1000 WHERE label = 'owner-again'",
      )
      .run();
    addServer("u1", "s-second", "owner-again");
    database.db.delete(server).where(eq(server.id, "s-second")).run();

    expect(createRetirementRecorder(database.db, journal)()).toBe(1);
    expect(
      journal.entries().filter((entry) => entry.kind === "label-retire"),
    ).toHaveLength(2);
  });
});

describe("revocation journal compaction", () => {
  it("drops entries older than the retention window and keeps newer ones in order", () => {
    const at = (age: number) => NOW - age;

    journal.append({
      kind: "machine",
      id: "old",
      userId: "u1",
      at: at(JOURNAL_RETENTION_MS + 1),
    });
    journal.append({ kind: "machine", id: "new", userId: "u1", at: at(1_000) });
    journal.append({
      kind: "user-delete",
      githubId: "4242",
      userId: "u2",
      at: at(JOURNAL_RETENTION_MS * 2),
    });
    journal.append({ kind: "machine", id: "newest", userId: "u1", at: at(0) });

    expect(journal.compact(NOW - JOURNAL_RETENTION_MS)).toMatchObject({
      kept: 2,
      dropped: 2,
    });
    expect(
      journal.entries().map((entry) => entry.kind === "machine" && entry.id),
    ).toEqual(["new", "newest"]);
    expect(journal.compact(NOW - JOURNAL_RETENTION_MS)).toMatchObject({
      kept: 2,
      dropped: 0,
    });
  });

  it("treats a missing journal as empty", () => {
    expect(
      createRevocationJournal(join(root, "absent.jsonl")).compact(NOW),
    ).toMatchObject({ kept: 0, dropped: 0 });
  });
});

describe("revocation journal reader", () => {
  it("reads entries that straddle its read chunks", () => {
    const path = join(root, "long.jsonl");

    const lines = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({
        v: 1,
        kind: "machine",
        id: `machine-${index}-${"é".repeat(index % 17)}`,
        userId: "u1",
        at: NOW + index,
      }),
    );

    writeFileSync(path, `${lines.join("\n")}\n\n`);

    const entries = createRevocationJournal(path).entries();

    expect(entries).toHaveLength(2_000);
    expect(entries[1_999]).toMatchObject({
      id: `machine-1999-${"é".repeat(1_999 % 17)}`,
    });
  });

  it("refuses a journal line longer than any entry instead of building one huge string", () => {
    const path = join(root, "corrupt.jsonl");
    writeFileSync(path, "x".repeat(MAX_JOURNAL_LINE_BYTES * 3));

    expect(() => createRevocationJournal(path).entries()).toThrow(
      RevocationJournalError,
    );
  });
});
