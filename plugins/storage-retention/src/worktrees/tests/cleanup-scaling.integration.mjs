import assert from "node:assert/strict";
import cp from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const benchmark = process.argv.includes("--benchmark");

const smoke = process.argv.includes("--smoke");

const retainedFoldersPerRepository = smoke ? 1 : 6;

const branchCounts = smoke
  ? [3, 3, 3, 3]
  : benchmark && !process.argv.includes("--balanced")
    ? [202, 9, 7, 3]
    : [23, 23, 23, 23];

const branchTotal = branchCounts.reduce((sum, count) => sum + count, 0);

const independentBranches =
  benchmark && !process.argv.includes("--single-anchor") ? 32 : 0;

const source =
  process.env.LOCAL_WORKTREES_TEST_SOURCE ??
  dirname(dirname(fileURLToPath(import.meta.url)));

const root = await realpath(
  await mkdtemp(join(tmpdir(), "worktrees-cleanup-scaling-")),
);

const nativeExec = cp.execFile;

const activeRepos = new Map();

const repoByPath = new Map();

const mutations = new Set();

let repositoryOverlap = false;

const statuses = [];

let activeNative = 0;

let maximumNative = 0;

let maximumRepos = 0;

let commands = 0;

let ancestryWalks = 0;

let measuring = false;

let receipt;

function observeGit(command, args, options, callback) {
  if (command !== "git" || !measuring)
    return nativeExec(command, args, options, callback);
  const cwd = args[args.indexOf("-C") + 1];
  const repo = repoByPath.get(cwd) ?? cwd;
  const mutating = args.includes("remove") || args.includes("-d");

  if (mutating) {
    if (mutations.has(repo)) repositoryOverlap = true;
    mutations.add(repo);
  }

  commands++;

  if (args.some((arg) => arg.startsWith("--merged="))) ancestryWalks++;
  activeNative++;
  maximumNative = Math.max(maximumNative, activeNative);
  activeRepos.set(repo, (activeRepos.get(repo) ?? 0) + 1);
  maximumRepos = Math.max(maximumRepos, activeRepos.size);

  if (args.includes("status")) statuses.push(cwd);

  return nativeExec(command, args, options, (cause, stdout, stderr) => {
    activeNative--;

    if (mutating) mutations.delete(repo);
    const remaining = activeRepos.get(repo) - 1;

    if (remaining) activeRepos.set(repo, remaining);
    else activeRepos.delete(repo);
    callback(cause, stdout, stderr);
  });
}

observeGit[promisify.custom] = (command, args, options) =>
  new Promise((success, failure) => {
    observeGit(command, args, options, (cause, stdout, stderr) =>
      cause ? failure(cause) : success({ stdout, stderr }),
    );
  });

const git = (cwd, ...args) =>
  cp
    .execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    })
    .trim();

async function writeReceipt() {
  const evidence = process.env.LOCAL_WORKTREES_EVIDENCE;

  if (!evidence || !receipt) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, "cleanup-scaling.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
}

try {
  const repos = [];
  const folders = [];
  const keep = [];
  const heads = [];

  for (let index = 0; index < 4; index++) {
    const repo = join(root, `repo-${index}`);
    cp.execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "tracked"), "retained source\n");
    git(repo, "add", "tracked");
    git(repo, "commit", "-m", "base");
    repos.push(repo);
    repoByPath.set(repo, repo);
    heads.push(git(repo, "rev-parse", "HEAD"));

    for (let branch = 0; branch < branchCounts[index]; branch++)
      git(repo, "branch", `finished-${branch}`);
    git(repo, "config", "remote.origin.url", ".");
    git(
      repo,
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    );

    const tracked = Array.from(
      { length: branchCounts[index] },
      (_, n) => `finished-${n}`,
    );

    cp.execFileSync("git", ["-C", repo, "update-ref", "--stdin"], {
      input: tracked
        .map((name) => `create refs/remotes/origin/${name} ${heads[index]}\n`)
        .join(""),
      stdio: ["pipe", "ignore", "pipe"],
    });
    await appendFile(
      join(repo, ".git", "config"),
      tracked
        .map(
          (name) =>
            `[branch "${name}"]\n\tremote = origin\n\tmerge = refs/heads/${name}\n`,
        )
        .join(""),
    );

    if (index === 0 && independentBranches) {
      const tree = git(repo, "rev-parse", "HEAD^{tree}");

      for (let branch = 0; branch < independentBranches; branch++) {
        const commit = git(
          repo,
          "commit-tree",
          tree,
          "-p",
          heads[index],
          "-m",
          `Unique ${branch}`,
        );

        git(repo, "branch", `unique-${branch}`, commit);
      }
    }

    if (index < 3) {
      const folder = join(root, `finished-${index}`);
      git(repo, "worktree", "add", folder, "finished-0");
      folders.push(folder);
      repoByPath.set(folder, repo);
    }

    for (
      let worktree = 0;
      worktree < retainedFoldersPerRepository;
      worktree++
    ) {
      const folder = join(root, `keep-${index}-${worktree}`);
      git(repo, "worktree", "add", "-b", `keep-${worktree}`, folder);
      await writeFile(
        join(folder, "unique-work"),
        `preserved ${index} ${worktree}\n`,
      );
      keep.push(folder);
      repoByPath.set(folder, repo);
    }
  }

  cp.execFile = observeGit;
  syncBuiltinESMExports();

  const { inspectRepo, deleteBranch } = await import(
    pathToFileURL(join(source, "git.ts")).href
  );

  const { planCleanup } = await import(
    pathToFileURL(join(source, "cleanup-plan.ts")).href
  );

  const { runCleanup } = await import(
    pathToFileURL(join(source, "cleanup.ts")).href
  );

  git(
    repos[0],
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/missing",
  );
  await assert.rejects(
    () => deleteBranch(repos[0], "finished-1", heads[0], "main"),
    "An unreadable configured baseline must still block cleanup",
  );
  git(repos[0], "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  const previewStart = performance.now();
  measuring = true;

  const entries = await Promise.all(
    repos.map(async (repo, index) => ({
      projectId: `project-${index}`,
      projectName: `Project ${index}`,
      repo: await inspectRepo(repo, keep, false),
    })),
  );

  const plan = planCleanup(entries);
  const previewMs = performance.now() - previewStart;
  measuring = false;
  const previewCommands = commands;
  const previewAncestryWalks = ancestryWalks;
  commands = 0;
  ancestryWalks = 0;
  maximumNative = 0;
  maximumRepos = 0;
  statuses.length = 0;
  assert.equal(plan.filter((item) => item.kind === "folder").length, 3);
  assert.equal(
    plan.filter((item) => item.kind === "branch").length,
    branchTotal,
  );
  const progress = [];
  let foldersBeforeBranches = true;
  const start = performance.now();
  measuring = true;

  const result = await runCleanup(
    plan,
    async (item) => {
      if (item.kind === "branch")
        for (const folder of folders)
          try {
            await access(folder);
            foldersBeforeBranches = false;
          } catch (cause) {
            if (cause.code !== "ENOENT") throw cause;
          }

      return keep;
    },
    (done) => {
      progress.push(done);
    },
  );

  const executionMs = performance.now() - start;
  measuring = false;
  assert.equal(result.skipped.length, 0);
  assert.equal(result.removed.length, plan.length);

  const reported = result.removed.map((item) => ({
    ...item,
    freedBytes: item.freedBytes !== null,
  }));

  const expected = plan.map((item) => ({
    ...item,
    freedBytes: item.kind === "folder",
  }));

  const order = (item) => JSON.stringify([item.repo, item.kind, item.target]);
  assert.deepEqual(
    [...reported].sort((a, b) => order(a).localeCompare(order(b))),
    [...expected].sort((a, b) => order(a).localeCompare(order(b))),
    "Every reviewed item is reported, with measured space only for folders",
  );
  assert.deepEqual(progress.slice(0, folders.length), [1, 2, 3]);
  assert.ok(
    progress.every((done, index) => !index || done > progress[index - 1]),
  );
  assert.equal(progress.at(-1), plan.length);
  assert.equal(foldersBeforeBranches, true);

  for (let index = 0; index < repos.length; index++) {
    assert.equal(git(repos[index], "rev-parse", "main"), heads[index]);
    assert.equal(git(repos[index], "branch", "--list", "finished-*"), "");
    assert.equal(
      git(repos[index], "branch", "--list", "keep-*").split("\n").length,
      retainedFoldersPerRepository,
    );
  }

  for (let index = 0; index < keep.length; index++)
    assert.match(
      await readFile(join(keep[index], "unique-work"), "utf8"),
      /^preserved /,
    );

  if (independentBranches)
    assert.equal(
      git(repos[0], "branch", "--list", "unique-*").split("\n").length,
      independentBranches,
    );
  assert.ok(maximumNative <= 8);
  assert.equal(activeNative, 0);
  receipt = {
    source,
    benchmark,
    smoke,
    items: plan.length,
    folders: folders.length,
    branches: branchTotal,
    independentBranches,
    unrelatedWorktrees: keep.length,
    commands,
    ancestryWalks,
    previewCommands,
    previewAncestryWalks,
    statusReads: statuses.length,
    unrelatedStatusReads: statuses.filter((path) => !folders.includes(path))
      .length,
    maximumNative,
    maximumRepos,
    repositoryOverlap,
    foldersBeforeBranches,
    previewMs: benchmark ? Math.round(previewMs) : null,
    executionMs: benchmark ? Math.round(executionMs) : null,
    preserved: true,
    passed: false,
  };
  await writeReceipt();

  if (!benchmark) {
    assert.equal(
      receipt.unrelatedStatusReads,
      0,
      "Cleanup must not scan unrelated working folders",
    );
    assert.ok(
      previewCommands <= 200,
      "Review must batch reflog paths and upstream refs",
    );
    assert.ok(
      ancestryWalks <= 8,
      "Cleanup must avoid a separate ancestry walk for each upstream",
    );
    assert.equal(
      progress.length,
      folders.length + repos.length,
      "One event per completed batch",
    );
    assert.ok(
      commands <= 120,
      "Cleanup must share Git ancestry checks across each repository",
    );
    assert.ok(
      maximumRepos > 1,
      "Independent repositories must make progress concurrently",
    );
    assert.equal(
      repositoryOverlap,
      false,
      "Each repository must mutate serially",
    );
    assert.deepEqual(
      reported,
      expected,
      "Reports must retain confirmation order",
    );
  }

  receipt.passed = true;
  console.log(JSON.stringify(receipt));
  await writeReceipt();
} finally {
  measuring = false;
  cp.execFile = nativeExec;
  syncBuiltinESMExports();
  assert.equal(
    activeNative,
    0,
    "Native children must finish before fixture removal",
  );
  await rm(root, { recursive: true, force: true });
  await assert.rejects(access(root));

  if (receipt) {
    receipt.storageCloseout = {
      scratch: root,
      removed: true,
      absenceVerified: true,
      activeNative,
    };
    await writeReceipt();
  }

  console.log("Cleanup scaling owned fixture removed and absence verified.");
}
