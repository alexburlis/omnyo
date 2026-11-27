import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeSkillPack, encodeSkillPack, packArtifact } from "./pack-encoding.ts";
import { inspectPackDestination, installPackFiles } from "./pack-files.ts";
import { loadPackArtifact, resolvePackWorkspace } from "./pack-service.ts";
import { skill } from "./tests/marketplace-fixture.mjs";
import { maxPackBytes, skillPackSchema } from "./pack.ts";

const fixture = {
  schemaVersion: 1,
  publisher: "omnyo",
  slug: "review-pack",
  version: "1.0.0",
  title: "Review pack",
  description: "A test skill and its supporting files.",
  license: "MIT",
  skills: [
    {
      id: "review-skill",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: review-skill\ndescription: Review a draft.\n---\n\nInspect the draft.\n",
        },
        { path: "references/checklist.md", content: "Check the cited evidence.\n" },
      ],
    },
  ],
  prompts: [
    { title: "Review my draft", body: "Review the attached draft.", skillId: "review-skill" },
  ],
  layout: [
    { id: "root", parentId: null, title: "Review", description: "", items: [] },
    {
      id: "methods",
      parentId: "root",
      title: "Methods",
      description: "",
      items: [
        { kind: "skill", skillId: "review-skill", role: "entry" },
        { kind: "prompt", promptIndex: 0 },
      ],
    },
  ],
};

const artifact = encodeSkillPack(fixture);

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "omnyo-skill-pack-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  return directory;
}

async function review(workspacePath) {
  const destination = await inspectPackDestination({ workspacePath, artifact });

  return {
    ...destination,
    confirm: () =>
      installPackFiles({
        workspacePath,
        workspaceIdentity: destination.workspaceIdentity,
        artifact,
      }),
  };
}

test("binds the whole artifact and validates layout, documentation paths and exact skill IDs", () => {
  assert.deepEqual(decodeSkillPack(artifact), fixture);
  assert.throws(() => decodeSkillPack({ ...artifact, text: artifact.text + "\n" }), /SHA-256/);
  assert.notEqual(packArtifact(artifact.text + "\n").digest, artifact.digest);

  for (const badPath of [
    "../escape",
    "Bad\\slash",
    ".git/config",
    "refs/AUX.txt",
    "refs/a./b",
    "refs//b",
    "Z:/outside",
  ]) {
    const invalid = structuredClone(fixture);
    invalid.skills[0].files.push({ path: badPath, content: "content" });
    assert.equal(skillPackSchema.safeParse(invalid).success, false, badPath);
  }

  const duplicate = structuredClone(fixture);
  duplicate.skills[0].files.push({ path: "References/Other.md", content: "content" });
  assert.equal(skillPackSchema.safeParse(duplicate).success, false);

  const cyclic = structuredClone(fixture);
  cyclic.layout[0].parentId = "methods";
  assert.equal(skillPackSchema.safeParse(cyclic).success, false);

  const missing = structuredClone(fixture);
  missing.layout[1].items.push({ kind: "prompt", promptIndex: 1 });
  assert.equal(skillPackSchema.safeParse(missing).success, false);

  const incorrectName = structuredClone(fixture);
  incorrectName.skills[0].id = "lower-priority-skill";
  assert.equal(skillPackSchema.safeParse(incorrectName).success, false);
});

test("preserves portable underscore-prefixed support files without admitting hidden or parent paths", () => {
  const value = structuredClone(fixture);
  value.skills[0].files.push({ path: "rules/_sections.md", content: "Rule groups." });
  assert.equal(skillPackSchema.safeParse(value).success, true);

  for (const path of ["rules/../escape.md", "rules/.hidden", "rules/_CON/../escape"]) {
    const invalid = structuredClone(value);
    invalid.skills[0].files.push({ path, content: "No." });
    assert.equal(skillPackSchema.safeParse(invalid).success, false);
  }
});

test("published review reads only the digest-addressed app listing and refuses redirects or oversized bytes", async () => {
  const source = { kind: "published", slug: fixture.slug, digest: artifact.digest };
  const seen = [];

  const loaded = await loadPackArtifact(source, async (url, options) => {
    seen.push([url.href, options.redirect]);

    return new Response(artifact.text);
  });

  assert.deepEqual(seen, [
    [`https://omnyohq.com/explore/skills/review-pack/file/${artifact.digest}`, "error"],
  ]);
  assert.deepEqual(decodeSkillPack(loaded), fixture);

  await assert.rejects(
    loadPackArtifact(source, async () => new Response("", { status: 302 })),
    /unavailable/u,
  );

  await assert.rejects(
    loadPackArtifact(source, async () => new Response(new Uint8Array(maxPackBytes + 1))),
    /768 KiB/u,
  );

  const changed = await loadPackArtifact(source, async () => new Response(artifact.text + "\n"));
  assert.throws(() => decodeSkillPack(changed), /SHA-256/u);
});

test("Markdown imports preserve valid SKILL.md and install plain Markdown only after review", async (t) => {
  const exact = fixture.skills[0].files[0].content.replaceAll("\n", "\r\n");
  const source = { kind: "markdown", filename: "SKILL.md", text: exact };
  const reviewed = await loadPackArtifact(source);
  assert.equal(decodeSkillPack(reviewed).skills[0].files[0].content, exact);

  const body = "# Review guide\n\nRead the source before drafting.\n";

  const plain = await loadPackArtifact({
    kind: "markdown",
    filename: "Review guide.md",
    text: body,
  });

  const root = await workspace(t);
  const inspected = await inspectPackDestination({ workspacePath: root, artifact: plain });
  assert.deepEqual(await fs.readdir(root), []);
  await installPackFiles({
    workspacePath: root,
    artifact: plain,
    workspaceIdentity: inspected.workspaceIdentity,
  });

  const installed = await fs.readFile(
    path.join(root, ".omnyo", "skills", "review-guide", "SKILL.md"),
    "utf8",
  );

  assert.ok(installed.endsWith(body));
  assert.match(installed, /^---\nname: review-guide\n/u);
  await assert.rejects(
    loadPackArtifact({ ...source, text: "---\nname: ../escape\n---\n" }),
    /frontmatter/u,
  );
});

test("Marketplace review fetches the listed immutable Markdown and rejects a changed listing or file", async () => {
  const text = fixture.skills[0].files[0].content;
  const digest = packArtifact(text).digest;
  const catalog = { schemaVersion: 1, items: [{ ...skill, sha256: digest }] };
  const source = { kind: "marketplace", slug: skill.slug, digest };
  const seen = [];

  const fetcher = async (url, options) => {
    const href = String(url);
    seen.push([href, options.redirect]);

    return new URL(href).pathname.endsWith("/marketplace.json")
      ? Response.json(catalog)
      : new Response(text);
  };

  const reviewed = decodeSkillPack(await loadPackArtifact(source, fetcher));
  assert.equal(reviewed.skills[0].files[0].content, text);
  assert.deepEqual(seen, [
    ["https://omnyohq.com/explore/marketplace.json?provider-setup=1", "error"],
    [
      `https://raw.githubusercontent.com/github/awesome-copilot/${skill.revision}/skills/documentation-writer/SKILL.md`,
      "error",
    ],
  ]);
  await assert.rejects(
    loadPackArtifact({ ...source, digest: "0".repeat(64) }, fetcher),
    /changed/u,
  );
  await assert.rejects(
    loadPackArtifact(source, async (url) =>
      new URL(url).pathname.endsWith("/marketplace.json")
        ? Response.json(catalog)
        : new Response(text + "changed"),
    ),
    /SHA-256/u,
  );
});

test("Marketplace provider setup cannot be imported as a standalone skill", async () => {
  const setupUrl = `https://github.com/github/awesome-copilot/blob/${skill.revision}/README.md#install`;
  const source = { kind: "marketplace", slug: skill.slug, digest: skill.sha256 };

  const catalog = {
    schemaVersion: 1,
    items: [{ ...skill, publisher: "github/awesome-copilot", setupUrl }],
  };

  await assert.rejects(
    loadPackArtifact(source, async () => Response.json(catalog)),
    /requires the provider setup/u,
  );
});

test("a workspace from another project cannot be used as the review destination", async () => {
  const sdk = {
    environments: {
      get: async () => ({ projectId: "other-project", path: "/unrelated", hostId: "other-host" }),
    },
  };

  await assert.rejects(
    resolvePackWorkspace(sdk, { projectId: "authorized-project", environmentId: "other-env" }),
    /does not belong/u,
  );
});

test("preview is read-only, placement uses exact bytes, and retry returns the durable receipt", async (t) => {
  const root = await workspace(t);
  const pending = await review(root);
  assert.equal(pending.destination, "available");
  assert.deepEqual(await fs.readdir(root), []);

  const result = await pending.confirm();
  const skillRoot = path.join(root, ".omnyo", "skills", "review-skill");

  for (const item of fixture.skills[0].files) {
    assert.equal(await fs.readFile(path.join(skillRoot, item.path), "utf8"), item.content);
  }

  assert.deepEqual(await pending.confirm(), result);
  const installed = await review(root);
  assert.equal(installed.destination, "installed");
  assert.equal(installed.receipt, result.receipt);

  await assert.rejects(
    inspectPackDestination({
      workspacePath: root,
      artifact: encodeSkillPack({ ...fixture, version: "1.1.0" }),
    }),
    /different revision/u,
  );
});

test("a partial owned placement resumes with its original receipt and keeps foreign edits intact", async (t) => {
  const root = await workspace(t);
  const initial = await review(root);
  const result = await initial.confirm();
  const skills = path.join(root, ".omnyo", "skills", "review-skill");
  const journals = path.join(root, ".omnyo", "skill-packs");
  const [name] = await fs.readdir(journals);
  const journal = path.join(journals, name);
  const persisted = JSON.parse(await fs.readFile(journal, "utf8"));
  assert.equal(persisted.receipt, result.receipt);

  await fs.unlink(path.join(skills, "SKILL.md"));
  await fs.writeFile(journal, JSON.stringify({ ...persisted, status: "pending" }));

  const interrupted = await review(root);
  assert.equal(interrupted.destination, "recoverable");
  assert.deepEqual(await interrupted.confirm(), result);

  const locallyEdited = path.join(skills, "references", "checklist.md");
  await fs.writeFile(locallyEdited, "Local edits must survive.\n");
  await assert.rejects(initial.confirm, /left it unchanged/);
  assert.equal(await fs.readFile(locallyEdited, "utf8"), "Local edits must survive.\n");
});

test("a stale path, symlink or unowned case-insensitive collision is refused without replacing files", async (t) => {
  const parent = await workspace(t);
  const root = path.join(parent, "destination");
  await fs.mkdir(root);
  const pending = await review(root);
  await fs.rename(root, path.join(parent, "old-destination"));
  await fs.mkdir(root);
  await assert.rejects(pending.confirm, /workspace changed/);
  assert.deepEqual(await fs.readdir(root), []);

  const fresh = await review(root);
  const foreign = path.join(root, ".omnyo", "skills", "Review-Skill");
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(foreign, "SKILL.md"), "Foreign content.\n");
  await assert.rejects(fresh.confirm, /already exists/);
  assert.equal(await fs.readFile(path.join(foreign, "SKILL.md"), "utf8"), "Foreign content.\n");

  const symlinked = path.join(parent, "symlinked-destination");
  await fs.mkdir(symlinked);
  await fs.symlink(path.join(root, ".omnyo"), path.join(symlinked, ".omnyo"), "dir");
  await assert.rejects(review(symlinked), /regular directory/);
});
