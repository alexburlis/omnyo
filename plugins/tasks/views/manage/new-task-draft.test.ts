// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  clearNewTaskDraft,
  loadNewTaskDraft,
  NEW_TASK_DRAFT_STORAGE_KEY,
} from "./new-task-draft.js";

const LEGACY_KEY = "bb-tasks:new-task-draft";

const stored = JSON.stringify({
  version: 1,
  projectId: null,
  title: "Keep this text",
  description: "",
  status: "todo",
  priority: "none",
  labelIds: [],
  dueDate: "",
});

afterEach(() => window.localStorage.clear());

describe("legacy new-task draft", () => {
  it("loads a saved draft from the legacy key and retires that key", () => {
    window.localStorage.setItem(LEGACY_KEY, stored);
    expect(loadNewTaskDraft()?.title).toBe("Keep this text");
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(window.localStorage.getItem(NEW_TASK_DRAFT_STORAGE_KEY)).toBe(
      stored,
    );
  });

  it("does not bring a cleared draft back from the legacy key", () => {
    window.localStorage.setItem(LEGACY_KEY, stored);
    clearNewTaskDraft();
    expect(loadNewTaskDraft()).toBeNull();
  });

  it("ignores an invalid legacy draft", () => {
    window.localStorage.setItem(LEGACY_KEY, "{not json");
    expect(loadNewTaskDraft()).toBeNull();
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});
