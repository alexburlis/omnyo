import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TAGS,
  accepts,
  addTag,
  effectiveTagId,
  isIconName,
  moveTag,
  removeTag,
  tagInstruction,
  updateTag,
  type TagRecord,
  type TagSource,
} from "../lib/tags.ts";

function record(tagId: string | null, source: TagSource): TagRecord {
  return { v: 1, tagId, source, updatedAt: 1 };
}

function ids(tags: readonly { id: string }[]) {
  return tags.map((tag) => tag.id);
}

describe("tag precedence", () => {
  const cases: readonly [TagSource, TagRecord | null, string | null, boolean][] = [
    ["prediction", null, "fix", true],
    ["prediction", record("build", "prediction"), "fix", true],
    ["prediction", record("build", "first-turn"), "fix", false],
    ["prediction", record("build", "user"), "fix", false],
    ["prediction", record(null, "user"), "fix", false],
    ["prediction", record("gone", "first-turn"), "fix", true],
    ["prediction", record("gone", "user"), "fix", false],
    ["prediction", null, null, false],
    ["prediction", record("build", "prediction"), null, true],
    ["first-turn", record("build", "prediction"), "fix", true],
    ["first-turn", record("build", "user"), "fix", false],
    ["first-turn", record(null, "user"), "fix", false],
    ["user", record("build", "first-turn"), null, true],
    ["user", record("build", "user"), "fix", true],
  ];

  it("ranks the user over the first turn over prediction", () => {
    for (const [source, current, tagId, expected] of cases)
      assert.equal(
        accepts(source, tagId, current, DEFAULT_TAGS),
        expected,
        `${source} ${tagId} over ${JSON.stringify(current)}`,
      );
  });

  it("shows a removed or unknown tag as untagged", () => {
    assert.equal(effectiveTagId(record("fix", "user"), DEFAULT_TAGS), "fix");
    assert.equal(effectiveTagId(record("gone", "user"), DEFAULT_TAGS), null);
    assert.equal(effectiveTagId(record("fix", "user"), removeTag(DEFAULT_TAGS, "fix")), null);
    assert.equal(effectiveTagId(null, DEFAULT_TAGS), null);
  });
});

describe("tag list edits", () => {
  it("adds, renames, moves and removes tags without touching the rest", () => {
    const added = addTag(DEFAULT_TAGS, { id: "docs", label: "Docs", icon: "📝", description: "" });
    assert.deepEqual(ids(added).at(-1), "docs");
    assert.deepEqual(
      updateTag(added, "docs", { label: "Writing", icon: undefined, description: undefined })[6],
      { id: "docs", label: "Writing", icon: "📝", description: "" },
    );
    assert.deepEqual(ids(moveTag(added, "docs", 1)).slice(0, 3), ["fix", "docs", "build"]);
    assert.deepEqual(ids(moveTag(added, "fix", 99)).at(-1), "fix");
    assert.deepEqual(ids(removeTag(added, "ship")).includes("ship"), false);
    assert.deepEqual(ids(DEFAULT_TAGS), ["fix", "build", "ship", "ops", "research", "design"]);
  });

  it("tells Omnyo icon names from emoji", () => {
    for (const tag of DEFAULT_TAGS) assert.equal(isIconName(tag.icon), true, tag.icon);

    for (const icon of ["📝", "⚙️", "•", "bug", "Bug fix", "A-B"])
      assert.equal(isIconName(icon), false, icon);
  });

  it("refuses duplicates, unknown ids and lists past the limit", () => {
    assert.throws(() => addTag(DEFAULT_TAGS, DEFAULT_TAGS[0]), /already exists/u);
    assert.throws(() => removeTag(DEFAULT_TAGS, "nope"), /No tag "nope"/u);
    assert.throws(() => updateTag(DEFAULT_TAGS, "nope", { label: "X" }), /No tag "nope"/u);
    let tags = [...DEFAULT_TAGS];

    for (const id of ["a", "b", "c", "d", "e", "f"])
      tags = addTag(tags, { id, label: id, icon: "•", description: "" });
    assert.throws(() => addTag(tags, { id: "g", label: "g", icon: "•", description: "" }));
  });

  it("lists each tag as id and meaning for the first turn", () => {
    assert.equal(
      tagInstruction([DEFAULT_TAGS[0], { id: "docs", label: "Docs", icon: "📝", description: "" }]),
      " Also pass tag, the one id that names this chat's type of work: fix (defects, regressions), docs. Omit tag when none fits.",
    );
    assert.equal(tagInstruction([]), "");
  });
});
