import { closeSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { RelayLogger } from "./contracts.js";

export const BACKUP_DIRECTORY = "backups";

export const BACKUP_KEEP = 7;

export const BACKUP_HOUR_UTC = 4;

export const BACKUP_MINUTE_UTC = 15;

export const BACKUP_PUSH_TIMEOUT_MS = 10_000;

export const BACKUP_FILE_PATTERN = /^relay-\d{8}T\d{6}Z\.sqlite$/u;

const DAY_MS = 24 * 60 * 60 * 1000;

export const BACKUP_MAX_AGE_MS = BACKUP_KEEP * DAY_MS;

const BACKUP_TIMESTAMP =
  /^relay-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite$/u;

const BACKUP_DIRECTORY_MODE = 0o700;

const BACKUP_FILE_MODE = 0o600;

const INTEGRITY_OK = "ok";

export class RelayBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayBackupError";
  }
}

export interface RelayBackupOptions {
  sqlite: Database.Database;
  directory: string;
  now: number;
  keep?: number;
  checkIntegrity?: (path: string) => unknown;
  truncateWal?: boolean;
}

export function backupFileName(now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .slice(0, 19)
    .replaceAll(/[-:]/gu, "");

  return `relay-${stamp}Z.sqlite`;
}

export function checkBackupIntegrity(path: string): unknown {
  const copy = new Database(path, { readonly: true, fileMustExist: true });

  try {
    return copy.pragma("integrity_check", { simple: true });
  } finally {
    copy.close();
  }
}

function removeOlderBackups(
  directory: string,
  created: string,
  keep: number,
): void {
  const older = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== created &&
        BACKUP_FILE_PATTERN.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const name of older.slice(Math.max(keep - 1, 0))) {
    rmSync(join(directory, name), { force: true });
  }
}

function backupTakenAt(name: string): number | null {
  const parts = BACKUP_TIMESTAMP.exec(name)?.slice(1).map(Number);

  if (parts === undefined) return null;

  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] =
    parts;

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function isMissingDirectory(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function removeExpiredBackups(directory: string, now: number): number {
  let names: string[];

  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingDirectory(error)) return 0;
    throw error;
  }

  let removed = 0;

  for (const name of names) {
    const takenAt = backupTakenAt(name);

    if (takenAt === null || now - takenAt < BACKUP_MAX_AGE_MS) continue;
    rmSync(join(directory, name), { force: true });
    removed += 1;
  }

  return removed;
}

function pruneExpiredBackups(
  options: Pick<NightlyBackupOptions, "directory" | "log" | "now">,
): void {
  try {
    const removed = removeExpiredBackups(options.directory, options.now());

    if (removed > 0) {
      options.log.info("backup.expired_removed", { count: removed });
    }
  } catch (error) {
    options.log.error("backup.prune_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export function createRelayBackup(options: RelayBackupOptions): string {
  const { sqlite, directory } = options;
  const checkIntegrity = options.checkIntegrity ?? checkBackupIntegrity;
  mkdirSync(directory, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
  const file = backupFileName(options.now);
  const path = join(directory, file);
  closeSync(openSync(path, "wx", BACKUP_FILE_MODE));

  try {
    sqlite.prepare("VACUUM INTO ?").run(path);

    if (checkIntegrity(path) !== INTEGRITY_OK) {
      throw new RelayBackupError("The backup copy failed its integrity check");
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }

  removeOlderBackups(directory, file, options.keep ?? BACKUP_KEEP);

  if (options.truncateWal ?? true) sqlite.pragma("wal_checkpoint(TRUNCATE)");

  return file;
}

export function nextBackupAt(nowMs: number): number {
  const now = new Date(nowMs);

  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    BACKUP_HOUR_UTC,
    BACKUP_MINUTE_UTC,
  );

  return today > nowMs ? today : today + DAY_MS;
}

export function msUntilNextBackup(nowMs: number): number {
  return nextBackupAt(nowMs) - nowMs;
}

export interface NightlyBackupOptions {
  sqlite: Database.Database;
  directory: string;
  pushUrl: string | null;
  log: RelayLogger;
  now: () => number;
  fetch?: typeof globalThis.fetch;
}

async function pushBackupStatus(
  pushUrl: string,
  log: RelayLogger,
  fetchImpl: typeof globalThis.fetch,
): Promise<void> {
  try {
    const url = new URL(pushUrl);
    url.searchParams.set("status", "up");

    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(BACKUP_PUSH_TIMEOUT_MS),
    });

    await response.body?.cancel();

    if (!response.ok) {
      log.warn("backup.push_failed", { status: response.status });
    }
  } catch (error) {
    log.warn("backup.push_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

export async function runNightlyBackup(
  options: NightlyBackupOptions,
): Promise<void> {
  const { log } = options;
  let file: string;

  pruneExpiredBackups(options);

  try {
    file = createRelayBackup({
      sqlite: options.sqlite,
      directory: options.directory,
      now: options.now(),
    });
  } catch (error) {
    log.error("backup.failed", {
      error: error instanceof Error ? error.name : "unknown",
    });

    return;
  }

  log.info("backup.completed", { file });

  if (options.pushUrl !== null) {
    await pushBackupStatus(
      options.pushUrl,
      log,
      options.fetch ?? globalThis.fetch,
    );
  }
}

export function startBackupSchedule(options: NightlyBackupOptions): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let previousAt = Number.NEGATIVE_INFINITY;

  pruneExpiredBackups(options);

  function schedule(): void {
    const now = options.now();
    const at = nextBackupAt(Math.max(now, previousAt));
    previousAt = at;

    timer = setTimeout(() => {
      timer = null;
      void runNightlyBackup(options).finally(() => {
        if (!stopped) schedule();
      });
    }, at - now);

    timer.unref();
  }

  schedule();

  return () => {
    stopped = true;

    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
