import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { listProcessesWithCwdUnder } from "@omnyo/process-utils";
import { Workspace } from "../src/workspace.js";
import {
  getCheckoutRef,
  readDefaultBranch,
  readMergeBaseRef,
  runGit,
} from "../src/git.js";

const exec = promisify(execFile);

const scratch = await mkdtemp(
  path.join(tmpdir(), "omnyo-status-process-proof-"),
);

const shellPath = process.env.PATH;

const iterations = Number.parseInt(process.argv[2] ?? "15", 10);

assert.ok(iterations > 0);

const realRepo = process.argv[3];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = async (cwd: string, args: string[]) =>
  (await exec("git", args, { cwd, env: gitEnv, encoding: "utf8" })).stdout;

async function init(name: string) {
  const root = path.join(scratch, name);
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);

  return root;
}

async function commit(root: string, message: string) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

async function seeded(name: string) {
  const root = await init(name);
  await writeFile(path.join(root, "tracked.txt"), "first\nsecond\nthird\n");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await commit(root, "initial");

  return root;
}

function workspace(root: string) {
  return new Workspace(root, { shellPath });
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);

  return {
    minimum: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
    ],
    maximum: sorted[sorted.length - 1],
  };
}

type Observation = {
  label: string;
  output: Awaited<ReturnType<Workspace["getStatus"]>>;
  commands: string[][];
  nativeGitStarts: number;
  validationStarts: number;
  samples: Array<{
    wallMs: number;
    traceElapsedMs: number;
  }>;
  wallMs: ReturnType<typeof summarize>;
};

const observations: Observation[] = [];

async function measured(
  label: string,
  root: string,
  options: Parameters<Workspace["getStatus"]>[0] = {},
  repeats = 1,
) {
  const samples: Observation["samples"] = [];
  let output: Observation["output"] | undefined;
  let commands: string[][] = [];
  let validationStarts = 0;
  const instance = workspace(root);

  for (let index = 0; index < repeats; index += 1) {
    const trace = path.join(scratch, `${label}-${index}.trace.jsonl`);
    const priorTrace = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    const start = performance.now();
    let actual: Observation["output"];

    try {
      actual = await instance.getStatus(options);
    } finally {
      if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = priorTrace;
    }

    const wallMs = performance.now() - start;

    if (output !== undefined && label !== "real-checkout-status")
      assert.deepEqual(actual, output, `${label} stays fresh and stable`);
    output = actual;

    const events: Array<{ event: string; argv?: string[]; t_abs?: number }> = (
      await readFile(trace, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const currentCommands = events
      .filter((event) => event.event === "start")
      .map((event) => event.argv ?? []);

    if (index !== 0)
      assert.deepEqual(
        currentCommands.map((args) => JSON.stringify(args)).sort(),
        commands.map((args) => JSON.stringify(args)).sort(),
        `${label} stable launch count`,
      );
    commands = currentCommands;
    validationStarts = commands.filter((args) =>
      args.includes("--is-inside-work-tree"),
    ).length;
    samples.push({
      wallMs,
      traceElapsedMs:
        events
          .filter((event) => event.event === "exit")
          .reduce((sum, event) => sum + (event.t_abs ?? 0), 0) * 1000,
    });
  }

  assert.ok(output);
  observations.push({
    label,
    output,
    commands,
    nativeGitStarts: commands.length,
    validationStarts,
    samples,
    wallMs: summarize(samples.map((sample) => sample.wallMs)),
  });

  return output;
}

try {
  const clean = await seeded("clean");
  const headSha = (await git(clean, ["rev-parse", "HEAD"])).trim();
  const cleanStatus = await measured("clean", clean);
  assert.deepEqual(cleanStatus, {
    workingTree: {
      hasUncommittedChanges: false,
      state: "clean",
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
      files: [],
    },
    branch: { currentBranch: "main", defaultBranch: "main" },
    checkout: { kind: "branch", branchName: "main", headSha },
    mergeBase: null,
  });

  await writeFile(path.join(clean, "tracked.txt"), "changed\n");
  await writeFile(path.join(clean, "untracked.txt"), "new\n");
  await writeFile(path.join(clean, "ignored.txt"), "ignored\n");
  const dirty = await measured("dirty", clean);
  assert.equal(dirty.workingTree.state, "dirty_uncommitted");
  assert.equal(dirty.workingTree.insertions, 1);
  assert.equal(dirty.workingTree.deletions, 3);
  assert.deepEqual(
    dirty.workingTree.files.map((file) => file.path),
    ["tracked.txt", "untracked.txt"],
  );
  await writeFile(path.join(clean, "later.txt"), "later\n");
  assert.ok(
    (await workspace(clean).getStatus()).workingTree.files.some(
      (file) => file.path === "later.txt",
    ),
  );
  await git(clean, ["checkout", "--detach", "HEAD"]);
  const detached = await measured("detached", clean);
  assert.deepEqual(detached.checkout, { kind: "detached", headSha });
  assert.equal(detached.branch.currentBranch, null);

  const unborn = await init("unborn");
  await writeFile(path.join(unborn, "new.txt"), "one\ntwo\n");
  await git(unborn, ["add", "new.txt"]);
  const unbornStatus = await measured("unborn", unborn);
  assert.deepEqual(unbornStatus.checkout, {
    kind: "unborn",
    branchName: "main",
  });
  assert.deepEqual(unbornStatus.workingTree.files, [
    { path: "new.txt", status: "A", insertions: 2, deletions: 0 },
  ]);

  const rename = await seeded("rename");
  const unusual = 'renamed\t"雪\n.txt';
  await git(rename, ["mv", "tracked.txt", unusual]);
  await writeFile(path.join(rename, unusual), "first\nsecond\nthird\nfourth\n");
  const renameStatus = await measured("rename-unusual-path", rename);
  assert.deepEqual(renameStatus.workingTree.files, [
    { path: unusual, status: "R", insertions: 1, deletions: 0 },
  ]);

  const binary = await seeded("binary");
  await writeFile(path.join(binary, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await commit(binary, "binary");
  await writeFile(path.join(binary, "binary.dat"), Buffer.from([0, 4, 5, 6]));
  const binaryStatus = await measured("binary", binary);
  assert.deepEqual(binaryStatus.workingTree.files, [
    { path: "binary.dat", status: "M", insertions: null, deletions: null },
  ]);

  const conflict = await seeded("conflict");
  await git(conflict, ["checkout", "-b", "feature"]);
  await writeFile(path.join(conflict, "tracked.txt"), "feature\n");
  await commit(conflict, "feature");
  await git(conflict, ["checkout", "main"]);
  await writeFile(path.join(conflict, "tracked.txt"), "main\n");
  await commit(conflict, "main");
  await assert.rejects(git(conflict, ["merge", "feature"]));
  const conflictStatus = await measured("conflict", conflict);
  assert.ok(
    conflictStatus.workingTree.files.some(
      (file) => file.path === "tracked.txt" && file.status === "U",
    ),
  );

  const linkedParent = await seeded("linked-parent");
  const linked = path.join(scratch, "linked");
  await git(linkedParent, ["worktree", "add", "-b", "linked", linked, "main"]);
  const linkedStatus = await measured("linked", linked);
  assert.equal(linkedStatus.checkout.kind, "branch");
  assert.equal(linkedStatus.branch.currentBranch, "linked");
  assert.equal(linkedStatus.branch.defaultBranch, "main");

  const origin = await seeded("origin-head");
  await git(origin, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/missing",
  ]);
  const originStatus = await measured("dangling-origin-head", origin);
  assert.equal(originStatus.branch.defaultBranch, "missing");
  assert.equal(await readDefaultBranch(origin, { shellPath }), "missing");

  const submodule = await seeded("submodule");
  await seeded("sub-source");
  await git(submodule, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "../sub-source",
    "nested",
  ]);
  await commit(submodule, "submodule");
  await writeFile(
    path.join(submodule, "nested", "tracked.txt"),
    "modified submodule\n",
  );
  const subStatus = await measured("submodule-dirty", submodule);
  assert.ok(
    subStatus.workingTree.files.some(
      (file) => file.path === "nested" && file.status === "M",
    ),
  );

  const large = await init("representative");
  await mkdir(path.join(large, "tracked"));

  for (let index = 0; index < 2000; index += 1) {
    await writeFile(
      path.join(large, "tracked", `file-${index}.txt`),
      `file ${index}\n${"content\n".repeat(20)}`,
    );
  }

  await commit(large, "representative tracked fixture");
  await git(large, ["checkout", "-b", "feature"]);
  await writeFile(path.join(large, "feature.txt"), "committed feature\n");
  await commit(large, "feature");
  await writeFile(path.join(large, "tracked", "file-0.txt"), "dirty\n");
  await measured("representative-status", large, {}, iterations);

  const mergeStatus = await measured(
    "representative-mergebase",
    large,
    { mergeBaseBranch: "main" },
    iterations,
  );

  assert.equal(mergeStatus.mergeBase?.aheadCount, 1);
  assert.equal(mergeStatus.mergeBase?.behindCount, 0);
  assert.equal(mergeStatus.mergeBase?.hasCommittedUnmergedChanges, true);
  assert.deepEqual(
    mergeStatus.mergeBase?.files.map((file) => file.path),
    ["feature.txt"],
  );

  const missingBase = await measured("missing-mergebase", large, {
    mergeBaseBranch: "missing",
  });

  assert.equal(missingBase.mergeBase?.baseRef, null);
  assert.equal(missingBase.mergeBase?.aheadCount, 0);

  const invalid = path.join(scratch, "invalid");
  await mkdir(invalid);
  assert.deepEqual(await getCheckoutRef(invalid, { shellPath }), {
    kind: "unknown",
    reason: "Path is not a git repository",
  });
  await assert.rejects(readDefaultBranch(invalid, { shellPath }), {
    code: "not_git_repo",
  });
  await assert.rejects(readMergeBaseRef(invalid, "main", { shellPath }), {
    code: "not_git_repo",
  });
  await assert.rejects(workspace(invalid).getStatus(), {
    code: "not_git_repo",
  });
  await assert.rejects(workspace(path.join(scratch, "missing")).getStatus(), {
    code: "not_git_repo",
  });

  const bare = path.join(scratch, "bare");
  await git(scratch, ["clone", "--bare", large, bare]);
  const bareCheckout = await getCheckoutRef(bare, { shellPath });
  assert.equal(bareCheckout.kind, "branch");
  assert.equal(await readDefaultBranch(bare, { shellPath }), "main");
  assert.ok(await readMergeBaseRef(bare, "main", { shellPath }));
  await assert.rejects(workspace(bare).getStatus(), {
    code: "git_command_failed",
  });
  assert.equal(
    await readMergeBaseRef(large, "missing", { shellPath }),
    undefined,
  );
  await writeFile(path.join(large, ".git", "packed-refs.lock"), "");
  await assert.rejects(
    runGit(["-c", "core.packedRefsTimeout=10000", "pack-refs", "--all"], {
      cwd: large,
      shellPath,
      timeoutMs: 100,
      allowFailure: true,
    }),
    { code: "git_command_timeout" },
  );

  if (realRepo !== undefined) {
    await access(path.join(realRepo, ".git"));
    await measured("real-checkout-status", realRepo, {}, iterations);
  }

  const violations = observations.filter(
    (entry) => entry.validationStarts !== 1,
  );

  process.stdout.write(
    `${JSON.stringify({
      fixtureVersion: 1,
      gitVersion: (await git(scratch, ["--version"])).trim(),
      iterations,
      correctnessPassed: true,
      processMethod:
        "actual Git Trace2 process starts; t_abs is elapsed, not CPU",
      expectedValidationStarts: 1,
      pass: violations.length === 0,
      observations,
    })}\n`,
  );

  assert.equal(
    violations.length,
    0,
    "each status read must validate the repository exactly once",
  );
} catch (error) {
  console.error("Git status fixture failure before cleanup", error);
  throw error;
} finally {
  const deadline = performance.now() + 5_000;

  for (;;) {
    const remaining = await listProcessesWithCwdUnder({
      directories: [scratch],
    });

    if (remaining.length === 0) break;
    assert.ok(
      performance.now() < deadline,
      "Owned Git children must exit before fixture cleanup",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  await rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
  await assert.rejects(access(scratch), { code: "ENOENT" });
}
