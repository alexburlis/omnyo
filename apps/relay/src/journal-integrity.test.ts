import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, user } from "@omnyo/connect-db";
import {
  COMMAND_FAILED_EXIT_CODE,
  type RelayCommandIo,
  runRelayCommand,
  SUSPEND_COMMAND,
  VACUUM_COMMAND,
} from "./cli.js";
import { openRelayDatabase } from "./db.js";
import {
  RevocationJournalError,
  createRevocationJournal,
  journalLockPath,
  revocationJournalPath,
} from "./gate/revocation.js";
import { sourceMigrationDirectories } from "./migrations.js";
import { isGitHubAccountBlocked } from "./user-blocks.js";

let root: string;

let journalPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-journal-integrity-"));
  journalPath = join(root, "revocations.jsonl");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ...entry })}\n`;
}

describe("a journal whose last write was cut off", () => {
  it("names the broken line, and the next entry starts on a line of its own", () => {
    writeFileSync(
      journalPath,
      `${line({ kind: "machine", id: "m1", userId: "u1", at: 1 })}{"v":1,"kind":"user-bl`,
    );
    const journal = createRevocationJournal(journalPath);

    journal.append({ kind: "machine", id: "m2", userId: "u1", at: 2 });

    expect(() => journal.entries()).toThrow(RevocationJournalError);
    expect(() => journal.entries()).toThrow(/line 2 /u);

    const lines = readFileSync(journalPath, "utf8").split("\n");
    writeFileSync(journalPath, [lines[0], ...lines.slice(2)].join("\n"));

    expect(
      journal.entries().map((entry) => entry.kind === "machine" && entry.id),
    ).toEqual(["m1", "m2"]);
  });
});

describe("journal writers in other processes", () => {
  it("keep an entry another process appends while compaction runs", async () => {
    writeFileSync(
      journalPath,
      line({ kind: "machine", id: "old", userId: "u1", at: 0 }) +
        line({ kind: "machine", id: "new", userId: "u1", at: Date.now() }),
    );
    const lockPath = journalLockPath(journalPath);

    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
const [journal, lock, entry] = process.argv.slice(1);
const held = fs.openSync(lock, "wx");
const descriptor = fs.openSync(journal, "a");
process.stdout.write("locked\\n");
setTimeout(() => {
  fs.writeSync(descriptor, entry);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  fs.closeSync(held);
  fs.unlinkSync(lock);
}, 200);`,
        journalPath,
        lockPath,
        line({
          kind: "user-block",
          githubId: "4242",
          userId: "u1",
          reason: null,
          at: Date.now(),
        }),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    await once(writer.stdout, "data");
    const journal = createRevocationJournal(journalPath);

    expect(journal.compact(1)).toMatchObject({ kept: 2, dropped: 1 });
    await once(writer, "exit");

    expect(journal.entries().map((entry) => entry.kind)).toEqual([
      "machine",
      "user-block",
    ]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a lock left behind by a writer that crashed", () => {
    const lockPath = journalLockPath(journalPath);
    writeFileSync(lockPath, "");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    createRevocationJournal(journalPath).append({
      kind: "machine",
      id: "m1",
      userId: "u1",
      at: 1,
    });

    expect(createRevocationJournal(journalPath).entries()).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("relay commands and the journal", () => {
  let databasePath: string;

  beforeEach(() => {
    databasePath = join(root, "relay.sqlite");

    const database = openRelayDatabase(
      databasePath,
      sourceMigrationDirectories(),
    );

    try {
      const now = new Date();
      database.db
        .insert(user)
        .values({
          id: "u1",
          name: "Mallory",
          email: "mallory@example.com",
          emailVerified: true,
          githubLogin: "mallory",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      database.db
        .insert(account)
        .values({
          id: "a1",
          accountId: "4242",
          providerId: "github",
          userId: "u1",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } finally {
      database.close();
    }
  });

  async function run(argv: readonly string[]) {
    let stdout = "";
    let stderr = "";

    const io: RelayCommandIo = {
      env: { DATABASE_PATH: databasePath },
      stdin: (async function* empty() {})(),
      stdinIsTerminal: false,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      migrations: sourceMigrationDirectories(),
    };

    return { code: await runRelayCommand(argv, io), stdout, stderr };
  }

  it("changes nothing when the journal cannot record a suspension", async () => {
    mkdirSync(revocationJournalPath(databasePath));

    const result = await run([SUSPEND_COMMAND, "--github-id", "4242"]);

    expect(result.code).toBe(COMMAND_FAILED_EXIT_CODE);
    expect(result.stderr).toContain("nothing changed");

    const database = openRelayDatabase(
      databasePath,
      sourceMigrationDirectories(),
    );

    try {
      expect(isGitHubAccountBlocked(database.db, "4242")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("reports a vacuum whose log checkpoint another reader blocked", async () => {
    const reader = new Database(databasePath);

    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM user").get();

      const result = await run([VACUUM_COMMAND]);

      expect(result.code).toBe(COMMAND_FAILED_EXIT_CODE);
      expect(result.stderr).toContain("still holds old pages");
      expect(result.stdout).not.toContain("vacuum ok");
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
  });
});
