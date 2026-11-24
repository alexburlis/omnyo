import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const cliEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "index.ts",
);

describe("packaged CLI data dir", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "omnyo-cli-data-dir-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function runCli(args: string[]) {
    return execFileAsync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", cliEntry, ...args],
      {
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
        timeout: 10_000,
      },
    );
  }

  it("starts in an agent shell that sets neither NODE_ENV nor OMNYO_DATA_DIR", async () => {
    const version = await runCli(["--version"]);

    expect(version.stdout.trim()).not.toBe("");

    const admitted = await runCli(["diagnostics", "--help"]);

    expect(admitted.stdout).toContain("Usage: omnyo diagnostics");
  });
});
