import { constants, createWriteStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { hasErrorCode, ServerArchiveError } from "./errors.js";
import {
  SERVER_ARCHIVE_FILES_DIR_NAME,
  SERVER_ARCHIVE_FORMAT,
  SERVER_ARCHIVE_MANIFEST_PATH,
  SERVER_ARCHIVE_VERSION,
  type ServerArchiveManifest,
  type ServerArchiveManifestEntry,
  type ServerArchiveManifestInput,
  serverArchiveManifestSchema,
} from "./manifest.js";
import { findRelativePathConflict } from "./relative-path.js";
import { isServerOwnedPath } from "./server-owned-paths.js";
import {
  encodeTarFileHeader,
  TAR_END_OF_ARCHIVE,
  tarPadding,
} from "./tar-format.js";

const READ_CHUNK_BYTES = 256 * 1024;

const IN_MEMORY_FILE_MODE = 0o600;

export interface ServerArchiveSourceFile {
  sourcePath: string;
  archivePath: string;
  contents?: Buffer;
}

export interface WriteServerArchiveArgs {
  outPath: string;
  files: readonly ServerArchiveSourceFile[];
  manifest: ServerArchiveManifestInput;
}

export interface StreamServerArchiveArgs {
  files: readonly ServerArchiveSourceFile[];
  manifest: ServerArchiveManifestInput;
  output: Writable;
  signal: AbortSignal;
}

export interface ServerArchiveDigest {
  sha256: string;
  sizeBytes: number;
}

export interface WriteServerArchiveResult extends ServerArchiveDigest {
  manifest: ServerArchiveManifest;
}

interface PlannedArchiveFile {
  sourcePath: string;
  contents: Buffer | null;
  mode: number;
  entry: ServerArchiveManifestEntry;
}

export interface ServerArchivePlan {
  readonly manifest: ServerArchiveManifest;
  readonly files: readonly PlannedArchiveFile[];
}

export interface PlanServerArchiveArgs {
  files: readonly ServerArchiveSourceFile[];
  manifest: ServerArchiveManifestInput;
  signal: AbortSignal | null;
}

export interface PipeServerArchiveArgs {
  plan: ServerArchivePlan;
  output: Writable;
  signal: AbortSignal | null;
}

async function openSourceFile(sourcePath: string): Promise<FileHandle> {
  const pathStats =
    process.platform === "win32"
      ? await lstat(sourcePath, { bigint: true })
      : null;

  if (pathStats?.isSymbolicLink()) {
    throw new ServerArchiveError(
      "unsafe_entry",
      `${sourcePath} is a symbolic link`,
    );
  }

  const handle = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if (hasErrorCode(error, "ELOOP")) {
      throw new ServerArchiveError(
        "unsafe_entry",
        `${sourcePath} is a symbolic link`,
      );
    }

    throw error;
  });

  const stats = await handle.stat({ bigint: true });

  if (!stats.isFile()) {
    await handle.close();
    throw new ServerArchiveError(
      "unsafe_entry",
      `${sourcePath} is not a regular file`,
    );
  }

  if (
    pathStats !== null &&
    (stats.ino !== pathStats.ino || stats.dev !== pathStats.dev)
  ) {
    await handle.close();
    throw new ServerArchiveError(
      "unsafe_entry",
      `${sourcePath} changed while it was being opened`,
    );
  }

  return handle;
}

async function* readFileChunks(
  handle: FileHandle,
  limit: number | null,
): AsyncGenerator<Buffer> {
  let position = 0;

  for (;;) {
    const length =
      limit === null
        ? READ_CHUNK_BYTES
        : Math.min(READ_CHUNK_BYTES, limit - position);

    if (length === 0) {
      return;
    }

    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);

    if (bytesRead === 0) {
      return;
    }

    position += bytesRead;
    yield bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  }
}

async function planArchiveFile(
  file: ServerArchiveSourceFile,
  signal: AbortSignal | null,
): Promise<PlannedArchiveFile> {
  if (file.contents !== undefined) {
    return {
      sourcePath: file.sourcePath,
      contents: file.contents,
      mode: IN_MEMORY_FILE_MODE,
      entry: {
        path: file.archivePath,
        size: file.contents.length,
        sha256: createHash("sha256").update(file.contents).digest("hex"),
      },
    };
  }

  const handle = await openSourceFile(file.sourcePath);

  try {
    const stats = await handle.stat();
    const hash = createHash("sha256");
    let size = 0;

    for await (const chunk of readFileChunks(handle, null)) {
      signal?.throwIfAborted();
      hash.update(chunk);
      size += chunk.length;
    }

    return {
      sourcePath: file.sourcePath,
      contents: null,
      mode: stats.mode & 0o777,
      entry: { path: file.archivePath, size, sha256: hash.digest("hex") },
    };
  } finally {
    await handle.close();
  }
}

async function* generateTarChunks(
  manifest: ServerArchiveManifest,
  plannedFiles: readonly PlannedArchiveFile[],
): AsyncGenerator<Buffer> {
  const mtime = new Date(manifest.createdAt);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  yield encodeTarFileHeader({
    path: SERVER_ARCHIVE_MANIFEST_PATH,
    size: manifestBytes.length,
    mode: 0o600,
    mtime,
  });
  yield manifestBytes;
  yield tarPadding(manifestBytes.length);

  for (const file of plannedFiles) {
    yield encodeTarFileHeader({
      path: `${SERVER_ARCHIVE_FILES_DIR_NAME}/${file.entry.path}`,
      size: file.entry.size,
      mode: file.mode,
      mtime,
    });

    if (file.contents !== null) {
      yield file.contents;
      yield tarPadding(file.entry.size);
      continue;
    }

    const handle = await openSourceFile(file.sourcePath);

    try {
      const hash = createHash("sha256");
      let size = 0;

      for await (const chunk of readFileChunks(handle, file.entry.size)) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }

      if (
        size !== file.entry.size ||
        hash.digest("hex") !== file.entry.sha256
      ) {
        throw new ServerArchiveError(
          "digest_mismatch",
          `${file.sourcePath} changed while the archive was being written`,
        );
      }
    } finally {
      await handle.close();
    }

    yield tarPadding(file.entry.size);
  }

  yield TAR_END_OF_ARCHIVE;
}

function assertArchivePaths(files: readonly ServerArchiveSourceFile[]): void {
  for (const file of files) {
    if (!isServerOwnedPath(file.archivePath)) {
      throw new ServerArchiveError(
        "unsafe_entry",
        `Archive path ${JSON.stringify(file.archivePath)} is not a server-owned path`,
      );
    }
  }

  const conflict = findRelativePathConflict(
    files.map((file) => file.archivePath),
  );

  if (conflict !== null) {
    throw new ServerArchiveError(
      "unsafe_entry",
      `Archive path ${conflict} conflicts with another entry`,
    );
  }
}

export async function planServerArchive(
  args: PlanServerArchiveArgs,
): Promise<ServerArchivePlan> {
  args.signal?.throwIfAborted();
  assertArchivePaths(args.files);
  const plannedFiles: PlannedArchiveFile[] = [];

  for (const file of args.files) {
    args.signal?.throwIfAborted();
    plannedFiles.push(await planArchiveFile(file, args.signal));
  }

  const manifest = serverArchiveManifestSchema.parse({
    ...args.manifest,
    format: SERVER_ARCHIVE_FORMAT,
    version: SERVER_ARCHIVE_VERSION,
    entries: plannedFiles.map((file) => file.entry),
  });

  return { manifest, files: plannedFiles };
}

export async function pipeServerArchive(
  args: PipeServerArchiveArgs,
): Promise<ServerArchiveDigest> {
  const archiveHash = createHash("sha256");
  let sizeBytes = 0;
  await pipeline(
    Readable.from(generateTarChunks(args.plan.manifest, args.plan.files)),
    createGzip(),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        archiveHash.update(chunk);
        sizeBytes += chunk.length;
        yield chunk;
      }
    },
    args.output,
    args.signal === null ? {} : { signal: args.signal },
  );

  return { sha256: archiveHash.digest("hex"), sizeBytes };
}

export async function streamServerArchive(
  args: StreamServerArchiveArgs,
): Promise<WriteServerArchiveResult> {
  const plan = await planServerArchive({
    files: args.files,
    manifest: args.manifest,
    signal: args.signal,
  });

  const digest = await pipeServerArchive({
    plan,
    output: args.output,
    signal: args.signal,
  });

  return { ...digest, manifest: plan.manifest };
}

export async function writeServerArchive(
  args: WriteServerArchiveArgs,
): Promise<WriteServerArchiveResult> {
  const plan = await planServerArchive({
    files: args.files,
    manifest: args.manifest,
    signal: null,
  });

  await mkdir(dirname(args.outPath), { recursive: true });

  const tempPath = join(
    dirname(args.outPath),
    `.${basename(args.outPath)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    const digest = await pipeServerArchive({
      plan,
      output: createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
      signal: null,
    });

    await rename(tempPath, args.outPath);

    return { ...digest, manifest: plan.manifest };
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
