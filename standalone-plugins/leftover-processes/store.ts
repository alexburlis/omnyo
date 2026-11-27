import { createCuaStore, CUA_MIGRATIONS } from "./cua-store";
import type { PluginApi } from "@omnyo/plugin-sdk";
import type { z } from "zod";
import {
  historyEntry,
  hostSnapshot,
  sweepStatus,
  type HistoryEntry,
  type HostSnapshot,
  type ObservedProcess,
  type ProcessIdentity,
  type SweepStatus,
} from "./contract";
import { identityKey, type CpuSample } from "./policy";

const HISTORY_LIMIT = 200;

const INSTALLED_AT_KEY = "installedAt";

const LAST_SWEEP_KEY = "lastSweep";

const MIGRATIONS = [
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE keeps (host_id TEXT NOT NULL, pid INTEGER NOT NULL, started_at TEXT NOT NULL, kept_at INTEGER NOT NULL, PRIMARY KEY (host_id, pid, started_at))",
  "CREATE TABLE samples (host_id TEXT NOT NULL, pid INTEGER NOT NULL, started_at TEXT NOT NULL, cpu_seconds REAL NOT NULL, sampled_at INTEGER NOT NULL, PRIMARY KEY (host_id, pid, started_at))",
  "CREATE TABLE snapshots (host_id TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)",
  ...CUA_MIGRATIONS,
];

function parseStored<T>(schema: z.ZodType<T>, value: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(value));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createStore(storage: PluginApi["storage"]) {
  const db = storage.database();

  storage.migrate(db, MIGRATIONS);

  const readMeta = db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?");

  const writeMeta = db.prepare<[string, string]>(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  const insertMetaOnce = db.prepare<[string, string]>(
    "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
  );

  const selectKeeps = db.prepare<[string], { pid: number; started_at: string }>(
    "SELECT pid, started_at FROM keeps WHERE host_id = ?",
  );

  const insertKeep = db.prepare<[string, number, string, number]>(
    "INSERT OR IGNORE INTO keeps (host_id, pid, started_at, kept_at) VALUES (?, ?, ?, ?)",
  );

  const deleteKeep = db.prepare<[string, number, string]>(
    "DELETE FROM keeps WHERE host_id = ? AND pid = ? AND started_at = ?",
  );

  const selectSamples = db.prepare<
    [string],
    { pid: number; started_at: string; cpu_seconds: number; sampled_at: number }
  >("SELECT pid, started_at, cpu_seconds, sampled_at FROM samples WHERE host_id = ?");

  const deleteSamples = db.prepare<[string]>("DELETE FROM samples WHERE host_id = ?");

  const insertSample = db.prepare<[string, number, string, number, number]>(
    "INSERT INTO samples (host_id, pid, started_at, cpu_seconds, sampled_at) VALUES (?, ?, ?, ?, ?)",
  );

  const upsertSnapshot = db.prepare<[string, string]>(
    "INSERT INTO snapshots (host_id, value) VALUES (?, ?) ON CONFLICT(host_id) DO UPDATE SET value = excluded.value",
  );

  const selectSnapshots = db.prepare<[], { value: string }>("SELECT value FROM snapshots");

  const selectSnapshot = db.prepare<[string], { value: string }>(
    "SELECT value FROM snapshots WHERE host_id = ?",
  );

  const selectSnapshotHosts = db.prepare<[], { host_id: string }>("SELECT host_id FROM snapshots");

  const deleteSnapshot = db.prepare<[string]>("DELETE FROM snapshots WHERE host_id = ?");

  const insertHistory = db.prepare<[string]>("INSERT INTO history (value) VALUES (?)");

  const trimHistory = db.prepare<[number]>(
    "DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?)",
  );

  const selectHistory = db.prepare<[number], { value: string }>(
    "SELECT value FROM history ORDER BY id DESC LIMIT ?",
  );

  const replaceSamplesInTransaction = db.transaction(
    (hostId: string, workloads: readonly ObservedProcess[], sampledAt: number) => {
      deleteSamples.run(hostId);

      for (const workload of workloads)
        insertSample.run(hostId, workload.pid, workload.startedAt, workload.cpuSeconds, sampledAt);
    },
  );

  const appendHistoryInTransaction = db.transaction((entries: readonly HistoryEntry[]) => {
    for (const entry of entries) insertHistory.run(JSON.stringify(entry));

    trimHistory.run(HISTORY_LIMIT);
  });

  function readKeeps(hostId: string): Set<string> {
    return new Set(
      selectKeeps
        .all(hostId)
        .map((row) => identityKey({ pid: row.pid, startedAt: row.started_at })),
    );
  }

  return {
    cua: createCuaStore(db),
    installedAt(now: number): number {
      insertMetaOnce.run(INSTALLED_AT_KEY, String(now));

      return Number(readMeta.get(INSTALLED_AT_KEY)?.value ?? now);
    },
    readKeeps,
    addKeep(hostId: string, identity: ProcessIdentity, keptAt: number): void {
      insertKeep.run(hostId, identity.pid, identity.startedAt, keptAt);
    },
    removeKeep(hostId: string, identity: ProcessIdentity): void {
      deleteKeep.run(hostId, identity.pid, identity.startedAt);
    },
    pruneKeeps(hostId: string, live: readonly ObservedProcess[]): void {
      const liveKeys = new Set(live.map(identityKey));

      for (const row of selectKeeps.all(hostId)) {
        if (!liveKeys.has(identityKey({ pid: row.pid, startedAt: row.started_at })))
          deleteKeep.run(hostId, row.pid, row.started_at);
      }
    },
    readSamples(hostId: string): Map<string, CpuSample> {
      return new Map(
        selectSamples
          .all(hostId)
          .map((row) => [
            identityKey({ pid: row.pid, startedAt: row.started_at }),
            { cpuSeconds: row.cpu_seconds, sampledAt: row.sampled_at },
          ]),
      );
    },
    replaceSamples(hostId: string, workloads: readonly ObservedProcess[], sampledAt: number): void {
      replaceSamplesInTransaction(hostId, workloads, sampledAt);
    },
    saveSnapshot(snapshot: HostSnapshot): void {
      upsertSnapshot.run(snapshot.hostId, JSON.stringify(snapshot));
    },
    readSnapshot(hostId: string): HostSnapshot | null {
      const row = selectSnapshot.get(hostId);

      return row === undefined ? null : parseStored(hostSnapshot, row.value);
    },
    readSnapshots(): HostSnapshot[] {
      return selectSnapshots.all().flatMap((row) => {
        const snapshot = parseStored(hostSnapshot, row.value);

        return snapshot === null ? [] : [snapshot];
      });
    },
    retainSnapshots(hostIds: ReadonlySet<string>): void {
      for (const row of selectSnapshotHosts.all()) {
        if (!hostIds.has(row.host_id)) deleteSnapshot.run(row.host_id);
      }
    },
    appendHistory(entries: readonly HistoryEntry[]): void {
      appendHistoryInTransaction(entries);
    },
    readHistory(limit: number): HistoryEntry[] {
      return selectHistory.all(limit).flatMap((row) => {
        const entry = parseStored(historyEntry, row.value);

        return entry === null ? [] : [entry];
      });
    },
    saveLastSweep(status: SweepStatus): void {
      writeMeta.run(LAST_SWEEP_KEY, JSON.stringify(status));
    },
    readLastSweep(): SweepStatus | null {
      const row = readMeta.get(LAST_SWEEP_KEY);

      return row === undefined ? null : parseStored(sweepStatus, row.value);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
