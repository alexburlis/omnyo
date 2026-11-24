import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRelayDatabase } from "./db.js";
import { isUserBlocked } from "./user-blocks.js";
import {
  CONNECT_DB_MIGRATIONS_TABLE,
  MigrationError,
  RELAY_LOCAL_MIGRATIONS_TABLE,
  type MigrationDirectories,
  sourceMigrationDirectories,
} from "./migrations.js";

const CONNECT_DB_TABLES = [
  "account",
  "ai_request_log",
  "ai_usage_day",
  "audit_log",
  "connect_code",
  "label_claim",
  "machine",
  "profile",
  "server",
  "session",
  "user",
  "verification",
];

const RELAY_LOCAL_TAGS = [
  "0000_relay_egress_month",
  "0001_relay_user_block",
  "0002_relay_retired_label",
  "0003_relay_suspension",
  "0004_relay_machine_server",
  "0005_relay_prune_indexes",
  "0006_relay_label_limit_kinds",
  "0007_relay_workflow_share",
];

const RELAY_TABLES = [
  "relay_egress_month",
  "relay_machine_server",
  "relay_retired_label",
  "relay_suspension",
  "relay_workflow_share",
];

const LEDGER_TABLES = [
  CONNECT_DB_MIGRATIONS_TABLE,
  RELAY_LOCAL_MIGRATIONS_TABLE,
];

const source = sourceMigrationDirectories();

interface JournalEntry {
  idx: number;
  tag: string;
}

function journalTags(directory: string): string[] {
  const journal = JSON.parse(
    readFileSync(join(directory, "meta", "_journal.json"), "utf8"),
  ) as {
    entries: JournalEntry[];
  };

  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.tag);
}

function names(sqlite: Database.Database, type: "table" | "trigger"): string[] {
  return sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => (row as { name: string }).name);
}

function count(
  sqlite: Database.Database,
  sql: string,
  ...params: unknown[]
): number {
  return (sqlite.prepare(sql).get(...params) as { n: number }).n;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "relay-migrations-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function copiedDirectories(): MigrationDirectories {
  const copy = {
    connectDb: join(workDir, "connect-db"),
    relayLocal: join(workDir, "relay"),
  };

  cpSync(source.connectDb, copy.connectDb, { recursive: true });
  cpSync(source.relayLocal, copy.relayLocal, { recursive: true });

  return copy;
}

describe("relay migration runner", () => {
  it("applies every connect-db and relay-local migration once on a file database", () => {
    const path = join(workDir, "relay.sqlite");
    const tags = journalTags(source.connectDb);
    expect(tags).toHaveLength(9);

    const first = openRelayDatabase(path, source);

    try {
      expect(first.applied.connectDb).toEqual(tags);
      expect(first.applied.relayLocal).toEqual(RELAY_LOCAL_TAGS);
      expect(names(first.sqlite, "table")).toEqual(
        [...CONNECT_DB_TABLES, ...RELAY_TABLES, ...LEDGER_TABLES].sort(),
      );
      expect(names(first.sqlite, "trigger")).toHaveLength(12);
      expect(first.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(first.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(first.sqlite.pragma("synchronous", { simple: true })).toBe(1);
      expect(first.sqlite.pragma("temp_store", { simple: true })).toBe(2);
      expect(first.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);

      const recorded = first.sqlite
        .prepare(
          `SELECT tag, sha256 FROM "${CONNECT_DB_MIGRATIONS_TABLE}" ORDER BY tag`,
        )
        .all() as { tag: string; sha256: string }[];

      expect(recorded).toEqual(
        tags.map((tag) => ({
          tag,
          sha256: createHash("sha256")
            .update(readFileSync(join(source.connectDb, `${tag}.sql`)))
            .digest("hex"),
        })),
      );
    } finally {
      first.close();
    }

    const second = openRelayDatabase(path, source);

    try {
      expect(second.applied).toEqual({ connectDb: [], relayLocal: [] });
      expect(
        count(
          second.sqlite,
          `SELECT count(*) AS n FROM "${CONNECT_DB_MIGRATIONS_TABLE}"`,
        ),
      ).toBe(9);
      expect(
        count(
          second.sqlite,
          `SELECT count(*) AS n FROM "${RELAY_LOCAL_MIGRATIONS_TABLE}"`,
        ),
      ).toBe(RELAY_LOCAL_TAGS.length);
    } finally {
      second.close();
    }
  });

  it("refuses to start when an applied migration file changed", () => {
    const path = join(workDir, "relay.sqlite");
    const directories = copiedDirectories();
    openRelayDatabase(path, directories).close();

    appendFileSync(
      join(directories.connectDb, "0004_machine_labels.sql"),
      "\n",
    );
    expect(() => openRelayDatabase(path, directories)).toThrow(MigrationError);
    expect(() => openRelayDatabase(path, directories)).toThrow(
      /0004_machine_labels changed after it was applied/,
    );

    const restored = copiedDirectories();
    openRelayDatabase(path, restored).close();
    appendFileSync(
      join(restored.relayLocal, "0000_relay_egress_month.sql"),
      "\n",
    );
    expect(() => openRelayDatabase(path, restored)).toThrow(
      /0000_relay_egress_month changed after it was applied/,
    );
  });

  it("keeps child rows when a table-rebuild migration runs on a populated database", () => {
    const path = join(workDir, "relay.sqlite");
    const directories = copiedDirectories();
    const journalPath = join(directories.connectDb, "meta", "_journal.json");
    const fullJournal = readFileSync(journalPath, "utf8");
    const journal = JSON.parse(fullJournal) as { entries: JournalEntry[] };
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }),
    );
    const laterRelayLocal = RELAY_LOCAL_TAGS.slice(2);

    for (const tag of laterRelayLocal) {
      rmSync(join(directories.relayLocal, `${tag}.sql`));
    }

    const early = openRelayDatabase(path, directories);

    try {
      expect(early.applied.connectDb).toEqual([
        "0000_init",
        "0001_machine",
        "0002_user_github_login",
      ]);
      const created = Date.UTC(2026, 10, 1);
      early.sqlite
        .prepare(
          "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("u1", "Owner", "owner@example.com", created, created);
      early.sqlite
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?, ?, ?)",
        )
        .run("u1", "owner-box", created);
      early.sqlite
        .prepare(
          "INSERT INTO server (id, user_id, name, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("s1", "u1", "default", created);
      early.sqlite
        .prepare(
          "INSERT INTO connect_code (code, user_id, server_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("c1", "u1", "s1", "pair", created + 600_000, created);
      early.sqlite
        .prepare(
          "INSERT INTO relay_egress_month (user_id, month, bytes) VALUES (?, ?, ?)",
        )
        .run("u1", "2026-11", 42);
    } finally {
      early.close();
    }

    writeFileSync(journalPath, fullJournal);
    cpSync(source.relayLocal, directories.relayLocal, { recursive: true });
    const full = openRelayDatabase(path, directories);

    try {
      expect(full.applied.connectDb).toEqual(
        journalTags(source.connectDb).slice(3),
      );
      expect(full.applied.relayLocal).toEqual(laterRelayLocal);
      expect(
        full.sqlite
          .prepare("SELECT code, user_id, server_id FROM connect_code")
          .all(),
      ).toEqual([{ code: "c1", user_id: "u1", server_id: "s1" }]);
      expect(
        full.sqlite.prepare("SELECT id, subdomain FROM server").all(),
      ).toEqual([{ id: "s1", subdomain: "owner-box" }]);
      expect(
        full.sqlite
          .prepare(
            "SELECT label, kind, owner_id FROM label_claim ORDER BY label",
          )
          .all(),
      ).toEqual([{ label: "owner-box", kind: "handle", owner_id: "u1" }]);
      expect(
        count(
          full.sqlite,
          "SELECT bytes AS n FROM relay_egress_month WHERE user_id = ?",
          "u1",
        ),
      ).toBe(42);
      expect(full.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(full.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      full.close();
    }
  });

  it("moves existing suspensions to rows keyed by GitHub ID that outlive the user", () => {
    const path = join(workDir, "relay.sqlite");
    const directories = copiedDirectories();

    for (const tag of RELAY_LOCAL_TAGS.slice(2)) {
      rmSync(join(directories.relayLocal, `${tag}.sql`));
    }

    const early = openRelayDatabase(path, directories);

    try {
      early.sqlite.exec(
        "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1);" +
          "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('a1', '4242', 'github', 'u1', 1, 1);" +
          "INSERT INTO relay_user_block (user_id, blocked_at, reason) VALUES ('u1', 7, 'spam');",
      );
    } finally {
      early.close();
    }

    cpSync(source.relayLocal, directories.relayLocal, { recursive: true });
    const full = openRelayDatabase(path, directories);

    try {
      expect(
        full.sqlite
          .prepare(
            "SELECT github_id, user_id, blocked_at, reason FROM relay_suspension",
          )
          .all(),
      ).toEqual([
        { github_id: "4242", user_id: "u1", blocked_at: 7, reason: "spam" },
      ]);
      full.sqlite.exec("DELETE FROM user WHERE id = 'u1'");
      expect(
        count(full.sqlite, "SELECT count(*) AS n FROM relay_suspension"),
      ).toBe(1);
      expect(names(full.sqlite, "table")).not.toContain("relay_user_block");
    } finally {
      full.close();
    }
  });

  it("migrates two blocked users who share one GitHub ID without failing, and keeps both blocked", () => {
    const path = join(workDir, "relay.sqlite");
    const directories = copiedDirectories();

    for (const tag of RELAY_LOCAL_TAGS.slice(2)) {
      rmSync(join(directories.relayLocal, `${tag}.sql`));
    }

    const early = openRelayDatabase(path, directories);

    try {
      early.sqlite.exec(
        "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u1', 'One', 'one@example.com', 1, 1), ('u2', 'Two', 'two@example.com', 1, 1);" +
          "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('a1', '4242', 'github', 'u1', 1, 1), ('a2', '4242', 'github', 'u2', 2, 2);" +
          "INSERT INTO relay_user_block (user_id, blocked_at, reason) VALUES ('u1', 7, 'spam'), ('u2', 8, 'spam');",
      );
    } finally {
      early.close();
    }

    cpSync(source.relayLocal, directories.relayLocal, { recursive: true });
    const full = openRelayDatabase(path, directories);

    try {
      expect(isUserBlocked(full.db, "u1")).toBe(true);
      expect(isUserBlocked(full.db, "u2")).toBe(true);
    } finally {
      full.close();
    }
  });

  it("would lose child rows if the rebuild ran inside a transaction with foreign keys on", () => {
    const sqlite = new Database(":memory:");

    try {
      sqlite.pragma("foreign_keys = ON");

      for (const tag of [
        "0000_init",
        "0001_machine",
        "0002_user_github_login",
      ]) {
        sqlite.exec(readFileSync(join(source.connectDb, `${tag}.sql`), "utf8"));
      }

      sqlite.exec(
        "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1);" +
          "INSERT INTO profile (user_id, handle, created_at) VALUES ('u1', 'owner-box', 1);" +
          "INSERT INTO server (id, user_id, name, created_at) VALUES ('s1', 'u1', 'default', 1);" +
          "INSERT INTO connect_code (code, user_id, server_id, purpose, expires_at, created_at) VALUES ('c1', 'u1', 's1', 'pair', 2, 1);",
      );
      sqlite.exec("BEGIN");
      sqlite.exec(
        readFileSync(
          join(source.connectDb, "0003_server_subdomain.sql"),
          "utf8",
        ),
      );
      sqlite.exec("COMMIT");

      expect(count(sqlite, "SELECT count(*) AS n FROM connect_code")).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("rolls back a migration that leaves a foreign key violation", () => {
    const path = join(workDir, "relay.sqlite");
    const directories = copiedDirectories();
    openRelayDatabase(path, directories).close();

    writeFileSync(
      join(directories.relayLocal, "0001_dangling_fixture.sql"),
      "INSERT INTO relay_egress_month (user_id, month, bytes) VALUES ('missing-user', '2026-11', 1);\n",
    );

    expect(() => openRelayDatabase(path, directories)).toThrow(
      /0001_dangling_fixture left 1 foreign key violation/,
    );

    const sqlite = new Database(path, { readonly: true });

    try {
      expect(
        count(sqlite, "SELECT count(*) AS n FROM relay_egress_month"),
      ).toBe(0);
      expect(
        count(
          sqlite,
          `SELECT count(*) AS n FROM "${RELAY_LOCAL_MIGRATIONS_TABLE}" WHERE tag = ?`,
          "0001_dangling_fixture",
        ),
      ).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
