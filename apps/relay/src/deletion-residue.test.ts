import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, profile, session, user } from "@omnyo/connect-db";
import {
  BACKUP_FILE_PATTERN,
  BACKUP_HOUR_UTC,
  BACKUP_KEEP,
  BACKUP_MINUTE_UTC,
  createRelayBackup,
} from "./backup.js";
import {
  DELETE_USER_COMMAND,
  type RelayCommandIo,
  runRelayCommand,
} from "./cli.js";
import { openRelayDatabase, type RelayDatabase } from "./db.js";
import {
  createRevocationJournal,
  replayRevocationJournal,
  revocationJournalPath,
} from "./gate/revocation.js";
import { sourceMigrationDirectories } from "./migrations.js";
import { deleteRelayUser } from "./user-blocks.js";

const USER_ID = "u-erase";

const GITHUB_ID = "880055";

const MARKER_EMAIL = "erasure-marker-5b1e@example.org";

const MARKER_AGENT = "ErasureMarkerAgent/5.5";

const MINUTE_MS = 60 * 1000;

const DAY_MS = 24 * 60 * MINUTE_MS;

const ARCHIVE_HOUR_UTC = 4;

const ARCHIVE_MINUTE_UTC = 45;

const DAY_ZERO = Date.UTC(2026, 10, 12);

let root: string;

function at(day: number, hour: number, minute: number): number {
  return DAY_ZERO + day * DAY_MS + (hour * 60 + minute) * MINUTE_MS;
}

function seed(database: RelayDatabase): void {
  const now = new Date(at(0, 0, 0));
  const { db } = database;

  db.insert(user)
    .values({
      id: USER_ID,
      name: "Erasure Subject",
      email: MARKER_EMAIL,
      emailVerified: true,
      githubLogin: "erasuresubject",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: "a-erase",
      accountId: GITHUB_ID,
      providerId: "github",
      userId: USER_ID,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(profile)
    .values({ userId: USER_ID, handle: "erasuresubject", createdAt: now })
    .run();
  db.insert(session)
    .values({
      id: "sess-erase",
      userId: USER_ID,
      token: randomUUID(),
      userAgent: MARKER_AGENT,
      ipAddress: "203.0.113.91",
      expiresAt: new Date(now.getTime() + DAY_MS),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function holdsMarkers(bytes: Buffer): boolean {
  return (
    bytes.includes(Buffer.from(MARKER_EMAIL, "utf8")) ||
    bytes.includes(Buffer.from(MARKER_AGENT, "utf8"))
  );
}

function liveFiles(path: string): Buffer {
  return Buffer.concat(
    [path, `${path}-wal`].filter(existsSync).map((file) => readFileSync(file)),
  );
}

function copyHoldsUser(path: string): boolean {
  const copy = new Database(path, { readonly: true, fileMustExist: true });

  try {
    const row = copy
      .prepare("SELECT count(*) AS n FROM user WHERE email = ?")
      .get(MARKER_EMAIL);

    return typeof row === "object" && row !== null && "n" in row && row.n !== 0;
  } finally {
    copy.close();
  }
}

async function runCli(
  databasePath: string,
  argv: readonly string[],
): Promise<number | null> {
  const io: RelayCommandIo = {
    env: { DATABASE_PATH: databasePath },
    stdin: (async function* empty() {})(),
    stdinIsTerminal: false,
    stdout: () => undefined,
    stderr: () => undefined,
    migrations: sourceMigrationDirectories(),
  };

  return runRelayCommand(argv, io);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-deletion-residue-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a deleted user's data in the relay's database files", () => {
  it("leaves no email or session details in the database image", () => {
    const database = openRelayDatabase(
      ":memory:",
      sourceMigrationDirectories(),
    );

    try {
      seed(database);
      expect(holdsMarkers(database.sqlite.serialize())).toBe(true);
      expect(deleteRelayUser(database.db, { userId: USER_ID, now: 1 })).toBe(
        true,
      );
      expect(holdsMarkers(database.sqlite.serialize())).toBe(false);
    } finally {
      database.close();
    }
  });

  it("leaves none in relay.sqlite or its write-ahead log once delete-user finishes, while the relay holds its connection", async () => {
    const path = join(root, "relay.sqlite");
    const relay = openRelayDatabase(path, sourceMigrationDirectories());

    try {
      seed(relay);
      relay.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      expect(holdsMarkers(liveFiles(path))).toBe(true);

      expect(
        await runCli(path, [
          DELETE_USER_COMMAND,
          "--github-id",
          GITHUB_ID,
          "--yes",
        ]),
      ).toBe(0);
      expect(
        relay.db.select().from(user).where(eq(user.id, USER_ID)).all(),
      ).toHaveLength(0);
      expect(holdsMarkers(liveFiles(path))).toBe(false);
    } finally {
      relay.close();
    }
  });

  it("is gone from the live files after the nightly backup when the relay itself deleted it", () => {
    const path = join(root, "relay.sqlite");
    const relay = openRelayDatabase(path, sourceMigrationDirectories());

    try {
      seed(relay);
      relay.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      deleteRelayUser(relay.db, { userId: USER_ID, now: 1 });

      const copy = createRelayBackup({
        sqlite: relay.sqlite,
        directory: join(root, "backups"),
        now: at(1, BACKUP_HOUR_UTC, BACKUP_MINUTE_UTC),
      });

      expect(statSync(`${path}-wal`).size).toBe(0);
      expect(holdsMarkers(liveFiles(path))).toBe(false);
      expect(holdsMarkers(readFileSync(join(root, "backups", copy)))).toBe(
        false,
      );
    } finally {
      relay.close();
    }
  });

  it("stays deleted after a restore from a copy taken before delete-user and the startup journal replay", async () => {
    const path = join(root, "relay.sqlite");
    const directory = join(root, "backups");
    const relay = openRelayDatabase(path, sourceMigrationDirectories());
    let copy: string;

    try {
      seed(relay);
      copy = createRelayBackup({
        sqlite: relay.sqlite,
        directory,
        now: at(0, BACKUP_HOUR_UTC, BACKUP_MINUTE_UTC),
      });
    } finally {
      relay.close();
    }

    expect(
      await runCli(path, [
        DELETE_USER_COMMAND,
        "--github-id",
        GITHUB_ID,
        "--yes",
      ]),
    ).toBe(0);

    const restoredPath = join(root, "restored.sqlite");
    copyFileSync(join(directory, copy), restoredPath);

    const restored = openRelayDatabase(
      restoredPath,
      sourceMigrationDirectories(),
    );

    try {
      expect(
        restored.db.select().from(user).where(eq(user.id, USER_ID)).all(),
      ).toHaveLength(1);
      replayRevocationJournal(
        restored.db,
        createRevocationJournal(revocationJournalPath(path)),
      );
      expect(
        restored.db.select().from(user).where(eq(user.id, USER_ID)).all(),
      ).toHaveLength(0);
    } finally {
      restored.close();
    }
  });

  it("drops out of the nightly copies within 7 days, so 7 kept server archives hold it for under the 14 days the privacy page states", () => {
    const database = openRelayDatabase(
      ":memory:",
      sourceMigrationDirectories(),
    );

    const directory = join(root, "backups");
    const deletedAt = at(0, BACKUP_HOUR_UTC, BACKUP_MINUTE_UTC + 1);
    const archivesHoldingUser: number[] = [];

    try {
      seed(database);

      for (let day = 0; day <= 9; day += 1) {
        createRelayBackup({
          sqlite: database.sqlite,
          directory,
          now: at(day, BACKUP_HOUR_UTC, BACKUP_MINUTE_UTC),
        });

        if (day === 0) {
          deleteRelayUser(database.db, { userId: USER_ID, now: deletedAt });
        }

        const holds = readdirSync(directory)
          .filter((name) => BACKUP_FILE_PATTERN.test(name))
          .some((name) => copyHoldsUser(join(directory, name)));

        if (holds) {
          archivesHoldingUser.push(
            at(day, ARCHIVE_HOUR_UTC, ARCHIVE_MINUTE_UTC),
          );
        }
      }
    } finally {
      database.close();
    }

    const lastArchive = archivesHoldingUser.at(-1);

    expect(BACKUP_KEEP).toBe(7);
    expect(archivesHoldingUser).toHaveLength(BACKUP_KEEP);
    expect(lastArchive).toBeDefined();
    expect(
      (lastArchive ?? Number.POSITIVE_INFINITY) +
        BACKUP_KEEP * DAY_MS -
        deletedAt,
    ).toBeLessThan(14 * DAY_MS);
  });
});
