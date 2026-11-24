import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { account, user } from "@omnyo/connect-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RelayDatabase, openRelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { isGitHubAccountBlocked, isUserBlocked } from "../user-blocks.js";
import type { RelayLogger } from "../contracts.js";
import {
  JOURNAL_COMPACT_INTERVAL_MS,
  JOURNAL_RETENTION_MS,
  type RevocationJournal,
  createRetirementRecorder,
  createRevocationJournal,
  replayRevocationJournal,
  startJournalMaintenance,
} from "./revocation.js";

const NOW = Date.UTC(2026, 10, 9, 12, 0);

const OLD = NOW - 2 * JOURNAL_RETENTION_MS;

let root: string;

let database: RelayDatabase;

let journal: RevocationJournal;

function openDatabase(name: string): RelayDatabase {
  return openRelayDatabase(
    join(root, name),
    sourceMigrationDirectories(),
    () => NOW,
  );
}

function seedLinkedOwner(target: RelayDatabase, githubId: string): void {
  target.db
    .insert(user)
    .values({
      id: "u1",
      name: "owner",
      email: "u1@example.test",
      emailVerified: true,
      image: null,
      githubLogin: "owner",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })
    .run();
  target.db
    .insert(account)
    .values({
      id: "account-u1",
      accountId: githubId,
      providerId: "github",
      userId: "u1",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })
    .run();
}

function insertRetired(label: string, retiredAt: number): void {
  database.sqlite
    .prepare(
      "INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) VALUES (?, 'server', '4242', 'u1', ?)",
    )
    .run(label, retiredAt);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-retention-"));
  database = openDatabase("relay.sqlite");
  journal = createRevocationJournal(join(root, "revocations.jsonl"));
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("retirement journaling after a clock step", () => {
  it("journals a retirement stamped earlier than every journaled one", () => {
    const record = createRetirementRecorder(database.db, journal);

    insertRetired("later-label", NOW + 60_000);
    expect(record()).toBe(1);

    insertRetired("earlier-label", NOW - 60_000);
    expect(record()).toBe(1);
    expect(record()).toBe(0);
    expect(
      journal
        .entries()
        .flatMap((entry) => (entry.kind === "label-retire" ? entry.label : [])),
    ).toEqual(["later-label", "earlier-label"]);
    expect(createRetirementRecorder(database.db, journal)()).toBe(0);
  });

  it("journals a retirement whose stamp equals the previous one but belongs to another label", () => {
    const record = createRetirementRecorder(database.db, journal);

    insertRetired("first-label", NOW);
    insertRetired("second-label", NOW);

    expect(record()).toBe(2);
  });
});

describe("retirement journaling cost", () => {
  it("reads only rows added or retired recently after its first pass, and still journals a new row stamped long ago", () => {
    for (let index = 0; index < 50; index += 1) {
      insertRetired(`old-label-${index}`, OLD);
    }

    insertRetired("recent-label", NOW);
    let read = 0;

    const counted = new Proxy(database.db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);

        if (property !== "all" || typeof value !== "function") return value;

        return (...args: unknown[]) => {
          const rows: unknown = value.apply(target, args);

          if (Array.isArray(rows)) read += rows.length;

          return rows;
        };
      },
    });

    const record = createRetirementRecorder(counted, journal);

    expect(record()).toBe(51);
    read = 0;
    insertRetired("stepped-back-label", OLD - 60_000);

    expect(record()).toBe(1);
    expect(read).toBeLessThanOrEqual(2);
  });
});

describe("journal compaction on a schedule", () => {
  const silent: RelayLogger = { info() {}, warn() {}, error() {} };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses the journal again only when it grew or an entry has aged out", () => {
    vi.useFakeTimers();
    let at = NOW;
    let compactions = 0;

    const counting: RevocationJournal = {
      ...journal,
      compact(keepFrom) {
        compactions += 1;

        return journal.compact(keepFrom);
      },
    };

    journal.append({ kind: "machine", id: "m1", userId: "u1", at: NOW });

    const stop = startJournalMaintenance({
      db: database.db,
      journal: counting,
      log: silent,
      now: () => at,
    });

    expect(compactions).toBe(1);
    vi.advanceTimersByTime(3 * JOURNAL_COMPACT_INTERVAL_MS);
    expect(compactions).toBe(1);

    journal.append({ kind: "machine", id: "m2", userId: "u1", at: NOW });
    vi.advanceTimersByTime(JOURNAL_COMPACT_INTERVAL_MS);
    expect(compactions).toBe(2);
    vi.advanceTimersByTime(JOURNAL_COMPACT_INTERVAL_MS);
    expect(compactions).toBe(2);

    at = NOW + JOURNAL_RETENTION_MS + 1;
    vi.advanceTimersByTime(JOURNAL_COMPACT_INTERVAL_MS);
    expect(compactions).toBe(3);
    expect(journal.entries()).toEqual([]);
    stop();
  });
});

describe("compaction of permanent entries", () => {
  it("keeps retirements, blocks and unblocks past the retention window and drops the rest", () => {
    journal.append({ kind: "machine", id: "m1", userId: "u1", at: OLD });
    journal.append({
      kind: "server",
      id: "s1",
      userId: "u1",
      credentialHash: null,
      at: OLD,
    });
    journal.append({
      kind: "user-delete",
      githubId: "9",
      userId: "u9",
      at: OLD,
    });
    journal.append({
      kind: "workflow-share",
      id: "a".repeat(32),
      userId: "u1",
      at: OLD,
    });
    journal.append({
      kind: "label-retire",
      label: "kept-label",
      labelKind: "server",
      githubId: "4242",
      userId: "u1",
      at: OLD,
    });
    journal.append({
      kind: "user-block",
      githubId: "4242",
      userId: "u1",
      reason: "spam",
      at: OLD,
    });
    journal.append({
      kind: "user-unblock",
      githubId: "5151",
      userId: "u5",
      at: OLD,
    });

    expect(journal.compact(NOW - JOURNAL_RETENTION_MS)).toMatchObject({
      kept: 3,
      dropped: 4,
    });
    expect(journal.entries().map((entry) => entry.kind)).toEqual([
      "label-retire",
      "user-block",
      "user-unblock",
    ]);
    expect(journal.compact(NOW - JOURNAL_RETENTION_MS).dropped).toBe(0);
  });

  it("keeps only the newest retirement of a label and the newest entry of an account once they age out", () => {
    const retire = (at: number, userId: string) =>
      journal.append({
        kind: "label-retire",
        label: "again-label",
        labelKind: "server",
        githubId: null,
        userId,
        at,
      });

    retire(OLD, "u-old");
    retire(OLD + 2_000, "u-new");
    retire(OLD + 1_000, "u-mid");
    journal.append({
      kind: "user-block",
      githubId: "4242",
      userId: "u1",
      reason: "first",
      at: OLD,
    });
    journal.append({
      kind: "user-unblock",
      githubId: "4242",
      userId: "u1",
      at: OLD + 1,
    });
    journal.append({
      kind: "user-block",
      githubId: "4242",
      userId: "u1",
      reason: "second",
      at: OLD + 2,
    });

    expect(journal.compact(NOW - JOURNAL_RETENTION_MS)).toMatchObject({
      kept: 2,
      dropped: 4,
    });

    const [retired, blocked] = journal.entries();

    expect(retired).toMatchObject({ kind: "label-retire", userId: "u-new" });
    expect(blocked).toMatchObject({ kind: "user-block", reason: "second" });
  });

  it("keeps a recent superseded entry until it ages out", () => {
    journal.append({
      kind: "user-block",
      githubId: "4242",
      userId: "u1",
      reason: null,
      at: NOW - 1_000,
    });
    journal.append({
      kind: "user-unblock",
      githubId: "4242",
      userId: "u1",
      at: NOW,
    });

    expect(journal.compact(NOW - JOURNAL_RETENTION_MS).dropped).toBe(0);
  });

  it("restores the same suspension from a compacted journal as from the full one", () => {
    const entries = [
      {
        kind: "user-block",
        githubId: "4242",
        userId: "u1",
        reason: "spam",
        at: OLD,
      },
      { kind: "user-unblock", githubId: null, userId: "u1", at: OLD + 1 },
      {
        kind: "user-block",
        githubId: "4242",
        userId: "u1",
        reason: "spam again",
        at: OLD + 2,
      },
    ] as const;

    const full = createRevocationJournal(join(root, "full.jsonl"));
    const compacted = createRevocationJournal(join(root, "compacted.jsonl"));

    for (const entry of entries) {
      full.append(entry);
      compacted.append(entry);
    }

    expect(compacted.compact(NOW - JOURNAL_RETENTION_MS).dropped).toBe(1);

    const restoredFull = openDatabase("restored-full.sqlite");
    const restoredCompacted = openDatabase("restored-compacted.sqlite");

    try {
      for (const restored of [restoredFull, restoredCompacted]) {
        seedLinkedOwner(restored, "4242");
      }

      replayRevocationJournal(restoredFull.db, full);
      expect(
        replayRevocationJournal(restoredCompacted.db, compacted),
      ).toMatchObject({ applied: expect.any(Number) });

      expect(isUserBlocked(restoredFull.db, "u1")).toBe(true);
      expect(isUserBlocked(restoredCompacted.db, "u1")).toBe(true);
      expect(isGitHubAccountBlocked(restoredCompacted.db, "4242")).toBe(true);
      replayRevocationJournal(restoredCompacted.db, compacted);
      expect(isUserBlocked(restoredCompacted.db, "u1")).toBe(true);
    } finally {
      restoredFull.close();
      restoredCompacted.close();
    }
  });

  it("restores the newest retirement of a label after compaction and replays it idempotently", () => {
    seedLinkedOwner(database, "4242");

    for (const [at, userId] of [
      [OLD, "u-old"],
      [OLD + 1_000, "u1"],
    ] as const) {
      journal.append({
        kind: "label-retire",
        label: "restored-label",
        labelKind: "server",
        githubId: "4242",
        userId,
        at,
      });
    }

    expect(journal.compact(NOW - JOURNAL_RETENTION_MS).dropped).toBe(1);
    expect(replayRevocationJournal(database.db, journal).applied).toBe(1);
    expect(replayRevocationJournal(database.db, journal).applied).toBe(0);
    expect(
      database.sqlite
        .prepare(
          "SELECT user_id, retired_at FROM relay_retired_label WHERE label = 'restored-label'",
        )
        .get(),
    ).toEqual({ user_id: "u1", retired_at: OLD + 1_000 });
  });
});
