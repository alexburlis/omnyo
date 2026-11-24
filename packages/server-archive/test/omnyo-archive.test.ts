import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { extractServerArchive } from "../src/extract-archive.js";
import { parseServerArchiveManifest } from "../src/manifest.js";
import { writeServerArchive } from "../src/write-archive.js";
import {
  encodeTarFileHeader,
  TAR_END_OF_ARCHIVE,
  tarPadding,
} from "../src/tar-format.js";

const fixtures: string[] = [];

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const manifestInput = {
  createdAt: 17,
  appVersion: "1.0.0",
  protocolVersion: 253,
  migrationCount: 162,
  sourceDataDir: "/synthetic/source",
  sourceServerHostId: "stable-host",
  serverMoveExperiment: false,
};

afterEach(async () => {
  for (const path of fixtures.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "omnyo-archive-"));
  fixtures.push(root);

  return root;
}

function tarFile(path: string, body: Buffer) {
  return Buffer.concat([
    encodeTarFileHeader({
      path,
      size: body.length,
      mode: 0o600,
      mtime: new Date(17),
    }),
    body,
    tarPadding(body.length),
  ]);
}

function legacyManifest(
  entries: { path: string; size: number; sha256: string }[],
) {
  const { appVersion, ...rest } = manifestInput;

  return {
    ...rest,
    format: "bb-server-archive",
    version: 2,
    bbVersion: appVersion,
    entries,
  };
}

test("writes only canonical archive metadata and round-trips canonical database bytes", async () => {
  const root = await fixture();
  const bytes = Buffer.from("synthetic database bytes");
  await writeFile(join(root, "source"), bytes);

  const result = await writeServerArchive({
    outPath: join(root, "archive.gz"),
    files: [{ sourcePath: join(root, "source"), archivePath: "app.db" }],
    manifest: manifestInput,
  });

  expect(result.manifest).toMatchObject({
    format: "omnyo-server-archive",
    version: 3,
    appVersion: "1.0.0",
  });
  expect(result.manifest).not.toHaveProperty("bbVersion");

  const imported = await extractServerArchive({
    archivePath: join(root, "archive.gz"),
    destinationDir: join(root, "extracted"),
  });

  expect(imported.entries[0].path).toBe("app.db");
  expect(await readFile(join(root, "extracted/files/app.db"))).toEqual(bytes);
});

test("imports exact legacy v2 metadata and database path without changing the original archive", async () => {
  const root = await fixture();
  const bytes = Buffer.from("unchanged legacy database bytes");

  const manifest = legacyManifest([
    { path: "bb.db", size: bytes.length, sha256: digest(bytes) },
  ]);

  const original = gzipSync(
    Buffer.concat([
      tarFile("manifest.json", Buffer.from(JSON.stringify(manifest))),
      tarFile("files/bb.db", bytes),
      TAR_END_OF_ARCHIVE,
    ]),
  );

  const archivePath = join(root, "legacy.gz");
  await writeFile(archivePath, original);

  const imported = await extractServerArchive({
    archivePath,
    destinationDir: join(root, "extracted"),
  });

  expect(imported).toMatchObject({
    format: "omnyo-server-archive",
    version: 3,
    appVersion: "1.0.0",
  });
  expect(imported.entries).toEqual([
    { path: "app.db", size: bytes.length, sha256: digest(bytes) },
  ]);
  expect(await readFile(join(root, "extracted/files/app.db"))).toEqual(bytes);
  expect(digest(await readFile(archivePath))).toBe(digest(original));
  expect(manifest.entries[0].path).toBe("bb.db");
});

test("refuses legacy/canonical path convergence and conflicting version fields", () => {
  const entries = ["bb.db", "app.db"].map((path) => ({
    path,
    size: 1,
    sha256: "a".repeat(64),
  }));

  expect(() => parseServerArchiveManifest(legacyManifest(entries))).toThrow(
    /conflict/,
  );
  expect(() =>
    parseServerArchiveManifest({
      ...legacyManifest([]),
      appVersion: "different",
    }),
  ).toThrow();

  const equal = parseServerArchiveManifest({
    ...legacyManifest([]),
    appVersion: "1.0.0",
  });

  expect(equal.appVersion).toBe("1.0.0");
  expect(equal).not.toHaveProperty("bbVersion");
});

test("rejects unsupported legacy versions and obsolete encrypted archives", async () => {
  expect(() =>
    parseServerArchiveManifest({ ...legacyManifest([]), version: 1 }),
  ).toThrow(/Unsupported/);
  const root = await fixture();
  const path = join(root, "encrypted");
  await writeFile(path, Buffer.from("BBSA synthetic unsupported archive"));
  await expect(
    extractServerArchive({
      archivePath: path,
      destinationDir: join(root, "out"),
    }),
  ).rejects.toThrow(/encrypted/);
});
