import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOmnyoRootFixture } from "./omnyo-root-fixture.js";
import { createRuntimeIdentity } from "../src/runtime-identity.js";
import {
  promoteDesktopUpdateHoldForIdentityV1,
  restoreAbortedIdentityHoldV1,
  restoreUnstagedIdentityHoldV1,
  readMaintenanceHold,
  writeMaintenanceHold,
} from "../src/maintenance-hold.js";
import { inspectOmnyoStateRoot } from "../src/omnyo-state-root.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const profile = await createOmnyoRootFixture();
  roots.push(profile.root);
  const runtimeRoot = join(profile.root, "runtime");

  for (const name of ["dist", "server/dist", "host-daemon/dist", "app/dist"]) {
    await mkdir(join(runtimeRoot, name), { recursive: true });
    await writeFile(
      join(runtimeRoot, name, "entry.js"),
      "export const bound=true;\n",
    );
  }

  await writeFile(
    join(runtimeRoot, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: "0.46.244+private.1" }),
  );

  const identity = await createRuntimeIdentity(runtimeRoot, {
    runtimeVersion: "0.46.244+private.1",
    hostDaemonProtocolVersion: 253,
  });

  await writeFile(
    join(runtimeRoot, "dist/runtime-identity.json"),
    JSON.stringify(identity),
  );
  await writeMaintenanceHold(profile.input.sourceDataDir, {
    version: 1,
    id: profile.input.migrationId,
    ownerId: profile.input.ownerId,
    kind: "desktop-update",
    phase: "held",
    serverHostId: profile.input.serverHostId,
    createdAt: 17,
    artifact: null,
  });

  const holdPath = join(
    profile.input.sourceDataDir,
    "server-maintenance-hold.json",
  );

  const bytes = await readFile(holdPath);

  const input = {
    id: profile.input.migrationId,
    ownerId: profile.input.ownerId,
    serverHostId: profile.input.serverHostId,
    expectedHoldSha256: createHash("sha256").update(bytes).digest("hex"),
    binding: {
      version: 1 as const,
      ownerKind: "coordinator" as const,
      sourceDataDir: profile.input.sourceDataDir,
      destinationDataDir: profile.input.destinationDataDir,
      jobDir: profile.input.jobDir,
      runtimeRoot,
      runtimeSha256: identity.runtimeSha256,
      archiveSha256: "a".repeat(64),
    },
  };

  return { ...profile, input, holdPath, bytes };
}

it("promotes only the same stopped acquired hold and replays idempotently without a move record", async () => {
  const f = await fixture();
  const hold = await promoteDesktopUpdateHoldForIdentityV1(f.input);
  expect(hold).toMatchObject({
    id: f.input.id,
    ownerId: f.input.ownerId,
    serverHostId: f.input.serverHostId,
    kind: "migration",
    phase: "held",
    identityAdoption: f.input.binding,
    artifact: { runtimeSha256: f.input.binding.runtimeSha256 },
  });
  expect(await promoteDesktopUpdateHoldForIdentityV1(f.input)).toEqual(hold);
  expect(
    await readFile(
      join(f.input.binding.sourceDataDir, "last-server-move.json"),
    ).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

it("refuses live runtime and daemon ownership without altering the acquired hold", async () => {
  const f = await fixture();
  await writeFile(
    join(f.input.binding.sourceDataDir, "bb-app-runtime.json"),
    JSON.stringify({
      pid: process.pid,
      entryPath: "/installed/runtime/dist/bb-app.js",
      surface: "web",
      serverUrl: "http://127.0.0.1:38886",
      startedAt: new Date().toISOString(),
      version: "0.46.238+private.1",
    }),
  );
  await expect(promoteDesktopUpdateHoldForIdentityV1(f.input)).rejects.toThrow(
    /runtime owner/,
  );
  expect(await readFile(f.holdPath)).toEqual(f.bytes);
});

it("refuses an artifact mismatch or foreign hold owner without rewriting protected state", async () => {
  const f = await fixture();
  await expect(
    promoteDesktopUpdateHoldForIdentityV1({ ...f.input, ownerId: "foreign" }),
  ).rejects.toThrow(/binding/);
  await expect(
    promoteDesktopUpdateHoldForIdentityV1({
      ...f.input,
      binding: { ...f.input.binding, runtimeSha256: "0".repeat(64) },
    }),
  ).rejects.toThrow(/runtime artifact/);
  expect(await readFile(f.holdPath)).toEqual(f.bytes);
  expect(readMaintenanceHold(f.input.binding.sourceDataDir)?.kind).toBe(
    "desktop-update",
  );
});

it("restores the original acquired hold when promotion failed before any staging owner", async () => {
  const f = await fixture();
  await promoteDesktopUpdateHoldForIdentityV1(f.input);
  await restoreUnstagedIdentityHoldV1(f.input);
  expect(await readFile(f.holdPath)).toEqual(f.bytes);
  expect(
    await readFile(
      join(f.input.binding.sourceDataDir, "user-file.txt"),
      "utf8",
    ),
  ).toBe("unchanged user work");
});

it("restores and replays an aborted hold when the original config and backup were absent", async () => {
  const f = await abortedFixture(false);
  await restoreAbortedIdentityHoldV1(f.input);
  await restoreAbortedIdentityHoldV1(f.input);
  expect(await readFile(f.holdPath)).toEqual(f.bytes);
  await expect(lstat(f.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(f.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  { phase: "copied" },
  { phase: "rollback-selected" },
  { ownerId: "foreign-owner" },
  { migrationId: "foreign-migration" },
  { serverHostId: "foreign-host" },
  { sourceDataDir: "/foreign-source" },
  { destinationDataDir: "/foreign-destination" },
  { artifactDigest: "0".repeat(64) },
  { sourceDigest: "0".repeat(64) },
  { destinationDigest: "0".repeat(64) },
  { stagingDevice: "1", stagingInode: "2" },
])("refuses an abort marker with mismatched binding %j", async (difference) => {
  const f = await abortedFixture();
  const promoted = await readFile(f.holdPath);
  await writeFile(f.markerPath, JSON.stringify({ ...f.marker, ...difference }));
  await expect(restoreAbortedIdentityHoldV1(f.input)).rejects.toThrow();
  expect(await readFile(f.holdPath)).toEqual(promoted);
});

it.each([
  "destination",
  "root-staging",
  "write-admission.json",
  "server-moved.json",
  "server-import.json",
  "server-import-journal.json",
])(
  "refuses existing and dangling %s ownership before restoring a hold",
  async (name) => {
    const f = await abortedFixture();
    const promoted = await readFile(f.holdPath);

    const path =
      name === "destination"
        ? f.input.binding.destinationDataDir
        : join(
            name.startsWith("server-")
              ? f.input.binding.sourceDataDir
              : f.input.binding.jobDir,
            name,
          );

    if (name === "destination" || name === "root-staging") await mkdir(path);
    else await writeFile(path, JSON.stringify({ admission: 0 }));
    await expect(restoreAbortedIdentityHoldV1(f.input)).rejects.toThrow(
      /writer or staging fence/,
    );
    expect(await readFile(f.holdPath)).toEqual(promoted);
    await rm(path, { recursive: true });
    await symlink(join(f.root, "missing-owner"), path);
    await expect(restoreAbortedIdentityHoldV1(f.input)).rejects.toThrow(
      /writer or staging fence/,
    );
    expect(await readFile(f.holdPath)).toEqual(promoted);
  },
);

it.each([
  { id: "foreign" },
  { ownerId: "foreign" },
  { serverHostId: "foreign" },
  { expectedHoldSha256: "0".repeat(64) },
  { expectedSourceDigest: "0".repeat(64) },
])("refuses a different abort restoration input %j", async (difference) => {
  const f = await abortedFixture();
  const promoted = await readFile(f.holdPath);
  await expect(
    restoreAbortedIdentityHoldV1({ ...f.input, ...difference }),
  ).rejects.toThrow(/owner or abort receipt differs/);
  expect(await readFile(f.holdPath)).toEqual(promoted);
});

it.each(["runtimeSha256", "archiveSha256"] as const)(
  "refuses a changed %s binding",
  async (name) => {
    const f = await abortedFixture();
    const promoted = await readFile(f.holdPath);
    await expect(
      restoreAbortedIdentityHoldV1({
        ...f.input,
        binding: { ...f.input.binding, [name]: "0".repeat(64) },
      }),
    ).rejects.toThrow(/owner or abort receipt differs/);
    expect(await readFile(f.holdPath)).toEqual(promoted);
  },
);

it.each([
  "config-bytes",
  "backup-bytes",
  "config-mode",
  "backup-mode",
  "state-migration",
  "foreign-hold",
  "runtime-bytes",
  "host-id",
  "daemon-owner",
  "runtime-owner",
])("refuses %s changes after a pre-admission abort", async (change) => {
  const f = await abortedFixture();
  const promoted = await readFile(f.holdPath);

  if (change === "config-bytes" || change === "backup-bytes")
    await writeFile(
      change === "config-bytes" ? f.configPath : f.backupPath,
      "{}",
    );
  else if (change === "config-mode" || change === "backup-mode")
    await chmod(change === "config-mode" ? f.configPath : f.backupPath, 0o644);
  else if (change === "state-migration") {
    const config = JSON.stringify({
      stateMigration: {
        journalPath: join(f.input.binding.jobDir, "write-admission.json"),
        binding: {
          migrationId: f.input.id,
          sourceDataDir: f.input.binding.sourceDataDir,
          destinationDataDir: f.input.binding.destinationDataDir,
          artifactDigest: f.input.binding.runtimeSha256,
          sourceDigest: f.input.expectedSourceDigest,
          destinationDigest: "0".repeat(64),
        },
      },
    });

    await writeFile(f.configPath, config);
    await writeFile(f.backupPath, config);
    await writeFile(
      f.markerPath,
      JSON.stringify({
        ...f.marker,
        configDigest: createHash("sha256").update(config).digest("hex"),
      }),
    );
  } else if (change === "foreign-hold") {
    await writeFile(
      f.holdPath,
      promoted.toString().replace(f.input.ownerId, "foreign-owner"),
    );
  } else if (change === "runtime-bytes") {
    await writeFile(
      join(f.input.binding.runtimeRoot, "dist", "entry.js"),
      "changed runtime",
    );
  } else if (change === "host-id") {
    await writeFile(
      join(f.input.binding.sourceDataDir, "host-id"),
      "foreign-host",
    );
  } else if (change === "daemon-owner") {
    await writeFile(
      join(f.input.binding.sourceDataDir, "daemon.lock.lock"),
      "owned",
    );
  } else
    await writeFile(
      join(f.input.binding.sourceDataDir, "bb-app-runtime.json"),
      JSON.stringify({
        pid: process.pid,
        entryPath: "/installed/runtime/dist/bb-app.js",
        surface: "web",
        serverUrl: "http://127.0.0.1:38886",
        startedAt: new Date().toISOString(),
        version: "0.46.238+private.1",
      }),
    );
  const current = await readFile(f.holdPath);
  await expect(restoreAbortedIdentityHoldV1(f.input)).rejects.toThrow();
  expect(await readFile(f.holdPath)).toEqual(current);
});

it.each(["marker", "receipt", "config", "backup", "hold"])(
  "refuses symbolic %s evidence",
  async (name) => {
    const f = await abortedFixture();
    const promoted = await readFile(f.holdPath);

    const path =
      name === "marker"
        ? f.markerPath
        : name === "receipt"
          ? join(f.input.binding.jobDir, "identity-hold-v1.json")
          : name === "config"
            ? f.configPath
            : name === "backup"
              ? f.backupPath
              : f.holdPath;

    const bytes = await readFile(path);
    const target = join(f.root, "alternate-proof");
    await writeFile(target, bytes, { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    await expect(restoreAbortedIdentityHoldV1(f.input)).rejects.toThrow();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(f.holdPath)).toEqual(promoted);
  },
);

it("revalidates abort evidence and exact mode after the original hold is already restored", async () => {
  const f = await abortedFixture();
  await restoreAbortedIdentityHoldV1(f.input);
  await writeFile(
    f.markerPath,
    JSON.stringify({ ...f.marker, phase: "sealed" }),
  );
  await expect(restoreAbortedIdentityHoldV1(f.input)).rejects.toThrow();
  await writeFile(f.markerPath, JSON.stringify(f.marker));
  await chmod(f.holdPath, 0o600);
  await expect(restoreAbortedIdentityHoldV1(f.input)).rejects.toThrow(
    /original hold mode differs/,
  );
  expect(await readFile(f.holdPath)).toEqual(f.bytes);
});

it.each(["root-adoption.json", "write-admission.json", "root-staging"])(
  "refuses unstaged restoration once %s has an owner",
  async (name) => {
    const f = await fixture();
    await promoteDesktopUpdateHoldForIdentityV1(f.input);
    const promoted = await readFile(f.holdPath);
    await writeFile(join(f.input.binding.jobDir, name), "owned stage");
    await expect(restoreUnstagedIdentityHoldV1(f.input)).rejects.toThrow(
      /staging/,
    );
    expect(await readFile(f.holdPath)).toEqual(promoted);
  },
);

it("refuses a foreign unstaged hold restoration", async () => {
  const f = await fixture();
  await promoteDesktopUpdateHoldForIdentityV1(f.input);
  const promoted = await readFile(f.holdPath);
  await expect(
    restoreUnstagedIdentityHoldV1({ ...f.input, ownerId: "foreign" }),
  ).rejects.toThrow();
  expect(await readFile(f.holdPath)).toEqual(promoted);
});

async function abortedFixture(configPresent = true) {
  const f = await fixture();
  const bytes = Buffer.from(`\n${f.bytes.toString()}\n`);
  await writeFile(f.holdPath, bytes);
  await chmod(f.holdPath, 0o640);

  const promotedInput = {
    ...f.input,
    expectedHoldSha256: createHash("sha256").update(bytes).digest("hex"),
  };

  await promoteDesktopUpdateHoldForIdentityV1(promotedInput);

  if (!configPresent)
    await rm(join(f.input.binding.sourceDataDir, "config.json"));
  const source = await inspectOmnyoStateRoot(f.input.binding.sourceDataDir);
  const configPath = join(f.input.binding.sourceDataDir, "config.json");
  const configBytes = configPresent ? await readFile(configPath) : null;

  const configMode = configPresent
    ? (await lstat(configPath)).mode & 0o777
    : 0o600;

  const backupPath = join(f.input.binding.jobDir, "source-config.json");

  if (configBytes !== null)
    await writeFile(backupPath, configBytes, { mode: configMode });

  const marker = {
    version: 1,
    migrationId: f.input.id,
    ownerId: f.input.ownerId,
    serverHostId: f.input.serverHostId,
    sourceDataDir: f.input.binding.sourceDataDir,
    destinationDataDir: f.input.binding.destinationDataDir,
    artifactDigest: f.input.binding.runtimeSha256,
    sourceDigest: source.digest,
    phase: "aborted-before-admission",
    configPresent,
    configMode,
    configDigest:
      configBytes === null
        ? null
        : createHash("sha256").update(configBytes).digest("hex"),
    destinationDigest: null,
    stagingDevice: null,
    stagingInode: null,
    socketBindings: [],
  };

  const markerPath = join(f.input.binding.jobDir, "root-adoption.json");
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });

  return {
    ...f,
    bytes,
    input: { ...promotedInput, expectedSourceDigest: source.digest },
    marker,
    markerPath,
    backupPath,
    configPath,
  };
}

it("restores the exact original hold after an owned pre-admission abort and validates replay", async () => {
  const f = await abortedFixture();
  const receiptPath = join(f.input.binding.jobDir, "identity-hold-v1.json");

  const evidence = await Promise.all(
    [f.markerPath, f.backupPath, receiptPath].map((path) => readFile(path)),
  );

  await restoreAbortedIdentityHoldV1(f.input);
  expect(await readFile(f.holdPath)).toEqual(f.bytes);
  expect((await lstat(f.holdPath)).mode & 0o777).toBe(0o640);
  const restoredInode = (await lstat(f.holdPath)).ino;
  await restoreAbortedIdentityHoldV1(f.input);
  expect((await lstat(f.holdPath)).ino).toBe(restoredInode);
  expect(
    await Promise.all(
      [f.markerPath, f.backupPath, receiptPath].map((path) => readFile(path)),
    ),
  ).toEqual(evidence);
  expect(
    await readFile(
      join(f.input.binding.sourceDataDir, "user-file.txt"),
      "utf8",
    ),
  ).toBe("unchanged user work");
});
