import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  APP_UPDATE_SHIM_LOCK_FILE_NAME,
  APP_UPDATE_STATE_FILE_NAME,
  LEGACY_APP_UPDATE_SHIM_FILE_V1,
  LEGACY_APP_UPDATE_STATE_FILE_V1,
} from "@omnyo/config/app-update";
import { withFileLock } from "@omnyo/config/file-lock";
import {
  adoptLegacyAppUpdateFilesV1,
  assertLegacyAppUpdateOwnerStoppedV1,
} from "../src/legacy-app-update-files-v1.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-updater-adoption-")),
  );

  const jobDir = join(root, "job");
  const dataDir = join(jobDir, "staging");
  await mkdir(jobDir, { mode: 0o700 });
  await mkdir(dataDir, { mode: 0o700 });
  onTestFinished(async () => {
    await chmod(dataDir, 0o700);
    await rm(root, { recursive: true, force: true });
  });

  const revision = {
    kind: "npm",
    packageRoot: join(root, "original", "node_modules", "bb-app"),
    version: "0.46.241+private.1",
  };

  const raw = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        current: { ...revision, nodeAbi: "127" },
        pending: {
          id: "original-pending-request",
          from: revision,
          to: { ...revision, version: "0.46.253+private.1" },
          requestedAt: "2026-11-04T00:00:00.000Z",
          futurePendingField: { preserve: ["unchanged", 4] },
        },
        lastResult: null,
        unknown: { draft: "日本語", opaque: "bb user work" },
      },
      null,
      2,
    )}\n`,
  );

  const source = join(dataDir, LEGACY_APP_UPDATE_STATE_FILE_V1);
  const destination = join(dataDir, APP_UPDATE_STATE_FILE_NAME);
  await writeFile(source, raw, { mode: 0o640 });

  return {
    root,
    jobDir,
    dataDir,
    source,
    destination,
    raw,
    args: {
      migrationId: "updater-fixture-v1",
      sourceDataDir: join(root, "original"),
      destinationDataDir: join(root, "destination"),
      dataDir,
      jobDir,
      artifactDigest: "a".repeat(64),
      sourceDigest: "b".repeat(64),
    },
    journal: join(jobDir, "legacy-app-update-files-v1.json"),
  };
}

async function identity(path: string) {
  const info = await lstat(path, { bigint: true });

  return { device: info.dev, inode: info.ino, mode: info.mode & 0o777n };
}

async function prepareAtRealPermissionFailure(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await chmod(f.dataDir, 0o500);

  try {
    await expect(adoptLegacyAppUpdateFilesV1(f.args)).rejects.toMatchObject({
      code: "EACCES",
    });
  } finally {
    await chmod(f.dataDir, 0o700);
  }

  expect(JSON.parse(await readFile(f.journal, "utf8")).phase).toBe("prepared");
  expect(await readFile(f.source)).toEqual(f.raw);
  await expect(lstat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
}

test("adopts all four updater files without rewriting raw pending state, lock bytes, mode or inode", async () => {
  const f = await fixture();

  const completedChild = spawnSync(process.execPath, ["-e", ""], {
    timeout: 2000,
    windowsHide: true,
    stdio: "ignore",
  });

  expect(completedChild.status).toBe(0);

  const files = [
    [LEGACY_APP_UPDATE_STATE_FILE_V1, APP_UPDATE_STATE_FILE_NAME, f.raw],
    [
      LEGACY_APP_UPDATE_SHIM_FILE_V1,
      APP_UPDATE_SHIM_LOCK_FILE_NAME,
      Buffer.from(
        JSON.stringify({
          pid: completedChild.pid,
          entryPath: join(f.root, "old-owner", "bb-app.js"),
          startedAt: "2026-11-04T00:00:00.000Z",
          unknown: "retain shim extension",
        }),
      ),
    ],
    [
      `.${LEGACY_APP_UPDATE_STATE_FILE_V1}.lock`,
      `.${APP_UPDATE_STATE_FILE_NAME}.lock`,
      Buffer.from([0, 255, 8, 0, 1]),
    ],
    [
      `.${LEGACY_APP_UPDATE_STATE_FILE_V1}.tmp`,
      `.${APP_UPDATE_STATE_FILE_NAME}.tmp`,
      f.raw,
    ],
  ] as const;

  const before = new Map<string, Awaited<ReturnType<typeof identity>>>();

  for (const [legacy, current, raw] of files) {
    await writeFile(join(f.dataDir, legacy), raw, { mode: 0o640 });
    before.set(current, await identity(join(f.dataDir, legacy)));
  }

  await assertLegacyAppUpdateOwnerStoppedV1(f.dataDir);
  await adoptLegacyAppUpdateFilesV1(f.args);

  for (const [legacy, current, raw] of files) {
    expect(await readFile(join(f.dataDir, current))).toEqual(raw);
    expect(await identity(join(f.dataDir, current))).toEqual(
      before.get(current),
    );
    await expect(lstat(join(f.dataDir, legacy))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }

  const journal = await readFile(f.journal);
  await adoptLegacyAppUpdateFilesV1(f.args);
  expect(await readFile(f.journal)).toEqual(journal);
});

test("refuses equal dual namespace files before preparing or deleting either owner", async () => {
  const f = await fixture();
  await writeFile(f.destination, f.raw, { mode: 0o640 });

  const before = await Promise.all([
    identity(f.source),
    identity(f.destination),
  ]);

  await expect(adoptLegacyAppUpdateFilesV1(f.args)).rejects.toThrow(
    /collision/,
  );
  expect(
    await Promise.all([identity(f.source), identity(f.destination)]),
  ).toEqual(before);
  expect(await readFile(f.source)).toEqual(f.raw);
  expect(await readFile(f.destination)).toEqual(f.raw);
  await expect(lstat(f.journal)).rejects.toMatchObject({ code: "ENOENT" });
});

test
  .skipIf(process.platform === "win32")
  .each(["before-link", "after-link", "after-unlink"] as const)(
  "resumes only the original prepared inode %s after a real permission fault",
  async (boundary) => {
    const f = await fixture();
    const original = await identity(f.source);
    await prepareAtRealPermissionFailure(f);

    if (boundary === "after-link") await link(f.source, f.destination);
    else if (boundary === "after-unlink") await rename(f.source, f.destination);

    await adoptLegacyAppUpdateFilesV1(f.args);
    expect(await identity(f.destination)).toEqual(original);
    expect(await readFile(f.destination)).toEqual(f.raw);
    await expect(lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    const journal = await readFile(f.journal);
    expect(JSON.parse(journal.toString("utf8")).phase).toBe("complete");
    await adoptLegacyAppUpdateFilesV1(f.args);
    expect(await readFile(f.journal)).toEqual(journal);
  },
);

test
  .skipIf(process.platform === "win32")
  .each(["source", "destination"] as const)(
  "refuses a replaced %s inode even when raw bytes and mode match",
  async (replaced) => {
    const f = await fixture();
    await prepareAtRealPermissionFailure(f);
    const original = await identity(f.source);

    if (replaced === "source")
      await rename(f.source, join(f.dataDir, "retained-original"));
    const path = replaced === "source" ? f.source : f.destination;
    await writeFile(path, f.raw, { mode: 0o640 });
    expect((await identity(path)).inode).not.toBe(original.inode);
    await expect(adoptLegacyAppUpdateFilesV1(f.args)).rejects.toThrow(
      replaced === "source" ? /source changed/ : /destination collision/,
    );
    expect(await readFile(path)).toEqual(f.raw);
    expect(
      await readFile(
        replaced === "source" ? join(f.dataDir, "retained-original") : f.source,
      ),
    ).toEqual(f.raw);
    expect(JSON.parse(await readFile(f.journal, "utf8")).phase).toBe(
      "prepared",
    );
  },
);

test.each(["live-shim", "uncommitted-state"] as const)(
  "refuses %s before a migration journal or rename",
  async (kind) => {
    const f = await fixture();

    const extra =
      kind === "live-shim"
        ? join(f.dataDir, LEGACY_APP_UPDATE_SHIM_FILE_V1)
        : join(f.dataDir, `.${LEGACY_APP_UPDATE_STATE_FILE_V1}.tmp`);

    const raw =
      kind === "live-shim"
        ? JSON.stringify({
            pid: process.pid,
            entryPath: process.execPath,
            startedAt: "fixture",
          })
        : `${f.raw.toString("utf8")} `;

    await writeFile(extra, raw, { mode: 0o600 });
    await expect(adoptLegacyAppUpdateFilesV1(f.args)).rejects.toThrow(
      kind === "live-shim" ? /stopped/ : /Uncommitted/,
    );
    expect(await readFile(f.source)).toEqual(f.raw);
    expect(await readFile(extra, "utf8")).toBe(raw);
    await expect(lstat(f.journal)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("existing-only lock admission refuses a new inode without entering work or creating a missing parent", async () => {
  const f = await fixture();
  const original = await identity(f.source);
  await rename(f.source, join(f.dataDir, "retained-original"));
  await writeFile(f.source, f.raw, { mode: 0o640 });
  let entered = false;

  const work = async () => {
    entered = true;
  };

  const expected = {
    device: original.device.toString(),
    inode: original.inode.toString(),
  };

  await expect(
    withFileLock({
      path: f.source,
      existingOnly: true,
      identity: expected,
      timeoutMs: 1,
      work,
    }),
  ).rejects.toThrow(/original inode/);
  expect(entered).toBe(false);
  const missing = join(f.root, "missing", "lock");
  await expect(
    withFileLock({
      path: missing,
      existingOnly: true,
      identity: expected,
      timeoutMs: 1,
      work,
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(entered).toBe(false);
  await expect(lstat(join(f.root, "missing"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
