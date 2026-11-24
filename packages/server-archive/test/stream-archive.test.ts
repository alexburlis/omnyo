import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractServerArchive,
  ServerArchiveError,
  type ServerArchiveManifestInput,
  type ServerArchiveSourceFile,
  streamServerArchive,
  writeServerArchive,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "omnyo-stream-archive-"),
  );

  tempDirs.push(tempDir);

  return tempDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { force: true, recursive: true })),
  );
});

const MANIFEST_INPUT: ServerArchiveManifestInput = {
  createdAt: Date.UTC(2026, 9, 15, 9, 30, 0),
  appVersion: "0.46.3",
  protocolVersion: 236,
  migrationCount: 180,
  sourceDataDir: "/root/.omnyo",
  sourceServerHostId: "host-vps",
  serverMoveExperiment: true,
};

const LARGE_DATABASE_BYTES = 16 * 1024 * 1024;

interface SourceFixture {
  root: string;
  files: ServerArchiveSourceFile[];
  lastSourcePath: string;
}

async function createSourceFixture(): Promise<SourceFixture> {
  const root = await makeTempDir();

  const sources: Array<{ archivePath: string; body: Buffer }> = [
    { archivePath: "app.db", body: randomBytes(LARGE_DATABASE_BYTES) },
    {
      archivePath: "config.json",
      body: Buffer.from(JSON.stringify({ config: {} })),
    },
    { archivePath: "plugins/tasks/data.db", body: randomBytes(64 * 1024) },
    {
      archivePath: "attachments/thr_1/screenshot.png",
      body: randomBytes(256 * 1024),
    },
  ];

  const files: ServerArchiveSourceFile[] = [];

  for (const [index, source] of sources.entries()) {
    const sourcePath = path.join(root, "source", `${String(index)}.bin`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, source.body);
    files.push({ sourcePath, archivePath: source.archivePath });
  }

  const lastSourcePath = files.at(-1)?.sourcePath ?? "";

  return { root, files, lastSourcePath };
}

class CollectingWritable extends Writable {
  readonly chunks: Buffer[] = [];

  constructor(private readonly onWrite: (count: number) => void = () => {}) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk);
    this.onWrite(this.chunks.length);
    callback();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("streamServerArchive", () => {
  it("streams the same bytes and manifest to a non-file writable as writeServerArchive writes to a file", async () => {
    const fixture = await createSourceFixture();
    const outPath = path.join(fixture.root, "out", "server.tar.gz");

    const written = await writeServerArchive({
      outPath,
      files: fixture.files,
      manifest: MANIFEST_INPUT,
    });

    const output = new CollectingWritable();

    const streamed = await streamServerArchive({
      files: fixture.files,
      manifest: MANIFEST_INPUT,
      output,
      signal: new AbortController().signal,
    });

    const streamedBytes = output.bytes();
    expect(output.writableFinished).toBe(true);
    expect(streamedBytes.equals(await readFile(outPath))).toBe(true);
    expect(streamed).toEqual(written);
    expect(streamed.sha256).toBe(sha256(streamedBytes));
    expect(streamed.sizeBytes).toBe(streamedBytes.length);
    const streamedPath = path.join(fixture.root, "streamed.tar.gz");
    await writeFile(streamedPath, streamedBytes);
    expect(
      await extractServerArchive({
        archivePath: streamedPath,
        destinationDir: path.join(fixture.root, "staging"),
      }),
    ).toEqual(written.manifest);
  });

  it("fails with digest_mismatch when a source file changes after planning, mid-stream", async () => {
    const fixture = await createSourceFixture();

    const replacement = randomBytes(
      (await readFile(fixture.lastSourcePath)).length,
    );

    let releaseFirstWrite: () => void = () => {};

    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    let writes = 0;

    const output = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        writes += 1;

        if (writes > 1) {
          callback();

          return;
        }

        void writeFile(fixture.lastSourcePath, replacement).then(() => {
          releaseFirstWrite();
        });
        void firstWriteReleased.then(() => {
          callback();
        });
      },
    });

    const error = await streamServerArchive({
      files: fixture.files,
      manifest: MANIFEST_INPUT,
      output,
      signal: new AbortController().signal,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ServerArchiveError);
    expect(error).toMatchObject({ code: "digest_mismatch" });
  });

  it("rejects with an AbortError and stops writing when the signal aborts mid-stream", async () => {
    const fixture = await createSourceFixture();
    const controller = new AbortController();

    const output = new CollectingWritable((count) => {
      if (count === 1) {
        controller.abort(new Error("consumer went away"));
      }
    });

    const error = await streamServerArchive({
      files: fixture.files,
      manifest: MANIFEST_INPUT,
      output,
      signal: controller.signal,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ name: "AbortError" });
    const writesAfterAbort = output.chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output.chunks.length).toBe(writesAfterAbort);
    expect(output.destroyed).toBe(true);
    expect(output.bytes().length).toBeLessThan(LARGE_DATABASE_BYTES);
  });

  it("rejects when the consumer fails mid-stream, as when a pipe reader exits", async () => {
    const fixture = await createSourceFixture();

    const output = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });

    await expect(
      streamServerArchive({
        files: fixture.files,
        manifest: MANIFEST_INPUT,
        output,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "EPIPE" });
  });

  it("leaves the output untouched when planning fails, so the caller can still report the error", async () => {
    const fixture = await createSourceFixture();
    await rm(fixture.lastSourcePath);
    const output = new CollectingWritable();

    await expect(
      streamServerArchive({
        files: fixture.files,
        manifest: MANIFEST_INPUT,
        output,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.chunks).toEqual([]);
    expect(output.destroyed).toBe(false);
    expect(output.writableEnded).toBe(false);
  });

  it("does not read any source when the signal is already aborted", async () => {
    const fixture = await createSourceFixture();
    await rm(fixture.lastSourcePath);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before start"));
    const output = new CollectingWritable();

    await expect(
      streamServerArchive({
        files: fixture.files,
        manifest: MANIFEST_INPUT,
        output,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before start");
    expect(output.chunks).toEqual([]);
  });
});
