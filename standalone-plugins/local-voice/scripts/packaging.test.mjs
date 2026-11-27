import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  symlink,
  stat,
  readdir,
  writeFile,
  chmod,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [core, source, inputsPath, scratch, reportPath] = process.argv.slice(2);

assert(core && source && inputsPath && scratch && reportPath);

const input = JSON.parse(await readFile(inputsPath, "utf8"));

const hash = (value) => createHash("sha256").update(value).digest("hex");

const { preparePluginRuntime } = await import(
  pathToFileURL(join(core, "packages/plugin-build/src/prepare-plugin-runtime.ts"))
);

const { resolvePluginBuildToolchain } = await import(
  pathToFileURL(join(core, "packages/plugin-build/src/toolchain.ts"))
);

const staged = join(scratch, "source");

const packaged = join(scratch, "package");

const work = join(scratch, "work");

const checks = [];

const installer = join(scratch, "build-helper.mjs");

let esbuild;

await mkdir(scratch, { recursive: false });

try {
  const files = new Map(
    input.sourceRows
      .filter((row) => row.sha256)
      .map((row) => [row.file.slice("local-voice/".length), row]),
  );

  const binary = input.acceptedHelper.artifact;

  for (const [path, expected] of [["native/OmnyoLocalVoice", binary]])
    files.set(path, { file: "local-voice/" + path, sha256: expected.sha256, mode: expected.mode });

  for (const [relative, expected] of files) {
    assert(!relative.split("/").includes(".."));
    const from = join(source, relative);
    assert.equal(hash(await readFile(from)), expected.sha256);
    const to = join(staged, relative);
    await mkdir(dirname(to), { recursive: true });
    execFileSync("/bin/cp", ["-pc", from, to], { timeout: 5000 });
    assert.equal(hash(await readFile(to)), expected.sha256);
  }

  await writeFile(installer, await readFile(join(source, "scripts/build-helper.mjs")), {
    flag: "wx",
    mode: 0o600,
  });
  await symlink(join(source, "node_modules"), join(staged, "node_modules"), "junction");

  const toolchain = await resolvePluginBuildToolchain(join(scratch, "never-fetch"), {
    onFetchStart() {
      throw new Error("The packaging regression requires existing pinned tools.");
    },
  });

  esbuild = await import(toolchain.esbuild);
  await preparePluginRuntime({
    sourceRoot: staged,
    targetDir: packaged,
    coreVersion: "packaging-regression",
    toolchain,
    workDirectory: work,
  });
  esbuild.stop();
  esbuild = undefined;
  assert.deepEqual(await readdir(work), []);
  await rm(staged, { recursive: true });
  await assert.rejects(stat(staged), { code: "ENOENT" });

  for (const [name, run] of [
    [
      "native bytes and modes survive final runtime package",
      async () => {
        for (const [relative, expected] of [["OmnyoLocalVoice", binary]]) {
          const path = join(packaged, "dist/local-voice-native", relative);
          assert.equal(hash(await readFile(path)), expected.sha256);
          assert.equal((await stat(path)).mode & 0o7777, expected.mode);
        }
      },
    ],
    [
      "accepted native payload installs without compiling or running",
      async () => {
        const destination = join(scratch, "installation");
        await mkdir(join(destination, "helper"), { recursive: true });
        const manifestPath = join(scratch, "accepted-helper.json");

        const entries = [
          { ...binary, path: "OmnyoLocalVoice" },
          ...binary.resourceRows.map((row) => ({
            ...row,
            path: "FluidAudio_FluidAudio.bundle/" + row.path,
          })),
        ].map(({ path, sha256, bytes, mode }) => ({ path, sha256, bytes, mode }));

        await writeFile(manifestPath, JSON.stringify({ schema: 1, files: entries }) + "\n", {
          flag: "wx",
          mode: 0o600,
        });

        const runInstall = (target, selectedManifest = manifestPath) =>
          spawnSync(
            process.execPath,
            [
              installer,
              "--install-existing",
              join(packaged, "dist/local-voice-native"),
              selectedManifest,
            ],
            { cwd: target, encoding: "utf8", timeout: 5000 },
          );

        const first = runInstall(destination);
        assert.equal(first.status, 0, first.stderr);
        assert.equal(JSON.parse(first.stdout).installed, 3);

        for (const expected of entries) {
          const installed = join(destination, "helper/bin", expected.path);
          assert.equal(hash(await readFile(installed)), expected.sha256);
          assert.equal((await stat(installed)).mode & 0o7777, expected.mode);
        }

        await writeFile(join(destination, "helper/bin/legacy-user-data"), "preserved");
        const before = await stat(join(destination, "helper/bin/OmnyoLocalVoice"));
        const repeat = runInstall(destination);
        assert.equal(repeat.status, 0, repeat.stderr);
        assert.equal(JSON.parse(repeat.stdout).installed, 0);
        assert.equal((await stat(join(destination, "helper/bin/OmnyoLocalVoice"))).ino, before.ino);
        assert.equal(
          await readFile(join(destination, "helper/bin/legacy-user-data"), "utf8"),
          "preserved",
        );
        const conflict = join(scratch, "collision");
        await mkdir(join(conflict, "helper/bin"), { recursive: true });
        await writeFile(join(conflict, "helper/bin/OmnyoLocalVoice"), "foreign", { mode: 0o755 });
        const refused = runInstall(conflict);
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /refuses a conflicting target/u);
        assert.deepEqual(await readdir(join(conflict, "helper/bin")), ["OmnyoLocalVoice"]);
        assert.equal(
          await readFile(join(conflict, "helper/bin/OmnyoLocalVoice"), "utf8"),
          "foreign",
        );
        const malformed = join(scratch, "malformed");
        await mkdir(join(malformed, "helper"), { recursive: true });
        const badManifest = join(scratch, "malformed.json");
        await writeFile(badManifest, JSON.stringify({ schema: 1, files: entries.slice(1) }), {
          mode: 0o600,
        });
        const invalid = runInstall(malformed, badManifest);
        assert.notEqual(invalid.status, 0);
        assert.match(invalid.stderr, /exact accepted Dictation by Paraspeech helper manifest/u);
        assert.deepEqual(await readdir(join(malformed, "helper")), []);
        const unsafe = join(scratch, "unsafe-permissions");
        await mkdir(join(unsafe, "helper"), { recursive: true });
        await chmod(join(unsafe, "helper"), 0o777);
        const denied = runInstall(unsafe);
        assert.notEqual(denied.status, 0);
        assert.match(denied.stderr, /owned ordinary protected directories/u);
        assert.deepEqual(await readdir(join(unsafe, "helper")), []);
        const linked = join(scratch, "symlink-target");
        await mkdir(join(linked, "helper/bin"), { recursive: true });
        await symlink(
          join(destination, "helper/bin/OmnyoLocalVoice"),
          join(linked, "helper/bin/OmnyoLocalVoice"),
        );
        const linkRefused = runInstall(linked);
        assert.notEqual(linkRefused.status, 0);
        assert.match(linkRefused.stderr, /refuses a conflicting target/u);
        assert((await lstat(join(linked, "helper/bin/OmnyoLocalVoice"))).isSymbolicLink());
        assert.deepEqual(await readdir(join(linked, "helper/bin")), ["OmnyoLocalVoice"]);
      },
    ],
    [
      "actual host artifact spawns the packaged helper the server supplies",
      async () => {
        const path = join(packaged, "dist/host.js");
        const packagedHelper = join(packaged, "dist/local-voice-native/OmnyoLocalVoice");
        const originalSpawn = childProcess.spawn;
        const sentinel = new Error("Captured native helper request before process creation");
        const calls = [];
        const lifecycle = new AbortController();
        const signal = new AbortController();
        let entry;
        childProcess.spawn = (command) => {
          calls.push(command);
          throw sentinel;
        };

        syncBuiltinESMExports();

        try {
          entry = (await import(pathToFileURL(path).href)).default;
          assert.equal(entry.experimental_apiVersion, 1);
          await assert.rejects(
            entry.handlers.prepare(
              { helper: packagedHelper, dictionary: [], download: false },
              {
                signal: signal.signal,
                lifecycle: { signal: lifecycle.signal },
                experimental_paths: { tempDir: join(scratch, "unused-audio") },
              },
            ),
            (error) => error === sentinel,
          );
          assert.equal(calls.length, 1);
          assert.equal(resolve(calls[0]), packagedHelper);
        } finally {
          await entry?.dispose?.();
          lifecycle.abort();
          childProcess.spawn = originalSpawn;
          syncBuiltinESMExports();
        }
      },
    ],
  ]) {
    try {
      await run();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({
        name,
        passed: false,
        error: { name: error.name, code: error.code ?? null, message: error.message },
      });
    }
  }
} finally {
  esbuild?.stop();

  const result = {
    checks,
    helperExecuted: false,
    nativeCompilation: false,
    sourceTemporaryRemoved: await stat(staged).then(
      () => false,
      (error) => error.code === "ENOENT",
    ),
    finalRuntime: packaged,
  };

  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(reportPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }),
  );
}

assert.equal(checks.length, 3);

assert.equal(checks.filter((value) => !value.passed).length, 0);
