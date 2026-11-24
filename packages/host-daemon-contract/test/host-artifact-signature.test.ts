import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
  hostArtifactKeyIdFromRawPublicKey,
  hostArtifactSignatureMessage,
  hostArtifactSigningKeyId,
  parseHostArtifactPublicKey,
  parseHostArtifactSignatureRecord,
  verifyHostArtifactSignature,
  type HostArtifactSignatureSubject,
} from "../src/host-artifact-signature.js";

const SUBJECT: HostArtifactSignatureSubject = {
  version: "0.46.2+private.1",
  protocolVersion: 250,
  digest: "ab".repeat(32),
};

function openSshLine(rawPublicKey: Buffer): string {
  const field = (bytes: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);

    return Buffer.concat([length, bytes]);
  };

  const blob = Buffer.concat([
    field(Buffer.from("ssh-ed25519")),
    field(rawPublicKey),
  ]);

  return `ssh-ed25519 ${blob.toString("base64")} test-key`;
}

function ephemeralKey() {
  const pair = generateKeyPairSync("ed25519");

  const raw = Buffer.from(
    pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  );

  const line = openSshLine(raw);

  return {
    line,
    keyId: hostArtifactSigningKeyId(line),
    signature(subject: HostArtifactSignatureSubject): string {
      return sign(
        null,
        Buffer.from(hostArtifactSignatureMessage(subject)),
        pair.privateKey,
      ).toString("base64");
    },
  };
}

describe("host artifact signature message", () => {
  it("is the exact versioned, newline-terminated text", () => {
    expect(hostArtifactSignatureMessage(SUBJECT)).toBe(
      `omnyo-host-artifact-v1\n0.46.2+private.1\n250\n${"ab".repeat(32)}\n`,
    );
  });

  it("keeps a fixed signature for a fixed key and subject", () => {
    const raw = Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    );

    const line = openSshLine(raw);

    const signature =
      "vibT16Y0E1sxpWoYQHqK2PemyQ8Z4a7nGNmTVDBOk2/L/b/yQe3K2ZtcmadPfPVcXeFb4Hu0cOx1vPxvR2rpDQ==";

    expect(
      verifyHostArtifactSignature(
        { ...SUBJECT, signature, keyId: hostArtifactSigningKeyId(line) },
        [line],
      ),
    ).toBe(true);
  });
});

describe("pinned host artifact signing keys", () => {
  it("parse as Ed25519 keys with distinct 16 hex character ids", () => {
    const ids = HOST_ARTIFACT_SIGNING_PUBLIC_KEYS.map((key) =>
      hostArtifactSigningKeyId(key),
    );

    expect(HOST_ARTIFACT_SIGNING_PUBLIC_KEYS.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{16}$/u);
  });

  it("derive the key id from the raw 32 byte public key", () => {
    const [key] = HOST_ARTIFACT_SIGNING_PUBLIC_KEYS;
    const raw = parseHostArtifactPublicKey(key ?? "");

    expect(raw).toHaveLength(32);
    expect(hostArtifactKeyIdFromRawPublicKey(raw)).toBe(
      createHash("sha256").update(raw).digest("hex").slice(0, 16),
    );
    expect(hostArtifactSigningKeyId(key ?? "")).toBe(
      hostArtifactKeyIdFromRawPublicKey(raw),
    );
  });

  it("rejects malformed key lines", () => {
    for (const line of [
      "",
      "ssh-rsa AAAA",
      "ssh-ed25519",
      "ssh-ed25519 not-base64!",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==",
    ])
      expect(() => parseHostArtifactPublicKey(line)).toThrow();
  });
});

describe("verifyHostArtifactSignature", () => {
  it("accepts a signature from a listed key", () => {
    const key = ephemeralKey();

    expect(
      verifyHostArtifactSignature(
        { ...SUBJECT, signature: key.signature(SUBJECT), keyId: key.keyId },
        [key.line],
      ),
    ).toBe(true);
  });

  it("accepts the signing key anywhere in the list and ignores unparsable entries", () => {
    const key = ephemeralKey();
    const other = ephemeralKey();

    expect(
      verifyHostArtifactSignature(
        { ...SUBJECT, signature: key.signature(SUBJECT), keyId: key.keyId },
        ["not a key", other.line, key.line],
      ),
    ).toBe(true);
  });

  it("rejects a changed version, protocol version or digest", () => {
    const key = ephemeralKey();
    const signature = key.signature(SUBJECT);

    for (const changed of [
      { version: "0.46.3+private.1" },
      { protocolVersion: 251 },
      { digest: "cd".repeat(32) },
    ])
      expect(
        verifyHostArtifactSignature(
          { ...SUBJECT, ...changed, signature, keyId: key.keyId },
          [key.line],
        ),
      ).toBe(false);
  });

  it("rejects a signature from an unlisted key", () => {
    const signer = ephemeralKey();
    const listed = ephemeralKey();

    expect(
      verifyHostArtifactSignature(
        {
          ...SUBJECT,
          signature: signer.signature(SUBJECT),
          keyId: signer.keyId,
        },
        [listed.line],
      ),
    ).toBe(false);
  });

  it("rejects a key id that names a different listed key", () => {
    const signer = ephemeralKey();
    const listed = ephemeralKey();

    expect(
      verifyHostArtifactSignature(
        {
          ...SUBJECT,
          signature: signer.signature(SUBJECT),
          keyId: listed.keyId,
        },
        [signer.line, listed.line],
      ),
    ).toBe(false);
  });

  it("rejects an ephemeral signature against the pinned keys", () => {
    const key = ephemeralKey();

    expect(
      verifyHostArtifactSignature({
        ...SUBJECT,
        signature: key.signature(SUBJECT),
        keyId: key.keyId,
      }),
    ).toBe(false);
  });

  it("rejects malformed signatures, key ids and subjects without throwing", () => {
    const key = ephemeralKey();
    const signature = key.signature(SUBJECT);

    const claims = [
      { ...SUBJECT, signature: "", keyId: key.keyId },
      { ...SUBJECT, signature: "!!!!", keyId: key.keyId },
      {
        ...SUBJECT,
        signature: Buffer.alloc(63).toString("base64"),
        keyId: key.keyId,
      },
      { ...SUBJECT, signature, keyId: key.keyId.toUpperCase() },
      { ...SUBJECT, signature, keyId: key.keyId.slice(0, 8) },
      { ...SUBJECT, digest: "AB".repeat(32), signature, keyId: key.keyId },
      { ...SUBJECT, protocolVersion: 0, signature, keyId: key.keyId },
      { ...SUBJECT, protocolVersion: 250.5, signature, keyId: key.keyId },
      { ...SUBJECT, version: "", signature, keyId: key.keyId },
      {
        ...SUBJECT,
        version: "0.46.2+private.1\n250",
        signature,
        keyId: key.keyId,
      },
    ];

    for (const claim of claims)
      expect(verifyHostArtifactSignature(claim, [key.line])).toBe(false);
  });

  it("rejects a signature over a different message layout", () => {
    const pair = generateKeyPairSync("ed25519");

    const raw = Buffer.from(
      pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    );

    const line = openSshLine(raw);

    const withoutTrailingNewline = sign(
      null,
      Buffer.from(hostArtifactSignatureMessage(SUBJECT).slice(0, -1)),
      pair.privateKey,
    ).toString("base64");

    expect(
      verifyHostArtifactSignature(
        {
          ...SUBJECT,
          signature: withoutTrailingNewline,
          keyId: hostArtifactSigningKeyId(line),
        },
        [line],
      ),
    ).toBe(false);
  });
});

describe("parseHostArtifactSignatureRecord", () => {
  const record = {
    schemaVersion: 1,
    keyId: "0123456789abcdef",
    version: SUBJECT.version,
    protocolVersion: SUBJECT.protocolVersion,
    digest: SUBJECT.digest,
    signature: Buffer.alloc(64, 1).toString("base64"),
  };

  it("accepts the exact record shape", () => {
    expect(parseHostArtifactSignatureRecord(record)).toEqual(record);
  });

  it("rejects extra, missing or mistyped fields", () => {
    for (const value of [
      null,
      [],
      "record",
      { ...record, extra: true },
      { ...record, schemaVersion: 2 },
      { ...record, protocolVersion: "250" },
      { ...record, digest: "short" },
      { ...record, keyId: "XYZ" },
      { ...record, signature: "not base64!" },
      Object.fromEntries(
        Object.entries(record).filter(([name]) => name !== "signature"),
      ),
    ])
      expect(parseHostArtifactSignatureRecord(value)).toBeNull();
  });
});
