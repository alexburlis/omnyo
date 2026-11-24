import { expect, it } from "vitest";
import { createMemorySecureStorage } from "../profiles/secure-storage";
import { createMigratingSessionCacheV1 } from "./legacy-session-storage-v1";

const stored = {
  serverUrl: "https://example.invalid",
  credential: "fixture",
  session: {
    cookie: {
      domain: "example.invalid",
      expiresAt: 1700000000000,
      name: "session",
      value: "fixture",
    },
  },
};

const raw = JSON.stringify(stored);

it("adopts the same opaque session bytes and preserves expiry under the same profile", async () => {
  const storage = createMemorySecureStorage({
    "bb.connectSession.profile": raw,
  });

  const cache = createMigratingSessionCacheV1(storage);
  expect(await cache.read("profile")).toEqual(stored);
  expect(storage.entries.get("omnyo.connectSession.profile")).toBe(raw);
  expect(storage.entries.get("bb.connectSession.profile")).toBe(raw);
  await cache.clear("profile");
  expect(
    await createMigratingSessionCacheV1(storage).read("profile"),
  ).toBeNull();
});

it("refuses conflicting stored sessions without changing either", async () => {
  const canonical = JSON.stringify({
    ...stored,
    serverUrl: "https://other.invalid",
  });

  const storage = createMemorySecureStorage({
    "bb.connectSession.profile": raw,
    "omnyo.connectSession.profile": canonical,
  });

  const before = new Map(storage.entries);
  await expect(
    createMigratingSessionCacheV1(storage).read("profile"),
  ).rejects.toThrow(/conflict/i);
  expect(storage.entries).toEqual(before);
});

it("recovers response loss after copy and does not overwrite a later refreshed session", async () => {
  const storage = createMemorySecureStorage({
    "bb.connectSession.profile": raw,
  });

  let interrupted = true;

  const cache = createMigratingSessionCacheV1({
    ...storage,
    async setItem(key, value) {
      await storage.setItem(key, value);

      if (interrupted) {
        interrupted = false;
        throw new Error("Response lost");
      }
    },
  });

  await expect(cache.read("profile")).rejects.toThrow("Response lost");
  expect(await cache.read("profile")).toEqual(stored);

  const refreshed = {
    ...stored,
    session: { cookie: { ...stored.session.cookie, expiresAt: 1800000000000 } },
  };

  await cache.write("profile", refreshed);
  expect(await createMigratingSessionCacheV1(storage).read("profile")).toEqual(
    refreshed,
  );
});

it("rejects malformed legacy bytes while preserving the protected original", async () => {
  const storage = createMemorySecureStorage({
    "bb.connectSession.profile": "{broken",
  });

  await expect(
    createMigratingSessionCacheV1(storage).read("profile"),
  ).rejects.toThrow(/invalid/i);
  expect(storage.entries.size).toBe(1);
});
