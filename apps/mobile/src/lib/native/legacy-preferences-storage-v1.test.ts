import { expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  createMemoryPushStorage,
  createPushStore,
} from "../../data/notifications/push-store";
import { createHapticsPreferenceStore } from "../haptics/haptics-policy";
import {
  adoptLegacyPreferencesV1,
  adoptLegacyOpaquePreferencesV1,
} from "./legacy-preferences-storage-v1";

function preferences(initial: Record<string, string> = {}) {
  const storage = createMemoryPushStorage();

  for (const [key, value] of Object.entries(initial)) storage.set(key, value);

  return { ...storage, getAllKeys: () => Object.keys(storage.dump()) };
}

const registration = {
  subscriptionId: "stable-registration",
  expoPushToken: "fixture",
  tokenSuffix: "fixture".slice(-6),
  platform: "ios",
  serverUrl: "https://example.invalid",
  registeredAt: 17,
};

it("preserves push consent and registration identity through the real push-store reader", () => {
  const source = preferences({
    "bb.theme": "dark",
    "bb.haptics.enabled": "false",
    "bb.push.prompted": "1",
    "bb.push.enabledProfiles": JSON.stringify(["stable-profile"]),
    "bb.push.enabled.stable-profile": "1",
    "bb.push.registrations": JSON.stringify(["stable-profile"]),
    "bb.push.registration.stable-profile": JSON.stringify(registration),
  });

  const target = preferences();
  const before = source.dump();
  adoptLegacyPreferencesV1(source, target);
  expect(createPushStore(target).getSnapshot()).toEqual({
    enabledProfileIds: ["stable-profile"],
    registrations: { "stable-profile": registration },
    prompted: true,
    enableFirstServer: false,
  });
  expect(target.getString("omnyo.theme")).toBe("dark");
  expect(createHapticsPreferenceStore(target).isEnabled()).toBe(false);
  expect(source.dump()).toEqual(before);
  const current = createPushStore(target);
  current.setEnabled("stable-profile", false);
  adoptLegacyPreferencesV1(source, target);
  expect(createPushStore(target).isEnabled("stable-profile")).toBe(false);
});

it("refuses two populated preference stores instead of merging even equal selected values", () => {
  const source = preferences({ "bb.theme": "dark" });
  const target = preferences({ "omnyo.theme": "dark" });
  const before = target.dump();
  expect(() => adoptLegacyPreferencesV1(source, target)).toThrow(/collision/i);
  expect(target.dump()).toEqual(before);
});

it("resumes a partial owned copy after response loss", () => {
  const source = preferences({
    "bb.theme": "dark",
    "bb.haptics.enabled": "false",
  });

  const target = preferences();
  let lost = false;
  expect(() =>
    adoptLegacyPreferencesV1(source, {
      ...target,
      set(key, value) {
        target.set(key, value);

        if (key === "omnyo.theme") {
          lost = true;
          throw new Error("Response lost");
        }
      },
    }),
  ).toThrow("Response lost");
  expect(lost).toBe(true);
  adoptLegacyPreferencesV1(source, target);
  expect(target.getString("omnyo.theme")).toBe("dark");
  expect(target.getString("omnyo.haptics.enabled")).toBe("false");
});

it("refuses malformed legacy preferences before writing a destination receipt", () => {
  const source = preferences({ "bb.push.registrations": "{broken" });
  const target = preferences();
  expect(() => adoptLegacyPreferencesV1(source, target)).toThrow(/invalid/i);
  expect(target.dump()).toEqual({});
});

it("refuses a changed source key set during interrupted migration", () => {
  const source = preferences({ "bb.theme": "dark" });
  const target = preferences();
  expect(() =>
    adoptLegacyPreferencesV1(source, {
      ...target,
      set(key, value) {
        target.set(key, value);
        throw new Error("Interrupted");
      },
    }),
  ).toThrow("Interrupted");
  source.set("bb.haptics.enabled", "true");
  expect(() => adoptLegacyPreferencesV1(source, target)).toThrow(/changed/i);
});

it("refuses changed source values after receipt preparation without copying the changed payload", () => {
  const source = preferences({ "bb.theme": "dark" });
  const target = preferences();
  expect(() =>
    adoptLegacyPreferencesV1(source, {
      ...target,
      set(key, value) {
        target.set(key, value);
        throw new Error("Interrupted");
      },
    }),
  ).toThrow("Interrupted");
  source.set("bb.theme", "light");
  expect(() => adoptLegacyPreferencesV1(source, target)).toThrow(/changed/i);
  expect(target.getString("omnyo.theme")).toBeUndefined();
});

function opaquePreferences(
  initial: Record<string, string | number | boolean | Uint8Array> = {},
) {
  const entries = new Map(Object.entries(initial));

  return {
    entries,
    getAllKeys: () => [...entries.keys()],
    getString(key: string) {
      const value = entries.get(key);

      return typeof value === "string" ? value : undefined;
    },
    set(key: string, value: string) {
      entries.set(key, value);
    },
    snapshot() {
      return new Map(
        [...entries].map(([key, value]) => [
          key,
          bytesToHex(
            sha256(
              utf8ToBytes(
                JSON.stringify(
                  value instanceof Uint8Array
                    ? ["buffer", [...value]]
                    : [typeof value, value],
                ),
              ),
            ),
          ),
        ]),
      );
    },
  };
}

function opaqueOwner(
  source: ReturnType<typeof opaquePreferences>,
  target: ReturnType<typeof opaquePreferences>,
) {
  return {
    sourceRecords: () => source.snapshot(),
    targetRecords: () => target.snapshot(),
    importAll() {
      for (const [key, value] of source.entries)
        target.entries.set(
          key,
          value instanceof Uint8Array ? value.slice() : value,
        );

      return source.entries.size;
    },
    remove: (key: string) => {
      target.entries.delete(key);
    },
  };
}

it("retains opaque booleans, numbers, binary bytes and user key spellings while renaming only owned preferences", () => {
  const source = opaquePreferences({
    "bb.theme": "dark",
    "opaque.boolean": false,
    "opaque.number": 12.25,
    "bb.user.note": new Uint8Array([0, 255, 9]),
  });

  const before = source.snapshot();
  const target = opaquePreferences();
  adoptLegacyOpaquePreferencesV1(source, target, opaqueOwner(source, target));
  expect(target.entries.get("opaque.boolean")).toBe(false);
  expect(target.entries.get("opaque.number")).toBe(12.25);
  expect(target.entries.get("bb.user.note")).toEqual(
    new Uint8Array([0, 255, 9]),
  );
  expect(target.getString("omnyo.theme")).toBe("dark");
  expect(target.entries.has("bb.theme")).toBe(false);
  expect(source.snapshot()).toEqual(before);
  target.entries.set("opaque.number", 99);
  adoptLegacyOpaquePreferencesV1(source, target, opaqueOwner(source, target));
  expect(target.entries.get("opaque.number")).toBe(99);
});

it("resumes an interrupted native raw copy and preserves typed opaque values", () => {
  const source = opaquePreferences({
    "bb.theme": "dark",
    "unknown.bytes": new Uint8Array([255, 0, 128]),
  });

  const target = opaquePreferences();
  const owner = opaqueOwner(source, target);
  expect(() =>
    adoptLegacyOpaquePreferencesV1(source, target, {
      ...owner,
      importAll() {
        target.entries.set("unknown.bytes", new Uint8Array([255, 0, 128]));
        throw new Error("Native copy interrupted");
      },
    }),
  ).toThrow("Native copy interrupted");
  expect(target.getString("omnyo.theme")).toBeUndefined();
  adoptLegacyOpaquePreferencesV1(source, target, owner);
  expect(target.getString("omnyo.theme")).toBe("dark");
  expect(target.entries.get("unknown.bytes")).toEqual(
    new Uint8Array([255, 0, 128]),
  );
});

it("refuses changed opaque source or destination bytes before repeating a raw import", () => {
  const source = opaquePreferences({
    "bb.theme": "dark",
    "unknown.bytes": new Uint8Array([1, 2, 3]),
  });

  const target = opaquePreferences();
  const owner = opaqueOwner(source, target);
  expect(() =>
    adoptLegacyOpaquePreferencesV1(source, target, {
      ...owner,
      importAll() {
        owner.importAll();
        throw new Error("Response lost");
      },
    }),
  ).toThrow("Response lost");
  target.entries.set("unknown.bytes", new Uint8Array([9, 9, 9]));
  expect(() => adoptLegacyOpaquePreferencesV1(source, target, owner)).toThrow(
    /conflict/i,
  );
  expect(target.entries.get("unknown.bytes")).toEqual(
    new Uint8Array([9, 9, 9]),
  );
  target.entries.set("unknown.bytes", new Uint8Array([1, 2, 3]));
  source.entries.set("unknown.bytes", new Uint8Array([0, 0, 0]));
  expect(() => adoptLegacyOpaquePreferencesV1(source, target, owner)).toThrow(
    /changed/i,
  );
  expect(target.entries.get("unknown.bytes")).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});

it("refuses populated opaque target stores even when native record values match", () => {
  const source = opaquePreferences({ "bb.user.flag": true });
  const target = opaquePreferences({ "bb.user.flag": true });
  const before = target.snapshot();
  expect(() =>
    adoptLegacyOpaquePreferencesV1(source, target, opaqueOwner(source, target)),
  ).toThrow(/collision/i);
  expect(target.snapshot()).toEqual(before);
});
