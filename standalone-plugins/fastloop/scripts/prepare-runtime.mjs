import { readFile, mkdir, lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PayloadError,
  runtimeLockSchema,
  validateRuntimePackage,
  validateNativeArchive,
} from "../package-payload.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

const args = process.argv.slice(2).filter((value) => value !== "--");

try {
  const options = new Map();

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];

    if (!["--package", "--sha256"].includes(key) || !value || options.has(key))
      throw new PayloadError("RUNTIME_PREPARE_ARGUMENTS_INVALID");
    options.set(key, value);
  }

  const packagePath = options.get("--package");
  const expectedSha256 = options.get("--sha256");

  if (!packagePath || !isAbsolute(packagePath) || !expectedSha256)
    throw new PayloadError("RUNTIME_PREPARE_ARGUMENTS_INVALID");
  let lockBytes;

  try {
    lockBytes = await readFile(resolve(root, "runtime.lock.json"));
  } catch {
    throw new PayloadError("RUNTIME_LOCK_MISSING");
  }

  const lock = runtimeLockSchema.parse(JSON.parse(lockBytes.toString("utf8")));

  if ((await lstat(packagePath)).size > 64 * 1024 * 1024)
    throw new PayloadError("ARCHIVE_BYTES_EXCEEDED");
  const archive = await readFile(packagePath);
  const validated = validateRuntimePackage({ archive, expectedSha256, lock });
  const nativeName = validated.manifest.native.archive;

  if (basename(nativeName) !== nativeName || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(nativeName))
    throw new PayloadError("RUNTIME_NATIVE_PATH_INVALID");
  const nativePath = resolve(dirname(packagePath), nativeName);

  if ((await lstat(nativePath)).size > 64 * 1024 * 1024)
    throw new PayloadError("ARCHIVE_BYTES_EXCEEDED");
  const native = await readFile(nativePath);
  validateNativeArchive(native, validated.manifest);
  const chunks = (bytes) => bytes.toString("base64").match(/.{1,32768}/g) ?? [];
  const metadata = { lock, manifest: validated.manifest };
  const source = `export const runtimeMetadata = JSON.parse(${JSON.stringify(JSON.stringify(metadata))});\nexport const packageArchiveBase64 = ${JSON.stringify(chunks(archive))}.join("");\n`;

  if (Buffer.byteLength(source) > 48 * 1024 * 1024)
    throw new PayloadError("RUNTIME_PAYLOAD_TOO_LARGE");
  const directory = resolve(root, "generated");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  if ((await lstat(directory)).isSymbolicLink()) throw new PayloadError("RUNTIME_PAYLOAD_SYMLINK");
  const temporary = resolve(directory, `.runtime-payload-${randomUUID()}.ts`);
  const file = await open(temporary, "wx", 0o600);

  try {
    try {
      await file.writeFile(source);
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, resolve(directory, "runtime-payload.ts"));
  } finally {
    await rm(temporary, { force: true });
  }

  const infoPath = resolve(directory, "runtime-info.ts");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      infoPath,
      `export const runtimeInfo = ${JSON.stringify({ lock, qualifiedPlatforms: validated.manifest.qualifiedPlatforms })};\n`,
      { mode: 0o600 },
    ),
  );

  process.stdout.write(
    JSON.stringify({
      prepared: true,
      installed: false,
      sha256: validated.archiveSha256,
      packageVersion: validated.manifest.packageVersion,
      protocolVersion: validated.manifest.protocolVersion,
      files: validated.manifest.files.length,
    }) + "\n",
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      prepared: false,
      installed: false,
      code: error instanceof PayloadError ? error.code : "RUNTIME_PREPARATION_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
}
