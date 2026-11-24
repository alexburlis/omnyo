import { NativeModules } from "react-native";
import { z } from "zod";

const recordDigestsSchema = z.record(
  z.string(),
  z.string().regex(/^[a-f0-9]{64}$/u),
);

const recordResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), records: recordDigestsSchema }).strict(),
  z.object({ ok: z.literal(false), message: z.string().min(1) }).strict(),
]);

type PreferenceStoreId = "bb.preferences" | "omnyo.preferences";

function moduleBoundary() {
  const value: unknown = NativeModules.OmnyoPreferencesIdentityV1;

  if (
    typeof value !== "object" ||
    value === null ||
    !("recordDigestsV1" in value) ||
    typeof value.recordDigestsV1 !== "function" ||
    !("integrityV1" in value) ||
    typeof value.integrityV1 !== "function"
  ) {
    throw new Error(
      "The native preference migration owner is unavailable. No saved preferences were replaced.",
    );
  }

  const integrity = value.integrityV1;
  const records = value.recordDigestsV1;

  return {
    integrityV1: (id: PreferenceStoreId): unknown =>
      Reflect.apply(integrity, value, [id]),
    recordDigestsV1: (id: PreferenceStoreId): unknown =>
      Reflect.apply(records, value, [id]),
  };
}

export function assertPreferenceOwnerAvailableV1(): void {
  moduleBoundary();
}

export function assertPreferenceIntegrityV1(id: PreferenceStoreId): void {
  const native = moduleBoundary();
  const value: unknown = native.integrityV1(id);

  if (value !== true)
    throw new Error(
      "The saved preference store failed its native integrity check. Its original was preserved.",
    );
}

export function preferenceRecordDigestsV1(
  id: PreferenceStoreId,
): Map<string, string> {
  const native = moduleBoundary();
  const value: unknown = native.recordDigestsV1(id);

  const result = recordResultSchema.parse(value);

  if (!result.ok) throw new Error(result.message);

  return new Map(Object.entries(result.records));
}
