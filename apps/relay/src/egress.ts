import type Database from "better-sqlite3";
import { z } from "zod";
import type { EgressCounter, EgressUsage } from "./contracts.js";

export const EGRESS_FLUSH_INTERVAL_MS = 60_000;

const storedRowSchema = z.object({
  user_id: z.string(),
  bytes: z.number().int().nonnegative(),
});

export function utcMonth(at: number): string {
  const date = new Date(at);

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextUtcMonthStart(at: number): Date {
  const date = new Date(at);

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export interface EgressCounterOptions {
  sqlite: Database.Database;
  capBytes: number;
  now?: () => number;
}

export function createEgressCounter(
  options: EgressCounterOptions,
): EgressCounter {
  const { sqlite, capBytes } = options;
  const now = options.now ?? Date.now;

  if (!Number.isInteger(capBytes) || capBytes <= 0) {
    throw new Error("The egress cap must be a positive whole number of bytes");
  }

  const select = sqlite.prepare(
    "SELECT user_id, bytes FROM relay_egress_month WHERE month = ?",
  );

  const upsert = sqlite.prepare(
    "INSERT INTO relay_egress_month (user_id, month, bytes) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM user WHERE id = ?) ON CONFLICT (user_id, month) DO UPDATE SET bytes = excluded.bytes",
  );

  function load(month: string): Map<string, number> {
    const rows = z.array(storedRowSchema).parse(select.all(month));

    return new Map(rows.map((row) => [row.user_id, row.bytes]));
  }

  let month = utcMonth(now());
  let totals = load(month);
  let dirty = new Set<string>();

  const writeDirty = sqlite.transaction(
    (targetMonth: string, users: readonly string[]) => {
      for (const userId of users) {
        upsert.run(userId, targetMonth, totals.get(userId) ?? 0, userId);
      }
    },
  );

  function flush(): void {
    if (dirty.size === 0) return;
    const users = [...dirty];
    writeDirty(month, users);
    dirty = new Set();
  }

  function current(): void {
    const at = utcMonth(now());

    if (at === month) return;
    flush();
    month = at;
    totals = load(month);
  }

  function usage(userId: string): EgressUsage {
    current();

    return {
      userId,
      month,
      bytes: totals.get(userId) ?? 0,
      capBytes,
      resetsAt: nextUtcMonthStart(now()),
    };
  }

  return {
    add(userId, bytes) {
      if (!Number.isInteger(bytes) || bytes < 0) {
        throw new Error("Egress byte counts must be non-negative integers");
      }

      if (bytes === 0) return;
      current();
      totals.set(userId, (totals.get(userId) ?? 0) + bytes);
      dirty.add(userId);
    },
    isOverCap(userId) {
      return usage(userId).bytes > capBytes;
    },
    usage,
    flush() {
      current();
      flush();
    },
  };
}
