import { createHash, createPublicKey, verify } from "node:crypto";

export const HOST_ARTIFACT_SIGNATURE_MESSAGE_PREFIX = "omnyo-host-artifact-v1";

export const HOST_ARTIFACT_SIGNING_PUBLIC_KEYS: readonly string[] = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO7mX4VG4BJBYtyzrplzZLqkwR4wqpUBboDzocVR4Q1M",
];

export interface HostArtifactSignatureSubject {
  version: string;
  protocolVersion: number;
  digest: string;
}

export interface HostArtifactSignatureClaim extends HostArtifactSignatureSubject {
  signature: string;
  keyId: string;
}

export interface HostArtifactSignatureRecord extends HostArtifactSignatureClaim {
  schemaVersion: 1;
}

const OPENSSH_ED25519_TYPE = "ssh-ed25519";

const ED25519_RAW_PUBLIC_KEY_BYTES = 32;

const ED25519_SIGNATURE_BYTES = 64;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const KEY_ID_PATTERN = /^[a-f0-9]{16}$/u;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function readOpenSshString(
  blob: Buffer,
  offset: number,
): { value: Buffer; next: number } {
  if (offset + 4 > blob.length) throw new Error("Malformed public key");
  const length = blob.readUInt32BE(offset);
  const end = offset + 4 + length;

  if (end > blob.length) throw new Error("Malformed public key");

  return { value: blob.subarray(offset + 4, end), next: end };
}

export function parseHostArtifactPublicKey(publicKey: string): Buffer {
  const [type, encoded] = publicKey.trim().split(/\s+/u);

  if (type !== OPENSSH_ED25519_TYPE || encoded === undefined)
    throw new Error("Unsupported public key");

  if (!BASE64_PATTERN.test(encoded)) throw new Error("Malformed public key");
  const blob = Buffer.from(encoded, "base64");
  const blobType = readOpenSshString(blob, 0);
  const blobKey = readOpenSshString(blob, blobType.next);

  if (
    blobType.value.toString("utf8") !== OPENSSH_ED25519_TYPE ||
    blobKey.value.length !== ED25519_RAW_PUBLIC_KEY_BYTES ||
    blobKey.next !== blob.length
  )
    throw new Error("Malformed public key");

  return Buffer.from(blobKey.value);
}

export function hostArtifactKeyIdFromRawPublicKey(
  rawPublicKey: Uint8Array,
): string {
  if (rawPublicKey.length !== ED25519_RAW_PUBLIC_KEY_BYTES)
    throw new Error("Malformed public key");

  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

export function hostArtifactSigningKeyId(publicKey: string): string {
  return hostArtifactKeyIdFromRawPublicKey(
    parseHostArtifactPublicKey(publicKey),
  );
}

export function hostArtifactSignatureMessage(
  subject: HostArtifactSignatureSubject,
): string {
  return `${HOST_ARTIFACT_SIGNATURE_MESSAGE_PREFIX}\n${subject.version}\n${subject.protocolVersion}\n${subject.digest}\n`;
}

function subjectIsValid(subject: HostArtifactSignatureSubject): boolean {
  return (
    typeof subject.version === "string" &&
    subject.version.length > 0 &&
    !/[\r\n]/u.test(subject.version) &&
    Number.isSafeInteger(subject.protocolVersion) &&
    subject.protocolVersion > 0 &&
    typeof subject.digest === "string" &&
    DIGEST_PATTERN.test(subject.digest)
  );
}

export function verifyHostArtifactSignature(
  claim: HostArtifactSignatureClaim,
  keys: readonly string[] = HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
): boolean {
  try {
    if (
      !subjectIsValid(claim) ||
      typeof claim.keyId !== "string" ||
      !KEY_ID_PATTERN.test(claim.keyId) ||
      typeof claim.signature !== "string" ||
      !BASE64_PATTERN.test(claim.signature)
    )
      return false;
    const signature = Buffer.from(claim.signature, "base64");

    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
    const message = Buffer.from(hostArtifactSignatureMessage(claim), "utf8");

    return keys.some((key) => {
      let raw: Buffer;

      try {
        raw = parseHostArtifactPublicKey(key);
      } catch {
        return false;
      }

      if (hostArtifactKeyIdFromRawPublicKey(raw) !== claim.keyId) return false;

      return verify(
        null,
        message,
        createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
          format: "der",
          type: "spki",
        }),
        signature,
      );
    });
  } catch {
    return false;
  }
}

export function parseHostArtifactSignatureRecord(
  value: unknown,
): HostArtifactSignatureRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  const names = Object.keys(record).sort();

  if (
    names.join(",") !==
    "digest,keyId,protocolVersion,schemaVersion,signature,version"
  )
    return null;

  const { digest, keyId, protocolVersion, schemaVersion, signature, version } =
    record;

  if (
    schemaVersion !== 1 ||
    typeof digest !== "string" ||
    typeof keyId !== "string" ||
    typeof protocolVersion !== "number" ||
    typeof signature !== "string" ||
    typeof version !== "string" ||
    !subjectIsValid({ version, protocolVersion, digest }) ||
    !KEY_ID_PATTERN.test(keyId) ||
    !BASE64_PATTERN.test(signature)
  )
    return null;

  return {
    schemaVersion,
    keyId,
    version,
    protocolVersion,
    digest,
    signature,
  };
}
