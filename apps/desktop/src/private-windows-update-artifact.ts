import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Open } from "unzipper";
import { z } from "zod";
import { RELEASE_VERSION_PATTERN } from "@omnyo/config/release-version";
import {
  parseRuntimeIdentity,
  readRuntimeIdentity,
  runtimeIdentityDigest,
  verifyRuntimeIdentity,
} from "@omnyo/server-archive/runtime-identity";
import {
  desktopPackageFromAsar,
  entryBytes,
  hashFile,
  inventoryPath,
} from "./private-update-artifact.js";
import {
  isNewerNativeVersion,
  nativeNumericVersion,
  type PrivateReleaseInfo,
} from "./private-update-config.js";
import type { PrivateUpdateArtifact } from "./private-update-install.js";

const RUNTIME_PACKAGE_PATH = [
  "app.asar.unpacked",
  "node_modules",
  "omnyo-app",
] as const;

const identitySchema = z
  .object({
    schema: z.literal(1),
    appId: z.enum(["dev.omnyo.private", "dev.omnyo.private.nightly"]),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    runtimeVersion: z.string().regex(RELEASE_VERSION_PATTERN),
    protocolVersion: z.number().int().positive(),
    runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.string().regex(/^[A-Za-z0-9 ._-]+\.exe$/),
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    desktopSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

async function embeddedArchive(file: string) {
  const size = (await stat(file)).size;
  const handle = await open(file, "r");
  const candidates: { start: number; length: number }[] = [];

  try {
    const magic = Buffer.alloc(2);
    await handle.read(magic, 0, 2, 0);

    if (magic.toString() !== "MZ" || size > 2 * 1024 ** 3) throw new Error();
    let carry = Buffer.alloc(0);

    for (let position = 0; position < size; position += 1024 ** 2) {
      const chunk = Buffer.alloc(Math.min(1024 ** 2, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);

      if (bytesRead !== chunk.length) throw new Error();
      const bytes = Buffer.concat([carry, chunk]);

      for (
        let offset = 0;
        (offset = bytes.indexOf(
          Buffer.from([0x50, 0x4b, 0x05, 0x06]),
          offset,
        )) >= 0;
        offset++
      ) {
        if (offset + 22 > bytes.length) break;

        if (
          bytes.readUInt16LE(offset + 4) !== 0 ||
          bytes.readUInt16LE(offset + 6) !== 0 ||
          bytes.readUInt16LE(offset + 8) !== bytes.readUInt16LE(offset + 10)
        )
          continue;
        const end = position - carry.length + offset;

        const start =
          end -
          bytes.readUInt32LE(offset + 12) -
          bytes.readUInt32LE(offset + 16);

        const length = end + 22 + bytes.readUInt16LE(offset + 20) - start;

        if (start >= 2 && length > 22 && start + length <= size)
          candidates.push({ start, length });

        if (candidates.length > 64) throw new Error();
      }

      carry = bytes.subarray(Math.max(0, bytes.length - 21));
    }
  } finally {
    await handle.close();
  }

  const archives = [];

  for (const candidate of candidates) {
    try {
      const archive = await Open.custom({
        size: async () => candidate.length,
        stream: (offset: number, length?: number) =>
          createReadStream(file, {
            start: candidate.start + offset,
            end: Math.min(
              candidate.start + candidate.length - 1,
              candidate.start + offset + (length ?? candidate.length) - 1,
            ),
          }),
      });

      if (
        archive.files.some(
          (entry) => entry.path === "resources/private-update-identity.json",
        )
      )
        archives.push(archive);
    } catch {
      continue;
    }
  }

  if (
    archives.length !== 1 ||
    !archives[0] ||
    archives[0].files.length > 200000
  )
    throw new Error();

  return archives[0];
}

export async function inspectDownloadedPrivateWindowsUpdate(args: {
  file: string;
  release: PrivateReleaseInfo;
  currentVersion: string;
  expectedAppId: string;
  expectedProtocolVersion: number;
}): Promise<PrivateUpdateArtifact> {
  const scratch = await mkdtemp(
    join(tmpdir(), "omnyo-private-windows-update-"),
  );

  try {
    const expected = args.release.files[0];

    if (
      !expected ||
      (await stat(args.file)).size !== expected.size ||
      (await hashFile(args.file, "sha512")) !== expected.sha512 ||
      args.release.omnyoPrivate.platform !== "windows" ||
      args.release.omnyoPrivate.teamId !== ""
    )
      throw new Error();
    const archive = await embeddedArchive(args.file);
    const entries = new Map(archive.files.map((entry) => [entry.path, entry]));

    if (
      entries.size !== archive.files.length ||
      archive.files.some(
        (entry) =>
          entry.path.startsWith("/") ||
          entry.path.includes("\\") ||
          entry.path.split("/").some((part) => part === ".." || part === "."),
      )
    )
      throw new Error();
    const metadataEntry = entries.get("resources/private-update-identity.json");
    const runtimePrefix = ["resources", ...RUNTIME_PACKAGE_PATH, ""].join("/");

    const runtimeEntry = entries.get(
      runtimePrefix + "dist/runtime-identity.json",
    );

    const asarEntry = entries.get("resources/app.asar");

    if (!metadataEntry || !runtimeEntry || !asarEntry) throw new Error();

    const metadata = identitySchema.parse(
      JSON.parse((await entryBytes(metadataEntry, 131072)).toString("utf8")),
    );

    const identity = parseRuntimeIdentity(
      JSON.parse(
        (await entryBytes(runtimeEntry, 16 * 1024 ** 2)).toString("utf8"),
      ),
    );

    if (
      metadata.appId !== args.expectedAppId ||
      metadata.appId !== args.release.omnyoPrivate.appId ||
      metadata.version !== args.release.version ||
      !isNewerNativeVersion(metadata.version, args.currentVersion) ||
      nativeNumericVersion(metadata.runtimeVersion) !== metadata.version ||
      metadata.runtimeVersion !== args.release.omnyoPrivate.runtimeVersion ||
      metadata.protocolVersion < args.expectedProtocolVersion ||
      metadata.protocolVersion !== args.release.omnyoPrivate.protocolVersion ||
      metadata.protocolVersion !== identity.hostDaemonProtocolVersion ||
      metadata.runtimeVersion !== identity.runtimeVersion ||
      metadata.runtimeSha256 !== identity.runtimeSha256 ||
      metadata.runtimeSha256 !== args.release.omnyoPrivate.runtimeSha256
    )
      throw new Error();
    const asar = join(scratch, "app.asar");
    await writeFile(asar, await entryBytes(asarEntry, 512 * 1024 ** 2));

    if (
      (await hashFile(asar, "sha256")) !== metadata.desktopSha256 ||
      metadata.desktopSha256 !== args.release.omnyoPrivate.desktopSha256 ||
      metadata.executableSha256 !== args.release.omnyoPrivate.executableSha256
    )
      throw new Error();

    const desktop = z
      .object({
        version: z.string(),
        name: z.enum(["omnyo-private", "omnyo-private-nightly"]),
      })
      .parse(JSON.parse(desktopPackageFromAsar(asar).toString("utf8")));

    if (
      desktop.version !== metadata.runtimeVersion ||
      desktop.name !==
        (metadata.appId.endsWith(".nightly")
          ? "omnyo-private-nightly"
          : "omnyo-private")
    )
      throw new Error();
    const executable = entries.get(metadata.executable);

    if (!executable || executable.uncompressedSize > 512 * 1024 ** 2)
      throw new Error();
    const executableHash = createHash("sha256");

    for await (const chunk of executable.stream()) executableHash.update(chunk);

    if (executableHash.digest("hex") !== metadata.executableSha256)
      throw new Error();
    const files: { path: string; sha256: string }[] = [];
    let total = 0;

    for (const entry of archive.files) {
      if (!entry.path.startsWith(runtimePrefix) || entry.type === "Directory")
        continue;
      const path = entry.path.slice(runtimePrefix.length);

      if (!inventoryPath(path)) continue;
      total += entry.uncompressedSize;

      if (
        total > 8 * 1024 ** 3 ||
        entry.uncompressedSize > 1024 ** 3 ||
        Math.floor(entry.externalFileAttributes / 65536 / 4096) === 10
      )
        throw new Error();
      const hash = createHash("sha256");
      let size = 0;

      for await (const chunk of entry.stream()) {
        size += chunk.length;

        if (size > entry.uncompressedSize) throw new Error();
        hash.update(chunk);
      }

      if (size !== entry.uncompressedSize) throw new Error();
      files.push({ path, sha256: hash.digest("hex") });
    }

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    if (
      JSON.stringify(files) !== JSON.stringify(identity.files) ||
      runtimeIdentityDigest(files) !== metadata.runtimeSha256 ||
      (await hashFile(args.file, "sha512")) !== expected.sha512
    )
      throw new Error();

    return {
      version: metadata.version,
      runtimeVersion: metadata.runtimeVersion,
      protocolVersion: metadata.protocolVersion,
      appId: metadata.appId,
      teamId: "",
      sha512: expected.sha512,
      runtimeSha256: metadata.runtimeSha256,
      desktopSha256: metadata.desktopSha256,
      executableSha256: metadata.executableSha256,
    };
  } catch (error) {
    throw new Error("Private Windows update artifact is invalid", {
      cause: error,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function inspectInstalledPrivateWindowsUpdate(
  appRoot: string,
): Promise<PrivateUpdateArtifact> {
  try {
    const resources = join(appRoot, "resources");

    const metadata = identitySchema.parse(
      JSON.parse(
        await readFile(join(resources, "private-update-identity.json"), "utf8"),
      ),
    );

    const runtimeRoot = join(resources, ...RUNTIME_PACKAGE_PATH);

    const identity = await readRuntimeIdentity(runtimeRoot);
    await verifyRuntimeIdentity(runtimeRoot, identity);

    const desktop = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          desktopPackageFromAsar(join(resources, "app.asar")).toString("utf8"),
        ),
      );

    if (
      (await hashFile(join(resources, "app.asar"), "sha256")) !==
      metadata.desktopSha256
    )
      throw new Error();

    if (
      metadata.runtimeVersion !== desktop.version ||
      metadata.runtimeVersion !== identity.runtimeVersion ||
      metadata.protocolVersion !== identity.hostDaemonProtocolVersion ||
      metadata.runtimeSha256 !== identity.runtimeSha256 ||
      nativeNumericVersion(metadata.runtimeVersion) !== metadata.version ||
      (await hashFile(join(appRoot, metadata.executable), "sha256")) !==
        metadata.executableSha256
    )
      throw new Error();

    return {
      version: metadata.version,
      runtimeVersion: metadata.runtimeVersion,
      protocolVersion: metadata.protocolVersion,
      appId: metadata.appId,
      teamId: "",
      sha512: "",
      runtimeSha256: metadata.runtimeSha256,
      desktopSha256: metadata.desktopSha256,
      executableSha256: metadata.executableSha256,
    };
  } catch (error) {
    throw new Error("Private Windows installed identity is invalid", {
      cause: error,
    });
  }
}
