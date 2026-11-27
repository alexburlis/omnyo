import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import Database from "better-sqlite3";
import { searchCurated } from "./curated-contract.ts";
import { createCuratedReferences, curatedReferenceMigration } from "./curated-references.ts";
import { createPackService } from "./pack-service.ts";
import { encodeSkillPack } from "./pack-encoding.ts";
import { inspectPackDestination, installPackFiles } from "./pack-files.ts";
import { createCuratedService } from "./curated-service.ts";

const content =
  "---\nname: test-skill\ndescription: A test skill.\n---\n\nReview the current change.\n";

const digest = createHash("sha256").update(content).digest("hex");

function referenceStore(t, now) {
  const db = new Database(":memory:");
  db.exec(curatedReferenceMigration);
  t.after(() => db.close());

  return { db, refs: createCuratedReferences(db, now) };
}

test("exact names rank first and search preserves source identities and stable ties", () => {
  const row = {
    publisher: "test",
    description: "Document and code review",
    sourceUrl: "https://example.com",
    license: "MIT",
    useOnce: true,
  };

  const entries = [
    { ...row, id: "test/code-review", name: "code-review" },
    { ...row, id: "test/review", name: "review" },
    { ...row, id: "other/review", name: "review" },
  ];

  assert.deepEqual(
    searchCurated(entries, "review").map((entry) => entry.id),
    ["test/review", "other/review", "test/code-review"],
  );
  assert.equal(searchCurated(entries, "unknown skill").length, 0);
  assert.deepEqual(searchCurated(entries, "", 1), entries.slice(0, 1));
  assert.equal(searchCurated(entries, "code review").length, 3);
  assert.equal(searchCurated(entries, "code reveiw")[0]?.id, "test/code-review");
  assert.equal(searchCurated(entries, "help me review my code")[0]?.id, "test/code-review");
  assert.deepEqual(searchCurated(entries, "test/missing"), []);
});

test("one-time references survive reload and repeated sends without changing exact content", (t) => {
  let now = 1000;
  const { refs, db } = referenceStore(t, () => now);
  const prepared = refs.prepare("test/skill", content, digest);
  assert.deepEqual(refs.prepare("test/skill", content, digest), prepared);
  now += 29 * 24 * 60 * 60 * 1000;
  const reloaded = createCuratedReferences(db, () => now);
  assert.deepEqual(reloaded.resolve(prepared.reference), { context: content });
  now += 29 * 24 * 60 * 60 * 1000;
  assert.deepEqual(reloaded.resolve(prepared.reference), { context: content });
  now += 31 * 24 * 60 * 60 * 1000;
  assert.throws(() => reloaded.resolve(prepared.reference), /expired.*Remove its pill/u);
  assert.throws(() => reloaded.resolve("unknown"), /expired/u);
});

test("reference creation rejects changed instructions and enforces bounded retention", (t) => {
  const { refs, db } = referenceStore(t, () => 1000);
  assert.throws(() => refs.prepare("test/skill", content + "changed", digest), /changed/u);
  assert.throws(() => refs.prepare("test/skill", "a".repeat(65537), digest), /too large/u);
  const prepared = refs.prepare("test/skill", content, digest);
  db.prepare("UPDATE curated_use_once SET content = ? WHERE reference = ?").run(
    "Changed",
    prepared.reference,
  );
  assert.throws(() => refs.resolve(prepared.reference), /changed/u);

  for (let index = 1; index < 256; index += 1) refs.prepare(`test/${index}`, content, digest);
  assert.throws(() => refs.prepare("test/overflow", content, digest), /Too many/u);
});

test("catalog discovery stays offline and one-time use keeps exact reviewed bytes and license", async (t) => {
  const { db } = referenceStore(t, () => 1000);

  const entry = {
    id: "test/skills/test-skill",
    name: "test-skill",
    publisher: "Test",
    description: "Test skill",
    sourceUrl: "https://example.com/source",
    license: "MIT",
    useOnce: true,
    pin: "1".repeat(40),
    artifact: { kind: "skill-md", url: "https://example.com/skill", sha256: digest },
    notice: {
      path: "LICENSE.curated.txt",
      content: "Permission is hereby granted, free of charge.",
      sourceUrl: "https://example.com/license",
    },
    useOnceReview: { skillSha256: digest, reason: "Standalone instructions" },
  };

  let requests = 0;
  let returnedContent = content;

  const catalog = createCuratedService(
    { storage: { database: () => db } },
    {},
    {
      entries: [entry],
      loadFiles: async () => {
        requests += 1;

        return [
          { path: "SKILL.md", content: returnedContent },
          { path: entry.notice.path, content: entry.notice.content },
        ];
      },
    },
  );

  const snapshot = catalog.get();
  assert.equal(requests, 0);
  assert.equal(snapshot.entries[0].pin, undefined);
  assert.deepEqual(searchCurated(snapshot.entries, "test"), snapshot.entries);
  assert.equal(requests, 0);
  await assert.rejects(catalog.prepare({ id: entry.id, generation: "0".repeat(64) }), /updated/u);
  await assert.rejects(
    catalog.prepare({ id: "test/missing", generation: snapshot.generation }),
    /no longer/u,
  );
  assert.equal(requests, 0);
  const prepared = await catalog.prepare({ id: entry.id, generation: snapshot.generation });
  const resolved = catalog.resolve(prepared.reference);
  assert.ok(resolved.context.startsWith(content));
  assert.ok(resolved.context.endsWith(entry.notice.content));
  assert.equal(
    createHash("sha256").update(resolved.context.slice(0, content.length)).digest("hex"),
    digest,
  );
  assert.equal(requests, 1);
  catalog.resolve(prepared.reference);
  assert.equal(requests, 1);
  returnedContent += "changed";
  await assert.rejects(
    catalog.prepare({ id: entry.id, generation: snapshot.generation }),
    /approved one-time version/u,
  );
});

test("curated artifact review does not write and confirmation is bound to exact bytes and workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omnyo-curated-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let workspacePath = root;

  const api = {
    sdk: {
      projects: {
        get: async () => ({
          sources: [{ isDefault: true, path: workspacePath, hostId: "test-host" }],
        }),
      },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method, input, target) => {
          assert.equal(target.hostId, "test-host");

          return method === "inspect" ? inspectPackDestination(input) : installPackFiles(input);
        },
      }),
    },
  };

  const packs = createPackService(api);

  const artifact = encodeSkillPack({
    schemaVersion: 1,
    publisher: "curated",
    slug: "test-skill",
    version: "1.0.0",
    title: "test-skill",
    description: "A curated test skill",
    license: "MIT",
    skills: [{ id: "test-skill", files: [{ path: "SKILL.md", content }] }],
    prompts: [],
  });

  const review = await packs.reviewArtifact(
    { projectId: "project", environmentId: null },
    artifact,
  );

  assert.equal(review.workspacePath, root);
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(
    packs.confirm({ reviewId: review.reviewId, digest: "0".repeat(64) }),
    /expired or changed/u,
  );
  workspacePath = path.join(root, "different");
  await assert.rejects(
    packs.confirm({ reviewId: review.reviewId, digest: review.digest }),
    /workspace changed/u,
  );
  workspacePath = root;
  const installed = await packs.confirm({ reviewId: review.reviewId, digest: review.digest });
  assert.equal("collectionId" in installed, false);
  assert.equal(
    await fs.readFile(path.join(root, ".omnyo", "skills", "test-skill", "SKILL.md"), "utf8"),
    content,
  );
  assert.deepEqual(
    await packs.confirm({ reviewId: review.reviewId, digest: review.digest }),
    installed,
  );
});
