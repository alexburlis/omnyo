import { describe, expect, it } from "vitest";
import { migrateLegacyBrowserStorageV1 } from "./legacy-browser-storage-v1";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  readonly mutations: string[] = [];

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.mutations.push("clear");
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.mutations.push(`remove:${key}`);
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.mutations.push(`set:${key}`);
    this.values.set(key, value);
  }

  snapshot(): [string, string][] {
    return [...this.values.entries()];
  }
}

const pending = {
  id: "pending_stable",
  projectId: "project-stable",
  realThreadId: null,
};

const submission = {
  id: "request-stable",
  scope: { kind: "new-thread" },
  draft: JSON.stringify({ text: "Unsent work" }),
};

const records = [
  {
    label: "pending top-level",
    owner: "pending",
    legacy: [{ ...pending, future: "old" }],
    canonical: [{ ...pending, future: "new" }],
  },
  {
    label: "pending nested",
    owner: "pending",
    legacy: [{ ...pending, future: { nested: { value: "old" } } }],
    canonical: [{ ...pending, future: { nested: { value: "new" } } }],
  },
  {
    label: "composer top-level",
    owner: "composer",
    legacy: [{ ...submission, future: "old" }],
    canonical: [{ ...submission, future: "new" }],
  },
  {
    label: "composer nested scope",
    owner: "composer",
    legacy: [
      {
        ...submission,
        scope: { kind: "new-thread", future: { value: "old" } },
      },
    ],
    canonical: [
      {
        ...submission,
        scope: { kind: "new-thread", future: { value: "new" } },
      },
    ],
  },
] as const;

function stores(owner: "pending" | "composer") {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  local.setItem("bb.desktopUpdateLaterVersion", "0.46.20");
  session.setItem("unrelated-key", "unrelated raw value");

  if (owner === "composer")
    session.setItem("bb.composer-submission-tab.v1", "stable-tab");
  const storage = owner === "pending" ? session : local;

  const suffix =
    owner === "pending"
      ? "pending-chats.v1"
      : "composer-submissions.v1.stable-tab";

  return {
    local,
    session,
    storage,
    legacyKey: `bb.${suffix}`,
    canonicalKey: `omnyo.${suffix}`,
  };
}

describe("finite browser importer unknown-field authority", () => {
  it.each(records)(
    "refuses differing $label bytes before any writes",
    ({ owner, legacy, canonical }) => {
      const input = stores(owner);
      input.storage.setItem(input.legacyKey, JSON.stringify(legacy));
      input.storage.setItem(input.canonicalKey, JSON.stringify(canonical));

      const before = {
        local: input.local.snapshot(),
        session: input.session.snapshot(),
      };

      input.local.mutations.length = 0;
      input.session.mutations.length = 0;
      expect(() => migrateLegacyBrowserStorageV1(input)).toThrow(/conflict/i);
      expect(input.local.snapshot()).toEqual(before.local);
      expect(input.session.snapshot()).toEqual(before.session);
      expect(input.local.mutations).toEqual([]);
      expect(input.session.mutations).toEqual([]);
    },
  );

  it.each(["pending", "composer"] as const)(
    "accepts equal %s records without discarding nested unknown fields",
    (owner) => {
      const input = stores(owner);
      const base = owner === "pending" ? pending : submission;

      const oldRaw = JSON.stringify(
        [{ ...base, future: { z: [1, { b: true, a: null }], a: "preserved" } }],
        null,
        2,
      );

      const newRaw = JSON.stringify([
        { future: { a: "preserved", z: [1, { a: null, b: true }] }, ...base },
      ]);

      input.storage.setItem(input.legacyKey, oldRaw);
      input.storage.setItem(input.canonicalKey, newRaw);
      migrateLegacyBrowserStorageV1(input);
      expect(input.storage.getItem(input.legacyKey)).toBeNull();
      expect(input.storage.getItem(input.canonicalKey)).toBe(newRaw);

      const before = {
        local: input.local.snapshot(),
        session: input.session.snapshot(),
      };

      migrateLegacyBrowserStorageV1(input);
      expect(input.local.snapshot()).toEqual(before.local);
      expect(input.session.snapshot()).toEqual(before.session);
    },
  );

  it.each(["pending", "composer"] as const)(
    "copies old-only %s records with exact raw unknown bytes",
    (owner) => {
      const input = stores(owner);
      const base = owner === "pending" ? pending : submission;

      const raw = JSON.stringify(
        [{ ...base, future: { opaque: ["unknown", { retained: true }] } }],
        null,
        2,
      );

      input.storage.setItem(input.legacyKey, raw);
      migrateLegacyBrowserStorageV1(input);
      expect(input.storage.getItem(input.legacyKey)).toBeNull();
      expect(input.storage.getItem(input.canonicalKey)).toBe(raw);
      expect(input.session.getItem("unrelated-key")).toBe(
        "unrelated raw value",
      );
    },
  );
});


describe("finite Branch Tree browser admission", () => {
  const legacyKey = "bb:branch-tree:collapsed:v1";
  const canonicalKey = "omnyo:branch-tree:collapsed:v1";
  const raw = '[\n  "project:bb/user-name", "chat:thr_stable", "section:opaque/../用户"\n]';

  it("copies exact raw opaque IDs before removing the legacy key and preserves later canonical work", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem(legacyKey, raw);
    local.mutations.length = 0;
    migrateLegacyBrowserStorageV1({ local, session });
    expect(local.getItem(canonicalKey)).toBe(raw);
    expect(local.getItem(legacyKey)).toBeNull();
    expect(local.mutations).toEqual([`set:${canonicalKey}`, `remove:${legacyKey}`]);
    const later = '["chat:thr_later", "opaque-bb-value"]';
    local.setItem(canonicalKey, later);
    local.mutations.length = 0;
    migrateLegacyBrowserStorageV1({ local, session });
    expect(local.getItem(canonicalKey)).toBe(later);
    expect(local.mutations).toEqual([]);
  });

  it("accepts equal dual arrays while preserving canonical raw bytes", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const canonical = JSON.stringify(JSON.parse(raw));
    local.setItem(legacyKey, raw);
    local.setItem(canonicalKey, canonical);
    migrateLegacyBrowserStorageV1({ local, session });
    expect(local.getItem(canonicalKey)).toBe(canonical);
    expect(local.getItem(legacyKey)).toBeNull();
  });

  it("refuses unequal arrays before any other planned preference write", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem("bb.desktopUpdateLaterVersion", "0.46.20");
    local.setItem(legacyKey, raw);
    local.setItem(canonicalKey, '["chat:thr_other"]');
    const before = local.snapshot();
    local.mutations.length = 0;
    expect(() => migrateLegacyBrowserStorageV1({ local, session })).toThrow(/conflict/i);
    expect(local.snapshot()).toEqual(before);
    expect(local.mutations).toEqual([]);
  });

  it.each([legacyKey, canonicalKey])("refuses malformed %s before any writes", (key) => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem("bb.desktopUpdateLaterVersion", "0.46.20");
    local.setItem(key, '[{"opaque":"wrong-shape"}]');
    const before = local.snapshot();
    local.mutations.length = 0;
    expect(() => migrateLegacyBrowserStorageV1({ local, session })).toThrow(/invalid/i);
    expect(local.snapshot()).toEqual(before);
    expect(local.mutations).toEqual([]);
  });

  it("retains the original on quota failure and resumes through the same owner", () => {
    class QuotaStorage extends MemoryStorage {
      failCopy = true;
      override setItem(key: string, value: string): void {
        if (key === canonicalKey && this.failCopy) throw new Error("quota exceeded");
        super.setItem(key, value);
      }
    }

    const local = new QuotaStorage();
    const session = new MemoryStorage();
    local.setItem(legacyKey, raw);
    expect(() => migrateLegacyBrowserStorageV1({ local, session })).toThrow(/quota/i);
    expect(local.getItem(legacyKey)).toBe(raw);
    expect(local.getItem(canonicalKey)).toBeNull();
    local.failCopy = false;
    migrateLegacyBrowserStorageV1({ local, session });
    expect(local.getItem(canonicalKey)).toBe(raw);
    expect(local.getItem(legacyKey)).toBeNull();
  });
});
