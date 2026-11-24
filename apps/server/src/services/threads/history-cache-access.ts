import { createHash } from "node:crypto";
import type { DbConnection, HistoryCache } from "@omnyo/db";

const readers = new WeakMap<
  DbConnection,
  { cache: HistoryCache; sourceIdentity: string }
>();

export function attachHistoryCacheReader(
  db: DbConnection,
  cache: HistoryCache,
  sourceIdentity: string,
): void {
  readers.set(db, { cache, sourceIdentity });
}

export function readHistoryCache(db: DbConnection, key: string) {
  const reader = readers.get(db);

  return (
    reader?.cache.get({
      key,
      sourceIdentity: reader.sourceIdentity,
      now: Date.now(),
    }) ?? null
  );
}

export function historyRecordKey(
  kind: "outline" | "page",
  binding: string,
): string {
  return `${kind}:${createHash("sha256").update(binding).digest("hex")}`;
}
