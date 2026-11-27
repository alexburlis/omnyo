import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, statfs } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { experimental_inspectDirectoryProcesses } from "@omnyo/plugin-sdk/host";
import { getGitCommonDir, runGit } from "omnyo-environment-provider-host/git";
import {
  findWorktreeEntry,
  parseWorktreeListPorcelain,
} from "./worktree-list.js";
import {
  loadHelper,
  sharePairs,
  supportsSharing,
  UnsupportedSharing,
  type FilePair,
  type Helper,
  type ShareCounts,
} from "./share-helper.js";

type Worktree = { sourcePath: string; path: string };

type SharingResult = ShareCounts & {
  status: "completed" | "unsupported";
  skippedWorktrees: { path: string; reason: string }[];
  volumeFreeBytesChange?: number | null;
};

type Candidate = { file: string; size: number; owner: string };

type Root = Worktree & { identity: string; repository: string };

const ignoredBuildPaths = [
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "target",
  ".build",
  "DerivedData",
  "SourcePackages",
  "Pods",
  "__pycache__",
  ".gradle",
].map((directory) => `:(glob)**/${directory}/**`);

const maxGitOutput = 128 * 1024 * 1024;

const noFollowAny = 0x20000000;

const available = () =>
  process.platform === "darwin" && Number.parseInt(release(), 10) >= 24;

const empty = (status: SharingResult["status"]): SharingResult => ({
  status,
  sharedFiles: 0,
  privateBytesReleased: 0,
  skippedFiles: 0,
  skippedWorktrees: [],
});

function names(value: string): string[] {
  return value
    .split("\0")
    .filter((name) => name !== "" && !name.includes("\uFFFD"));
}

function resolveInside(root: string, name: string): string | undefined {
  if (
    path.isAbsolute(name) ||
    name
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  )
    return;

  return path.join(root, name);
}

function gitRead(root: string, args: string[], signal?: AbortSignal) {
  return runGit(
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: root,
      signal,
      maxOutputBytes: maxGitOutput,
    },
  ).then((result) => result.stdout);
}

async function tracked(root: string, signal?: AbortSignal): Promise<string[]> {
  return names(
    await gitRead(root, ["ls-files", "--stage", "-z"], signal),
  ).flatMap((row) => {
    const sep = row.indexOf("\t");

    if (sep === -1 || !/^100(?:644|755) [0-9a-f]+ 0$/u.test(row.slice(0, sep)))
      return [];

    return [row.slice(sep + 1)];
  });
}

async function dirty(root: string, signal?: AbortSignal): Promise<Set<string>> {
  const diff = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-only",
    "-z",
    "--",
  ];

  const [cached, working] = await Promise.all([
    gitRead(root, ["diff", "--cached", ...diff], signal),
    gitRead(root, ["diff", ...diff], signal),
  ]);

  return new Set([...names(cached), ...names(working)]);
}

const fileAbsent = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" ||
    error.code === "ENOTDIR" ||
    error.code === "ELOOP");

async function isWorktreeDirectory(
  root: string,
  dir: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  if (dir === root) return true;
  const known = cache.get(dir);

  if (known !== undefined) return known;

  const validParent = await isWorktreeDirectory(root, path.dirname(dir), cache);

  let valid = false;

  if (validParent) {
    try {
      valid =
        (await lstat(dir)).isDirectory() &&
        !(await lstat(path.join(dir, ".git")).catch((error: unknown) => {
          if (!fileAbsent(error)) throw error;

          return null;
        }));
    } catch (error) {
      if (!fileAbsent(error)) throw error;
    }
  }

  cache.set(dir, valid);

  return valid;
}

async function readRoot(
  tree: Worktree,
  helper: Helper,
  signal?: AbortSignal,
): Promise<Root> {
  signal?.throwIfAborted();

  const [source, target] = await Promise.all([
    realpath(tree.sourcePath),
    realpath(tree.path),
  ]);

  const [registered, common, targetCommon, marker, folder, stage] =
    await Promise.all([
      gitRead(source, ["worktree", "list", "--porcelain", "-z"], signal),
      getGitCommonDir(source, { signal }).then((p) =>
        realpath(path.resolve(source, p)),
      ),
      getGitCommonDir(target, { signal }).then((p) =>
        realpath(path.resolve(target, p)),
      ),
      lstat(path.join(target, ".git"), { bigint: true }),
      lstat(target, { bigint: true }),
      stat(helper.staging, { bigint: true }),
    ]);

  const row = findWorktreeEntry(parseWorktreeListPorcelain(registered), target);

  if (
    !row ||
    row.isMain ||
    row.isBare ||
    row.locked ||
    row.prunable ||
    target === source ||
    common !== targetCommon ||
    !marker.isFile() ||
    !folder.isDirectory() ||
    Number(folder.uid) !== process.getuid?.()
  ) {
    throw new Error(
      "This checkout no longer identifies an eligible linked worktree.",
    );
  }

  if (
    folder.dev !== stage.dev ||
    !(await supportsSharing(helper, target, signal))
  ) {
    throw new Error(
      "This worktree and the sharing helper must be on the same supported APFS volume.",
    );
  }

  const consumers = await experimental_inspectDirectoryProcesses(
    target,
    signal,
  );

  if (consumers.kind !== "idle")
    throw new Error(
      consumers.kind === "busy"
        ? "This worktree is in use."
        : "Worktree activity could not be verified.",
    );

  return {
    path: target,
    sourcePath: source,
    repository: common,
    identity: [folder.dev, folder.ino, marker.ino, marker.ctimeNs].join("/"),
  };
}

async function inventory(
  root: Root,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const checkoutGitDir = (
    await gitRead(root.path, ["rev-parse", "--absolute-git-dir"], signal)
  ).trimEnd();

  const hasOutputReceipt = await lstat(
    path.join(checkoutGitDir, "omnyo-setup-outputs-v1"),
  )
    .then(() => true)
    .catch((error: unknown) => {
      if (!fileAbsent(error)) throw error;

      return false;
    });

  const [files, ignored, edits] = await Promise.all([
    tracked(root.path, signal),
    hasOutputReceipt
      ? ""
      : gitRead(
          root.path,
          [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
            ...ignoredBuildPaths,
          ],
          signal,
        ),
    dirty(root.path, signal),
  ]);

  const folders = new Map<string, boolean>();
  const candidates: Candidate[] = [];

  for (const name of [...files, ...names(ignored)]) {
    signal?.throwIfAborted();
    const file = resolveInside(root.path, name);

    if (
      !file ||
      edits.has(name) ||
      !(await isWorktreeDirectory(root.path, path.dirname(file), folders))
    )
      continue;

    const info = await lstat(file).catch((error: unknown) => {
      if (!fileAbsent(error)) throw error;

      return null;
    });

    if (
      info?.isFile() &&
      info.size > 0 &&
      info.blocks > 0 &&
      info.nlink === 1 &&
      info.uid === process.getuid?.()
    ) {
      candidates.push({ file, size: info.size, owner: root.path });
    }
  }

  return candidates;
}

async function contentDigest(
  candidate: Candidate,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const fd = await open(
    candidate.file,
    constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny,
  ).catch((error: unknown) => {
    if (!fileAbsent(error)) throw error;

    return null;
  });

  if (!fd) return;

  try {
    const info = await fd.stat();

    if (
      !info.isFile() ||
      info.size !== candidate.size ||
      info.blocks === 0 ||
      info.nlink !== 1
    )
      return;
    const digest = createHash("sha256");

    for await (const chunk of fd.createReadStream({ autoClose: false, signal }))
      digest.update(chunk);

    return digest.digest("hex");
  } finally {
    await fd.close();
  }
}

export async function shareFreshWorktree(args: {
  sourcePath: string;
  targetPath: string;
  dataDir: string;
  signal?: AbortSignal;
}): Promise<SharingResult> {
  if (!available()) return empty("unsupported");

  const [source, target, helper] = await Promise.all([
    realpath(args.sourcePath),
    realpath(args.targetPath),
    loadHelper(args.dataDir),
  ]);

  const [src, dst, stage, supported] = await Promise.all([
    stat(source),
    stat(target),
    stat(helper.staging),
    supportsSharing(helper, target, args.signal),
  ]);

  if (!supported || dst.dev !== stage.dev || src.dev !== dst.dev)
    return empty("unsupported");
  const files = await tracked(target, args.signal);

  async function* pairs(): AsyncGenerator<FilePair> {
    for (const name of files) {
      const donor = resolveInside(source, name);
      const copy = resolveInside(target, name);

      if (donor && copy) yield [donor, copy];
    }
  }

  try {
    return {
      ...empty("completed"),
      ...(await sharePairs(helper, pairs(), args.signal)),
    };
  } catch (error) {
    if (error instanceof UnsupportedSharing) return empty("unsupported");
    throw error;
  }
}

type ReclaimOptions = {
  worktrees: readonly Worktree[];
  dataDir: string;
  signal?: AbortSignal;
};

type VolumeObservation = { staging?: string; before: bigint | null };

async function volumeFreeBytes(staging: string): Promise<bigint | null> {
  try {
    const info = await statfs(staging, { bigint: true });

    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

export async function reclaimWorktreeStorage(
  args: ReclaimOptions,
): Promise<SharingResult> {
  const result = empty("completed");
  const volume: VolumeObservation = { before: null };
  let outcome = result;

  try {
    outcome = await reclaim(args, result, volume);
  } catch (error) {
    if (error instanceof UnsupportedSharing)
      outcome = { ...result, status: "unsupported" };
    else if (
      !(
        args.signal?.aborted &&
        error instanceof Error &&
        (error.name === "AbortError" ||
          error === args.signal.reason ||
          ("code" in error && error.code === "provision_cancelled"))
      )
    )
      throw error;
  } finally {
    if (volume.staging) {
      const after = await volumeFreeBytes(volume.staging);

      const change =
        volume.before === null || after === null
          ? null
          : Number(after - volume.before);

      outcome.volumeFreeBytesChange =
        change !== null && Number.isSafeInteger(change) ? change : null;
    }
  }

  return outcome;
}

async function reclaim(
  args: ReclaimOptions,
  result: SharingResult,
  volume: VolumeObservation,
): Promise<SharingResult> {
  if (!available()) return empty("unsupported");
  const helper = await loadHelper(args.dataDir);

  if (!(await supportsSharing(helper, helper.staging, args.signal)))
    return empty("unsupported");
  volume.staging = helper.staging;
  volume.before = await volumeFreeBytes(helper.staging);
  const roots = new Map<string, Root>();
  const sizes = new Map<number, Candidate[]>();

  for (const tree of args.worktrees) {
    try {
      const root = await readRoot(tree, helper, args.signal);

      if (roots.has(root.path)) continue;
      const files = await inventory(root, args.signal);
      roots.set(root.path, root);

      for (const candidate of files) {
        const group = sizes.get(candidate.size);

        if (group) group.push(candidate);
        else sizes.set(candidate.size, [candidate]);
      }
    } catch (error) {
      args.signal?.throwIfAborted();
      result.skippedWorktrees.push({
        path: tree.path,
        reason:
          error instanceof Error
            ? error.message
            : "Worktree inspection failed.",
      });
    }
  }

  const pairsByRoot = new Map<string, FilePair[]>();

  for (const candidates of sizes.values()) {
    if (candidates.length < 2) continue;
    const donors = new Map<string, string>();

    for (const candidate of candidates) {
      args.signal?.throwIfAborted();
      const hash = await contentDigest(candidate, args.signal);

      if (!hash) continue;
      const donor = donors.get(hash);

      if (!donor) {
        donors.set(hash, candidate.file);
        continue;
      }

      const group = pairsByRoot.get(candidate.owner);
      const pair: FilePair = [donor, candidate.file];

      if (group) group.push(pair);
      else pairsByRoot.set(candidate.owner, [pair]);
    }
  }

  for (const [owner, pairs] of pairsByRoot) {
    if (args.signal?.aborted) break;
    const expected = roots.get(owner)!;
    let edits: Set<string>;

    try {
      const actual = await readRoot(expected, helper, args.signal);

      if (
        actual.identity !== expected.identity ||
        actual.repository !== expected.repository
      )
        throw new Error("Worktree registration changed during the scan.");
      edits = await dirty(owner, args.signal);
    } catch (error) {
      if (args.signal?.aborted) break;
      result.skippedWorktrees.push({
        path: owner,
        reason:
          error instanceof Error
            ? error.message
            : "Worktree changed during the scan.",
      });
      continue;
    }

    async function* currentPairs(): AsyncGenerator<FilePair> {
      const folders = new Map<string, boolean>();
      let lastCheck = Date.now();

      for (const pair of pairs) {
        if (args.signal?.aborted) return;

        if (Date.now() - lastCheck >= 15_000) {
          try {
            const current = await readRoot(expected, helper, args.signal);

            if (
              current.identity !== expected.identity ||
              current.repository !== expected.repository
            )
              throw new Error("Worktree registration changed.");
            edits = await dirty(owner, args.signal);
          } catch (error) {
            if (!args.signal?.aborted)
              result.skippedWorktrees.push({
                path: owner,
                reason:
                  error instanceof Error
                    ? error.message
                    : "Could not verify worktree.",
              });

            return;
          }

          folders.clear();
          lastCheck = Date.now();
        }

        if (
          !edits.has(path.relative(owner, pair[1])) &&
          (await isWorktreeDirectory(owner, path.dirname(pair[1]), folders))
        )
          yield pair;
        else result.skippedFiles++;
      }
    }

    const counts = await sharePairs(helper, currentPairs(), args.signal);
    result.sharedFiles += counts.sharedFiles;
    result.privateBytesReleased += counts.privateBytesReleased;
    result.skippedFiles += counts.skippedFiles;
  }

  return result;
}
