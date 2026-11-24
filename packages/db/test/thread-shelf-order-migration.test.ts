import { expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
} from "../src/index.js";
import { dropThreadShelfSortKeyColumn } from "./helpers/rewind.js";

const MIGRATION_CREATED_AT = 1794756731604;

it("orders existing Shelf families newest shelved first and keeps each family together", () => {
  const db = createConnection(":memory:");

  try {
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "shelf-order" });

    const { project } = createProject(db, noopNotifier, {
      name: "shelf-order",
      source: { type: "local_path", hostId: host.id, path: "/tmp/shelf-order" },
    });

    const create = (parentThreadId?: string) =>
      createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        ...(parentThreadId ? { parentThreadId } : {}),
      }).id;

    const oldest = create();
    const oldestChild = create(oldest);
    const newest = create();
    const middle = create();
    const active = create();

    const setShelvedAt = db.$client.prepare(
      "UPDATE threads SET shelved_at = ? WHERE id = ?",
    );

    for (const [id, shelvedAt] of [
      [oldest, 10],
      [oldestChild, 10],
      [newest, 30],
      [middle, 20],
    ] as const)
      setShelvedAt.run(shelvedAt, id);

    dropThreadShelfSortKeyColumn(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(MIGRATION_CREATED_AT);
    migrate(db);

    const keys = new Map(
      db.$client
        .prepare<[], { id: string; key: string | null }>(
          "SELECT id, shelf_sort_key AS key FROM threads",
        )
        .all()
        .map((row) => [row.id, row.key]),
    );

    expect(keys.get(newest)).toBe("V00000001");
    expect(keys.get(middle)).toBe("V00000002");
    expect(keys.get(oldest)).toBe("V00000003");
    expect(keys.get(oldestChild)).toBe("V00000003");
    expect(keys.get(active)).toBeNull();
  } finally {
    db.$client.close();
  }
});
