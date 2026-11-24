import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { pushRegistrationRecordSchema } from "../../data/notifications/push-store";

interface PreferenceStorage {
  getAllKeys(): string[];
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

const receiptKey = "omnyo.preferences.import.v1";

const receiptSchema = z
  .object({
    format: z.literal(1),
    phase: z.enum(["copying", "accepted"]),
    sourceKeys: z.array(z.string()),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const exactKeys = new Map([
  ["bb.theme", "omnyo.theme"],
  ["bb.haptics.enabled", "omnyo.haptics.enabled"],
  ["bb.push.prompted", "omnyo.push.prompted"],
  ["bb.push.registrations", "omnyo.push.registrations"],
  ["bb.push.enabledProfiles", "omnyo.push.enabledProfiles"],
]);

function canonicalKey(key: string): string {
  const exact = exactKeys.get(key);

  if (exact) return exact;

  for (const prefix of ["bb.push.enabled.", "bb.push.registration."])
    if (key.startsWith(prefix) && key.length > prefix.length)
      return `omnyo.${key.slice(3)}`;

  if (key.startsWith("bb."))
    throw new Error("Unknown legacy preference requires migration review.");

  return key;
}

function validate(key: string, value: string | undefined): string {
  if (value === undefined)
    throw new Error(
      "Saved preference has an unsupported value type. Its original was preserved.",
    );

  try {
    if (key === "omnyo.theme" && !["light", "dark", "system"].includes(value))
      throw new Error();

    if (key === "omnyo.haptics.enabled" && !["true", "false"].includes(value))
      throw new Error();

    if (
      (key === "omnyo.push.prompted" ||
        key.startsWith("omnyo.push.enabled.")) &&
      value !== "1"
    )
      throw new Error();

    if (
      key === "omnyo.push.registrations" ||
      key === "omnyo.push.enabledProfiles"
    )
      z.array(z.string().min(1)).parse(JSON.parse(value));

    if (key.startsWith("omnyo.push.registration."))
      pushRegistrationRecordSchema.parse(JSON.parse(value));

    return value;
  } catch {
    throw new Error("Saved preference is invalid. Its original was preserved.");
  }
}

function readReceipt(
  target: PreferenceStorage,
): z.infer<typeof receiptSchema> | null {
  const raw = target.getString(receiptKey);

  if (raw === undefined) {
    if (target.getAllKeys().includes(receiptKey))
      throw new Error(
        "Saved preference migration receipt has an invalid value type.",
      );

    return null;
  }

  try {
    return receiptSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Saved preference migration receipt is invalid.");
  }
}

function validateReferences(values: Map<string, string>): void {
  for (const [indexKey, prefix] of [
    ["omnyo.push.registrations", "omnyo.push.registration."],
    ["omnyo.push.enabledProfiles", "omnyo.push.enabled."],
  ]) {
    const raw = values.get(indexKey);

    if (raw === undefined) continue;
    const ids = z.array(z.string().min(1)).parse(JSON.parse(raw));

    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !values.has(`${prefix}${id}`))
    )
      throw new Error(
        "Saved preference index references invalid or missing records.",
      );
  }
}

export function validateCanonicalPreferencesV1(
  target: PreferenceStorage,
): void {
  const receipt = readReceipt(target);

  if (receipt?.phase === "copying")
    throw new Error(
      "Saved preference migration requires its original source to resume.",
    );
  const values = new Map<string, string>();

  for (const key of target.getAllKeys()) {
    if (key === receiptKey) continue;

    if (canonicalKey(key) !== key)
      throw new Error("Legacy preference key remains in canonical storage.");
    values.set(key, validate(key, target.getString(key)));
  }

  validateReferences(values);
}

export function adoptLegacyPreferencesV1(
  source: PreferenceStorage,
  target: PreferenceStorage,
): void {
  const receipt = readReceipt(target);

  if (receipt?.phase === "accepted") {
    validateCanonicalPreferencesV1(target);

    return;
  }

  const sourceKeys = source.getAllKeys().sort();

  if (!sourceKeys.length) {
    validateCanonicalPreferencesV1(target);

    return;
  }

  const copies = new Map<string, string>();
  const sourceValues: [string, string][] = [];

  for (const key of sourceKeys) {
    const canonical = canonicalKey(key);
    const value = validate(canonical, source.getString(key));
    sourceValues.push([key, value]);

    if (copies.has(canonical) && copies.get(canonical) !== value)
      throw new Error(
        "Saved preference key conflict. Both copies were preserved.",
      );
    copies.set(canonical, value);
  }

  validateReferences(copies);

  const sourceDigest = bytesToHex(
    sha256(utf8ToBytes(JSON.stringify(sourceValues))),
  );

  const existingKeys = target.getAllKeys().filter((key) => key !== receiptKey);

  if (receipt === null && existingKeys.length)
    throw new Error(
      "Saved preference storage collision. Both stores were preserved.",
    );

  if (
    receipt &&
    (JSON.stringify(receipt.sourceKeys) !== JSON.stringify(sourceKeys) ||
      receipt.sourceDigest !== sourceDigest)
  )
    throw new Error("Legacy preference storage changed during migration.");

  for (const key of existingKeys)
    if (!copies.has(key) || target.getString(key) !== copies.get(key))
      throw new Error(
        "Saved preference storage conflict. Both stores were preserved.",
      );

  function verifiedWrite(key: string, value: string): void {
    target.set(key, value);

    if (target.getString(key) !== value)
      throw new Error("Saved preference copy could not be verified.");
  }

  if (!receipt)
    verifiedWrite(
      receiptKey,
      JSON.stringify({ format: 1, phase: "copying", sourceKeys, sourceDigest }),
    );

  for (const [key, value] of copies)
    if (target.getString(key) !== value) verifiedWrite(key, value);

  for (const [key, value] of copies)
    if (target.getString(key) !== value)
      throw new Error("Saved preference copy changed before acceptance.");
  verifiedWrite(
    receiptKey,
    JSON.stringify({ format: 1, phase: "accepted", sourceKeys, sourceDigest }),
  );
}

const opaqueReceiptKey = "omnyo.preferences.import.v2";

const opaqueReceiptSchema = z
  .object({
    format: z.literal(2),
    phase: z.enum(["copying", "accepted"]),
    sourceKeys: z.array(z.string()),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export interface OpaquePreferenceCopyOwnerV1 {
  sourceRecords(): Map<string, string>;
  targetRecords(): Map<string, string>;
  importAll(): number;
  remove(key: string): void;
}

function ownedCanonicalPreferenceKey(key: string): string | null {
  const exact = exactKeys.get(key);

  if (exact !== undefined) return exact;

  if ([...exactKeys.values()].includes(key)) return key;

  for (const prefix of ["bb.push.enabled.", "bb.push.registration."])
    if (key.startsWith(prefix) && key.length > prefix.length)
      return `omnyo.${key.slice(3)}`;

  for (const prefix of ["omnyo.push.enabled.", "omnyo.push.registration."])
    if (key.startsWith(prefix) && key.length > prefix.length) return key;

  return null;
}

function validateCanonicalOpaquePreferenceValuesV1(
  target: PreferenceStorage,
): void {
  const values = new Map<string, string>();

  for (const key of target.getAllKeys()) {
    if (key === receiptKey || key === opaqueReceiptKey) continue;
    const canonical = ownedCanonicalPreferenceKey(key);

    if (canonical === null) continue;

    if (canonical !== key)
      throw new Error(
        "An owned legacy preference remains in canonical storage.",
      );
    values.set(key, validate(key, target.getString(key)));
  }

  validateReferences(values);
}

export function validateCanonicalOpaquePreferencesV1(
  target: PreferenceStorage,
): void {
  const previous = readReceipt(target);
  const raw = target.getString(opaqueReceiptKey);

  if (previous?.phase === "copying")
    throw new Error(
      "Saved preference migration requires its original source to resume.",
    );

  if (raw === undefined && target.getAllKeys().includes(opaqueReceiptKey))
    throw new Error(
      "Saved opaque preference migration receipt has an invalid type.",
    );

  if (
    raw !== undefined &&
    opaqueReceiptSchema.parse(JSON.parse(raw)).phase === "copying"
  )
    throw new Error(
      "Saved opaque preference migration requires its original source to resume.",
    );
  validateCanonicalOpaquePreferenceValuesV1(target);
}

export function adoptLegacyOpaquePreferencesV1(
  source: PreferenceStorage,
  target: PreferenceStorage,
  owner: OpaquePreferenceCopyOwnerV1,
): void {
  const saved = target.getString(opaqueReceiptKey);
  let receipt: z.infer<typeof opaqueReceiptSchema> | null = null;

  if (saved === undefined && target.getAllKeys().includes(opaqueReceiptKey))
    throw new Error(
      "Saved opaque preference migration receipt has an invalid type.",
    );

  if (saved !== undefined)
    receipt = opaqueReceiptSchema.parse(JSON.parse(saved));

  if (receipt?.phase === "accepted") {
    validateCanonicalOpaquePreferencesV1(target);

    return;
  }

  const previous = readReceipt(target);

  if (receipt === null && previous !== null) {
    if (previous.phase === "copying") adoptLegacyPreferencesV1(source, target);
    validateCanonicalOpaquePreferencesV1(target);
    target.set(
      opaqueReceiptKey,
      JSON.stringify({
        format: 2,
        phase: "accepted",
        sourceKeys: previous.sourceKeys,
        sourceDigest: previous.sourceDigest,
      }),
    );

    return;
  }

  const sourceKeys = source.getAllKeys().sort();

  if (sourceKeys.includes(receiptKey) || sourceKeys.includes(opaqueReceiptKey))
    throw new Error(
      "The legacy preference store contains a conflicting migration receipt.",
    );

  if (sourceKeys.length === 0) {
    if (receipt !== null)
      throw new Error("The opaque preference migration source disappeared.");
    validateCanonicalOpaquePreferencesV1(target);

    return;
  }

  const sourceRecords = owner.sourceRecords();

  if (
    JSON.stringify([...sourceRecords.keys()].sort()) !==
    JSON.stringify(sourceKeys)
  )
    throw new Error(
      "The native preference source snapshot does not match its owner.",
    );

  const sourceDigest = bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify(sourceKeys.map((key) => [key, sourceRecords.get(key)])),
      ),
    ),
  );

  const copies = new Map<string, string>();

  for (const key of sourceKeys) {
    const canonical = ownedCanonicalPreferenceKey(key);

    if (canonical === null) continue;
    const value = validate(canonical, source.getString(key));

    if (copies.has(canonical) && copies.get(canonical) !== value)
      throw new Error(
        "Saved owned preference keys conflict. Both copies were preserved.",
      );
    copies.set(canonical, value);
  }

  validateReferences(copies);

  const existingKeys = target
    .getAllKeys()
    .filter((key) => key !== opaqueReceiptKey);

  if (receipt === null && existingKeys.length > 0)
    throw new Error(
      "Saved preference storage collision. Both stores were preserved.",
    );

  if (
    receipt !== null &&
    (receipt.sourceDigest !== sourceDigest ||
      JSON.stringify(receipt.sourceKeys) !== JSON.stringify(sourceKeys))
  )
    throw new Error("Legacy opaque preferences changed during migration.");
  const currentRecords = owner.targetRecords();

  for (const key of existingKeys) {
    if (
      sourceRecords.has(key) &&
      currentRecords.get(key) === sourceRecords.get(key)
    )
      continue;

    if (copies.has(key) && target.getString(key) === copies.get(key)) continue;
    throw new Error(
      "Saved opaque preference storage conflicts with the original. Both copies were preserved.",
    );
  }

  function writeReceipt(phase: "copying" | "accepted") {
    const value = JSON.stringify({
      format: 2,
      phase,
      sourceKeys,
      sourceDigest,
    });

    target.set(opaqueReceiptKey, value);

    if (target.getString(opaqueReceiptKey) !== value)
      throw new Error(
        "The opaque preference copy receipt could not be verified.",
      );
  }

  if (receipt === null) writeReceipt("copying");

  if (owner.importAll() !== sourceKeys.length)
    throw new Error(
      "The native preference owner did not copy every source record.",
    );
  const copied = owner.targetRecords();

  for (const key of sourceKeys)
    if (copied.get(key) !== sourceRecords.get(key))
      throw new Error("A native opaque preference copy could not be verified.");

  const indexes = new Set([
    "omnyo.push.registrations",
    "omnyo.push.enabledProfiles",
  ]);

  const ordered = [...copies].sort(
    ([left], [right]) => Number(indexes.has(left)) - Number(indexes.has(right)),
  );

  for (const [key, value] of ordered) {
    target.set(key, value);

    if (target.getString(key) !== value)
      throw new Error("An owned preference could not be verified.");
  }

  for (const key of sourceKeys) {
    const canonical = ownedCanonicalPreferenceKey(key);

    if (canonical !== null && canonical !== key) owner.remove(key);
  }

  const finalRecords = owner.targetRecords();

  for (const key of sourceKeys) {
    if (ownedCanonicalPreferenceKey(key) !== null) continue;

    if (finalRecords.get(key) !== sourceRecords.get(key))
      throw new Error(
        "An opaque preference changed during the owned-key migration.",
      );
  }

  const sourceAfter = owner.sourceRecords();

  if (
    JSON.stringify(sourceKeys.map((key) => [key, sourceAfter.get(key)])) !==
      JSON.stringify(sourceKeys.map((key) => [key, sourceRecords.get(key)])) ||
    sourceAfter.size !== sourceRecords.size
  )
    throw new Error(
      "The original opaque preference source changed during migration.",
    );
  validateCanonicalOpaquePreferenceValuesV1(target);
  writeReceipt("accepted");
}
