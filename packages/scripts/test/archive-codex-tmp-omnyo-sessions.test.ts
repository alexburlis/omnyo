import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMatchingThreadIdsSql,
  buildMatchingThreadPreviewSql,
  escapeSqlString,
  parseArchiveTmpOmnyoSessionsArgs,
  parseThreadPreviewRows,
  resolveCodexStateDbPath,
} from "../src/commands/archive-codex-tmp-omnyo-sessions.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("archive-codex-tmp-omnyo-sessions", () => {
  it("defaults to current and finite legacy test temp dirs from ~/.codex", () => {
    const parsedArgs = parseArchiveTmpOmnyoSessionsArgs(
      [],
      { CODEX_BIN: "/custom/codex" },
      "/Users/tester",
    );

    expect(parsedArgs.help).toBe(false);
    expect(parsedArgs.options).toEqual({
      codexBin: "/custom/codex",
      codexHome: path.resolve("/Users/tester", ".codex"),
      concurrency: 25,
      dryRun: false,
      patterns: [
        "*/omnyo-standalone-*",
        "*/omnyo-integration-*",
        "*/omnyo-integ-*",
        "*/omnyo-qa-smoke-*",
        "*/bb-standalone-*",
        "*/bb-integration-*",
        "*/bb-integ-*",
        "*/bb-qa-smoke-*",
      ],
      yes: false,
    });
  });

  it("selects canonical and finite legacy temp sessions without changing recorded data", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "codex-state-selection-"),
    );

    tempDirs.push(directory);
    const dbPath = path.join(directory, "state_5.sqlite");

    const rows = [
      ["current", "/tmp/omnyo-integration-one", 0, 4],
      ["legacy", "/tmp/bb-integ-two", 0, 3],
      ["foreign", "/tmp/custom-bb-work", 0, 2],
      ["archived", "/tmp/omnyo-integ-three", 1, 1],
    ] as const;

    execFileSync("sqlite3", [
      dbPath,
      "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, archived INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
        rows
          .map(
            ([id, cwd, archived, updatedAt]) =>
              `INSERT INTO threads VALUES ('${id}', '${cwd}', ${archived}, ${updatedAt});`,
          )
          .join(""),
    ]);

    const readRows = (): string =>
      execFileSync("sqlite3", [dbPath, "SELECT * FROM threads ORDER BY id;"], {
        encoding: "utf8",
      });

    const original = readRows();

    const { options } = parseArchiveTmpOmnyoSessionsArgs(
      [],
      {},
      "/Users/tester",
    );

    const selected = execFileSync(
      "sqlite3",
      [dbPath, buildMatchingThreadIdsSql(options.patterns)],
      { encoding: "utf8" },
    );

    expect(selected.trim().split("\n")).toEqual(["current", "legacy"]);
    expect(readRows()).toBe(original);
  });

  it("respects CODEX_HOME when choosing the default Codex state directory", () => {
    const parsedArgs = parseArchiveTmpOmnyoSessionsArgs(
      [],
      { CODEX_HOME: "~/custom-codex" },
      "/Users/tester",
    );

    expect(parsedArgs.options.codexHome).toBe(
      path.resolve("/Users/tester", "custom-codex"),
    );
  });

  it("parses explicit cleanup options", () => {
    const parsedArgs = parseArchiveTmpOmnyoSessionsArgs(
      [
        "--",
        "--dry-run",
        "--yes",
        "--pattern",
        "/tmp/custom-omnyo-*",
        "--codex-home=~/custom-codex",
        "--codex-bin",
        "~/bin/codex",
        "--concurrency=7",
      ],
      {},
      "/Users/tester",
    );

    expect(parsedArgs.options).toEqual({
      codexBin: path.join("/Users/tester", "bin", "codex"),
      codexHome: path.resolve("/Users/tester", "custom-codex"),
      concurrency: 7,
      dryRun: true,
      patterns: ["/tmp/custom-omnyo-*"],
      yes: true,
    });
  });

  it("accumulates repeated --pattern flags and replaces the defaults", () => {
    const parsedArgs = parseArchiveTmpOmnyoSessionsArgs(
      ["--pattern", "*/omnyo-foo-*", "--pattern=*/omnyo-bar-*"],
      {},
      "/Users/tester",
    );

    expect(parsedArgs.options.patterns).toEqual([
      "*/omnyo-foo-*",
      "*/omnyo-bar-*",
    ]);
  });

  it("rejects unknown or incomplete options", () => {
    expect(() =>
      parseArchiveTmpOmnyoSessionsArgs(["--wat"], {}, "/tmp"),
    ).toThrow("Unknown option: --wat");
    expect(() =>
      parseArchiveTmpOmnyoSessionsArgs(["--pattern"], {}, "/tmp"),
    ).toThrow("Missing value for --pattern");
    expect(() =>
      parseArchiveTmpOmnyoSessionsArgs(["--concurrency", "0"], {}, "/tmp"),
    ).toThrow("--concurrency must be a positive integer");
  });

  it("resolves the highest numbered Codex state DB", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    tempDirs.push(codexHome);
    writeFileSync(path.join(codexHome, "state_4.sqlite"), "");
    writeFileSync(path.join(codexHome, "state_4.sqlite-wal"), "");
    writeFileSync(path.join(codexHome, "state_5.sqlite"), "");
    writeFileSync(path.join(codexHome, "state_5.sqlite.backup-old"), "");

    expect(resolveCodexStateDbPath(codexHome)).toBe(
      path.join(codexHome, "state_5.sqlite"),
    );
  });

  it("reports when no Codex state DB exists", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    tempDirs.push(codexHome);

    expect(() => resolveCodexStateDbPath(codexHome)).toThrow(
      `No Codex state DB found in ${codexHome}`,
    );
  });

  it("escapes SQLite string values used in generated queries", () => {
    expect(escapeSqlString("/tmp/omnyo-o'clock-*")).toBe(
      "/tmp/omnyo-o''clock-*",
    );
    expect(buildMatchingThreadIdsSql(["/tmp/omnyo-o'clock-*"])).toContain(
      "archived=0 AND (cwd GLOB '/tmp/omnyo-o''clock-*')",
    );
    expect(buildMatchingThreadPreviewSql(["/tmp/omnyo-*"])).toContain(
      "ORDER BY updated_at DESC LIMIT 10",
    );
  });

  it("ORs multiple GLOB patterns in the WHERE clause", () => {
    const sql = buildMatchingThreadIdsSql([
      "*/omnyo-standalone-*",
      "*/omnyo-integration-*",
      "*/omnyo-integ-*",
    ]);

    expect(sql).toContain(
      "archived=0 AND (cwd GLOB '*/omnyo-standalone-*' OR cwd GLOB '*/omnyo-integration-*' OR cwd GLOB '*/omnyo-integ-*')",
    );
  });

  it("parses sqlite preview rows", () => {
    const separator = "\u001f";

    const rows = parseThreadPreviewRows(
      [
        ["thr_1", "2026-04-15 13:40:15", "/tmp/omnyo-integ-one"].join(
          separator,
        ),
        ["thr_2", "2026-04-15 13:39:51", "/tmp/omnyo-integration-two"].join(
          separator,
        ),
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        cwd: "/tmp/omnyo-integ-one",
        id: "thr_1",
        updatedAt: "2026-04-15 13:40:15",
      },
      {
        cwd: "/tmp/omnyo-integration-two",
        id: "thr_2",
        updatedAt: "2026-04-15 13:39:51",
      },
    ]);
  });
});
