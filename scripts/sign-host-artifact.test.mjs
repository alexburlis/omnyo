import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
  hostArtifactSignatureMessage,
  hostArtifactSigningKeyId,
  parseHostArtifactSignatureRecord,
  verifyHostArtifactSignature,
} from "../packages/host-daemon-contract/src/host-artifact-signature.ts";
import {
  HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME,
  HostArtifactSigningFailure,
  signHostArtifact,
} from "./sign-host-artifact.mjs";

const signer = fileURLToPath(
  new URL("sign-host-artifact.mjs", import.meta.url),
);

function openSshLine(publicKey) {
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

  const field = (bytes) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);

    return Buffer.concat([length, bytes]);
  };

  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")}`;
}

function pemBlock(body) {
  return [
    "-----BEGIN ",
    "PRIVATE KEY-----\n",
    body,
    "\n-----END ",
    "PRIVATE KEY-----\n",
  ].join("");
}

function ephemeralKey() {
  const pair = generateKeyPairSync("ed25519");

  return {
    pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    line: openSshLine(pair.publicKey),
  };
}

async function workspace(t, { size = 4096 } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sign-host-artifact-")),
  );

  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(size, 7);
  const digest = createHash("sha256").update(bytes).digest("hex");

  const descriptor = {
    schemaVersion: 1,
    version: "0.46.2+private.1",
    protocolVersion: 250,
    digest,
    size: bytes.length,
  };

  const descriptorPath = join(root, "host-artifact.json");
  const tarballPath = join(root, "host-artifact.tgz");

  await writeFile(tarballPath, bytes);
  await writeFile(descriptorPath, JSON.stringify(descriptor));

  return {
    root,
    descriptor,
    descriptorPath,
    tarballPath,
    outPath: join(root, "signatures", `${digest}.json`),
  };
}

function runSigner(args, env) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [signer, ...args],
      { env: { PATH: process.env.PATH, ...env } },
      (error, stdout, stderr) =>
        resolveRun({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HostArtifactSigningFailure);

    return error.reason;
  }

  throw new Error("Expected the signer to refuse");
}

test("signs the descriptor message and writes a record that verifies", async (t) => {
  const key = ephemeralKey();
  const work = await workspace(t);

  const record = await signHostArtifact({
    descriptorPath: work.descriptorPath,
    tarballPath: work.tarballPath,
    outPath: work.outPath,
    privateKeyPem: key.pem,
    publicKeys: [key.line],
  });

  const written = JSON.parse(await readFile(work.outPath, "utf8"));
  assert.deepEqual(written, record);
  assert.deepEqual(parseHostArtifactSignatureRecord(written), record);
  assert.equal(record.keyId, hostArtifactSigningKeyId(key.line));
  assert.equal(record.version, work.descriptor.version);
  assert.equal(record.protocolVersion, work.descriptor.protocolVersion);
  assert.equal(record.digest, work.descriptor.digest);
  assert.equal(verifyHostArtifactSignature(record, [key.line]), true);
  assert.equal(
    hostArtifactSignatureMessage(record),
    `omnyo-host-artifact-v1\n0.46.2+private.1\n250\n${work.descriptor.digest}\n`,
  );
  assert.equal((await stat(work.outPath)).mode & 0o777, 0o644);
  assert.deepEqual(await readdir(join(work.root, "signatures")), [
    `${work.descriptor.digest}.json`,
  ]);
});

test("refuses a key that is not pinned and writes nothing", async (t) => {
  const key = ephemeralKey();
  const work = await workspace(t);

  assert.equal(
    await refusal(
      signHostArtifact({
        descriptorPath: work.descriptorPath,
        outPath: work.outPath,
        privateKeyPem: key.pem,
      }),
    ),
    "signing_key_not_pinned",
  );
  assert.equal(existsSync(work.outPath), false);
  assert.equal(HOST_ARTIFACT_SIGNING_PUBLIC_KEYS.includes(key.line), false);
});

test("refuses a missing, malformed or non-Ed25519 key", async (t) => {
  const work = await workspace(t);

  const { privateKey: rsa } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  const cases = [
    [undefined, "signing_key_missing"],
    ["  \n", "signing_key_missing"],
    [pemBlock("bm90IGEga2V5"), "signing_key_invalid"],
    [rsa.export({ type: "pkcs8", format: "pem" }), "signing_key_invalid"],
  ];

  for (const [privateKeyPem, reason] of cases)
    assert.equal(
      await refusal(
        signHostArtifact({
          descriptorPath: work.descriptorPath,
          outPath: work.outPath,
          privateKeyPem,
        }),
      ),
      reason,
    );
  assert.equal(existsSync(work.outPath), false);
});

test("refuses a descriptor with unknown, missing or malformed fields", async (t) => {
  const key = ephemeralKey();
  const work = await workspace(t);

  const bad = [
    { ...work.descriptor, extra: 1 },
    { ...work.descriptor, schemaVersion: 2 },
    { ...work.descriptor, digest: "AB".repeat(32) },
    { ...work.descriptor, protocolVersion: 0 },
    { ...work.descriptor, version: "" },
    { ...work.descriptor, size: 0 },
    Object.fromEntries(
      Object.entries(work.descriptor).filter(([name]) => name !== "size"),
    ),
    "not an object",
  ];

  for (const descriptor of bad) {
    await writeFile(work.descriptorPath, JSON.stringify(descriptor));
    assert.equal(
      await refusal(
        signHostArtifact({
          descriptorPath: work.descriptorPath,
          outPath: work.outPath,
          privateKeyPem: key.pem,
          publicKeys: [key.line],
        }),
      ),
      "descriptor_invalid",
    );
  }

  await writeFile(work.descriptorPath, "{broken");
  assert.equal(
    await refusal(
      signHostArtifact({
        descriptorPath: work.descriptorPath,
        outPath: work.outPath,
        privateKeyPem: key.pem,
        publicKeys: [key.line],
      }),
    ),
    "descriptor_invalid",
  );
  assert.equal(existsSync(work.outPath), false);
});

test("refuses a tarball whose size or digest differs from the descriptor", async (t) => {
  const key = ephemeralKey();
  const work = await workspace(t);

  await writeFile(work.tarballPath, Buffer.alloc(4096, 8));
  assert.equal(
    await refusal(
      signHostArtifact({
        descriptorPath: work.descriptorPath,
        tarballPath: work.tarballPath,
        outPath: work.outPath,
        privateKeyPem: key.pem,
        publicKeys: [key.line],
      }),
    ),
    "tarball_mismatch",
  );
  await writeFile(work.tarballPath, Buffer.alloc(10, 7));
  assert.equal(
    await refusal(
      signHostArtifact({
        descriptorPath: work.descriptorPath,
        tarballPath: work.tarballPath,
        outPath: work.outPath,
        privateKeyPem: key.pem,
        publicKeys: [key.line],
      }),
    ),
    "tarball_mismatch",
  );
  assert.equal(existsSync(work.outPath), false);
});

test("command line reads the key only from the environment and prints only the record", async (t) => {
  const key = ephemeralKey();
  const work = await workspace(t);

  const result = await runSigner(
    [
      "--descriptor",
      work.descriptorPath,
      "--tarball",
      work.tarballPath,
      "--out",
      work.outPath,
      "--public-key",
      key.line,
    ],
    { [HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME]: key.pem },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const record = JSON.parse(result.stdout);
  assert.equal(result.stdout, `${JSON.stringify(record)}\n`);
  assert.deepEqual(record, JSON.parse(await readFile(work.outPath, "utf8")));
  assert.equal(verifyHostArtifactSignature(record, [key.line]), true);

  for (const line of key.pem.split("\n").filter((entry) => entry.length > 8))
    assert.equal(result.stdout.includes(line), false);
});

test("command line failure names a fixed reason and never echoes key material", async (t) => {
  const key = ephemeralKey();
  const work = await workspace(t);
  const marker = "SECRETMARKERVALUE0123456789";

  const cases = [
    [{}, "signing_key_missing"],
    [
      {
        [HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME]: pemBlock(marker),
      },
      "signing_key_invalid",
    ],
    [
      { [HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME]: key.pem },
      "signing_key_not_pinned",
    ],
  ];

  for (const [env, reason] of cases) {
    const result = await runSigner(
      ["--descriptor", work.descriptorPath, "--out", work.outPath],
      env,
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `host_artifact_signing_failed: ${reason}\n`);
    assert.equal(result.stderr.includes(marker), false);
  }

  assert.equal(existsSync(work.outPath), false);
});

test("command line rejects unknown, repeated and incomplete arguments", async (t) => {
  const key = ephemeralKey();
  const work = await workspace(t);
  const env = { [HOST_ARTIFACT_SIGNING_KEY_ENVIRONMENT_NAME]: key.pem };

  for (const args of [
    [],
    ["--descriptor", work.descriptorPath],
    ["--out", work.outPath],
    ["--descriptor", work.descriptorPath, "--out", work.outPath, "--key", "x"],
    [
      "--descriptor",
      work.descriptorPath,
      "--descriptor",
      work.descriptorPath,
      "--out",
      work.outPath,
    ],
    ["--descriptor", work.descriptorPath, "--out"],
  ]) {
    const result = await runSigner(args, env);

    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "host_artifact_signing_failed: invalid_arguments\n",
    );
  }
});

test("the signer source has no logging calls", async () => {
  assert.equal(/console\./u.test(await readFile(signer, "utf8")), false);
});
