import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretVaultError } from "./errors.js";

const ENVELOPE_PREFIX = "omnyo-vault:";

const ENVELOPE_VERSION = "1";

const IV_BYTES = 12;

const TAG_BYTES = 16;

const VAULT_ID_PATTERN = /^[0-9a-f]{32}$/u;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function associatedData(vaultId: string): Buffer {
  return Buffer.from(
    `${ENVELOPE_PREFIX}${ENVELOPE_VERSION}:${vaultId}`,
    "utf8",
  );
}

export function isSealed(text: string): boolean {
  return text.trim().startsWith(ENVELOPE_PREFIX);
}

export function sealEnvelope(
  key: Buffer,
  vaultId: string,
  plaintext: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(vaultId));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );

  return `${ENVELOPE_PREFIX}${ENVELOPE_VERSION}:${vaultId}:${payload}`;
}

function parseEnvelope(text: string): { vaultId: string; payload: Buffer } {
  const parts = text.trim().split(":");

  if (
    parts.length !== 4 ||
    `${parts[0]}:` !== ENVELOPE_PREFIX ||
    parts[1] !== ENVELOPE_VERSION
  )
    throw new SecretVaultError(
      "corrupt",
      "Sealed secret has an unsupported envelope format",
    );

  const [, , vaultId = "", encoded = ""] = parts;

  if (
    !VAULT_ID_PATTERN.test(vaultId) ||
    encoded.length === 0 ||
    !BASE64_PATTERN.test(encoded)
  )
    throw new SecretVaultError(
      "corrupt",
      "Sealed secret envelope is malformed",
    );

  const payload = Buffer.from(encoded, "base64");

  if (payload.length < IV_BYTES + TAG_BYTES)
    throw new SecretVaultError(
      "corrupt",
      "Sealed secret envelope is truncated",
    );

  return { vaultId, payload };
}

export function openEnvelope(
  key: Buffer,
  vaultId: string,
  sealed: string,
): string {
  const envelope = parseEnvelope(sealed);

  if (envelope.vaultId !== vaultId)
    throw new SecretVaultError(
      "wrong_vault",
      `Sealed secret belongs to vault ${envelope.vaultId}, not to this data directory's vault ${vaultId}`,
    );

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      envelope.payload.subarray(0, IV_BYTES),
    );

    decipher.setAAD(associatedData(vaultId));
    decipher.setAuthTag(
      envelope.payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    );

    return Buffer.concat([
      decipher.update(envelope.payload.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretVaultError(
      "corrupt",
      "Sealed secret failed authentication",
    );
  }
}
