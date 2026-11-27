import { describe, expect, it } from "vitest";
import { readGlanceExpansion, writeGlanceExpansion } from "../lib/expansion-storage";

const oldKey = "bb:glance:expansion:thr_one";

const currentKey = "omnyo:glance:expansion:thr_one";

const raw = '{"revision":2,"open":true,"future":{"order":[2,1]}}';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("card expansion preferences", () => {
  it("ignores an obsolete preference without importing or removing it", () => {
    const input = storage({ [oldKey]: raw });
    expect(readGlanceExpansion(input, "glance", "thr_one")).toBeNull();
    expect(input.getItem(currentKey)).toBeNull();
    expect(input.getItem(oldKey)).toBe(raw);
  });

  it.each([raw, "{bad"])(
    "reads the current preference regardless of obsolete bytes: %s",
    (legacy) => {
      const current = '{"revision":3,"open":false,"future":{"order":[2,1]}}';
      const input = storage({ [oldKey]: legacy, [currentKey]: current });
      expect(readGlanceExpansion(input, "glance", "thr_one")).toEqual(JSON.parse(current));
      expect(input.getItem(currentKey)).toBe(current);
      expect(input.getItem(oldKey)).toBe(legacy);
    },
  );

  it("preserves current extension fields when saving the next choice", () => {
    const input = storage({ [currentKey]: raw, [oldKey]: "{bad" });
    expect(writeGlanceExpansion(input, "glance", "thr_one", { revision: 3, open: false })).toEqual({
      revision: 3,
      open: false,
      future: { order: [2, 1] },
    });
    expect(input.getItem(oldKey)).toBe("{bad");
    expect(JSON.parse(input.getItem(currentKey) ?? "null")).toEqual({
      revision: 3,
      open: false,
      future: { order: [2, 1] },
    });
  });

  it.each(['{"revision":0,"open":true}', "{bad"])(
    "rejects invalid current preferences without mutation: %s",
    (current) => {
      const input = storage({ [currentKey]: current });
      expect(() => readGlanceExpansion(input, "glance", "thr_one")).toThrow(/invalid/u);
      expect(input.getItem(currentKey)).toBe(current);
    },
  );

  it("preserves the saved choice when storage rejects a write", () => {
    const input = storage({ [currentKey]: raw });
    input.setItem = () => {
      throw new Error("quota");
    };

    expect(() =>
      writeGlanceExpansion(input, "glance", "thr_one", { revision: 3, open: false }),
    ).toThrow("quota");
    expect(input.getItem(currentKey)).toBe(raw);
  });

  it("reports an unverified write", () => {
    const input = storage({ [currentKey]: raw });
    input.setItem = () => {};

    expect(() =>
      writeGlanceExpansion(input, "glance", "thr_one", { revision: 3, open: false }),
    ).toThrow(/verified/u);
  });
});
