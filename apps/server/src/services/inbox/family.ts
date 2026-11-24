import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { threads, type DbQueryConnection } from "@omnyo/db";

export type InboxThreadRow = typeof threads.$inferSelect;

const MAX_DEPTH = 32;

export function getInboxThread(
  db: DbQueryConnection,
  threadId: string,
): InboxThreadRow | null {
  return (
    db.select().from(threads).where(eq(threads.id, threadId)).get() ?? null
  );
}

function parentOf(row: InboxThreadRow): string | null {
  return row.parentThreadId ?? row.lifecycleOwnerThreadId;
}

export function inboxRootOf(
  db: DbQueryConnection,
  threadId: string,
): InboxThreadRow | null {
  let current = getInboxThread(db, threadId);

  for (let depth = 0; current !== null && depth < MAX_DEPTH; depth += 1) {
    const up = parentOf(current);

    if (up === null) return current;

    const next = getInboxThread(db, up);

    if (next === null || next.deletedAt !== null) return current;

    current = next;
  }

  return current;
}

export function isInboxDomainRoot(row: InboxThreadRow): boolean {
  return (
    row.deletedAt === null &&
    row.visibility === "visible" &&
    row.parentThreadId === null &&
    row.lifecycleOwnerThreadId === null
  );
}

export function listFamilyThreads(
  db: DbQueryConnection,
  rootIds: readonly string[],
): Map<string, InboxThreadRow[]> {
  const families = new Map<string, InboxThreadRow[]>();
  const rootOf = new Map<string, string>();

  for (const rootId of rootIds) {
    families.set(rootId, []);
    rootOf.set(rootId, rootId);
  }

  let frontier = [...rootIds];

  for (let depth = 0; frontier.length > 0 && depth < MAX_DEPTH; depth += 1) {
    const children = db
      .select()
      .from(threads)
      .where(
        and(
          isNull(threads.deletedAt),
          or(
            inArray(threads.parentThreadId, frontier),
            inArray(threads.lifecycleOwnerThreadId, frontier),
          ),
        ),
      )
      .all();

    const next: string[] = [];

    for (const child of children) {
      if (rootOf.has(child.id)) continue;

      const up = parentOf(child);
      const rootId = up === null ? undefined : rootOf.get(up);

      if (rootId === undefined) continue;

      rootOf.set(child.id, rootId);
      families.get(rootId)?.push(child);
      next.push(child.id);
    }

    frontier = next;
  }

  return families;
}

export function familyIdsOf(db: DbQueryConnection, rootId: string): string[] {
  return [
    rootId,
    ...(listFamilyThreads(db, [rootId]).get(rootId) ?? []).map((row) => row.id),
  ];
}
