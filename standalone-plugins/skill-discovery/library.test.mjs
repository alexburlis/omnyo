import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { addPackCollection, exportCollection } from "./library-packs.ts";
import { createLibraryStore } from "./library-store.ts";
import { decodeSkillPack } from "./pack-encoding.ts";

const workspace = { projectId: "project", environmentId: null };

function owner(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());

  return createLibraryStore({
    storage: {
      database: () => db,
      migrate: (database, statements) => statements.forEach((sql) => database.exec(sql)),
    },
  });
}

function apply(store, operation, revision = store.get(workspace).revision) {
  return store.apply({ ...workspace, revision, operation });
}

test("moves links and collections without renaming or replacing a source, and refuses stale or cyclic operations", (t) => {
  const store = owner(t);

  const [{ id: root }] = apply(store, {
    kind: "collection.create",
    title: "Customer Lab",
    description: "",
    parentId: null,
  }).collections;

  const [, { id: group }] = apply(store, {
    kind: "collection.create",
    title: "Methods",
    description: "",
    parentId: root,
  }).collections;

  const source = {
    name: "review",
    provider: null,
    scope: "omnyo-project",
    pluginId: null,
    filePath: "/checkout/.omnyo/skills/review/SKILL.md",
  };

  const [{ id }] = apply(store, {
    kind: "link.add",
    collectionId: group,
    target: { kind: "skill", source },
  }).links;

  apply(store, { kind: "link.update", id, title: "Review a draft" });
  assert.throws(() => apply(store, { kind: "link.update", id, title: "Stale" }, 3), /changed/);
  assert.throws(
    () => apply(store, { kind: "collection.move", id: root, parentId: group }),
    /within itself/,
  );
  const moved = apply(store, { kind: "link.move", id, collectionId: root });
  assert.deepEqual(moved.links, [
    { id, collectionId: root, target: { kind: "skill", source }, title: "Review a draft" },
  ]);
  assert.equal(store.get({ ...workspace, environmentId: "other" }).collections.length, 0);
  const removed = apply(store, { kind: "collection.remove", id: root });
  assert.equal(removed.links.length, 0);
  assert.equal(removed.collections.length, 0);
});

test("exports a nested collection and restores identical links without duplicating prompts on retry", async (t) => {
  const store = owner(t);

  const [{ id: root }] = apply(store, {
    kind: "collection.create",
    title: "Review pack",
    description: "Review a draft.",
    parentId: null,
  }).collections;

  const [, { id: methods }] = apply(store, {
    kind: "collection.create",
    title: "Methods",
    description: "",
    parentId: root,
  }).collections;

  const source = {
    name: "review",
    provider: null,
    scope: "omnyo-project",
    pluginId: null,
    filePath: "/checkout/.omnyo/skills/review/SKILL.md",
  };

  apply(store, {
    kind: "link.add",
    role: "entry",
    collectionId: root,
    target: { kind: "skill", source },
  });
  apply(store, {
    kind: "link.add",
    collectionId: methods,
    target: { kind: "reference", path: "private-notes.md" },
  });

  const [{ id: promptId }] = apply(store, {
    kind: "prompt.create",
    title: "Review a draft",
    body: "Review [draft].",
    skillId: "review",
  }).prompts;

  apply(store, { kind: "link.add", collectionId: methods, target: { kind: "prompt", promptId } });
  const content = "---\nname: review\ndescription: Review a draft.\n---\n\nCheck the facts.\n";
  const revision = createHash("sha256").update(content).digest("hex");

  const sdk = {
    list: async () => ({ skills: [{ ...source, id: "exact" }] }),
    listFiles: async ({ skillId }) => {
      assert.equal(skillId, "exact");

      return { files: ["SKILL.md"], truncated: false };
    },
    getContent: async () => ({ content, revision }),
  };

  const artifact = await exportCollection(sdk, store.get(workspace), {
    ...workspace,
    collectionId: root,
    publisher: "omnyo",
    slug: "review-pack",
    version: "1.0.0",
    license: "MIT",
  });

  const pack = decodeSkillPack(artifact);
  assert.equal(pack.skills[0].files[0].content, content);
  assert.equal(artifact.text.includes("private-notes.md"), false);
  assert.equal(pack.layout[1].parentId, root);

  const destination = { projectId: "recipient", environmentId: "worktree" };

  const sources = new Map([
    ["review", { ...source, filePath: "/recipient/.omnyo/skills/review/SKILL.md" }],
  ]);

  assert.throws(
    () =>
      store.registerPack(destination, artifact.digest, () => {
        throw Error("source unavailable");
      }),
    /source unavailable/,
  );

  const id = store.registerPack(destination, artifact.digest, (current) =>
    addPackCollection(current, pack, sources),
  );

  const repeated = store.registerPack(destination, artifact.digest, () => {
    throw Error("registered again");
  });

  const imported = store.get(destination);
  assert.equal(repeated, id);
  assert.equal(
    imported.collections.find((collection) => collection.id === id).title,
    "Review pack",
  );
  assert.equal(
    imported.collections.find((collection) => collection.title === "Methods").parentId,
    id,
  );
  assert.deepEqual(
    imported.links.map((link) => link.target.kind),
    ["skill", "prompt"],
  );
  assert.equal(imported.prompts.length, 1);
});
