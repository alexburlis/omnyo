import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createOmnyoAppArtifactService } from "../../src/services/install/omnyo-app-artifact.js";

const roots: string[] = [];

const execute = promisify(execFile);

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const builder = join(
  repositoryRoot,
  "packages/omnyo-app/scripts/build-host-artifact.mjs",
);

let verifierRoot = "";

beforeAll(async () => {
  verifierRoot = await mkdtemp(join(tmpdir(), "omnyo-identity-verifier-"));
  await execute(
    process.execPath,
    [
      join(repositoryRoot, "scripts/build-node-entry.mjs"),
      join(repositoryRoot, "packages/server-archive/src/runtime-identity.ts"),
      join(verifierRoot, "runtime-identity-verifier.js"),
    ],
    { cwd: verifierRoot },
  );
});

afterAll(async () => {
  await rm(verifierRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnyo-prepared-artifact-"));
  roots.push(root);
  await mkdir(join(root, "server/dist"), { recursive: true });
  await mkdir(join(root, "dist/plugin-sdk"), { recursive: true });
  await mkdir(join(root, "host-daemon/dist/omnyo-chunks"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "omnyo-app",
      version: "1.2.3-test",
      dependencies: {
        "@parcel/watcher": "2.5.6",
        "fs-native-extensions": "1.5.0",
        "node-pty": "1.2.0-beta.15",
        pino: "9.6.0",
        "pino-pretty": "13.0.0",
        "pino-roll": "4.0.0",
      },
      engines: { node: ">=22.19.0" },
      os: ["darwin", "linux", "win32"],
    }),
  );

  await writeFile(join(root, "README.md"), "Omnyo worker fixture\n");

  for (const name of [
    "omnyo-app.js",
    "omnyo.js",
    "omnyo-host-daemon.js",
    "machine-state.mjs",
    "state-admission.mjs",
  ])
    await writeFile(join(root, "dist", name), "#!/usr/bin/env node\n");
  await copyFile(
    join(verifierRoot, "runtime-identity-verifier.js"),
    join(root, "dist/runtime-identity-verifier.js"),
  );
  const sdk = Buffer.from("digest-bound SDK fixture");
  const sdkSha256 = createHash("sha256").update(sdk).digest("hex");
  const sdkFile = `omnyo-plugin-sdk-0.6.44-${sdkSha256.slice(0, 12)}.tgz`;
  await writeFile(join(root, "dist/plugin-sdk", sdkFile), sdk);
  await writeFile(
    join(root, "dist/plugin-sdk/manifest.json"),
    JSON.stringify({
      schema: 1,
      packageName: "@omnyo/plugin-sdk",
      version: "0.6.44",
      file: sdkFile,
      sha256: sdkSha256,
    }),
  );

  for (const name of [
    "omnyo",
    "omnyo.cmd",
    "omnyo-file-search-worker.mjs",
    "omnyo-parcel-watcher-child.mjs",
    "omnyo-plugin-host-worker.mjs",
    "omnyo-process-launcher-worker.mjs",
    "omnyo-workspace-observer-child.mjs",
    "omnyo-workspace-read-child.mjs",
    "omnyo-provider-bridge-worker.mjs",
    "daemon-bundle.mjs",
  ])
    await writeFile(join(root, "host-daemon/dist", name), name);
  await writeFile(
    join(root, "host-daemon/dist/omnyo-chunks/chunk-TEST.js"),
    "export {};\n",
  );
  await writeFile(join(root, "private.txt"), "must not ship\n");
  await execute(process.execPath, [
    builder,
    "--package",
    root,
    "--protocol-version",
    "51",
  ]);
  const path = join(root, "dist/host-artifact.tgz");
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest("hex");

  const descriptor = {
    schemaVersion: 1,
    version: "1.2.3-test",
    protocolVersion: 51,
    digest,
    size: bytes.length,
  };

  const service = createOmnyoAppArtifactService({
    dataDir: join(root, "data"),
    serverEntryUrl: pathToFileURL(join(root, "server/dist/server.js")).href,
    protocolVersion: 51,
    commandRunner: async () => {
      throw new Error(
        "A packaged artifact request must not invoke a subprocess",
      );
    },
  });

  return { root, path, bytes, digest, descriptor, service };
}

it("serves a prepared packaged artifact without invoking a packaging command", async () => {
  const { service, digest, path, bytes } = await fixture();
  await expect(service.getArtifact()).resolves.toEqual({
    digest,
    path,
    size: bytes.length,
  });
  const listing = (await execute("tar", ["-tzf", path])).stdout.split(/\r?\n/u);
  expect(listing).toContain("package/host-daemon/dist/daemon-bundle.mjs");
  expect(listing).not.toContain("package/private.txt");
  await expect(service.getVersion()).resolves.toBe("1.2.3-test");
});

it("shares the prepared artifact across concurrent metadata and download requests", async () => {
  const { service, digest, path, bytes } = await fixture();

  const artifacts = await Promise.all(
    Array.from({ length: 10 }, () => service.getArtifact()),
  );

  expect(artifacts).toEqual(
    Array.from({ length: 10 }, () => ({ digest, path, size: bytes.length })),
  );
});

it.each([{ version: "1.2.4-test" }, { protocolVersion: 52 }])(
  "rejects a prepared artifact for a different runtime identity %j",
  async (patch) => {
    const test = await fixture();
    await writeFile(
      join(test.root, "dist/host-artifact.json"),
      JSON.stringify({ ...test.descriptor, ...patch }),
    );
    await expect(test.service.getArtifact()).rejects.toThrow(
      "does not match the runtime version and protocol",
    );
  },
);

it("rejects corrupt bytes even when the prepared archive size still matches", async () => {
  const test = await fixture();
  const corrupt = Buffer.from(test.bytes);
  corrupt[0] = corrupt[0] === 0 ? 1 : 0;
  await writeFile(test.path, corrupt);
  await expect(test.service.getArtifact()).rejects.toThrow(
    "integrity check failed",
  );
});

it("fails visibly when the prepared archive is absent and can retry after repair", async () => {
  const test = await fixture();
  await rm(test.path);
  await expect(test.service.getArtifact()).rejects.toMatchObject({
    code: "ENOENT",
  });
  await writeFile(test.path, test.bytes);
  await expect(test.service.getArtifact()).resolves.toEqual({
    digest: test.digest,
    path: test.path,
    size: test.bytes.length,
  });
});

it("fails visibly when the prepared descriptor is absent", async () => {
  const test = await fixture();
  await rm(join(test.root, "dist/host-artifact.json"));
  await expect(test.service.getArtifact()).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects missing required host files during assembly", async () => {
  const test = await fixture();
  await rm(join(test.root, "host-daemon/dist/daemon-bundle.mjs"));
  await expect(
    execute(process.execPath, [
      builder,
      "--package",
      test.root,
      "--protocol-version",
      "51",
    ]),
  ).rejects.toThrow("ENOENT");
});

it("rejects a README that is not a regular file during assembly", async () => {
  const test = await fixture();
  await rm(join(test.root, "README.md"));
  await mkdir(join(test.root, "README.md"));
  await expect(
    execute(process.execPath, [
      builder,
      "--package",
      test.root,
      "--protocol-version",
      "51",
    ]),
  ).rejects.toThrow(/EISDIR|ENOTSUP|EPERM/u);
});
