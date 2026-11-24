import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { readLegacyRuntimeArchiveFilesV1 } from "../src/legacy-runtime-archive-v1.js";
import { legacyWorkerPackageRoleV1 } from "../src/legacy-runtime-identity-v1.js";
import {
  encodeTarFileHeader,
  tarPadding,
  TAR_END_OF_ARCHIVE,
} from "../src/tar-format.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  extra: Array<[string, string]> = [],
  version = "0.46.238+private.1",
) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "omnyo-legacy-artifact-"),
  );

  roots.push(root);

  const input: Array<[string, string]> = [
    [
      "package.json",
      JSON.stringify({
        name: "bb-app",
        version,
        ...legacyWorkerPackageRoleV1,
      }),
    ],
    ["README.md", "published first-party documentation"],
    ...Object.values(legacyWorkerPackageRoleV1.bin).map(
      (path): [string, string] => [path, "#!/usr/bin/env node\n"],
    ),
    ["host-daemon/dist/daemon-bundle.mjs", "export const baseline = true;\n"],
    ...extra,
  ];

  const chunks = input.flatMap(([path, text]) => {
    const bytes = Buffer.from(text);

    return [
      encodeTarFileHeader({
        path: "package/" + path,
        size: bytes.length,
        mode: 0o644,
        mtime: new Date(0),
      }),
      bytes,
      tarPadding(bytes.length),
    ];
  });

  const bytes = gzipSync(Buffer.concat([...chunks, TAR_END_OF_ARCHIVE]));
  const archivePath = join(root, "old-worker.tgz");
  await writeFile(archivePath, bytes);

  return {
    archivePath,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("binds exact published worker files without changing the historical archive", async () => {
  const input = await fixture();
  const before = await readFile(input.archivePath);
  const files = await readLegacyRuntimeArchiveFilesV1(input);
  expect(files.find((file) => file.path === "README.md")?.sha256).toBe(
    createHash("sha256")
      .update("published first-party documentation")
      .digest("hex"),
  );
  expect(files).toHaveLength(6);
  expect(await readFile(input.archivePath)).toEqual(before);
  await expect(
    readLegacyRuntimeArchiveFilesV1({
      ...input,
      archiveSha256: "0".repeat(64),
    }),
  ).rejects.toThrow(/digest/iu);
});

test("refuses duplicate, escaping and unowned files rather than granting retirement authority", async () => {
  for (const extra of [
    [["README.md", "changed"]],
    [["../escape", "opaque"]],
    [["user-work", "opaque"]],
  ] satisfies Array<Array<[string, string]>>) {
    const input = await fixture(extra);
    await expect(readLegacyRuntimeArchiveFilesV1(input)).rejects.toThrow(
      /repeat|unsupported|unowned/iu,
    );
  }
});

test.each(["0.46.241+private.1", "0.46.242+private.1", "0.46.245+private.1"])(
  "binds the %s archive independently and refuses a different or unsupported baseline",
  async (version) => {
    const f = await fixture([], version);
    await expect(
      readLegacyRuntimeArchiveFilesV1(f, version),
    ).resolves.toContainEqual(
      expect.objectContaining({ path: "package.json" }),
    );
    await expect(readLegacyRuntimeArchiveFilesV1(f)).rejects.toThrow();
    await expect(
      readLegacyRuntimeArchiveFilesV1(f, "0.46.239+private.1"),
    ).rejects.toThrow();
  },
);
