import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatCount, nameInputSchema } from "../lib/naming.ts";

describe("first-response title validation", () => {
  it("accepts a concise title and an optional tag without a model-supplied target", () => {
    assert.deepEqual(nameInputSchema.parse({ title: "  Fix  worker updates ", tag: " Fix " }), {
      title: "Fix worker updates",
      tag: "fix",
    });
    assert.deepEqual(nameInputSchema.parse({ title: "Fix updates" }), { title: "Fix updates" });
    assert.deepEqual(nameInputSchema.parse({ title: "Fix updates", tag: null }), {
      title: "Fix updates",
      tag: null,
    });
    assert.equal(
      nameInputSchema.safeParse({ title: "Fix updates", threadId: "foreign" }).success,
      false,
    );
    assert.equal(
      nameInputSchema.safeParse({ title: "Fix updates", topic: "Runtime" }).success,
      false,
    );
  });

  it("rejects empty, long, six-word and multiline titles", () => {
    for (const title of [
      " ",
      "x".repeat(49),
      "One two three four five six",
      "Fix\nupdates",
      "\nFix",
      "Fix\u0000updates",
      "Fix updates",
    ])
      assert.equal(nameInputSchema.safeParse({ title }).success, false, JSON.stringify(title));
  });
});

describe("chat count labels", () => {
  it("uses the singular for exactly one chat", () => {
    assert.equal(chatCount(0), "0 chats");
    assert.equal(chatCount(1), "1 chat");
    assert.equal(chatCount(2), "2 chats");
    assert.equal(chatCount(1, true), "1 or more chats");
  });
});
