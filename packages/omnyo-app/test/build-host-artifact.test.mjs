import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildNodeEsmEntry } from "../../../scripts/build-utils.mjs";
import {
  readRuntimeIdentity,
  verifyWorkerRuntimeIdentity,
} from "../../server-archive/src/runtime-identity.js";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  buildHostArtifact,
  npmLaunch,
} from "../scripts/build-host-artifact.mjs";

it("runs npm through the current Node on Windows, where spawn cannot resolve npm.cmd", () => {
  expect(npmLaunch(["pack", "stage"], "win32")).toEqual({
    command: process.execPath,
    args: [
      join(
        dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
      "pack",
      "stage",
    ],
  });
});

it("runs npm from PATH on macOS and Linux", () => {
  expect(npmLaunch(["pack", "stage"], "darwin")).toEqual({
    command: "npm",
    args: ["pack", "stage"],
  });
});

it("packs the canonical worker role with its state helper and verifiable private SDK bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-worker-artifact-test-"));
  const source = join(root, "source");
  const unpacked = join(root, "unpacked");

  try {
    await mkdir(join(source, "dist/plugin-sdk"), { recursive: true });
    await mkdir(join(source, "host-daemon/dist/omnyo-chunks"), {
      recursive: true,
    });
    await mkdir(unpacked);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "omnyo-app",
        version: "1.2.3",
        os: ["darwin"],
        engines: { node: ">=22" },
        dependencies: Object.fromEntries(
          [
            "@parcel/watcher",
            "fs-native-extensions",
            "node-pty",
            "pino",
            "pino-pretty",
            "pino-roll",
          ].map((name) => [name, "1.0.0"]),
        ),
      }),
    );
    await writeFile(join(source, "README.md"), "Omnyo worker fixture\n");

    for (const name of [
      "omnyo-app.js",
      "omnyo-host-daemon.js",
      "omnyo.js",
      "machine-state.mjs",
      "state-admission.mjs",
    ])
      await writeFile(
        join(source, "dist", name),
        "export const fixture = true;\n",
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
      await writeFile(join(source, "host-daemon/dist", name), "fixture\n");
    await writeFile(
      join(source, "host-daemon/dist/omnyo-chunks/chunk.js"),
      "export {};\n",
    );
    const sdk = Buffer.from("digest-bound SDK fixture");
    const sha256 = createHash("sha256").update(sdk).digest("hex");
    const file = `omnyo-plugin-sdk-0.6.44-${sha256.slice(0, 12)}.tgz`;
    await writeFile(join(source, "dist/plugin-sdk", file), sdk);
    await writeFile(
      join(source, "dist/plugin-sdk/manifest.json"),
      JSON.stringify({
        schema: 1,
        packageName: "@omnyo/plugin-sdk",
        version: "0.6.44",
        file,
        sha256,
      }),
    );
    await buildNodeEsmEntry({
      cleanDist: false,
      entryPoint: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../server-archive/src/runtime-identity.ts",
      ),
      outfile: join(source, "dist/runtime-identity-verifier.js"),
      packageRoot: source,
      sourcemap: false,
    });

    const descriptor = await buildHostArtifact({
      packageRoot: source,
      protocolVersion: 253,
    });

    const archive = await readFile(join(source, "dist/host-artifact.tgz"));
    expect(descriptor.digest).toBe(
      createHash("sha256").update(archive).digest("hex"),
    );
    await promisify(execFile)(
      "tar",
      ["-xf", join(source, "dist/host-artifact.tgz"), "-C", unpacked],
      { timeout: 5000 },
    );
    const packaged = join(unpacked, "package");
    const identity = await readRuntimeIdentity(packaged);
    expect(
      (await verifyWorkerRuntimeIdentity(packaged, identity))
        .hostDaemonProtocolVersion,
    ).toBe(253);
    expect(
      JSON.parse(await readFile(join(packaged, "package.json"), "utf8")).bin,
    ).toEqual({
      omnyo: "dist/omnyo.js",
      "omnyo-app": "dist/omnyo-app.js",
      "omnyo-host-daemon": "dist/omnyo-host-daemon.js",
    });
    await writeFile(join(packaged, "dist/machine-state.mjs"), "tampered");
    await expect(
      verifyWorkerRuntimeIdentity(packaged, identity),
    ).rejects.toThrow("digest mismatch");
    await rm(join(source, "dist/machine-state.mjs"));
    await expect(
      buildHostArtifact({ packageRoot: source, protocolVersion: 253 }),
    ).rejects.toThrow();
    expect(
      JSON.parse(
        await readFile(join(source, "dist/host-artifact.json"), "utf8"),
      ),
    ).toEqual(descriptor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
