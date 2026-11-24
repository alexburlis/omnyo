import { describe, expect, it } from "vitest";
import {
  DEFAULT_THREAD_GROUP_NAME,
  suggestThreadGroupName,
} from "../src/thread-group-name.js";

describe("suggestThreadGroupName", () => {
  it("names a group after the longest run of words every title shares", () => {
    expect(
      suggestThreadGroupName(["COMMANDER CUSTOM MODEL", "E4B CUSTOM MODEL"]),
    ).toBe("CUSTOM MODEL");
  });

  it("treats breadcrumb separators as word breaks and ignores case", () => {
    expect(
      suggestThreadGroupName([
        "Paraspeech > SEO > Weekly Release Readiness",
        "paraspeech › Support › Daily triage",
      ]),
    ).toBe("Paraspeech");
  });

  it("skips runs made only of filler words", () => {
    expect(
      suggestThreadGroupName(["Fix the sidebar", "Polish the composer"]),
    ).toBe(DEFAULT_THREAD_GROUP_NAME);
  });

  it("falls back when titles share nothing or are missing", () => {
    expect(suggestThreadGroupName(["Mac app", "Landing SEO"])).toBe(
      DEFAULT_THREAD_GROUP_NAME,
    );
    expect(suggestThreadGroupName([])).toBe(DEFAULT_THREAD_GROUP_NAME);
    expect(suggestThreadGroupName(["   "])).toBe(DEFAULT_THREAD_GROUP_NAME);
  });

  it("keeps a single chat's title, capped to the name length", () => {
    expect(suggestThreadGroupName(["E4B CUSTOM MODEL"])).toBe(
      "E4B CUSTOM MODEL",
    );
    expect(suggestThreadGroupName(["x".repeat(60)])).toHaveLength(48);
  });
});
