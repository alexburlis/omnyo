import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingLogger } from "./acme.fixture.js";
import {
  BACKUP_FILE_PATTERN,
  BACKUP_KEEP,
  BACKUP_MAX_AGE_MS,
  backupFileName,
  createRelayBackup,
  msUntilNextBackup,
  runNightlyBackup,
  startBackupSchedule,
} from "./backup.js";
import { type RelayDatabase, openRelayDatabase } from "./db.js";
import { sourceMigrationDirectories } from "./migrations.js";

const HOUR_MS = 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

const NOW = Date.UTC(2026, 10, 8, 3, 0);

let root: string;

let backups: string;

let database: RelayDatabase;

const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-backup-"));
  backups = join(root, "backups");
  database = openRelayDatabase(
    join(root, "relay.sqlite"),
    sourceMigrationDirectories(),
  );
  database.sqlite
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("u1", "Owner", "owner@example.com", NOW, NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  database.close();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  rmSync(root, { recursive: true, force: true });
});

function backupFiles(): string[] {
  return readdirSync(backups)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort();
}

function seedOlderBackups(count: number): string[] {
  mkdirSync(backups, { recursive: true, mode: 0o700 });

  return Array.from({ length: count }, (_, index) => {
    const name = backupFileName(NOW - DAY_MS * (count - index));
    writeFileSync(join(backups, name), "older copy");

    return name;
  });
}

interface PushServer {
  url: string;
  requests: Array<{ method: string; url: string }>;
}

async function startPushServer(status: number): Promise<PushServer> {
  const requests: PushServer["requests"] = [];

  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "" });
    response.writeHead(status, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/api/push/push-key-123?status=down&msg=OK`,
    requests,
  };
}

describe("relay backup copy", () => {
  it("writes a readable private copy with the source rows", () => {
    const file = createRelayBackup({
      sqlite: database.sqlite,
      directory: backups,
      now: Date.UTC(2026, 10, 8, 4, 15, 7, 450),
    });

    expect(file).toBe("relay-20261108T041507Z.sqlite");
    expect(file).toMatch(BACKUP_FILE_PATTERN);
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    expect(statSync(join(backups, file)).mode & 0o777).toBe(0o600);
    expect(readdirSync(backups)).toEqual([file]);

    const copy = new Database(join(backups, file), {
      readonly: true,
      fileMustExist: true,
    });

    try {
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(copy.prepare("SELECT id, email FROM user").all()).toEqual([
        { id: "u1", email: "owner@example.com" },
      ]);
    } finally {
      copy.close();
    }
  });

  it("keeps the seven newest copies and never deletes other files", () => {
    const older = seedOlderBackups(BACKUP_KEEP + 2);

    const others = [
      "relay-latest.sqlite",
      "relay-20200101T000000Z.sqlite-wal",
      "notes.txt",
    ];

    for (const name of others) writeFileSync(join(backups, name), "keep");

    const file = createRelayBackup({
      sqlite: database.sqlite,
      directory: backups,
      now: NOW,
    });

    expect(backupFiles()).toEqual([...older.slice(-(BACKUP_KEEP - 1)), file]);

    for (const name of others) {
      expect(existsSync(join(backups, name)), name).toBe(true);
    }
  });

  it("deletes only the new copy and keeps older copies when the integrity check fails", () => {
    const older = seedOlderBackups(BACKUP_KEEP + 1);

    expect(() =>
      createRelayBackup({
        sqlite: database.sqlite,
        directory: backups,
        now: NOW,
        checkIntegrity: () => "*** in database main ***",
      }),
    ).toThrow("The backup copy failed its integrity check");

    expect(backupFiles()).toEqual(older);
    expect(existsSync(join(backups, backupFileName(NOW)))).toBe(false);
  });

  it("refuses to overwrite a copy that already has the same name", () => {
    createRelayBackup({
      sqlite: database.sqlite,
      directory: backups,
      now: NOW,
    });

    expect(() =>
      createRelayBackup({
        sqlite: database.sqlite,
        directory: backups,
        now: NOW,
      }),
    ).toThrow(/EEXIST/u);
    expect(backupFiles()).toEqual([backupFileName(NOW)]);
  });
});

describe("nightly backup timing", () => {
  it("waits until the next 04:15 UTC strictly in the future", () => {
    expect(msUntilNextBackup(Date.UTC(2026, 10, 8, 3, 0))).toBe(
      HOUR_MS + 15 * MINUTE_MS,
    );
    expect(msUntilNextBackup(Date.UTC(2026, 10, 8, 4, 14, 59, 999))).toBe(1);
    expect(msUntilNextBackup(Date.UTC(2026, 10, 8, 4, 15))).toBe(DAY_MS);
    expect(msUntilNextBackup(Date.UTC(2026, 10, 8, 4, 15, 0, 1))).toBe(
      DAY_MS - 1,
    );
    expect(msUntilNextBackup(Date.UTC(2026, 10, 8, 5, 0))).toBe(
      23 * HOUR_MS + 15 * MINUTE_MS,
    );
    expect(msUntilNextBackup(Date.UTC(2026, 10, 30, 12, 0))).toBe(
      Date.UTC(2026, 11, 1, 4, 15) - Date.UTC(2026, 10, 30, 12, 0),
    );
    expect(msUntilNextBackup(Date.UTC(2026, 11, 31, 23, 0))).toBe(
      5 * HOUR_MS + 15 * MINUTE_MS,
    );
    expect(msUntilNextBackup(Date.UTC(2028, 1, 28, 5, 0))).toBe(
      Date.UTC(2028, 1, 29, 4, 15) - Date.UTC(2028, 1, 28, 5, 0),
    );
  });

  it("backs up at 04:15 UTC and again 24 hours later until stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const recorder = recordingLogger();

    const stop = startBackupSchedule({
      sqlite: database.sqlite,
      directory: backups,
      pushUrl: null,
      log: recorder.log,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(HOUR_MS + 15 * MINUTE_MS - 1);
    expect(recorder.events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(recorder.events).toEqual([
      {
        level: "info",
        event: "backup.completed",
        fields: { file: "relay-20261108T041500Z.sqlite" },
      },
    ]);

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(recorder.events.map((entry) => entry.fields)).toEqual([
      { file: "relay-20261108T041500Z.sqlite" },
      { file: "relay-20261109T041500Z.sqlite" },
    ]);

    stop();
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    expect(recorder.events).toHaveLength(2);
    expect(backupFiles()).toEqual([
      "relay-20261108T041500Z.sqlite",
      "relay-20261109T041500Z.sqlite",
    ]);
  });
});

describe("nightly backup push", () => {
  it("sends one GET with status=up after a successful backup", async () => {
    const push = await startPushServer(200);
    const recorder = recordingLogger();

    await runNightlyBackup({
      sqlite: database.sqlite,
      directory: backups,
      pushUrl: push.url,
      log: recorder.log,
      now: () => NOW,
    });

    expect(push.requests).toHaveLength(1);
    const [request] = push.requests;
    expect(request?.method).toBe("GET");
    const received = new URL(request?.url ?? "", "http://relay.test");
    expect(received.pathname).toBe("/api/push/push-key-123");
    expect(received.searchParams.getAll("status")).toEqual(["up"]);
    expect(received.searchParams.get("msg")).toBe("OK");
    expect(recorder.events.map((entry) => entry.event)).toEqual([
      "backup.completed",
    ]);
  });

  it("keeps the backup when the push fails and never logs the push URL", async () => {
    const failing = await startPushServer(500);
    const closed = await startPushServer(200);
    const closedServer = servers.at(-1);
    await new Promise<void>((resolve) => closedServer?.close(() => resolve()));
    servers.pop();

    for (const [pushUrl, expected] of [
      [failing.url, { status: 500 }],
      [closed.url, { reason: "TypeError" }],
    ] as const) {
      const recorder = recordingLogger();
      rmSync(backups, { recursive: true, force: true });

      await runNightlyBackup({
        sqlite: database.sqlite,
        directory: backups,
        pushUrl,
        log: recorder.log,
        now: () => NOW,
      });

      expect(
        recorder.events.map((entry) => [entry.event, entry.fields]),
      ).toEqual([
        ["backup.completed", { file: backupFileName(NOW) }],
        ["backup.push_failed", expected],
      ]);
      const logged = JSON.stringify(recorder.events);
      expect(logged).not.toContain("push-key-123");
      expect(logged).not.toContain("127.0.0.1");
      expect(backupFiles()).toEqual([backupFileName(NOW)]);
    }

    expect(failing.requests).toHaveLength(1);
  });

  it("removes copies older than seven days even when the new copy fails, so a deleted user leaves the copies on time", async () => {
    const older = seedOlderBackups(BACKUP_KEEP + 3);
    writeFileSync(join(backups, "notes.txt"), "keep");
    const recorder = recordingLogger();
    const closed = new Database(":memory:");
    closed.close();

    await runNightlyBackup({
      sqlite: closed,
      directory: backups,
      pushUrl: null,
      log: recorder.log,
      now: () => NOW,
    });

    const kept = older.filter(
      (name) =>
        NOW -
          Date.parse(
            name.replace(
              /^relay-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite$/u,
              "$1-$2-$3T$4:$5:$6Z",
            ),
          ) <
        BACKUP_MAX_AGE_MS,
    );

    expect(kept).toHaveLength(BACKUP_KEEP - 1);
    expect(backupFiles()).toEqual(kept);
    expect(existsSync(join(backups, "notes.txt"))).toBe(true);
    expect(recorder.events.map((event) => event.event)).toEqual([
      "backup.expired_removed",
      "backup.failed",
    ]);
  });

  it("removes expired copies when the schedule starts", () => {
    seedOlderBackups(BACKUP_KEEP + 2);
    const recorder = recordingLogger();

    const stop = startBackupSchedule({
      sqlite: database.sqlite,
      directory: backups,
      pushUrl: null,
      log: recorder.log,
      now: () => NOW,
    });

    stop();

    expect(backupFiles()).toHaveLength(BACKUP_KEEP - 1);
  });

  it("logs backup.failed by error name and does not push when the backup fails", async () => {
    const push = await startPushServer(200);
    const recorder = recordingLogger();
    writeFileSync(backups, "not a directory");

    await runNightlyBackup({
      sqlite: database.sqlite,
      directory: backups,
      pushUrl: push.url,
      log: recorder.log,
      now: () => NOW,
    });

    expect(recorder.events).toEqual([
      { level: "error", event: "backup.failed", fields: { error: "Error" } },
    ]);
    expect(push.requests).toEqual([]);
  });
});
