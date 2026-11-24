import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import { coordinatorStore, submissionReceipts } from "../schema.js";

type SubmissionReceiptConnection = DbConnection | DbTransaction;

export type SubmissionReceiptRow = typeof submissionReceipts.$inferSelect;

export interface SubmissionReceiptKey {
  actorKey: string;
  submissionId: string;
}

const COORDINATOR_STORE_SINGLETON = 1;

export function ensureCoordinatorStoreId(db: DbConnection): string {
  return db.transaction(
    (tx) => {
      const existing = readCoordinatorStoreId(tx);

      if (existing !== null) {
        return existing;
      }

      const storeId = `store_${randomUUID()}`;

      tx.insert(coordinatorStore)
        .values({
          singleton: COORDINATOR_STORE_SINGLETON,
          storeId,
          createdAt: Date.now(),
        })
        .run();

      return storeId;
    },
    { behavior: "immediate" },
  );
}

export function readCoordinatorStoreId(
  db: SubmissionReceiptConnection,
): string | null {
  return (
    db
      .select({ storeId: coordinatorStore.storeId })
      .from(coordinatorStore)
      .where(eq(coordinatorStore.singleton, COORDINATOR_STORE_SINGLETON))
      .get()?.storeId ?? null
  );
}

export function findSubmissionReceipt(
  db: SubmissionReceiptConnection,
  key: SubmissionReceiptKey,
): SubmissionReceiptRow | null {
  return (
    db
      .select()
      .from(submissionReceipts)
      .where(
        and(
          eq(submissionReceipts.actorKey, key.actorKey),
          eq(submissionReceipts.submissionId, key.submissionId),
        ),
      )
      .get() ?? null
  );
}

export function insertSubmissionReceipt(
  tx: DbTransaction,
  row: SubmissionReceiptRow,
): void {
  tx.insert(submissionReceipts).values(row).run();
}
