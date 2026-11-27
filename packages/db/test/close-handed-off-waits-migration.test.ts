import { expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
} from "../src/index.js";
import {
  dropPostShelfMigrationArtifacts,
  dropNativeThreadImportsTable,
  dropThreadShelfSortKeyColumn,
  dropThreadStatusChangedAtColumn,
} from "./helpers/rewind.js";

const MIGRATION_CREATED_AT = 1794403489168;

it("closes only dispatched waits whose woken turn completed with a follow-up wait", () => {
  const db = createConnection(":memory:");

  try {
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "handed-off-waits" });

    const { project } = createProject(db, noopNotifier, {
      name: "handed-off-waits",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/handed-off-waits",
      },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const insertWait = db.$client.prepare(
      `INSERT INTO thread_waits (id, thread_id, key, generation, kind, status, readiness, created_by, owner_accepted, for_text, marker, chain_start_at, check_count, covers_receipt_ids, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'check', ?, 'all', 'agent', 0, ?, ?, 1, 0, '[]', 1, 1)`,
    );

    const insertMark = db.$client.prepare(
      `INSERT INTO thread_turn_marks (thread_id, turn_id, wait_id, wait_generation, evaluation, rearmed, after_wait_id, ended_owner_wait_ids, created_at, ended_at, ended_outcome)
       VALUES (?, ?, ?, 1, 0, ?, ?, '[]', 1, ?, ?)`,
    );

    for (const [id, status] of [
      ["handed-off", "dispatched"],
      ["follow-up", "live"],
      ["running", "dispatched"],
      ["failed", "dispatched"],
      ["rearmed", "evaluating"],
      ["unmarked", "dispatched"],
    ] as const)
      insertWait.run(id, thread.id, id, status, id, `[omnyo wait ${id}]`);

    insertMark.run(
      thread.id,
      "turn-1",
      "handed-off",
      0,
      "follow-up",
      2,
      "completed",
    );
    insertMark.run(thread.id, "turn-2", "running", 0, "follow-up", null, null);
    insertMark.run(thread.id, "turn-3", "failed", 0, "follow-up", 2, "failed");
    insertMark.run(
      thread.id,
      "turn-4",
      "rearmed",
      1,
      "follow-up",
      2,
      "completed",
    );

    dropPostShelfMigrationArtifacts(db);
    dropThreadShelfSortKeyColumn(db);
    dropThreadStatusChangedAtColumn(db);
    dropNativeThreadImportsTable(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(MIGRATION_CREATED_AT);
    migrate(db);

    const rows = db.$client
      .prepare(
        "SELECT id, status, closed_reason AS closedReason, closed_at IS NOT NULL AS closed FROM thread_waits ORDER BY id",
      )
      .all();

    expect(rows).toEqual([
      { id: "failed", status: "dispatched", closedReason: null, closed: 0 },
      { id: "follow-up", status: "live", closedReason: null, closed: 0 },
      {
        id: "handed-off",
        status: "closed",
        closedReason: "continued",
        closed: 1,
      },
      { id: "rearmed", status: "evaluating", closedReason: null, closed: 0 },
      { id: "running", status: "dispatched", closedReason: null, closed: 0 },
      { id: "unmarked", status: "dispatched", closedReason: null, closed: 0 },
    ]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.$client.close();
  }
});
