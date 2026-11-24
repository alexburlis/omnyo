import { eq, and } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { managedPreviews } from "../schema.js";

export type ManagedPreviewRow = typeof managedPreviews.$inferSelect;

export function getManagedPreview(
  db: DbConnection,
  id: string,
): ManagedPreviewRow | undefined {
  return db
    .select()
    .from(managedPreviews)
    .where(eq(managedPreviews.id, id))
    .get();
}

export function listManagedPreviews(
  db: DbConnection,
  environmentId: string,
): ManagedPreviewRow[] {
  return db
    .select()
    .from(managedPreviews)
    .where(eq(managedPreviews.environmentId, environmentId))
    .all();
}

export function findManagedPreview(
  db: DbConnection,
  environmentId: string,
  endpoint: string,
): ManagedPreviewRow | undefined {
  return db
    .select()
    .from(managedPreviews)
    .where(
      and(
        eq(managedPreviews.environmentId, environmentId),
        eq(managedPreviews.endpoint, endpoint),
      ),
    )
    .get();
}

export function insertManagedPreview(
  db: DbConnection,
  input: ManagedPreviewRow,
): ManagedPreviewRow {
  return db.insert(managedPreviews).values(input).returning().get();
}

export function deleteManagedPreview(db: DbConnection, id: string): boolean {
  return (
    db
      .delete(managedPreviews)
      .where(eq(managedPreviews.id, id))
      .returning({ id: managedPreviews.id })
      .all().length > 0
  );
}
