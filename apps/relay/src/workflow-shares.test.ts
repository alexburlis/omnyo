import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openRelayDatabase, type RelayDatabase } from "./db.js";
import { sourceMigrationDirectories } from "./migrations.js";
import { readWorkflowShare, revokeWorkflowShare } from "./workflow-shares.js";
import { deleteRelayUser, suspendUser } from "./user-blocks.js";
import {
  replayRevocationJournal,
  type RevocationJournal,
  type RevocationJournalInput,
  type RevocationJournalEntry,
} from "./gate/revocation.js";

const NOW = 1800000000000;

const pkg = {
  schemaVersion: 1,
  revision: 1,
  title: "Fictional feed",
  description: "A synthetic workflow",
  inputs: [],
  trigger: { kind: "manual" },
  flow: { kind: "prompt", prompt: "Write fictional sample text." },
  skills: [],
};

let database: RelayDatabase;

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  database.db.run(
    sql`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','Synthetic','synthetic@example.invalid',1,${NOW},${NOW})`,
  );
});

afterEach(() => database.close());

function createLegacyShare() {
  const metadata = {
    id: "a".repeat(32),
    title: pkg.title,
    description: pkg.description,
    revision: pkg.revision,
    packageDigest: "a".repeat(64),
    executionDigest: "b".repeat(64),
    capabilities: ["model-text"],
    expiresAt: NOW + 30 * 86400000,
  };

  database.db.run(
    sql`INSERT INTO relay_workflow_share (id, user_id, package, metadata, created_at, expires_at)
      VALUES (${metadata.id}, 'owner', ${Buffer.from(JSON.stringify(pkg))}, ${JSON.stringify(metadata)}, ${NOW}, ${metadata.expiresAt})`,
  );

  return metadata;
}

describe("workflow share lifecycle", () => {
  it("pins normalized bytes and enforces absolute expiry", () => {
    const share = createLegacyShare();
    expect(share.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(
      JSON.parse(
        readWorkflowShare(database.db, share.id, NOW)!.bytes.toString(),
      ),
    ).toEqual(pkg);
    expect(
      readWorkflowShare(database.db, share.id, share.expiresAt),
    ).toBeNull();
    expect(readWorkflowShare(database.db, "../owner", NOW)).toBeNull();
  });
  it("denies suspended accounts and cascades account payload deletion", () => {
    const share = createLegacyShare();
    suspendUser(database.db, {
      userId: "owner",
      reason: "synthetic",
      now: NOW,
    });
    expect(readWorkflowShare(database.db, share.id, NOW)).toBeNull();
    deleteRelayUser(database.db, { userId: "owner", now: NOW });
    expect(
      database.db.get(sql`SELECT 1 FROM relay_workflow_share`),
    ).toBeUndefined();
  });
  it("journals before deletion and refuses a restored payload after replay", () => {
    const share = createLegacyShare();

    const row = database.sqlite
      .prepare("SELECT * FROM relay_workflow_share WHERE id = ?")
      .get(share.id);

    const entries: RevocationJournalInput[] = [];
    expect(
      revokeWorkflowShare(
        database.db,
        (entry) => {
          entries.push(entry);
          expect(readWorkflowShare(database.db, share.id, NOW)).not.toBeNull();
        },
        { id: share.id, userId: "owner", now: NOW },
      ),
    ).toBe(true);
    expect(readWorkflowShare(database.db, share.id, NOW)).toBeNull();
    database.sqlite
      .prepare(
        "INSERT INTO relay_workflow_share VALUES (@id,@user_id,@package,@metadata,@created_at,@expires_at)",
      )
      .run(row);

    const versioned: RevocationJournalEntry[] = entries.map((entry) => ({
      ...entry,
      v: 1,
    }));

    const journal: RevocationJournal = {
      append() {},
      *read() {
        yield* versioned;
      },
      entries: () => versioned,
      compact: () => ({ kept: 1, dropped: 0, size: 1, nextExpiry: null }),
      size: () => 1,
    };

    replayRevocationJournal(database.db, journal);
    expect(readWorkflowShare(database.db, share.id, NOW)).toBeNull();
  });
  it("preserves a payload if the durable journal refuses the write", () => {
    const share = createLegacyShare();
    expect(() =>
      revokeWorkflowShare(
        database.db,
        () => {
          throw new Error("disk unavailable");
        },
        { id: share.id, userId: "owner", now: NOW },
      ),
    ).toThrow();
    expect(readWorkflowShare(database.db, share.id, NOW)).not.toBeNull();
  });
});
