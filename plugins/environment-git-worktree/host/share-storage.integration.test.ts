import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { reclaimWorktreeStorage, shareFreshWorktree } from "./share-storage.js";

const exec = promisify(execFile);

it.runIf(process.platform === "darwin" && Number.parseInt(release(), 10) >= 24)(
  "shares fresh tracked files and reclaims selected idle worktrees without touching user changes",
  async (context) => {
    const dir = await realpath(
      await mkdtemp(path.join(tmpdir(), "omnyo-worktree-sharing-")),
    );

    const source = path.join(dir, "source");
    const dataDir = path.join(dir, "data");
    const first = path.join(dir, "first");
    const second = path.join(dir, "second");
    const payload = randomBytes(256 * 1024);
    const git = (...args: string[]) => exec("git", ["-C", source, ...args]);

    try {
      await exec("git", ["init", "-q", "-b", "main", source]);
      await writeFile(path.join(source, "data.bin"), payload);
      await writeFile(
        path.join(source, ".gitignore"),
        "build/\nlocal.config\n",
      );
      await git("add", ".");
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      await git("worktree", "add", "-qb", "one", first);
      await git("worktree", "add", "-qb", "two", second);

      const fresh = await shareFreshWorktree({
        sourcePath: source,
        targetPath: first,
        dataDir,
      });

      if (fresh.status === "unsupported") context.skip();
      expect(fresh.status).toBe("completed");
      expect(fresh.privateBytesReleased).toBeGreaterThanOrEqual(payload.length);
      expect((await stat(path.join(first, "data.bin"))).ino).not.toBe(
        (await stat(path.join(source, "data.bin"))).ino,
      );
      const ignored = randomBytes(64 * 1024);

      for (const target of [first, second]) {
        await mkdir(path.join(target, "build"));
        await writeFile(path.join(target, "build", "output.cache"), ignored);
        await writeFile(path.join(target, "local.config"), ignored);
      }

      const configInode = (await stat(path.join(second, "local.config"))).ino;
      await writeFile(path.join(second, "notes"), ignored);
      const notesInode = (await stat(path.join(second, "notes"))).ino;

      const worktrees = [first, second].map((target) => ({
        sourcePath: source,
        path: target,
      }));

      const reclaimed = await reclaimWorktreeStorage({ worktrees, dataDir });
      expect(reclaimed.skippedWorktrees).toEqual([]);
      expect(Number.isSafeInteger(reclaimed.volumeFreeBytesChange)).toBe(true);
      expect(reclaimed.privateBytesReleased).toBeGreaterThanOrEqual(
        payload.length + ignored.length,
      );
      expect(
        (await reclaimWorktreeStorage({ worktrees, dataDir }))
          .privateBytesReleased,
      ).toBe(0);
      expect((await stat(path.join(second, "notes"))).ino).toBe(notesInode);
      expect((await stat(path.join(second, "local.config"))).ino).toBe(
        configInode,
      );
      const originalInode = (await stat(path.join(first, "data.bin"))).ino;
      await writeFile(
        path.join(first, "data.bin"),
        Buffer.from("work in progress"),
      );
      expect(await readFile(path.join(source, "data.bin"))).toEqual(payload);
      expect(await readFile(path.join(second, "data.bin"))).toEqual(payload);
      await reclaimWorktreeStorage({ worktrees, dataDir });
      expect((await stat(path.join(first, "data.bin"))).ino).toBe(
        originalInode,
      );
      expect(await readFile(path.join(first, "data.bin"), "utf8")).toBe(
        "work in progress",
      );

      const main = await reclaimWorktreeStorage({
        worktrees: [{ sourcePath: source, path: source }],
        dataDir,
      });

      expect(main.sharedFiles).toBe(0);
      expect(main.skippedWorktrees).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
