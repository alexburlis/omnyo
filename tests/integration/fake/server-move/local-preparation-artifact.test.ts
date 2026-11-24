import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBundledNpmCli } from "../../../../packages/plugin-build/src/npm-cli.js";
import { createHash } from "node:crypto";
import { cp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { createFullOmnyoAppArtifactService } from "../../../../apps/server/src/services/server-move/full-artifact.js";
import {
  createRoot,
  registerServerMoveFixtureCleanup,
  writeFileWithDirs,
} from "../../../../apps/host-daemon/src/server-move/test-fixture.js";

registerServerMoveFixtureCleanup();

async function packagedInput() {
  const root = await createRoot();
  const packageRoot = join(root, "package");

  const files = {
    "package.json": JSON.stringify({
      name: "omnyo-app",
      type: "module",
      version: "0.46.0",
      dependencies: {},
      engines: { node: ">=22" },
      os: ["darwin", "linux", "win32"],
      files: [
        "dist",
        "server/dist",
        "host-daemon/dist",
        "app/dist",
        "package.json",
      ],
    }),
    "dist/omnyo-server.js": "export const inert = true;\n",
    "dist/omnyo-app.js": "export const inert = true;\n",
    "server/dist/start-server.js": `export function getRuntimeBuildIdentity(){return {hostDaemonProtocolVersion:${HOST_DAEMON_PROTOCOL_VERSION}};}\n`,
    "host-daemon/dist/daemon-bundle.mjs": "export const inert = true;\n",
    "app/dist/index.html": "<title>Owned inert package</title>",
  };

  for (const [path, bytes] of Object.entries(files))
    await writeFileWithDirs(join(packageRoot, path), bytes);

  const inventory = Object.entries(files)
    .map(([path, bytes]) => ({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const runtimeSha256 = createHash("sha256")
    .update(JSON.stringify(inventory))
    .digest("hex");

  const identity = {
    schemaVersion: 1,
    runtimeVersion: "0.46.0",
    hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    files: inventory,
    runtimeSha256,
  };

  await writeFile(
    join(packageRoot, "dist/runtime-identity.json"),
    JSON.stringify(identity),
  );

  return {
    root,
    packageRoot,
    identity,
    service: createFullOmnyoAppArtifactService({
      dataDir: join(root, "cache"),
      commandRunner: async (_command, args, cwd) => {
        const result = await promisify(execFile)(
          process.execPath,
          [resolveBundledNpmCli(), ...args, "--offline"],
          {
            cwd,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: root,
              npm_config_cache: join(root, "npm-cache"),
            },
          },
        );

        return result.stdout;
      },
      serverEntryUrl: pathToFileURL(join(packageRoot, "server/dist/index.js"))
        .href,
    }),
  };
}

async function identityApi() {
  return import(
    new URL(
      "../../../../packages/server-archive/src/runtime-identity.ts",
      import.meta.url,
    ).href
  );
}

describe("exact private runtime identity through packaged production paths", () => {
  it("binds a real full npm archive to the finished file inventory, including equal-version packages", async () => {
    const fixture = await packagedInput();
    const artifact = await fixture.service.build();
    expect(artifact.runtimeSha256).toBe(fixture.identity.runtimeSha256);
    expect(artifact.sha256).toBe(
      createHash("sha256")
        .update(await readFile(artifact.path))
        .digest("hex"),
    );
  });

  it.each([
    "changed-byte",
    "extra-byte",
    "symlink",
    "wrong-version",
    "wrong-protocol",
  ])(
    "refuses %s before packaging or installation can trust a stored receipt",
    async (kind) => {
      const fixture = await packagedInput();

      if (kind === "changed-byte")
        await writeFile(
          join(fixture.packageRoot, "dist/omnyo-server.js"),
          "changed runtime bytes",
        );

      if (kind === "extra-byte")
        await writeFile(
          join(fixture.packageRoot, "dist/unrecorded.js"),
          "unrecorded runtime bytes",
        );

      if (kind === "symlink")
        await symlink(
          join(fixture.packageRoot, "dist/omnyo-app.js"),
          join(fixture.packageRoot, "dist/linked.js"),
        );

      if (kind === "wrong-version")
        await writeFile(
          join(fixture.packageRoot, "package.json"),
          JSON.stringify({
            name: "omnyo-app",
            type: "module",
            version: "0.46.1",
            dependencies: {},
            engines: { node: ">=22" },
            os: ["linux"],
          }),
        );

      if (kind === "wrong-protocol")
        await writeFile(
          join(fixture.packageRoot, "dist/runtime-identity.json"),
          JSON.stringify({
            ...fixture.identity,
            hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
          }),
        );
      await expect(fixture.service.build()).rejects.toThrow(
        /identity|inventory|digest|protocol|version|symlink/u,
      );
    },
  );

  it("rejects duplicate and traversing inventory paths through the shared offline consumer", async () => {
    const fixture = await packagedInput();
    const api = await identityApi();

    for (const files of [
      [...fixture.identity.files, fixture.identity.files[0]],
      [{ path: "../escape", sha256: "0".repeat(64) }],
    ])
      expect(() =>
        api.parseRuntimeIdentity({ ...fixture.identity, files }),
      ).toThrow();
  });

  it("verifies the producer against the actual compiled server export, without starting a server", async () => {
    const fixture = await packagedInput();
    const compiled = resolve("../../apps/server/dist/start-server.js");
    await cp(
      compiled,
      join(fixture.packageRoot, "server/dist/start-server.js"),
    );
    const server = await import(pathToFileURL(compiled).href);
    expect(server.getRuntimeBuildIdentity()).toEqual({
      hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    });
    const api = await identityApi();

    const identity = await api.createRuntimeIdentity(fixture.packageRoot, {
      runtimeVersion: "0.46.0",
      hostDaemonProtocolVersion:
        server.getRuntimeBuildIdentity().hostDaemonProtocolVersion,
    });

    await expect(
      api.verifyRuntimeIdentity(fixture.packageRoot, identity),
    ).resolves.toEqual(identity);
  });
});
