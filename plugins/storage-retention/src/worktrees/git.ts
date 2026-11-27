import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import { readdir, realpath, access, open, stat } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname, sep } from "node:path";
import {
  measureWorktreeStorage,
  invalidateWorktreeStorage,
  type WorktreeStorage,
} from "./storage.js";
import {
  findUnreportedChanges,
  WORKTREE_INDEX_LISTING_MAX_BYTES,
  WORKTREE_OPERATION_MARKERS,
  WORKTREE_PRIVATE_REF_NAMESPACES,
} from "omnyo-environment-provider-host/worktree-local-state";

export function isPathWithin(parent: string, target: string) {
  const difference = relative(parent, target);

  return (
    difference === "" ||
    (!isAbsolute(difference) &&
      difference !== ".." &&
      !difference.startsWith(`..${sep}`))
  );
}

const execute = promisify(execFile);

let activeGit = 0;

const gitWaiters: (() => void)[] = [];

const cleanupGitWaiters: (() => void)[] = [];

const cleanupPriority = new AsyncLocalStorage<true>();

const hostSignal = new AsyncLocalStorage<AbortSignal>();

export function withHostSignal<T>(signal: AbortSignal, run: () => T): T {
  return hostSignal.run(signal, run);
}

export function withCleanupPriority<T>(run: () => T): T {
  return cleanupPriority.run(true, run);
}

export async function git(
  cwd: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
  gitEnvironment: NodeJS.ProcessEnv = {},
) {
  hostSignal.getStore()?.throwIfAborted();

  if (activeGit >= 8)
    await new Promise<void>((resolve) =>
      (cleanupPriority.getStore() ? cleanupGitWaiters : gitWaiters).push(
        resolve,
      ),
    );
  else activeGit++;

  try {
    hostSignal.getStore()?.throwIfAborted();

    const result = await execute(
      "git",
      ["--no-optional-locks", "-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer,
        signal: hostSignal.getStore(),
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_LITERAL_PATHSPECS: "1",
          ...gitEnvironment,
        },
      },
    );

    return result.stdout;
  } finally {
    const next = cleanupGitWaiters.shift() ?? gitWaiters.shift();

    if (next) next();
    else activeGit--;
  }
}

async function revision(repo: string, ref: string) {
  if (ref.startsWith("-") || ref.includes("\0"))
    throw new Error("Invalid reference");

  return (await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

async function readGitMetadataAt(path: string) {
  try {
    const handle = await open(path, "r");

    try {
      const limit = 4 * 1024 * 1024;
      const { size } = await handle.stat();

      if (size > limit)
        throw new Error(
          "Cannot verify Git history or recovery: metadata exceeds 4 MiB",
        );
      const contents = Buffer.allocUnsafe(size + 1);
      let length = 0;

      while (length < contents.byteLength) {
        const { bytesRead } = await handle.read(
          contents,
          length,
          contents.byteLength - length,
          length,
        );

        if (!bytesRead) break;
        length += bytesRead;
      }

      if (length > size)
        throw new Error(
          "Cannot verify Git history or recovery: metadata changed during read",
        );

      return contents.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (missingFile.safeParse(cause).success) return "";
    throw cause;
  }
}

async function hasUnpreservedHeads(
  repo: string,
  heads: Iterable<string>,
  retainedHeads: string[],
  preservedHeads: ReadonlySet<string>,
) {
  const candidates = [...new Set(heads)].filter(
    (head) => !/^0+$/.test(head) && !preservedHeads.has(head),
  );

  for (let offset = 0; offset < candidates.length; offset += 256) {
    if (
      (
        await git(repo, [
          "rev-list",
          "--max-count=1",
          ...candidates.slice(offset, offset + 256),
          "--not",
          ...retainedHeads,
          "--",
        ])
      ).trim()
    )
      return true;
  }

  return false;
}

function hasUnpreservedReflog(
  repo: string,
  contents: string,
  retainedHeads: string[],
  preservedHeads: ReadonlySet<string>,
) {
  const heads = new Set<string>();

  for (const line of contents.split("\n")) {
    if (!line) continue;
    const pair = line.split(" ", 2);

    if (pair.length !== 2 || pair.some((head) => !objectId.test(head)))
      throw new Error("Cannot verify Git history: malformed reflog");

    for (const head of pair) heads.add(head);
  }

  return hasUnpreservedHeads(repo, heads, retainedHeads, preservedHeads);
}

async function equivalentRecoveryChanges(
  repo: string,
  contents: string,
  retainedHeads: string[],
  preservedHeads: ReadonlySet<string>,
  preservedBy: string,
) {
  const heads = new Set<string>();
  const rewrites = new Map<string, string>();

  for (const line of contents.split("\n")) {
    if (!line) continue;
    const [entry, action] = line.split("\t", 2);
    const [previous, next] = entry.split(" ", 2);

    for (const head of [previous, next])
      if (!/^0+$/.test(head) && !preservedHeads.has(head)) heads.add(head);

    if (
      action?.startsWith("commit (amend):") ||
      action?.startsWith("rebase (finish):")
    )
      rewrites.set(previous, next);
  }

  if (!rewrites.size || heads.size > 256) return false;

  const missing = (
    await git(repo, [
      "rev-list",
      "--max-count=9",
      ...heads,
      "--not",
      ...retainedHeads,
      "--",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  if (!missing.length || missing.length > 8) return false;

  const replacements = missing.flatMap((head) => {
    const replacement = rewrites.get(head);

    return replacement ? [{ head, replacement }] : [];
  });

  if (replacements.length !== missing.length) return false;

  if (
    (
      await git(repo, [
        "rev-list",
        "--max-count=1",
        ...replacements.map(({ replacement }) => replacement),
        "--not",
        preservedBy,
        "--",
      ])
    ).trim()
  )
    return false;

  const metadata = new Map(
    (
      await git(repo, [
        "log",
        "--no-walk=unsorted",
        "--format=%H %T %P",
        ...new Set(
          replacements.flatMap(({ head, replacement }) => [head, replacement]),
        ),
        "--",
      ])
    )
      .trim()
      .split("\n")
      .map((line) => {
        const [head, tree, ...parents] = line.trim().split(" ");

        return [head, { tree, parents }] as const;
      }),
  );

  function changedBlobs(head: string) {
    return git(repo, [
      "diff-tree",
      "--no-renames",
      "--no-abbrev",
      "--no-commit-id",
      "--raw",
      "-r",
      "-z",
      head,
      "--",
    ]);
  }

  for (const { head, replacement } of replacements) {
    const before = metadata.get(head);
    const after = metadata.get(replacement);

    if (!before || !after) return false;

    if (before.tree === after.tree) continue;

    if (before.parents.length !== 1 || after.parents.length !== 1) return false;

    const [oldChanges, newChanges] = await Promise.all([
      changedBlobs(head),
      changedBlobs(replacement),
    ]);

    if (oldChanges !== newChanges) return false;
  }

  return true;
}

async function hasUnpreservedRecovery(
  repo: string,
  gitDirectory: string,
  retainedHeads: string[],
  preservedHeads: ReadonlySet<string>,
) {
  const heads = new Set<string>();

  const recoveryRefs = await Promise.all(
    ["ORIG_HEAD", "FETCH_HEAD"].map((ref) =>
      readGitMetadataAt(join(gitDirectory, ref)),
    ),
  );

  for (const contents of recoveryRefs) {
    for (const line of contents.split("\n")) {
      if (!line) continue;
      const head = line.split(/[ \t]/, 1)[0];

      if (!objectId.test(head))
        throw new Error(
          "Cannot verify Git recovery: malformed recovery reference",
        );
      heads.add(head);
    }
  }

  return hasUnpreservedHeads(repo, heads, retainedHeads, preservedHeads);
}

export async function discover(
  roots: string[],
  onRepository?: (path: string) => void,
  options: {
    projectRoots?: ReadonlySet<string>;
    inactiveEnvironmentRoots?: ReadonlySet<string>;
  } = {},
) {
  const repos = new Map<
    string,
    {
      path: string;
      priority: number;
    }
  >();

  const errors: string[] = [];
  const missingInactive = new Set<string>();
  const possibleUmbrellas = new Set<string>();
  const observedRepos = new Set<string>();

  const gitIdentityFiles = new Set([
    "HEAD",
    "commondir",
    "config",
    "objects",
    "refs",
    "packed-refs",
    "shallow",
  ]);

  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return resolve(root);
      }
    }),
  );

  const visited = new Set<string>();

  const skip = new Set([
    ".git",
    "node_modules",
    ".next",
    ".cache",
    ".venv",
    "vendor",
    "dist",
    "build",
    "DerivedData",
    "SourcePackages",
    ".build",
    ".swiftpm",
    ".turbo",
    "Pods",
    "target",
    ".pnpm-store",
    "uv-cache",
    ".uv-cache",
    ".npm",
    ".yarn",
    "venv",
    "__pycache__",
    ".gradle",
    ".support-quarantine",
    ".Trash",
  ]);

  class DiscoveryLimit extends Error {}

  type Budget = {
    count: number;
    exhausted: boolean;
  };

  const queue = roots.map((path) => ({
    path,
    budget: { count: 0, exhausted: false },
  }));

  const waiters: (() => void)[] = [];
  let cursor = 0;
  let active = 0;

  function wake() {
    for (const resolve of waiters.splice(0)) resolve();
  }

  function enqueue(path: string, budget: Budget) {
    queue.push({ path, budget });
    wake();
  }

  async function visit(path: string, budget: Budget) {
    const canonical = await realpath(path).catch((error: unknown) => {
      if (
        !options.inactiveEnvironmentRoots?.has(path) ||
        !missingFile.safeParse(error).success
      )
        throw error;
      missingInactive.add(path);

      return null;
    });

    if (!canonical || visited.has(canonical)) return;

    if (budget.count >= 20000)
      throw new DiscoveryLimit("Repository scan exceeded 20,000 directories");
    visited.add(canonical);
    budget.count++;
    const entries = await readdir(canonical, { withFileTypes: true });
    let recognized = false;
    const gitEntry = entries.find((entry) => entry.name === ".git");

    if (gitEntry?.isDirectory() && options.projectRoots?.has(canonical)) {
      const metadata = await readdir(join(canonical, ".git")).catch(() => null);

      if (
        metadata &&
        !metadata.some((name) => gitIdentityFiles.has(name)) &&
        (!metadata.includes("worktrees") ||
          (await readdir(join(canonical, ".git", "worktrees")).then(
            (worktrees) => worktrees.length === 0,
            () => false,
          )))
      )
        possibleUmbrellas.add(canonical);
    }

    if (gitEntry && !possibleUmbrellas.has(canonical)) {
      try {
        const common = (
          await git(canonical, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ])
        ).trim();

        observedRepos.add(canonical);

        const priority = canonicalRoots.findIndex((root) =>
          isPathWithin(root, canonical),
        );

        const previous = repos.get(common);

        if (
          !previous ||
          priority < previous.priority ||
          (priority === previous.priority && canonical < previous.path)
        ) {
          repos.set(common, { path: canonical, priority });
          onRepository?.(canonical);
        }

        recognized = true;

        const paths = (
          await git(
            canonical,
            [
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "--directory",
              "-z",
            ],
            32 * 1024 * 1024,
          )
        )
          .split("\0")
          .filter(Boolean);

        const directories = new Set<string>();
        const untrackedDirectories = new Set<string>();

        for (const path of paths) {
          if (path.split("/").some((part) => skip.has(part))) continue;

          if (path.endsWith("/"))
            untrackedDirectories.add(join(canonical, path));

          let directory = path.endsWith("/")
            ? path.slice(0, -1)
            : dirname(path);

          while (directory !== "." && directory !== "") {
            directories.add(join(canonical, directory));
            directory = dirname(directory);
          }
        }

        const candidates = [...directories];

        for (let offset = 0; offset < candidates.length; offset += 64) {
          const existing = await Promise.all(
            candidates.slice(offset, offset + 64).map(async (directory) => {
              try {
                await access(join(directory, ".git"));

                return directory;
              } catch (error) {
                if (!missingFile.safeParse(error).success) throw error;

                return null;
              }
            }),
          );

          for (const directory of existing)
            if (directory) enqueue(directory, budget);
        }

        for (const directory of untrackedDirectories)
          enqueue(directory, budget);

        const submodules = (
          await git(canonical, ["ls-files", "--stage", "-z"], 32 * 1024 * 1024)
        ).split("\0");

        for (const entry of submodules)
          if (entry.startsWith("160000 ")) {
            const path = join(canonical, entry.slice(entry.indexOf("\t") + 1));
            enqueue(path, budget);
          }

        return;
      } catch (error) {
        if (error instanceof DiscoveryLimit) throw error;
        let message = error instanceof Error ? error.message : String(error);

        if (!recognized && gitEntry.isFile()) {
          const contents = await readGitMetadataAt(
            join(canonical, ".git"),
          ).catch(() => "");

          const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(contents);

          if (pointer) {
            const target = resolve(canonical, pointer[1]);

            if (
              await access(target).then(
                () => false,
                (cause) => missingFile.safeParse(cause).success,
              )
            )
              message = `Git metadata directory is missing at ${target}`;
          }
        }

        errors.push(`${canonical}: ${message}`);

        if (recognized) return;
      }
    }

    async function directoryEntries(path: string) {
      try {
        return await readdir(path, { withFileTypes: true });
      } catch (cause) {
        if (
          !z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) }).safeParse(cause)
            .success
        )
          throw cause;

        return [];
      }
    }

    async function exists(path: string) {
      try {
        await access(path);

        return true;
      } catch (cause) {
        if (!missingFile.safeParse(cause).success) throw cause;

        return false;
      }
    }

    async function prefix(path: string, limit: number) {
      let handle;

      try {
        handle = await open(path, "r");
        const bytes = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(bytes, 0, limit, 0);

        return bytes.subarray(0, bytesRead).toString("utf8");
      } catch (cause) {
        if (!missingFile.safeParse(cause).success) throw cause;

        return "";
      } finally {
        await handle?.close();
      }
    }

    if (
      entries.some((entry) => entry.name === "pyvenv.cfg" && entry.isFile())
    ) {
      const unixLayout = async () => {
        if (!(await exists(join(canonical, "bin", "python")))) return false;

        if (
          !entries.some((entry) => entry.name === "lib" && entry.isDirectory())
        )
          return false;
        const versions = await directoryEntries(join(canonical, "lib"));

        for (const version of versions)
          if (
            version.isDirectory() &&
            /^python\d+(?:\.\d+)*$/.test(version.name) &&
            (await directoryEntries(join(canonical, "lib", version.name))).some(
              (entry) => entry.name === "site-packages" && entry.isDirectory(),
            )
          )
            return true;

        return false;
      };

      const windowsLayout = async () =>
        (await exists(join(canonical, "Scripts", "python.exe"))) &&
        (await directoryEntries(join(canonical, "Lib"))).some(
          (entry) => entry.name === "site-packages" && entry.isDirectory(),
        );

      if ((await unixLayout()) || (await windowsLayout())) return;
    }

    if (
      canonical.endsWith(".xcresult") &&
      entries.some((entry) => entry.name === "Data" && entry.isDirectory()) &&
      entries.some((entry) => entry.name === "Info.plist" && entry.isFile())
    ) {
      const plist = await prefix(join(canonical, "Info.plist"), 8192);

      if (
        plist.includes("<plist") &&
        ["rootId", "storage", "version"].every((key) =>
          plist.includes(`<key>${key}</key>`),
        )
      )
        return;
    }

    if (canonical.endsWith(".app")) {
      const packageRoot = entries.some(
        (entry) => entry.name === "Contents" && entry.isDirectory(),
      )
        ? join(canonical, "Contents")
        : canonical;

      const packageEntries =
        packageRoot === canonical
          ? entries
          : await directoryEntries(packageRoot);

      if (
        packageEntries.some(
          (entry) => entry.name === "Info.plist" && entry.isFile(),
        ) &&
        packageEntries.some(
          (entry) => entry.name === "PkgInfo" && entry.isFile(),
        )
      ) {
        const [info, signature] = await Promise.all([
          prefix(join(packageRoot, "Info.plist"), 128),
          prefix(join(packageRoot, "PkgInfo"), 8),
        ]);

        if (
          signature.startsWith("APPL") &&
          (info.includes("<plist") || info.startsWith("bplist"))
        )
          return;
      }
    }

    if (
      entries.some(
        (entry) => entry.name === "CMakeCache.txt" && entry.isFile(),
      ) &&
      entries.some(
        (entry) => entry.name === "CMakeFiles" && entry.isDirectory(),
      ) &&
      (await prefix(join(canonical, "CMakeCache.txt"), 128)).startsWith(
        "# This is the CMakeCache file.",
      )
    )
      return;

    if (
      relative(dirname(canonical), canonical) === "Index.noindex" &&
      entries.some((entry) => entry.name === "DataStore" && entry.isDirectory())
    ) {
      for (const version of await directoryEntries(
        join(canonical, "DataStore"),
      )) {
        if (!version.isDirectory() || !/^v\d+$/.test(version.name)) continue;

        const content = await directoryEntries(
          join(canonical, "DataStore", version.name),
        );

        if (
          ["records", "units"].every((name) =>
            content.some((entry) => entry.name === name && entry.isDirectory()),
          )
        )
          return;
      }
    }

    for (const entry of entries)
      if (entry.isDirectory() && !skip.has(entry.name))
        enqueue(join(canonical, entry.name), budget);
  }

  async function worker() {
    while (true) {
      const task = queue[cursor];

      if (!task) {
        if (active === 0) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
        continue;
      }

      cursor++;

      if (task.budget.exhausted) continue;
      active++;

      try {
        await visit(task.path, task.budget);
      } catch (error) {
        if (error instanceof DiscoveryLimit) task.budget.exhausted = true;
        errors.push(
          `${task.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        active--;
        wake();
      }
    }
  }

  await Promise.all(Array.from({ length: 8 }, () => worker()));

  for (const root of possibleUmbrellas)
    if (
      ![...observedRepos].some(
        (path) => root !== path && isPathWithin(root, path),
      )
    )
      errors.push(
        `${root}: Git metadata is incomplete and no child repository was found`,
      );

  return {
    repos: [...repos.values()]
      .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))
      .map((repo) => repo.path),
    errors,
    missingInactive: [...missingInactive],
  };
}

async function worktreeRecords(repo: string) {
  const tokens = (
    await git(repo, ["worktree", "list", "--porcelain", "-z"])
  ).split("\0");

  const records: {
    path: string;
    head: string;
    branch: string | null;
    locked: boolean;
    missing: boolean;
    bare: boolean;
  }[] = [];

  for (const token of tokens) {
    if (token.startsWith("worktree "))
      records.push({
        path: token.slice(9),
        head: "",
        branch: null,
        locked: false,
        missing: false,
        bare: false,
      });
    const current = records.at(-1);

    if (!current) continue;

    if (token.startsWith("HEAD ")) current.head = token.slice(5);

    if (token.startsWith("branch refs/heads/"))
      current.branch = token.slice(18);

    if (token.startsWith("locked")) current.locked = true;

    if (token.startsWith("prunable")) current.missing = true;

    if (token === "bare") current.bare = true;
  }

  const primary = records[0];

  if (primary && !primary.bare) {
    try {
      await access(join(primary.path, ".git"));
    } catch (cause) {
      if (!missingFile.safeParse(cause).success) throw cause;

      const common = (
        await git(repo, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim();

      if ((await realpath(primary.path)) !== (await realpath(common)))
        throw new Error("Cannot resolve the primary checkout source directory");

      const configured = (
        await git(repo, ["config", "--get", "--default", "", "core.worktree"])
      ).trim();

      let source: string;

      if (configured)
        source = (await git(common, ["rev-parse", "--show-toplevel"])).trim();
      else {
        const directory = (
          await git(repo, ["rev-parse", "--absolute-git-dir"])
        ).trim();

        if ((await realpath(directory)) !== (await realpath(common)))
          throw new Error(
            "Cannot resolve the primary checkout source directory",
          );
        source = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
      }

      primary.path = await realpath(source);
    }
  }

  return records;
}

export async function primaryCheckout(repo: string) {
  const primary = (await worktreeRecords(repo))[0];

  if (!primary || primary.missing)
    throw new Error("Primary checkout is unavailable");

  return primary.path;
}

function originBaseline(repo: string) {
  return git(repo, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]).then(
    (output) => output.trim(),
    () => null,
  );
}

function localBaseline(branches: string[]) {
  return branches.includes("main")
    ? "main"
    : branches.includes("master")
      ? "master"
      : null;
}

function gitCommonDirectory(repo: string) {
  return git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).then((output) => output.trim());
}

function requireGitOutput<T>(result: PromiseSettledResult<T>) {
  if (result.status === "rejected") throw result.reason;

  return result.value;
}

function statusFiles(output: string) {
  const entries = output.split("\0");
  const paths: string[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (!entry) continue;
    paths.push(entry.slice(3));

    if (entry.slice(0, 2).includes("R") || entry.slice(0, 2).includes("C"))
      index++;
  }

  return paths;
}

export async function inspectRepo(
  repo: string,
  protectedPaths: string[],
  includeStorage = true,
  chatTargets?: ReadonlySet<string>,
) {
  return inspectTargets(
    repo,
    protectedPaths,
    includeStorage,
    undefined,
    chatTargets,
  );
}

export async function inspectCleanupRepo(
  repo: string,
  protectedPaths: string[],
  chatTargets?: ReadonlySet<string>,
) {
  return inspectTargets(
    repo,
    protectedPaths,
    false,
    { kind: "cleanup" },
    chatTargets,
  );
}

type CleanupTarget =
  | {
      kind: "folder";
      name: string;
      measurement?:
        | { kind: "preview" }
        | { kind: "removal"; head: string; base?: string };
    }
  | { kind: "branch"; name: string };

export function inspectCleanupTarget(
  repo: string,
  protectedPaths: string[],
  target: CleanupTarget,
  chatTargets?: ReadonlySet<string>,
) {
  return inspectTargets(repo, protectedPaths, false, target, chatTargets);
}

async function localBranchRefs(repo: string) {
  return (
    await git(repo, [
      "for-each-ref",
      "--format=%(refname:strip=2)%09%(objectname)%09%(upstream)",
      "refs/heads/",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split("\t");

      return { name, head, upstream };
    });
}

function comparisonBaseline(
  refs: Awaited<ReturnType<typeof localBranchRefs>>,
  primaryBranch: string | null | undefined,
  fallback: string | null,
) {
  const upstream = refs.find(({ name }) => name === primaryBranch)?.upstream;

  if (upstream)
    return {
      base: upstream.replace(/^refs\/(?:heads|remotes)\//, ""),
      baseRef: upstream,
    };

  return {
    base: fallback,
    baseRef: fallback
      ? refs.some(({ name }) => name === fallback)
        ? `refs/heads/${fallback}`
        : `refs/remotes/${fallback}`
      : null,
  };
}

type BranchBatch = {
  kind: "branchBatch";
  bases: ReadonlyMap<string, string>;
  logRoot: string;
  reflogs: Map<string, string>;
  upstreams: Map<string, string>;
  retained: Map<string, string>;
};

export function chatOwns(target: string, chatTargets?: ReadonlySet<string>) {
  if (!chatTargets?.size) return false;

  if (chatTargets.has(target)) return true;

  for (const [, id] of target.matchAll(
    /(?:^|[^a-z0-9])thr[_-]([a-z0-9]+)(?=$|[^a-z0-9])/g,
  ))
    if (chatTargets.has(`thr_${id}`)) return true;

  return false;
}

function chatWorktrees(
  records: Awaited<ReturnType<typeof worktreeRecords>>,
  chatTargets?: ReadonlySet<string>,
) {
  return records
    .slice(1)
    .filter(
      (w) =>
        chatOwns(w.path, chatTargets) || chatOwns(w.branch ?? "", chatTargets),
    );
}

async function inspectTargets(
  repo: string,
  protectedPaths: string[],
  includeStorage: boolean,
  target?: CleanupTarget | { kind: "cleanup" } | BranchBatch,
  chatTargets?: ReadonlySet<string>,
) {
  const measurement =
    target?.kind === "folder" ? target.measurement : undefined;

  const [refs, records, canonicalProtected, origin, commonDirectory] =
    await Promise.all([
      localBranchRefs(repo),
      worktreeRecords(repo),
      Promise.all(
        protectedPaths.map(async (path) => {
          try {
            return await realpath(path);
          } catch {
            return resolve(path);
          }
        }),
      ),
      originBaseline(repo),
      includeStorage || measurement
        ? gitCommonDirectory(repo)
        : Promise.resolve(null),
    ]);

  const names = refs.map((ref) => ref.name);
  const retentionBase = origin ?? localBaseline(names);

  const { base, baseRef } = comparisonBaseline(
    refs,
    records[0]?.branch,
    retentionBase,
  );

  const baseSha =
    baseRef && !target ? await revision(repo, baseRef).catch(() => null) : null;

  const counts = new Map<
    string,
    Promise<{
      ahead: number | null;
      behind: number | null;
    }>
  >();

  function comparison(head: string) {
    if (!baseSha || target)
      return Promise.resolve({ ahead: null, behind: null });

    if (head === baseSha) return Promise.resolve({ ahead: 0, behind: 0 });
    let count = counts.get(head);

    if (!count) {
      count = git(repo, [
        "rev-list",
        "--left-right",
        "--count",
        `${baseSha}...${head}`,
      ]).then((value) => {
        const [behind, ahead] = value.trim().split(/\s+/).map(Number);

        return { ahead, behind };
      });
      counts.set(head, count);
    }

    return count;
  }

  const chatOwners = chatWorktrees(records, chatTargets);
  const chatPaths = new Set(chatOwners.map((w) => w.path));

  const chatHeads = new Set(
    chatOwners.filter((w) => !w.branch).map((w) => w.head),
  );

  const localBase = retentionBase?.startsWith("origin/")
    ? retentionBase.slice(7)
    : retentionBase;

  const baseNames = [localBase, "main", "master"].filter(
    (name) => name && names.includes(name),
  );

  const refsByHead = new Map<string, typeof refs>();

  for (const ref of refs) {
    const group = refsByHead.get(ref.head);

    if (group) group.push(ref);
    else refsByHead.set(ref.head, [ref]);
  }

  const distinctHeads = [...refsByHead.keys()];

  const independent = distinctHeads.length
    ? (await git(repo, ["merge-base", "--independent", ...distinctHeads]))
        .trim()
        .split("\n")
    : [];

  const reviewedBases = new Set(
    target?.kind === "branchBatch" ? target.bases.values() : [],
  );

  const retained = refs.filter(
    (ref) => baseNames.includes(ref.name) || reviewedBases.has(ref.name),
  );

  const independentHeads = new Set(independent);
  const namedHeads = new Set(retained.map((ref) => ref.head));

  for (const head of independent) {
    if (namedHeads.has(head)) continue;
    const candidates = refsByHead.get(head);

    if (!candidates?.length)
      throw new Error("Git returned an unknown independent branch tip");
    candidates.sort(
      (a, b) =>
        Number(b.name === records[0]?.branch) -
          Number(a.name === records[0]?.branch) || a.name.localeCompare(b.name),
    );
    retained.push(candidates[0]);
  }

  if (target?.kind === "branchBatch")
    for (const ref of retained) target.retained.set(ref.name, ref.head);
  const preservation = new Map<string, string>();
  const retainedNames = new Set(retained.map((ref) => ref.name));

  const remaining = new Set(
    distinctHeads.filter((head) => !independentHeads.has(head)),
  );

  const coverageByBase = new Map<string, Set<string>>();
  const refsByName = new Map(refs.map((ref) => [ref.name, ref.head]));
  const reviewedCoverage = new Set<string>();

  if (target?.kind === "branchBatch") {
    for (const [name, base] of target.bases) {
      const head = refsByName.get(name);

      if (head && head !== refsByName.get(base) && !independentHeads.has(head))
        reviewedCoverage.add(base);
    }
  }

  function recordCoverage(name: string, heads: Set<string>) {
    if (reviewedBases.has(name)) coverageByBase.set(name, heads);

    for (const head of heads) {
      remaining.delete(head);

      if (!preservation.has(head)) preservation.set(head, name);
    }
  }

  for (let offset = 0; offset < retained.length;) {
    const anchor = retained[offset];

    if (
      !reviewedCoverage.has(anchor.name) &&
      (remaining.size === 0 ||
        (remaining.size === 1 && remaining.has(anchor.head)))
    ) {
      recordCoverage(anchor.name, new Set([anchor.head]));
      offset++;
      continue;
    }

    const width = offset < baseNames.length ? 1 : 4;

    const coverage = await Promise.all(
      retained.slice(offset, offset + width).map(async (ref) => ({
        name: ref.name,
        heads: new Set(
          (
            await git(repo, [
              "for-each-ref",
              `--merged=${ref.head}`,
              "--format=%(objectname)",
              "refs/heads/",
            ])
          )
            .trim()
            .split("\n"),
        ),
      })),
    );

    for (const { name, heads } of coverage) recordCoverage(name, heads);
    offset += coverage.length;
  }

  const retainedHeads = retained.map((ref) => ref.head);
  const preservedHeads = new Set(preservation.keys());

  const selectedWorktrees = records.flatMap((w, index) =>
    !target ||
    target.kind === "cleanup" ||
    (target.kind === "folder" && target.name === w.path)
      ? [{ w, index }]
      : [],
  );

  const worktrees = await Promise.all(
    selectedWorktrees.map(async ({ w, index }) => {
      let dirty = false;
      let dirtyFiles: string[] = [];
      let ignored = false;
      let error: string | null = null;
      let count: number | null = null;
      let behind: number | null = null;
      let lastActivityAt: number | null = null;
      let unsavedCommitCount: number | null = w.branch === null ? null : 0;

      let hiddenIndex = false;
      let submoduleFiles = false;
      let operation = false;
      let privateReferences = false;
      let gitDirectory: string | undefined;
      const inUse = canonicalProtected.some((p) => isPathWithin(w.path, p));

      const blocked =
        index === 0 ||
        w.locked ||
        inUse ||
        chatPaths.has(w.path) ||
        !w.branch ||
        !preservation.has(w.head) ||
        preservation.get(w.head) === w.branch;

      const measureForCleanup =
        measurement &&
        !blocked &&
        (measurement.kind === "preview" ||
          (w.head === measurement.head &&
            (!measurement.base ||
              preservation.get(w.head) === measurement.base)));

      if (measureForCleanup && measurement.kind === "removal")
        invalidateWorktreeStorage(w.path);

      const storage =
        w.bare || w.missing || (!includeStorage && !measureForCleanup)
          ? Promise.resolve({
              status: "unavailable" as const,
              allocatedBytes: null,
              reclaimableBytes: null,
              measuredAt: new Date().toISOString(),
              error:
                !includeStorage && !measureForCleanup
                  ? "Storage not requested for safety recheck"
                  : w.bare
                    ? "Bare repository has no working folder"
                    : "Working folder is missing",
            })
          : measureWorktreeStorage(w.path, [
              ...(commonDirectory ? [commonDirectory] : []),
              ...records
                .filter((other) => other.path !== w.path)
                .map((other) => other.path),
            ]);

      if (!target || w.bare || w.missing || !blocked) {
        try {
          if (w.bare || w.missing)
            throw new Error(
              w.bare ? "Bare repository" : "Worktree directory is missing",
            );

          const [status, ignoredFiles, unreported, privateRefs, directory] =
            await Promise.allSettled([
              git(w.path, [
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
              ]),
              git(w.path, [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "--no-empty-directory",
                "-z",
              ]),
              findUnreportedChanges(
                w.path,
                (args) => git(w.path, args, WORKTREE_INDEX_LISTING_MAX_BYTES),
                () => hostSignal.getStore()?.throwIfAborted(),
              ),
              git(w.path, [
                "for-each-ref",
                "--format=%(refname)",
                ...WORKTREE_PRIVATE_REF_NAMESPACES,
              ]),
              git(w.path, ["rev-parse", "--absolute-git-dir"]),
            ]);

          dirtyFiles = statusFiles(requireGitOutput(status));
          dirty = dirtyFiles.length > 0;
          ignored = requireGitOutput(ignoredFiles).length > 0;
          const unreportedChanges = requireGitOutput(unreported);
          hiddenIndex = unreportedChanges.hidden.length > 0;
          submoduleFiles = unreportedChanges.submodules.length > 0;
          privateReferences = requireGitOutput(privateRefs).trim().length > 0;

          const metadataDirectory = requireGitOutput(directory).trim();
          gitDirectory = metadataDirectory;

          if (!isAbsolute(metadataDirectory))
            throw new Error("Cannot resolve worktree Git metadata");

          const present = await Promise.all(
            WORKTREE_OPERATION_MARKERS.map((marker) =>
              access(join(metadataDirectory, marker)).then(
                () => true,
                (cause) => {
                  if (!missingFile.safeParse(cause).success) throw cause;

                  return false;
                },
              ),
            ),
          );

          operation = present.some(Boolean);

          ({ ahead: count, behind } = await comparison(w.head));

          if (includeStorage && index !== 0) {
            const [times, unsaved] = await Promise.all([
              Promise.all(
                ["HEAD", "index", join("logs", "HEAD")].map((name) =>
                  stat(join(metadataDirectory, name)).then(
                    (entry) => entry.mtimeMs,
                    () => 0,
                  ),
                ),
              ),
              w.branch === null && objectId.test(w.head)
                ? git(w.path, [
                    "rev-list",
                    "--count",
                    w.head,
                    "--not",
                    "--branches",
                    "--tags",
                    "--remotes",
                  ]).then(
                    (output) => Number(output.trim()),
                    () => null,
                  )
                : Promise.resolve(unsavedCommitCount),
            ]);

            const latest = Math.max(...times);
            lastActivityAt = latest > 0 ? Math.round(latest) : null;
            unsavedCommitCount = unsaved;
          }
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }

      const reasons = [
        index === 0 ? "Primary checkout" : "",
        dirty ? "Uncommitted files" : "",
        ignored ? "Ignored files present" : "",
        w.locked ? "Locked" : "",
        hiddenIndex ? "Index hides working files" : "",
        submoduleFiles ? "Uninitialized submodule holds files" : "",
        operation ? "Git operation in progress" : "",
        privateReferences ? "Worktree-private references present" : "",
        inUse ? "Used by Omnyo environment or project source" : "",
        chatPaths.has(w.path) ? "Used by an open or protected chat" : "",
        !w.branch ? "Detached HEAD" : "",
        !preservation.has(w.head) || preservation.get(w.head) === w.branch
          ? "Not merged into another retained local branch"
          : "",
        error ?? "",
      ].filter(Boolean);

      if (reasons.length === 0 && gitDirectory) {
        try {
          if (
            await hasUnpreservedRecovery(
              w.path,
              gitDirectory,
              retainedHeads,
              preservedHeads,
            )
          )
            reasons.push("Unique commits in worktree recovery references");
          else if (
            await hasUnpreservedReflog(
              w.path,
              await readGitMetadataAt(join(gitDirectory, "logs", "HEAD")),
              retainedHeads,
              preservedHeads,
            )
          )
            reasons.push("Unique commits in worktree HEAD history");
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
          reasons.push(error);
        }
      }

      return {
        ...w,
        error,
        dirty,
        dirtyFiles,
        ignored,
        lastActivityAt,
        unsavedCommitCount,
        ahead: count,
        behind,
        storage: await storage,
        purgeReady: reasons.length === 0,
        preserveIn: preservation.get(w.head) ?? null,
        reasons,
      };
    }),
  );

  const deletionChecks = new Map<string, Promise<Set<string>>>();
  let upstreamTips: Promise<Map<string, string>> | undefined;
  let branchLogRoot: Promise<string> | undefined;

  function readBranchReflog(name: string) {
    branchLogRoot ??= git(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "logs/refs/heads",
    ]).then((output) => output.trim());

    return branchLogRoot.then((root) => readGitMetadataAt(join(root, name)));
  }

  async function readUpstreamTips() {
    const upstreams = [
      ...new Set(refs.flatMap(({ upstream }) => (upstream ? [upstream] : []))),
    ];

    const tips = new Map<string, string>();

    for (let offset = 0; offset < upstreams.length; offset += 128) {
      const output = await git(repo, [
        "for-each-ref",
        "--format=%(refname)%09%(objectname)",
        "--",
        ...upstreams.slice(offset, offset + 128),
      ]);

      for (const line of output.trim().split("\n")) {
        if (!line) continue;
        const [name, head] = line.split("\t");
        tips.set(name, head);
      }
    }

    return tips;
  }

  async function mergedIntoUpstream(head: string, upstream: string) {
    upstreamTips ??= readUpstreamTips();

    if ((await upstreamTips).get(upstream) === head) return true;
    let check = deletionChecks.get(upstream);

    if (!check) {
      check = git(repo, [
        "for-each-ref",
        `--merged=${upstream}`,
        "--format=%(objectname)",
        "refs/heads/",
      ]).then((output) => new Set(output.trim().split("\n")));
      deletionChecks.set(upstream, check);
    }

    return (await check).has(head);
  }

  const selectedBranches = refs.filter(
    (ref) =>
      !target ||
      target.kind === "cleanup" ||
      (target.kind === "branch" && target.name === ref.name) ||
      (target.kind === "branchBatch" && target.bases.has(ref.name)),
  );

  const removablePaths = new Set(
    worktrees.flatMap((worktree) =>
      worktree.purgeReady ? [worktree.path] : [],
    ),
  );

  const checkoutPaths = new Map<string, string[]>();

  for (const worktree of records) {
    if (!worktree.branch) continue;
    const paths = checkoutPaths.get(worktree.branch);

    if (paths) paths.push(worktree.path);
    else checkoutPaths.set(worktree.branch, [worktree.path]);
  }

  async function inspectBranch({
    name,
    head,
    upstream,
  }: (typeof refs)[number]) {
    const paths = checkoutPaths.get(name) ?? [];
    const reasons: string[] = [];

    if (paths.length) reasons.push("Checked out in a working folder");

    if (chatOwns(name, chatTargets) || chatHeads.has(head))
      reasons.push("Used by an open or protected chat");

    const reviewedBase =
      target?.kind === "branchBatch" ? target.bases.get(name) : undefined;

    if (target?.kind === "branchBatch") target.upstreams.set(name, upstream);

    const deleteBase = reviewedBase
      ? coverageByBase.get(reviewedBase)?.has(head)
        ? reviewedBase
        : null
      : (preservation.get(head) ?? null);

    if (retainedNames.has(name))
      reasons.push("Retained branch — preserves commits");

    if (
      name.startsWith("private-release/") ||
      name.startsWith("storage-keepers/")
    )
      reasons.push("Owned by release retention");

    if (!deleteBase) reasons.push("No retained local branch preserves commits");

    if (
      !reasons.some((reason) => reason !== "Checked out in a working folder") &&
      (target?.kind !== "cleanup" ||
        paths.every((path) => removablePaths.has(path)))
    ) {
      try {
        let contents: string;

        if (target?.kind === "branchBatch") {
          contents = await readGitMetadataAt(join(target.logRoot, name));
          target.reflogs.set(name, contents);
        } else {
          contents = await readBranchReflog(name);
        }

        if (
          await hasUnpreservedReflog(
            repo,
            contents,
            retainedHeads,
            preservedHeads,
          )
        ) {
          const preservedBy = deleteBase
            ? refsByName.get(deleteBase)
            : undefined;

          const equivalent =
            !target &&
            preservedBy &&
            (await equivalentRecoveryChanges(
              repo,
              contents,
              retainedHeads,
              preservedHeads,
              preservedBy,
            ).catch(() => false));

          reasons.push(
            equivalent
              ? "Recovery changes match retained commits · Original commit IDs kept"
              : "Unique commits in branch history",
          );
        } else if (upstream && !(await mergedIntoUpstream(head, upstream)))
          reasons.push("Not merged into its upstream");
      } catch {
        reasons.push("Cannot verify Git deletion check");
      }
    }

    return {
      name,
      head,
      ...(await comparison(head)),
      worktrees: paths,
      deleteReady: reasons.length === 0,
      deleteBase,
      reasons,
    };
  }

  const branches: Awaited<ReturnType<typeof inspectBranch>>[] = [];
  let cursor = 0;

  async function readBranches() {
    while (cursor < selectedBranches.length) {
      const index = cursor++;
      branches[index] = await inspectBranch(selectedBranches[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(16, selectedBranches.length) }, () =>
      readBranches(),
    ),
  );

  return { path: repo, base, baseRef, branches, worktrees };
}

export async function inspectSidebarRepo(repo: string) {
  const [refs, records, origin] = await Promise.all([
    localBranchRefs(repo),
    worktreeRecords(repo),
    originBaseline(repo),
  ]);

  const { base, baseRef } = comparisonBaseline(
    refs,
    records[0]?.branch,
    origin ?? localBaseline(refs.map(({ name }) => name)),
  );

  const baseSha = baseRef
    ? await revision(repo, baseRef).catch(() => null)
    : null;

  const counts = new Map<string, Promise<number | null>>();

  function ahead(head: string) {
    if (!baseSha) return Promise.resolve(null);

    if (head === baseSha) return Promise.resolve(0);
    let count = counts.get(head);

    if (!count) {
      count = git(repo, ["rev-list", "--count", `${baseSha}..${head}`]).then(
        (value) => Number(value.trim()),
      );
      counts.set(head, count);
    }

    return count;
  }

  const worktrees = await Promise.all(
    records.map(async (w) => {
      let dirtyFiles: string[] = [];
      let count: number | null = null;
      let error: string | null = null;

      try {
        if (w.bare || w.missing)
          throw new Error(
            w.bare ? "Bare repository" : "Worktree directory is missing",
          );
        dirtyFiles = statusFiles(
          await git(w.path, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ]),
        );
        count = await ahead(w.head);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }

      return {
        path: w.path,
        head: w.head,
        branch: w.branch,
        dirty: dirtyFiles.length > 0,
        dirtyFiles,
        ahead: count,
        error,
      };
    }),
  );

  const branches = await Promise.all(
    refs.map(async ({ name, head }) => ({
      name,
      head,
      ahead: await ahead(head),
      worktrees: worktrees.flatMap((w) => (w.branch === name ? [w.path] : [])),
    })),
  );

  return { path: repo, base, branches, worktrees };
}

export type SidebarRepo = Awaited<ReturnType<typeof inspectSidebarRepo>>;

export type Repo = Awaited<ReturnType<typeof inspectRepo>>;

async function measureRegisteredWorktrees(
  repo: string,
  records: readonly {
    path: string;
    bare: boolean;
    missing: boolean;
  }[],
  selectedPaths: readonly string[],
): Promise<
  {
    path: string;
    storage: WorktreeStorage;
  }[]
> {
  const selected = new Set(selectedPaths);

  for (const path of selected)
    if (!records.some((record) => record.path === path))
      throw new Error(
        "Storage selection must name a registered working folder",
      );

  if (!selected.size) return [];

  const commonDirectory = await gitCommonDirectory(repo);

  const selectedRecords = records.flatMap((record) =>
    selected.has(record.path) ? [record] : [],
  );

  return Promise.all(
    selectedRecords.map(async (record) => ({
      path: record.path,
      storage:
        record.bare || record.missing
          ? {
              status: "unavailable" as const,
              allocatedBytes: null,
              reclaimableBytes: null,
              measuredAt: new Date().toISOString(),
              error: record.bare
                ? "Bare repository has no working folder"
                : "Working folder is missing",
            }
          : await measureWorktreeStorage(record.path, [
              commonDirectory,
              ...records.flatMap((other) =>
                other.path !== record.path ? [other.path] : [],
              ),
            ]),
    })),
  );
}

export async function measureRepoWorktreeStorage(
  state: Repo,
  selectedPaths: readonly string[],
): Promise<Repo> {
  const sizes = new Map(
    (
      await measureRegisteredWorktrees(
        state.path,
        state.worktrees,
        selectedPaths,
      )
    ).map((item) => [item.path, item.storage]),
  );

  return {
    ...state,
    worktrees: state.worktrees.map((worktree) => ({
      ...worktree,
      storage: sizes.get(worktree.path) ?? worktree.storage,
    })),
  };
}

export async function inspectWorktreeStorage(repo: string) {
  const records = await worktreeRecords(repo);

  return measureRegisteredWorktrees(
    repo,
    records,
    records.map((record) => record.path),
  );
}

export async function purgeWorktree(
  repo: string,
  path: string,
  expectedHead: string,
  protectedPaths: string[],
  expectedBase?: string,
  chatTargets?: ReadonlySet<string>,
) {
  const state = await inspectTargets(
    repo,
    protectedPaths,
    false,
    {
      kind: "folder",
      name: path,
      measurement: { kind: "removal", head: expectedHead, base: expectedBase },
    },
    chatTargets,
  );

  const target = state.worktrees.find((w) => w.path === path);

  if (
    !target?.purgeReady ||
    target.head !== expectedHead ||
    (expectedBase && target.preserveIn !== expectedBase)
  )
    throw new Error(
      "Worktree changed or is protected. Refresh and review it again.",
    );
  await git(repo, ["worktree", "remove", "--", path]);
  invalidateWorktreeStorage(path);

  return { removed: true, freedBytes: target.storage.reclaimableBytes };
}

export async function deleteBranch(
  repo: string,
  name: string,
  expectedHead: string,
  expectedBase?: string,
  chatTargets?: ReadonlySet<string>,
) {
  const target = (
    await inspectTargets(repo, [], false, { kind: "branch", name }, chatTargets)
  ).branches.find((branch) => branch.name === name);

  const base = expectedBase ?? target?.deleteBase;

  if (
    !target?.deleteReady ||
    !base ||
    target.deleteBase !== base ||
    [base, "main", "master"].includes(name)
  )
    throw new Error("Branch is protected. Refresh and review it again.");

  const [refs, worktrees] = await Promise.all([
    localBranchRefs(repo),
    worktreeRecords(repo),
  ]);

  const branch = refs.find((ref) => ref.name === name);

  if (branch?.head !== expectedHead)
    throw new Error("Branch changed since confirmation");

  if (worktrees.some((w) => w.branch === name))
    throw new Error("Branch is still checked out in a working folder");

  if (
    chatWorktrees(worktrees, chatTargets).some(
      (w) => !w.branch && w.head === expectedHead,
    )
  )
    throw new Error("Branch is used by an open or protected chat");
  await git(repo, [
    "merge-base",
    "--is-ancestor",
    expectedHead,
    `refs/heads/${base}`,
  ]);
  await gitDeleteBranches(repo, [{ name, base, upstream: branch.upstream }]);

  return { removed: true };
}

function gitDeleteBranches(
  repo: string,
  branches: readonly {
    name: string;
    base: string;
    upstream: string;
  }[],
) {
  const config = branches.flatMap(({ name, base, upstream }) =>
    upstream
      ? []
      : [
          [`branch.${name}.remote`, "."],
          [`branch.${name}.merge`, `refs/heads/${base}`],
        ],
  );

  const gitEnvironment: NodeJS.ProcessEnv = {};

  if (config.length) {
    const first = Number(process.env.GIT_CONFIG_COUNT ?? 0);

    if (!Number.isSafeInteger(first) || first < 0)
      throw new Error("Cannot verify Git command configuration");

    for (const [index, [key, value]] of config.entries()) {
      gitEnvironment[`GIT_CONFIG_KEY_${first + index}`] = key;
      gitEnvironment[`GIT_CONFIG_VALUE_${first + index}`] = value;
    }

    gitEnvironment.GIT_CONFIG_COUNT = String(first + config.length);
  }

  return git(
    repo,
    ["branch", "-d", "--", ...branches.map(({ name }) => name)],
    undefined,
    gitEnvironment,
  );
}

export async function deleteBranches(
  repo: string,
  reviewed: readonly {
    target: string;
    head: string;
    base: string;
  }[],
  chatTargets?: ReadonlySet<string>,
) {
  const logRoot = (
    await git(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "logs/refs/heads",
    ])
  ).trim();

  const batch: BranchBatch = {
    kind: "branchBatch",
    bases: new Map(reviewed.map((item) => [item.target, item.base])),
    logRoot,
    reflogs: new Map(),
    upstreams: new Map(),
    retained: new Map(),
  };

  const state = await inspectTargets(repo, [], false, batch, chatTargets);

  const branches = new Map(
    state.branches.map((branch) => [branch.name, branch]),
  );

  const results = new Map<string, string | null>();

  const eligible = reviewed.filter((item) => {
    const branch = branches.get(item.target);

    if (
      branch?.deleteReady &&
      branch.head === item.head &&
      branch.deleteBase === item.base &&
      ![item.base, "main", "master"].includes(item.target)
    )
      return true;

    const reason = branch
      ? branch.head !== item.head
        ? "Branch tip changed since confirmation."
        : branch.reasons.join(". ") ||
          "Retained branch changed since confirmation."
      : "Branch no longer exists.";

    results.set(item.target, reason);

    return false;
  });

  for (let offset = 0; offset < eligible.length; offset += 64) {
    const items = eligible.slice(offset, offset + 64);

    const [refs, worktrees, histories] = await Promise.all([
      localBranchRefs(repo),
      worktreeRecords(repo),
      Promise.allSettled(
        items.map((item) => readGitMetadataAt(join(logRoot, item.target))),
      ),
    ]);

    const currentRefs = new Map(refs.map((ref) => [ref.name, ref]));

    const sameAnchors = [...batch.retained].every(
      ([name, head]) => currentRefs.get(name)?.head === head,
    );

    const checkedOut = new Set(worktrees.map((worktree) => worktree.branch));

    const chatHeads = new Set(
      chatWorktrees(worktrees, chatTargets)
        .filter((w) => !w.branch)
        .map((w) => w.head),
    );

    const deletions = items.flatMap((item, index) => {
      const log = histories[index];
      const ref = currentRefs.get(item.target);

      if (
        sameAnchors &&
        ref?.head === item.head &&
        ref.upstream === batch.upstreams.get(item.target) &&
        !checkedOut.has(item.target) &&
        !chatHeads.has(item.head) &&
        log.status === "fulfilled" &&
        log.value === batch.reflogs.get(item.target)
      )
        return [{ name: item.target, base: item.base, upstream: ref.upstream }];
      results.set(
        item.target,
        "Branch, upstream, retained base, or reflog changed during cleanup.",
      );

      return [];
    });

    if (!deletions.length) continue;

    try {
      await gitDeleteBranches(repo, deletions);

      for (const { name } of deletions) results.set(name, null);
    } catch {
      const remaining = new Set(
        (await localBranchRefs(repo)).map((ref) => ref.name),
      );

      for (const { name } of deletions)
        results.set(
          name,
          remaining.has(name) ? "Git refused to delete this branch." : null,
        );
    }
  }

  return results;
}

async function comparison(
  repo: string,
  target: string,
  base: string,
  mode: "working" | "branch",
) {
  const baseSha = await revision(repo, base);

  if (mode === "working") {
    if (!(await worktreeRecords(repo)).some((w) => w.path === target))
      throw new Error("Unknown worktree");

    return { cwd: target, args: [baseSha] };
  }

  const head = await revision(repo, `refs/heads/${target}`);
  const ancestor = (await git(repo, ["merge-base", baseSha, head])).trim();

  return { cwd: repo, args: [ancestor, head] };
}

export async function diffFiles(
  repo: string,
  target: string,
  base: string,
  mode: "working" | "branch",
) {
  const c = await comparison(repo, target, base, mode);

  const tracked = (
    await git(c.cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      ...c.args,
      "--",
    ])
  )
    .split("\0")
    .filter(Boolean);

  const untracked =
    mode === "working"
      ? (
          await git(target, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean)
      : [];

  return [...new Set([...tracked, ...untracked])];
}

export async function fileDiff(
  repo: string,
  target: string,
  base: string,
  mode: "working" | "branch",
  path: string,
) {
  const c = await comparison(repo, target, base, mode);

  if (!(await diffFiles(repo, target, base, mode)).includes(path))
    throw new Error("File is not part of this comparison");

  if (isAbsolute(path) || !isPathWithin(c.cwd, resolve(c.cwd, path)))
    throw new Error("Invalid file path");

  let patch = await git(c.cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    ...c.args,
    "--",
    path,
  ]);

  if (!patch && mode === "working") {
    try {
      patch = await git(c.cwd, [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        "/dev/null",
        path,
      ]);
    } catch (error) {
      const result = noIndexError.safeParse(error);

      if (!result.success || result.data.code !== 1) throw error;
      patch = result.data.stdout;
    }
  }

  return { patch };
}

import { z } from "zod";

const noIndexError = z.object({ code: z.literal(1), stdout: z.string() });

const missingFile = z.object({ code: z.literal("ENOENT") });
