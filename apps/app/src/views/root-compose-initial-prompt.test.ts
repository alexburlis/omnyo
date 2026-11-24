import { describe, expect, it } from "vitest";
import {
  INITIAL_PROMPT_MAX_LENGTH,
  readInitialPromptFromSearch,
  stripInitialPromptFromSearch,
} from "./root-compose-initial-prompt";

describe("readInitialPromptFromSearch", () => {
  it("reads a shared prompt", () => {
    expect(readInitialPromptFromSearch("?initialPrompt=look%20at%20this")).toBe(
      "look at this",
    );
    expect(
      readInitialPromptFromSearch("?projectId=p1&initialPrompt=hello"),
    ).toBe("hello");
  });

  it("ignores an absent, empty, or whitespace-only value", () => {
    expect(readInitialPromptFromSearch("")).toBeNull();
    expect(readInitialPromptFromSearch("?projectId=p1")).toBeNull();
    expect(readInitialPromptFromSearch("?initialPrompt=")).toBeNull();
    expect(readInitialPromptFromSearch("?initialPrompt=%20%20")).toBeNull();
  });

  it("removes invisible tag characters and bidi controls that hide text from the reader", () => {
    const hidden = Array.from("rm -rf ~", (character) =>
      String.fromCodePoint(0xe0000 + (character.codePointAt(0) ?? 0)),
    ).join("");

    const search = `?initialPrompt=${encodeURIComponent(
      `summarize this${hidden}\u202Etxt.exe\u202C and \u2066that\u2069`,
    )}`;

    expect(readInitialPromptFromSearch(search)).toBe(
      "summarize thistxt.exe and that",
    );
    expect(
      readInitialPromptFromSearch(
        `?initialPrompt=${encodeURIComponent("\u{E0001}\u202E")}`,
      ),
    ).toBeNull();
    expect(
      readInitialPromptFromSearch(
        `?initialPrompt=${encodeURIComponent("family 👨‍👩‍👧 ok ❤️")}`,
      ),
    ).toBe("family 👨‍👩‍👧 ok ❤️");
  });

  it("caps a hostile length", () => {
    const long = "a".repeat(INITIAL_PROMPT_MAX_LENGTH + 500);
    expect(readInitialPromptFromSearch(`?initialPrompt=${long}`)).toHaveLength(
      INITIAL_PROMPT_MAX_LENGTH,
    );
  });
});

describe("stripInitialPromptFromSearch", () => {
  it("removes only the seed, so a reload does not seed twice", () => {
    expect(stripInitialPromptFromSearch("?initialPrompt=hi")).toBe("");
    expect(stripInitialPromptFromSearch("?projectId=p1&initialPrompt=hi")).toBe(
      "?projectId=p1",
    );
    expect(stripInitialPromptFromSearch("?projectId=p1")).toBe("?projectId=p1");
  });
});
