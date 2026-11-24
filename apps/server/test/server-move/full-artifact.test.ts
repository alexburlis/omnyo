import { createRuntimeIdentity } from "@omnyo/server-archive";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFullOmnyoAppArtifactService } from "../../src/services/server-move/full-artifact.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function writePackageFile(
  root: string,
  relativePath: string,
  body: string,
): Promise<void> {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

function packageJson(version: string): string {
  return JSON.stringify({
    name: "omnyo-app",
    version,
    dependencies: {},
    engines: { node: ">=22" },
    os: ["linux"],
  });
}

describe("full omnyo-app artifact availability", () => {
  it("reports the unpacked package size without node_modules and refreshes it for a new version", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-full-artifact-"));
    tempDirs.push(root);
    await writePackageFile(root, "package.json", packageJson("1.2.3"));
    await writePackageFile(root, "dist/omnyo-server.js", "a".repeat(100));
    await writePackageFile(root, "dist/omnyo-app.js", "b".repeat(200));
    await writePackageFile(root, "server/dist/index.js", "c".repeat(300));
    await writePackageFile(root, "app/dist/index.html", "d".repeat(400));
    await writePackageFile(
      root,
      "node_modules/pino/index.js",
      "e".repeat(5_000),
    );
    const dataDir = await mkdtemp(join(tmpdir(), "omnyo-full-artifact-data-"));
    tempDirs.push(dataDir);

    const service = createFullOmnyoAppArtifactService({
      commandRunner: async () => {
        throw new Error("availability never packs the artifact");
      },
      dataDir,
      serverEntryUrl: pathToFileURL(join(root, "server", "dist", "index.js"))
        .href,
    });

    expect(await service.availability()).toEqual({
      available: true,
      unpackedSizeBytes: Buffer.byteLength(packageJson("1.2.3")) + 1_000,
      version: "1.2.3",
    });

    await writePackageFile(root, "package.json", packageJson("1.2.40"));
    await writePackageFile(root, "app/dist/assets/app.js", "f".repeat(1_000));
    expect(await service.availability()).toEqual({
      available: true,
      unpackedSizeBytes: Buffer.byteLength(packageJson("1.2.40")) + 2_000,
      version: "1.2.40",
    });
  });
});

describe("full omnyo-app artifact packing", () => {
  it("packs with the bundled npm when the server has no npm on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-full-artifact-pack-"));
    tempDirs.push(root);
    await writePackageFile(root, "package.json", packageJson("1.2.3"));
    await writePackageFile(root, "dist/omnyo-server.js", "a");
    await writePackageFile(root, "dist/omnyo-app.js", "b");
    await writePackageFile(root, "server/dist/index.js", "c");
    await writePackageFile(root, "app/dist/index.html", "d");
    await writePackageFile(
      root,
      "host-daemon/dist/daemon-bundle.mjs",
      "inert host bytes",
    );

    const identity = await createRuntimeIdentity(root, {
      runtimeVersion: "1.2.3",
      hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    });

    await writePackageFile(
      root,
      "dist/runtime-identity.json",
      JSON.stringify(identity),
    );

    const dataDir = await mkdtemp(
      join(tmpdir(), "omnyo-full-artifact-pack-data-"),
    );

    tempDirs.push(dataDir);

    const service = createFullOmnyoAppArtifactService({
      dataDir,
      serverEntryUrl: pathToFileURL(join(root, "server", "dist", "index.js"))
        .href,
    });

    const originalPath = process.env.PATH;
    const originalNpmCache = process.env.npm_config_cache;
    process.env.npm_config_cache = join(dataDir, "npm-cache");
    process.env.PATH = "";
    let artifact;

    try {
      artifact = await service.build();
    } finally {
      process.env.PATH = originalPath;

      if (originalNpmCache === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = originalNpmCache;
    }

    expect(artifact.version).toBe("1.2.3");
    expect(artifact.sizeBytes).toBeGreaterThan(0);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
  }, 15_000);
});
