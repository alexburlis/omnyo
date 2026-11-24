import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TREE_HEIGHT, readStoredTreeHeight } from "./file-tree-height";

const LEGACY_KEY = "bb-plugin-monaco-editor:file-tree-height";

const CANONICAL_KEY = "omnyo-plugin-monaco-editor:file-tree-height";

function memoryStorage() {
  const values = new Map<string, string>();

  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("readStoredTreeHeight", () => {
  let localStorage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    localStorage = memoryStorage();
    vi.stubGlobal("window", { localStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves the old key once and then reads only the new key", () => {
    localStorage.values.set(LEGACY_KEY, "300");

    expect(readStoredTreeHeight()).toBe(300);
    expect(localStorage.values.get(CANONICAL_KEY)).toBe("300");
    expect(localStorage.values.has(LEGACY_KEY)).toBe(false);
  });

  it("prefers the new key over a stale old copy", () => {
    localStorage.values.set(CANONICAL_KEY, "200");
    localStorage.values.set(LEGACY_KEY, "400");

    expect(readStoredTreeHeight()).toBe(200);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(readStoredTreeHeight()).toBe(DEFAULT_TREE_HEIGHT);
  });
});
