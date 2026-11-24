import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from "node:crypto";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
  hostArtifactKeyIdFromRawPublicKey,
  hostArtifactSignatureMessage,
  hostArtifactSigningKeyId,
  verifyHostArtifactSignature,
} from "../packages/host-daemon-contract/src/host-artifact-signature.ts";

export const HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME =
  "OMNYO_HOST_ARTIFACT_SIGNING_KEY";

export class HostArtifactSigningFailure extends Error {
  constructor(reason) {
    super(reason);
    this.name = "HostArtifactSigningFailure";
    this.reason = reason;
  }
}

function refuse(reason) {
  throw new HostArtifactSigningFailure(reason);
}

function parseDescriptor(text) {
  let value;

  try {
    value = JSON.parse(text);
  } catch {
    refuse("descriptor_invalid");
  }

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "digest,protocolVersion,schemaVersion,size,version" ||
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    !Number.isSafeInteger(value.protocolVersion) ||
    value.protocolVersion <= 0 ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  )
    refuse("descriptor_invalid");

  return value;
}

async function checkTarball(path, descriptor) {
  const info = await lstat(path);

  if (!info.isFile() || info.size !== descriptor.size)
    refuse("tarball_mismatch");

  if (
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== descriptor.digest
  )
    refuse("tarball_mismatch");
}

function readPrivateKey(privateKeyPem) {
  if (typeof privateKeyPem !== "string" || privateKeyPem.trim() === "")
    refuse("signing_key_missing");
  let key;

  try {
    key = createPrivateKey({ key: privateKeyPem, format: "pem" });
  } catch {
    refuse("signing_key_invalid");
  }

  if (key.asymmetricKeyType !== "ed25519") refuse("signing_key_invalid");

  return key;
}

function rawPublicKey(privateKey) {
  return createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
}

export async function signHostArtifact({
  descriptorPath,
  tarballPath,
  outPath,
  privateKeyPem,
  publicKeys = HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
}) {
  const privateKey = readPrivateKey(privateKeyPem);
  const keyId = hostArtifactKeyIdFromRawPublicKey(rawPublicKey(privateKey));

  const pinned = publicKeys.some((key) => {
    try {
      return hostArtifactSigningKeyId(key) === keyId;
    } catch {
      return false;
    }
  });

  if (!pinned) refuse("signing_key_not_pinned");
  const descriptor = parseDescriptor(await readFile(descriptorPath, "utf8"));

  if (tarballPath !== undefined) await checkTarball(tarballPath, descriptor);

  const subject = {
    version: descriptor.version,
    protocolVersion: descriptor.protocolVersion,
    digest: descriptor.digest,
  };

  const signature = sign(
    null,
    Buffer.from(hostArtifactSignatureMessage(subject), "utf8"),
    privateKey,
  ).toString("base64");

  if (
    !verifyHostArtifactSignature({ ...subject, signature, keyId }, publicKeys)
  )
    refuse("signature_self_check_failed");

  const record = { schemaVersion: 1, keyId, ...subject, signature };
  const temporary = `${outPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await mkdir(dirname(outPath), { recursive: true, mode: 0o755 });
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporary, outPath);
  } catch {
    refuse("signature_write_failed");
  } finally {
    await rm(temporary, { force: true });
  }

  return record;
}

function parseArguments(argv) {
  const values = { publicKeys: [] };

  const flags = new Map([
    ["--descriptor", "descriptorPath"],
    ["--tarball", "tarballPath"],
    ["--out", "outPath"],
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (value === undefined || value === "") refuse("invalid_arguments");

    if (flag === "--public-key") {
      values.publicKeys.push(value);
      continue;
    }

    const name = flags.get(flag);

    if (name === undefined || values[name] !== undefined)
      refuse("invalid_arguments");
    values[name] = resolve(value);
  }

  if (values.descriptorPath === undefined || values.outPath === undefined)
    refuse("invalid_arguments");

  return values;
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));

    const privateKeyPem =
      process.env[HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME];

    delete process.env[HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME];

    const record = await signHostArtifact({
      descriptorPath: args.descriptorPath,
      tarballPath: args.tarballPath,
      outPath: args.outPath,
      privateKeyPem,
      ...(args.publicKeys.length === 0 ? {} : { publicKeys: args.publicKeys }),
    });

    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    const reason =
      error instanceof HostArtifactSigningFailure
        ? error.reason
        : typeof error?.code === "string" &&
            /^[A-Z0-9_]{1,40}$/u.test(error.code)
          ? `unexpected_${error.code}`
          : "unexpected";

    process.stderr.write(`host_artifact_signing_failed: ${reason}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  await main();
