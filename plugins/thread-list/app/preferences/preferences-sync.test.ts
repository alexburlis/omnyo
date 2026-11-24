// @vitest-environment jsdom

import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemotePreferenceSignal,
  attachPreferencesStore,
  flushPreferenceWritesForTest,
  hydratePreferences,
  hydratePreferencesFromMirror,
  preferencesMirrorStorageKey,
  preferencesReadyAtom,
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
  type PreferencesRpc,
} from "./preferences-sync.js";
import { createSyncedPreferenceAtom } from "./synced-preference-atom.js";
import { defaultPreferences } from "../../shared/preferences.js";

function fakeRpc(
  preferences: Record<string, unknown> = {},
): PreferencesRpc & { calls: { method: string; input: unknown }[] } {
  const calls: { method: string; input: unknown }[] = [];

  return {
    calls,
    async call(method: string, input: unknown) {
      calls.push({ method, input });

      if (method === "listPreferences") {
        return { preferences: { ...defaultPreferences(), ...preferences } };
      }

      const { key, value } = input as { key: string; value: unknown };

      return { key, value };
    },
  };
}

function deferredRpc(): PreferencesRpc & {
  writes: { key: string; value: unknown; origin: string }[];
  settleNextWrite: () => Promise<void>;
} {
  const writes: { key: string; value: unknown; origin: string }[] = [];
  const settlers: (() => void)[] = [];

  return {
    writes,
    async settleNextWrite() {
      settlers.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    },
    async call(method: string, input: unknown) {
      if (method === "listPreferences") {
        return { preferences: defaultPreferences() };
      }

      const write = input as { key: string; value: unknown; origin: string };
      writes.push(write);

      return new Promise((resolve) =>
        settlers.push(() => resolve({ key: write.key, value: write.value })),
      );
    },
  };
}

function memoryStorage(): Storage {
  const rows = new Map<string, string>();

  return {
    get length() {
      return rows.size;
    },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => {
      rows.delete(key);
    },
    setItem: (key, value) => {
      rows.set(key, String(value));
    },
  };
}

const MIRROR_KEY = preferencesMirrorStorageKey("thread-list");

let mirror: Storage;

beforeEach(() => {
  vi.useFakeTimers();
  mirror = memoryStorage();
  setPreferencesMirrorStorageForTest(mirror);
  attachPreferencesStore(getDefaultStore(), "thread-list");
});

afterEach(() => {
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
  vi.useRealTimers();
});

describe("preferences sync", () => {
  it("hydrates from the server, marks ready, and mirrors to localStorage", async () => {
    const store = getDefaultStore();
    const modeAtom = createSyncedPreferenceAtom("organizationMode");
    expect(store.get(preferencesReadyAtom())).toBe(false);
    await hydratePreferences(fakeRpc({ organizationMode: "machine" }));
    expect(store.get(preferencesReadyAtom())).toBe(true);
    expect(store.get(modeAtom)).toBe("machine");
    expect(
      JSON.parse(mirror.getItem(MIRROR_KEY) ?? "{}").organizationMode,
    ).toBe("machine");
  });

  it("paints from the mirror before the server answers and refuses malformed bytes", () => {
    mirror.setItem(
      MIRROR_KEY,
      JSON.stringify({
        organizationMode: "project",
        chronologicalSort: "nonsense",
      }),
    );
    const store = getDefaultStore();
    expect(hydratePreferencesFromMirror()).toBe(true);
    expect(store.get(createSyncedPreferenceAtom("organizationMode"))).toBe(
      "project",
    );
    expect(store.get(createSyncedPreferenceAtom("chronologicalSort"))).toBe(
      "updated",
    );
    mirror.setItem(MIRROR_KEY, "{not json");
    expect(() => hydratePreferencesFromMirror()).toThrow(/invalid/i);
  });

  it("keys the mirror by plugin id, so a renamed copy keeps its own layout", async () => {
    expect(MIRROR_KEY).toBe("omnyo.thread-list.preferences.v1");
    mirror.setItem(MIRROR_KEY, JSON.stringify({ organizationMode: "project" }));
    attachPreferencesStore(getDefaultStore(), "my-sidebar");

    expect(hydratePreferencesFromMirror()).toBe(false);
    await hydratePreferences(fakeRpc({ organizationMode: "machine" }));

    expect(
      JSON.parse(mirror.getItem("omnyo.my-sidebar.preferences.v1") ?? "{}")
        .organizationMode,
    ).toBe("machine");
    expect(
      JSON.parse(mirror.getItem(MIRROR_KEY) ?? "{}").organizationMode,
    ).toBe("project");
  });

  it("applies a local write immediately and coalesces the server write", async () => {
    const rpc = fakeRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const collapsedAtom = createSyncedPreferenceAtom("collapsedProjects");
    store.set(collapsedAtom, ["proj_a"]);
    store.set(collapsedAtom, (current) => [...current, "proj_b"]);
    store.set(collapsedAtom, (current) =>
      current.filter((id) => id !== "proj_a"),
    );
    expect(store.get(collapsedAtom)).toEqual(["proj_b"]);
    expect(
      rpc.calls.filter((call) => call.method === "setPreference"),
    ).toHaveLength(0);
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    expect(rpc.calls.filter((call) => call.method === "setPreference")).toEqual(
      [
        {
          method: "setPreference",
          input: {
            key: "collapsedProjects",
            value: ["proj_b"],
            origin: expect.any(String),
          },
        },
      ],
    );
  });

  it("takes a remote change from another window unless a local write is pending", async () => {
    const rpc = fakeRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const sortAtom = createSyncedPreferenceAtom("chronologicalSort");
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "alpha",
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("alpha");
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "bogus",
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("alpha");
    applyRemotePreferenceSignal({
      key: "nope",
      value: 1,
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("alpha");

    store.set(sortAtom, "created");
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "updated",
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("created");
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "updated",
      origin: null,
    });
    expect(store.get(sortAtom)).toBe("updated");
  });

  it("ignores the late echo of its own earlier write after the user toggles again", async () => {
    const rpc = deferredRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const collapsedAtom = createSyncedPreferenceAtom("collapsedProjects");
    const seen: string[][] = [];
    store.sub(collapsedAtom, () => seen.push(store.get(collapsedAtom)));

    store.set(collapsedAtom, ["proj_a"]);
    vi.advanceTimersByTime(150);
    await rpc.settleNextWrite();
    store.set(collapsedAtom, []);
    vi.advanceTimersByTime(150);
    await rpc.settleNextWrite();

    for (const write of rpc.writes) {
      applyRemotePreferenceSignal(write);
    }

    expect(seen).toEqual([["proj_a"], []]);
    expect(store.get(collapsedAtom)).toEqual([]);
  });

  it("sends one write per key at a time and follows up with the latest value", async () => {
    const rpc = deferredRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const collapsedAtom = createSyncedPreferenceAtom("collapsedProjects");

    store.set(collapsedAtom, ["proj_a"]);
    vi.advanceTimersByTime(150);
    store.set(collapsedAtom, []);
    vi.advanceTimersByTime(150);
    expect(rpc.writes.map((write) => write.value)).toEqual([["proj_a"]]);

    await rpc.settleNextWrite();
    expect(rpc.writes.map((write) => write.value)).toEqual([["proj_a"], []]);
    applyRemotePreferenceSignal({
      key: "collapsedProjects",
      value: ["proj_b"],
      origin: "other-window",
    });
    expect(store.get(collapsedAtom)).toEqual([]);

    await rpc.settleNextWrite();
    applyRemotePreferenceSignal({
      key: "collapsedProjects",
      value: ["proj_b"],
      origin: "other-window",
    });
    expect(store.get(collapsedAtom)).toEqual(["proj_b"]);
  });

  it("does not write back a value that did not change", async () => {
    const rpc = fakeRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const modeAtom = createSyncedPreferenceAtom("organizationMode");
    store.set(modeAtom, "chronological");
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    expect(
      rpc.calls.filter((call) => call.method === "setPreference"),
    ).toHaveLength(0);
  });
});

describe("preferences sync with a provided store", () => {
  it("reads and writes the attached store instead of the default one", async () => {
    const { createStore } = await import("jotai");
    const custom = createStore();
    attachPreferencesStore(custom, "thread-list");
    const modeAtom = createSyncedPreferenceAtom("organizationMode");
    await hydratePreferences(fakeRpc({ organizationMode: "machine" }));
    expect(custom.get(preferencesReadyAtom())).toBe(true);
    expect(custom.get(modeAtom)).toBe("machine");
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(false);
  });
});

describe("finite preferences mirror import V1", () => {
  const legacyKey = "bb.thread-list.preferences.v1";
  const receiptKey = "omnyo.thread-list.preferences-import.v1";

  const raw =
    '{ "organizationMode": "machine", "chronologicalSort": "future-sort", "futurePluginField": {"opaque":"保留%2f"} }';

  it("copies exact unacknowledged payload bytes for only this plugin and repeats without rewriting them", () => {
    mirror.setItem(legacyKey, raw);
    mirror.setItem("bb.foreign-plugin.preferences.v1", "foreign opaque bytes");
    expect(hydratePreferencesFromMirror()).toBe(true);
    expect(
      getDefaultStore().get(createSyncedPreferenceAtom("organizationMode")),
    ).toBe("machine");
    expect(mirror.getItem(MIRROR_KEY)).toBe(raw);
    expect(mirror.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(mirror.getItem(receiptKey) ?? "null")).toMatchObject({
      phase: "imported",
      originalRaw: raw,
    });
    expect(mirror.getItem("bb.foreign-plugin.preferences.v1")).toBe(
      "foreign opaque bytes",
    );
    expect(hydratePreferencesFromMirror()).toBe(true);
    expect(mirror.getItem(MIRROR_KEY)).toBe(raw);
  });

  it.each([raw, '{"organizationMode":"project"}'])(
    "refuses an unreceipted destination even when its bytes match: %s",
    (destination) => {
      mirror.setItem(legacyKey, raw);
      mirror.setItem(MIRROR_KEY, destination);
      expect(() => hydratePreferencesFromMirror()).toThrow(/conflict/i);
      expect(mirror.getItem(legacyKey)).toBe(raw);
      expect(mirror.getItem(MIRROR_KEY)).toBe(destination);
      expect(mirror.getItem(receiptKey)).toBeNull();
    },
  );

  it.each(["{invalid", "[]", "null"])(
    "preserves malformed legacy bytes and fails visibly: %s",
    (value) => {
      mirror.setItem(legacyKey, value);
      expect(() => hydratePreferencesFromMirror()).toThrow(/invalid/i);
      expect(mirror.getItem(legacyKey)).toBe(value);
      expect(mirror.getItem(MIRROR_KEY)).toBeNull();
      expect(mirror.getItem(receiptKey)).toBeNull();
    },
  );

  it.each(["receipt-write", "copy-write", "source-remove", "receipt-finalize"])(
    "preserves the exact payload through a storage fault at %s and resumes its matching receipt",
    (stage) => {
      mirror.setItem(legacyKey, raw);
      const originalSet = mirror.setItem.bind(mirror);
      const originalRemove = mirror.removeItem.bind(mirror);
      let failed = false;
      let receiptWrites = 0;

      const set = vi
        .spyOn(mirror, "setItem")
        .mockImplementation((key, value) => {
          if (key === receiptKey) receiptWrites += 1;

          if (
            !failed &&
            ((stage === "receipt-write" && key === receiptKey) ||
              (stage === "copy-write" && key === MIRROR_KEY) ||
              (stage === "receipt-finalize" &&
                key === receiptKey &&
                receiptWrites === 2))
          ) {
            failed = true;
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }

          originalSet(key, value);
        });

      const remove = vi
        .spyOn(mirror, "removeItem")
        .mockImplementation((key) => {
          if (!failed && stage === "source-remove" && key === legacyKey) {
            failed = true;
            throw new Error("Injected storage interruption");
          }

          originalRemove(key);
        });

      expect(() => hydratePreferencesFromMirror()).toThrow(
        /quota|interruption/i,
      );
      expect(failed).toBe(true);
      expect([mirror.getItem(legacyKey), mirror.getItem(MIRROR_KEY)]).toContain(
        raw,
      );
      set.mockRestore();
      remove.mockRestore();
      expect(hydratePreferencesFromMirror()).toBe(true);
      expect(mirror.getItem(MIRROR_KEY)).toBe(raw);
      expect(mirror.getItem(legacyKey)).toBeNull();
      expect(JSON.parse(mirror.getItem(receiptKey) ?? "null")).toMatchObject({
        phase: "imported",
        originalRaw: raw,
      });
    },
  );

  it.each(["source", "destination"])(
    "refuses changed %s bytes after a prepared receipt without losing either copy",
    (side) => {
      mirror.setItem(legacyKey, raw);
      const original = mirror.setItem.bind(mirror);

      const failure = vi
        .spyOn(mirror, "setItem")
        .mockImplementation((key, value) => {
          if (key === MIRROR_KEY)
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          original(key, value);
        });

      expect(() => hydratePreferencesFromMirror()).toThrow(/quota/i);
      failure.mockRestore();
      const changed = '{"organizationMode":"project","owner":"changed"}';
      mirror.setItem(side === "source" ? legacyKey : MIRROR_KEY, changed);
      expect(() => hydratePreferencesFromMirror()).toThrow(/conflict|changed/i);
      expect(mirror.getItem(side === "source" ? legacyKey : MIRROR_KEY)).toBe(
        changed,
      );
      expect(mirror.getItem(receiptKey)).not.toBeNull();

      if (side === "destination") expect(mirror.getItem(legacyKey)).toBe(raw);
    },
  );

  it("keeps unsupported fields while a new local change is still waiting for the debounced RPC", async () => {
    const rpc = fakeRpc();
    await hydratePreferences(rpc);
    mirror.removeItem(MIRROR_KEY);
    mirror.setItem(legacyKey, raw);
    expect(hydratePreferencesFromMirror()).toBe(true);
    getDefaultStore().set(
      createSyncedPreferenceAtom("organizationMode"),
      "project",
    );
    const stored = JSON.parse(mirror.getItem(MIRROR_KEY) ?? "{}");
    expect(stored).toMatchObject({
      organizationMode: "project",
      chronologicalSort: "future-sort",
      futurePluginField: { opaque: "保留%2f" },
    });
    expect(rpc.calls.filter((call) => call.method === "setPreference")).toEqual(
      [],
    );
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    expect(rpc.calls.filter((call) => call.method === "setPreference")).toEqual(
      [
        {
          method: "setPreference",
          input: {
            key: "organizationMode",
            value: "project",
            origin: expect.any(String),
          },
        },
      ],
    );
  });

  it("refuses unequal recognized server values without replaying old preference writes and retains both values", async () => {
    const imported = JSON.stringify({
      organizationMode: "machine",
      chronologicalSort: "created",
      futureField: "opaque",
    });

    mirror.setItem(legacyKey, imported);
    expect(hydratePreferencesFromMirror()).toBe(true);

    const rpc = fakeRpc({
      organizationMode: "project",
      chronologicalSort: "updated",
    });

    await expect(hydratePreferences(rpc)).rejects.toThrow(
      /conflict.*organizationMode.*chronologicalSort|conflict.*chronologicalSort.*organizationMode/i,
    );
    expect(mirror.getItem(MIRROR_KEY)).toBe(imported);
    expect(JSON.parse(mirror.getItem(receiptKey) ?? "null")).toMatchObject({
      originalRaw: imported,
      serverValues: {
        organizationMode: "project",
        chronologicalSort: "updated",
      },
    });
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(false);
    expect(rpc.calls.filter((call) => call.method === "setPreference")).toEqual(
      [],
    );
  });

  it("resolves only each explicitly acknowledged remote field and retains remaining original and unknown work", async () => {
    const imported = JSON.stringify({
      organizationMode: "machine",
      chronologicalSort: "created",
      futureField: "opaque",
    });

    mirror.setItem(legacyKey, imported);
    hydratePreferencesFromMirror();
    await expect(
      hydratePreferences(
        fakeRpc({ organizationMode: "project", chronologicalSort: "updated" }),
      ),
    ).rejects.toThrow(/conflict/i);
    applyRemotePreferenceSignal({
      key: "organizationMode",
      value: "project",
      origin: "other-window",
    });
    expect(JSON.parse(mirror.getItem(receiptKey) ?? "null")).toMatchObject({
      originalRaw: imported,
      acknowledged: { organizationMode: "project" },
    });
    expect(
      JSON.parse(mirror.getItem(receiptKey) ?? "null").acknowledged,
    ).not.toHaveProperty("chronologicalSort");
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(false);
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "updated",
      origin: "other-window",
    });
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(true);
    expect(JSON.parse(mirror.getItem(receiptKey) ?? "null")).toMatchObject({
      originalRaw: imported,
      acknowledged: {
        organizationMode: "project",
        chronologicalSort: "updated",
      },
    });
    expect(JSON.parse(mirror.getItem(MIRROR_KEY) ?? "null")).toMatchObject({
      organizationMode: "project",
      chronologicalSort: "updated",
      futureField: "opaque",
    });
  });

  it("recovers when the server later matches imported values without submitting them", async () => {
    mirror.setItem(legacyKey, raw);
    hydratePreferencesFromMirror();
    await expect(hydratePreferences(fakeRpc())).rejects.toThrow(/conflict/i);
    const rpc = fakeRpc({ organizationMode: "machine" });
    await hydratePreferences(rpc);
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(true);
    expect(JSON.parse(mirror.getItem(receiptKey) ?? "null")).toMatchObject({
      originalRaw: raw,
      acknowledged: { organizationMode: "machine" },
    });
    expect(JSON.parse(mirror.getItem(MIRROR_KEY) ?? "null")).toMatchObject({
      chronologicalSort: "future-sort",
      futurePluginField: { opaque: "保留%2f" },
    });
    expect(rpc.calls.filter((call) => call.method === "setPreference")).toEqual(
      [],
    );
  });

  it("uses an explicit local write acknowledgement for only its exact field and preserves another conflict", async () => {
    const imported = JSON.stringify({
      organizationMode: "machine",
      chronologicalSort: "created",
      futureField: "opaque",
    });

    mirror.setItem(legacyKey, imported);
    hydratePreferencesFromMirror();

    const rpc = fakeRpc({
      organizationMode: "project",
      chronologicalSort: "updated",
    });

    await expect(hydratePreferences(rpc)).rejects.toThrow(/conflict/i);
    getDefaultStore().set(
      createSyncedPreferenceAtom("organizationMode"),
      "project",
    );
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    expect(JSON.parse(mirror.getItem(receiptKey) ?? "null")).toMatchObject({
      originalRaw: imported,
      acknowledged: { organizationMode: "project" },
    });
    expect(
      JSON.parse(mirror.getItem(receiptKey) ?? "null").acknowledged,
    ).not.toHaveProperty("chronologicalSort");
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(false);
    expect(rpc.calls.filter((call) => call.method === "setPreference")).toEqual(
      [
        {
          method: "setPreference",
          input: {
            key: "organizationMode",
            value: "project",
            origin: expect.any(String),
          },
        },
      ],
    );
  });
});
