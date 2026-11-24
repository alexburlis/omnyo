import { expect, it } from "vitest";
import { createProfileStore } from "./profile-store";
import { createMemorySecureStorage } from "./secure-storage";

const profile = {
  id: "stable-profile",
  mode: "direct",
  serverUrl: "https://example.invalid",
  label: "Saved server",
  createdAt: 17,
};

const index = JSON.stringify({
  ids: [profile.id],
  activeProfileId: profile.id,
});

const profileBytes = JSON.stringify(profile);

function fixture() {
  return createMemorySecureStorage({
    "bb.profiles.index": index,
    [`bb.profile.${profile.id}`]: profileBytes,
  });
}

it("adopts existing profile IDs and selected server before publishing the canonical index", async () => {
  const storage = fixture();
  const writes: string[] = [];

  const store = createProfileStore({
    storage: {
      ...storage,
      async setItem(key, value) {
        writes.push(key);
        await storage.setItem(key, value);
      },
    },
  });

  expect(await store.load()).toMatchObject({
    profiles: [profile],
    activeProfileId: profile.id,
  });
  expect(storage.entries.get("omnyo.profile.stable-profile")).toBe(
    profileBytes,
  );
  expect(storage.entries.get("omnyo.profiles.index")).toBe(index);
  expect(writes.indexOf("omnyo.profile.stable-profile")).toBeLessThan(
    writes.indexOf("omnyo.profiles.index"),
  );
  expect(storage.entries.get("bb.profile.stable-profile")).toBe(profileBytes);
});

it("does not publish an index after interrupted entry copy and safely resumes", async () => {
  const storage = fixture();
  let fail = true;

  const interrupted = createProfileStore({
    storage: {
      ...storage,
      async setItem(key, value) {
        if (key.startsWith("omnyo.profile.") && fail) {
          fail = false;
          throw new Error("Interrupted secure write");
        }

        await storage.setItem(key, value);
      },
    },
  });

  await expect(interrupted.load()).rejects.toThrow("Interrupted secure write");
  expect(storage.entries.has("omnyo.profiles.index")).toBe(false);
  expect(storage.entries.get("bb.profiles.index")).toBe(index);
  expect(await createProfileStore({ storage }).load()).toMatchObject({
    profiles: [profile],
    activeProfileId: profile.id,
  });
});

it("refuses different old and new indexes without changing either", async () => {
  const storage = fixture();
  storage.entries.set(
    "omnyo.profiles.index",
    JSON.stringify({ ids: [], activeProfileId: null }),
  );
  const before = new Map(storage.entries);
  await expect(createProfileStore({ storage }).load()).rejects.toThrow(
    /conflict/i,
  );
  expect(storage.entries).toEqual(before);
});

it("refuses an existing different canonical profile without publishing an index", async () => {
  const storage = fixture();
  storage.entries.set(
    "omnyo.profile.stable-profile",
    JSON.stringify({ ...profile, label: "Other server" }),
  );
  const before = new Map(storage.entries);
  await expect(createProfileStore({ storage }).load()).rejects.toThrow(
    /conflict/i,
  );
  expect(storage.entries).toEqual(before);
});

it.each([
  "{invalid",
  JSON.stringify({ ids: ["stable-profile"], activeProfileId: "missing" }),
])(
  "refuses malformed legacy indexes instead of creating a blank replacement",
  async (raw) => {
    const storage = createMemorySecureStorage({ "bb.profiles.index": raw });
    const before = new Map(storage.entries);
    await expect(createProfileStore({ storage }).load()).rejects.toThrow(
      /profile/i,
    );
    expect(storage.entries).toEqual(before);
  },
);

it("does not reimport retained legacy recovery records after canonical edits", async () => {
  const storage = fixture();
  const store = createProfileStore({ storage });
  await store.load();
  await store.updateProfile(profile.id, { label: "Current label" });
  const reloaded = createProfileStore({ storage });
  expect(await reloaded.load()).toMatchObject({
    profiles: [{ ...profile, label: "Current label" }],
    activeProfileId: profile.id,
  });
  expect(
    JSON.parse(storage.entries.get("omnyo.profile.stable-profile") ?? "null"),
  ).toMatchObject({ label: "Current label" });
  expect(storage.entries.get("bb.profile.stable-profile")).toBe(profileBytes);
});

it("refuses changed source bytes after preparation and leaves the canonical index unpublished", async () => {
  const storage = fixture();

  const interrupted = createProfileStore({
    storage: {
      ...storage,
      async setItem(key, value) {
        await storage.setItem(key, value);
        throw new Error("Interrupted");
      },
    },
  });

  await expect(interrupted.load()).rejects.toThrow("Interrupted");
  storage.entries.set(
    "bb.profile.stable-profile",
    JSON.stringify({ ...profile, label: "Changed after preparation" }),
  );
  await expect(createProfileStore({ storage }).load()).rejects.toThrow(
    /source changed/i,
  );
  expect(storage.entries.has("omnyo.profiles.index")).toBe(false);
});

it("preserves an intentionally unselected active profile", async () => {
  const storage = fixture();
  storage.entries.set(
    "bb.profiles.index",
    JSON.stringify({ ids: [profile.id], activeProfileId: null }),
  );
  expect(await createProfileStore({ storage }).load()).toMatchObject({
    profiles: [profile],
    activeProfileId: null,
  });
});
