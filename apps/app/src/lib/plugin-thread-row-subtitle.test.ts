import { afterEach, describe, expect, it } from "vitest";
import {
  clearPluginThreadRowSubtitles,
  clearPluginThreadRowSubtitlesByOwner,
  getPluginThreadRowSubtitle,
  setPluginThreadRowSubtitle,
} from "./plugin-thread-row-subtitle";

afterEach(() => {
  clearPluginThreadRowSubtitles("glance");
  clearPluginThreadRowSubtitles("other");
});

describe("thread row subtitle ownership", () => {
  it("keeps the first owner until it clears and then reveals the next owner", () => {
    const first = Symbol("first");
    setPluginThreadRowSubtitle(
      "thr_one",
      "glance",
      { text: "Needs you: review" },
      first,
    );
    setPluginThreadRowSubtitle("thr_one", "other", { text: "Working" });
    setPluginThreadRowSubtitle("thr_one", "glance", { text: "Done" }, first);
    expect(getPluginThreadRowSubtitle("thr_one")).toBe("Done");
    clearPluginThreadRowSubtitlesByOwner(first);
    expect(getPluginThreadRowSubtitle("thr_one")).toBe("Working");
    setPluginThreadRowSubtitle("thr_one", "other", null);
    expect(getPluginThreadRowSubtitle("thr_one")).toBeNull();
  });

  it("clears one generation without removing its replacement or another plugin", () => {
    const old = Symbol("old");
    const replacement = Symbol("replacement");
    setPluginThreadRowSubtitle("thr_old", "glance", { text: "Old" }, old);
    setPluginThreadRowSubtitle(
      "thr_new",
      "glance",
      { text: "New" },
      replacement,
    );
    setPluginThreadRowSubtitle("thr_other", "other", { text: "Other" });
    clearPluginThreadRowSubtitlesByOwner(old);
    expect(getPluginThreadRowSubtitle("thr_old")).toBeNull();
    expect(getPluginThreadRowSubtitle("thr_new")).toBe("New");
    clearPluginThreadRowSubtitles("glance");
    expect(getPluginThreadRowSubtitle("thr_new")).toBeNull();
    expect(getPluginThreadRowSubtitle("thr_other")).toBe("Other");
  });
});
