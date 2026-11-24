import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFileSystem from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Open, type File } from "unzipper";
import { z } from "zod";
import { extractFile, statFile } from "@electron/asar";
import { macBundleVersion } from "@omnyo/config/release-version";
import {
  parseRuntimeIdentity,
  runtimeIdentityDigest,
  readRuntimeIdentity,
  verifyRuntimeIdentity,
} from "@omnyo/server-archive/runtime-identity";
import {
  isNewerNativeVersion,
  nativeNumericVersion,
  PRIVATE_UPDATE_TEAM_ID,
  type PrivateReleaseInfo,
} from "./private-update-config.js";
import type { PrivateUpdateArtifact } from "./private-update-install.js";

const fileSystem: typeof nodeFileSystem = process.versions.electron
  ? createRequire(process.execPath)("original-fs")
  : nodeFileSystem;

const { createReadStream } = fileSystem;

const { lstat, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } =
  fileSystem.promises;

const execute = promisify(execFile);

const plistSchema = z.object({
  CFBundleIdentifier: z.string(),
  CFBundleExecutable: z.string().regex(/^[A-Za-z0-9 ._-]+$/),
  CFBundleVersion: z.string(),
  CFBundleShortVersionString: z.string(),
});

const runtimePackageSchema = z.object({
  name: z.literal("omnyo-app"),
  version: z.string(),
});

function nativeIdentityMatchesRuntime(
  native: z.infer<typeof plistSchema>,
  runtimeVersion: string,
  protocolVersion: number,
): boolean {
  const version = nativeNumericVersion(runtimeVersion);

  return (
    native.CFBundleShortVersionString === version &&
    native.CFBundleVersion ===
      (protocolVersion >= 236 ? macBundleVersion(runtimeVersion) : version)
  );
}

export function desktopPackageFromAsar(path: string): Buffer {
  const entry = statFile(path, "package.json", false);

  if (
    !("size" in entry) ||
    entry.unpacked ||
    entry.size < 0 ||
    entry.size > 131072
  )
    throw new Error();

  return extractFile(path, "package.json", false);
}

async function desktopVersion(contents: string): Promise<string> {
  const resources = join(contents, "Resources");

  const archive = (await readdir(resources, { withFileTypes: true })).find(
    (entry) => entry.name === "app.asar",
  );

  if (archive !== undefined && !archive.isFile()) throw new Error();

  const bytes =
    archive === undefined
      ? await readFile(join(resources, "app", "package.json"))
      : desktopPackageFromAsar(join(resources, "app.asar"));

  if (bytes.length > 131072) throw new Error();

  return z
    .object({ version: z.string() })
    .parse(JSON.parse(bytes.toString("utf8"))).version;
}

export async function verifyPrivateUpdateArchiveMatchesApp(
  file: string,
  appRoot: string,
): Promise<void> {
  const archive = await Open.file(file);
  const root = appRoot.split("/").at(-1) + "/";
  const expected = new Set<string>();

  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;

      if (entry.isDirectory())
        await walk(join(directory, entry.name), path + "/");
      else expected.add(path);
    }
  }

  await walk(appRoot, "");
  const seen = new Set<string>();

  for (const entry of archive.files) {
    if (entry.path.startsWith("__MACOSX/")) continue;

    if (!entry.path.startsWith(root))
      throw new Error("Private ZIP bundle differs from verified app");
    const path = entry.path.slice(root.length);

    if (entry.type === "Directory") continue;

    if (
      !expected.has(path) ||
      seen.has(path) ||
      path.split("/").some((p) => p === ".." || p === ".") ||
      path.includes("\\")
    )
      throw new Error("Private ZIP bundle differs from verified app");
    seen.add(path);
    const source = join(appRoot, path);
    const info = await lstat(source);
    const mode = Math.floor(entry.externalFileAttributes / 65536) % 65536;

    if (info.isSymbolicLink()) {
      if (
        Math.floor(mode / 4096) !== 10 ||
        (await entryBytes(entry, 131072)).toString("utf8") !==
          (await readlink(source))
      )
        throw new Error("Private ZIP bundle differs from verified app");
    } else {
      if (
        !info.isFile() ||
        Math.floor(mode / 4096) === 10 ||
        info.size !== entry.uncompressedSize
      )
        throw new Error("Private ZIP bundle differs from verified app");
      const hash = createHash("sha256");
      let size = 0;

      for await (const chunk of entry.stream()) {
        size += chunk.length;

        if (size > info.size) throw new Error();
        hash.update(chunk);
      }

      if (
        size !== info.size ||
        hash.digest("hex") !== (await hashFile(source, "sha256"))
      )
        throw new Error("Private ZIP bundle differs from verified app");
    }
  }

  if (seen.size !== expected.size)
    throw new Error("Private ZIP bundle differs from verified app");
}

export async function hashFile(path: string, algorithm: "sha256" | "sha512") {
  const digest = createHash(algorithm);

  for await (const chunk of createReadStream(path)) digest.update(chunk);

  return digest.digest(algorithm === "sha512" ? "base64" : "hex");
}

export async function entryBytes(entry: File, limit: number): Promise<Buffer> {
  if (
    entry.type !== "File" ||
    entry.uncompressedSize > limit ||
    entry.uncompressedSize < 0
  )
    throw new Error();
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of entry.stream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;

    if (size > limit) throw new Error();
    chunks.push(bytes);
  }

  if (size !== entry.uncompressedSize) throw new Error();

  return Buffer.concat(chunks);
}

async function plist(path: string) {
  const result = await execute(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", path],
    { timeout: 5000, maxBuffer: 131072 },
  );

  return plistSchema.parse(JSON.parse(result.stdout));
}

async function signedTeam(path: string) {
  const result = await execute(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", path],
    { timeout: 5000, maxBuffer: 131072 },
  );

  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(result.stderr)?.[1];

  if (team !== PRIVATE_UPDATE_TEAM_ID) throw new Error();

  return team;
}

export function inventoryPath(path: string): boolean {
  return (
    (path === "package.json" ||
      ["dist/", "server/dist/", "host-daemon/dist/", "app/dist/"].some(
        (prefix) => path.startsWith(prefix),
      )) &&
    path !== "dist/runtime-identity.json" &&
    !path.endsWith(".map")
  );
}

export async function inspectDownloadedPrivateUpdate(args: {
  file: string;
  release: PrivateReleaseInfo;
  currentVersion: string;
  expectedAppId: string;
  expectedProtocolVersion: number;
}): Promise<PrivateUpdateArtifact> {
  let scratch: string | null = null;
  let gate = "ZIP digest";

  try {
    const zipInfo = await stat(args.file);
    const expectedFile = args.release.files[0];

    if (
      !zipInfo.isFile() ||
      !expectedFile ||
      zipInfo.size !== expectedFile.size ||
      zipInfo.size > 2 * 1024 ** 3 ||
      (await hashFile(args.file, "sha512")) !== expectedFile.sha512
    )
      throw new Error();
    gate = "archive structure";
    const archive = await Open.file(args.file);

    if (archive.files.length > 200000) throw new Error();
    const entries = new Map<string, File>();

    for (const file of archive.files) {
      const path = file.path;

      if (
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => part === "." || part === "..") ||
        entries.has(path)
      )
        throw new Error();
      entries.set(path, file);
    }

    const plists = [...entries.keys()].filter((path) =>
      /^[^/]+\.app\/Contents\/Info\.plist$/.test(path),
    );

    const infoPath = plists[0];

    if (plists.length !== 1 || !infoPath) throw new Error();
    const contents = infoPath.slice(0, -"Info.plist".length);

    const runtimeRoot =
      contents + "Resources/app.asar.unpacked/node_modules/omnyo-app/";

    gate = "bundle identity";
    scratch = await mkdtemp(join(tmpdir(), "omnyo-private-update-metadata-"));
    const infoEntry = entries.get(infoPath);

    if (!infoEntry) throw new Error();
    const localPlist = join(scratch, "Info.plist");
    await writeFile(localPlist, await entryBytes(infoEntry, 131072));
    const native = await plist(localPlist);

    if (
      native.CFBundleIdentifier !== args.expectedAppId ||
      native.CFBundleIdentifier !== args.release.omnyoPrivate.appId ||
      native.CFBundleShortVersionString !== args.release.version ||
      !isNewerNativeVersion(
        native.CFBundleShortVersionString,
        args.currentVersion,
      )
    )
      throw new Error();

    const executableEntry = entries.get(
      contents + "MacOS/" + native.CFBundleExecutable,
    );

    if (!executableEntry) throw new Error();
    const executable = join(scratch, "signed-executable");
    await writeFile(
      executable,
      await entryBytes(executableEntry, 64 * 1024 ** 2),
      { mode: 0o600 },
    );
    gate = "signing team";
    const teamId = await signedTeam(executable);
    gate = "runtime identity";

    const identityEntry = entries.get(
      runtimeRoot + "dist/runtime-identity.json",
    );

    const packageEntry = entries.get(runtimeRoot + "package.json");

    if (!identityEntry || !packageEntry) throw new Error();

    const identity = parseRuntimeIdentity(
      JSON.parse(
        (await entryBytes(identityEntry, 16 * 1024 ** 2)).toString("utf8"),
      ),
    );

    const runtimePackage = runtimePackageSchema.parse(
      JSON.parse((await entryBytes(packageEntry, 131072)).toString("utf8")),
    );

    const desktopAsar = entries.get(contents + "Resources/app.asar");
    let logicalDesktopVersion: string;
    let desktopSha256: string | undefined;

    if (desktopAsar) {
      const asarPath = join(scratch, "desktop-package.bin");
      await writeFile(asarPath, await entryBytes(desktopAsar, 512 * 1024 ** 2));
      desktopSha256 = await hashFile(asarPath, "sha256");
      logicalDesktopVersion = z
        .object({ version: z.string() })
        .parse(
          JSON.parse(desktopPackageFromAsar(asarPath).toString("utf8")),
        ).version;
    } else {
      const packageEntry = entries.get(contents + "Resources/app/package.json");

      if (!packageEntry) throw new Error();
      logicalDesktopVersion = z
        .object({ version: z.string() })
        .parse(
          JSON.parse((await entryBytes(packageEntry, 131072)).toString("utf8")),
        ).version;
    }

    const executableSha256 = await hashFile(executable, "sha256");
    const files: { path: string; sha256: string }[] = [];
    let total = 0;

    for (const entry of archive.files) {
      if (!entry.path.startsWith(runtimeRoot) || entry.type === "Directory")
        continue;
      const path = entry.path.slice(runtimeRoot.length);

      if (!inventoryPath(path)) continue;
      const mode = Math.floor(entry.externalFileAttributes / 65536) % 65536;

      if (Math.floor(mode / 4096) === 10) throw new Error();
      total += entry.uncompressedSize;

      if (total > 8 * 1024 ** 3 || entry.uncompressedSize > 1024 ** 3)
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
      runtimeIdentityDigest(files) !== identity.runtimeSha256 ||
      JSON.stringify(files) !== JSON.stringify(identity.files) ||
      logicalDesktopVersion !== identity.runtimeVersion ||
      runtimePackage.version !== identity.runtimeVersion ||
      identity.runtimeVersion !== args.release.omnyoPrivate.runtimeVersion ||
      !nativeIdentityMatchesRuntime(
        native,
        identity.runtimeVersion,
        identity.hostDaemonProtocolVersion,
      ) ||
      identity.hostDaemonProtocolVersion < args.expectedProtocolVersion ||
      identity.hostDaemonProtocolVersion !==
        args.release.omnyoPrivate.protocolVersion ||
      teamId !== args.release.omnyoPrivate.teamId ||
      (args.release.omnyoPrivate.desktopSha256 !== undefined &&
        args.release.omnyoPrivate.desktopSha256 !== desktopSha256) ||
      (args.release.omnyoPrivate.executableSha256 !== undefined &&
        args.release.omnyoPrivate.executableSha256 !== executableSha256) ||
      (await hashFile(args.file, "sha512")) !== expectedFile.sha512
    )
      throw new Error();

    return {
      version: native.CFBundleShortVersionString,
      runtimeVersion: identity.runtimeVersion,
      protocolVersion: identity.hostDaemonProtocolVersion,
      appId: native.CFBundleIdentifier,
      teamId,
      sha512: expectedFile.sha512,
      runtimeSha256: identity.runtimeSha256,
      executableSha256,
      ...(desktopSha256 === undefined ? {} : { desktopSha256 }),
    };
  } catch (error) {
    throw new Error(`Private update artifact is invalid (${gate})`, {
      cause: error,
    });
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true });
  }
}

export async function inspectInstalledPrivateUpdate(
  appRoot: string,
): Promise<PrivateUpdateArtifact> {
  let gate = "bundle identity";

  try {
    const contents = join(appRoot, "Contents");
    const native = await plist(join(contents, "Info.plist"));
    gate = "full bundle signature";
    await execute(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", appRoot],
      { timeout: 30000, maxBuffer: 131072 },
    );

    gate = "signing team";

    const teamId = await signedTeam(
      join(contents, "MacOS", native.CFBundleExecutable),
    );

    const runtimeRoot = join(
      contents,
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "omnyo-app",
    );

    gate = "runtime identity";
    const identity = await readRuntimeIdentity(runtimeRoot);
    await verifyRuntimeIdentity(runtimeRoot, identity);

    const runtimePackage = runtimePackageSchema.parse(
      JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")),
    );

    gate = "logical version agreement";

    if (
      (await desktopVersion(contents)) !== identity.runtimeVersion ||
      runtimePackage.version !== identity.runtimeVersion ||
      !nativeIdentityMatchesRuntime(
        native,
        identity.runtimeVersion,
        identity.hostDaemonProtocolVersion,
      )
    )
      throw new Error();

    const desktopArchive = join(contents, "Resources", "app.asar");

    const desktopInfo = await lstat(desktopArchive).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (
      desktopInfo !== null &&
      (!desktopInfo.isFile() || desktopInfo.isSymbolicLink())
    )
      throw new Error();

    const desktopSha256 =
      desktopInfo === null
        ? undefined
        : await hashFile(desktopArchive, "sha256");

    return {
      version: native.CFBundleShortVersionString,
      runtimeVersion: identity.runtimeVersion,
      protocolVersion: identity.hostDaemonProtocolVersion,
      appId: native.CFBundleIdentifier,
      teamId,
      sha512: "",
      runtimeSha256: identity.runtimeSha256,
      executableSha256: await hashFile(
        join(contents, "MacOS", native.CFBundleExecutable),
        "sha256",
      ),
      ...(desktopSha256 === undefined ? {} : { desktopSha256 }),
    };
  } catch (error) {
    throw new Error(`Private installed update identity is invalid at ${gate}`, {
      cause: error,
    });
  }
}
