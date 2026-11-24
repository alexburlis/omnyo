import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_EXPIRED_ROW_RETENTION_MS } from "./account/account.js";
import { type RelayDatabase, openRelayDatabase } from "./db.js";
import {
  createRevocationJournal,
  replayRevocationJournal,
} from "./gate/revocation.js";
import { sourceMigrationDirectories } from "./migrations.js";
import {
  ANONYMOUS_REJECTION_RETENTION_MS,
  AUDIT_LOG_RETENTION_MS,
  BEARER_REJECTED_ACTION,
  INACTIVE_USER_RETENTION_MS,
  PRUNE_INTERVAL_MS,
  REVOKED_MACHINE_RETENTION_MS,
  pruneExpiredRows,
  startPruneJob,
} from "./prune.js";
import { isGitHubAccountBlocked, suspendUser } from "./user-blocks.js";

const NOW = Date.UTC(2026, 10, 8, 12);

const MINUTE_MS = 60_000;

let database: RelayDatabase;

function insertVerification(id: string, expiresAt: number): void {
  database.sqlite
    .prepare(
      "INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, `gate-grant:${id}`, "{}", expiresAt, NOW, NOW);
}

function insertCode(
  code: string,
  expiresAt: number,
  consumedAt: number | null,
): void {
  database.sqlite
    .prepare(
      "INSERT INTO connect_code (code, user_id, purpose, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(code, "u1", "server-pair", expiresAt, consumedAt, NOW);
}

function insertAudit(
  id: string,
  createdAt: number,
  action: string,
  userId: string | null = null,
): void {
  database.sqlite
    .prepare(
      "INSERT INTO audit_log (id, user_id, action, detail, ip_address, created_at) VALUES (?, ?, ?, NULL, ?, ?)",
    )
    .run(id, userId, action, "198.51.100.7", createdAt);
}

function insertUser(id: string, createdAt: number, githubId?: string): void {
  database.sqlite
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, id, `${id}@example.com`, createdAt, createdAt);

  if (githubId !== undefined) {
    database.sqlite
      .prepare(
        "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, 'github', ?, ?, ?)",
      )
      .run(`account-${id}`, githubId, id, createdAt, createdAt);
  }
}

function insertMachine(
  id: string,
  subdomain: string | null,
  revokedAt: number | null,
): void {
  database.sqlite
    .prepare(
      "INSERT INTO machine (id, user_id, subdomain, credential_hash, created_at, revoked_at) VALUES (?, 'u1', ?, ?, ?, ?)",
    )
    .run(id, subdomain, `hash-${id}`, NOW - 60 * DAY_MS, revokedAt);
  database.sqlite
    .prepare(
      "INSERT INTO relay_machine_server (machine_id, server_id, created_at) VALUES (?, 'server-1', ?)",
    )
    .run(id, NOW - 60 * DAY_MS);
}

const DAY_MS = 24 * 60 * MINUTE_MS;

function insertSession(id: string, expiresAt: number): void {
  database.sqlite
    .prepare(
      "INSERT INTO session (id, token, expires_at, ip_address, user_agent, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, `t-${id}`, expiresAt, "198.51.100.7", "browser", "u1", NOW, NOW);
}

function ids(table: string, column: string): string[] {
  return (
    database.sqlite
      .prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`)
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  database.sqlite
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("u1", "Owner", "owner@example.com", NOW, NOW);
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
});

describe("hourly prune job", () => {
  it("deletes workflow shares once they expire", () => {
    const insertShare = database.sqlite.prepare(
      "INSERT INTO relay_workflow_share (id, user_id, package, metadata, created_at, expires_at) VALUES (?, 'u1', ?, '{}', ?, ?)",
    );

    insertShare.run(
      "share-expired",
      Buffer.from("{}"),
      NOW - DAY_MS,
      NOW - MINUTE_MS,
    );
    insertShare.run("share-expiring-now", Buffer.from("{}"), NOW - DAY_MS, NOW);
    insertShare.run(
      "share-live",
      Buffer.from("{}"),
      NOW - DAY_MS,
      NOW + MINUTE_MS,
    );

    expect(pruneExpiredRows(database.db, NOW)).toMatchObject({
      workflowShares: 2,
    });
    expect(ids("relay_workflow_share", "id")).toEqual(["share-live"]);
  });

  it("deletes expired verification rows, long-expired codes and audit rows past 90 days", () => {
    insertVerification("expired", NOW - 1);
    insertVerification("expiring-now", NOW);
    insertVerification("live", NOW + 10 * MINUTE_MS);

    insertCode(
      "OLD-CONSUMED",
      NOW - LINK_EXPIRED_ROW_RETENTION_MS - MINUTE_MS,
      NOW - 2 * LINK_EXPIRED_ROW_RETENTION_MS,
    );
    insertCode(
      "OLD-UNUSED",
      NOW - LINK_EXPIRED_ROW_RETENTION_MS - MINUTE_MS,
      null,
    );
    insertCode("RECENTLY-EXPIRED", NOW - MINUTE_MS, null);
    insertCode("LIVE-CONSUMED", NOW + 10 * MINUTE_MS, NOW - MINUTE_MS);

    insertAudit(
      "a-old",
      NOW - AUDIT_LOG_RETENTION_MS - MINUTE_MS,
      "operator.suspended",
    );
    insertAudit(
      "a-keep",
      NOW - AUDIT_LOG_RETENTION_MS + MINUTE_MS,
      "operator.suspended",
    );
    insertAudit(
      "r-old",
      NOW - ANONYMOUS_REJECTION_RETENTION_MS - MINUTE_MS,
      BEARER_REJECTED_ACTION,
    );
    insertAudit(
      "r-keep",
      NOW - ANONYMOUS_REJECTION_RETENTION_MS + MINUTE_MS,
      BEARER_REJECTED_ACTION,
    );
    insertAudit(
      "r-user",
      NOW - ANONYMOUS_REJECTION_RETENTION_MS - MINUTE_MS,
      BEARER_REJECTED_ACTION,
      "u1",
    );

    insertSession("s-expired", NOW - MINUTE_MS);
    insertSession("s-expiring-now", NOW);
    insertSession("s-live", NOW + 10 * MINUTE_MS);

    expect(pruneExpiredRows(database.db, NOW)).toEqual({
      verifications: 2,
      connectCodes: 2,
      auditRows: 2,
      sessions: 2,
      revokedMachines: 0,
      inactiveUsers: 0,
      workflowShares: 0,
    });
    expect(ids("session", "id")).toEqual(["s-live"]);
    expect(ids("verification", "id")).toEqual(["live"]);
    expect(ids("connect_code", "code")).toEqual([
      "LIVE-CONSUMED",
      "RECENTLY-EXPIRED",
    ]);
    expect(ids("audit_log", "id")).toEqual(["a-keep", "r-keep", "r-user"]);
    expect(pruneExpiredRows(database.db, NOW)).toEqual({
      verifications: 0,
      connectCodes: 0,
      auditRows: 0,
      sessions: 0,
      revokedMachines: 0,
      inactiveUsers: 0,
      workflowShares: 0,
    });
  });

  it("removes devices revoked over 30 days ago while journal replay and the retired label still hold", () => {
    insertMachine(
      "m-old",
      "old-device",
      NOW - REVOKED_MACHINE_RETENTION_MS - MINUTE_MS,
    );
    insertMachine(
      "m-recent",
      null,
      NOW - REVOKED_MACHINE_RETENTION_MS + MINUTE_MS,
    );
    insertMachine("m-live", "live-device", null);
    const directory = mkdtempSync(join(tmpdir(), "relay-prune-journal-"));

    try {
      const journal = createRevocationJournal(
        join(directory, "revocations.jsonl"),
      );

      journal.append({
        kind: "machine",
        id: "m-old",
        userId: "u1",
        at: NOW - REVOKED_MACHINE_RETENTION_MS - MINUTE_MS,
      });

      expect(pruneExpiredRows(database.db, NOW)).toMatchObject({
        revokedMachines: 1,
      });
      expect(ids("machine", "id")).toEqual(["m-live", "m-recent"]);
      expect(ids("relay_machine_server", "machine_id")).toEqual([
        "m-live",
        "m-recent",
      ]);
      expect(ids("relay_retired_label", "label")).toEqual(["old-device"]);
      expect(replayRevocationJournal(database.db, journal)).toEqual({
        entries: 1,
        applied: 0,
        sessionsCleared: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes accounts never used for 30 days and keeps their suspension", () => {
    const old = NOW - INACTIVE_USER_RETENTION_MS - MINUTE_MS;
    insertUser("idle", old, "9001");
    insertUser("idle-signed-in", old);
    insertUser("recent", NOW - INACTIVE_USER_RETENTION_MS + MINUTE_MS);
    insertUser("named", old);
    database.sqlite
      .prepare(
        "INSERT INTO session (id, token, expires_at, user_id, created_at, updated_at) VALUES ('live', 'token-live', ?, 'idle-signed-in', ?, ?)",
      )
      .run(NOW + MINUTE_MS, old, old);
    database.sqlite
      .prepare(
        "INSERT INTO profile (user_id, handle, created_at) VALUES ('named', 'named-owner', ?)",
      )
      .run(old);
    suspendUser(database.db, { userId: "idle", reason: null, now: old });

    expect(pruneExpiredRows(database.db, NOW)).toMatchObject({
      inactiveUsers: 1,
    });
    expect(ids("user", "id")).toEqual([
      "idle-signed-in",
      "named",
      "recent",
      "u1",
    ]);
    expect(isGitHubAccountBlocked(database.db, "9001")).toBe(true);
  });

  it("keeps an unused account while it has a live workflow share", () => {
    insertUser("sharer", NOW - INACTIVE_USER_RETENTION_MS - MINUTE_MS);
    database.sqlite
      .prepare(
        "INSERT INTO relay_workflow_share (id, user_id, package, metadata, created_at, expires_at) VALUES ('share', 'sharer', ?, '{}', ?, ?)",
      )
      .run(Buffer.from("{}"), NOW - DAY_MS, NOW + DAY_MS);

    expect(pruneExpiredRows(database.db, NOW)).toMatchObject({
      inactiveUsers: 0,
      workflowShares: 0,
    });
    expect(ids("user", "id")).toEqual(["sharer", "u1"]);
    expect(pruneExpiredRows(database.db, NOW + 2 * DAY_MS)).toMatchObject({
      inactiveUsers: 1,
      workflowShares: 1,
    });
    expect(ids("user", "id")).toEqual(["u1"]);
  });

  it("runs at start, then every hour, until it is stopped", () => {
    vi.useFakeTimers();
    let now = NOW;
    const events: string[] = [];

    const stop = startPruneJob({
      db: database.db,
      log: {
        info: (event) => events.push(event),
        warn: (event) => events.push(event),
        error: (event) => events.push(event),
      },
      now: () => now,
    });

    expect(events).toEqual(["relay.pruned"]);
    insertVerification("soon", NOW + MINUTE_MS);
    now = NOW + PRUNE_INTERVAL_MS;
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS);

    expect(events).toEqual(["relay.pruned", "relay.pruned"]);
    expect(ids("verification", "id")).toEqual([]);

    stop();
    vi.advanceTimersByTime(3 * PRUNE_INTERVAL_MS);
    expect(events).toHaveLength(2);
  });
});
