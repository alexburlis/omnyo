import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_FILE_PATTERN } from "./backup.js";
import {
  AUDIT_TAIL_COMMAND,
  BACKUP_COMMAND,
  COMMAND_FAILED_EXIT_CODE,
  COMMAND_USAGE_EXIT_CODE,
  type RelayCommandIo,
  runRelayCommand,
  VACUUM_COMMAND,
} from "./cli.js";
import { openRelayDatabase } from "./db.js";
import { sourceMigrationDirectories } from "./migrations.js";

const NOW = Date.UTC(2026, 10, 8, 12);

const MINUTE_MS = 60_000;

let root: string;

let databasePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-cli-maintenance-"));
  databasePath = join(root, "relay.sqlite");

  const database = openRelayDatabase(
    databasePath,
    sourceMigrationDirectories(),
  );

  try {
    const insert = database.sqlite.prepare(
      "INSERT INTO audit_log (id, user_id, action, detail, ip_address, created_at) VALUES (?, NULL, ?, ?, ?, ?)",
    );

    insert.run(
      "a1",
      "gate.bearer_rejected",
      "first",
      "198.51.100.7",
      NOW - 3 * MINUTE_MS,
    );
    insert.run("a2", "account.signed_in", "second", null, NOW - 2 * MINUTE_MS);
    insert.run(
      "a3",
      "gate.bearer_rejected",
      "third",
      "203.0.113.9",
      NOW - MINUTE_MS,
    );
    insert.run(
      "a4",
      "account.signed_in",
      "fourth",
      "2001:db8::1",
      NOW - MINUTE_MS,
    );
  } finally {
    database.close();
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {
    DATABASE_PATH: databasePath,
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";

  const io: RelayCommandIo = {
    env,
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

  const code = await runRelayCommand(argv, io);

  return { code, stdout, stderr };
}

function auditLines(stdout: string): unknown[] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

describe("relay maintenance commands", () => {
  it("backs up the database while the running relay holds it open in WAL mode", async () => {
    const live = new Database(join(root, "relay.sqlite"));

    try {
      live.pragma("journal_mode = WAL");
      live.exec("CREATE TABLE IF NOT EXISTS review_wal_probe (v TEXT)");
      live.prepare("INSERT INTO review_wal_probe (v) VALUES (?)").run("live");

      const result = await run([BACKUP_COMMAND]);

      expect(result.stderr).toBe("");
      expect(result).toMatchObject({ code: 0 });
      expect(result.stdout).toMatch(/^relay-\d{8}T\d{6}Z\.sqlite ok\n$/u);
    } finally {
      live.close();
    }
  });

  it("backs up the database next to it and prints only the file name and ok", async () => {
    const result = await run([BACKUP_COMMAND]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(/^relay-\d{8}T\d{6}Z\.sqlite ok\n$/u);
    const file = result.stdout.split(" ")[0] ?? "";
    expect(readdirSync(join(root, "backups"))).toEqual([file]);
    expect(file).toMatch(BACKUP_FILE_PATTERN);

    const copy = new Database(join(root, "backups", file), {
      readonly: true,
      fileMustExist: true,
    });

    try {
      expect(
        copy.prepare("SELECT count(*) AS rows FROM audit_log").get(),
      ).toEqual({ rows: 4 });
    } finally {
      copy.close();
    }
  });

  it("overwrites rows deleted before secure delete was on and prints the file sizes", async () => {
    const marker = "vacuum-marker-7f3a9c1e5d2b4a68";
    const setup = new Database(databasePath);

    try {
      setup.pragma("secure_delete = OFF");
      setup
        .prepare(
          "INSERT INTO audit_log (id, user_id, action, detail, ip_address, created_at) VALUES (?, NULL, ?, ?, NULL, ?)",
        )
        .run("marker", "account.signed_in", marker.repeat(40), NOW);
      setup.prepare("DELETE FROM audit_log WHERE id = ?").run("marker");
      setup.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      setup.close();
    }

    expect(readFileSync(databasePath).includes(marker)).toBe(true);

    const result = await run([VACUUM_COMMAND]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(
      /^vacuum ok: \d+ bytes before, \d+ bytes after\n$/u,
    );
    expect(readFileSync(databasePath).includes(marker)).toBe(false);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });

  it("exits 1 without creating anything when the database file is missing", async () => {
    const missing = join(root, "missing", "relay.sqlite");
    const result = await run([BACKUP_COMMAND], { DATABASE_PATH: missing });

    expect(result.code).toBe(COMMAND_FAILED_EXIT_CODE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^backup: /u);
    expect(existsSync(join(root, "missing"))).toBe(false);

    const unset = await run([BACKUP_COMMAND], { DATABASE_PATH: ":memory:" });
    expect(unset.code).toBe(COMMAND_FAILED_EXIT_CODE);
    expect(unset.stderr).toBe(
      "backup: DATABASE_PATH must name the relay database file\n",
    );
  });

  it("prints the newest audit rows as JSON lines with three fields", async () => {
    const all = await run([AUDIT_TAIL_COMMAND]);

    expect(all).toMatchObject({ code: 0, stderr: "" });
    expect(auditLines(all.stdout)).toEqual([
      {
        created_at: new Date(NOW - MINUTE_MS).toISOString(),
        action: "account.signed_in",
        ip_address: "2001:db8::1",
      },
      {
        created_at: new Date(NOW - MINUTE_MS).toISOString(),
        action: "gate.bearer_rejected",
        ip_address: "203.0.113.9",
      },
      {
        created_at: new Date(NOW - 2 * MINUTE_MS).toISOString(),
        action: "account.signed_in",
        ip_address: null,
      },
      {
        created_at: new Date(NOW - 3 * MINUTE_MS).toISOString(),
        action: "gate.bearer_rejected",
        ip_address: "198.51.100.7",
      },
    ]);

    const limited = await run([AUDIT_TAIL_COMMAND, "--limit", "2"]);
    expect(auditLines(limited.stdout)).toEqual(
      auditLines(all.stdout).slice(0, 2),
    );

    const filtered = await run([
      AUDIT_TAIL_COMMAND,
      "--action",
      "gate.bearer_rejected",
      "--limit",
      "1",
    ]);

    expect(filtered.stdout).toBe(
      `${JSON.stringify({
        created_at: new Date(NOW - MINUTE_MS).toISOString(),
        action: "gate.bearer_rejected",
        ip_address: "203.0.113.9",
      })}\n`,
    );

    const none = await run([AUDIT_TAIL_COMMAND, "--action", "unknown.action"]);
    expect(none).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("rejects a limit outside 1 to 1000 with the usage exit code", async () => {
    for (const limit of ["0", "1001", "-1", "2.5", "ten", ""]) {
      const result = await run([AUDIT_TAIL_COMMAND, "--limit", limit]);

      expect(result.code, limit).toBe(COMMAND_USAGE_EXIT_CODE);
      expect(result.stdout, limit).toBe("");
    }

    expect((await run([AUDIT_TAIL_COMMAND, "--limit", "1000"])).code).toBe(0);
    expect((await run([AUDIT_TAIL_COMMAND, "extra"])).code).toBe(
      COMMAND_USAGE_EXIT_CODE,
    );
    expect((await run([BACKUP_COMMAND, "--now"])).code).toBe(
      COMMAND_USAGE_EXIT_CODE,
    );
  });
});
