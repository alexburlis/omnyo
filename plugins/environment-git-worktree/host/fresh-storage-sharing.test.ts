import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktree } from "./worktree.js";

const exec = promisify(execFile);

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnyo-sharing-hook-"));
  roots.push(root);
  const sourcePath = join(root, "source");
  const ownWorktreesRoot = join(root, "worktrees");
  await Promise.all([mkdir(sourcePath), mkdir(ownWorktreesRoot)]);
  const git = (...args: string[]) => exec("git", args, { cwd: sourcePath });
  await git("init", "--initial-branch=main");
  await writeFile(join(sourcePath, "tracked.txt"), "tracked\n");
  await writeFile(join(sourcePath, ".worktreeinclude"), "local.txt\n");
  await writeFile(join(sourcePath, ".gitignore"), "local.txt\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Omnyo Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "initial",
  );
  await writeFile(join(sourcePath, "local.txt"), "included\n");
  const targetPath = join(ownWorktreesRoot, "target");

  return {
    sourcePath,
    targetPath,
    ownWorktreesRoot,
    completionPath: `${targetPath}.completed`,
    branchName: "feature",
    baseBranch: null,
    branchMode: "reset" as const,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("fresh worktree storage sharing boundary", () => {
  it("shares once after checkout and before includes and completion", async () => {
    const args = await fixture();

    const shareStorage = vi.fn(async () => {
      expect(await readFile(join(args.targetPath, "tracked.txt"), "utf8")).toBe(
        "tracked\n",
      );
      expect(existsSync(join(args.targetPath, "local.txt"))).toBe(false);
      expect(existsSync(args.completionPath)).toBe(false);
    });

    await createWorktree({ ...args, shareStorage });
    expect(shareStorage).toHaveBeenCalledTimes(1);
    expect(await readFile(join(args.targetPath, "local.txt"), "utf8")).toBe(
      "included\n",
    );
    await createWorktree({ ...args, shareStorage });
    expect(shareStorage).toHaveBeenCalledTimes(1);
    await rm(args.completionPath);
    await createWorktree({ ...args, shareStorage });
    expect(shareStorage).toHaveBeenCalledTimes(1);
  });

  it("preserves the checkout and reports an optional sharing failure", async () => {
    const args = await fixture();
    const events: string[] = [];
    await expect(
      createWorktree({
        ...args,
        shareStorage: async () => {
          throw new Error("sharing unavailable");
        },
        onProgress: (event) => events.push(event.text),
      }),
    ).resolves.toEqual({ path: args.targetPath });
    expect(existsSync(args.completionPath)).toBe(true);
    expect(await readFile(join(args.targetPath, "tracked.txt"), "utf8")).toBe(
      "tracked\n",
    );
    expect(events).toContain("Storage sharing failed: sharing unavailable");
  });
});
