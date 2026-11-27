import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { hostContract } from "../contract";
import entry from "../host";
import { SentryRunner } from "../src/runner";
import { SentryStore } from "../src/store";
import { incident, route } from "./fixtures";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sentry-teardown-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const path = join(root, "worktree");
  await mkdir(source);
  git(source, "init", "-b", "main");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "config", "user.name", "Sentry Test");
  git(source, "config", "user.email", "test@example.invalid");
  await writeFile(join(source, "source.txt"), "base\n");
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  git(source, "add", "source.txt", ".gitignore");
  git(source, "commit", "-m", "baseline");
  const baseSha = git(source, "rev-parse", "HEAD");
  const branch = "sentry/teardown-fixture";
  git(source, "worktree", "add", "-b", branch, path, baseSha);
  await writeFile(join(path, "source.txt"), "repair\n");
  git(path, "add", "source.txt");
  git(path, "commit", "-m", "repair");
  const head = git(path, "rev-parse", "HEAD");

  const native = experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: root, tempDir: root },
  });

  cleanup.push(() => native.experimental_dispose());

  const host = createFakePluginHost({
    pluginId: "sentry",
    experimental_callHostRpc: (call) => {
      expect(call.method).toBe("removeWorktree");
      expect(call.input).toEqual({
        sourcePath: expect.any(String),
        path: expect.any(String),
        branch: expect.any(String),
      });

      return native.experimental_call(
        "removeWorktree",
        hostContract.removeWorktree.input.parse(call.input),
        { signal: call.signal },
      );
    },
  });

  cleanup.push(() => host.harness.lifecycle.dispose());
  const runner = new SentryRunner(host.api, async () => ({ apiOrigin: "https://de.sentry.io" }));
  cleanup.push(() => runner.dispose());
  const configured = runner.store.saveRoute({ ...route(), repositoryPath: source });
  runner.store.savePolicy({ projectId: configured.projectId, autoSolve: true, dailyLimit: 10 });
  const run = runner.store.enqueue(incident(), configured);
  runner.store.updateRun(run.id, {
    state: "needs-evidence",
    worktreePath: path,
    baseSha,
    branch,
    environmentKey: "owned-teardown",
  });
  runner.registerEnvironment();

  const provider =
    host.harness.inspection.registrations.environmentProviders.get("sentry-worktree");

  if (!provider) throw new Error("Sentry environment provider was not registered");

  const remove = () =>
    provider.remove({
      environment: null,
      hostId: configured.hostId,
      path,
      pathKey: "owned-teardown",
      resource: { runId: run.id, sourcePath: source, branch, baseSha },
      attempt: 1,
      report: { step() {}, log() {} },
      signal: new AbortController().signal,
    });

  const persisted = () => new SentryStore(host.api.storage).getRun(run.id);

  return {
    root,
    source,
    path,
    baseSha,
    branch,
    head,
    native,
    runner,
    run,
    remove,
    persisted,
    host,
  };
}

describe("owned worktree teardown preserves source independently of verification", () => {
  it.each(["post-verification evidence commit", "interrupted without verification"])(
    "removes a clean retained branch after %s and records its actual head",
    async (scenario) => {
      const f = await fixture();

      if (scenario === "post-verification evidence commit") {
        const verification = await f.native.experimental_call("verify", {
          runId: f.run.id,
          path: f.path,
          baseSha: f.baseSha,
          head: f.head,
          changedFiles: ["source.txt"],
          checks: [
            {
              name: "Fixture check",
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
              timeoutMs: 5000,
            },
          ],
        });

        f.runner.store.updateRun(f.run.id, { verification });
        await writeFile(join(f.path, "evidence.txt"), "verified evidence\n");
        git(f.path, "add", "evidence.txt");
        git(f.path, "commit", "-m", "record evidence after verification");
      }

      const preservedHead = git(f.path, "rev-parse", "HEAD");
      expect(f.persisted().verification?.head ?? null).toBe(
        scenario === "post-verification evidence commit" ? f.head : null,
      );
      expect(await f.remove()).toEqual({ status: "removed" });
      await expect(access(f.path)).rejects.toThrow();
      expect(git(f.source, "rev-parse", "refs/heads/" + f.branch)).toBe(preservedHead);
      expect(git(f.source, "show", preservedHead + ":source.txt")).toBe("repair");

      if (scenario === "post-verification evidence commit") {
        expect(preservedHead).not.toBe(f.head);
        expect(git(f.source, "show", preservedHead + ":evidence.txt")).toBe("verified evidence");
      }

      expect(f.persisted().preservedSha).toBe(preservedHead);
      expect(f.persisted().verification?.head ?? null).toBe(
        scenario === "post-verification evidence commit" ? f.head : null,
      );
      expect(await f.remove()).toEqual({ status: "removed" });
      expect(f.persisted().preservedSha).toBe(preservedHead);
    },
  );

  it.each(["tracked", "untracked", "ignored"])(
    "refuses removal while %s content exists and preserves its bytes",
    async (kind) => {
      const f = await fixture();
      const file = join(f.path, kind === "tracked" ? "source.txt" : kind + ".txt");
      await writeFile(file, "unique unsaved source\n");
      await expect(f.remove()).rejects.toThrow("uncommitted, untracked or ignored content");
      expect(await readFile(file, "utf8")).toBe("unique unsaved source\n");
      expect(git(f.source, "rev-parse", "refs/heads/" + f.branch)).toBe(f.head);
      expect(f.persisted().preservedSha ?? null).toBeNull();
    },
  );

  it("refuses removal when the retained branch no longer points at the worktree head", async () => {
    const f = await fixture();
    const mismatchedSource = join(f.root, "mismatched-source");
    git(f.root, "clone", "--no-local", f.source, mismatchedSource);
    git(mismatchedSource, "branch", f.branch, f.baseSha);
    f.runner.store.updateRun(f.run.id, {
      route: { ...f.run.route, repositoryPath: mismatchedSource },
    });
    await expect(f.remove()).rejects.toThrow("Unique source has not been preserved and recorded");
    await access(f.path);
    expect(git(f.path, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(mismatchedSource, "rev-parse", "refs/heads/" + f.branch)).toBe(f.baseSha);
    expect(f.persisted().preservedSha ?? null).toBeNull();
  });

  it("cleans only a workflow's recorded previous repository after a diagnosed handoff", async () => {
    const f = await fixture();
    const other = join(f.root, "next-source");
    git(f.root, "clone", "--no-local", f.source, other);
    f.host.api.storage
      .database()
      .prepare("INSERT INTO workflow_bindings VALUES (?,?)")
      .run(f.run.id, "{}");
    f.runner.store.updateRun(f.run.id, { route: { ...f.run.route, repositoryPath: other } });
    await expect(f.remove()).resolves.toEqual({ status: "removed" });
    await expect(access(f.path)).rejects.toThrow();
    expect(git(f.source, "rev-parse", "refs/heads/" + f.branch)).toBe(f.head);
    expect(git(other, "rev-parse", "HEAD")).toBe(f.baseSha);
  });

  it("refuses removal when the worktree has changed branch identity", async () => {
    const f = await fixture();
    git(f.path, "branch", "-m", "sentry/other-owner");
    await expect(f.remove()).rejects.toThrow("Worktree branch changed");
    expect(git(f.path, "branch", "--show-current")).toBe("sentry/other-owner");
    expect(git(f.path, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.persisted().preservedSha ?? null).toBeNull();
  });

  it("does not fabricate a preservation head when the worktree is already absent", async () => {
    const f = await fixture();
    git(f.source, "worktree", "remove", f.path);
    expect(await f.remove()).toEqual({ status: "removed" });
    expect(git(f.source, "rev-parse", "refs/heads/" + f.branch)).toBe(f.head);
    expect(f.persisted().preservedSha ?? null).toBeNull();
  });
});
