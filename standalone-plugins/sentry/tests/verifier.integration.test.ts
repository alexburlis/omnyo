import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { completionSchema, hostContract } from "../contract";
import entry from "../host";
import { GitHost } from "../src/git-host";
import { execute } from "../src/host-execution";
import { SentryRunner } from "../src/runner";
import { incident, route } from "./fixtures";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "sentry-verifier-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();

  git("init", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "Sentry Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, "code.txt"), "base\n");
  git("add", "code.txt");
  git("commit", "-m", "baseline");
  const baseSha = git("rev-parse", "HEAD");
  await writeFile(join(root, "code.txt"), "repair\n");
  git("add", "code.txt");
  git("commit", "-m", "repair");

  return { root, baseSha, head: git("rev-parse", "HEAD") };
}

function check(name: string, script: string, timeoutMs = 5000) {
  return { name, command: process.execPath, args: ["-e", script], timeoutMs };
}

const privateOutput = "PRIVATE_VERIFIER_SENTINEL sk_synthetic_not_a_credential";

const verboseBytes = 5 * 1024 * 1024;

const verbose = (exitCode: number) =>
  `process.stdout.write(Buffer.alloc(${verboseBytes}, 120), () => { process.stderr.write(${JSON.stringify(privateOutput)}, () => { process.exitCode = ${exitCode}; }); });`;

const timedOut = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);';

describe("real verifier process bounds and receipts", () => {
  it("binds a mistyped repair receipt to the single commit on its owned branch", async () => {
    const { root, baseSha, head } = await repository();

    const verify = (reported: string, branch: string) =>
      new GitHost().verify(
        root,
        baseSha,
        reported,
        ["code.txt"],
        [check("check", "process.exit(0)")],
        branch,
      );

    await expect(verify("f".repeat(40), "main")).resolves.toMatchObject({ head });
    await expect(verify(baseSha, "main")).rejects.toThrow();
    await expect(verify("f".repeat(40), "another")).rejects.toThrow();
  });

  it.each([0, 17])("drains uncaptured verbose output to genuine exit %s", async (exitCode) => {
    const result = await execute(
      process.execPath,
      ["-e", verbose(exitCode)],
      tmpdir(),
      5000,
      false,
    );

    expect(result).toMatchObject({
      exitCode,
      output: "",
      outputBytes: verboseBytes + Buffer.byteLength(privateOutput),
    });
    expect(result).not.toHaveProperty("termination");
    expect(JSON.stringify(result)).not.toContain(privateOutput);
  });

  it("retains the capture ceiling for commands whose output is consumed", async () => {
    await expect(
      execute(process.execPath, ["-e", verbose(0)], tmpdir(), 5000, true),
    ).rejects.toThrow("output bound");
  });

  it("preserves a natural signal instead of inventing an exit code", async () => {
    const result = await execute(
      process.execPath,
      ["-e", 'process.kill(process.pid, "SIGTERM")'],
      tmpdir(),
      5000,
      false,
    );

    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM", output: "" });
    expect(result).not.toHaveProperty("termination");
  });

  it("records its own timeout even when SIGTERM is handled with exit zero", async () => {
    const result = await execute(process.execPath, ["-e", timedOut], tmpdir(), 1000, false);
    expect(result).toMatchObject({ exitCode: 0, termination: "timeout", output: "" });
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
    expect(result.durationMs).toBeLessThan(4000);
  });

  it("bounds a child that ignores SIGTERM and retains the actual SIGKILL", async () => {
    const result = await execute(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      tmpdir(),
      1000,
      false,
    );

    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      termination: "timeout",
      output: "",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(2500);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("records an unavailable executable without retaining process output", async () => {
    const result = await execute(
      join(tmpdir(), "sentry-missing-executable-fixture"),
      [],
      tmpdir(),
      5000,
      false,
    );

    expect(result).toMatchObject({
      exitCode: null,
      termination: "spawn-error",
      output: "",
      outputBytes: 0,
    });
  });

  it.each(["local", "pr"] as const)(
    "retains failed host receipts and prevents %s delivery",
    async (delivery) => {
      const { root, baseSha, head } = await repository();

      const native = experimental_createHostEntryHarness(entry, {
        experimental_paths: { dataDir: root, tempDir: root },
      });

      cleanup.push(() => native.experimental_dispose());
      const third = join(root, ".git/third-check-ran");

      const configured = {
        ...route(),
        delivery,
        githubRepository: "fixture/example",
        repositoryPath: root,
        checks: [
          check("First", "process.exit(0)"),
          check("Verbose failure", verbose(17)),
          check("Never", `require("node:fs").writeFileSync(${JSON.stringify(third)}, "ran")`),
        ],
      };

      const host = createFakePluginHost({
        pluginId: "sentry",
        experimental_callHostRpc: (call) => {
          expect(call.method).toBe("verify");

          return native.experimental_call("verify", hostContract.verify.input.parse(call.input), {
            signal: call.signal,
          });
        },
      });

      cleanup.push(() => host.harness.lifecycle.dispose());

      const runner = new SentryRunner(host.api, async () => ({
        apiOrigin: "https://de.sentry.io",
      }));

      cleanup.push(() => runner.dispose());
      runner.store.savePolicy({ projectId: "proj_app", autoSolve: true, dailyLimit: 10 });
      const saved = runner.store.saveRoute(configured);
      const queued = runner.store.enqueue(incident(), saved);
      expect(runner.store.claimNext()?.id).toBe(queued.id);
      runner.store.updateRun(queued.id, {
        threadId: "thr_owned",
        state: "investigating",
        worktreePath: root,
        baseSha,
        branch: "sentry/fixture",
        verification: {
          head,
          tree: "b".repeat(40),
          changedFiles: ["code.txt"],
          checks: [{ name: "Old check", exitCode: 0, durationMs: 1, output: "" }],
        },
      });

      const proposal = completionSchema.parse({
        outcome: "fix-ready",
        classification: "Reproduced",
        summary: "Synthetic repair",
        rootCause: "Synthetic regression",
        change: "Synthetic source change",
        commit: head,
        changedFiles: ["code.txt"],
        reproduction: {
          command: "fixture",
          before: "failed",
          after: "passed",
          evidence: ["proof.log"],
        },
        checks: [{ name: "Forged worker receipt", exitCode: 0, durationMs: 1, output: "" }],
      });

      await expect(
        runner.finish("thr_owned", "proj_app", proposal, new AbortController().signal),
      ).rejects.toThrow("Completion did not pass");
      const retained = runner.store.getRun(queued.id);
      expect(retained.result?.checks).toMatchObject([
        { name: "First", exitCode: 0 },
        {
          name: "Verbose failure",
          exitCode: 17,
          outputBytes: verboseBytes + Buffer.byteLength(privateOutput),
        },
      ]);
      expect(retained.result?.checks[1]?.output).toContain("17");
      expect(
        JSON.stringify({
          result: retained.result,
          verification: retained.verification,
          reason: retained.reason,
        }),
      ).not.toContain(privateOutput);
      expect(retained.state).toBe("investigating");
      expect(retained.verification).toBeNull();
      expect(retained.publication).toBeNull();
      expect(runner.store.hasClaim(queued.id)).toBe(true);
      expect(
        await access(third).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(host.harness.experimental_hostRpcCalls.map((call) => call.method)).toEqual(["verify"]);
    },
  );

  it.each(["local", "pr"] as const)(
    "keeps a timed-out exit-zero check out of %s success",
    async (delivery) => {
      const { root, baseSha, head } = await repository();

      const native = experimental_createHostEntryHarness(entry, {
        experimental_paths: { dataDir: root, tempDir: root },
      });

      cleanup.push(() => native.experimental_dispose());

      const host = createFakePluginHost({
        pluginId: "sentry",
        experimental_callHostRpc: (call) =>
          native.experimental_call("verify", hostContract.verify.input.parse(call.input), {
            signal: call.signal,
          }),
      });

      cleanup.push(() => host.harness.lifecycle.dispose());

      const runner = new SentryRunner(host.api, async () => ({
        apiOrigin: "https://de.sentry.io",
      }));

      cleanup.push(() => runner.dispose());
      runner.store.savePolicy({ projectId: "proj_app", autoSolve: true, dailyLimit: 10 });

      const configured = runner.store.saveRoute({
        ...route(),
        delivery,
        githubRepository: "fixture/example",
        repositoryPath: root,
        checks: [check("Deadline", timedOut, 1000)],
      });

      const queued = runner.store.enqueue(incident(), configured);
      runner.store.claimNext();
      runner.store.updateRun(queued.id, {
        threadId: "thr_owned",
        state: "investigating",
        worktreePath: root,
        baseSha,
        branch: "sentry/fixture",
      });

      const proposal = completionSchema.parse({
        outcome: "fix-ready",
        classification: "Reproduced",
        summary: "Synthetic repair",
        rootCause: "Synthetic regression",
        commit: head,
        changedFiles: ["code.txt"],
        reproduction: {
          command: "fixture",
          before: "failed",
          after: "passed",
          evidence: ["proof.log"],
        },
      });

      await expect(
        runner.finish("thr_owned", "proj_app", proposal, new AbortController().signal),
      ).rejects.toThrow();
      const retained = runner.store.getRun(queued.id);
      expect(retained.result?.checks).toMatchObject([
        { name: "Deadline", exitCode: 0, termination: "timeout" },
      ]);
      expect(retained.state).toBe("investigating");
      expect(retained.verification).toBeNull();
      expect(retained.publication).toBeNull();
    },
  );
});
