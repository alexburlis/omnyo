import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  deleteBranch,
  inspectCleanupRepo,
  inspectRepo,
  inspectSidebarRepo,
  isPathWithin,
  purgeWorktree,
} from "../git.js";
import { createWorktreeService } from "../host-service.js";
import storageHost from "../../host.js";

it("composes the Worktrees host into Storage without legacy removal RPCs", () => {
  expect(storageHost.contract).toHaveProperty("cleanSaved");
  expect(storageHost.contract).toHaveProperty("managedAllocate");
  expect(storageHost.contract).toHaveProperty("housekeepingHostState");
  expect(storageHost.contract).not.toHaveProperty("removeGitWorktrees");
  expect(storageHost.contract).not.toHaveProperty("inspectGitWorktree");
  expect(storageHost.contract).not.toHaveProperty("listGitWorktrees");
  expect(storageHost.experimental_signals).toHaveProperty("git-changed");
  expect(storageHost.experimental_signals).toHaveProperty("changed");
});

it("keeps native path ownership boundaries after normalization", () => {
  const root = join(tmpdir(), "project");
  expect(isPathWithin(root, root)).toBe(true);
  expect(isPathWithin(root, join(root, "nested", "..", "checkout"))).toBe(true);
  expect(isPathWithin(root, join(root, "..", "project-other"))).toBe(false);
  expect(isPathWithin(root, join(root, ".."))).toBe(false);
});

it("distinguishes inactive missing workspaces from missing sources and broken Git links", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "worktrees-discovery-")),
  );

  const umbrella = join(root, "project");
  const child = join(umbrella, "repo");
  const broken = join(umbrella, "broken");
  const missingSource = join(root, "missing-project");
  const inactive = join(root, "inactive");
  const protectedPath = join(root, "protected");
  const orphanScaffold = join(root, "scaffold-without-repositories");
  const hostId = "machine";
  const projectId = "project";

  try {
    await Promise.all([
      mkdir(join(umbrella, ".git", "worktrees"), { recursive: true }),
      mkdir(join(orphanScaffold, ".git"), { recursive: true }),
      mkdir(child, { recursive: true }),
      mkdir(broken, { recursive: true }),
    ]);
    await writeFile(join(broken, ".git"), "gitdir: ../missing-metadata\n");
    execFileSync("git", ["-C", child, "init", "-b", "main"], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-C",
        child,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { stdio: "ignore" },
    );

    const service = createWorktreeService(
      async () => ({
        hostId,
        projects: [
          {
            id: projectId,
            name: "Project",
            sources: [umbrella, missingSource, orphanScaffold].map((path) => ({
              hostId,
              path,
            })),
          },
        ],
        environments: [inactive, protectedPath, missingSource].map((path) => ({
          projectId,
          path,
          isGitRepo: true,
          status: "ready",
        })),
        chatTargets: [protectedPath],
      }),
      () => {},
    );

    const inventory = await service.inventory(null);
    expect(inventory.entries.map(({ path }) => path)).toEqual([child]);
    expect(inventory.missingInactiveEnvironments).toEqual([
      { projectId, path: inactive },
    ]);
    expect(inventory.issues).toHaveLength(4);

    for (const path of [missingSource, protectedPath, orphanScaffold, broken])
      expect(
        inventory.issues.some((issue) => issue.startsWith(`${path}: `)),
      ).toBe(true);
    expect(inventory.issues).toContain(
      `${broken}: Git metadata directory is missing at ${join(umbrella, "missing-metadata")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it("recognizes equivalent amended and rebased recovery changes without releasing the hold", async () => {
  const repo = await realpath(
    await mkdtemp(join(tmpdir(), "worktrees-rewrites-")),
  );

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const commit = async (file: string, contents: string) => {
    await writeFile(join(repo, file), contents);
    git("add", file);
    git("commit", "-m", file);
  };

  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("commit", "--allow-empty", "-m", "base");
    git("switch", "-c", "amended");
    await commit("notch", "notch content\n");
    git("commit", "--amend", "-m", "same tree");
    git("switch", "main");
    git("merge", "--ff-only", "amended");

    git("switch", "-c", "rebased");
    await commit("overlay", "overlay content\n");
    git("switch", "main");
    await commit("other-file", "unrelated change\n");
    git("rebase", "main", "rebased");
    git("switch", "main");
    git("merge", "--ff-only", "rebased");

    git("switch", "-c", "different");
    await commit("do-not-match", "preserve these spaces\n");
    await writeFile(join(repo, "do-not-match"), "preserve  these spaces\n");
    git("add", "do-not-match");
    git("commit", "--amend", "--no-edit");
    git("switch", "main");
    git("merge", "--ff-only", "different");

    const [inventory, cleanup] = await Promise.all([
      inspectRepo(repo, [], false),
      inspectCleanupRepo(repo, []),
    ]);

    for (const name of ["amended", "rebased", "different"]) {
      expect(inventory.branches.find((row) => row.name === name)).toMatchObject(
        {
          deleteReady: false,
          reasons: [
            name === "different"
              ? "Unique commits in branch history"
              : "Recovery changes match retained commits · Original commit IDs kept",
          ],
        },
      );
      expect(
        cleanup.branches.find((row) => row.name === name)?.deleteReady,
      ).toBe(false);
      expect(git("branch", "--list", name)).toBe(name);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 15_000);

it("compares against the primary checkout's upstream independently of cleanup", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "worktrees-base-")));

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    git("init", "-b", "production");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("commit", "--allow-empty", "-m", "production");
    git("remote", "add", "origin", ".");
    git("update-ref", "refs/remotes/origin/production", "production");
    git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/production",
    );

    git("switch", "-c", "integration");
    git("commit", "--allow-empty", "-m", "integrated change");
    git("branch", "finished");
    git("commit", "--allow-empty", "-m", "next integrated change");
    git("update-ref", "refs/remotes/origin/integration", "integration");
    git("branch", "--set-upstream-to=origin/integration", "integration");

    const [inventory, sidebar, cleanup] = await Promise.all([
      inspectRepo(repo, [], false, new Set(["finished"])),
      inspectSidebarRepo(repo),
      inspectCleanupRepo(repo, [], new Set(["finished"])),
    ]);

    const branch = inventory.branches.find((row) => row.name === "finished");
    expect(inventory.base).toBe("origin/integration");
    expect(inventory.baseRef).toBe("refs/remotes/origin/integration");
    expect(branch).toMatchObject({ ahead: 0, behind: 1, deleteReady: false });
    expect(branch?.reasons).toContain("Used by an open or protected chat");
    expect(
      inventory.branches.find((row) => row.name === "production")?.deleteReady,
    ).toBe(false);
    expect(sidebar.base).toBe(inventory.base);
    expect(sidebar.branches.find((row) => row.name === "finished")?.ahead).toBe(
      0,
    );
    expect(
      cleanup.branches.find((row) => row.name === "finished"),
    ).toMatchObject({
      deleteReady: branch?.deleteReady,
      deleteBase: branch?.deleteBase,
      reasons: branch?.reasons,
    });
    expect(git("branch", "--list", "finished")).toBe("finished");

    git("switch", "--detach", "integration");
    expect((await inspectRepo(repo, [], false)).base).toBe("origin/production");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 15_000);

it("rechecks ignored work and protected paths while preserving branch history", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "worktrees-guard-proof-")),
  );

  const repo = join(root, "repo");
  const lane = join(root, "lane");

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    await mkdir(repo);
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(repo, "tracked"), "retained source\n");
    await writeFile(join(repo, ".gitignore"), "ignored\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("worktree", "add", "-b", "lane", lane);
    const head = git("rev-parse", "HEAD");
    const initial = await inspectRepo(repo, []);
    const inspected = initial.worktrees.find((entry) => entry.path === lane);
    expect(inspected?.lastActivityAt).toEqual(expect.any(Number));
    expect(inspected?.unsavedCommitCount).toBe(0);
    expect(
      initial.worktrees.find((entry) => entry.path === lane)?.purgeReady,
    ).toBe(true);

    const protectedState = await inspectCleanupRepo(repo, [
      join(lane, "nested"),
    ]);

    expect(
      protectedState.worktrees.find((entry) => entry.path === lane)?.purgeReady,
    ).toBe(false);
    await writeFile(join(lane, "ignored"), "unique ignored work\n");
    await expect(purgeWorktree(repo, lane, head, [], "main")).rejects.toThrow();
    expect(await access(join(lane, "ignored"))).toBeUndefined();
    await rm(join(lane, "ignored"));
    const removed = await purgeWorktree(repo, lane, head, [], "main");
    expect(removed.removed).toBe(true);
    await expect(access(lane)).rejects.toThrow();
    expect(git("rev-parse", "lane")).toBe(head);
    await deleteBranch(repo, "lane", head, "main");
    expect(git("branch", "--list", "lane")).toBe("");
    expect(git("rev-parse", "main")).toBe(head);
  } finally {
    await rm(root, { recursive: true, force: true });
    await expect(access(root)).rejects.toThrow();
  }
});

it("blocks purge only while Git status hides changed work", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "worktrees-hidden-proof-")),
  );

  const repo = join(root, "repo");
  const library = join(root, "library");
  const lane = join(root, "lane");

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const laneReasons = async () =>
    (await inspectRepo(repo, [])).worktrees.find((entry) => entry.path === lane)
      ?.reasons;

  try {
    for (const path of [repo, library]) {
      await mkdir(path);
      git(path, "init", "-b", "main");
      git(path, "config", "user.name", "Fixture");
      git(path, "config", "user.email", "fixture@example.invalid");
      git(path, "config", "commit.gpgsign", "false");
      await writeFile(join(path, "tracked"), "retained source\n");
      git(path, "add", ".");
      git(path, "commit", "-m", "base");
    }

    git(
      repo,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      library,
      "lib",
    );
    git(repo, "commit", "-m", "add submodule");
    git(repo, "worktree", "add", "-b", "lane", lane);
    git(lane, "update-index", "--assume-unchanged", "tracked");
    expect(await laneReasons()).toEqual([]);

    await writeFile(join(lane, "tracked"), "hidden edit\n");
    await writeFile(join(lane, "lib", "notes"), "submodule folder work\n");
    expect(await laneReasons()).toEqual(
      expect.arrayContaining([
        "Index hides working files",
        "Uninitialized submodule holds files",
      ]),
    );
    await expect(
      purgeWorktree(repo, lane, git(lane, "rev-parse", "HEAD"), [], "main"),
    ).rejects.toThrow("Worktree changed or is protected");
    expect(await readFile(join(lane, "tracked"), "utf8")).toBe("hidden edit\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
