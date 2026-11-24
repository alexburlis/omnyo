import { hkdfSync } from "node:crypto";

export const RELAY_KEY_LABELS = {
  gate: "omnyo-relay gate v1",
  desktop: "omnyo-relay desktop v1",
  betterAuth: "omnyo-relay better-auth v1",
} as const;

export type RelayKeyPurpose = keyof typeof RELAY_KEY_LABELS;

export const RELAY_KEY_BYTES = 32;

const HKDF_SALT = Buffer.from("omnyo-relay", "utf8");

export interface RelayKeys {
  gate: Buffer;
  desktop: Buffer;
  betterAuthSecret: string;
}

export function deriveRelayKey(
  rootSecret: string,
  purpose: RelayKeyPurpose,
): Buffer {
  if (rootSecret.length === 0) {
    throw new Error("BETTER_AUTH_SECRET is required to derive relay keys");
  }

  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(rootSecret, "utf8"),
      HKDF_SALT,
      Buffer.from(RELAY_KEY_LABELS[purpose], "utf8"),
      RELAY_KEY_BYTES,
    ),
  );
}

export function deriveRelayKeys(rootSecret: string): RelayKeys {
  return {
    gate: deriveRelayKey(rootSecret, "gate"),
    desktop: deriveRelayKey(rootSecret, "desktop"),
    betterAuthSecret: deriveRelayKey(rootSecret, "betterAuth").toString(
      "base64url",
    ),
  };
}
