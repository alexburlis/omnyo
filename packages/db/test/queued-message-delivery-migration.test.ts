import { expect, it } from "vitest";
import {
  dropQueuedMessageCoalesceColumns,
  dropQueuedMessageOverridesFailureColumn,
  dropThreadLaunchedByColumn,
  dropNativeThreadImportsTable,
  dropThreadShelfSortKeyColumn,
  dropThreadStatusChangedAtColumn,
  rewindInboxStateMigration,
} from "./helpers/rewind.js";
import {
  createConnection,
  createProject,
  createQueuedThreadMessageInTransaction,
  createThread,
  getQueuedThreadMessage,
  migrate,
  noopNotifier,
  upsertHost,
} from "../src/index.js";

it("upgrades legacy queued messages with steer intent while preserving their payload", () => {
  const db = createConnection(":memory:");

  try {
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "delivery-migration" });

    const { project } = createProject(db, noopNotifier, {
      name: "delivery-migration",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/delivery-migration",
      },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const row = db.transaction((tx) =>
      createQueuedThreadMessageInTransaction(tx, {
        threadId: thread.id,
        content: [{ type: "text", text: "Keep this message", mentions: [] }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "time" },
        sendAt: 1_800_000_000_000,
        payload: { kind: "inline" },
        systemNotice: null,
      }),
    );

    db.$client.exec(
      "ALTER TABLE queued_thread_messages DROP COLUMN delivery_mode",
    );
    dropQueuedMessageCoalesceColumns(db);
    rewindInboxStateMigration(db);
    dropThreadLaunchedByColumn(db);
    dropQueuedMessageOverridesFailureColumn(db);
    dropThreadShelfSortKeyColumn(db);
    dropThreadStatusChangedAtColumn(db);
    dropNativeThreadImportsTable(db);
    db.$client.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at >= 1793617438585",
    );
    migrate(db);
    expect(getQueuedThreadMessage(db, row.id)).toEqual({
      ...row,
      deliveryMode: "steer",
    });
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    migrate(db);
    expect(getQueuedThreadMessage(db, row.id)).toEqual({
      ...row,
      deliveryMode: "steer",
    });
  } finally {
    db.$client.close();
  }
});
