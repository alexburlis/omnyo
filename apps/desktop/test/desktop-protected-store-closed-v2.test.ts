import { execFile, spawn } from "node:child_process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  lstat,
  readFile,
  realpath,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { writeJsonFileAtomically } from "@omnyo/server-archive/json-file";
import {
  sealDesktopProtectedStoreJobV2,
  signDesktopProtectedStoreConsumersV1,
} from "../scripts/prepare-protected-store-consumers.mjs";
import {
  protectedStoreBindingSchemaV2,
  transferDesktopProtectedStoreV2,
  type DesktopProtectedStoreBindingV2,
} from "../src/desktop-protected-store-closed-v2.js";

if (process.env.OMNYO_PROFILE_NATIVE_FIXTURE_MANIFEST)
  writeSync(2, "native-fence-stage:module-loaded\n");

const execute = promisify(execFile);

const nativeSourceFixturePrepared =
  process.env.OMNYO_PROFILE_NATIVE_FIXTURE_MANIFEST !== undefined;

const nativeSourceFixtureRequired =
  "Requires a prepared native source fixture in OMNYO_PROFILE_NATIVE_FIXTURE_MANIFEST";

const environment = {
  HOME: process.env.HOME,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: process.env.TMPDIR,
};

export type ClosedProtectedStoreFixtureMetadataV2 = {
  namespace: string;
  root: string;
  stage: string;
  helpers: DesktopProtectedStoreBindingV2 | null;
  cleanup: Array<{ owner: string; osStatus: number }>;
  controls: Record<string, unknown>;
};

test("authenticates native peers and a sealed selection before protected transfer and monotonic first-write admission", async ({
  task,
}) => {
  const scratch = join(homedir(), "scratch/bb-private");
  await mkdir(scratch, { recursive: true });
  const available = await statfs(scratch);

  if (Number(available.bavail) * Number(available.bsize) < 16 * 1024 * 1024)
    throw new Error("Native fixture scratch budget unavailable");
  const namespace = `Omnyo Closed Transfer ${randomUUID()}`;
  const created = join(scratch, `test-${randomUUID()}--native-protected-store`);
  await mkdir(created, { mode: 0o700 });
  const root = await realpath(created);
  const old = join(root, "old-reader");
  const current = join(root, "new-writer");
  const forged = join(root, "forged-peer");
  const admissionPath = join(root, "admission");

  const metadata: ClosedProtectedStoreFixtureMetadataV2 = {
    namespace,
    root,
    stage: "prepared",
    helpers: null,
    cleanup: [],
    controls: {},
  };

  task.meta.nativeFixture = metadata;

  const checkpoint = () =>
    writeJsonFileAtomically(join(root, "native-fixture.json"), metadata);

  await checkpoint();
  let externalStateMayExist = false;
  let signed = false;

  async function invoke(path: string, operation: string, parameter: string) {
    return execute(path, [operation, parameter], {
      env: environment,
      timeout: 4000,
      maxBuffer: 4096,
    });
  }

  async function refused(path: string, operation: string, parameter: string) {
    let byteCount = 0;
    let exitCode = 0;

    try {
      byteCount = (
        await execute(path, [operation, parameter], {
          env: environment,
          timeout: 4000,
          encoding: "buffer",
          maxBuffer: 4096,
        })
      ).stdout.length;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        typeof error.code !== "number"
      )
        throw error;
      exitCode = error.code;

      if ("stdout" in error && Buffer.isBuffer(error.stdout))
        byteCount = error.stdout.length;
    }

    expect(exitCode).not.toBe(0);
    expect(byteCount).toBe(0);

    return { byteCount, exitCode };
  }

  try {
    await writeFile(admissionPath, "0", { mode: 0o600 });
    await execute(
      "/usr/bin/clang",
      [
        "-fobjc-arc",
        "-Wno-deprecated-declarations",
        "-framework",
        "Foundation",
        "-framework",
        "Security",
        "-framework",
        "LocalAuthentication",
        `-DOMNYO_TRANSFER_FIXTURE="${namespace}"`,
        join(__dirname, "../src/desktop-protected-store-closed-v2.m"),
        "-o",
        old,
      ],
      { env: environment, timeout: 8000 },
    );
    await writeFile(current, await readFile(old), { mode: 0o700 });
    await chmod(old, 0o700);
    await execute(
      "/usr/bin/clang",
      [
        join(__dirname, "fixtures/desktop-protected-store-forged-parent-v2.c"),
        "-o",
        forged,
      ],
      { env: environment, timeout: 4000 },
    );
    const identity = "227D854658C245C7521066FF87102B73FDB18A29";
    await Promise.all(
      [
        [old, "dev.bb.private"],
        [current, "dev.omnyo.private"],
        [forged, "dev.omnyo.private"],
      ].map(([path, identifier]) =>
        execute(
          "/usr/bin/codesign",
          [
            "--force",
            "--timestamp=none",
            "--sign",
            identity,
            "--options",
            "runtime",
            "--identifier",
            identifier,
            path,
          ],
          { env: environment, timeout: 4000 },
        ),
      ),
    );
    signed = true;

    const input = protectedStoreBindingSchemaV2.parse(
      await sealDesktopProtectedStoreJobV2({
        envelopePath: join(root, "Selection.app"),
        readerPath: old,
        writerPath: current,
        oldStorageName: `${namespace} Legacy`,
        newStorageName: `${namespace} Current`,
        profileBindingSha256: "a".repeat(64),
        admissionPath,
        sourceApplication: null,
        timestamp: false,
      }),
    );

    metadata.helpers = input;
    metadata.stage = "before-first-query";
    await checkpoint();

    for (const helper of [old, current])
      expect(
        JSON.parse((await invoke(helper, "inspect", namespace)).stdout),
      ).toMatchObject({
        absent: true,
        osStatus: -25300,
        interactionNotAllowed: true,
      });
    metadata.stage = "before-seed";
    externalStateMayExist = true;
    await checkpoint();
    await invoke(old, "seed", namespace);
    metadata.controls.directCaller = await refused(
      input.reader.path,
      "read",
      input.job.path,
    );

    const forgedResult = JSON.parse(
      (
        await execute(forged, [input.reader.path, input.job.path], {
          env: environment,
          timeout: 4000,
        })
      ).stdout,
    );

    expect(forgedResult).toMatchObject({ byteCount: 0 });
    expect(forgedResult.childExit).not.toBe(0);
    metadata.controls.forgedPeer = forgedResult;
    expect(
      JSON.parse(
        (await invoke(input.writer.path, "probe-channel", input.job.path))
          .stdout,
      ),
    ).toMatchObject({ outcome: "channel-denied", created: false });
    await writeFile(admissionPath, "1");
    metadata.controls.closedAdmission = await refused(
      input.writer.path,
      "write",
      input.job.path,
    );
    expect(
      JSON.parse((await invoke(current, "inspect", namespace)).stdout),
    ).toMatchObject({ absent: true, osStatus: -25300 });
    await writeFile(admissionPath, "0");
    expect(await transferDesktopProtectedStoreV2(input)).toMatchObject({
      created: true,
      admitted: false,
    });
    expect(await transferDesktopProtectedStoreV2(input)).toMatchObject({
      created: false,
    });

    const selectionPath = join(
      input.job.path,
      "Contents/Resources/selection.json",
    );

    const selection = await readFile(selectionPath);
    await writeFile(
      selectionPath,
      selection
        .toString()
        .replace('"oldStorageName":', '"forgedOldStorageName":'),
    );
    metadata.controls.forgedSelection = await refused(
      input.writer.path,
      "write",
      input.job.path,
    );
    await writeFile(selectionPath, selection);
    expect(await transferDesktopProtectedStoreV2(input)).toMatchObject({
      created: false,
    });
    await expect(
      transferDesktopProtectedStoreV2({
        ...input,
        profileBindingSha256: "f".repeat(64),
      }),
    ).rejects.toThrow("binding changed");
    expect(
      await transferDesktopProtectedStoreV2(input, "rollback"),
    ).toMatchObject({ outcome: "removed" });
    expect(
      await transferDesktopProtectedStoreV2(input, "rollback"),
    ).toMatchObject({ outcome: "absent" });
    expect(await transferDesktopProtectedStoreV2(input)).toMatchObject({
      created: true,
    });
    metadata.stage = "before-admission-fault";
    await checkpoint();
    metadata.controls.interruptedAdmission = await refused(
      input.writer.path,
      "admit-interrupt",
      input.job.path,
    );
    expect(await readFile(admissionPath, "utf8")).toBe("0");
    expect(
      await transferDesktopProtectedStoreV2(input, "status"),
    ).toMatchObject({ outcome: "admitted-recovery-required", admitted: true });
    metadata.controls.postAdmitRollback = await refused(
      input.writer.path,
      "rollback",
      input.job.path,
    );
    metadata.controls.postAdmitWrite = await refused(
      input.writer.path,
      "write",
      input.job.path,
    );
    expect(await transferDesktopProtectedStoreV2(input, "admit")).toMatchObject(
      { admitted: true },
    );
    expect(await readFile(admissionPath, "utf8")).toBe("1");
    await writeFile(admissionPath, "0");
    metadata.controls.replayedLatch = await refused(
      input.writer.path,
      "rollback",
      input.job.path,
    );
    expect(await transferDesktopProtectedStoreV2(input, "admit")).toMatchObject(
      { admitted: true },
    );
    expect(
      JSON.parse((await invoke(old, "inspect", namespace)).stdout),
    ).toMatchObject({ present: true, osStatus: 0 });
    metadata.stage = "verified";
    await checkpoint();
  } finally {
    const attempts =
      signed && externalStateMayExist
        ? await Promise.allSettled(
            [old, current].map(async (path) => {
              await invoke(path, "cleanup", namespace);

              const result = JSON.parse(
                (await invoke(path, "inspect", namespace)).stdout,
              );

              expect(result).toMatchObject({ absent: true, osStatus: -25300 });
              metadata.cleanup.push({
                owner: path === old ? "old" : "new",
                osStatus: result.osStatus,
              });
            }),
          )
        : [];

    const failed = attempts.find((attempt) => attempt.status === "rejected");
    metadata.stage = failed ? "cleanup-pending" : "cleanup-complete";
    await checkpoint();

    if (failed?.status === "rejected") throw failed.reason;
    await rm(root, { recursive: true });
  }
});

test("keeps production signing closed without configured namespace and unchanged-query production-fence proof", async () => {
  await expect(
    signDesktopProtectedStoreConsumersV1("/unselected-protected-store-source"),
  ).rejects.toThrow(
    "Protected-store consumers require configured Electron namespace and unchanged-query production-fence proof before publication",
  );
});

declare module "vitest" {
  interface TaskMeta {
    sourceApplicationBoundaryV2?: {
      scenario: string;
      accepted: boolean;
      nativeEffects: 0;
    };
  }
}

test.for([
  { scenario: "production-attested", expected: true },
  { scenario: "production-missing", expected: false },
  { scenario: "production-null", expected: false },
  { scenario: "synthetic-explicit-null", expected: true },
  { scenario: "foreign-source-app", expected: false },
  { scenario: "foreign-source-executable", expected: false },
  { scenario: "writable-source-mode", expected: false },
  { scenario: "unknown-source-field", expected: false },
])(
  "requires an attested original application in the sealed native job: $scenario",
  ({ scenario, expected }, { task }) => {
    const fixtureRoot =
      "/private/tmp/test-12345678-1234-1234-1234-123456789012--native-protected-store";

    const executable = {
      path: "/Applications/BB Private VPS.app/Contents/MacOS/BB Private",
      sha256: "a".repeat(64),
      codeDirectoryHash: "b".repeat(40),
      designatedRequirement: 'identifier "dev.bb.private"',
    };

    const sourceApplication = {
      appPath: "/Applications/BB Private VPS.app",
      profilePath: "/Users/fixture/Library/Application Support/BB Private",
      executable,
      originalMode: 0o755,
      device: "1",
      inode: "7",
    };

    const base = {
      version: 2,
      reader: {
        ...executable,
        path: fixtureRoot + "/Selection.app/Contents/Resources/old-reader",
      },
      writer: {
        ...executable,
        path: fixtureRoot + "/Selection.app/Contents/Resources/new-writer",
      },
      oldStorageName: "BB Private",
      newStorageName: "Omnyo Private",
      profileBindingSha256: "c".repeat(64),
      admissionPath: fixtureRoot + "/admission",
      job: {
        path: fixtureRoot + "/Selection.app",
        selectionSha256: "d".repeat(64),
      },
    };

    const value =
      scenario === "production-missing"
        ? base
        : {
            ...base,
            sourceApplication:
              scenario === "production-null" ||
              scenario === "synthetic-explicit-null"
                ? null
                : {
                    ...sourceApplication,
                    ...(scenario === "foreign-source-app"
                      ? { appPath: "/Applications/Unowned.app" }
                      : {}),
                    ...(scenario === "foreign-source-executable"
                      ? {
                          executable: {
                            ...executable,
                            path: "/Applications/Unowned.app/Contents/MacOS/Unowned",
                          },
                        }
                      : {}),
                    ...(scenario === "writable-source-mode"
                      ? { originalMode: 0o777 }
                      : {}),
                    ...(scenario === "unknown-source-field"
                      ? { unknown: true }
                      : {}),
                  },
            ...(scenario === "synthetic-explicit-null"
              ? {
                  oldStorageName:
                    "Omnyo Closed Transfer 12345678-1234-1234-1234-123456789012 Legacy",
                  newStorageName:
                    "Omnyo Closed Transfer 12345678-1234-1234-1234-123456789012 Current",
                }
              : {}),
          };

    const result = protectedStoreBindingSchemaV2.safeParse(value);
    task.meta.sourceApplicationBoundaryV2 = {
      scenario,
      accepted: result.success,
      nativeEffects: 0,
    };
    expect(result.success).toBe(expected);
  },
);

declare module "vitest" {
  interface TaskMeta {
    nativeSourceFenceV2?: {
      root: string;
      sourceSha256: string;
      exitCode: number;
      stdoutBytes: number;
      beforeMode: number;
      afterMode: number;
      sourcePreserved: boolean;
    };
  }
}

test("fences the attested original executable through the closed native admission owner", async ({
  skip,
  task,
}) => {
  skip(!nativeSourceFixturePrepared, nativeSourceFixtureRequired);
  writeSync(2, "native-fence-stage:case-entered\n");

  const manifestPath = process.env.OMNYO_PROFILE_NATIVE_FIXTURE_MANIFEST;

  if (!manifestPath)
    throw new Error("Exact native source-fence preparation required");

  const manifest = z
    .object({
      version: z.literal(1),
      root: z.string(),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      input: protectedStoreBindingSchemaV2,
    })
    .strict()
    .parse(JSON.parse(await readFile(manifestPath, "utf8")));

  const input = manifest.input;
  const source = input.sourceApplication;

  if (
    source === null ||
    manifest.root !== join(input.job.path, "..") ||
    (await realpath(manifest.root)) !== manifest.root
  )
    throw new Error("Native source-fence fixture binding differs");

  const hash = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");

  expect(
    hash(
      await readFile(
        join(__dirname, "../src/desktop-protected-store-closed-v2.m"),
      ),
    ),
  ).toBe(manifest.sourceSha256);
  writeSync(2, "native-fence-stage:input-bound\n");

  const original = await readFile(source.executable.path);
  const before = await lstat(source.executable.path, { bigint: true });
  expect(hash(original)).toBe(source.executable.sha256);
  expect(Number(before.mode & 0o777n)).toBe(source.originalMode);
  let exitCode = 0;
  let stdout = "";

  writeSync(2, "native-fence-stage:before-child\n");

  try {
    stdout = (
      await execute(input.writer.path, ["fence-source", input.job.path], {
        env: environment,
        timeout: 4000,
        maxBuffer: 4096,
      })
    ).stdout;

    writeSync(2, "native-fence-stage:child-returned\n");
  } catch (error) {
    writeSync(2, "native-fence-stage:child-rejected\n");

    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "number"
    )
      throw error;
    exitCode = error.code;

    if ("stdout" in error && typeof error.stdout === "string")
      stdout = error.stdout;
  }

  writeSync(2, "native-fence-stage:after-child\n");

  const after = await lstat(source.executable.path, { bigint: true });

  const sourcePreserved =
    hash(await readFile(source.executable.path)) === hash(original) &&
    before.dev === after.dev &&
    before.ino === after.ino;

  task.meta.nativeSourceFenceV2 = {
    root: manifest.root,
    sourceSha256: manifest.sourceSha256,
    exitCode,
    stdoutBytes: Buffer.byteLength(stdout),
    beforeMode: Number(before.mode & 0o777n),
    afterMode: Number(after.mode & 0o777n),
    sourcePreserved,
  };
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    version: 2,
    operation: "fence-source",
    outcome: "fenced",
    sourceMode: source.originalMode & ~0o111,
    admitted: false,
    authenticationUIFail: true,
    interactionNotAllowed: true,
  });
  expect(Number(after.mode & 0o777n)).toBe(source.originalMode & ~0o111);
  expect(sourcePreserved).toBe(true);
  expect(await readFile(input.admissionPath, "utf8")).toBe("0");
});

declare module "vitest" {
  interface TaskMeta {
    nativeSourceModeControlV2?: {
      scenario: string;
      root: string;
      sourceSha256: string;
      operation: string;
      exitCode: number;
      stdoutBytes: number;
      beforeMode: number;
      afterMode: number;
      sourcePreserved: boolean;
      latch: string;
      lockHolderStopped: boolean;
    };
  }
}

for (const [scenario, operation, beforeMode, afterMode, expectedExit] of [
  ["fence-repeat", "fence-source", 0o600, 0o600, 0],
  ["restore", "restore-source", 0o600, 0o700, 0],
  ["restore-repeat", "restore-source", 0o700, 0o700, 0],
  ["busy-lock", "fence-source", 0o700, 0o700, 110],
  ["restore-closed-tag", "restore-source", 0o600, 0o600, 116],
  ["restore-foreign-tag", "restore-source", 0o600, 0o600, 112],
  ["interrupted-admit", "admit-interrupt", 0o600, 0o600, 124],
  ["restore-admitted-zero-latch", "restore-source", 0o600, 0o600, 116],
  ["fence-admitted-zero-latch", "fence-source", 0o600, 0o600, 116],
] as const) {
  test(
    "enforces the sealed native source mode boundary: " + scenario,
    async ({ skip, task }) => {
      skip(!nativeSourceFixturePrepared, nativeSourceFixtureRequired);
      const manifestPath = process.env.OMNYO_PROFILE_NATIVE_FIXTURE_MANIFEST;

      if (!manifestPath)
        throw new Error(
          "Exact native source-mode fixture preparation required",
        );

      const manifest = z
        .object({
          version: z.literal(1),
          root: z.string(),
          sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          input: protectedStoreBindingSchemaV2,
        })
        .strict()
        .parse(JSON.parse(await readFile(manifestPath, "utf8")));

      const input = manifest.input;
      const source = input.sourceApplication;

      if (
        source === null ||
        manifest.root !== join(input.job.path, "..") ||
        (await realpath(manifest.root)) !== manifest.root
      )
        throw new Error("Native source-mode fixture binding differs");

      const hash = (value: Buffer) =>
        createHash("sha256").update(value).digest("hex");

      expect(
        hash(
          await readFile(
            join(__dirname, "../src/desktop-protected-store-closed-v2.m"),
          ),
        ),
      ).toBe(manifest.sourceSha256);

      const sealedRaw = await readFile(
        join(input.job.path, "Contents/Resources/selection.json"),
      );

      expect(hash(sealedRaw)).toBe(input.job.selectionSha256);

      const selected = z
        .object({ bindingSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
        .passthrough()
        .parse(JSON.parse(sealedRaw.toString("utf8")));

      const bytes = await readFile(source.executable.path);
      const before = await lstat(source.executable.path, { bigint: true });
      expect(hash(bytes)).toBe(source.executable.sha256);
      expect(Number(before.mode & 0o777n)).toBe(beforeMode);
      expect(await readFile(input.admissionPath, "utf8")).toBe("0");

      const holder =
        scenario === "busy-lock"
          ? spawn(
              "/usr/bin/perl",
              [
                "-e",
                'use Fcntl qw(:flock); alarm 4; open(my $f,"+<",$ARGV[0]) or die; flock($f,LOCK_EX|LOCK_NB) or die; $|=1; print "native-mode-lock-held\\n"; <STDIN>;',
                input.admissionPath,
              ],
              { env: environment, stdio: ["pipe", "pipe", "pipe"] },
            )
          : null;

      const holderClosed = holder
        ? new Promise<number | null>((resolve, reject) => {
            holder.once("error", reject);
            holder.once("exit", resolve);
          })
        : null;

      let lockHolderStopped = holder === null;
      let exitCode = 0;
      let stdout = "";

      try {
        if (holder)
          await new Promise<void>((resolve, reject) => {
            holder.once("error", reject);
            holder.once("exit", () =>
              reject(
                new Error("Native mode lock holder exited before readiness"),
              ),
            );
            holder.stdout.once("data", (chunk: Buffer) => {
              if (chunk.toString("utf8") === "native-mode-lock-held\n")
                resolve();
              else
                reject(new Error("Native mode lock holder readiness differs"));
            });
          });

        try {
          stdout = (
            await execute(input.writer.path, [operation, input.job.path], {
              env: environment,
              timeout: 4000,
              maxBuffer: 4096,
            })
          ).stdout;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            typeof error.code !== "number"
          )
            throw error;
          exitCode = error.code;

          if ("stdout" in error && typeof error.stdout === "string")
            stdout = error.stdout;
        }
      } finally {
        if (holder && holderClosed) {
          holder.stdin.end();
          expect(await holderClosed).toBe(0);
          lockHolderStopped = true;
        }
      }

      const after = await lstat(source.executable.path, { bigint: true });

      const sourcePreserved =
        before.dev === after.dev &&
        before.ino === after.ino &&
        hash(await readFile(source.executable.path)) === hash(bytes);

      const latch = await readFile(input.admissionPath, "utf8");
      task.meta.nativeSourceModeControlV2 = {
        scenario,
        root: manifest.root,
        sourceSha256: manifest.sourceSha256,
        operation,
        exitCode,
        stdoutBytes: Buffer.byteLength(stdout),
        beforeMode: Number(before.mode & 0o777n),
        afterMode: Number(after.mode & 0o777n),
        sourcePreserved,
        latch,
        lockHolderStopped,
      };
      expect(exitCode).toBe(expectedExit);
      expect(sourcePreserved).toBe(true);
      expect(Number(after.mode & 0o777n)).toBe(afterMode);
      expect(latch).toBe("0");
      expect(lockHolderStopped).toBe(true);

      if (expectedExit === 0)
        expect(JSON.parse(stdout)).toMatchObject({
          version: 2,
          operation,
          bindingSha256: selected.bindingSha256,
          outcome: operation === "fence-source" ? "fenced" : "restored",
          sourceMode: afterMode,
          admitted: false,
          protectedStore: true,
          authenticationUIFail: true,
          interactionNotAllowed: true,
        });
      else expect(stdout).toBe("");
    },
  );
}

declare module "vitest" {
  interface TaskMeta {
    selectedBuildSignerV1?: {
      scenario: string;
      sourceSha256: string;
      signingCommandsDeniedByFixture: number;
      actualNativeEffects: 0;
    };
  }
}

for (const scenario of [
  "qualified-selected-build",
  "qualified-untagged-selected-build",
  "malformed-selected-runtime",
  "wrong-source-commit",
  "dirty-source",
  "changed-native-source",
  "changed-sealer-owner",
  "changed-unsigned-consumer",
  "missing-compile-receipt",
  "public-compile-receipt",
  "wrong-target-identity",
  "different-selected-runtime",
]) {
  test(
    "qualifies only the exact selected native build before signing: " +
      scenario,
    async ({ task }) => {
      const packageRoot = await realpath(process.cwd());

      const source = await readFile(
        join(packageRoot, "scripts/prepare-protected-store-consumers.mjs"),
        "utf8",
      );

      const localRequire = createRequire(join(packageRoot, "package.json"));
      const parent = join(homedir(), "scratch/bb-private");
      await mkdir(parent, { recursive: true });

      const root = join(
        await realpath(parent),
        `test-${randomUUID()}--selected-build-signing`,
      );

      await mkdir(join(root, "src"), { recursive: true, mode: 0o700 });
      await mkdir(join(root, "dist"), { mode: 0o700 });

      const selected = {
        version: 1,
        sourceCommit: "a".repeat(40),
        runtimeVersion:
          scenario === "qualified-untagged-selected-build"
            ? "1.0.1"
            : scenario === "malformed-selected-runtime"
              ? "1.0.1+build.1"
              : "0.46.246+private.1",
        platform: "darwin",
        arch: "arm64",
        appId: "dev.omnyo.private",
        applicationName: "Omnyo Private",
        desktopProfileAdoptionProtocol: 2,
      };

      const sources = [];

      const sourceFiles = [
        "src/desktop-protected-store-closed-v2.m",
        "src/desktop-keychain-ui-fence-v1.c",
        "src/desktop-keychain-query-guard-v1.h",
        "src/desktop-keychain-query-guard-v1.m",
      ];

      const consumers = [];

      const files = [
        "desktop-protected-store-reader-v1",
        "desktop-protected-store-writer-v1",
        "desktop-keychain-ui-fence-v1.node",
      ];

      let signingCommands = 0;

      const nativeBoundary = Object.assign(
        () => {
          throw new Error("Unpromisified child process is forbidden");
        },
        {
          [promisify.custom]: async (command: string, args: string[]) => {
            if (command === "/usr/bin/git") {
              if (args[0] === "rev-parse")
                return {
                  stdout:
                    (scenario === "wrong-source-commit"
                      ? "b".repeat(40)
                      : selected.sourceCommit) + "\n",
                  stderr: "",
                };

              if (args[0] === "status")
                return {
                  stdout:
                    scenario === "dirty-source"
                      ? " M selected-native-source\n"
                      : "",
                  stderr: "",
                };
            }

            signingCommands += 1;
            throw new Error(
              "Native signing boundary held by qualification fixture",
            );
          },
        },
      );

      try {
        const context: Record<string, unknown> = {
          Buffer,
          process: {
            platform: "darwin",
            arch: "arm64",
            getuid: () => process.getuid?.(),
            env: { TMPDIR: process.env.TMPDIR },
          },
          require(name: string) {
            if (name === "node:child_process")
              return { execFile: nativeBoundary };

            if (
              [
                "node:crypto",
                "node:fs/promises",
                "node:path",
                "node:os",
                "node:util",
                "zod",
                "@omnyo/config/release-version",
              ].includes(name)
            )
              return localRequire(name);
            throw new Error("Unexpected signer source dependency");
          },
        };

        const imports = [
          ...source.matchAll(/^import[\s\S]*?from "([^"]+)";/gmu),
        ];

        let executable = source;

        for (const item of imports) {
          const declaration = item[0]
            .slice("import".length, item[0].lastIndexOf("from"))
            .trim();

          executable = executable.replace(
            item[0],
            `const ${declaration}=require(${JSON.stringify(item[1])});`,
          );
        }

        executable =
          executable.replaceAll("export async function ", "async function ") +
          "\nglobalThis.signSelectedBuild=signDesktopProtectedStoreConsumersV1;globalThis.compileFunctionSource=compileDesktopProtectedStoreConsumersV1.toString();";

        if (scenario === "changed-sealer-owner")
          executable = executable.replace(
            "async function finalizeDesktopProtectedStoreUnsignedJobV2(input) {",
            "async function finalizeDesktopProtectedStoreUnsignedJobV2(input) { throw new Error('unqualified changed sealer owner');",
          );
        vm.runInNewContext(executable, context, {
          filename: "actual-selected-build-signer.mjs",
          timeout: 1000,
        });
        const sign = context.signSelectedBuild;

        if (typeof sign !== "function")
          throw new Error("Actual signer source was not loaded");
        const functionSource = context.compileFunctionSource;

        if (typeof functionSource !== "string")
          throw new Error("Actual compiler source was not loaded");

        const compileFunctionSha256 = createHash("sha256")
          .update(functionSource)
          .digest("hex");

        for (const file of sourceFiles) {
          const bytes = await readFile(join(packageRoot, file));
          await writeFile(join(root, file), bytes, { mode: 0o644 });
          sources.push({
            file,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            mode: 0o644,
          });
        }

        for (const file of files) {
          const bytes = Buffer.from("owned unsigned metadata fixture: " + file);
          await writeFile(join(root, "dist", file), bytes, { mode: 0o755 });
          consumers.push({
            file,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            mode: 0o755,
          });
        }

        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "@omnyo/desktop",
            version: selected.runtimeVersion,
            desktopProfileAdoptionProtocol: 2,
          }),
          { mode: 0o644 },
        );

        const receipt = join(
          root,
          "dist/desktop-protected-store-compiled-v1.json",
        );

        await writeFile(
          receipt,
          JSON.stringify({
            version: 1,
            platform: "darwin",
            arch: "arm64",
            compileFunctionSha256,
            sources,
            consumers,
          }),
          { mode: 0o600 },
        );

        if (scenario === "changed-native-source")
          await writeFile(join(root, sourceFiles[0]), "changed native source");

        if (scenario === "changed-unsigned-consumer")
          await writeFile(
            join(root, "dist", files[0]),
            "changed unsigned consumer",
          );

        if (scenario === "missing-compile-receipt") await rm(receipt);

        if (scenario === "public-compile-receipt") await chmod(receipt, 0o644);

        if (scenario === "wrong-target-identity")
          selected.appId = "dev.bb.private";

        if (scenario === "different-selected-runtime")
          selected.runtimeVersion = "0.46.247+private.1";

        const errors: Record<string, string> = {
          "qualified-selected-build":
            "Native signing boundary held by qualification fixture",
          "qualified-untagged-selected-build":
            "Native signing boundary held by qualification fixture",
          "malformed-selected-runtime":
            "Protected-store selected build job differs",
          "wrong-source-commit":
            "Protected-store selected source commit differs",
          "dirty-source":
            "Protected-store selected source must be committed and clean",
          "changed-native-source":
            "Protected-store native source requires fresh qualification",
          "changed-sealer-owner":
            "Protected-store compiler or sealed-job owner requires fresh qualification",
          "changed-unsigned-consumer":
            "Protected-store unsigned consumer bytes differ",
          "missing-compile-receipt": "ENOENT",
          "public-compile-receipt":
            "Protected-store build file ownership differs",
          "wrong-target-identity": "Protected-store selected build job differs",
          "different-selected-runtime":
            "Protected-store selected build metadata differs",
        };

        try {
          await expect(sign(root, selected)).rejects.toThrow(errors[scenario]);
        } finally {
          task.meta.selectedBuildSignerV1 = {
            scenario,
            sourceSha256: createHash("sha256").update(source).digest("hex"),
            signingCommandsDeniedByFixture: signingCommands,
            actualNativeEffects: 0,
          };
        }

        expect(signingCommands).toBe(
          scenario === "qualified-selected-build" ||
            scenario === "qualified-untagged-selected-build"
            ? 3
            : 0,
        );
      } finally {
        await rm(root, { recursive: true });
        await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
}
