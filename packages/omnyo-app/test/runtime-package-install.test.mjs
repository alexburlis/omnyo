import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildNodeEsmEntry } from "../../../scripts/build-utils.mjs";
import {
  createRuntimeIdentity,
  verifyRuntimeIdentity,
} from "../../server-archive/src/runtime-identity.ts";

const execute = promisify(execFile);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packScript = join(packageRoot, "scripts", "pack-runtime.mjs");

it("installs an extracted runtime root with production dependencies and bound published bytes", async () => {
  const scratch = join(tmpdir(), `omnyo-runtime-package-install-${randomUUID()}`);
  const source = join(scratch, "source");
  const destination = join(scratch, "packed");
  const extracted = join(scratch, "extracted");

  const report = {
    scratch,
    budgetBytes: 2_000_000,
    npm: null,
    tarballSha256: null,
    installExit: null,
    installError: null,
    runtimeOutput: null,
    identityVerified: false,
    sourceManifestUnchanged: false,
    scratchRemoved: false,
  };

  console.info(
    JSON.stringify({
      event: "runtime-package-scratch",
      scratch,
      budgetBytes: report.budgetBytes,
    }),
  );
  await mkdir(scratch);

  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    TMPDIR: scratch,
    TEMP: scratch,
    TMP: scratch,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_userconfig: join(scratch, "npmrc"),
    npm_config_globalconfig: join(scratch, "global-npmrc"),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };

  const run = (command, args, cwd) =>
    execute(command, args, { cwd, env, timeout: 20_000, maxBuffer: 1_000_000 });

  try {
    await Promise.all([
      mkdir(source),
      mkdir(destination),
      mkdir(extracted),
      writeFile(env.npm_config_userconfig, ""),
      writeFile(env.npm_config_globalconfig, ""),
    ]);
    report.npm = (await run("npm", ["--version"], scratch)).stdout.trim();
    const dependency = join(scratch, "dependency");
    await mkdir(dependency);
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "omnyo-runtime-fixture",
        version: "1.0.0",
        main: "index.cjs",
        files: ["index.cjs"],
      }),
    );
    await writeFile(
      join(dependency, "index.cjs"),
      'module.exports = "runtime-dependency-ready";\n',
    );

    const dependencyPack = JSON.parse(
      (
        await run(
          "npm",
          ["pack", "--json", "--ignore-scripts", "--pack-destination", source],
          dependency,
        )
      ).stdout,
    );

    const dependencyTarball = dependencyPack[0].filename;

    const original = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );

    const manifest = {
      ...original,
      dependencies: { "omnyo-runtime-fixture": `file:./${dependencyTarball}` },
      scripts: { prepack: original.scripts.prepack },
      files: [...original.files, dependencyTarball],
    };

    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(join(source, "package.json"), manifestBytes);

    for (const directory of [
      "dist",
      "server/dist",
      "host-daemon/dist/omnyo-chunks",
      "app/dist",
    ]) {
      await mkdir(join(source, directory), { recursive: true });
    }

    await Promise.all([
      writeFile(join(source, "README.md"), "Runtime package fixture\n"),
      writeFile(
        join(source, "dist/omnyo-app.js"),
        'import value from "omnyo-runtime-fixture"; process.stdout.write(value);\n',
      ),
      writeFile(
        join(source, "server/dist/start-server.js"),
        "export const fixture = true;\n",
      ),
      writeFile(
        join(source, "host-daemon/dist/omnyo"),
        'import "./omnyo-chunks/chunk-LIVE.js";\n',
      ),
      writeFile(
        join(source, "host-daemon/dist/omnyo-chunks/chunk-LIVE.js"),
        "export const fixture = true;\n",
      ),
      writeFile(
        join(source, "app/dist/index.html"),
        "<main>Runtime fixture</main>\n",
      ),
    ]);

    for (const [entryPoint, file] of [
      [
        resolve(packageRoot, "../server-archive/src/runtime-identity.ts"),
        "runtime-identity-verifier.js",
      ],
      [join(packageRoot, "scripts/prune-omnyo-chunks.mjs"), "prune-omnyo-chunks.mjs"],
    ]) {
      await buildNodeEsmEntry({
        entryPoint,
        outfile: join(source, "dist", file),
        packageRoot: source,
        cleanDist: false,
        sourcemap: false,
      });
    }

    const initialIdentity = await createRuntimeIdentity(source, {
      runtimeVersion: manifest.version,
      hostDaemonProtocolVersion: 237,
    });

    await writeFile(
      join(source, "dist/runtime-identity.json"),
      JSON.stringify(initialIdentity) + "\n",
    );

    const packed = JSON.parse(
      (
        await run(
          process.execPath,
          [packScript, "--package", source, "--pack-destination", destination],
          scratch,
        )
      ).stdout,
    );

    const tarball = join(destination, packed[0].filename);
    report.tarballSha256 = createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex");
    await run("tar", ["-xzf", tarball, "-C", extracted], scratch);
    const runtimeRoot = join(extracted, "package");
    report.sourceManifestUnchanged =
      (await readFile(join(source, "package.json"), "utf8")) === manifestBytes;

    try {
      await run(
        "npm",
        [
          "install",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--offline",
        ],
        runtimeRoot,
      );
      report.installExit = 0;
    } catch (error) {
      report.installExit = error.code;
      report.installError = error.stderr;
      throw new Error(
        `Extracted runtime npm --omit=dev install failed: ${error.stderr}`,
        { cause: error },
      );
    }

    report.runtimeOutput = (
      await run(
        process.execPath,
        [join(runtimeRoot, "dist/omnyo-app.js")],
        runtimeRoot,
      )
    ).stdout;

    const identity = JSON.parse(
      await readFile(join(runtimeRoot, "dist/runtime-identity.json"), "utf8"),
    );

    await verifyRuntimeIdentity(runtimeRoot, identity);
    report.identityVerified = true;
    expect(report.runtimeOutput).toBe("runtime-dependency-ready");
    expect(report.sourceManifestUnchanged).toBe(true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    report.scratchRemoved = true;
    console.info(JSON.stringify({ event: "runtime-package-proof", ...report }));
  }
}, 60_000);
