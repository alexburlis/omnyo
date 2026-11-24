import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostDaemonCommandRegistry } from "@omnyo/host-daemon-contract";
import { executeReadonlyFilesystemCommand } from "../../src/workspace-read-rpc.js";
import {
  cleanupTempDirs,
  makeTempDir,
  runGitCommand,
} from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

it("reads a real nested repository and refuses a symlink outside its workspace", async () => {
  const root = await fs.realpath(await makeTempDir("omnyo-nested-activity-"));
  const repo = path.join(root, "project");
  await fs.mkdir(repo);
  await runGitCommand(["init", "-b", "main"], { cwd: repo });
  const startedAt = Date.now() - 1_000;
  await runGitCommand(
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Nested activity",
    ],
    { cwd: repo },
  );

  const command = hostDaemonCommandRegistry[
    "workspace.gitActivity"
  ].schema.parse({
    type: "workspace.gitActivity",
    environmentId: "env-test",
    workspaceContext: { workspacePath: root },
    repositoryPath: repo,
    windows: [{ startMs: startedAt, endMs: Date.now() + 1_000 }],
    maxCommits: 10,
    maxPushes: 10,
  });

  const result = await executeReadonlyFilesystemCommand(command, undefined);
  expect(result).toMatchObject({
    outcome: "available",
    activity: {
      commits: [expect.objectContaining({ subject: "Nested activity" })],
    },
  });
  const outside = await makeTempDir("omnyo-outside-activity-");
  const link = path.join(root, "outside-link");
  await fs.symlink(outside, link);
  await expect(
    executeReadonlyFilesystemCommand(
      { ...command, repositoryPath: link },
      undefined,
    ),
  ).rejects.toThrow("Repository is outside the workspace");
});
