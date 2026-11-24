import { describe, expect, it } from "vitest";
import {
  PROFILE_INDEX_STORAGE_KEY,
  createProfileStore,
  profileStorageKey,
} from "./profile-store";
import { createMemorySecureStorage } from "./secure-storage";

function makeStore(storage = createMemorySecureStorage()) {
  let counter = 0;

  const store = createProfileStore({
    storage,
    now: () => 1_700_000_000_000,
    generateId: () => `id-${++counter}`,
  });

  return { store, storage };
}

const direct = {
  mode: "direct" as const,
  serverUrl: "http://127.0.0.1:20304",
  label: "Simulator",
};

const connect = {
  mode: "connect" as const,
  serverUrl: "https://bee.example.test",
  label: "bee",
  handle: "bee",
  credential: "bbcm_secret",
};

describe("profile store", () => {
  it.each([
    {
      name: "an intentionally empty server list",
      index: JSON.stringify({ ids: [], activeProfileId: null }),
      profiles: [],
      activeProfileId: null,
    },
    {
      name: "an existing selected server",
      index: JSON.stringify({ ids: ["saved"], activeProfileId: "saved" }),
      profiles: [{ ...direct, id: "saved", createdAt: 1 }],
      activeProfileId: "saved",
    },
  ])(
    "preserves $name without writing",
    async ({ index, profiles, activeProfileId }) => {
      const storage = createMemorySecureStorage({
        [PROFILE_INDEX_STORAGE_KEY]: index,
        ...Object.fromEntries(
          profiles.map((profile) => [
            profileStorageKey(profile.id),
            JSON.stringify(profile),
          ]),
        ),
      });

      const before = new Map(storage.entries);
      const { store } = makeStore(storage);

      expect(await store.load()).toMatchObject({ profiles, activeProfileId });
      expect(storage.entries).toEqual(before);
    },
  );

  it("keeps a fresh installation empty", async () => {
    const { store, storage } = makeStore();

    expect(await store.load()).toMatchObject({
      profiles: [],
      activeProfileId: null,
    });
    expect(storage.entries.size).toBe(0);
  });

  it("persists one key per profile plus an index, and activates the first profile", async () => {
    const { store, storage } = makeStore();
    await store.load();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(connect);

    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      activeProfileId: a.id,
      profiles: [a, b],
    });
    expect(JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!)).toEqual(
      {
        ids: [a.id, b.id],
        activeProfileId: a.id,
      },
    );
    expect(JSON.parse(storage.entries.get(profileStorageKey(b.id))!)).toEqual({
      ...connect,
      id: b.id,
      createdAt: 1_700_000_000_000,
    });
  });

  it("reloads from storage in a fresh store", async () => {
    const { store, storage } = makeStore();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(connect);
    await store.setActiveProfile(b.id);

    const { store: reloaded } = makeStore(storage);
    const state = await reloaded.load();
    expect(state.profiles).toEqual([a, b]);
    expect(state.activeProfileId).toBe(b.id);
    expect(reloaded.getSnapshot().activeProfileId).toBe(b.id);
  });

  it("removeProfile deletes the key, heals the active id, and notifies listeners", async () => {
    const { store, storage } = makeStore();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(connect);
    let notified = 0;
    store.subscribe(() => notified++);

    await store.removeProfile(a.id);
    expect(store.listProfiles()).toEqual([b]);
    expect(store.getSnapshot().activeProfileId).toBe(b.id);
    expect(storage.entries.has(profileStorageKey(a.id))).toBe(false);
    expect(notified).toBeGreaterThan(0);

    await store.removeProfile(b.id);
    expect(store.getSnapshot().activeProfileId).toBeNull();
    expect(JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!)).toEqual(
      {
        ids: [],
        activeProfileId: null,
      },
    );
  });

  it("updateProfile validates the result and keeps mode-specific fields honest", async () => {
    const { store } = makeStore();
    const a = await store.addProfile(direct);
    const c = await store.addProfile(connect);

    const renamed = await store.updateProfile(a.id, { label: "Mac" });
    expect(renamed).toEqual({ ...a, label: "Mac" });
    await expect(
      store.updateProfile(a.id, { credential: "bbcm_x" }),
    ).rejects.toThrow(/Direct profiles/);
    await expect(store.updateProfile(a.id, { label: "" })).rejects.toThrow();

    const rotated = await store.updateProfile(c.id, {
      credential: "bbcm_new",
      label: undefined,
    });

    expect(rotated).toEqual({ ...c, credential: "bbcm_new" });
    await expect(store.updateProfile("nope", { label: "x" })).rejects.toThrow(
      /Unknown/,
    );
  });

  it("setActiveProfile rejects unknown ids and persists the choice", async () => {
    const { store, storage } = makeStore();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(connect);
    await expect(store.setActiveProfile("ghost")).rejects.toThrow(/Unknown/);
    await store.setActiveProfile(b.id);
    expect(store.getSnapshot().activeProfileId).toBe(b.id);
    await store.setActiveProfile(null);
    expect(store.getSnapshot().activeProfileId).toBeNull();
    expect(JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!)).toEqual(
      {
        ids: [a.id, b.id],
        activeProfileId: null,
      },
    );
  });

  it("preserves corrupt or missing profile records without healing away the saved index", async () => {
    const storage = createMemorySecureStorage({
      [PROFILE_INDEX_STORAGE_KEY]: JSON.stringify({
        ids: ["good", "missing", "corrupt"],
        activeProfileId: "missing",
      }),
      [profileStorageKey("good")]: JSON.stringify({
        ...direct,
        id: "good",
        createdAt: 1,
      }),
      [profileStorageKey("corrupt")]: "{not json",
    });

    const before = new Map(storage.entries);
    const { store } = makeStore(storage);
    await expect(store.load()).rejects.toThrow(/could not be read/);
    expect(storage.entries).toEqual(before);
  });

  it("rejects a damaged canonical index without changing storage", async () => {
    const storage = createMemorySecureStorage({
      [PROFILE_INDEX_STORAGE_KEY]: "{not json",
    });

    const before = new Map(storage.entries);
    const { store } = makeStore(storage);
    await expect(store.load()).rejects.toThrow(/index is invalid/);
    expect(storage.entries).toEqual(before);
  });

  it("refuses profiles that would exceed the SecureStore value limit", async () => {
    const { store } = makeStore();
    await expect(
      store.addProfile({ ...connect, credential: "x".repeat(2100) }),
    ).rejects.toThrow(/too large/);
    expect(store.listProfiles()).toEqual([]);
  });

  it("serializes concurrent mutations so the index never loses a profile", async () => {
    const { store, storage } = makeStore();

    const [a, b, c] = await Promise.all([
      store.addProfile(direct),
      store.addProfile(connect),
      store.addProfile({ ...direct, label: "LAN" }),
    ]);

    expect(
      JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!).ids,
    ).toEqual([a.id, b.id, c.id]);
  });
});

it("migrates active and inactive relay profiles in place and retries a partial write", async () => {
  const profiles = [
    {
      ...connect,
      id: "active",
      createdAt: 1,
      serverUrl: "https://bee.slashnew.com",
    },
    {
      ...connect,
      id: "inactive",
      createdAt: 2,
      serverUrl: "https://bee.stg.slashnew.com",
    },
    { ...direct, id: "direct", createdAt: 3 },
    {
      ...direct,
      id: "private-direct",
      createdAt: 5,
      serverUrl: "https://app.example.invalid",
    },
    {
      ...direct,
      id: "custom",
      createdAt: 4,
      serverUrl: "https://bee.slashnew.com.example",
    },
  ];

  const storage = createMemorySecureStorage({
    [PROFILE_INDEX_STORAGE_KEY]: JSON.stringify({
      ids: profiles.map((p) => p.id),
      activeProfileId: "active",
    }),
    ...Object.fromEntries(
      profiles.map((p) => [profileStorageKey(p.id), JSON.stringify(p)]),
    ),
  });

  const write = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = async (key, value) => {
    if (fail && key === profileStorageKey("inactive"))
      throw new Error("storage failure");
    await write(key, value);
  };

  const { store } = makeStore(storage);
  await expect(store.load()).rejects.toThrow("storage failure");
  expect(store.getSnapshot().status).toBe("loading");
  fail = false;
  const state = await store.load();
  expect(state.activeProfileId).toBe("active");
  expect(state.profiles).toEqual([
    { ...profiles[0], serverUrl: "https://bee.omnyo.link" },
    { ...profiles[1], serverUrl: "https://bee.stg.omnyo.link" },
    profiles[2],
    { ...profiles[3], serverUrl: "https://app.example.invalid" },
    profiles[4],
  ]);
  const bytes = new Map(storage.entries);
  await expect(makeStore(storage).store.load()).resolves.toMatchObject({
    profiles: state.profiles,
  });
  expect(storage.entries).toEqual(bytes);
});
