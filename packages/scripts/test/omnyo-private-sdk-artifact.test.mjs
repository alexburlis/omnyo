import { createHash } from "node:crypto";
import {
  mkdtemp,
  lstat,
  readlink,
  copyFile,
  readdir,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  copyPrivateSdkArtifact,
  parsePrivateSdkArtifactManifest,
  verifyPrivateSdkArtifact,
} from "../../plugin-sdk/scripts/private-artifact.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "omnyo-private-sdk-"));
  const source = join(root, "source");
  const bytes = Buffer.from("actual-packed-sdk-fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const manifest = {
    schema: 1,
    packageName: "@omnyo/plugin-sdk",
    version: "0.6.44",
    file: `omnyo-plugin-sdk-0.6.44-${sha256.slice(0, 12)}.tgz`,
    sha256,
  };

  try {
    await mkdir(source);
    await writeFile(join(source, manifest.file), bytes);
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
    await run({ root, source, manifest, bytes });
  } finally {
    await rm(root, { recursive: true });
  }
}

test("copies the exact private SDK payload and verifies repeat copies", async () => {
  await fixture(async ({ root, source, manifest, bytes }) => {
    const target = join(root, "runtime/dist/plugin-sdk");
    await copyPrivateSdkArtifact(source, target);
    await copyPrivateSdkArtifact(source, target);
    expect((await verifyPrivateSdkArtifact(target)).manifest).toEqual(manifest);
    expect(await readFile(join(target, manifest.file))).toEqual(bytes);
  });
});

test("refuses corrupt source bytes and preserves existing target bytes", async () => {
  await fixture(async ({ root, source, manifest }) => {
    const target = join(root, "target");
    await copyPrivateSdkArtifact(source, target);
    await writeFile(join(source, manifest.file), "corrupt-source");
    await expect(copyPrivateSdkArtifact(source, target)).rejects.toThrow(
      "digest differs",
    );
    expect((await verifyPrivateSdkArtifact(target)).manifest).toEqual(manifest);
  });
});

test("refuses a populated destination artifact collision without changing its manifest", async () => {
  await fixture(async ({ root, source, manifest }) => {
    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, manifest.file), "foreign");
    await writeFile(join(target, "manifest.json"), "preserved-original");
    await expect(copyPrivateSdkArtifact(source, target)).rejects.toThrow(
      "collision",
    );
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe(
      "preserved-original",
    );
  });
});

test("refuses traversal, wrong identities and symbolic artifact paths", async () => {
  await fixture(async ({ root, source, manifest }) => {
    expect(() =>
      parsePrivateSdkArtifactManifest({ ...manifest, file: "../payload.tgz" }),
    ).toThrow();
    expect(() =>
      parsePrivateSdkArtifactManifest({ ...manifest, packageName: "other" }),
    ).toThrow();
    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, "manifest.json"), JSON.stringify(manifest));
    await symlink(join(source, manifest.file), join(target, manifest.file));
    await expect(verifyPrivateSdkArtifact(target)).rejects.toThrow(
      "regular file",
    );
  });
});

async function privatePackFixture(work) {
  const root = await mkdtemp(join(tmpdir(), "omnyo-sdk-pack-order-"));
  const repository = join(root, "repository");
  const directory = join(repository, "packages/plugin-sdk");
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const pnpm = process.env.npm_execpath;

  if (typeof pnpm !== "string" || !/pnpm\.(?:c?js)$/u.test(pnpm))
    throw new Error(
      "Private SDK packing fixture requires its pinned pnpm owner",
    );

  await mkdir(join(directory, "scripts"), { recursive: true });
  await mkdir(join(directory, "dist"));
  await mkdir(join(directory, "bundled-types"));
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ private: true, packageManager: "pnpm@10.34.5" }),
  );
  await writeFile(
    join(repository, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );

  const metadata = {
    name: "@omnyo/plugin-sdk",
    private: true,
    version: "0.6.46",
    type: "module",
    files: ["dist", "bundled-types", "README.md"],
    exports: {
      ".": {
        types: "./bundled-types/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    },
    devDependencies: { "fixture-a": "1.0.0", "fixture-b": "1.0.0" },
  };

  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  await writeFile(join(directory, "README.md"), "Private SDK fixture\n");
  await writeFile(
    join(directory, "dist/index.js"),
    "export const value = 1;\n",
  );
  await writeFile(
    join(directory, "dist/alternate.js"),
    "export const value = 2;\n",
  );
  await writeFile(
    join(directory, "bundled-types/index.d.ts"),
    "export declare const value: number;\n",
  );

  for (const file of ["pack-private.mjs", "private-artifact.mjs"])
    await copyFile(
      join(sourceRoot, "packages/plugin-sdk/scripts", file),
      join(directory, "scripts", file),
    );

  const actors = new Set();

  const runPack = () =>
    new Promise((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        [join(directory, "scripts/pack-private.mjs")],
        {
          cwd: directory,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: root,
            npm_execpath: pnpm,
            npm_config_registry: "http://127.0.0.1:1",
          },
        },
      );

      actors.add(child.pid);

      let stdout = "",
        stderr = "";

      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });

      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") reject(error);
        }
      }, 4000);

      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);

        if (code === 0) resolveRun({ code, signal, stdout, stderr });
        else
          reject(
            new Error(
              "Owned private SDK pack failed: " +
                code +
                "/" +
                signal +
                "; " +
                stderr,
            ),
          );
      });
    });

  const fingerprint = async () => {
    const rows = [];

    const visit = async (path, prefix = "") => {
      const parent = await lstat(path);

      rows.push([prefix, "directory", parent.mode & 0o7777]);

      for (const entry of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const file = join(path, entry.name),
          local = prefix + entry.name;

        if (file === join(directory, "private-artifact")) continue;
        const metadata = await lstat(file);
        const mode = metadata.mode & 0o7777;

        if (metadata.isSymbolicLink())
          rows.push([local, "symlink", mode, await readlink(file)]);
        else if (metadata.isDirectory()) await visit(file, local + "/");
        else if (metadata.isFile()) {
          const bytes = await readFile(file);

          rows.push([
            local,
            "file",
            mode,
            bytes.length,
            createHash("sha256").update(bytes).digest("hex"),
          ]);
        } else throw new Error("Owned SDK fixture contains a special path");
      }
    };

    await visit(repository);

    return rows;
  };

  try {
    await runPack();

    const selected = await verifyPrivateSdkArtifact(
      join(directory, "private-artifact"),
    );

    await work({
      root,
      repository,
      directory,
      metadata,
      runPack,
      fingerprint,
      selected,
    });
  } finally {
    for (const pid of actors) {
      let absent = false;

      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        absent = true;
      }

      if (!absent)
        throw new Error(
          "Owned SDK producer remains active; fixture retained: " + root,
        );
    }

    await rm(root, { recursive: true });
  }
}

async function inspectPrivatePackFixtureArchive(archive) {
  const executeTar = promisify(execFile);
  const tar = process.platform === "win32" ? "tar.exe" : "/usr/bin/tar";
  const options = { timeout: 1000, maxBuffer: 1024 * 1024, encoding: "buffer" };

  const [listed, verbose, bytes] = await Promise.all([
    executeTar(tar, ["-tf", archive], options),
    executeTar(tar, ["-tvf", archive], options),
    readFile(archive),
  ]);

  const entries = listed.stdout
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean);

  const files = entries.filter((name) => !name.endsWith("/"));

  if (
    files.length > 32 ||
    files.some(
      (name) => !name.startsWith("package/") || name.split("/").includes(".."),
    )
  )
    throw new Error("Owned packing fixture member inventory differs");
  const inventory = [];
  let metadata = null;

  for (let offset = 0; offset < files.length; offset += 2) {
    const values = await Promise.all(
      files.slice(offset, offset + 2).map(async (name) => {
        const result = await executeTar(
          tar,
          ["-xOf", archive, "--", name],
          options,
        );

        if (name === "package/package.json")
          metadata = JSON.parse(result.stdout.toString("utf8"));

        return {
          name,
          bytes: result.stdout.length,
          sha256: createHash("sha256").update(result.stdout).digest("hex"),
        };
      }),
    );

    inventory.push(...values);
  }

  if (metadata === null)
    throw new Error("Owned packing fixture package metadata is missing");

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    entryOrder: entries,
    inventory,
    headers: verbose.stdout.toString("utf8").trim().split("\n"),
    packageRootKeys: Object.keys(metadata),
    dependencyKeys: Object.keys(metadata.devDependencies ?? {}),
    packageValues: metadata,
  };
}

test("private SDK pack preserves the selected exact archive during real concurrent hook completion", async () => {
  await privatePackFixture(
    async ({ repository, directory, runPack, fingerprint, selected }) => {
      const waiting = [];
      const incomingOrders = [];
      let overlapping = false;
      let heldInputs = null;
      let barrierSettled = false;
      let resolveBarrier, rejectBarrier;

      const barrier = new Promise((resolve, reject) => {
        resolveBarrier = resolve;
        rejectBarrier = reject;
      }).then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ status: "rejected", reason }),
      );

      const failBarrier = (error) => {
        if (barrierSettled) return;
        barrierSettled = true;

        for (const entry of waiting) entry.destroy();
        rejectBarrier(error);
      };

      const server = createServer((request, response) => {
        if (request.url !== "/pack-hook") {
          response.writeHead(404).end();

          return;
        }

        if (barrierSettled) {
          response.destroy();

          return;
        }

        incomingOrders.push(
          request.headers["x-fixture-before-packing"] ?? null,
        );
        waiting.push(response);

        if (waiting.length === 2) {
          void (async () => {
            overlapping = waiting.every(
              (entry) => !entry.writableEnded && !entry.destroyed,
            );
            expect(overlapping).toBe(true);
            heldInputs = await fingerprint();

            const previousInputs = new Map(
              before.map((row) => [row[0], JSON.stringify(row)]),
            );

            const changedInputs = heldInputs.filter(
              (row) => previousInputs.get(row[0]) !== JSON.stringify(row),
            );

            expect(
              heldInputs,
              "SDK_PACK_REQUIRED_INPUTS_DURING_HOOKS " +
                JSON.stringify(changedInputs),
            ).toEqual(before);
            expect(
              waiting.every(
                (entry) => !entry.writableEnded && !entry.destroyed,
              ),
            ).toBe(true);
            barrierSettled = true;

            for (const entry of waiting) entry.end("continue");
            resolveBarrier();
          })().catch(failBarrier);
        }
      });

      await new Promise((resolveListen) =>
        server.listen(0, "127.0.0.1", resolveListen),
      );
      const address = server.address();

      if (address === null || typeof address === "string")
        throw new Error("Owned packing fixture did not bind loopback");
      await writeFile(
        join(repository, ".pnpmfile.cjs"),
        `exports.hooks={beforePacking:async manifest=>{await new Promise((resolve,reject)=>{require("node:http").get("http://127.0.0.1:${address.port}/pack-hook",{agent:false,headers:{"x-fixture-before-packing":Object.keys(manifest.devDependencies).join(",")}},response=>{response.resume();response.once("end",resolve);}).once("error",reject);});return {...manifest,devDependencies:Object.fromEntries(Object.entries(manifest.devDependencies).reverse())};}};\n`,
      );
      const before = await fingerprint();

      try {
        const guardedPack = () =>
          runPack().catch((error) => {
            failBarrier(error);

            throw error;
          });

        const [results, barrierResult] = await Promise.all([
          Promise.allSettled([guardedPack(), guardedPack()]),
          barrier,
        ]);

        if (barrierResult.status === "rejected") throw barrierResult.reason;
        expect(heldInputs).toEqual(before);
        expect(results.map((result) => result.status)).toEqual([
          "fulfilled",
          "fulfilled",
        ]);
        expect(waiting).toHaveLength(2);
        expect(overlapping).toBe(true);
        expect(await fingerprint()).toEqual(before);

        const after = await verifyPrivateSdkArtifact(
          join(directory, "private-artifact"),
        );

        console.info(
          JSON.stringify({
            stage: "private-sdk-pack-overlap",
            arrivals: waiting.length,
            overlapping,
            producerResults: results.map((result) => result.status),
            selectedSha256: selected.manifest.sha256,
            actualSha256: after.manifest.sha256,
            fullFixtureInputsUnchanged: true,
            duringHeldHooksInputsUnchanged: true,
            requiredInputPaths: before.length,
            fingerprintIncludes: [
              "path",
              "type",
              "mode",
              "bytes",
              "sha256",
              "symlinkTarget",
            ],
            packs: 2,
            network: "owned-loopback-only",
          }),
        );
        let diagnostic;

        if (after.manifest.sha256 !== selected.manifest.sha256) {
          try {
            const [selectedArchive, currentArchive] = await Promise.all([
              inspectPrivatePackFixtureArchive(selected.artifactPath),
              inspectPrivatePackFixtureArchive(after.artifactPath),
            ]);

            diagnostic =
              "SDK_PACK_ARCHIVE_DIAGNOSTIC " +
              JSON.stringify({
                incomingOrders,
                selectedArchive,
                currentArchive,
              });
          } catch (error) {
            diagnostic =
              "SDK_PACK_ARCHIVE_DIAGNOSTIC unavailable: " +
              (error.code ?? error.name);
          }
        }

        expect(after.manifest, diagnostic).toEqual(selected.manifest);
        expect(await readFile(after.artifactPath)).toEqual(
          await readFile(selected.artifactPath),
        );

        for (const owner of [directory, join(directory, "private-artifact")])
          expect(
            (await readdir(owner)).filter((name) =>
              name.startsWith(".private-pack-"),
            ),
          ).toEqual([]);
      } finally {
        const closed = new Promise((resolveClose) =>
          server.close(resolveClose),
        );

        server.closeAllConnections();
        await closed;
      }
    },
  );
});

for (const changed of ["runtime", "dependency", "export"]) {
  test(
    "private SDK pack retains every required input when " +
      changed +
      " changes",
    async () => {
      await privatePackFixture(
        async ({ directory, metadata, runPack, selected, fingerprint }) => {
          if (changed === "runtime")
            await writeFile(
              join(directory, "dist/index.js"),
              "export const value = 3;\n",
            );
          else {
            if (changed === "dependency")
              metadata.devDependencies["fixture-a"] = "1.0.1";
            else metadata.exports["."].default = "./dist/alternate.js";
            await writeFile(
              join(directory, "package.json"),
              JSON.stringify(metadata, null, 2) + "\n",
            );
          }

          const before = await fingerprint();
          await runPack();

          const after = await verifyPrivateSdkArtifact(
            join(directory, "private-artifact"),
          );

          console.info(
            JSON.stringify({
              stage: "private-sdk-pack-required-input",
              changed,
              selectedSha256: selected.manifest.sha256,
              actualSha256: after.manifest.sha256,
            }),
          );
          expect(after.manifest.sha256).not.toBe(selected.manifest.sha256);
          expect(await fingerprint()).toEqual(before);
          expect(await readFile(selected.artifactPath)).not.toEqual(
            await readFile(after.artifactPath),
          );

          for (const owner of [directory, join(directory, "private-artifact")])
            expect(
              (await readdir(owner)).filter((name) =>
                name.startsWith(".private-pack-"),
              ),
            ).toEqual([]);
        },
      );
    },
  );
}
