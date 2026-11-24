import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishFileWithoutReplacing, replaceFile } from "../src/index.js";

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

function linkUnsupported(): NodeJS.ErrnoException {
  return Object.assign(new Error("operation not permitted"), {
    code: "EPERM",
  });
}

describe("replaceFile", () => {
  it("leaves the original file intact when a write fails midway", async () => {
    const dir = await makeTempDir("omnyo-replace-file-");
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
        replaceFile({ contents: Buffer.from("replacement"), path: target }),
      ).rejects.toBe(diskFull);
    } finally {
      writeFileSpy.mockRestore();
      handleWriteSpy.mockRestore();
    }

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    await expect(fs.readdir(dir)).resolves.toEqual(["note.md"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "overwrites in place without a precondition when the parent directory is not writable",
    async () => {
      const dir = await makeTempDir("omnyo-replace-file-");
      const lockedDir = path.join(dir, "locked");
      await fs.mkdir(lockedDir);
      const target = path.join(lockedDir, "note.md");
      await fs.writeFile(target, "original");
      await fs.chmod(lockedDir, 0o555);

      try {
        await expect(
          replaceFile({ contents: Buffer.from("replacement"), path: target }),
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

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a revision-checked save rather than overwrite in place in a read-only directory",
    async () => {
      const dir = await makeTempDir("omnyo-replace-file-");
      const lockedDir = path.join(dir, "locked");
      await fs.mkdir(lockedDir);
      const target = path.join(lockedDir, "note.md");
      await fs.writeFile(target, "original");
      await fs.chmod(lockedDir, 0o555);

      try {
        await expect(
          replaceFile({
            contents: Buffer.from("replacement"),
            expectedSha256: sha256("original"),
            path: target,
          }),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await fs.chmod(lockedDir, 0o755);
      }

      await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    },
  );

  it.skipIf(process.platform === "win32")(
    "applies the process umask to a requested mode on new files",
    async () => {
      const dir = await makeTempDir("omnyo-replace-file-");
      const target = path.join(dir, "shared.txt");
      const umask = process.umask();

      await replaceFile({
        contents: Buffer.from("hello"),
        mode: 0o666,
        path: target,
      });

      expect((await fs.stat(target)).mode & 0o777).toBe(0o666 & ~umask);
    },
  );

  it("saves files whose names are close to the filesystem limit", async () => {
    const dir = await makeTempDir("omnyo-replace-file-");
    const target = path.join(dir, `${"n".repeat(240)}.md`);
    await fs.writeFile(target, "original");

    await expect(
      replaceFile({ contents: Buffer.from("replacement"), path: target }),
    ).resolves.toMatchObject({ outcome: "written" });
    await expect(fs.readdir(dir)).resolves.toEqual([path.basename(target)]);
  });

  it("copies a create-only write into place when the filesystem refuses hard links", async () => {
    const dir = await makeTempDir("omnyo-replace-file-");
    const target = path.join(dir, "note.md");

    const linkSpy = vi.spyOn(fs, "link").mockRejectedValue(linkUnsupported());

    try {
      await expect(
        replaceFile({
          contents: Buffer.from("created"),
          expectedSha256: null,
          path: target,
        }),
      ).resolves.toEqual({
        outcome: "written",
        sha256: sha256("created"),
        sizeBytes: 7,
      });
      expect(linkSpy).toHaveBeenCalledTimes(1);

      await expect(
        replaceFile({
          contents: Buffer.from("other"),
          expectedSha256: null,
          path: target,
        }),
      ).resolves.toEqual({
        outcome: "conflict",
        currentSha256: sha256("created"),
      });
    } finally {
      linkSpy.mockRestore();
    }

    await expect(fs.readFile(target, "utf8")).resolves.toBe("created");
    await expect(fs.readdir(dir)).resolves.toEqual(["note.md"]);
  });
});

describe("publishFileWithoutReplacing", () => {
  it("does not replace an existing destination when it falls back to copying", async () => {
    const dir = await makeTempDir("omnyo-publish-file-");
    const source = path.join(dir, "source.md");
    const destination = path.join(dir, "destination.md");
    await fs.writeFile(source, "incoming");
    await fs.writeFile(destination, "existing");

    const linkSpy = vi.spyOn(fs, "link").mockRejectedValue(linkUnsupported());

    try {
      await expect(
        publishFileWithoutReplacing(source, destination),
      ).resolves.toBe(false);
      expect(linkSpy).toHaveBeenCalledTimes(1);
    } finally {
      linkSpy.mockRestore();
    }

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("existing");
  });

  it("rethrows link failures that are not about hard-link support", async () => {
    const dir = await makeTempDir("omnyo-publish-file-");
    const source = path.join(dir, "missing.md");
    const destination = path.join(dir, "destination.md");

    await expect(
      publishFileWithoutReplacing(source, destination),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });
});
