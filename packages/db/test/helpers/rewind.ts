import type { DbConnection } from "../../src/index.js";

export function dropPluginEnabledFollowsDefaultColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugins)")
    .all();

  if (columns.some((column) => column.name === "enabled_follows_default")) {
    db.$client.exec("ALTER TABLE plugins DROP COLUMN enabled_follows_default");
  }
}

export function rewindThreadPruningWork(db: DbConnection): void {
  db.$client.exec(`
    DROP TRIGGER IF EXISTS timeline_history_thread_insert;
    DROP TRIGGER IF EXISTS timeline_history_event_replacement;
    DROP TRIGGER IF EXISTS timeline_history_event_insert;
    DROP TRIGGER IF EXISTS timeline_history_event_update;
    DROP TRIGGER IF EXISTS timeline_history_event_delete;
    DROP INDEX IF EXISTS events_thread_accepted_client_request_idx;
    DROP TABLE IF EXISTS thread_timeline_records;
    DROP TABLE IF EXISTS thread_history_epochs;
    DROP TABLE IF EXISTS server_access_retirements;
    DROP TABLE IF EXISTS thread_pruning_work;
    DELETE FROM __drizzle_migrations WHERE created_at >= 1791399370294;
  `);

  dropReplayCreatedTables(db);
  dropThreadLastMessageAtColumn(db);
  dropHostAvailabilityColumn(db);

  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(thread_pruning_cursors)")
    .all();

  if (columns.some((column) => column.name === "work_revision"))
    db.$client.exec(
      "ALTER TABLE thread_pruning_cursors DROP COLUMN work_revision",
    );
}

export function dropIdleLifecycleIndexes(db: DbConnection): void {
  for (const name of [
    "hosts_pending_provider_idx",
    "threads_deleted_cleanup_idx",
  ]) {
    db.$client.exec(`DROP INDEX IF EXISTS ${name}`);
  }
}

export function dropQueuedMessageEditHeldUntilColumn(db: DbConnection): void {
  dropQueuedMessageCoalesceColumns(db);

  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all();

  if (columns.some((column) => column.name === "edit_held_until")) {
    db.$client.exec(
      "ALTER TABLE queued_thread_messages DROP COLUMN edit_held_until",
    );
  }
}

export function dropQueuedMessageCoalesceColumns(db: DbConnection): void {
  db.$client.exec("DROP INDEX IF EXISTS queued_thread_messages_coalesce_idx");

  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all();

  for (const name of ["coalesce_state", "coalesce_key"]) {
    if (columns.some((column) => column.name === name))
      db.$client.exec(`ALTER TABLE queued_thread_messages DROP COLUMN ${name}`);
  }
}

export function dropMarketplaceSourceGitSubdirectoryColumn(
  db: DbConnection,
): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugin_marketplaces)")
    .all();

  if (columns.some((column) => column.name === "source_git_subdirectory")) {
    db.$client.exec(
      "ALTER TABLE plugin_marketplaces DROP COLUMN source_git_subdirectory",
    );
  }
}

export function dropThreadLastMessageAtColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(threads)")
    .all();

  if (columns.some((column) => column.name === "last_message_at")) {
    db.$client.exec("ALTER TABLE threads DROP COLUMN last_message_at");
  }
}

export function dropHostAvailabilityColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(hosts)")
    .all();

  if (columns.some((column) => column.name === "availability")) {
    db.$client.exec("ALTER TABLE hosts DROP COLUMN availability");
  }
}

export function dropProjectCustomIconColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(projects)")
    .all();

  if (columns.some((column) => column.name === "custom_icon")) {
    db.$client.exec("ALTER TABLE projects DROP COLUMN custom_icon");
  }
}

export function dropPluginArtifactBundledRootDirColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugin_artifacts)")
    .all();

  if (columns.some((column) => column.name === "bundled_root_dir")) {
    db.$client.exec(
      "ALTER TABLE plugin_artifacts DROP COLUMN bundled_root_dir",
    );
  }
}

export function dropQueuedMessageDeliveryModeColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all();

  if (columns.some((column) => column.name === "delivery_mode")) {
    db.$client.exec(
      "ALTER TABLE queued_thread_messages DROP COLUMN delivery_mode",
    );
  }
}

export function rewindInboxStateMigration(db: DbConnection): void {
  db.$client.exec(`
    DROP TABLE IF EXISTS thread_wait_conditions;
    DROP TABLE IF EXISTS thread_wait_results;
    DROP TABLE IF EXISTS thread_waits;
    DROP TABLE IF EXISTS thread_turn_marks;
    DROP TABLE IF EXISTS thread_receipts;
    DROP TABLE IF EXISTS thread_producers;
    DROP TABLE IF EXISTS thread_owner_inputs;
    DROP TABLE IF EXISTS thread_moves;
    DROP TABLE IF EXISTS thread_failures;
  `);

  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugin_state_snapshots)")
    .all();

  if (columns.some((column) => column.name === "rollback_core_version")) {
    db.$client.exec(
      "ALTER TABLE plugin_state_snapshots RENAME COLUMN rollback_core_version TO rollback_bb_version",
    );
  }
}

export function dropThreadLaunchedByColumn(db: DbConnection): void {
  db.$client.exec("DROP INDEX IF EXISTS threads_launched_by_idx");

  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(threads)")
    .all();

  if (columns.some((column) => column.name === "launched_by_thread_id"))
    db.$client.exec("ALTER TABLE threads DROP COLUMN launched_by_thread_id");
}

export function dropQueuedMessageOverridesFailureColumn(
  db: DbConnection,
): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all();

  if (columns.some((column) => column.name === "overrides_failure_id")) {
    db.$client.exec(
      "ALTER TABLE queued_thread_messages DROP COLUMN overrides_failure_id",
    );
  }
}

export function dropThreadStatusChangedAtColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(threads)")
    .all();

  if (columns.some((column) => column.name === "status_changed_at")) {
    db.$client.exec("ALTER TABLE threads DROP COLUMN status_changed_at");
  }
}

export function dropThreadShelfSortKeyColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(threads)")
    .all();

  if (columns.some((column) => column.name === "shelf_sort_key")) {
    db.$client.exec("ALTER TABLE threads DROP COLUMN shelf_sort_key");
  }
}

export function dropNativeThreadImportsTable(db: DbConnection): void {
  db.$client.exec("DROP TABLE IF EXISTS native_thread_imports");
}

export function dropReplayCreatedTables(db: DbConnection): void {
  dropThreadShelfSortKeyColumn(db);
  dropThreadStatusChangedAtColumn(db);
  dropNativeThreadImportsTable(db);
  dropQueuedMessageOverridesFailureColumn(db);
  dropThreadLaunchedByColumn(db);
  rewindInboxStateMigration(db);
  dropQueuedMessageCoalesceColumns(db);
  dropQueuedMessageDeliveryModeColumn(db);
  dropProjectCustomIconColumn(db);
  dropPluginArtifactBundledRootDirColumn(db);
  db.$client.exec(`
    DROP TABLE IF EXISTS managed_previews;
    DROP TABLE IF EXISTS thread_questions;
    DROP TABLE IF EXISTS thread_callbacks;
    DROP TABLE IF EXISTS thread_attention_imports;
    DROP TABLE IF EXISTS daemon_event_receipts;
    DROP INDEX IF EXISTS threads_shelf_sort_idx;
  `);

  const threadColumns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(threads)")
    .all();

  if (threadColumns.some((column) => column.name === "shelved_at"))
    db.$client.exec("ALTER TABLE threads DROP COLUMN shelved_at");
}
