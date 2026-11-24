import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandOf } from "../../src/command-dispatch-support.js";
import { afterEach, expect, it } from "vitest";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "../../src/command-dispatch.js";
import {
  cleanupTempDirs,
  createHarness,
  makeTempDir,
  runGitCommand,
} from "./dispatch-helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

async function createRepo(prefix: string): Promise<string> {
  const repo = await fs.realpath(await makeTempDir(prefix));
  await runGitCommand(["init", "-b", "main"], { cwd: repo });
  await fs.writeFile(path.join(repo, "tracked.txt"), "tracked\n");
  await runGitCommand(["add", "."], { cwd: repo });
  await runGitCommand(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial",
    ],
    { cwd: repo },
  );

  return repo;
}

async function createGitLog(): Promise<{ binDir: string; log: string }> {
  const realGit = (
    await execFileAsync("sh", ["-c", "command -v git"])
  ).stdout.trim();

  const binDir = await makeTempDir("omnyo-git-log-");
  const log = path.join(binDir, "git.log");
  await fs.writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh\nprintf '%s %s\\n' "$(pwd -P)" "$*" >> '${log}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );

  return { binDir, log };
}

async function countStatusScans(log: string, repo: string): Promise<number> {
  const lines = (await fs.readFile(log, "utf8").catch(() => "")).split("\n");

  return lines.filter((line) =>
    line.startsWith(`${repo} --no-optional-locks status --porcelain=v2`),
  ).length;
}

function statusCommand(
  environmentId: string,
  workspacePath: string,
): CommandOf<"workspace.status"> {
  return {
    type: "workspace.status",
    environmentId,
    workspaceContext: { workspacePath },
    maxFiles: 200,
    maxUntrackedLineStatFiles: 50,
    maxUntrackedLineStatBytes: 8 * 1024 * 1024,
  };
}

it.skipIf(process.platform === "win32")(
  "runs one git status per workspace for concurrent readers and rescans after a known change",
  async () => {
    const [shared, other, { binDir, log }] = await Promise.all([
      createRepo("omnyo-coalesced-shared-"),
      createRepo("omnyo-coalesced-other-"),
      createGitLog(),
    ]);

    const harness = createHarness({ workspacePath: shared });
    await harness.manager.replaceBaseShellEnv({
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    for (const [environmentId, workspacePath] of [
      ["env-a", shared],
      ["env-b", shared],
      ["env-c", other],
    ] as const) {
      await harness.manager.ensureEnvironment({ environmentId, workspacePath });
    }

    const reads = await Promise.all(
      [
        statusCommand("env-a", shared),
        statusCommand("env-b", shared),
        statusCommand("env-a", shared),
        statusCommand("env-b", shared),
        statusCommand("env-c", other),
        statusCommand("env-c", other),
      ].map((command) =>
        dispatchOnlineRpcCommand(command, harness.dispatchOptions()),
      ),
    );

    expect(reads.map((result) => result.outcome)).toEqual(
      Array.from({ length: 6 }, () => "available"),
    );
    expect(await countStatusScans(log, shared)).toBe(1);
    expect(await countStatusScans(log, other)).toBe(1);

    await fs.writeFile(path.join(shared, "added.txt"), "added\n");
    await dispatchCommand(
      {
        type: "workspace.commit",
        environmentId: "env-a",
        workspaceContext: { workspacePath: shared },
        message: "Commit message",
      },
      harness.dispatchOptions(),
    );

    const afterChange = await dispatchOnlineRpcCommand(
      statusCommand("env-b", shared),
      harness.dispatchOptions(),
    );

    if (afterChange.outcome !== "available") {
      throw new Error("Expected workspace status after the change");
    }

    expect(afterChange.workspaceStatus.workingTree.files).toEqual([
      expect.objectContaining({ path: "added.txt", status: "??" }),
    ]);
    expect(await countStatusScans(log, shared)).toBe(2);
  },
);

it.skipIf(process.platform === "win32")(
  "runs one git status for readers of a symlinked workspace and its target",
  async () => {
    const [repo, linkParent, { binDir, log }] = await Promise.all([
      createRepo("omnyo-coalesced-target-"),
      makeTempDir("omnyo-coalesced-link-"),
      createGitLog(),
    ]);

    const link = path.join(linkParent, "hardware");
    await fs.symlink(repo, link);

    const harness = createHarness({ workspacePath: repo });
    await harness.manager.replaceBaseShellEnv({
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    for (const [environmentId, workspacePath] of [
      ["env-link", link],
      ["env-real", repo],
    ] as const) {
      await harness.manager.ensureEnvironment({ environmentId, workspacePath });
    }

    const reads = await Promise.all(
      [
        statusCommand("env-link", link),
        statusCommand("env-real", repo),
        statusCommand("env-link", link),
        statusCommand("env-real", repo),
      ].map((command) =>
        dispatchOnlineRpcCommand(command, harness.dispatchOptions()),
      ),
    );

    expect(reads.map((result) => result.outcome)).toEqual(
      Array.from({ length: 4 }, () => "available"),
    );
    expect(await countStatusScans(log, repo)).toBe(1);

    await fs.writeFile(path.join(repo, "added.txt"), "added\n");
    await dispatchCommand(
      {
        type: "workspace.commit",
        environmentId: "env-link",
        workspaceContext: { workspacePath: link },
        message: "Commit message",
      },
      harness.dispatchOptions(),
    );

    const afterChange = await dispatchOnlineRpcCommand(
      statusCommand("env-real", repo),
      harness.dispatchOptions(),
    );

    if (afterChange.outcome !== "available") {
      throw new Error("Expected workspace status after the change");
    }

    expect(afterChange.workspaceStatus.workingTree.files).toEqual([
      expect.objectContaining({ path: "added.txt", status: "??" }),
    ]);
    expect(await countStatusScans(log, repo)).toBe(2);
  },
);
