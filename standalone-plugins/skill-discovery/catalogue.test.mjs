import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogue } from "./catalogue.ts";

const source = (name, extra = {}) => ({
  id: name,
  name,
  description: `${name} description.`,
  filePath: `/skills/${name}/SKILL.md`,
  provider: "claude",
  scope: "provider-user",
  pluginId: null,
  ...extra,
});

const byName = (entries) => new Map(entries.map((entry) => [entry.name, entry]));

test("derives families and subgroups from shared skill name prefixes", () => {
  const entries = byName(
    buildCatalogue([
      source("game-dev", { description: "Game Dev: Find the right game skill. More detail." }),
      source("game-dev-blender-expert"),
      source("game-dev-blender-uv-baking"),
      source("game-dev-godot-shaders"),
    ]),
  );

  assert.deepEqual(entries.get("game-dev-blender-expert").category, ["Game Dev", "Blender"]);
  assert.equal(entries.get("game-dev-blender-expert").label, "Blender Expert");
  assert.deepEqual(entries.get("game-dev-blender-uv-baking").category, ["Game Dev", "Blender"]);
  assert.deepEqual(entries.get("game-dev-godot-shaders").category, ["Game Dev", "General"]);
  assert.deepEqual(entries.get("game-dev").category, ["Game Dev", "General"]);
  assert.equal(entries.get("game-dev").label, "Game Dev");
  assert.equal(entries.get("game-dev").summary, "Find the right game skill");
});

test("groups provider plugin namespaces and places small ones by topic", () => {
  const entries = byName(
    buildCatalogue([
      source("engineering:debug"),
      source("engineering:code-review"),
      source("engineering:deploy-checklist"),
      source("solo:aws-storage"),
    ]),
  );

  assert.deepEqual(entries.get("engineering:code-review").category, ["Engineering", "General"]);
  assert.equal(entries.get("engineering:code-review").label, "Code Review");
  assert.deepEqual(entries.get("solo:aws-storage").category, ["Infrastructure", "Deployment"]);
  assert.equal(entries.get("solo:aws-storage").label, "AWS Storage");
});

test("groups Omnyo plugin skills by plugin and leaves unknown skills under Other", () => {
  const entries = byName(
    buildCatalogue([
      source("board", { pluginId: "canvas-board", scope: "plugin" }),
      source("guide", { scope: "omnyo-builtin" }),
      source("weekly-standup"),
    ]),
  );

  assert.deepEqual(entries.get("board").category, ["Omnyo plugins", "Canvas Board"]);
  assert.deepEqual(entries.get("guide").category, ["Omnyo plugins", "Built-in"]);
  assert.deepEqual(entries.get("weekly-standup").category, ["Other", "General"]);
});
