import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import {
  findWorktreeForBranch,
  readDefaultBranchRefs,
  resolveDefaultBaseBranch,
  runGit,
} from "omnyo-environment-provider-host/git";

export type CopyBranchSelection =
  | { kind: "default" }
  | { kind: "named"; name: string };

export interface FileDigest {
  size: number;
  sha256: string;
}

export interface CopyRef {
  name: string;
  sha: string;
}

const UNSAVED_REF = "refs/omnyo/unsaved";

const FROM_ORIGIN_REF = "refs/omnyo/from-origin";

const SENT_REF = "refs/worktree/omnyo-sent";

const COMPARE_INDEX = "omnyo-compare-index";

const MAX_LISTED_CHANGES = 50;

const SEQUENCER_OPERATIONS = ["rebase", "merge", "cherry-pick", "revert", "am"];

const INCOMPLETE_HISTORY =
  "The step's commits build on history this copy does not have, so they cannot come back here.";

const WITHOUT_HOOKS = ["-c", "core.hooksPath=/dev/null"];

const STASH_ENTRY_PREFIX = "refs/omnyo/stash-entry/";

const KEEP_MARKER = "omnyo-temporary-copy";

const STALE_KEEP_MS = 60 * 60 * 1000;

const SYNTHETIC_IDENTITY = {
  GIT_AUTHOR_NAME: "Omnyo temporary copy",
  GIT_AUTHOR_EMAIL: "omnyo@localhost",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "Omnyo temporary copy",
  GIT_COMMITTER_EMAIL: "omnyo@localhost",
  GIT_COMMITTER_DATE: "@0 +0000",
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runGit(args, {
    cwd,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });

  return result.stdout.trim();
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const result = await runGit(args, { cwd, allowFailure: true });

  return result.exitCode === 0;
}

async function gitPipe(
  cwd: string,
  args: string[],
  io: {
    stdinText?: string;
    stdinFile?: string;
    stdoutFile?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string> {
  const child = spawn("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(io.env === undefined ? {} : { env: { ...process.env, ...io.env } }),
  });

  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr += text;
  });

  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code) => {
      if (code === 0) resolveExit();
      else
        rejectExit(
          new Error(
            `git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`,
          ),
        );
    });
  });

  const output =
    io.stdoutFile === undefined
      ? new Promise<void>((resolveOutput) => {
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (text: string) => {
            stdout += text;
          });
          child.stdout.on("end", () => resolveOutput());
        })
      : pipeline(child.stdout, createWriteStream(io.stdoutFile));

  const input =
    io.stdinFile !== undefined
      ? pipeline(createReadStream(io.stdinFile), child.stdin)
      : new Promise<void>((resolveInput) => {
          child.stdin.end(io.stdinText ?? "", () => resolveInput());
        });

  await Promise.all([exited, output, input]);

  return stdout;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

type RefIdentityScope =
  | { kind: "copy" }
  | { kind: "source"; threadId: string }
  | { kind: "origin-checkout" };

interface GitRefState extends CopyRef {
  objectType: string;
  symbolic: string;
}

function assertRefOwner(threadId: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(threadId))
    throw new Error("Invalid temporary-copy ref owner");
}

function isOwnedRef(
  name: string,
  scope: RefIdentityScope,
  oid?: string,
): boolean {
  if (scope.kind === "origin-checkout") return name === SENT_REF;

  if (scope.kind === "source") {
    assertRefOwner(scope.threadId);

    return name.startsWith(`refs/omnyo/temporary-copy/${scope.threadId}/`);
  }

  if (name === UNSAVED_REF || name === FROM_ORIGIN_REF) return true;

  const kept = /^refs\/omnyo\/from-origin@([0-9a-f]{12})$/u.exec(name)?.[1];

  if (kept !== undefined) {
    if (oid !== undefined && !oid.startsWith(kept))
      throw new Error("Invalid owned ref history");

    return true;
  }

  const stash = /^refs\/omnyo\/stash-entry\/([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(
    name,
  )?.[1];

  if (stash !== undefined) {
    if (oid !== undefined && oid !== stash)
      throw new Error("Invalid owned ref history");

    return true;
  }

  if (/^refs\/omnyo\/(?:stash-entry\/|unsaved\/|from-origin[\/@])/u.test(name))
    throw new Error("Invalid owned ref namespace");

  return false;
}

async function gitRefStates(cwd: string): Promise<GitRefState[]> {
  const output = await git(cwd, [
    "for-each-ref",
    "--format=%(objectname)%09%(refname)%09%(objecttype)%09%(symref)",
  ]);

  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, name, objectType, symbolic = "", ...extra] = line.split("\t");

      if (
        sha === undefined ||
        name === undefined ||
        objectType === undefined ||
        extra.length !== 0 ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)
      )
        throw new Error("Invalid Git ref metadata");

      return { sha, name, objectType, symbolic };
    });
}

async function validatedRefStates(
  cwd: string,
  scope: RefIdentityScope,
): Promise<GitRefState[]> {
  const refs = await gitRefStates(cwd);

  for (const ref of refs) {
    if (
      isOwnedRef(ref.name, scope, ref.sha) &&
      (ref.symbolic !== "" || ref.objectType !== "commit")
    )
      throw new Error(
        "Invalid or symbolic owned ref; existing refs were preserved",
      );
  }

  return refs;
}

export async function digestFile(file: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);

  return { size: (await stat(file)).size, sha256: hash.digest("hex") };
}

async function requireDigest(
  file: string,
  expected: FileDigest,
): Promise<void> {
  const actual = await digestFile(file);

  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error(
      "The copied pack does not match its checksum; nothing was changed.",
    );
  }
}

async function packObjectCount(file: string): Promise<number> {
  const handle = await open(file, "r");

  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);

    if (bytesRead < 12 || header.toString("latin1", 0, 4) !== "PACK") {
      throw new Error("The copied file is not a git pack.");
    }

    return header.readUInt32BE(8);
  } finally {
    await handle.close();
  }
}

async function indexPack(
  cwd: string,
  packFile: string,
  check: "--strict" | "--fsck-objects",
): Promise<string | null> {
  if ((await packObjectCount(packFile)) === 0) return null;

  const output = await gitPipe(
    cwd,
    ["index-pack", check, `--keep=${KEEP_MARKER}`, "--stdin"],
    { stdinFile: packFile },
  );

  const hash = /^keep\t([0-9a-f]+)$/mu.exec(output)?.[1];

  if (hash === undefined) return null;

  return join(await packDirectory(cwd), `pack-${hash}.keep`);
}

async function packDirectory(cwd: string): Promise<string> {
  return resolve(
    cwd,
    await git(cwd, ["rev-parse", "--git-path", "objects/pack"]),
  );
}

async function releaseKeep(keepFile: string | null): Promise<void> {
  if (keepFile !== null) await rm(keepFile, { force: true });
}

async function releaseStaleKeeps(cwd: string, now: number): Promise<void> {
  const directory = await packDirectory(cwd);
  let entries: string[];

  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".keep")) continue;
    const file = join(directory, entry);

    try {
      const [info, contents] = await Promise.all([
        stat(file),
        readFile(file, "utf8"),
      ]);

      if (
        contents.trim() === KEEP_MARKER &&
        now - info.mtimeMs > STALE_KEEP_MS
      ) {
        await rm(file, { force: true });
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export async function resolveBaseCommit(
  sourcePath: string,
  selection: CopyBranchSelection,
): Promise<string> {
  if (selection.kind === "named") {
    return git(sourcePath, [
      "rev-parse",
      "--verify",
      `${selection.name}^{commit}`,
    ]);
  }

  const refs = await readDefaultBranchRefs(sourcePath);

  const base =
    resolveDefaultBaseBranch({
      defaultBranch: refs.defaultBranch ?? null,
      defaultBranchRelation: refs.defaultBranchRelation ?? null,
      originDefaultBranch: refs.originDefaultBranch ?? null,
    }) ?? "HEAD";

  return git(sourcePath, ["rev-parse", "--verify", `${base}^{commit}`]);
}

export async function writeSnapshotPack(args: {
  sourcePath: string;
  commit: string;
  packFile: string;
}): Promise<FileDigest> {
  const tree = await git(args.sourcePath, [
    "rev-parse",
    `${args.commit}^{tree}`,
  ]);

  const listing = await gitPipe(
    args.sourcePath,
    ["ls-tree", "-r", "-t", args.commit],
    {},
  );

  const objects = listing
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const [type, sha] = (line.split("\t")[0] ?? "").split(" ").slice(1);

      return type === "commit" || sha === undefined ? [] : [sha];
    });

  await mkdir(dirname(args.packFile), { recursive: true });
  await gitPipe(args.sourcePath, ["pack-objects", "--stdout", "-q"], {
    stdinText: `${[args.commit, tree, ...objects].join("\n")}\n`,
    stdoutFile: args.packFile,
  });

  return digestFile(args.packFile);
}

export async function readChunk(
  file: string,
  offset: number,
  length: number,
): Promise<{ dataBase64: string; sha256: string }> {
  const handle = await open(file, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const chunk = buffer.subarray(0, bytesRead);

    return { dataBase64: chunk.toString("base64"), sha256: sha256(chunk) };
  } finally {
    await handle.close();
  }
}

export async function appendChunk(args: {
  file: string;
  offset: number;
  dataBase64: string;
  sha256: string;
}): Promise<void> {
  const chunk = Buffer.from(args.dataBase64, "base64");

  if (sha256(chunk) !== args.sha256) {
    throw new Error("A copied chunk does not match its checksum.");
  }

  await mkdir(dirname(args.file), { recursive: true });
  const handle = await open(args.file, args.offset === 0 ? "w" : "r+");

  try {
    await handle.truncate(args.offset);
    await handle.write(chunk, 0, chunk.length, args.offset);
  } finally {
    await handle.close();
  }
}

export async function materializeCopy(args: {
  packFile: string;
  digest: FileDigest;
  copyPath: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
}): Promise<void> {
  await requireDigest(args.packFile, args.digest);
  await mkdir(dirname(args.copyPath), { recursive: true });
  await mkdir(args.copyPath);

  try {
    await git(args.copyPath, ["init", "-q"]);

    const keepFile = await indexPack(
      args.copyPath,
      args.packFile,
      "--fsck-objects",
    );

    try {
      await writeFile(
        join(args.copyPath, ".git", "shallow"),
        `${args.baseCommit}\n`,
      );
      await git(args.copyPath, [
        "update-ref",
        `refs/heads/${args.baseRef}`,
        args.baseCommit,
      ]);
      await git(args.copyPath, [
        "update-ref",
        `refs/heads/${args.branch}`,
        args.baseCommit,
      ]);
    } finally {
      await releaseKeep(keepFile);
    }

    await git(args.copyPath, ["checkout", "-q", args.branch]);
  } catch (error) {
    await rm(args.copyPath, { recursive: true, force: true });
    throw error;
  }
}

export async function recordUnsavedWork(
  copyPath: string,
): Promise<string | null> {
  const entries = (
    await gitPipe(
      copyPath,
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      {},
    )
  )
    .split("\0")
    .filter((entry) => entry !== "");

  if (entries.length === 0) return null;

  const nested = entries
    .filter((entry) => entry.startsWith("?? ") && entry.endsWith("/"))
    .map((entry) => entry.slice(3, -1));

  if (nested.length > 0) {
    throw new Error(
      `Kept the temporary copy because it contains nested repositories it cannot preserve: ${nested.join(", ")}. Commit or move their work, then retry.`,
    );
  }

  const indexFile = join(copyPath, ".git", "omnyo-unsaved-index");
  const env = { GIT_INDEX_FILE: indexFile, ...SYNTHETIC_IDENTITY };

  await rm(`${indexFile}.lock`, { force: true });
  await rm(indexFile, { force: true });

  try {
    await git(copyPath, ["read-tree", "HEAD"], env);
    await git(copyPath, ["add", "-A"], env);
    const tree = await git(copyPath, ["write-tree"], env);

    const commit = await git(
      copyPath,
      [
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        "HEAD",
        "-m",
        "Unsaved work from a temporary copy",
      ],
      env,
    );

    await git(copyPath, ["update-ref", UNSAVED_REF, commit]);

    return commit;
  } finally {
    await rm(indexFile, { force: true });
  }
}

export async function listCopyRefs(
  copyPath: string,
  baseRef: string,
  baseCommit: string,
): Promise<CopyRef[]> {
  const states = await validatedRefStates(copyPath, { kind: "copy" });
  const refs: CopyRef[] = [];

  for (const ref of states) {
    const name = ref.name;

    if (name !== `refs/heads/${baseRef}` || ref.sha !== baseCommit)
      refs.push({ name, sha: ref.sha });
  }

  const newestStash = refs.find((ref) => ref.name === "refs/stash")?.sha;

  if (newestStash !== undefined) {
    const stashes = await git(copyPath, ["stash", "list", "--format=%H"]);

    for (const sha of new Set(stashes.split("\n"))) {
      if (sha === "" || sha === newestStash) continue;
      refs.push({ name: `${STASH_ENTRY_PREFIX}${sha}`, sha });
    }
  }

  const head = await runGit(["rev-parse", "--verify", "-q", "HEAD"], {
    cwd: copyPath,
    allowFailure: true,
  });

  if (head.exitCode === 0 && head.stdout.trim() !== "") {
    refs.push({ name: "HEAD", sha: head.stdout.trim() });
  }

  return refs;
}

export async function listSideRefShas(args: {
  sourcePath: string;
  threadId: string;
}): Promise<string[]> {
  const scope: RefIdentityScope = { kind: "source", threadId: args.threadId };
  const states = await validatedRefStates(args.sourcePath, scope);

  return [
    ...new Set(
      states
        .filter((ref) => isOwnedRef(ref.name, scope, ref.sha))
        .map((ref) => ref.sha),
    ),
  ];
}

export async function writeCopyBackPack(args: {
  copyPath: string;
  baseCommit: string;
  refs: readonly CopyRef[];
  haves: readonly string[];
  packFile: string;
}): Promise<FileDigest> {
  const tips = [...new Set(args.refs.map((ref) => ref.sha))];
  const haves = await presentCommits(args.copyPath, args.haves);
  await mkdir(dirname(args.packFile), { recursive: true });
  await gitPipe(args.copyPath, ["pack-objects", "--revs", "--stdout", "-q"], {
    stdinText: `${[...tips, ...[args.baseCommit, ...haves].map((sha) => `^${sha}`)].join("\n")}\n`,
    stdoutFile: args.packFile,
  });

  return digestFile(args.packFile);
}

async function presentCommits(
  cwd: string,
  shas: readonly string[],
): Promise<string[]> {
  if (shas.length === 0) return [];

  const output = await gitPipe(cwd, ["cat-file", "--batch-check"], {
    stdinText: `${shas.map((sha) => `${sha}^{commit}`).join("\n")}\n`,
  });

  return output
    .split("\n")
    .filter((line) => / commit \d+$/u.test(line))
    .map((line) => line.split(" ")[0] ?? "")
    .filter((sha) => sha !== "");
}

export function sideRefName(threadId: string, refName: string): string {
  const short =
    refName === "HEAD"
      ? "HEAD"
      : isOwnedRef(refName, { kind: "copy" })
        ? refName.slice("refs/omnyo/".length)
        : refName.startsWith("refs/")
          ? refName.slice("refs/".length)
          : refName;

  const leaf = short.replaceAll("%", "%25").replaceAll("/", "%2F");

  return `refs/omnyo/temporary-copy/${threadId}/${leaf}`;
}

async function readFirstLine(file: string): Promise<string | null> {
  try {
    return (await readFile(file, "utf8")).split("\n")[0]?.trim() ?? null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function branchBusy(sourcePath: string, branch: string) {
  if ((await findWorktreeForBranch(sourcePath, branch)) !== null) return true;

  const commonDir = resolve(
    sourcePath,
    await git(sourcePath, ["rev-parse", "--git-common-dir"]),
  );

  let linked: string[];

  try {
    linked = await readdir(join(commonDir, "worktrees"));
  } catch (error) {
    if (!isMissing(error)) throw error;
    linked = [];
  }

  const gitDirs = [
    commonDir,
    ...linked.map((name) => join(commonDir, "worktrees", name)),
  ];

  for (const gitDir of gitDirs) {
    for (const marker of ["rebase-merge", "rebase-apply"]) {
      const headName = await readFirstLine(join(gitDir, marker, "head-name"));

      if (headName === `refs/heads/${branch}`) return true;
    }
  }

  return false;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string) {
  return gitSucceeds(cwd, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
}

async function readRef(cwd: string, ref: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "-q", ref], {
    cwd,
    allowFailure: true,
  });

  return result.exitCode === 0 && result.stdout.trim() !== ""
    ? result.stdout.trim()
    : null;
}

async function writeSideRef(cwd: string, ref: string, sha: string) {
  const current = await readRef(cwd, ref);

  if (current === sha) return;

  if (current !== null && !(await isAncestor(cwd, current, sha))) {
    const kept = `${ref}@${current.slice(0, 12)}`;

    if ((await readRef(cwd, kept)) === null) {
      await git(cwd, ["update-ref", kept, current, ""]);
    }
  }

  await git(cwd, ["update-ref", ref, sha, current ?? ""]);
}

async function replaceRef(cwd: string, ref: string, sha: string) {
  const current = await readRef(cwd, ref);

  if (current !== sha) await git(cwd, ["update-ref", ref, sha, current ?? ""]);
}

export async function applyCopyBack(args: {
  sourcePath: string;
  packFile: string;
  digest: FileDigest;
  threadId: string;
  branch: string;
  baseCommit: string;
  refs: readonly CopyRef[];
}): Promise<{ sideRefs: CopyRef[]; branchUpdated: boolean }> {
  await requireDigest(args.packFile, args.digest);
  assertRefOwner(args.threadId);
  await releaseStaleKeeps(args.sourcePath, Date.now());
  const keepFile = await indexPack(args.sourcePath, args.packFile, "--strict");
  const sideRefs: CopyRef[] = [];

  try {
    for (const ref of args.refs) {
      await git(args.sourcePath, [
        "rev-list",
        "--objects",
        "--quiet",
        ref.sha,
        "--not",
        args.baseCommit,
      ]);
    }

    for (const ref of args.refs) {
      const name = sideRefName(args.threadId, ref.name);

      const write = ref.name === UNSAVED_REF ? replaceRef : writeSideRef;

      await write(args.sourcePath, name, ref.sha);
      sideRefs.push({ name, sha: ref.sha });
    }
  } finally {
    await releaseKeep(keepFile);
  }

  const tip = args.refs.find((ref) => ref.name === `refs/heads/${args.branch}`);
  let branchUpdated = false;

  if (tip !== undefined && !(await branchBusy(args.sourcePath, args.branch))) {
    const branchRef = `refs/heads/${args.branch}`;
    const current = await readRef(args.sourcePath, branchRef);

    if (current === tip.sha) {
      branchUpdated = true;
    } else if (
      current === null ||
      (await isAncestor(args.sourcePath, current, tip.sha))
    ) {
      branchUpdated = await gitSucceeds(args.sourcePath, [
        "update-ref",
        branchRef,
        tip.sha,
        current ?? "",
      ]);
    }
  }

  return { sideRefs, branchUpdated };
}

export async function confirmCopyBack(args: {
  sourcePath: string;
  threadId: string;
  baseCommit: string;
  refs: readonly CopyRef[];
}): Promise<boolean> {
  const states = await validatedRefStates(args.sourcePath, {
    kind: "source",
    threadId: args.threadId,
  });

  for (const ref of args.refs) {
    if (
      states.find((row) => row.name === sideRefName(args.threadId, ref.name))
        ?.sha !== ref.sha
    ) {
      return false;
    }

    if (
      !(await gitSucceeds(args.sourcePath, [
        "rev-list",
        "--objects",
        "--quiet",
        ref.sha,
        "--not",
        args.baseCommit,
      ]))
    ) {
      return false;
    }
  }

  return true;
}

export function copiesRoot(dataDir: string): string {
  return join(dataDir, "copies");
}

export function relayRoot(dataDir: string): string {
  return join(dataDir, "relay");
}

export function insideRoot(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));

  return (
    child !== "" &&
    !child.startsWith("..") &&
    !child.startsWith(sep) &&
    !isAbsolute(child)
  );
}

export function requireCopyPath(dataDir: string, path: string): void {
  if (!insideRoot(copiesRoot(dataDir), path)) {
    throw new Error(`Refusing to touch ${path}: it is not a temporary copy.`);
  }
}

export async function copyExists(args: {
  dataDir: string;
  path: string;
}): Promise<boolean> {
  requireCopyPath(args.dataDir, args.path);

  try {
    await stat(args.path);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function removeCopy(args: { dataDir: string; path: string }) {
  requireCopyPath(args.dataDir, args.path);
  await rm(args.path, { recursive: true, force: true });
}

export function originCheckoutsRoot(dataDir: string): string {
  return join(dataDir, "origin-checkouts");
}

function requireOriginCheckoutPath(dataDir: string, path: string): void {
  if (!insideRoot(originCheckoutsRoot(dataDir), path)) {
    throw new Error(
      `Refusing to touch ${path}: it is not a temporary copy's checkout.`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function originCheckoutPath(dataDir: string, threadId: string): string {
  const path = join(originCheckoutsRoot(dataDir), threadId);
  requireOriginCheckoutPath(dataDir, path);

  return path;
}

function lockReason(threadId: string): string {
  return `omnyo temporary copy ${threadId}`;
}

async function comparablePath(path: string): Promise<string> {
  for (const candidate of [path, dirname(path)]) {
    try {
      const real = await realpath(candidate);

      return candidate === path ? real : join(real, basename(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  return resolve(path);
}

async function findLinkedWorktree(
  sourcePath: string,
  path: string,
): Promise<{ head: string | null; locked: boolean } | null> {
  const target = await comparablePath(path);
  const listing = await git(sourcePath, ["worktree", "list", "--porcelain"]);

  for (const block of listing.split("\n\n")) {
    const lines = block.split("\n");

    const listed = lines
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);

    if (listed === undefined || (await comparablePath(listed)) !== target) {
      continue;
    }

    return {
      head:
        lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length) ??
        null,
      locked: lines.some(
        (line) => line === "locked" || line.startsWith("locked "),
      ),
    };
  }

  return null;
}

async function keepStepCommits(
  sourcePath: string,
  threadId: string,
  head: string | null,
): Promise<{ ref: string; added: boolean } | null> {
  if (head === null) return null;

  const holder = await git(sourcePath, [
    "for-each-ref",
    "--contains",
    head,
    "--count=1",
    "--format=%(refname)",
  ]);

  if (holder !== "") return { ref: holder, added: false };

  const ref = sideRefName(threadId, "origin-HEAD");
  await writeSideRef(sourcePath, ref, head);

  return { ref, added: true };
}

async function keepBeforeDiscarding(
  sourcePath: string,
  threadId: string,
  head: string | null,
): Promise<string | null> {
  const kept = await keepStepCommits(sourcePath, threadId, head);

  return kept?.added === true ? kept.ref : null;
}

export async function prepareOriginCheckout(args: {
  dataDir: string;
  sourcePath: string;
  threadId: string;
  head: string;
  unsaved: string | null;
}): Promise<{ path: string; kept: string | null }> {
  assertRefOwner(args.threadId);
  const path = originCheckoutPath(args.dataDir, args.threadId);
  const linked = await findLinkedWorktree(args.sourcePath, path);

  const kept = await keepBeforeDiscarding(
    args.sourcePath,
    args.threadId,
    linked?.head ?? null,
  );

  if (linked !== null && (await exists(join(path, ".git")))) {
    for (const operation of SEQUENCER_OPERATIONS) {
      await gitSucceeds(path, [...WITHOUT_HOOKS, operation, "--quit"]);
    }

    if (!linked.locked) {
      await git(args.sourcePath, [
        "worktree",
        "lock",
        "--reason",
        lockReason(args.threadId),
        path,
      ]);
    }
  } else {
    await rm(path, { recursive: true, force: true });
    await mkdir(originCheckoutsRoot(args.dataDir), { recursive: true });
    await git(args.sourcePath, [
      ...WITHOUT_HOOKS,
      "worktree",
      "add",
      "--force",
      "--force",
      "--lock",
      "--reason",
      lockReason(args.threadId),
      "--detach",
      "--quiet",
      path,
      args.head,
    ]);
  }

  await git(path, [...WITHOUT_HOOKS, "clean", "-fd", "--quiet"]);
  await git(path, [
    ...WITHOUT_HOOKS,
    "checkout",
    "--detach",
    "--force",
    "--quiet",
    args.unsaved ?? args.head,
  ]);

  if (args.unsaved !== null) {
    await git(path, [
      ...WITHOUT_HOOKS,
      "reset",
      "--mixed",
      "--quiet",
      args.head,
    ]);
  }

  await git(path, [
    ...WITHOUT_HOOKS,
    "update-ref",
    SENT_REF,
    args.unsaved ?? args.head,
  ]);

  return { path, kept };
}

function statusPaths(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";

    if (field.length < 4) continue;

    paths.push(field.slice(3));

    if (/^(?:[RC].|.[RC])/u.test(field)) index += 1;
  }

  return paths;
}

async function pathsDifferingFrom(
  cwd: string,
  treeish: string,
): Promise<string[]> {
  const gitPath = async (name: string) =>
    resolve(cwd, await git(cwd, ["rev-parse", "--git-path", name]));

  const indexFile = await gitPath(COMPARE_INDEX);
  const env = { GIT_INDEX_FILE: indexFile };

  await rm(`${indexFile}.lock`, { force: true });
  await copyFile(await gitPath("index"), indexFile);

  try {
    await git(cwd, ["read-tree", "--reset", "-i", treeish], env);
    await git(cwd, ["update-index", "-q", "--refresh"], env);

    const modified = await gitPipe(cwd, ["diff-files", "--name-only", "-z"], {
      env,
    });

    const added = await gitPipe(
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { env },
    );

    return `${modified}${added}`.split("\0").filter((path) => path !== "");
  } finally {
    await rm(indexFile, { force: true });
  }
}

async function leftoverChanges(path: string): Promise<string[]> {
  const uncommitted = statusPaths(
    await gitPipe(
      path,
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
      ],
      {},
    ),
  );

  const sent = (
    await validatedRefStates(path, { kind: "origin-checkout" })
  ).find((row) => row.name === SENT_REF)?.sha;

  if (uncommitted.length === 0 || sent === undefined) {
    return uncommitted.slice(0, MAX_LISTED_CHANGES);
  }

  const differing = await pathsDifferingFrom(path, sent);
  const differingFiles = new Set(differing);

  return uncommitted
    .filter((entry) =>
      entry.endsWith("/")
        ? differing.some((changed) => changed.startsWith(entry))
        : differingFiles.has(entry),
    )
    .slice(0, MAX_LISTED_CHANGES);
}

export async function readOriginCheckout(args: {
  dataDir: string;
  sourcePath: string;
  threadId: string;
  base: string;
}): Promise<{
  head: string;
  changes: string[];
  newCommits: boolean;
  keptAt: string | null;
} | null> {
  const path = originCheckoutPath(args.dataDir, args.threadId);
  const linked = await findLinkedWorktree(args.sourcePath, path);

  if (linked === null || linked.head === null) return null;

  assertRefOwner(args.threadId);

  const head = linked.head;
  const newCommits = !(await isAncestor(args.sourcePath, head, args.base));

  const kept = newCommits
    ? await keepStepCommits(args.sourcePath, args.threadId, head)
    : null;

  const changes = (await exists(join(path, ".git")))
    ? await leftoverChanges(path)
    : [];

  return { head, changes, newCommits, keptAt: kept?.ref ?? null };
}

export async function writeOriginPack(args: {
  sourcePath: string;
  tip: string;
  base: string;
  packFile: string;
}): Promise<FileDigest> {
  await mkdir(dirname(args.packFile), { recursive: true });
  await gitPipe(args.sourcePath, ["pack-objects", "--revs", "--stdout", "-q"], {
    stdinText: `${args.tip}\n^${args.base}\n`,
    stdoutFile: args.packFile,
  });

  return digestFile(args.packFile);
}

async function filesAlreadyMatch(cwd: string, tip: string): Promise<boolean> {
  const indexMatches =
    (await gitSucceeds(cwd, ["diff-index", "--cached", "--quiet", "HEAD"])) ||
    (await gitSucceeds(cwd, ["diff-index", "--cached", "--quiet", tip]));

  return indexMatches && (await pathsDifferingFrom(cwd, tip)).length === 0;
}

export async function applyOriginPack(args: {
  copyPath: string;
  packFile: string;
  digest: FileDigest;
  tip: string;
  expectedHead: string;
}): Promise<{ fastForwarded: boolean }> {
  await requireDigest(args.packFile, args.digest);

  const keepFile = await indexPack(
    args.copyPath,
    args.packFile,
    "--fsck-objects",
  );

  try {
    if (
      !(await gitSucceeds(args.copyPath, [
        "rev-list",
        "--objects",
        "--quiet",
        args.tip,
        "--not",
        "HEAD",
      ]))
    ) {
      throw new Error(INCOMPLETE_HISTORY);
    }

    const head = await git(args.copyPath, ["rev-parse", "HEAD"]);

    if (
      head === args.expectedHead &&
      (await isAncestor(args.copyPath, head, args.tip))
    ) {
      const merged = await gitSucceeds(args.copyPath, [
        ...WITHOUT_HOOKS,
        "merge",
        "--ff-only",
        "--quiet",
        args.tip,
      ]);

      if (merged && (await readRef(args.copyPath, "HEAD")) === args.tip) {
        return { fastForwarded: true };
      }

      if (await filesAlreadyMatch(args.copyPath, args.tip)) {
        await git(args.copyPath, [
          ...WITHOUT_HOOKS,
          "reset",
          "--mixed",
          "--quiet",
          args.tip,
        ]);

        return { fastForwarded: true };
      }
    }

    await writeSideRef(args.copyPath, FROM_ORIGIN_REF, args.tip);

    return { fastForwarded: false };
  } finally {
    await releaseKeep(keepFile);
  }
}

export async function removeOriginCheckout(args: {
  dataDir: string;
  sourcePath: string;
  threadId: string;
}): Promise<{ kept: string | null }> {
  assertRefOwner(args.threadId);
  const path = originCheckoutPath(args.dataDir, args.threadId);
  const linked = await findLinkedWorktree(args.sourcePath, path);

  const kept = await keepBeforeDiscarding(
    args.sourcePath,
    args.threadId,
    linked?.head ?? null,
  );

  if (linked !== null) {
    await git(args.sourcePath, [
      ...WITHOUT_HOOKS,
      "worktree",
      "remove",
      "--force",
      "--force",
      path,
    ]);
  }

  await rm(path, { recursive: true, force: true });

  return { kept };
}

export async function sweepRelay(
  dataDir: string,
  maxAgeMs: number,
  now: number,
) {
  const root = relayRoot(dataDir);
  let entries: string[];

  try {
    entries = await readdir(root);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".pack")) continue;
    const file = join(root, entry);

    try {
      const info = await stat(file);

      if (now - info.mtimeMs > maxAgeMs) await rm(file, { force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
