import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  labelClaim,
  machine,
  machineRoutingKey,
  server,
  session,
} from "@omnyo/connect-db";
import { z } from "zod";
import type { RelayLogger, TunnelRegistry } from "../contracts.js";
import type { RelayDb } from "../db.js";
import {
  deleteUserRows,
  liftSuspension,
  restoreSuspension,
} from "../user-blocks.js";
import { sha256HexOf } from "./signed-token.js";

export const REVOKED_BY_OWNER_REASON = "revoked by owner";

export const REVOCATION_JOURNAL_FILE = "revocations.jsonl";

export const MAX_JOURNAL_LINE_BYTES = 64 * 1024;

const JOURNAL_READ_CHUNK_BYTES = 64 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

export const JOURNAL_RETENTION_MS = 30 * DAY_MS;

export const JOURNAL_RECORD_INTERVAL_MS = 15_000;

export const JOURNAL_COMPACT_INTERVAL_MS = 60 * 60 * 1000;

export const RETIREMENT_RECORD_OVERLAP_MS = 5 * 60 * 1000;

export const JOURNAL_LOCK_STALE_MS = 10_000;

const JOURNAL_LOCK_WAIT_MS = 10_000;

const JOURNAL_LOCK_RETRY_MS = 5;

export function revocationJournalPath(databasePath: string): string {
  return join(dirname(databasePath), REVOCATION_JOURNAL_FILE);
}

const entryFields = {
  v: z.literal(1),
  id: z.string().min(1),
  userId: z.string().min(1),
  at: z.number().int(),
};

const accountFields = {
  v: z.literal(1),
  githubId: z.string().min(1).nullable(),
  userId: z.string().min(1).nullable(),
  at: z.number().int(),
};

const journalEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow-share"), ...entryFields }),
  z.object({ kind: z.literal("machine"), ...entryFields }),
  z.object({
    kind: z.literal("server"),
    credentialHash: z.string().min(1).nullable().default(null),
    ...entryFields,
  }),
  z.object({
    kind: z.literal("user-block"),
    reason: z.string().nullable(),
    ...accountFields,
  }),
  z.object({ kind: z.literal("user-unblock"), ...accountFields }),
  z.object({
    kind: z.literal("user-delete"),
    ...accountFields,
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("label-retire"),
    v: z.literal(1),
    label: z.string().min(1),
    labelKind: z.string().min(1),
    githubId: z.string().min(1).nullable(),
    userId: z.string().min(1),
    at: z.number().int(),
  }),
]);

export type RevocationJournalEntry = z.infer<typeof journalEntrySchema>;

type Unversioned<Entry> = Entry extends unknown ? Omit<Entry, "v"> : never;

export type RevocationJournalInput = Unversioned<RevocationJournalEntry>;

export interface JournalCompaction {
  kept: number;
  dropped: number;
  size: number | null;
  nextExpiry: number | null;
}

export interface RevocationJournal {
  append(entry: RevocationJournalInput): void;
  read(): Generator<RevocationJournalEntry>;
  entries(): RevocationJournalEntry[];
  compact(keepFrom: number): JournalCompaction;
  size(): number | null;
}

export class RevocationJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevocationJournalError";
  }
}

type AccountEntry = Extract<
  RevocationJournalEntry,
  { kind: "user-block" | "user-unblock" }
>;

function accountKey(entry: AccountEntry): string | null {
  if (entry.githubId !== null) return `github:${entry.githubId}`;

  return entry.userId === null ? null : `user:${entry.userId}`;
}

function permanentEntryIndexes(
  entries: readonly RevocationJournalEntry[],
): Set<number> {
  const retired = new Map<string, { index: number; at: number }>();
  const accounts = new Map<string, number>();

  entries.forEach((entry, index) => {
    if (entry.kind === "label-retire") {
      const current = retired.get(entry.label);

      if (current === undefined || entry.at > current.at) {
        retired.set(entry.label, { index, at: entry.at });
      }
    } else if (entry.kind === "user-block" || entry.kind === "user-unblock") {
      const key = accountKey(entry);

      if (key !== null) accounts.set(key, index);
    }
  });

  return new Set([
    ...Array.from(retired.values(), ({ index }) => index),
    ...accounts.values(),
  ]);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function openForRead(path: string): number | null {
  try {
    return openSync(path, "r");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;

    throw error;
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;

    throw error;
  }
}

function removeLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

export function journalLockPath(path: string): string {
  return `${path}.lock`;
}

function withJournalLock<T>(path: string, act: () => T): T {
  const lockPath = journalLockPath(path);
  const deadline = Date.now() + JOURNAL_LOCK_WAIT_MS;
  let descriptor: number | null = null;

  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const age = lockAgeMs(lockPath);

      if (age !== null && age > JOURNAL_LOCK_STALE_MS) {
        removeLock(lockPath);
      } else if (Date.now() > deadline) {
        throw new RevocationJournalError(
          `${lockPath} is held by another writer`,
        );
      } else {
        pause(JOURNAL_LOCK_RETRY_MS);
      }
    }
  }

  try {
    return act();
  } finally {
    closeSync(descriptor);
    removeLock(lockPath);
  }
}

function writeFully(descriptor: number, data: Buffer): void {
  let offset = 0;

  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset);

    if (written <= 0) {
      throw new RevocationJournalError(
        `the journal accepted ${offset} of ${data.length} bytes`,
      );
    }

    offset += written;
  }
}

function endsWithNewline(descriptor: number): boolean {
  const size = fstatSync(descriptor).size;

  if (size === 0) return true;
  const last = Buffer.alloc(1);
  readSync(descriptor, last, 0, 1, size - 1);

  return last[0] === 0x0a;
}

function* journalLines(path: string): Generator<string> {
  const descriptor = openForRead(path);

  if (descriptor === null) return;

  try {
    const buffer = Buffer.allocUnsafe(JOURNAL_READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";

    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);

      if (read === 0) break;
      pending += decoder.write(buffer.subarray(0, read));
      let start = 0;
      let newline = pending.indexOf("\n", start);

      while (newline !== -1) {
        yield pending.slice(start, newline);
        start = newline + 1;
        newline = pending.indexOf("\n", start);
      }

      pending = pending.slice(start);

      if (pending.length > MAX_JOURNAL_LINE_BYTES) {
        throw new RevocationJournalError(
          `${path} has a line longer than ${MAX_JOURNAL_LINE_BYTES} bytes`,
        );
      }
    }

    pending += decoder.end();

    if (pending !== "") yield pending;
  } finally {
    closeSync(descriptor);
  }
}

function journalSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function createRevocationJournal(path: string): RevocationJournal {
  function* parsedLines(): Generator<{
    line: string;
    entry: RevocationJournalEntry;
  }> {
    let number = 0;

    for (const line of journalLines(path)) {
      number += 1;

      if (line.trim() === "") continue;
      let entry: RevocationJournalEntry;

      try {
        entry = journalEntrySchema.parse(JSON.parse(line));
      } catch {
        throw new RevocationJournalError(
          `${path} line ${number} is not a complete journal entry`,
        );
      }

      yield { line, entry };
    }
  }

  function* read(): Generator<RevocationJournalEntry> {
    for (const { entry } of parsedLines()) yield entry;
  }

  function compact(keepFrom: number): JournalCompaction {
    return withJournalLock(path, () => compactLocked(keepFrom));
  }

  function compactLocked(keepFrom: number): JournalCompaction {
    const size = journalSize(path);

    if (size === null) {
      return { kept: 0, dropped: 0, size: null, nextExpiry: null };
    }

    const lines = Array.from(parsedLines());

    const permanent = permanentEntryIndexes(lines.map(({ entry }) => entry));
    const kept: string[] = [];
    let dropped = 0;
    let nextExpiry: number | null = null;

    lines.forEach(({ line, entry }, index) => {
      if (entry.at < keepFrom && !permanent.has(index)) {
        dropped += 1;
      } else {
        kept.push(`${line}\n`);

        if (!permanent.has(index)) {
          nextExpiry = Math.min(nextExpiry ?? entry.at, entry.at);
        }
      }
    });

    if (dropped === 0) return { kept: kept.length, dropped, size, nextExpiry };
    const temporary = `${path}.compacting`;
    const descriptor = openSync(temporary, "w", 0o600);

    try {
      writeSync(descriptor, kept.join(""));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    if (journalSize(path) !== size) {
      unlinkSync(temporary);

      return {
        kept: kept.length + dropped,
        dropped: 0,
        size: null,
        nextExpiry: null,
      };
    }

    renameSync(temporary, path);

    return { kept: kept.length, dropped, size: journalSize(path), nextExpiry };
  }

  return {
    append(entry) {
      const line = `${JSON.stringify({ v: 1, ...entry })}\n`;

      withJournalLock(path, () => {
        const descriptor = openSync(path, "a+", 0o600);

        try {
          writeFully(
            descriptor,
            Buffer.from(endsWithNewline(descriptor) ? line : `\n${line}`),
          );
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      });
    },
    read,
    entries() {
      return Array.from(read());
    },
    compact,
    size: () => journalSize(path),
  };
}

export interface RevocationReplay {
  entries: number;
  applied: number;
  sessionsCleared: number;
}

export function replayRevocationJournal(
  db: RelayDb,
  journal: RevocationJournal,
): RevocationReplay {
  return db.transaction((tx) => {
    let entries = 0;
    let applied = 0;
    let revivedAccess = false;
    const accounts = new Map<string, AccountEntry>();

    for (const entry of journal.read()) {
      entries += 1;
      const at = new Date(entry.at);

      switch (entry.kind) {
        case "workflow-share": {
          applied += tx.run(
            sql`DELETE FROM relay_workflow_share WHERE id = ${entry.id} AND user_id = ${entry.userId}`,
          ).changes;
          break;
        }

        case "server": {
          const changes = tx
            .update(server)
            .set({ credentialHash: null, revokedAt: at })
            .where(
              and(
                eq(server.id, entry.id),
                isNull(server.revokedAt),
                entry.credentialHash === null
                  ? isNull(server.credentialHash)
                  : eq(server.credentialHash, entry.credentialHash),
              ),
            )
            .run().changes;

          applied += changes;
          revivedAccess ||= changes > 0;

          break;
        }

        case "machine": {
          const changes = tx
            .update(machine)
            .set({ revokedAt: at })
            .where(and(eq(machine.id, entry.id), isNull(machine.revokedAt)))
            .run().changes;

          applied += changes;
          revivedAccess ||= changes > 0;

          break;
        }

        case "user-block":
        case "user-unblock": {
          const key = accountKey(entry);

          if (key !== null) {
            accounts.delete(key);
            accounts.set(key, entry);
          }

          break;
        }

        case "user-delete": {
          if (
            deleteUserRows(tx, { userId: entry.userId, at: entry.at }).deleted
          ) {
            applied += 1;
            revivedAccess = true;
          }

          break;
        }

        case "label-retire": {
          applied += tx.run(
            sql`INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) VALUES (${entry.label}, ${entry.labelKind}, ${entry.githubId}, ${entry.userId}, ${entry.at}) ON CONFLICT (label) DO UPDATE SET github_id = COALESCE(relay_retired_label.github_id, excluded.github_id), user_id = excluded.user_id, retired_at = excluded.retired_at WHERE excluded.retired_at > relay_retired_label.retired_at`,
          ).changes;

          break;
        }
      }
    }

    for (const entry of accounts.values()) {
      if (entry.kind === "user-block") {
        if (restoreSuspension(tx, entry)) {
          applied += 1;
          revivedAccess = true;
        }
      } else if (liftSuspension(tx, entry)) {
        applied += 1;
      }
    }

    const sessionsCleared = revivedAccess
      ? tx.delete(session).run().changes
      : 0;

    return { entries, applied, sessionsCleared };
  });
}

interface RetiredLabelRow {
  label: string;
  kind: string;
  github_id: string | null;
  user_id: string;
  retired_at: number;
}

export function createRetirementRecorder(
  db: RelayDb,
  journal: RevocationJournal,
): () => number {
  const journaledAt = new Map<string, number>();

  for (const entry of journal.read()) {
    if (entry.kind === "label-retire") journaledAt.set(entry.label, entry.at);
  }

  let since = Number.NEGATIVE_INFINITY;
  let lastRowid = 0;

  return () => {
    const rows = db.all<RetiredLabelRow & { row_id: number }>(
      Number.isFinite(since)
        ? sql`SELECT rowid AS row_id, label, kind, github_id, user_id, retired_at FROM relay_retired_label WHERE rowid > ${lastRowid} OR retired_at >= ${since} ORDER BY rowid`
        : sql`SELECT rowid AS row_id, label, kind, github_id, user_id, retired_at FROM relay_retired_label ORDER BY rowid`,
    );

    let recorded = 0;
    let newest = Number.NEGATIVE_INFINITY;

    for (const row of rows) {
      newest = Math.max(newest, row.retired_at);
      lastRowid = Math.max(lastRowid, row.row_id);

      if (journaledAt.get(row.label) === row.retired_at) continue;
      journal.append({
        kind: "label-retire",
        label: row.label,
        labelKind: row.kind,
        githubId: row.github_id,
        userId: row.user_id,
        at: row.retired_at,
      });
      journaledAt.set(row.label, row.retired_at);
      recorded += 1;
    }

    if (Number.isFinite(newest)) {
      since = Math.max(since, newest - RETIREMENT_RECORD_OVERLAP_MS);
    }

    return recorded;
  };
}

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function startJournalMaintenance(input: {
  db: RelayDb;
  journal: RevocationJournal;
  log: RelayLogger;
  now: () => number;
}): () => void {
  const { journal, log, now } = input;
  const record = createRetirementRecorder(input.db, journal);

  const recordRetirements = () => {
    try {
      const recorded = record();

      if (recorded > 0) {
        log.info("relay.retirements_journaled", { count: recorded });
      }
    } catch (error) {
      log.error("relay.journal_record_failed", { error: failureName(error) });
    }
  };

  let compacted: JournalCompaction | null = null;

  const compact = () => {
    try {
      const keepFrom = now() - JOURNAL_RETENTION_MS;

      if (
        compacted !== null &&
        compacted.size !== null &&
        compacted.size === journal.size() &&
        (compacted.nextExpiry === null || compacted.nextExpiry >= keepFrom)
      ) {
        return;
      }

      const result = journal.compact(keepFrom);
      compacted = result;

      if (result.dropped > 0)
        log.info("relay.journal_compacted", {
          kept: result.kept,
          dropped: result.dropped,
        });
    } catch (error) {
      log.error("relay.journal_compact_failed", { error: failureName(error) });
    }
  };

  recordRetirements();
  compact();

  const recordTimer = setInterval(
    recordRetirements,
    JOURNAL_RECORD_INTERVAL_MS,
  );

  const compactTimer = setInterval(compact, JOURNAL_COMPACT_INTERVAL_MS);
  recordTimer.unref();
  compactTimer.unref();

  return () => {
    clearInterval(recordTimer);
    clearInterval(compactTimer);
    recordRetirements();
  };
}

export interface RevocationDeps {
  db: RelayDb;
  tunnels: TunnelRegistry;
  journal: RevocationJournal;
  now: () => number;
}

export function revokeMachine(
  deps: RevocationDeps,
  input: { userId: string; machineId: string },
): boolean {
  const at = deps.now();

  const revoked = deps.db
    .update(machine)
    .set({ revokedAt: new Date(at) })
    .where(
      and(
        eq(machine.id, input.machineId),
        eq(machine.userId, input.userId),
        isNull(machine.revokedAt),
      ),
    )
    .returning({ id: machine.id, subdomain: machine.subdomain })
    .get();

  if (revoked === undefined) return false;
  deps.journal.append({
    kind: "machine",
    id: revoked.id,
    userId: input.userId,
    at,
  });

  if (revoked.subdomain !== null) {
    const claim = deps.db
      .select({ generation: labelClaim.generation })
      .from(labelClaim)
      .where(
        and(
          eq(labelClaim.label, revoked.subdomain),
          eq(labelClaim.kind, "machine"),
          eq(labelClaim.ownerId, revoked.id),
        ),
      )
      .get();

    if (claim !== undefined) {
      deps.tunnels.close(
        machineRoutingKey(revoked.subdomain, claim.generation),
        REVOKED_BY_OWNER_REASON,
      );
    }
  }

  return true;
}

export function revokeServerByCredential(
  deps: RevocationDeps,
  credential: string,
): { serverId: string; subdomain: string } | null {
  const presented = credential.trim();

  if (presented === "") return null;
  const at = deps.now();

  const credentialHash = sha256HexOf(presented);

  const revoked = deps.db
    .update(server)
    .set({ credentialHash: null, revokedAt: new Date(at) })
    .where(
      and(eq(server.credentialHash, credentialHash), isNull(server.revokedAt)),
    )
    .returning({
      id: server.id,
      userId: server.userId,
      subdomain: server.subdomain,
    })
    .get();

  if (revoked === undefined) return null;
  deps.journal.append({
    kind: "server",
    id: revoked.id,
    userId: revoked.userId,
    credentialHash,
    at,
  });
  deps.tunnels.close(revoked.subdomain, REVOKED_BY_OWNER_REASON);

  return { serverId: revoked.id, subdomain: revoked.subdomain };
}
