import { createMMKV, existsMMKV, type MMKV } from "react-native-mmkv";
import { Platform } from "react-native";
import {
  adoptLegacyPreferencesV1,
  adoptLegacyOpaquePreferencesV1,
  validateCanonicalPreferencesV1,
  validateCanonicalOpaquePreferencesV1,
} from "./legacy-preferences-storage-v1";
import {
  assertPreferenceIntegrityV1,
  assertPreferenceOwnerAvailableV1,
  preferenceRecordDigestsV1,
} from "./preferences-records-v1";

let storage: MMKV | null = null;

export function getPreferencesStorage(): MMKV {
  if (storage !== null) return storage;
  const legacyExists = existsMMKV("bb.preferences");
  const canonicalExists = existsMMKV("omnyo.preferences");

  if (Platform.OS === "ios") {
    assertPreferenceOwnerAvailableV1();

    if (legacyExists) assertPreferenceIntegrityV1("bb.preferences");

    if (canonicalExists) assertPreferenceIntegrityV1("omnyo.preferences");
  }

  const canonical = createMMKV({ id: "omnyo.preferences" });

  if (legacyExists) {
    const source = createMMKV({
      id: "bb.preferences",
      readOnly: Platform.OS === "ios",
    });

    if (Platform.OS === "ios")
      adoptLegacyOpaquePreferencesV1(source, canonical, {
        sourceRecords: () => preferenceRecordDigestsV1("bb.preferences"),
        targetRecords: () => preferenceRecordDigestsV1("omnyo.preferences"),
        importAll: () => canonical.importAllFrom(source),
        remove: (key) => {
          canonical.remove(key);
        },
      });
    else adoptLegacyPreferencesV1(source, canonical);
  } else if (Platform.OS === "ios")
    validateCanonicalOpaquePreferencesV1(canonical);
  else validateCanonicalPreferencesV1(canonical);
  storage = canonical;

  return storage;
}
