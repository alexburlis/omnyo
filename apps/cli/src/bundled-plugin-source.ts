import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const BUNDLED_PLUGIN_SOURCE_PATH = "dist/omnyo-source.json";

const sourceIdentitySchema = z
  .object({
    schema: z.literal(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    path: z.string().min(1),
  })
  .strict();

export type BundledPluginSourceIdentity = z.infer<typeof sourceIdentitySchema>;

export type BundledPluginCandidateSource =
  | { kind: "unknown"; root: string }
  | { kind: "dirty"; root: string }
  | { kind: "clean"; root: string; repository: string; commit: string };

const fileMissing = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

const gitExit = z.object({ code: z.number(), stdout: z.string() });

async function git(repository: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 ** 2,
    });

    return { status: 0, stdout };
  } catch (cause) {
    const exit = gitExit.safeParse(cause);

    return exit.success
      ? { status: exit.data.code, stdout: exit.data.stdout }
      : { status: null, stdout: "" };
  }
}

async function gitOutput(repository: string, args: string[]) {
  const result = await git(repository, args);

  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed in ${repository}.`);

  return result.stdout;
}

export async function readBundledPluginCandidateSource(args: {
  directory: string;
  pluginName: string;
}): Promise<BundledPluginCandidateSource> {
  const nested = `plugins/${args.pluginName}`;
  const directory = await realpath(args.directory);
  const topLevel = await git(directory, ["rev-parse", "--show-toplevel"]);

  if (topLevel.status !== 0) return { kind: "unknown", root: nested };
  const repository = await realpath(topLevel.stdout.trim());

  const root = [nested, args.pluginName].find((candidate) => {
    const location = relative(join(repository, candidate), directory);

    return !(
      location === ".." ||
      location.startsWith(`..${sep}`) ||
      isAbsolute(location)
    );
  });

  if (root === undefined) return { kind: "unknown", root: nested };

  if (
    (await gitOutput(repository, ["status", "--porcelain", "--", root])).trim()
  )
    return { kind: "dirty", root };

  return {
    kind: "clean",
    root,
    repository,
    commit: (await gitOutput(repository, ["rev-parse", "HEAD"])).trim(),
  };
}

export function bundledPluginSourceIdentity(
  source: BundledPluginCandidateSource,
): BundledPluginSourceIdentity | null {
  return source.kind === "clean"
    ? { schema: 1, sourceCommit: source.commit, path: source.root }
    : null;
}

type ActiveIdentity =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; identity: BundledPluginSourceIdentity };

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readActiveIdentity(rootDir: string): Promise<ActiveIdentity> {
  const raw = await readFile(
    join(rootDir, BUNDLED_PLUGIN_SOURCE_PATH),
    "utf8",
  ).catch((cause: unknown) => {
    if (fileMissing.safeParse(cause).success) return null;
    throw cause;
  });

  if (raw === null) return { kind: "absent" };
  const parsed = sourceIdentitySchema.safeParse(parseJson(raw));

  return parsed.success
    ? { kind: "present", identity: parsed.data }
    : { kind: "invalid" };
}

async function commitExists(repository: string, commit: string) {
  const { status } = await git(repository, [
    "cat-file",
    "-e",
    `${commit}^{commit}`,
  ]);

  return status === 0;
}

async function isAncestor(
  repository: string,
  ancestor: string,
  descendant: string,
) {
  const { status } = await git(repository, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);

  if (status !== 0 && status !== 1)
    throw new Error(`git merge-base failed in ${repository}.`);

  return status === 0;
}

async function changedPaths(
  repository: string,
  from: string,
  to: string,
  root: string,
) {
  const output = await gitOutput(repository, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    from,
    to,
    "--",
    root,
  ]);

  return output.split("\0").filter(Boolean);
}

async function treeEntries(repository: string, commit: string, root: string) {
  const output = await gitOutput(repository, [
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    root,
  ]);

  return new Map(
    output
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");

        return [entry.slice(tab + 1), entry.slice(0, tab)] as const;
      }),
  );
}

function inPluginRoot(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

async function missingFromCandidate(args: {
  repository: string;
  candidate: string;
  overlay: string;
  baseline: string;
  root: string;
}) {
  const { repository, candidate, overlay, baseline, root } = args;

  const [paths, candidateTree, overlayTree] = await Promise.all([
    changedPaths(repository, baseline, overlay, root),
    treeEntries(repository, candidate, root),
    treeEntries(repository, overlay, root),
  ]);

  const uncovered = paths.filter(
    (path) => candidateTree.get(path) !== overlayTree.get(path),
  );

  if (uncovered.length === 0) return [];

  const merge = await git(repository, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "-z",
    `--merge-base=${baseline}`,
    candidate,
    overlay,
  ]);

  if (merge.status !== 0 && merge.status !== 1)
    throw new Error(`git merge-tree failed in ${repository}.`);
  const [merged, ...conflicted] = merge.stdout.split("\0").filter(Boolean);

  if (merged === undefined)
    throw new Error(`git merge-tree returned no tree in ${repository}.`);

  const conflictedInRoot = conflicted.filter((path) =>
    inPluginRoot(path, root),
  );

  const descendant =
    conflictedInRoot.length > 0 &&
    (await isAncestor(repository, overlay, candidate));

  const changed = await changedPaths(repository, candidate, merged, root);

  return [
    ...changed.filter((path) => !conflicted.includes(path)),
    ...conflictedInRoot.filter(
      (path) => !descendant || !candidateTree.has(path),
    ),
  ];
}

async function containmentBaseline(
  repository: string,
  candidate: string,
  overlay: string,
  packagedSourceCommit: string | null,
) {
  if (
    packagedSourceCommit !== null &&
    (await commitExists(repository, packagedSourceCommit)) &&
    (await isAncestor(repository, packagedSourceCommit, overlay))
  )
    return packagedSourceCommit;
  const mergeBase = await git(repository, ["merge-base", candidate, overlay]);

  return mergeBase.status === 0 ? mergeBase.stdout.trim() : null;
}

function releaseParts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);

  return match === null ? null : [match[1], match[2], match[3]].map(Number);
}

function isLowerVersion(candidate: string, installed: string) {
  const left = releaseParts(candidate);
  const right = releaseParts(installed);

  if (left === null || right === null) return false;

  for (const [index, part] of left.entries()) {
    if (part !== right[index]) return part < right[index];
  }

  return false;
}

export async function reviewBundledPluginReplacement(args: {
  source: BundledPluginCandidateSource;
  activeRootDir: string;
  installedVersion: string;
  candidateVersion: string;
  readPackagedSourceCommit: () => Promise<string | null>;
}): Promise<{ warning: string | null; refusal: string | null }> {
  const { source } = args;
  const active = await readActiveIdentity(args.activeRootDir);

  const warning =
    active.kind === "absent"
      ? "The installed artifact has no source identity, so Omnyo cannot check this candidate against it."
      : null;

  const refuse = (refusal: string) => ({ warning, refusal });

  if (isLowerVersion(args.candidateVersion, args.installedVersion))
    return refuse(
      `Candidate version ${args.candidateVersion} is lower than installed version ${args.installedVersion}.`,
    );

  if (source.kind === "dirty")
    return refuse(
      `${source.root} has uncommitted changes. Commit them, rebuild the runtime and retry.`,
    );

  if (active.kind === "absent") return { warning, refusal: null };

  if (active.kind === "invalid")
    return refuse("The installed artifact has an unreadable source identity.");
  const overlay = active.identity.sourceCommit;

  if (source.kind === "unknown")
    return refuse(
      `This runtime is not inside a checkout of ${source.root}, so Omnyo cannot check that it contains installed source ${overlay}.`,
    );

  if (!(await commitExists(source.repository, overlay)))
    return refuse(
      `Installed source ${overlay} is not in this repository. Fetch it, merge it into your candidate, rebuild the runtime and retry.`,
    );

  const baseline = await containmentBaseline(
    source.repository,
    source.commit,
    overlay,
    await args.readPackagedSourceCommit(),
  );

  const missing =
    baseline === null
      ? [source.root]
      : await missingFromCandidate({
          repository: source.repository,
          candidate: source.commit,
          overlay,
          baseline,
          root: source.root,
        });

  if (missing.length === 0) return { warning, refusal: null };
  const paths = missing.slice(0, 10).join(", ");

  return refuse(
    (await isAncestor(source.repository, overlay, source.commit))
      ? `This candidate removes work from installed source ${overlay} (${paths}). That commit is already in this candidate's history, so merging it changes nothing. Restore these paths unless they are your own change or you were explicitly told to remove them.`
      : `This candidate is missing installed source ${overlay} (${paths}). Merge that commit into your candidate, rebuild the runtime and retry.`,
  );
}

export async function requireBundledPluginOnMain(args: {
  source: BundledPluginCandidateSource;
  readPackagedSourceCommit: () => Promise<string | null>;
}) {
  const { source } = args;

  if (source.kind === "unknown")
    throw new Error(
      `This runtime is not inside a checkout of ${source.root}, so Omnyo cannot check that origin/main contains it. Build it from a checkout whose plugin source is already on origin/main.`,
    );

  if (source.kind === "dirty")
    throw new Error(
      `${source.root} has uncommitted changes. Commit them, land them on origin/main, rebuild the runtime and retry.`,
    );

  const fetched = await git(source.repository, [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);

  if (fetched.status !== 0)
    throw new Error(
      `Could not fetch origin/main in ${source.repository}. Publishing checks the candidate against a fresh origin/main; fix the fetch and retry.`,
    );

  const main = (
    await gitOutput(source.repository, [
      "rev-parse",
      "refs/remotes/origin/main^{commit}",
    ])
  ).trim();

  const packaged = await args.readPackagedSourceCommit();

  const baseline =
    packaged !== null && (await commitExists(source.repository, packaged))
      ? packaged
      : (
          await git(source.repository, ["merge-base", main, source.commit])
        ).stdout.trim() || null;

  const missing =
    baseline === null
      ? [source.root]
      : await missingFromCandidate({
          repository: source.repository,
          candidate: main,
          overlay: source.commit,
          baseline,
          root: source.root,
        });

  if (missing.length === 0) return;

  throw new Error(
    `origin/main (${main}) does not contain this candidate's ${source.root} changes from ${source.commit} (${missing.slice(0, 10).join(", ")}). Land them on main first, then rebuild and publish. A runtime release refuses any live plugin override that main lacks.`,
  );
}
