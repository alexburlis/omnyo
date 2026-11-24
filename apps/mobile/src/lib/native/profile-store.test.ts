import { expect, it, vi } from "vitest";

const secure = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  setItemAsync: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        omnyoMobileVariant: "private",
        defaultServerUrl: "https://app.example.invalid",
      },
    },
  },
}));

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => secure.entries.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secure.setItemAsync(key);
    secure.entries.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secure.entries.delete(key);
  },
}));

it("opens a fresh private installation with no saved server and writes nothing", async () => {
  const { getProfileStore } = await import("./profile-store");

  expect(await getProfileStore().load()).toMatchObject({
    status: "ready",
    profiles: [],
    activeProfileId: null,
  });
  expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(secure.entries.size).toBe(0);
});
