import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createConnection,
  deletePluginKvValue,
  getPluginKvValue,
  migrate,
  setPluginKvValue,
  type DbConnection,
} from "../../src/index.js";

const MARKER = "kv-secure-delete-marker-3f9c2a7e1b";

let dir: string;

let path: string;

let db: DbConnection;

function fileBytesContainMarker(): boolean {
  return [path, `${path}-wal`].some(
    (file) => existsSync(file) && readFileSync(file).includes(MARKER),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnyo-kv-secure-delete-"));
  path = join(dir, "app.db");
  db = createConnection(path);
  migrate(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { force: true, recursive: true });
});

it("leaves no trace of a deleted kv value in the database files", () => {
  setPluginKvValue(db, "connect", "credential", JSON.stringify(MARKER));
  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  expect(fileBytesContainMarker()).toBe(true);

  expect(deletePluginKvValue(db, "connect", "credential")).toBe(true);
  db.$client.pragma("wal_checkpoint(TRUNCATE)");

  expect(getPluginKvValue(db, "connect", "credential")).toBeUndefined();
  expect(fileBytesContainMarker()).toBe(false);
});

it("restores the connection's secure_delete setting after a delete", () => {
  const before: unknown = db.$client.pragma("secure_delete", { simple: true });
  setPluginKvValue(db, "connect", "credential", JSON.stringify(MARKER));
  deletePluginKvValue(db, "connect", "credential");

  expect(db.$client.pragma("secure_delete", { simple: true })).toBe(before);
});
