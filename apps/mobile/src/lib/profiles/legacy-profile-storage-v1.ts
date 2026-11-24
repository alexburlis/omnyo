import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { serverProfileSchema } from "./profile";
import {
  SECURE_STORAGE_MAX_VALUE_BYTES,
  utf8ByteLength,
  type SecureStorageLike,
} from "./secure-storage";

const legacyIndexKey = "bb.profiles.index";

const legacyProfilePrefix = "bb.profile.";

const migrationKey = "omnyo.profiles.import.v1";

export const canonicalProfileIndexKey = "omnyo.profiles.index";

export const canonicalProfilePrefix = "omnyo.profile.";

const migrationReceiptSchema = z
  .object({
    format: z.literal(1),
    phase: z.enum(["copying", "accepted"]),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const profileIndexSchema = z
  .object({
    ids: z.array(z.string().min(1)),
    activeProfileId: z.string().min(1).nullable(),
  })
  .strict()
  .refine(
    (index) =>
      new Set(index.ids).size === index.ids.length &&
      (index.activeProfileId === null ||
        index.ids.includes(index.activeProfileId)),
  );

export type ProfileIndex = z.infer<typeof profileIndexSchema>;

export function parseProfileIndex(raw: string): ProfileIndex {
  try {
    return profileIndexSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      "Saved server profile index is invalid; no profiles were replaced.",
    );
  }
}

function validateProfile(raw: string, id: string): string {
  try {
    const profile = serverProfileSchema.parse(JSON.parse(raw));

    if (
      profile.id !== id ||
      utf8ByteLength(raw) > SECURE_STORAGE_MAX_VALUE_BYTES
    )
      throw new Error();

    return JSON.stringify(profile);
  } catch {
    throw new Error(
      "Saved server profile is invalid; no profiles were replaced.",
    );
  }
}

async function copyVerified(
  storage: SecureStorageLike,
  key: string,
  value: string,
): Promise<void> {
  if ((await storage.getItem(key)) !== value) await storage.setItem(key, value);

  if ((await storage.getItem(key)) !== value)
    throw new Error("Saved server profile copy could not be verified.");
}

export async function adoptLegacyProfilesV1(
  storage: SecureStorageLike,
): Promise<string | null> {
  const canonical = await storage.getItem(canonicalProfileIndexKey);
  const rawReceipt = await storage.getItem(migrationKey);
  let receipt: z.infer<typeof migrationReceiptSchema> | null = null;

  if (rawReceipt !== null) {
    try {
      receipt = migrationReceiptSchema.parse(JSON.parse(rawReceipt));
    } catch {
      throw new Error("Saved server profile migration receipt is invalid.");
    }
  }

  if (receipt?.phase === "accepted") {
    if (canonical === null)
      throw new Error(
        "Saved server profile migration receipt has no canonical index.",
      );
    parseProfileIndex(canonical);

    return canonical;
  }

  const legacy = await storage.getItem(legacyIndexKey);

  if (legacy === null) {
    if (receipt !== null)
      throw new Error("Saved server profile migration source is missing.");

    if (canonical !== null) parseProfileIndex(canonical);

    return canonical;
  }

  const index = parseProfileIndex(legacy);

  if (
    canonical !== null &&
    JSON.stringify(parseProfileIndex(canonical)) !== JSON.stringify(index)
  )
    throw new Error(
      "Saved server profile index conflict; both copies were preserved.",
    );
  const copies: { key: string; value: string }[] = [];
  const sourceValues: [string, string][] = [[legacyIndexKey, legacy]];

  for (const id of index.ids) {
    const value = await storage.getItem(`${legacyProfilePrefix}${id}`);

    if (value === null)
      throw new Error(
        "Saved server profile is missing; migration was stopped.",
      );
    sourceValues.push([`${legacyProfilePrefix}${id}`, value]);
    const normalized = validateProfile(value, id);
    const key = `${canonicalProfilePrefix}${id}`;
    const destination = await storage.getItem(key);

    if (destination !== null && validateProfile(destination, id) !== normalized)
      throw new Error(
        "Saved server profile conflict; both copies were preserved.",
      );
    copies.push({ key, value: destination ?? value });
  }

  const sourceDigest = bytesToHex(
    sha256(utf8ToBytes(JSON.stringify(sourceValues))),
  );

  if (receipt !== null && receipt.sourceDigest !== sourceDigest)
    throw new Error("Saved server profile migration source changed.");

  if (receipt === null)
    await copyVerified(
      storage,
      migrationKey,
      JSON.stringify({ format: 1, phase: "copying", sourceDigest }),
    );

  for (const copy of copies) await copyVerified(storage, copy.key, copy.value);

  for (const [key, value] of sourceValues)
    if ((await storage.getItem(key)) !== value)
      throw new Error("Saved server profile migration source changed.");
  await copyVerified(storage, canonicalProfileIndexKey, canonical ?? legacy);
  await copyVerified(
    storage,
    migrationKey,
    JSON.stringify({ format: 1, phase: "accepted", sourceDigest }),
  );

  return canonical ?? legacy;
}
