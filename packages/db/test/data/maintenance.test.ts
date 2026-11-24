import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  environmentStatusValues,
  pendingInteractionStatusSchema,
  threadStatusValues,
} from "@omnyo/domain";
import { createConnection } from "../../src/connection.js";
import type { DbConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  DATABASE_INCREMENTAL_VACUUM_MIN_FREELIST_PAGES,
  dropDeferredLegacyTables,
  getDatabaseAutoVacuumMode,
  getDatabaseFreelistStats,
  getDatabaseMaintenanceActivity,
  isDatabaseMaintenanceIdle,
  listDeferredLegacyTables,
  runIncrementalVacuum,
  shouldRunIncrementalVacuum,
} from "../../src/data/maintenance.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject, markProjectDeleted } from "../../src/data/projects.js";
import { createThread, markThreadDeleted } from "../../src/data/threads.js";
import { createEnvironment } from "../../src/data/environments.js";
import { createPendingInteraction } from "../../src/data/pending-interactions.js";
import { pendingInteractions } from "../../src/schema.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const TEST_INCREMENTAL_VACUUM_MAX_PAGES = 128;

interface TempDatabasePath {
  dbPath: string;
  cleanup(): void;
}

interface ProjectNameRow {
  name: string;
}

const TEST_DEFERRED_LEGACY_TABLE_NAMES = [
  "client_turn_requests",
  "environment_operations",
  "host_daemon_command_attempts",
  "host_daemon_commands",
  "project_operations",
  "thread_operations",
];

function setup() {
  const db = createMigratedConnection();

  const host = upsertHost(db, noopNotifier, {
    name: "maintenance-host",
  });

  const { project } = createProject(db, noopNotifier, {
    name: "maintenance-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });

  return { db, host, project };
}

function createTempDatabasePath(): TempDatabasePath {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-db-maintenance-"));

  return {
    cleanup(): void {
      rmSync(dir, { force: true, recursive: true });
    },
    dbPath: join(dir, "app.db"),
  };
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createDeferredLegacyTables(db: DbConnection): void {
  for (const tableName of TEST_DEFERRED_LEGACY_TABLE_NAMES) {
    db.$client
      .prepare(
        `CREATE TABLE ${quoteSqlIdentifier(tableName)} (id TEXT PRIMARY KEY)`,
      )
      .run();
  }
}

function readProjectName(
  db: DbConnection,
  projectId: string,
): string | undefined {
  return db.$client
    .prepare<[string], ProjectNameRow>("SELECT name FROM projects WHERE id = ?")
    .get(projectId)?.name;
}

describe("database maintenance", () => {
  it("counts every maintenance blocker without treating deleted threads as live", () => {
    const { db, host, project } = setup();

    const zero = {
      activeEnvironmentProvisioningCount: 0,
      activePendingInteractionCount: 0,
      activeProjectDeletionCount: 0,
      activeThreadCount: 0,
      activeThreadProvisioningCount: 0,
    };

    try {
      expect(getDatabaseMaintenanceActivity(db)).toEqual(zero);
      expect(
        isDatabaseMaintenanceIdle(getDatabaseMaintenanceActivity(db)),
      ).toBe(true);

      const idleThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });

      for (const status of threadStatusValues.filter(
        (value) => value !== "idle",
      ))
        createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          status,
        });
      let deletedThreadId = "";

      for (const status of ["active", "starting"] as const) {
        const thread = createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          status,
        });

        markThreadDeleted(db, noopNotifier, { threadId: thread.id });
        deletedThreadId = thread.id;
      }

      for (const status of [
        ...environmentStatusValues,
        "provisioning",
      ] as const)
        createEnvironment(db, noopNotifier, {
          projectId: project.id,
          hostId: host.id,
          providerOwnsPath: false,
          status,
        });

      for (let index = 0; index < 2; index++) {
        const deletedProject = createProject(db, noopNotifier, {
          name: `deleted-${index}`,
          source: {
            type: "local_path",
            hostId: host.id,
            path: `/tmp/deleted-${index}`,
          },
        }).project;

        markProjectDeleted(db, noopNotifier, { projectId: deletedProject.id });
      }

      for (const status of pendingInteractionStatusSchema.options) {
        const interaction = createPendingInteraction(db, {
          originKind: "plugin",
          pluginId: "maintenance-test",
          rendererId: "inert",
          threadId: idleThread.id,
          turnId: null,
          payload: "{}",
        });

        db.update(pendingInteractions)
          .set({ status })
          .where(eq(pendingInteractions.id, interaction.id))
          .run();
      }

      createPendingInteraction(db, {
        originKind: "plugin",
        pluginId: "maintenance-test",
        rendererId: "inert",
        threadId: deletedThreadId,
        turnId: null,
        payload: "{}",
      });
      const activity = getDatabaseMaintenanceActivity(db);
      expect(activity).toEqual({
        activeEnvironmentProvisioningCount: 2,
        activePendingInteractionCount: 3,
        activeProjectDeletionCount: 2,
        activeThreadCount: 2,
        activeThreadProvisioningCount: 2,
      });
      expect(isDatabaseMaintenanceIdle(activity)).toBe(false);

      db.$client.exec(
        "UPDATE threads SET status = 'idle'; UPDATE projects SET deleted_at = NULL; UPDATE environments SET status = 'ready'; UPDATE pending_interactions SET status = 'resolved'",
      );
      expect(getDatabaseMaintenanceActivity(db)).toEqual(zero);
      expect(
        isDatabaseMaintenanceIdle(getDatabaseMaintenanceActivity(db)),
      ).toBe(true);
    } finally {
      db.$client.close();
    }
  });

  it("drops deferred legacy queue tables without touching current data", () => {
    const { db, project } = setup();
    createDeferredLegacyTables(db);
    expect(listDeferredLegacyTables(db)).toEqual(
      [...TEST_DEFERRED_LEGACY_TABLE_NAMES].sort(),
    );

    const result = dropDeferredLegacyTables(db);

    expect(result.droppedTables).toEqual(
      [...TEST_DEFERRED_LEGACY_TABLE_NAMES].sort(),
    );
    expect(listDeferredLegacyTables(db)).toEqual([]);
    expect(readProjectName(db, project.id)).toBe("maintenance-project");
  });

  it("keeps fresh file-backed databases in incremental auto-vacuum mode after reopen", () => {
    const tempDatabase = createTempDatabasePath();

    try {
      const db = createConnection(tempDatabase.dbPath);

      try {
        migrate(db);
        expect(getDatabaseAutoVacuumMode(db)).toBe("incremental");
      } finally {
        db.$client.close();
      }

      const reopenedDb = createConnection(tempDatabase.dbPath);

      try {
        migrate(reopenedDb);
        expect(getDatabaseAutoVacuumMode(reopenedDb)).toBe("incremental");
      } finally {
        reopenedDb.$client.close();
      }
    } finally {
      tempDatabase.cleanup();
    }
  });

  it("reclaims freed pages incrementally without a full VACUUM", () => {
    const { db } = setup();
    expect(getDatabaseAutoVacuumMode(db)).toBe("incremental");

    db.$client.exec(
      "CREATE TABLE scratch_blobs (id INTEGER PRIMARY KEY, blob TEXT)",
    );

    const insert = db.$client.prepare(
      "INSERT INTO scratch_blobs (blob) VALUES (?)",
    );

    const blob = "x".repeat(8 * 1024);

    const insertMany = db.$client.transaction((count: number) => {
      for (let index = 0; index < count; index += 1) {
        insert.run(blob);
      }
    });

    insertMany(3_000);
    db.$client.exec("DELETE FROM scratch_blobs");

    const before = getDatabaseFreelistStats(db);
    expect(before.freelistCount).toBeGreaterThan(0);

    const preparedSql: string[] = [];
    const raw = db.$client;
    const originalPrepare = raw.prepare.bind(raw);
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      value: (source: string) => {
        preparedSql.push(source);

        return originalPrepare(source);
      },
      writable: true,
    });
    let result: ReturnType<typeof runIncrementalVacuum>;

    try {
      result = runIncrementalVacuum(db, {
        maxPages: TEST_INCREMENTAL_VACUUM_MAX_PAGES,
      });
    } finally {
      Object.defineProperty(raw, "prepare", {
        configurable: true,
        value: originalPrepare,
        writable: true,
      });
    }

    const reclaimedPages =
      result.before.freelistCount - result.after.freelistCount;

    expect(result.before.freelistCount).toBe(before.freelistCount);
    expect(result.after.freelistCount).toBeLessThan(before.freelistCount);
    expect(reclaimedPages).toBeLessThanOrEqual(
      TEST_INCREMENTAL_VACUUM_MAX_PAGES,
    );
    expect(getDatabaseFreelistStats(db).freelistCount).toBeLessThan(
      before.freelistCount,
    );
    expect(preparedSql.some((source) => source.includes("dbstat"))).toBe(false);
    expect(getDatabaseAutoVacuumMode(db)).toBe("incremental");
  });

  it("does not schedule incremental vacuum for internal fragmentation without enough freelist pages", () => {
    const freelistStats = {
      databaseBytes: 1_000,
      freelistBytes: 0,
      freelistCount: DATABASE_INCREMENTAL_VACUUM_MIN_FREELIST_PAGES - 1,
      pageCount: 10,
      pageSize: 100,
    };

    expect(
      shouldRunIncrementalVacuum({
        minFreelistPages: DATABASE_INCREMENTAL_VACUUM_MIN_FREELIST_PAGES,
        stats: freelistStats,
      }),
    ).toBe(false);
  });
});
