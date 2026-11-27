import assert from "node:assert/strict";
import test from "node:test";
import { nativeSkillMention, replaceSkillMention, sameSkillPath } from "./curated-draft.ts";

const source = { name: "pdf", scope: "omnyo-project" };

test("installing a one-time skill replaces its pill and keeps following mentions bound", () => {
  const original = "Before @Use once: pdf then @thread after";

  const previous = {
    kind: "plugin",
    pluginId: "skill-discovery",
    provider: "curated-skill",
    id: "reference",
    label: "Use once: pdf",
    from: 7,
    to: original.indexOf(" then"),
  };

  const later = {
    kind: "thread",
    threadId: "thread",
    label: "thread",
    from: original.indexOf("@thread"),
    to: original.indexOf("@thread") + 7,
  };

  const draft = { text: original, mentions: [previous, later], attachments: [] };
  const next = replaceSkillMention(draft, previous, nativeSkillMention(source, "$"));
  assert.equal(next.text, "Before $pdf then @thread after");
  assert.equal(next.mentions.length, 2);
  assert.deepEqual(next.mentions[0], { ...nativeSkillMention(source, "$"), from: 7, to: 11 });
  assert.deepEqual(next.mentions[1], { ...later, from: 17, to: 24 });
});

test("an already-removed pill never rewrites an unrelated draft", () => {
  const draft = {
    text: "Keep this",
    mentions: [],
    attachments: [{ type: "localFile", path: "/a", name: "a" }],
  };

  const missing = {
    kind: "plugin",
    from: 0,
    to: 1,
    label: "missing",
    provider: "curated-skill",
    pluginId: "skill-discovery",
    id: "old",
  };

  assert.equal(replaceSkillMention(draft, missing, nativeSkillMention(source, "/")), draft);
});

test("native pills retain the selected provider trigger and source origin", () => {
  assert.equal(nativeSkillMention(source, "$").trigger, "$");
  assert.equal(nativeSkillMention({ ...source, scope: "provider-user" }, "/").origin, "user");
  assert.equal(nativeSkillMention({ ...source, scope: "omnyo-builtin" }, "/").origin, "builtin");
});

test("install binding tolerates Windows separators without accepting a same-name source", () => {
  assert.equal(
    sameSkillPath("C:\\work\\.omnyo\\skills\\pdf\\SKILL.md", "C:/work/.omnyo/skills/pdf/SKILL.md"),
    true,
  );
  assert.equal(
    sameSkillPath("/other/.omnyo/skills/pdf/SKILL.md", "/work/.omnyo/skills/pdf/SKILL.md"),
    false,
  );
});
