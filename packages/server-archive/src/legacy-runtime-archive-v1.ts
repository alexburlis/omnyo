import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { TarReader } from "./tar-format.js";
import { isSafeRelativePath } from "./relative-path.js";
import {
  legacyFullPackageRoleV1,
  legacyInstalledRuntimeVersionV1Schema,
  legacyWorkerPackageRoleV1,
} from "./legacy-runtime-identity-v1.js";

export const legacyRuntimeArchiveV1Schema = z
  .object({
    archivePath: z
      .string()
      .min(1)
      .refine(
        (path) =>
          (posix.isAbsolute(path) && posix.normalize(path) === path) ||
          (win32.isAbsolute(path) && win32.normalize(path) === path),
      ),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export async function readLegacyRuntimeArchiveFilesV1(
  value: unknown,
  runtimeVersion = "0.46.238+private.1",
) {
  const expectedVersion =
    legacyInstalledRuntimeVersionV1Schema.parse(runtimeVersion);

  const input = legacyRuntimeArchiveV1Schema.parse(value);
  const info = await lstat(input.archivePath);

  if (
    resolve(input.archivePath) !== input.archivePath ||
    (await realpath(input.archivePath)) !== input.archivePath ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 128 * 1024 * 1024 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new Error("Legacy runtime archive is not an ordinary bounded input");
  const hash = createHash("sha256");
  const source = createReadStream(input.archivePath);
  const gunzip = createGunzip();
  source.on("data", (chunk) => hash.update(chunk));
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = new TarReader(gunzip);
  const files = new Map<string, string>();
  let packageJson: unknown;
  let total = 0;

  try {
    for (;;) {
      const entry = await reader.nextEntry();

      if (entry === null) break;

      if (
        entry.type === "Directory" &&
        entry.path.startsWith("package/") &&
        isSafeRelativePath(entry.path.replace(/\/$/u, ""))
      )
        continue;

      if (
        entry.type !== "File" ||
        !entry.path.startsWith("package/") ||
        !isSafeRelativePath(entry.path) ||
        entry.size > 64 * 1024 * 1024 ||
        files.size >= 65_536 ||
        (total += entry.size) > 1024 * 1024 * 1024
      )
        throw new Error("Legacy runtime archive has an unsupported entry");
      const path = entry.path.slice("package/".length);

      if (files.has(path))
        throw new Error("Legacy runtime archive repeats a file");
      const fileHash = createHash("sha256");

      if (path === "package.json") {
        if (entry.size > 1024 * 1024)
          throw new Error(
            "Legacy runtime archive package metadata is oversized",
          );
        const bytes = await reader.readBodyBuffer();
        fileHash.update(bytes);
        packageJson = JSON.parse(bytes.toString("utf8"));
      } else
        for await (const bytes of reader.readBody()) fileHash.update(bytes);
      files.set(path, fileHash.digest("hex"));
    }

    if (hash.digest("hex") !== input.archiveSha256)
      throw new Error(
        "Legacy runtime archive digest differs from its bound artifact",
      );

    const metadata = z
      .object({
        name: z.literal("bb-app"),
        version: z.literal(expectedVersion),
        files: z.array(z.string()),
        bin: z.record(z.string(), z.string()),
      })
      .parse(packageJson);

    const canonical = (
      role: typeof legacyWorkerPackageRoleV1 | typeof legacyFullPackageRoleV1,
    ) =>
      JSON.stringify([...metadata.files].sort()) ===
        JSON.stringify([...role.files].sort()) &&
      JSON.stringify(Object.entries(metadata.bin).sort()) ===
        JSON.stringify(Object.entries(role.bin).sort());

    const full =
      files.has("server/dist/index.js") ||
      [...files.keys()].some((path) => path.startsWith("server/dist/"));

    const app = [...files.keys()].some((path) => path.startsWith("app/dist/"));

    if (
      full !== app ||
      !(full
        ? canonical(legacyFullPackageRoleV1)
        : canonical(legacyWorkerPackageRoleV1))
    )
      throw new Error(
        "Legacy runtime archive does not declare its finite product role",
      );

    for (const path of files.keys())
      if (
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        ![
          "dist/",
          "host-daemon/dist/",
          ...(full ? ["server/dist/", "app/dist/"] : []),
        ].some((root) => path.startsWith(root))
      )
        throw new Error(
          "Legacy runtime archive contains an unowned product path",
        );

    for (const path of [
      ...Object.values(metadata.bin),
      "host-daemon/dist/daemon-bundle.mjs",
    ])
      if (!files.has(path))
        throw new Error("Legacy runtime archive is missing its declared entry");

    return [...files]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}
