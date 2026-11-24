import { and, eq, ne, sql } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import { daemonEventReceipts } from "../schema.js";

type DaemonEventReceiptConnection = DbConnection | DbTransaction;

export interface DaemonEventReceiptKey {
  hostId: string;
  instanceId: string;
}

export interface RecordDaemonEventReceiptInput extends DaemonEventReceiptKey {
  lastEventIndex: number;
}

export function readDaemonEventReceiptIndex(
  db: DaemonEventReceiptConnection,
  key: DaemonEventReceiptKey,
): number {
  const row = db
    .select({ lastEventIndex: daemonEventReceipts.lastEventIndex })
    .from(daemonEventReceipts)
    .where(
      and(
        eq(daemonEventReceipts.hostId, key.hostId),
        eq(daemonEventReceipts.instanceId, key.instanceId),
      ),
    )
    .get();

  return row?.lastEventIndex ?? 0;
}

export function recordDaemonEventReceipt(
  db: DaemonEventReceiptConnection,
  input: RecordDaemonEventReceiptInput,
): void {
  const now = Date.now();

  db.insert(daemonEventReceipts)
    .values({
      hostId: input.hostId,
      instanceId: input.instanceId,
      lastEventIndex: input.lastEventIndex,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [daemonEventReceipts.hostId, daemonEventReceipts.instanceId],
      set: {
        lastEventIndex: sql`max(${daemonEventReceipts.lastEventIndex}, excluded.last_event_index)`,
        updatedAt: now,
      },
    })
    .run();
}

export function deleteDaemonEventReceiptsForOtherInstances(
  db: DaemonEventReceiptConnection,
  key: DaemonEventReceiptKey,
): void {
  db.delete(daemonEventReceipts)
    .where(
      and(
        eq(daemonEventReceipts.hostId, key.hostId),
        ne(daemonEventReceipts.instanceId, key.instanceId),
      ),
    )
    .run();
}
