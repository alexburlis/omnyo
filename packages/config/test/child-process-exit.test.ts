import { spawnPortableProcess } from "@omnyo/process-utils";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { waitForProcessExit } from "../src/child-process-exit.js";

it("rejects when a child process cannot start", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omnyo-process-start-failure-"));

  try {
    const command = join(directory, "missing-command");

    const childProcess = spawnPortableProcess({
      command,
      args: [],
      stdio: "ignore",
    });

    const observedSpawnError = once(childProcess, "error");

    await Promise.all([
      observedSpawnError,
      expect(waitForProcessExit(childProcess)).rejects.toMatchObject({
        code: "ENOENT",
        path: command,
      }),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 2_000);
