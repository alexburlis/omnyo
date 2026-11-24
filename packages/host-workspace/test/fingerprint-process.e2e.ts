import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.js";

const root = await mkdtemp(path.join(os.tmpdir(), "omnyo-fingerprint-proof-"));

const observations: Array<{
  state: string;
  starts: number;
  commands: string[][];
}> = [];

const exec = promisify(execFile);

const git = async (args: string[], cwd = root) =>
  (await exec("git", args, { cwd, encoding: "utf8" })).stdout;

async function measured(state: string, operation: () => Promise<unknown>) {
  const trace = path.join(root, ".git", `${state}.jsonl`);
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  let result: unknown;

  try {
    result = await operation();
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }

  const events = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const commands = events
    .filter((event) => event.event === "start")
    .map((event) => event.argv);

  observations.push({ state, starts: commands.length, commands });

  return result;
}

try {
  await git(["init", "-b", "main"]);
  const workspace = new Workspace(root);

  for (const state of ["unborn", "clean", "dirty", "detached"]) {
    if (state === "clean") {
      await writeFile(path.join(root, "tracked.txt"), "initial\n");
      await git(["add", "tracked.txt"]);
      await git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture",
      ]);
    }

    if (state === "dirty") {
      await writeFile(path.join(root, "tracked.txt"), "changed\n");
      await writeFile(path.join(root, "untracked.txt"), "new\n");
    }

    if (state === "detached") await git(["checkout", "--detach", "HEAD"]);

    const headSha =
      state === "unborn" ? null : (await git(["rev-parse", "HEAD"])).trim();

    const porcelain = await git([
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--branch",
      "--untracked-files=normal",
    ]);

    const actual = await measured(state, () =>
      workspace.getLocalStateFingerprint(),
    );

    assert.equal(
      actual,
      JSON.stringify({ headSha, porcelain }),
      `${state} fingerprint bytes`,
    );
  }

  assert.equal(
    await workspace.getHeadSha(),
    (await git(["rev-parse", "HEAD"])).trim(),
  );

  const invalid = await mkdtemp(
    path.join(os.tmpdir(), "omnyo-fingerprint-invalid-"),
  );

  try {
    await assert.rejects(new Workspace(invalid).getLocalStateFingerprint(), {
      code: "not_git_repo",
    });
  } finally {
    await rm(invalid, { recursive: true, force: true });
  }

  const violations = observations.filter((item) => item.starts > 3);
  process.stdout.write(
    JSON.stringify({
      observations,
      byteContractsPassed: true,
      maximumStarts: 3,
      pass: violations.length === 0,
    }) + "\n",
  );
  assert.equal(
    violations.length,
    0,
    "fresh fingerprint must launch at most three Git processes",
  );
} finally {
  await rm(root, { recursive: true, force: true });
  await assert.rejects(readFile(root), { code: "ENOENT" });
}
