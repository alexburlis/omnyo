import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { THREAD_CONTEXT_CLEAR_OPERATION } from "@omnyo/domain";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import {
  environments,
  events,
  nativeThreadImports,
  threads,
} from "../schema.js";

const THREAD_EDIT_MESSAGE_OPERATION = "edit_message";

export type NativeThreadImportRow = typeof nativeThreadImports.$inferSelect;

export interface NativeThreadImportSourceKey {
  hostId: string;
  providerId: string;
  sourceProviderThreadId: string;
}

export type NewNativeThreadImport = Omit<NativeThreadImportRow, "threadId">;

export type NativeSessionClaimVia = "import" | "identity";

export interface NativeSessionClaim {
  sourceProviderThreadId: string;
  threadId: string;
  via: NativeSessionClaimVia;
}

export class NativeThreadImportConflictError extends Error {
  constructor() {
    super("This native session is already imported");
    this.name = "NativeThreadImportConflictError";
  }
}

function sourceKeyWhere(key: NativeThreadImportSourceKey) {
  return and(
    eq(nativeThreadImports.hostId, key.hostId),
    eq(nativeThreadImports.providerId, key.providerId),
    eq(nativeThreadImports.sourceProviderThreadId, key.sourceProviderThreadId),
  );
}

export function insertNativeThreadImportInTransaction(
  tx: DbTransaction,
  args: { threadId: string; source: NewNativeThreadImport },
): void {
  tx.delete(nativeThreadImports)
    .where(
      and(
        sourceKeyWhere(args.source),
        inArray(
          nativeThreadImports.threadId,
          tx
            .select({ id: threads.id })
            .from(threads)
            .where(isNotNull(threads.deletedAt)),
        ),
      ),
    )
    .run();

  const inserted = tx
    .insert(nativeThreadImports)
    .values({ ...args.source, threadId: args.threadId })
    .onConflictDoNothing()
    .returning({ threadId: nativeThreadImports.threadId })
    .get();

  if (inserted === undefined) {
    throw new NativeThreadImportConflictError();
  }
}

export function deleteNativeThreadImport(
  db: DbQueryConnection,
  threadId: string,
): void {
  db.delete(nativeThreadImports)
    .where(eq(nativeThreadImports.threadId, threadId))
    .run();
}

export function getNativeThreadImport(
  db: DbQueryConnection,
  threadId: string,
): NativeThreadImportRow | null {
  return (
    db
      .select()
      .from(nativeThreadImports)
      .where(eq(nativeThreadImports.threadId, threadId))
      .get() ?? null
  );
}

export function getNativeThreadImportBySource(
  db: DbQueryConnection,
  key: NativeThreadImportSourceKey,
): NativeThreadImportRow | null {
  return (
    db
      .select(getNativeThreadImportColumns())
      .from(nativeThreadImports)
      .innerJoin(threads, eq(threads.id, nativeThreadImports.threadId))
      .where(and(sourceKeyWhere(key), isNull(threads.deletedAt)))
      .get() ?? null
  );
}

function getNativeThreadImportColumns() {
  return {
    threadId: nativeThreadImports.threadId,
    hostId: nativeThreadImports.hostId,
    providerId: nativeThreadImports.providerId,
    sourceProviderThreadId: nativeThreadImports.sourceProviderThreadId,
    sourcePath: nativeThreadImports.sourcePath,
    importedAt: nativeThreadImports.importedAt,
  };
}

function listIdentityClaims(
  db: DbQueryConnection,
  args: {
    hostId: string;
    providerId: string;
    sourceProviderThreadId?: string;
  },
): NativeSessionClaim[] {
  const rows = db
    .select({
      sourceProviderThreadId: events.providerThreadId,
      threadId: events.threadId,
    })
    .from(events)
    .innerJoin(threads, eq(threads.id, events.threadId))
    .leftJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        eq(events.type, "thread/identity"),
        isNotNull(events.providerThreadId),
        args.sourceProviderThreadId === undefined
          ? undefined
          : eq(events.providerThreadId, args.sourceProviderThreadId),
        eq(threads.providerId, args.providerId),
        isNull(threads.deletedAt),
        or(isNull(environments.hostId), eq(environments.hostId, args.hostId)),
      ),
    )
    .orderBy(asc(events.createdAt), asc(events.threadId))
    .all();

  return rows.flatMap((row) =>
    row.sourceProviderThreadId === null || row.sourceProviderThreadId === ""
      ? []
      : [
          {
            sourceProviderThreadId: row.sourceProviderThreadId,
            threadId: row.threadId,
            via: "identity" as const,
          },
        ],
  );
}

function listImportClaims(
  db: DbQueryConnection,
  args: {
    hostId: string;
    providerId: string;
    sourceProviderThreadId?: string;
  },
): NativeSessionClaim[] {
  return db
    .select({
      sourceProviderThreadId: nativeThreadImports.sourceProviderThreadId,
      threadId: nativeThreadImports.threadId,
    })
    .from(nativeThreadImports)
    .innerJoin(threads, eq(threads.id, nativeThreadImports.threadId))
    .where(
      and(
        eq(nativeThreadImports.hostId, args.hostId),
        eq(nativeThreadImports.providerId, args.providerId),
        args.sourceProviderThreadId === undefined
          ? undefined
          : eq(
              nativeThreadImports.sourceProviderThreadId,
              args.sourceProviderThreadId,
            ),
        isNull(threads.deletedAt),
      ),
    )
    .orderBy(asc(nativeThreadImports.importedAt))
    .all()
    .map((row) => ({ ...row, via: "import" as const }));
}

export function listNativeSessionClaims(
  db: DbQueryConnection,
  args: { hostId: string; providerId: string },
): NativeSessionClaim[] {
  const claims = new Map<string, NativeSessionClaim>();

  for (const claim of [
    ...listImportClaims(db, args),
    ...listIdentityClaims(db, args),
  ]) {
    if (!claims.has(claim.sourceProviderThreadId)) {
      claims.set(claim.sourceProviderThreadId, claim);
    }
  }

  return [...claims.values()];
}

export function findNativeSessionClaim(
  db: DbQueryConnection,
  key: NativeThreadImportSourceKey,
): NativeSessionClaim | null {
  return listImportClaims(db, key)[0] ?? listIdentityClaims(db, key)[0] ?? null;
}

export function hasThreadNativeSessionHistory(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  const row = db
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        or(
          eq(events.type, "thread/identity"),
          and(
            eq(events.type, "system/operation"),
            sql`json_extract(${events.data}, '$.operation') IN (${THREAD_CONTEXT_CLEAR_OPERATION}, ${THREAD_EDIT_MESSAGE_OPERATION})`,
            sql`json_extract(${events.data}, '$.status') = 'completed'`,
          ),
        ),
      ),
    )
    .limit(1)
    .get();

  return row !== undefined;
}
