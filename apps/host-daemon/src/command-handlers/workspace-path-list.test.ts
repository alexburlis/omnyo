import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "@omnyo/host-workspace";
import { listWorkspacePaths } from "./file-list.js";
import { listHostFiles, listHostPaths } from "./host-files.js";

const roots: string[] = [];

async function createRoot() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "omnyo-workspace-paths-"),
  );

  roots.push(root);

  return root;
}

async function write(root: string, file: string, content = "fixture") {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

async function initRepo(root: string) {
  await runGit(["init", "-b", "main"], { cwd: root });
}

function listingArgs(root: string) {
  return {
    root,
    includeFiles: true,
    includeDirectories: true,
    includeHidden: true,
    respectGitIgnore: true,
    excludeNames: [],
    maxEntries: 1_000,
  };
}

async function paths(root: string) {
  return (await listWorkspacePaths(listingArgs(root))).paths
    .map((entry) => entry.path)
    .sort();
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("workspace path discovery", () => {
  it("includes tracked and non-ignored untracked files while pruning Git-ignored trees", async () => {
    const fileNameBreak = process.platform === "win32" ? " " : "\n";
    const root = await createRoot();
    await initRepo(root);
    await write(root, ".github/workflows/ci.yml");
    await write(root, ".generated/tracked.txt");
    await runGit(["add", "."], { cwd: root });
    await write(
      root,
      ".gitignore",
      ".generated/\ncustom-cache/\n.state/*\n!.state/keep.txt\n",
    );
    await write(root, ".git/info/exclude", "local-output/\n");
    await write(root, ".generated/deep/ignored.txt");
    await write(root, "custom-cache/arbitrary-tool/ignored.txt");
    await write(root, "local-output/ignored.txt");
    await write(root, ".state/drop.txt");
    await write(root, ".state/keep.txt");
    await write(root, `src/new${fileNameBreak}file.ts`);
    await write(root, `src/ignored${fileNameBreak}file.log`);
    await write(root, "src/.gitignore", "*.log\n");
    await fs.mkdir(path.join(root, "empty"));
    await fs.symlink(
      `src/new${fileNameBreak}file.ts`,
      path.join(root, "link.ts"),
    );

    expect(await paths(root)).toEqual([
      ".generated",
      ".generated/tracked.txt",
      ".github",
      ".github/workflows",
      ".github/workflows/ci.yml",
      ".gitignore",
      ".state",
      ".state/keep.txt",
      "empty",
      "src",
      "src/.gitignore",
      `src/new${fileNameBreak}file.ts`,
    ]);
  });

  it("resolves ignore rules relative to a subdirectory and a linked worktree", async () => {
    const root = await createRoot();
    await initRepo(root);
    await write(root, ".gitignore", "/.sandboxes/\n*.log\n");
    await write(root, "src/README.md");
    await runGit(["add", "."], { cwd: root });
    await runGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    const worktree = path.join(root, ".sandboxes", "worker");
    await runGit(["worktree", "add", "--detach", worktree], { cwd: root });
    await write(worktree, "src/trace.log");
    await write(worktree, "src/new.ts");

    expect(await paths(root)).not.toContain(".sandboxes");
    expect(await paths(path.join(worktree, "src"))).toEqual([
      "README.md",
      "new.ts",
    ]);
    expect(await paths(worktree)).toContain("src/new.ts");
  });

  it("preserves filesystem listings without Git and when ignore filtering is disabled", async () => {
    const root = await createRoot();
    await write(root, ".gitignore", "output/\n");
    await write(root, "output/result.txt");
    await write(root, ".claude/settings.json");
    await write(root, ".claude/worktrees/worker/README.md");
    await write(root, "src/worktrees/index.ts");
    const args = { ...listingArgs(root), excludeNames: [".claude/worktrees"] };
    expect(
      (await listWorkspacePaths(args)).paths.map((entry) => entry.path),
    ).toEqual([
      ".claude",
      ".claude/settings.json",
      ".gitignore",
      "output",
      "output/result.txt",
      "src",
      "src/worktrees",
      "src/worktrees/index.ts",
    ]);
    await initRepo(root);
    expect(await paths(root)).not.toContain("output/result.txt");
    expect(
      (
        await listWorkspacePaths({ ...args, respectGitIgnore: false })
      ).paths.map((entry) => entry.path),
    ).toContain("output/result.txt");
    expect(
      (await listWorkspacePaths({ ...args, includeHidden: false })).paths.map(
        (entry) => entry.path,
      ),
    ).toEqual(["src", "src/worktrees", "src/worktrees/index.ts"]);
  });

  it("reuses discovery for five seconds after it completes, then refreshes results and ignore rules", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });

    try {
      const root = await createRoot();
      await initRepo(root);
      await write(root, "first.txt");
      const args = listingArgs(root);
      const first = listWorkspacePaths(args);
      const second = listWorkspacePaths({ ...args, excludeNames: [] });
      expect(second).toBe(first);
      await first;
      await write(root, "second.txt");
      await write(root, ".gitignore", "first.txt\n");
      expect(await paths(root)).toEqual(["first.txt"]);

      vi.advanceTimersByTime(5_000);
      expect(await paths(root)).toEqual([".gitignore", "second.txt"]);

      const hidden = listWorkspacePaths(args);
      const visible = listWorkspacePaths({ ...args, includeHidden: false });
      expect((await hidden).paths.map((entry) => entry.path)).toContain(
        ".gitignore",
      );
      expect((await visible).paths.map((entry) => entry.path)).not.toContain(
        ".gitignore",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops walking at the entry limit and reports truncation", async () => {
    const root = await createRoot();

    for (const name of ["a", "b", "c"])
      for (const file of ["1.txt", "2.txt"])
        await write(root, `${name}/${file}`);

    const args = { ...listingArgs(root), includeDirectories: false };

    const capped = await listWorkspacePaths({ ...args, maxEntries: 4 });
    expect(capped.paths).toHaveLength(4);
    expect(capped.truncated).toBe(true);

    const exact = await listWorkspacePaths({ ...args, maxEntries: 6 });
    expect(exact.paths).toHaveLength(6);
    expect(exact.truncated).toBe(false);
  });

  it("does not retain failed discovery", async () => {
    const root = path.join(await createRoot(), "missing");
    await expect(listWorkspacePaths(listingArgs(root))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await write(root, "recovered.txt");
    expect(await paths(root)).toEqual(["recovered.txt"]);
  });

  it("ranks concurrent queries independently over the shared listing", async () => {
    const root = await createRoot();
    await initRepo(root);
    await write(root, "alpha.md");
    await write(root, "beta.md");

    const command = {
      type: "host.list_paths" as const,
      path: root,
      includeFiles: true,
      includeDirectories: false,
      includeHidden: true,
      respectGitIgnore: true,
      excludeNames: [],
      limit: 1,
    };

    const [alpha, beta] = await Promise.all([
      listHostPaths({ ...command, query: "alpha" }),
      listHostPaths({ ...command, query: "beta" }),
    ]);

    expect(alpha.paths.map((entry) => entry.path)).toEqual(["alpha.md"]);
    expect(beta.paths.map((entry) => entry.path)).toEqual(["beta.md"]);
  });

  it("keeps the event loop responsive while ranking a large workspace", async () => {
    const root = await createRoot();

    const directories = Array.from(
      { length: 60 },
      (_, index) => `src/components/feature-${index}`,
    );

    await Promise.all(
      directories.map((directory) =>
        fs.mkdir(path.join(root, directory), { recursive: true }),
      ),
    );

    for (let batch = 0; batch < 6_000; batch += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_, offset) => {
          const index = batch + offset;

          return fs.writeFile(
            path.join(
              root,
              directories[index % directories.length]!,
              `component-${index}-application-footer.tsx`,
            ),
            "",
          );
        }),
      );
    }

    let lastTick = performance.now();
    let longestGap = 0;

    const ticker = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - lastTick);
      lastTick = now;
    }, 5);

    const startedAt = performance.now();

    const result = await listHostFiles({
      type: "host.list_files",
      followRootSymlink: false,
      path: root,
      query: "src/comp",
      limit: 50,
      includeHidden: false,
      respectGitIgnore: false,
      excludeNames: [],
    }).finally(() => clearInterval(ticker));

    const finishedAt = performance.now();
    longestGap = Math.max(longestGap, finishedAt - lastTick);
    const elapsed = finishedAt - startedAt;

    expect(result.files).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(longestGap).toBeLessThan(elapsed / 4);
  });

  it("skips excluded names at any depth and never lists .git", async () => {
    const root = await createRoot();
    await write(root, ".git/HEAD");
    await write(root, "node_modules/pkg/index.js");
    await write(root, "apps/web/.turbo/log");
    await write(root, "apps/web/.DS_Store");
    await write(root, "apps/web/index.ts");

    const listPaths = async (excludeNames: string[]) =>
      (
        await listWorkspacePaths({
          ...listingArgs(root),
          respectGitIgnore: false,
          excludeNames,
        })
      ).paths
        .map((entry) => entry.path)
        .sort();

    expect(await listPaths(["node_modules", ".turbo", ".DS_Store"])).toEqual([
      "apps",
      "apps/web",
      "apps/web/index.ts",
    ]);
    expect(await listPaths([])).toEqual([
      "apps",
      "apps/web",
      "apps/web/.DS_Store",
      "apps/web/.turbo",
      "apps/web/.turbo/log",
      "apps/web/index.ts",
      "node_modules",
      "node_modules/pkg",
      "node_modules/pkg/index.js",
    ]);
  });
});
