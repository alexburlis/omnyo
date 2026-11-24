import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import { noopNotifier } from "../../src/notifier.js";
import { projects } from "../../src/schema.js";
import { createConnection, migrate } from "../../src/index.js";
import {
  createProject,
  ensurePersonalProject,
  findOrCreateProjectByLocalPathSource,
  getProject,
  listActiveProjects,
  listPublicProjects,
  markProjectDeleted,
  reorderProject,
  setProjectGitRemoteUrlIfMissing,
  updateProject,
} from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import {
  dropPluginArtifactBundledRootDirColumn,
  dropQueuedMessageCoalesceColumns,
  dropQueuedMessageDeliveryModeColumn,
  dropQueuedMessageOverridesFailureColumn,
  dropThreadLaunchedByColumn,
  dropNativeThreadImportsTable,
  dropThreadShelfSortKeyColumn,
  dropThreadStatusChangedAtColumn,
  rewindInboxStateMigration,
} from "../helpers/rewind.js";

function setup() {
  const db = createMigratedConnection();

  const host = upsertHost(db, noopNotifier, {
    name: "projects-host",
  });

  return { db, host };
}

describe("projects", () => {
  it("persists a custom icon across reopen and resets to automatic", () => {
    const { db, host } = setup();

    const { project } = createProject(db, noopNotifier, {
      name: "Icons",
      source: { type: "local_path", hostId: host.id, path: "/tmp/icons" },
    });

    const customIcon = "data:image/png;base64,test";
    updateProject(db, noopNotifier, project.id, { customIcon });
    const reopened = createConnection(db.$client.serialize());

    try {
      migrate(reopened);
      expect(getProject(reopened, project.id)?.customIcon).toBe(customIcon);
      updateProject(reopened, noopNotifier, project.id, { customIcon: null });
      expect(getProject(reopened, project.id)?.customIcon).toBeNull();
    } finally {
      reopened.$client.close();
      db.$client.close();
    }
  });
  it("migrates Personal after existing projects once and preserves later moves on restart", () => {
    const { db } = setup();

    try {
      db.$client.exec(`
        DELETE FROM __drizzle_migrations WHERE created_at >= 1793023960867;
        ALTER TABLE projects DROP COLUMN custom_icon;
        DROP TABLE daemon_event_receipts;
        DROP TABLE managed_previews;
        DROP INDEX threads_shelf_sort_idx;
        ALTER TABLE threads DROP COLUMN shelved_at;
        UPDATE projects SET sort_key = 'V' WHERE id = 'proj_personal';
        INSERT INTO projects (id, kind, name, sort_key, created_at, updated_at)
        VALUES ('proj_first', 'standard', 'First', 'V', 1, 1),
               ('proj_last', 'standard', 'Last', 'z', 1, 1);
      `);
      dropPluginArtifactBundledRootDirColumn(db);
      dropQueuedMessageDeliveryModeColumn(db);
      dropQueuedMessageCoalesceColumns(db);
      rewindInboxStateMigration(db);
      dropThreadLaunchedByColumn(db);
      dropQueuedMessageOverridesFailureColumn(db);
      dropThreadShelfSortKeyColumn(db);
      dropThreadStatusChangedAtColumn(db);
      dropNativeThreadImportsTable(db);
      migrate(db);
      expect(listActiveProjects(db).map((project) => project.id)).toEqual([
        "proj_first",
        "proj_last",
        PERSONAL_PROJECT_ID,
      ]);
      expect(
        reorderProject({
          db,
          notifier: noopNotifier,
          projectId: PERSONAL_PROJECT_ID,
          previousProjectId: null,
          nextProjectId: "proj_first",
        }).kind,
      ).toBe("reordered");
      const restarted = createConnection(db.$client.serialize());

      try {
        migrate(restarted);
        expect(
          listActiveProjects(restarted).map((project) => project.id),
        ).toEqual([PERSONAL_PROJECT_ID, "proj_first", "proj_last"]);
      } finally {
        restarted.$client.close();
      }
    } finally {
      db.$client.close();
    }
  });

  it("reorders Personal between standard projects", () => {
    const { db, host } = setup();

    const first = createProject(db, noopNotifier, {
      name: "First",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/personal-first",
      },
    }).project;

    const second = createProject(db, noopNotifier, {
      name: "Second",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/personal-second",
      },
    }).project;

    const result = reorderProject({
      db,
      notifier: noopNotifier,
      projectId: PERSONAL_PROJECT_ID,
      previousProjectId: first.id,
      nextProjectId: second.id,
    });

    expect(result.kind).toBe("reordered");

    if (result.kind !== "reordered") throw new Error(result.kind);
    expect(result.projects.map((project) => project.id)).toEqual([
      first.id,
      PERSONAL_PROJECT_ID,
      second.id,
    ]);
  });

  it("returns the existing project when the same host path is added again", () => {
    const { db, host } = setup();

    const first = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "first-name",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/same-project",
      },
    });

    const repeated = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "second-name",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/same-project",
      },
    });

    expect(repeated).toEqual(first);
    expect(listPublicProjects(db)).toEqual([first.project]);
  });

  it("allows the same path on different hosts", () => {
    const { db, host } = setup();

    const otherHost = upsertHost(db, noopNotifier, {
      name: "other-projects-host",
    });

    const first = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "first-host-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/shared-path",
      },
    });

    const second = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "second-host-project",
      source: {
        type: "local_path",
        hostId: otherHost.id,
        path: "/tmp/shared-path",
      },
    });

    expect(second.project.id).not.toBe(first.project.id);
    expect(listPublicProjects(db)).toHaveLength(2);
  });

  it("sets a git remote anchor only while it is missing", () => {
    const { db, host } = setup();

    const { project } = createProject(db, noopNotifier, {
      name: "anchored-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/anchored-project",
      },
    });

    expect(project.gitRemoteUrl).toBeNull();
    expect(
      setProjectGitRemoteUrlIfMissing(
        db,
        noopNotifier,
        project.id,
        "ssh://git.example.test/first.git",
      )?.gitRemoteUrl,
    ).toBe("ssh://git.example.test/first.git");
    expect(
      setProjectGitRemoteUrlIfMissing(
        db,
        noopNotifier,
        project.id,
        "ssh://git.example.test/second.git",
      ),
    ).toBeNull();
    expect(getProject(db, project.id)?.gitRemoteUrl).toBe(
      "ssh://git.example.test/first.git",
    );
  });

  it("ensures the singleton personal project idempotently", () => {
    const { db } = setup();

    const first = ensurePersonalProject(db);
    const second = ensurePersonalProject(db);

    expect(first.id).toBe(PERSONAL_PROJECT_ID);
    expect(second.id).toBe(PERSONAL_PROJECT_ID);
    expect(
      db
        .select()
        .from(projects)
        .all()
        .filter((project) => project.kind === "personal"),
    ).toEqual([expect.objectContaining({ id: PERSONAL_PROJECT_ID })]);
  });

  it("excludes deleted projects from public listings", () => {
    const { db, host } = setup();

    const { project: visibleProject } = createProject(db, noopNotifier, {
      name: "visible-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/visible-project",
      },
    });

    const { project: deletingProject } = createProject(db, noopNotifier, {
      name: "deleting-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/deleting-project",
      },
    });

    markProjectDeleted(db, noopNotifier, {
      projectId: deletingProject.id,
    });

    const allProjectIds = db
      .select()
      .from(projects)
      .all()
      .map((project) => project.id);

    expect(allProjectIds).toHaveLength(3);
    expect(allProjectIds).toEqual(
      expect.arrayContaining([
        PERSONAL_PROJECT_ID,
        visibleProject.id,
        deletingProject.id,
      ]),
    );
    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      visibleProject.id,
    ]);
  });

  it("reorders public projects by neighboring projects", () => {
    const { db, host } = setup();

    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });

    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });

    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    const result = reorderProject({
      db,
      notifier: noopNotifier,
      projectId: thirdProject.id,
      previousProjectId: firstProject.id,
      nextProjectId: secondProject.id,
    });

    expect(result.kind).toBe("reordered");
    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      firstProject.id,
      thirdProject.id,
      secondProject.id,
    ]);
  });

  it("returns unchanged when project order already matches neighboring projects", () => {
    const { db, host } = setup();

    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });

    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });

    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    const result = reorderProject({
      db,
      notifier: noopNotifier,
      projectId: secondProject.id,
      previousProjectId: firstProject.id,
      nextProjectId: thirdProject.id,
    });

    expect(result.kind).toBe("unchanged");

    if (result.kind !== "unchanged") {
      throw new Error(`Expected unchanged reorder, received ${result.kind}`);
    }

    expect(result.projects.map((project) => project.id)).toEqual([
      PERSONAL_PROJECT_ID,
      firstProject.id,
      secondProject.id,
      thirdProject.id,
    ]);
  });

  it("returns not_found when reordering a missing project", () => {
    const { db } = setup();

    expect(
      reorderProject({
        db,
        notifier: noopNotifier,
        projectId: "proj_missing",
        previousProjectId: null,
        nextProjectId: null,
      }).kind,
    ).toBe("not_found");
  });

  it("rejects project reorder neighbors that are in reverse order", () => {
    const { db, host } = setup();

    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });

    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });

    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    expect(
      reorderProject({
        db,
        notifier: noopNotifier,
        projectId: thirdProject.id,
        previousProjectId: secondProject.id,
        nextProjectId: firstProject.id,
      }).kind,
    ).toBe("invalid_neighbor_order");
    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      firstProject.id,
      secondProject.id,
      thirdProject.id,
    ]);
  });

  it("appends new projects after existing project order", () => {
    const { db, host } = setup();

    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });

    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });

    reorderProject({
      db,
      notifier: noopNotifier,
      projectId: secondProject.id,
      previousProjectId: null,
      nextProjectId: firstProject.id,
    });

    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      secondProject.id,
      firstProject.id,
      thirdProject.id,
    ]);
  });

  it("rejects stale project reorder neighbors", () => {
    const { db, host } = setup();

    const { project: visibleProject } = createProject(db, noopNotifier, {
      name: "visible-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/visible-project",
      },
    });

    const { project: deletingProject } = createProject(db, noopNotifier, {
      name: "deleting-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/deleting-project",
      },
    });

    markProjectDeleted(db, noopNotifier, {
      projectId: deletingProject.id,
    });

    expect(
      reorderProject({
        db,
        notifier: noopNotifier,
        projectId: visibleProject.id,
        previousProjectId: deletingProject.id,
        nextProjectId: null,
      }).kind,
    ).toBe("stale_neighbor");
  });
});
