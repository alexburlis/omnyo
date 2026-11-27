import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import entry from "../host";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("native host cancellation and process shutdown", () => {
  it("acknowledges stop only after the owned verifier child has closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentry-host-stop-test-"));

    const harness = experimental_createHostEntryHarness(entry, {
      experimental_paths: { dataDir: root, tempDir: root },
    });

    let pending: Promise<unknown> | null = null;

    try {
      git(root, "init", "-b", "main");
      git(root, "config", "commit.gpgsign", "false");
      git(root, "config", "user.name", "Sentry Test");
      git(root, "config", "user.email", "test@example.invalid");
      await writeFile(join(root, "code.txt"), "base\n");
      git(root, "add", "code.txt");
      git(root, "commit", "-m", "baseline");
      const baseSha = git(root, "rev-parse", "HEAD");
      await writeFile(join(root, "code.txt"), "repair\n");
      git(root, "add", "code.txt");
      git(root, "commit", "-m", "repair");
      const head = git(root, "rev-parse", "HEAD");
      const ready = join(root, ".git/verifier-ready");
      const closed = join(root, ".git/verifier-closed");
      const script = `const fs = require("node:fs"); process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(0); }, 250)); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`;
      pending = harness
        .experimental_call("verify", {
          runId: "run_stop",
          path: root,
          baseSha,
          head,
          changedFiles: ["code.txt"],
          checks: [
            {
              name: "Slow verifier",
              command: process.execPath,
              args: ["-e", script],
              timeoutMs: 10000,
            },
          ],
        })
        .catch((error) => error);
      await vi.waitFor(
        async () =>
          expect(
            await access(ready).then(
              () => true,
              () => false,
            ),
          ).toBe(true),
        { timeout: 3000, interval: 20 },
      );
      await harness.experimental_call("stop", { runId: "run_stop" });
      expect(await readFile(closed, "utf8")).toBe("closed");
    } finally {
      await harness.experimental_dispose();
      await pending;
      await rm(root, { recursive: true, force: true });
    }
  });
});
