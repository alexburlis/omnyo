import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandDispatchError,
  type CommandOf,
  isExpectedCommandDispatchError,
} from "../command-dispatch-support.js";
import { writeHostFile } from "./file-write.js";
import { readHostFile } from "./host-files.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeCommand(
  overrides: Partial<CommandOf<"host.write_file">> &
    Pick<CommandOf<"host.write_file">, "path">,
): CommandOf<"host.write_file"> {
  return {
    type: "host.write_file",
    content: "hello",
    contentEncoding: "utf8",
    createParents: false,
    ...overrides,
  };
}

async function captureWriteError(
  command: CommandOf<"host.write_file">,
): Promise<unknown> {
  try {
    await writeHostFile(command);
  } catch (error) {
    return error;
  }

  throw new Error("Expected writeHostFile to fail");
}

describe("writeHostFile", () => {
  it("writes a new file unconditionally and returns its hash", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");

    const result = await writeHostFile(
      writeCommand({ path: target, content: "# Hello" }),
    );

    expect(result).toEqual({
      outcome: "written",
      sha256: sha256("# Hello"),
      sizeBytes: 7,
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("# Hello");
  });

  it("overwrites an existing file when the expected hash matches", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");
    await fs.writeFile(target, "old");

    const result = await writeHostFile(
      writeCommand({
        path: target,
        content: "new",
        expectedSha256: sha256("old"),
      }),
    );

    expect(result).toEqual({
      outcome: "written",
      sha256: sha256("new"),
      sizeBytes: 3,
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("new");
  });

  it("allows only one concurrent write for the same expected hash", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");
    await fs.writeFile(target, "old");
    const expectedSha256 = sha256("old");

    const results = await Promise.all([
      writeHostFile(
        writeCommand({
          path: target,
          content: "first",
          expectedSha256,
        }),
      ),
      writeHostFile(
        writeCommand({
          path: target,
          content: "second",
          expectedSha256,
        }),
      ),
    ]);

    expect(
      results.filter((result) => result.outcome === "written"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "conflict"),
    ).toHaveLength(1);
    await expect(fs.readFile(target, "utf8")).resolves.toMatch(/first|second/);
  });

  it("returns a conflict with the current hash when the expected hash is stale", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");
    await fs.writeFile(target, "current");

    const result = await writeHostFile(
      writeCommand({
        path: target,
        content: "mine",
        expectedSha256: sha256("stale"),
      }),
    );

    expect(result).toEqual({
      outcome: "conflict",
      currentSha256: sha256("current"),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("current");
  });

  it("returns a null-hash conflict when the expected file is missing", async () => {
    const dir = await makeTempDir("omnyo-file-write-");

    const result = await writeHostFile(
      writeCommand({
        path: path.join(dir, "gone.md"),
        expectedSha256: sha256("anything"),
      }),
    );

    expect(result).toEqual({ outcome: "conflict", currentSha256: null });
  });

  it("treats expectedSha256 null as create-only", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");

    const created = await writeHostFile(
      writeCommand({ path: target, expectedSha256: null }),
    );

    expect(created).toMatchObject({ outcome: "written" });

    const conflicted = await writeHostFile(
      writeCommand({ path: target, expectedSha256: null }),
    );

    expect(conflicted).toEqual({
      outcome: "conflict",
      currentSha256: sha256("hello"),
    });
  });

  it("decodes base64 content", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "logo.bin");

    const result = await writeHostFile(
      writeCommand({
        path: target,
        content: Buffer.from([0, 1, 2, 255]).toString("base64"),
        contentEncoding: "base64",
      }),
    );

    expect(result).toMatchObject({ outcome: "written", sizeBytes: 4 });
    expect(Uint8Array.from(await fs.readFile(target))).toEqual(
      Uint8Array.from([0, 1, 2, 255]),
    );
  });

  it("fails with ENOENT when the parent is missing and createParents is false", async () => {
    const dir = await makeTempDir("omnyo-file-write-");

    const error = await captureWriteError(
      writeCommand({ path: path.join(dir, "nested", "note.md") }),
    );

    expect(isExpectedCommandDispatchError(error)).toBe(true);
    expect((error as CommandDispatchError).code).toBe("ENOENT");
  });

  it("creates missing parents when createParents is true", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "a", "b", "note.md");

    const result = await writeHostFile(
      writeCommand({ path: target, createParents: true }),
    );

    expect(result).toMatchObject({ outcome: "written" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("hello");
  });

  it("rejects writes that escape the declared root via symlinks", async () => {
    const rootDir = await makeTempDir("omnyo-file-write-root-");
    const outsideDir = await makeTempDir("omnyo-file-write-outside-");
    await fs.symlink(outsideDir, path.join(rootDir, "link"), "dir");

    const error = await captureWriteError(
      writeCommand({
        path: path.join(rootDir, "link", "escape.md"),
        rootPath: rootDir,
      }),
    );

    expect(error).toBeInstanceOf(CommandDispatchError);
    expect((error as CommandDispatchError).code).toBe("invalid_path");
    await expect(
      fs.readFile(path.join(outsideDir, "escape.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a declared root that is itself a symlink",
    async () => {
      const rootDir = await makeTempDir("omnyo-file-write-root-");
      const aliasParent = await makeTempDir("omnyo-file-write-alias-");
      const aliasDir = path.join(aliasParent, "alias");
      await fs.symlink(rootDir, aliasDir, "dir");

      const error = await captureWriteError(
        writeCommand({
          path: path.join(aliasDir, "note.md"),
          rootPath: aliasDir,
        }),
      );

      expect(error).toBeInstanceOf(CommandDispatchError);
      expect(error).toMatchObject({
        code: "invalid_path",
        message: expect.stringContaining("must not be a symlink"),
      });
      await expect(
        fs.readFile(path.join(rootDir, "note.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects lexical escapes from the declared root", async () => {
    const rootDir = await makeTempDir("omnyo-file-write-root-");
    const outsideDir = await makeTempDir("omnyo-file-write-outside-");

    const error = await captureWriteError(
      writeCommand({
        path: path.join(outsideDir, "escape.md"),
        rootPath: rootDir,
      }),
    );

    expect(error).toBeInstanceOf(CommandDispatchError);
    expect((error as CommandDispatchError).code).toBe("invalid_path");
  });

  it("allows contained writes under the declared root", async () => {
    const rootDir = await makeTempDir("omnyo-file-write-root-");

    const result = await writeHostFile(
      writeCommand({
        path: path.join(rootDir, "notes", "note.md"),
        rootPath: rootDir,
        createParents: true,
      }),
    );

    expect(result).toMatchObject({ outcome: "written" });
  });

  it.skipIf(process.platform === "win32")(
    "uses mode for creation without chmodding an existing file",
    async () => {
      const dir = await makeTempDir("omnyo-file-write-mode-");
      const created = path.join(dir, "created.env");
      await writeHostFile(writeCommand({ path: created, mode: 0o600 }));
      expect((await fs.stat(created)).mode & 0o777).toBe(0o600);

      const existing = path.join(dir, "existing.env");
      await fs.writeFile(existing, "old", { mode: 0o644 });
      await fs.chmod(existing, 0o644);
      await writeHostFile(writeCommand({ path: existing, mode: 0o600 }));
      expect((await fs.stat(existing)).mode & 0o777).toBe(0o644);
    },
  );

  it("rejects directory targets", async () => {
    const dir = await makeTempDir("omnyo-file-write-");

    const error = await captureWriteError(writeCommand({ path: dir }));

    expect(error).toBeInstanceOf(CommandDispatchError);
    expect((error as CommandDispatchError).code).toBe("invalid_path");
  });

  it("rejects relative paths", async () => {
    const error = await captureWriteError(
      writeCommand({ path: "relative/note.md" }),
    );

    expect(error).toBeInstanceOf(CommandDispatchError);
    expect((error as CommandDispatchError).code).toBe("invalid_path");
  });

  it("leaves the original file intact when an unconditional write fails midway", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");
    await fs.writeFile(target, "original");

    const diskFull = Object.assign(new Error("no space left on device"), {
      code: "ENOSPC",
    });

    const probe = await fs.open(target, "r");
    const fileHandlePrototype: FileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWriteFile = fs.writeFile;

    const originalHandleWrite: (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
    ) => Promise<unknown> = fileHandlePrototype.write;

    const writeFileSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (file, data) => {
        await originalWriteFile(file, String(data).slice(0, 3));
        throw diskFull;
      });

    const handleWriteSpy = vi
      .spyOn(fileHandlePrototype, "write")
      .mockImplementation(async function (this: FileHandle, data: unknown) {
        if (!(data instanceof Uint8Array))
          throw new TypeError("Expected bytes");
        await originalHandleWrite.call(this, data, 0, 3);
        throw diskFull;
      });

    try {
      await expect(
        writeHostFile(writeCommand({ path: target, content: "replacement" })),
      ).rejects.toBe(diskFull);
    } finally {
      writeFileSpy.mockRestore();
      handleWriteSpy.mockRestore();
    }

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    await expect(fs.readdir(dir)).resolves.toEqual(["note.md"]);
  });

  it("saves a hash-checked write to a file whose name is close to the filesystem limit", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, `${"n".repeat(240)}.md`);
    await fs.writeFile(target, "original");

    const result = await writeHostFile(
      writeCommand({
        path: target,
        content: "replacement",
        expectedSha256: sha256("original"),
      }),
    );

    expect(result).toEqual({
      outcome: "written",
      sha256: sha256("replacement"),
      sizeBytes: 11,
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.readdir(dir)).resolves.toEqual([path.basename(target)]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps an existing file's exact mode on a hash-checked save",
    async () => {
      const dir = await makeTempDir("omnyo-file-write-mode-");
      const target = path.join(dir, "shared.txt");
      await fs.writeFile(target, "original");
      await fs.chmod(target, 0o666);

      await writeHostFile(
        writeCommand({
          path: target,
          content: "replacement",
          expectedSha256: sha256("original"),
        }),
      );

      expect((await fs.stat(target)).mode & 0o777).toBe(0o666);
      await expect(fs.readdir(dir)).resolves.toEqual(["shared.txt"]);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "overwrites in place without a hash and refuses a hash-checked save when the folder accepts no new files",
    async () => {
      const dir = await makeTempDir("omnyo-file-write-");
      const lockedDir = path.join(dir, "locked");
      await fs.mkdir(lockedDir);
      const target = path.join(lockedDir, "note.md");
      await fs.writeFile(target, "original");
      await fs.chmod(lockedDir, 0o555);

      try {
        await expect(
          writeHostFile(
            writeCommand({
              path: target,
              content: "unchecked",
              expectedSha256: sha256("original"),
            }),
          ),
        ).rejects.toMatchObject({ code: "EACCES" });
        await expect(fs.readFile(target, "utf8")).resolves.toBe("original");

        await expect(
          writeHostFile(writeCommand({ path: target, content: "replacement" })),
        ).resolves.toEqual({
          outcome: "written",
          sha256: sha256("replacement"),
          sizeBytes: 11,
        });
      } finally {
        await fs.chmod(lockedDir, 0o755);
      }

      await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
      await expect(fs.readdir(lockedDir)).resolves.toEqual(["note.md"]);
    },
  );

  it("returns a conflict without creating parents for a hash-checked write under a missing folder", async () => {
    const dir = await makeTempDir("omnyo-file-write-");

    const result = await writeHostFile(
      writeCommand({
        path: path.join(dir, "a", "b", "note.md"),
        createParents: true,
        expectedSha256: sha256("anything"),
      }),
    );

    expect(result).toEqual({ outcome: "conflict", currentSha256: null });
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("leaves no temporary files after create-only writes and conflicts", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");

    await expect(
      writeHostFile(writeCommand({ path: target, expectedSha256: null })),
    ).resolves.toMatchObject({ outcome: "written" });
    await expect(
      writeHostFile(
        writeCommand({ path: target, content: "other", expectedSha256: null }),
      ),
    ).resolves.toEqual({ outcome: "conflict", currentSha256: sha256("hello") });
    await expect(
      writeHostFile(writeCommand({ path: target, content: "unchecked" })),
    ).resolves.toMatchObject({ outcome: "written" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("unchecked");
    await expect(fs.readdir(dir)).resolves.toEqual(["note.md"]);
  });

  it("round-trips with readHostFile for compare-and-swap saves", async () => {
    const dir = await makeTempDir("omnyo-file-write-");
    const target = path.join(dir, "note.md");
    await fs.writeFile(target, "v1");

    const read = await readHostFile({ type: "host.read_file", path: target });

    const result = await writeHostFile(
      writeCommand({
        path: target,
        content: "v2",
        expectedSha256: read.sha256,
      }),
    );

    expect(result).toMatchObject({ outcome: "written" });
    const reread = await readHostFile({ type: "host.read_file", path: target });
    expect(reread.content).toBe("v2");
    expect(reread.sha256).toBe(sha256("v2"));
  });
});
