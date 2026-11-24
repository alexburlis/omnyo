import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { expect, test } from "vitest";
import { initializeTasksSchema } from "./db/schema";
import { createTasksStore } from "./db/store";

const legacyStatementHashesV1 = [
  "94814ac6f7457b7d87355fcbd53f7cbb93cfa42805c1a6180fef663edb61caaf",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "8d1980ff1f59b459f7eef6bd1b3b4d96ca5b8e48a519cca50bdac2124ba8b895",
  "271ff971f05b4c388e786969dba3856372a6bf7ab9c2ca68b40a5bda19f7ac06",
  "4b84e703e1b6268b94ef1076aa3390302da8b1418f93a7926c15bdb2a7daebd5",
  "609b59f72cb5ff68a7377d15cc116d8182bd7bc9f4a6c62ca6279e66e5f87d43",
  "3673aaf69e67431322e375f52906a3985e86f54eec400dfdfe6e594ce4f159ca",
  "1fd0e8bb37de9a6a532b9ea3d89473c59ed2f8729356d887af6c370c17a3a479",
];

function legacyStatements() {
  const source = ts.createSourceFile(
    "schema.ts",
    readFileSync(new URL("./db/schema.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  let statements: string[] | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "MIGRATIONS" &&
      node.initializer
    ) {
      const value = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;

      if (!ts.isArrayLiteralExpression(value))
        throw new Error("Expected literal applied migration history");
      statements = value.elements.slice(0, 8).map((entry) => {
        if (
          !ts.isStringLiteral(entry) &&
          !ts.isNoSubstitutionTemplateLiteral(entry)
        )
          throw new Error("Applied migration is no longer a literal");

        return entry.text;
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  if (!statements) throw new Error("Missing applied migration history");
  expect(
    statements.map((sql) => createHash("sha256").update(sql).digest("hex")),
  ).toEqual(legacyStatementHashesV1);

  return statements;
}

function legacyFixture() {
  const { api, harness } = createFakePluginHost({
    pluginId: "tasks-migration-fixture",
  });

  const db = api.storage.database();
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  for (const [index, sql] of legacyStatements().entries()) {
    db.exec(sql);
    db.prepare("INSERT INTO schema_version VALUES (?, ?)").run(
      index + 1,
      "original-applied-time",
    );
  }

  db.prepare(
    "INSERT INTO projects (id, name, prefix, color, linked_bb_project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "stable-project",
    "Preserved project",
    "MIG",
    "blue",
    "proj_preserved",
    "original-created-time",
  );
  db.prepare(
    "INSERT INTO tasks (id, project_id, number, title, description, status, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "stable-task",
    "stable-project",
    1,
    "Preserved task",
    "Keep literal bbtask://user-prose unchanged",
    "todo",
    "none",
    1,
    "original-created-time",
    "original-updated-time",
  );

  return { db, harness };
}

test("upgrades populated task links once without rewriting applied statements or user work", async () => {
  const { db, harness } = legacyFixture();

  try {
    initializeTasksSchema(db);
    initializeTasksSchema(db);
    expect(
      db.prepare("SELECT id, linked_app_project_id FROM projects").all(),
    ).toEqual([
      { id: "stable-project", linked_app_project_id: "proj_preserved" },
    ]);
    expect(db.prepare("SELECT id, description FROM tasks").all()).toEqual([
      {
        id: "stable-task",
        description: "Keep literal bbtask://user-prose unchanged",
      },
    ]);
    expect(
      db.prepare("SELECT count(*) AS count FROM schema_version").get(),
    ).toEqual({ count: 9 });
    expect(
      db
        .prepare(
          "SELECT DISTINCT applied_at FROM schema_version WHERE version <= 8",
        )
        .all(),
    ).toEqual([{ applied_at: "original-applied-time" }]);
    const store = createTasksStore(db);
    const project = store.getProject("stable-project");
    expect(project).toMatchObject({
      id: "stable-project",
      linkedAppProjectId: "proj_preserved",
    });
    expect(project).not.toHaveProperty("linkedBbProjectId");
    store.updateProject("stable-project", {
      linkedAppProjectId: "proj_updated",
    });
    expect(createTasksStore(db).getProject("stable-project")).toMatchObject({
      id: "stable-project",
      linkedAppProjectId: "proj_updated",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    await harness.dispose();
  }
});

test("refuses conflicting task columns and leaves both values and prior versions intact", async () => {
  const { db, harness } = legacyFixture();

  try {
    db.exec("ALTER TABLE projects ADD COLUMN linked_app_project_id TEXT");
    db.exec("UPDATE projects SET linked_app_project_id = 'proj_conflict'");
    expect(() => initializeTasksSchema(db)).toThrow(
      /duplicate column|already exists/i,
    );
    expect(
      db
        .prepare(
          "SELECT linked_bb_project_id, linked_app_project_id FROM projects",
        )
        .get(),
    ).toEqual({
      linked_bb_project_id: "proj_preserved",
      linked_app_project_id: "proj_conflict",
    });
    expect(
      db.prepare("SELECT count(*) AS count FROM schema_version").get(),
    ).toEqual({ count: 8 });
  } finally {
    await harness.dispose();
  }
});
