import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeHostEntry } from "./host.js";
import { removeWorktree } from "./host/worktree.js";

const execFileAsync = promisify(execFile);

const temporaryRoots: string[] = [];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "omnyo",
      GIT_AUTHOR_EMAIL: "omnyo@example.com",
      GIT_COMMITTER_NAME: "omnyo",
      GIT_COMMITTER_EMAIL: "omnyo@example.com",
    },
  });

  return result.stdout;
}

async function createSourceRepository(repositoryName = "repo"): Promise<{
  root: string;
  sourcePath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "omnyo-worktree-plugin-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, repositoryName);
  const dataDir = join(root, "plugin-data");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");

  return { root, sourcePath, dataDir };
}

async function createDetachedSingleBranchRepository(): Promise<{
  root: string;
  sourcePath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "omnyo-worktree-plugin-detached-"));
  temporaryRoots.push(root);
  const originPath = join(root, "origin");
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await mkdir(originPath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await git(originPath, "init", "--initial-branch=main");
  await writeFile(join(originPath, "README.md"), "hello\n");
  await git(originPath, "add", ".");
  await git(originPath, "commit", "-m", "initial");
  await git(originPath, "tag", "v1.0");
  await git(
    root,
    "clone",
    "--single-branch",
    "--branch",
    "v1.0",
    originPath,
    sourcePath,
  );

  return { root, sourcePath, dataDir };
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(createWorktreeHostEntry(), {
    experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
  });
}

function createInput(args: {
  operationId: string;
  sourcePath: string;
  pathKey: string;
  branchName: string;
}) {
  return {
    ...args,
    baseBranch: { kind: "default" as const },
    branchMode: "reset" as const,
  };
}

function progressText(harness: ReturnType<typeof createHarness>): string {
  return harness
    .experimental_getSignals()
    .map((event) => event.payload.text)
    .join("\n");
}

async function addLibrarySubmodule(
  root: string,
  sourcePath: string,
): Promise<void> {
  const library = join(root, "library");
  await mkdir(library);
  await git(library, "init", "--initial-branch=main");
  await writeFile(join(library, "lib.txt"), "library\n");
  await git(library, "add", ".");
  await git(library, "commit", "-m", "library");
  await git(
    sourcePath,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    library,
    "lib",
  );
  await git(sourcePath, "commit", "-m", "add submodule");
}

async function inHiddenIndexWorktree(
  prepareSource: (paths: { root: string; sourcePath: string }) => Promise<void>,
  check: (worktree: string, remove: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const { root, sourcePath, dataDir } = await createSourceRepository();
  await prepareSource({ root, sourcePath });
  const harness = createHarness(dataDir);
  let removals = 0;

  try {
    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create-hidden-index",
        sourcePath,
        pathKey: "hidden-index",
        branchName: "omnyo/hidden-index",
      }),
    );

    if (created.status !== "created") throw new Error(created.message);

    await check(created.path, () =>
      harness.experimental_call("remove", {
        operationId: `remove-hidden-index-${(removals += 1)}`,
        pathKey: "hidden-index",
        path: created.path,
      }),
    );
    expect(existsSync(created.path)).toBe(false);
  } finally {
    await harness.experimental_dispose();
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worktree host entry", () => {
  it("removes one reviewed folder with missing Git registration and preserves all refs", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(await realpath(dataDir));
    const pathKey = "broken";

    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "broken-create",
        sourcePath,
        pathKey,
        branchName: "omnyo/broken",
      }),
    );

    if (created.status !== "created") throw new Error(created.message);

    const path = created.path;
    const pointer = await readFile(join(path, ".git"), "utf8");
    await rm(resolve(path, pointer.replace(/^gitdir: /u, "").trim()), {
      recursive: true,
    });
    const ref = "refs/heads/main";
    const inspect = { sourcePath, path, pathKey, ref };
    const refs = await git(sourcePath, "show-ref");

    try {
      const proof = await harness.experimental_call(
        "inspectMissingRegistration",
        inspect,
      );

      expect(proof).toMatchObject({
        head: (await git(sourcePath, "rev-parse", "main")).trim(),
        fileCount: 1,
        bytes: 6,
      });

      const remove = {
        operationId: "broken-remove",
        pathKey,
        path,
        recovery: {
          sourcePath,
          ref,
          proof: {
            head: proof.head,
            identity: proof.identity,
            registration: proof.registration,
          },
        },
      };

      await writeFile(join(path, "local.tmp"), "unique data\n");
      expect(await harness.experimental_call("remove", remove)).toMatchObject({
        status: "failed",
        message: expect.stringContaining("Extra worktree entry"),
      });
      expect(await readFile(join(path, "local.tmp"), "utf8")).toBe(
        "unique data\n",
      );
      await rm(join(path, "local.tmp"));

      expect(await harness.experimental_call("remove", remove)).toEqual({
        status: "removed",
      });
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.completed`)).toBe(false);
      expect(await git(sourcePath, "show-ref")).toBe(refs);
    } finally {
      await harness.experimental_dispose();
    }
  }, 120_000);

  it("automatic worktree cleanup preserves a real consumer without stopping it", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);

    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "consumer-create",
        sourcePath,
        pathKey: "consumer",
        branchName: "omnyo/consumer",
      }),
    );

    if (created.status !== "created") throw new Error(created.message);

    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { cwd: created.path, stdio: "ignore" },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      await expect(
        removeWorktree({ path: created.path, stopWorkspaceProcesses: false }),
      ).rejects.toThrow(/Cannot remove/u);
      expect(isPidAlive(child.pid ?? 0)).toBe(true);
      expect(existsSync(created.path)).toBe(true);
      expect(existsSync(`${created.path}.completed`)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      await harness.experimental_dispose();
    }
  });

  it.each([false, true])(
    "retires a fresh pnpm worktree only when there is no extra ignored artifact (artifact: %s)",
    async (hasArtifact) => {
      const { sourcePath, dataDir } = await createSourceRepository();
      const setupScript = new URL("../../.omnyo-env-setup.sh", import.meta.url);

      const { packageManager } = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
      );

      await mkdir(join(sourcePath, "dependency"));
      await Promise.all([
        writeFile(join(sourcePath, ".gitignore"), "node_modules/\n*.tgz\n"),
        writeFile(
          join(sourcePath, "pnpm-lock.yaml"),
          [
            "lockfileVersion: '9.0'",
            "settings:",
            "  autoInstallPeers: true",
            "  excludeLinksFromLockfile: false",
            "importers:",
            "  .:",
            "    dependencies:",
            "      worktree-fixture-dependency:",
            "        specifier: link:./dependency",
            "        version: link:dependency",
            "",
          ].join("\n"),
        ),
        writeFile(
          join(sourcePath, "package.json"),
          JSON.stringify({
            name: "worktree-fixture",
            packageManager,
            dependencies: {
              "worktree-fixture-dependency": "link:./dependency",
            },
          }),
        ),
        writeFile(
          join(sourcePath, "dependency/package.json"),
          JSON.stringify({
            name: "worktree-fixture-dependency",
            version: "1.0.0",
          }),
        ),
      ]);
      await git(sourcePath, "add", ".");
      await git(sourcePath, "commit", "-m", "add offline pnpm fixture");
      const worktree = join(dataDir, "worktrees", "pnpm", "repo");
      await mkdir(join(dataDir, "worktrees", "pnpm"), { recursive: true });
      const branchName = "omnyo/pnpm-fixture";
      await git(sourcePath, "worktree", "add", "-b", branchName, worktree);
      const worktreePath = await realpath(worktree);
      const harness = createHarness(dataDir);

      try {
        const head = await git(worktreePath, "rev-parse", "HEAD");

        const dependencyPath = join(
          worktreePath,
          "node_modules/worktree-fixture-dependency/package.json",
        );

        await execFileAsync(
          "bash",
          [
            fileURLToPath(
              new URL("../../.omnyo-env-setup.sh", import.meta.url),
            ),
          ],
          {
            cwd: worktreePath,
            env: {
              ...process.env,
              COREPACK_ENABLE_NETWORK: "0",
              npm_config_offline: "true",
            },
          },
        );
        expect(existsSync(dependencyPath)).toBe(true);

        const artifact = join(worktreePath, "node_modules", "keep.tgz");

        if (hasArtifact) await writeFile(artifact, "unique artifact\n");

        const removed = await harness.experimental_call("remove", {
          operationId: "remove-pnpm",
          pathKey: "pnpm",
          path: worktreePath,
        });

        expect(removed.status).toBe(hasArtifact ? "failed" : "removed");
        expect(existsSync(worktreePath)).toBe(hasArtifact);
        expect(
          (await git(sourcePath, "worktree", "list", "--porcelain")).includes(
            `worktree ${worktreePath}`,
          ),
        ).toBe(hasArtifact);
        expect(await git(sourcePath, "rev-parse", branchName)).toBe(head);

        if (hasArtifact) {
          expect(await readFile(artifact, "utf8")).toBe("unique artifact\n");
          expect(existsSync(dependencyPath)).toBe(true);
        }
      } finally {
        await harness.experimental_dispose();
      }
    },
  );

  it.each(["untracked", "ignored", "detached", "locked", "broken"])(
    "preserves worktree and completion marker when removal is unsafe: %s",
    async (state) => {
      const { sourcePath, dataDir } = await createSourceRepository();
      const harness = createHarness(dataDir);

      try {
        const created = await harness.experimental_call(
          "create",
          createInput({
            operationId: "create-preservation",
            sourcePath,
            pathKey: "preservation",
            branchName: "omnyo/preservation",
          }),
        );

        if (created.status !== "created") throw new Error(created.message);
        const marker = `${created.path}.completed`;
        const markerBytes = await readFile(marker, "utf8");

        if (state === "untracked") {
          await writeFile(join(created.path, "unique.txt"), "unique work\n");
        } else if (state === "ignored") {
          await writeFile(join(created.path, ".gitignore"), "unique.txt\n");
          await git(created.path, "add", ".gitignore");
          await git(created.path, "commit", "-m", "ignore fixture");
          await writeFile(join(created.path, "unique.txt"), "ignored work\n");
        } else if (state === "detached") {
          await git(created.path, "checkout", "--detach");
          await git(
            created.path,
            "commit",
            "--allow-empty",
            "-m",
            "unique tip",
          );
        } else if (state === "locked") {
          await git(sourcePath, "worktree", "lock", created.path);
        } else {
          await writeFile(join(created.path, ".git"), "gitdir: missing\n");
        }

        const result = await harness.experimental_call("remove", {
          operationId: "remove-preservation",
          pathKey: "preservation",
          path: created.path,
        });

        expect(result.status).toBe("failed");
        expect(existsSync(created.path)).toBe(true);
        expect(await readFile(marker, "utf8")).toBe(markerBytes);
      } finally {
        await harness.experimental_dispose();
      }
    },
  );

  it.each([
    "refs/worktree/saved",
    "refs/bisect/saved",
    "refs/rewritten/saved",
    "MERGE_HEAD",
    "MERGE_AUTOSTASH",
  ])("keeps clean worktrees with local Git state: %s", async (state) => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);

    try {
      const created = await harness.experimental_call(
        "create",
        createInput({
          operationId: "create-state",
          sourcePath,
          pathKey: "saved-state",
          branchName: "omnyo/saved-state",
        }),
      );

      if (created.status !== "created") throw new Error(created.message);

      const savedCommit = (
        await git(
          created.path,
          "commit-tree",
          "HEAD^{tree}",
          "-p",
          "HEAD",
          "-m",
          "saved",
        )
      ).trim();

      if (state === "MERGE_HEAD") {
        await git(created.path, "merge", "--no-ff", "--no-commit", savedCommit);
      } else {
        await git(created.path, "update-ref", state, savedCommit);
      }

      const gitDir = (
        await git(created.path, "rev-parse", "--absolute-git-dir")
      ).trim();

      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect((await git(created.path, "rev-parse", state)).trim()).toBe(
        savedCommit,
      );
      expect(
        (await git(sourcePath, "rev-parse", "omnyo/saved-state")).trim(),
      ).toBe((await git(created.path, "rev-parse", "HEAD")).trim());

      const result = await harness.experimental_call("remove", {
        operationId: "remove-state",
        pathKey: "saved-state",
        path: created.path,
      });

      expect({
        status: result.status,
        worktreeExists: existsSync(created.path),
        metadataExists: existsSync(gitDir),
      }).toEqual({
        status: "failed",
        worktreeExists: true,
        metadataExists: true,
      });
      expect((await git(created.path, "rev-parse", state)).trim()).toBe(
        savedCommit,
      );

      if (state === "MERGE_HEAD") {
        await git(created.path, "merge", "--abort");
      } else {
        await git(created.path, "update-ref", "-d", state);
      }

      const resolvedRemoval = await harness.experimental_call("remove", {
        operationId: "remove-resolved-state",
        pathKey: "saved-state",
        path: created.path,
      });

      if (resolvedRemoval.status === "failed")
        throw new Error(resolvedRemoval.message);
      expect(resolvedRemoval).toEqual({ status: "removed" });
      expect(existsSync(created.path)).toBe(false);
    } finally {
      await harness.experimental_dispose();
    }
  });

  it.each(["assume-unchanged", "skip-worktree", "core.ignoreStat"])(
    "keeps worktrees whose index hides edited files from status: %s",
    async (state) => {
      await inHiddenIndexWorktree(
        async ({ sourcePath }) => {
          if (state === "core.ignoreStat")
            await git(sourcePath, "config", "core.ignoreStat", "true");
        },
        async (worktree, remove) => {
          const file = join(worktree, "README.md");

          if (state === "assume-unchanged")
            await git(
              worktree,
              "update-index",
              "--assume-unchanged",
              "README.md",
            );
          else if (state === "skip-worktree")
            await git(worktree, "update-index", "--skip-worktree", "README.md");
          await writeFile(file, "hidden work\n");

          expect(
            await git(
              worktree,
              "status",
              "--porcelain",
              "--untracked-files=all",
              "--ignored",
            ),
          ).toBe("");
          expect(await remove()).toMatchObject({
            status: "failed",
            message: expect.stringContaining("hides in README.md ("),
          });
          expect(await readFile(file, "utf8")).toBe("hidden work\n");

          await writeFile(file, "hello\n");
          expect(await remove()).toEqual({ status: "removed" });
        },
      );
    },
  );

  it("removes a clean sparse worktree whose excluded files are absent", async () => {
    await inHiddenIndexWorktree(
      async ({ sourcePath }) => {
        await mkdir(join(sourcePath, "excluded"), { recursive: true });
        await writeFile(join(sourcePath, "excluded", "file.txt"), "outside\n");
        await git(sourcePath, "add", ".");
        await git(sourcePath, "commit", "-m", "add excluded file");
      },
      async (worktree, remove) => {
        await git(
          worktree,
          "sparse-checkout",
          "set",
          "--no-cone",
          "/README.md",
        );

        expect(existsSync(join(worktree, "excluded", "file.txt"))).toBe(false);
        expect(await git(worktree, "ls-files", "-v", "excluded")).toBe(
          "S excluded/file.txt\n",
        );
        expect(await remove()).toEqual({ status: "removed" });
      },
    );
  });

  it("removes unchanged hidden files whose committed bytes Git would convert", async () => {
    await inHiddenIndexWorktree(
      async ({ sourcePath }) => {
        await writeFile(join(sourcePath, "win.txt"), "a\r\nb\r\n");
        await git(sourcePath, "add", "win.txt");
        await git(sourcePath, "commit", "-m", "add crlf file");
        await writeFile(join(sourcePath, ".gitattributes"), "* text=auto\n");
        await git(sourcePath, "add", ".gitattributes");
        await git(sourcePath, "commit", "-m", "normalize line endings");
      },
      async (worktree, remove) => {
        await git(worktree, "update-index", "--assume-unchanged", "win.txt");

        expect(await readFile(join(worktree, "win.txt"), "utf8")).toBe(
          "a\r\nb\r\n",
        );
        expect(await remove()).toEqual({ status: "removed" });
      },
    );
  });

  it("refuses removal while a hidden symlink points somewhere new", async () => {
    await inHiddenIndexWorktree(
      async ({ sourcePath }) => {
        await symlink("README.md", join(sourcePath, "link"));
        await git(sourcePath, "add", "link");
        await git(sourcePath, "commit", "-m", "add link");
      },
      async (worktree, remove) => {
        const link = join(worktree, "link");
        await git(worktree, "update-index", "--assume-unchanged", "link");
        await rm(link);
        await symlink("elsewhere.md", link);

        expect(await remove()).toMatchObject({
          status: "failed",
          message: expect.stringContaining("hides in link ("),
        });

        await rm(link);
        await symlink("README.md", link);
        expect(await remove()).toEqual({ status: "removed" });
      },
    );
  });

  it("finds one edit among many hidden files that Git converts on checkout", async () => {
    const names = Array.from(
      { length: 300 },
      (_, index) =>
        `files/${"n".repeat(40)}-${String(index).padStart(3, "0")}.txt`,
    );

    const last = names.at(-1) ?? "";

    await inHiddenIndexWorktree(
      async ({ sourcePath }) => {
        await mkdir(join(sourcePath, "files"));
        await Promise.all(
          names.map((name) => writeFile(join(sourcePath, name), "line\n")),
        );
        await git(sourcePath, "add", "files");
        await git(sourcePath, "commit", "-m", "add many files");
        await git(sourcePath, "config", "core.autocrlf", "true");
        await git(sourcePath, "config", "core.ignoreStat", "true");
      },
      async (worktree, remove) => {
        expect(await readFile(join(worktree, last), "utf8")).toBe("line\r\n");
        await writeFile(join(worktree, last), "edited\r\n");

        expect(await remove()).toMatchObject({
          status: "failed",
          message: expect.stringContaining(`hides in ${last} (`),
        });

        await writeFile(join(worktree, last), "line\r\n");
        expect(await remove()).toEqual({ status: "removed" });
      },
    );
  });

  it("removes an ignoreStat worktree with an uninitialized submodule", async () => {
    await inHiddenIndexWorktree(
      async ({ root, sourcePath }) => {
        await addLibrarySubmodule(root, sourcePath);
        await git(sourcePath, "config", "core.ignoreStat", "true");
      },
      async (worktree, remove) => {
        expect(await git(worktree, "ls-files", "-v", "lib")).toBe("h lib\n");
        expect(await readdir(join(worktree, "lib"))).toEqual([]);
        expect(await remove()).toEqual({ status: "removed" });
      },
    );
  });

  it("keeps files left inside an uninitialized submodule folder", async () => {
    await inHiddenIndexWorktree(
      ({ root, sourcePath }) => addLibrarySubmodule(root, sourcePath),
      async (worktree, remove) => {
        const notes = join(worktree, "lib", "notes.txt");
        await writeFile(notes, "user work\n");

        expect(
          await git(
            worktree,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored",
          ),
        ).toBe("");
        expect(await remove()).toMatchObject({
          status: "failed",
          message: expect.stringContaining(
            "uninitialized submodule folder lib",
          ),
        });
        expect(await readFile(notes, "utf8")).toBe("user work\n");

        await rm(notes);
        expect(await remove()).toEqual({ status: "removed" });
      },
    );
  });

  it.each(["main", "release", "origin/main", "refs/heads/main"])(
    "resolves and fetches a stale named base %s",
    async (base) => {
      const { root, sourcePath, dataDir } = await createSourceRepository();
      const clone = join(root, "clone");
      await git(sourcePath, "branch", "release");
      await git(root, "clone", sourcePath, clone);
      const oldHead = (await git(clone, "rev-parse", "HEAD")).trim();
      await git(clone, "branch", "release", "origin/release");
      await writeFile(join(sourcePath, "README.md"), "remote advance\n");
      await git(sourcePath, "commit", "-am", "advance remote");
      await git(sourcePath, "branch", "-f", "release", "HEAD");
      const remoteHead = (await git(sourcePath, "rev-parse", "HEAD")).trim();

      const result = await createHarness(dataDir).experimental_call("create", {
        ...createInput({
          operationId: "stale-base",
          sourcePath: clone,
          pathKey: "stale-base",
          branchName: "omnyo/child",
        }),
        baseBranch: { kind: "named", name: base },
      });

      expect(result.status).toBe("created");

      if (result.status !== "created") throw new Error(result.message);
      expect((await git(result.path, "rev-parse", "HEAD")).trim()).toBe(
        base.startsWith("refs/heads/") ? oldHead : remoteHead,
      );
      expect((await git(clone, "rev-parse", "main")).trim()).toBe(oldHead);
    },
  );

  it.each([
    ["ahead", "main"],
    ["diverged", "main"],
    ["ahead", "release"],
    ["diverged", "release"],
    ["ahead", "origin/main"],
    ["diverged", "refs/heads/main"],
    ["ahead", "default"],
    ["diverged", "default"],
  ])("preserves local commits for %s with base %s", async (relation, base) => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const clone = join(root, "clone");
    await git(sourcePath, "branch", "release");
    await git(root, "clone", sourcePath, clone);
    await writeFile(join(clone, "local.txt"), "local work\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-m", "local work");
    await git(clone, "branch", "release");
    const localHead = (await git(clone, "rev-parse", "HEAD")).trim();

    if (relation === "diverged") {
      await writeFile(join(sourcePath, "remote.txt"), "remote work\n");
      await git(sourcePath, "add", ".");
      await git(sourcePath, "commit", "-m", "remote work");
      await git(sourcePath, "branch", "-f", "release", "HEAD");
      await git(clone, "fetch", "origin");
    }

    const remoteHead = (await git(sourcePath, "rev-parse", "HEAD")).trim();
    const harness = createHarness(dataDir);

    try {
      const result = await harness.experimental_call("create", {
        ...createInput({
          operationId: "local-work",
          sourcePath: clone,
          pathKey: "local-work",
          branchName: "omnyo/child",
        }),
        baseBranch:
          base === "default"
            ? { kind: "default" }
            : { kind: "named", name: base },
      });

      expect(result.status).toBe("created");

      if (result.status !== "created") throw new Error(result.message);
      expect((await git(result.path, "rev-parse", "HEAD")).trim()).toBe(
        base === "origin/main" ? remoteHead : localHead,
      );
    } finally {
      await harness.experimental_dispose();
    }
  });

  it.each([
    ["equal", "main"],
    ["behind", "main"],
    ["equal", "default"],
    ["behind", "default"],
    ["remote-only", "release"],
  ])(
    "uses the last fetched remote when the fetch fails for %s with base %s",
    async (relation, base) => {
      const { root, sourcePath, dataDir } = await createSourceRepository();
      const clone = join(root, "clone");
      await git(sourcePath, "branch", "release");
      await git(root, "clone", sourcePath, clone);
      const localHead = (await git(clone, "rev-parse", "HEAD")).trim();

      if (relation === "behind" || relation === "remote-only") {
        await writeFile(join(sourcePath, "README.md"), "remote advance\n");
        await git(sourcePath, "commit", "-am", "advance remote");
        await git(sourcePath, "branch", "-f", "release", "HEAD");
        await git(clone, "fetch", "origin");
      }

      const lastFetched = base === "release" ? "origin/release" : "origin/main";

      const lastFetchedHead = (
        await git(clone, "rev-parse", lastFetched)
      ).trim();

      await git(clone, "remote", "set-url", "origin", join(root, "missing"));
      const harness = createHarness(dataDir);

      try {
        const result = await harness.experimental_call("create", {
          ...createInput({
            operationId: "offline",
            sourcePath: clone,
            pathKey: "offline",
            branchName: "omnyo/offline",
          }),
          baseBranch:
            base === "default"
              ? { kind: "default" }
              : { kind: "named", name: base },
        });

        expect(result).toMatchObject({
          status: "created",
          baseBranch: lastFetched,
        });

        if (result.status !== "created") throw new Error(result.message);
        expect((await git(result.path, "rev-parse", "HEAD")).trim()).toBe(
          lastFetchedHead,
        );
        expect((await git(clone, "rev-parse", "main")).trim()).toBe(localHead);

        const progress = progressText(harness);

        expect(progress).toContain(`Failed to fetch ${lastFetched}`);
        expect(progress).toContain(
          `Using the last fetched ${lastFetched} (${lastFetchedHead.slice(0, 7)}`,
        );
      } finally {
        await harness.experimental_dispose();
      }
    },
  );

  it.each([
    ["main", "main"],
    ["default", null],
  ] as const)(
    "keeps a local base that is ahead without fetching for base %s",
    async (base, reportedBase) => {
      const { root, sourcePath, dataDir } = await createSourceRepository();
      const clone = join(root, "clone");
      await git(root, "clone", sourcePath, clone);
      await writeFile(join(clone, "local.txt"), "local work\n");
      await git(clone, "add", ".");
      await git(clone, "commit", "-m", "local work");
      const localHead = (await git(clone, "rev-parse", "HEAD")).trim();
      await git(clone, "remote", "set-url", "origin", join(root, "missing"));
      const harness = createHarness(dataDir);

      try {
        const result = await harness.experimental_call("create", {
          ...createInput({
            operationId: "offline-ahead",
            sourcePath: clone,
            pathKey: "offline-ahead",
            branchName: "omnyo/offline-ahead",
          }),
          baseBranch:
            base === "default"
              ? { kind: "default" }
              : { kind: "named", name: base },
        });

        expect(result).toMatchObject({
          status: "created",
          baseBranch: reportedBase,
        });

        if (result.status !== "created") throw new Error(result.message);
        expect((await git(result.path, "rev-parse", "HEAD")).trim()).toBe(
          localHead,
        );
        expect(progressText(harness)).not.toMatch(/fetch/iu);
      } finally {
        await harness.experimental_dispose();
      }
    },
  );

  it("fails when an explicit remote base cannot be fetched", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const clone = join(root, "clone");
    await git(root, "clone", sourcePath, clone);
    await git(clone, "remote", "set-url", "origin", join(root, "missing"));
    const harness = createHarness(dataDir);

    try {
      const result = await harness.experimental_call("create", {
        ...createInput({
          operationId: "offline-explicit",
          sourcePath: clone,
          pathKey: "offline-explicit",
          branchName: "omnyo/offline-explicit",
        }),
        baseBranch: { kind: "named", name: "origin/main" },
      });

      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringContaining("git fetch"),
      });
      expect(progressText(harness)).not.toContain("Using the last fetched");
      expect(
        existsSync(join(dataDir, "worktrees", "offline-explicit", "clone")),
      ).toBe(false);
    } finally {
      await harness.experimental_dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "cancels a create whose base fetch is still running",
    async () => {
      const { root, sourcePath, dataDir } = await createSourceRepository();
      const clone = join(root, "clone");
      await git(root, "clone", sourcePath, clone);
      const sshPidPath = join(root, "ssh.pid");
      const sshPath = join(root, "hanging-ssh");
      await writeFile(
        sshPath,
        `#!/bin/sh\necho $$ > "${sshPidPath}"\nexec sleep 30\n`,
        { mode: 0o755 },
      );
      await git(clone, "config", "core.sshCommand", sshPath);
      await git(
        clone,
        "remote",
        "set-url",
        "origin",
        "ssh://omnyo.invalid/repo",
      );
      const harness = createHarness(dataDir);
      const controller = new AbortController();

      const created = harness
        .experimental_call(
          "create",
          {
            ...createInput({
              operationId: "cancelled-fetch",
              sourcePath: clone,
              pathKey: "cancelled-fetch",
              branchName: "omnyo/cancelled-fetch",
            }),
            baseBranch: { kind: "named", name: "main" },
          },
          { signal: controller.signal },
        )
        .catch((error: unknown) => error);

      await expect
        .poll(() => existsSync(sshPidPath), { timeout: 10_000 })
        .toBe(true);
      controller.abort();
      expect(await created).toBeInstanceOf(Error);
      expect(progressText(harness)).not.toContain("Using the last fetched");
      expect(
        existsSync(join(dataDir, "worktrees", "cancelled-fetch", "clone")),
      ).toBe(false);
      await harness.experimental_dispose();
    },
  );

  it.each([
    { existingBranch: false, branchMode: "reset" },
    { existingBranch: false, branchMode: "reuse-existing" },
    { existingBranch: true, branchMode: "reuse-existing" },
    { existingBranch: true, branchMode: "reset" },
  ] as const)(
    "creates with a locked config (existing=$existingBranch, mode=$branchMode)",
    async ({ existingBranch, branchMode }) => {
      const { sourcePath, dataDir } = await createSourceRepository();
      await git(sourcePath, "remote", "add", "origin", sourcePath);
      await git(sourcePath, "fetch", "origin");
      await git(sourcePath, "config", "branch.autoSetupMerge", "always");
      await git(sourcePath, "config", "core.autocrlf", "true");
      const branchName = "omnyo/config-lock";

      if (existingBranch) {
        await git(
          sourcePath,
          "update-ref",
          "refs/remotes/origin/published",
          "HEAD",
        );
        await git(
          sourcePath,
          "branch",
          "--track",
          branchName,
          "origin/published",
        );
      }

      const configPath = join(sourcePath, ".git", "config");
      const originalConfig = await readFile(configPath, "utf8");
      const lockPath = `${configPath}.lock`;
      await writeFile(lockPath, "another Git writer\n");
      const harness = createHarness(dataDir);

      try {
        const result = await harness.experimental_call("create", {
          ...createInput({
            operationId: "config-lock",
            sourcePath,
            pathKey: "config-lock",
            branchName,
          }),
          branchMode,
          baseBranch: { kind: "named", name: "origin/main" },
        });

        expect(result.status).toBe("created");

        if (result.status !== "created") throw new Error(result.message);
        expect(
          (await readFile(join(result.path, "README.md"), "utf8")).replace(
            /\r\n/gu,
            "\n",
          ),
        ).toBe("hello\n");
        expect(await git(result.path, "rev-parse", "HEAD")).toBe(
          await git(sourcePath, "rev-parse", "origin/main"),
        );
        expect(
          (
            await git(
              result.path,
              "for-each-ref",
              "--format=%(upstream:short)",
              `refs/heads/${branchName}`,
            )
          ).trim(),
        ).toBe(existingBranch ? "origin/published" : "");
        expect(await readFile(lockPath, "utf8")).toBe("another Git writer\n");
        expect(await readFile(configPath, "utf8")).toBe(originalConfig);
      } finally {
        await harness.experimental_dispose();
      }
    },
  );

  it("resolves adoption paths with trailing slashes and symlink aliases", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const worktreePath = join(root, "feature");
    await git(sourcePath, "worktree", "add", "-b", "feature", worktreePath);
    const canonicalPath = await realpath(worktreePath);
    const aliasPath = join(root, "feature-alias");
    await symlink(worktreePath, aliasPath, "junction");
    const harness = createHarness(dataDir);

    for (const path of [canonicalPath, `${canonicalPath}/`, aliasPath]) {
      expect(
        await harness.experimental_call("resolveExistingWorktree", {
          sourcePath,
          path,
        }),
      ).toEqual({ status: "resolved", path: canonicalPath, branch: "feature" });
    }
  });

  it("refuses adoption aliases of the main checkout and managed worktrees", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const worktreePath = join(dataDir, "worktrees", "managed");
    await git(sourcePath, "worktree", "add", "-b", "managed", worktreePath);
    const dataAlias = join(root, "data-alias");
    await symlink(dataDir, dataAlias, "junction");
    const harness = createHarness(dataAlias);

    expect(
      await harness.experimental_call("listWorktrees", { sourcePath }),
    ).toEqual({ worktrees: [] });

    for (const [index, target] of [sourcePath, worktreePath].entries()) {
      const aliasPath = join(root, `alias-${index}`);
      await symlink(target, aliasPath, "junction");
      expect(
        await harness.experimental_call("resolveExistingWorktree", {
          sourcePath,
          path: aliasPath,
        }),
      ).toMatchObject({ status: "failed" });
    }
  });

  it("preserves adoption failures for missing and prunable worktrees", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const worktreePath = join(root, "feature");
    await git(sourcePath, "worktree", "add", "-b", "feature", worktreePath);
    const canonicalPath = await realpath(worktreePath);
    await rm(worktreePath, { recursive: true });
    const harness = createHarness(dataDir);

    expect(
      await harness.experimental_call("resolveExistingWorktree", {
        sourcePath,
        path: `${canonicalPath}/`,
      }),
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("prunable worktree"),
    });
    expect(
      await harness.experimental_call("resolveExistingWorktree", {
        sourcePath,
        path: join(root, "missing"),
      }),
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("not a worktree"),
    });
  });

  it("resolves the default label from the same refs used for creation", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    expect(
      await harness.experimental_call("defaultBaseBranch", { sourcePath }),
    ).toEqual({ branch: "main" });
    await git(sourcePath, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(
      sourcePath,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    expect(
      await harness.experimental_call("defaultBaseBranch", { sourcePath }),
    ).toEqual({ branch: "origin/main" });
    await writeFile(join(sourcePath, "README.md"), "ahead");
    await git(sourcePath, "commit", "-am", "local ahead");
    expect(
      await harness.experimental_call("defaultBaseBranch", { sourcePath }),
    ).toEqual({ branch: "main" });
  });

  it.each([
    ["spaces", "Repo With Space", "Repo-With-Space-7373994537587106"],
    ["CJK", "資料庫", "repo-1b2c8c90d27707c4"],
    ["NFC", "café", "cafe-850f7dc43910ff89"],
    ["NFD", "cafe\u0301", "cafe-81ef060bcd98adc7"],
    ["punctuation only", "!!!", "repo-e84c538e7fe25073"],
  ])(
    "creates and discovers cleanup paths for repository names with %s",
    async (_label, repositoryName, expectedLeaf) => {
      const { sourcePath, dataDir } =
        await createSourceRepository(repositoryName);

      const harness = createHarness(dataDir);
      const pathKey = "special-name";

      const result = await harness.experimental_call(
        "create",
        createInput({
          operationId: "create-special",
          sourcePath,
          pathKey,
          branchName: "omnyo/special-name",
        }),
      );

      expect(result).toMatchObject({
        status: "created",
        path: join(dataDir, "worktrees", pathKey, expectedLeaf),
      });

      if (result.status !== "created") throw new Error(result.message);
      expect(existsSync(join(result.path, "README.md"))).toBe(true);
      expect(
        await harness.experimental_call("remove", {
          operationId: "remove-special",
          pathKey,
          path: null,
        }),
      ).toEqual({ status: "removed" });
      expect(existsSync(join(dataDir, "worktrees", pathKey))).toBe(false);
      await harness.experimental_dispose();
    },
  );

  it("creates a bounded worktree path for a long repository name", async ({
    skip,
  }) => {
    skip(
      process.platform === "win32",
      "Windows cannot start a process whose working directory is longer than MAX_PATH",
    );
    const repositoryName = "repository".repeat(24);

    const { sourcePath, dataDir } =
      await createSourceRepository(repositoryName);

    const harness = createHarness(dataDir);

    const result = await harness.experimental_call(
      "create",
      createInput({
        operationId: "long-name",
        sourcePath,
        pathKey: "long-name",
        branchName: "omnyo/long-name",
      }),
    );

    expect(result.status).toBe("created");

    if (result.status !== "created") throw new Error(result.message);
    expect(Buffer.byteLength(basename(result.path), "utf8")).toBe(200);
    expect(basename(result.path)).toMatch(/-[a-f0-9]{16}$/u);
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("provisions the same specially named repository concurrently", async () => {
    const { sourcePath, dataDir } =
      await createSourceRepository("Concurrent Repo");

    const harness = createHarness(dataDir);

    const [first, second] = await Promise.all([
      harness.experimental_call(
        "create",
        createInput({
          operationId: "concurrent-first",
          sourcePath,
          pathKey: "concurrent-1",
          branchName: "omnyo/concurrent-1",
        }),
      ),
      harness.experimental_call(
        "create",
        createInput({
          operationId: "concurrent-second",
          sourcePath,
          pathKey: "concurrent-2",
          branchName: "omnyo/concurrent-2",
        }),
      ),
    ]);

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");

    if (first.status !== "created") throw new Error(first.message);

    if (second.status !== "created") throw new Error(second.message);
    expect(first.path).not.toBe(second.path);
    expect(basename(first.path)).toBe(basename(second.path));
    expect(existsSync(join(first.path, "README.md"))).toBe(true);
    expect(existsSync(join(second.path, "README.md"))).toBe(true);
    await harness.experimental_dispose();
  });

  it.skipIf(process.platform === "win32")(
    "settles a cancelled create promptly when Git's children are still running",
    async () => {
      const { root, sourcePath, dataDir } = await createSourceRepository();
      const hookPidPath = join(root, "hook.pid");
      const hookPath = join(sourcePath, ".git", "hooks", "post-checkout");
      await writeFile(
        hookPath,
        `#!/bin/sh\necho $$ > "${hookPidPath}"\nexec sleep 30\n`,
        { mode: 0o755 },
      );
      const harness = createHarness(dataDir);
      const controller = new AbortController();

      const created = harness
        .experimental_call(
          "create",
          createInput({
            operationId: "cancelled-create",
            sourcePath,
            pathKey: "cancelled",
            branchName: "omnyo/cancelled",
          }),
          { signal: controller.signal },
        )
        .catch((error) => error);

      await expect
        .poll(() => existsSync(hookPidPath), { timeout: 10_000 })
        .toBe(true);
      const hookPid = Number((await readFile(hookPidPath, "utf8")).trim());
      const abortedAt = performance.now();
      controller.abort();
      expect(await created).toBeInstanceOf(Error);
      expect(performance.now() - abortedAt).toBeLessThan(3_000);
      await expect.poll(() => isPidAlive(hookPid)).toBe(false);
      await harness.experimental_dispose();
    },
  );

  it("creates a worktree on a named base under the path-key directory", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    await git(sourcePath, "branch", "release");
    await git(sourcePath, "checkout", "release");
    await writeFile(join(sourcePath, "release.txt"), "release\n");
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "release only");
    await git(sourcePath, "checkout", "main");
    const harness = createHarness(dataDir);

    const result = await harness.experimental_call("create", {
      operationId: "named",
      sourcePath,
      pathKey: "thr_1",
      branchName: "omnyo/named-thr_1",
      baseBranch: { kind: "named", name: "release" },
      branchMode: "reset",
    });

    expect(result).toMatchObject({
      status: "created",
      path: join(dataDir, "worktrees", "thr_1", "repo"),
      baseBranch: "release",
    });

    if (result.status !== "created") throw new Error(result.message);
    expect(existsSync(join(result.path, "release.txt"))).toBe(true);
    expect(
      (await git(result.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
    ).toBe("omnyo/named-thr_1");
    await harness.experimental_dispose();
  });

  it("creates on an explicit base from a detached single-branch checkout", async () => {
    const { sourcePath, dataDir } =
      await createDetachedSingleBranchRepository();

    const harness = createHarness(dataDir);

    const result = await harness.experimental_call("create", {
      operationId: "detached",
      sourcePath,
      pathKey: "thr_detached",
      branchName: "omnyo/detached-thr",
      baseBranch: { kind: "named", name: "v1.0" },
      branchMode: "reset",
    });

    expect(result).toMatchObject({
      status: "created",
      path: join(dataDir, "worktrees", "thr_detached", "repo"),
      baseBranch: "v1.0",
    });

    if (result.status !== "created") throw new Error(result.message);
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("re-runs create with the same path key without replacing a valid worktree", async () => {
    const { sourcePath, dataDir } =
      await createSourceRepository("Restartable Repo");

    const input = createInput({
      operationId: "first",
      sourcePath,
      pathKey: "same-path-key",
      branchName: "omnyo/restart",
    });

    const firstHarness = createHarness(dataDir);
    const first = await firstHarness.experimental_call("create", input);

    if (first.status !== "created") throw new Error(first.message);
    await writeFile(join(first.path, "survives.txt"), "kept\n");
    await firstHarness.experimental_dispose();

    const restartedHarness = createHarness(dataDir);

    const resumed = await restartedHarness.experimental_call("create", {
      ...input,
      operationId: "resumed",
    });

    expect(resumed).toEqual(first);
    expect(existsSync(join(first.path, "survives.txt"))).toBe(true);
    await restartedHarness.experimental_dispose();
  });

  it("completes a recovered worktree without running core setup", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const setupMarker = join(root, "setup.marker");
    await writeFile(
      join(sourcePath, ".omnyo-env-setup.sh"),
      `#!/usr/bin/env bash\necho resumed > ${setupMarker}\n`,
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add setup script");
    const pathKey = "interrupted";
    const branchName = "omnyo/interrupted";
    const targetPath = join(dataDir, "worktrees", pathKey, "repo");
    await mkdir(join(dataDir, "worktrees", pathKey), { recursive: true });
    await git(
      sourcePath,
      "worktree",
      "add",
      "-B",
      branchName,
      targetPath,
      "main",
    );

    const harness = createHarness(dataDir);

    const resumed = await harness.experimental_call(
      "create",
      createInput({
        operationId: "resume-interrupted",
        sourcePath,
        pathKey,
        branchName,
      }),
    );

    expect(resumed).toMatchObject({ status: "created", path: targetPath });
    expect(existsSync(setupMarker)).toBe(false);
    expect(progressText(harness)).not.toContain("Running .omnyo-env-setup.sh");
    await harness.experimental_dispose();
  });

  it("replaces an invalid target before recreating the expected branch", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);

    const input = createInput({
      operationId: "first",
      sourcePath,
      pathKey: "replace",
      branchName: "omnyo/expected",
    });

    const first = await harness.experimental_call("create", input);

    if (first.status !== "created") throw new Error(first.message);
    await git(first.path, "checkout", "-b", "wrong-branch");

    const replaced = await harness.experimental_call("create", {
      ...input,
      operationId: "retry",
    });

    expect(replaced.status).toBe("created");
    expect(
      (await git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
    ).toBe("omnyo/expected");
    await harness.experimental_dispose();
  });

  it("leaves setup execution to core", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    await writeFile(
      join(sourcePath, ".omnyo-env-setup.sh"),
      "#!/usr/bin/env bash\necho setup-line-one\necho setup-line-two\n",
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add setup script");
    const harness = createHarness(dataDir);
    expect(
      await harness.experimental_call(
        "create",
        createInput({
          operationId: "setup",
          sourcePath,
          pathKey: "thr_3",
          branchName: "omnyo/setup-thr_3",
        }),
      ),
    ).toMatchObject({ status: "created" });
    expect(progressText(harness)).not.toContain("Running .omnyo-env-setup.sh");
    expect(progressText(harness)).not.toContain("setup-line-one");
    expect(progressText(harness)).not.toContain("setup-line-two");
    expect(
      harness
        .experimental_getSignals()
        .every((event) => event.payload.operationId === "setup"),
    ).toBe(true);
    await harness.experimental_dispose();
  });

  it("leaves a dirty earlier attempt alone when it holds the branch", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);

    const first = await harness.experimental_call(
      "create",
      createInput({
        operationId: "first",
        sourcePath,
        pathKey: "thr_7",
        branchName: "omnyo/dirty-thr_7",
      }),
    );

    if (first.status !== "created") throw new Error(first.message);
    await writeFile(join(first.path, "notes.txt"), "work in progress\n");

    const retry = await harness.experimental_call(
      "create",
      createInput({
        operationId: "retry",
        sourcePath,
        pathKey: "thr_7-2",
        branchName: "omnyo/dirty-thr_7",
      }),
    );

    expect(retry).toMatchObject({
      status: "failed",
      message: expect.stringContaining("uncommitted changes"),
    });
    expect(existsSync(join(first.path, "notes.txt"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("leaves teardown to core, kills workspace processes, and prunes the path-key parent", async ({
    skip,
  }) => {
    skip(
      process.platform === "win32",
      "killProcessesWithCwdUnder does not enumerate process working directories on Windows",
    );
    const { root, sourcePath, dataDir } = await createSourceRepository();
    await writeFile(
      join(sourcePath, ".omnyo-env-teardown.sh"),
      `#!/usr/bin/env bash\necho teardown-ran > ${join(root, "teardown.marker")}\necho tearing-down\n`,
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add teardown script");
    const harness = createHarness(dataDir);

    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create",
        sourcePath,
        pathKey: "thr_6",
        branchName: "omnyo/teardown-thr_6",
      }),
    );

    if (created.status !== "created") throw new Error(created.message);

    const lingering = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 300_000)"],
      {
        cwd: created.path,
        detached: true,
        stdio: "ignore",
      },
    );

    lingering.unref();

    const removed = await harness.experimental_call("remove", {
      operationId: "remove",
      pathKey: "thr_6",
      path: created.path,
    });

    const lingeringAlive = isPidAlive(lingering.pid ?? 0);
    lingering.kill("SIGKILL");
    expect(removed).toEqual({ status: "removed" });
    expect(lingeringAlive).toBe(false);
    expect(progressText(harness)).not.toContain("tearing-down");
    expect(existsSync(join(root, "teardown.marker"))).toBe(false);
    expect(existsSync(created.path)).toBe(false);
    expect(await readdir(join(dataDir, "worktrees"))).toEqual([]);
    await harness.experimental_dispose();
  });
});
