import assert from "node:assert/strict";
import test from "node:test";
import { libraryRows, searchRows, sourceLocator } from "./library-view.ts";

const source = {
  id: "project-skill",
  name: "skill-audit",
  description: "Inspect a skill and report issues",
  provider: null,
  scope: "omnyo-project",
  pluginId: null,
  filePath: "/work/project/.omnyo/skills/skill-audit/SKILL.md",
  manageable: true,
  registrySkillId: null,
};

const alternate = {
  ...source,
  id: "personal-skill",
  scope: "omnyo-user",
  filePath: "/home/owner/.omnyo/skills/skill-audit/SKILL.md",
};

const library = {
  revision: 1,
  collections: [
    { id: "quality", title: "Quality", parentId: null, description: "" },
    { id: "review", title: "Review", parentId: "quality", description: "" },
  ],
  links: [
    {
      id: "skill",
      collectionId: "review",
      target: { kind: "skill", source: sourceLocator(source) },
      role: "entry",
      title: "Inspect",
    },
    {
      id: "reference",
      collectionId: "review",
      target: { kind: "reference", path: "docs/skill-audit.md" },
    },
  ],
  prompts: [
    { id: "prompt", title: "Run skill-audit", body: "Inspect the input against the checklist." },
  ],
};

test("a collection link keeps its exact source and sees other copies separately", () => {
  const [linked] = libraryRows(library, [alternate, source]);

  assert.equal(linked.kind, "skill");
  assert.equal(linked.source.id, source.id);
  assert.deepEqual(linked.variantIds, [alternate.id, source.id]);
  assert.deepEqual(linked.path, ["Quality", "Review"]);
  assert.equal(linked.link.role, "entry");
  assert.equal(linked.title, "Inspect");
});

test("a missing exact source stays visibly unavailable", () => {
  const [linked] = libraryRows(library, [alternate]);

  assert.equal(linked.kind, "unavailable");
  assert.match(linked.subtitle, /unavailable/);
});

test("an exact skill id ranks first before prompt and file path matches", () => {
  const rows = libraryRows(library, [source]);
  assert.deepEqual(
    searchRows(rows, "skill-audit").map((row) => row.kind),
    ["skill", "reference", "prompt"],
  );
});
