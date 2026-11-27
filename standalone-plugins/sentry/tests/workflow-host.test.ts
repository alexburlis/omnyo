import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hostContract } from "../contract";
import { execute } from "../src/host-execution";
import { WorkflowHost } from "../src/workflow-host";

const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

function git(path: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: path,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type ReleaseReceipt = {
  status: string;
  sourceCommit?: string;
  phases?: Record<string, { status: string }>;
};

async function fixture(actions = [{ kind: "runtime" }], repository = "fixture/omnyo") {
  const root = await mkdtemp(join(tmpdir(), "sentry-workflow-host-"));
  scratch.push(root);
  const path = join(root, "source");
  await mkdir(path);
  git(path, "init", "-b", "sentry/run-fixture");
  git(path, "config", "commit.gpgsign", "false");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(
    join(path, "review.json"),
    JSON.stringify({ head: "fixture", verdict: "APPROVE" }),
  );
  await mkdir(join(path, "scripts"));
  await writeFile(
    join(path, "scripts/private-ship.json"),
    JSON.stringify({ outputDirectory: join(root, "releases") }),
  );
  git(path, "add", "review.json", "scripts/private-ship.json");
  git(path, "commit", "-m", "fixture");
  const head = git(path, "rev-parse", "HEAD");

  const merge = hostContract.workflowMerge.input.parse({
    runId: "run-fixture",
    path,
    repository,
    prNumber: 7,
    head,
    branch: "sentry/run-fixture",
    baseBranch: "main",
    review: { head, approved: true, evidencePath: "review.json" },
  });

  const plan = hostContract.workflowPlan.input.parse({
    runId: "run-fixture",
    path,
    repository,
    mergeCommit: head,
    baseCommit: head,
    changedFiles: ["apps/server/src/fix.ts"],
    selectionPath: null,
    nativeRequired: [],
  });

  const pull = {
    number: 7,
    url: `https://github.com/${repository}/pull/7`,
    headRefOid: head,
    headRefName: merge.branch,
    baseRefName: "main",
    body: "sentry-run:run-fixture",
    state: "OPEN",
    isDraft: true,
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  };

  const calls: string[][] = [];
  let checks: { name: string; bucket: string }[] | null = [{ name: "tests", bucket: "pass" }];
  let checksExit = 0;
  let merged = false;
  let loseMergeResponse = false;
  let loseDeliveryResponse = false;
  let installedVersion = "1.0.199";
  let installedCommit: string | null = null;
  let available: { version: string; commit: string } | null = null;
  const releasePath = join(root, "releases", "private-ship", "1.0.200", "no-ios", "receipt.json");

  const runner: typeof execute = async (program, args, cwd, timeout, capture, signal) => {
    if (program === "git") return execute(program, args, cwd, timeout, capture, signal);
    calls.push([program, ...args]);
    let output = "{}";
    let exitCode = 0;

    if (program === "gh") {
      if (args[1] === "view")
        output = JSON.stringify({
          ...pull,
          state: merged ? "MERGED" : "OPEN",
          mergeCommit: merged ? { oid: head } : null,
          statusCheckRollup: (checks ?? []).map(({ name }) => ({ __typename: "CheckRun", name })),
        });
      else if (args[1] === "checks") {
        output =
          checks === null
            ? "no checks reported on the 'sentry/run-fixture' branch"
            : JSON.stringify(checks);
        exitCode = checks === null ? 1 : checksExit;
      } else if (args[1] === "ready") pull.isDraft = false;
      else if (args[1] === "merge") {
        merged = true;

        if (loseMergeResponse) throw new Error("Response lost");
      }
    } else if (program === "pnpm" && args[0] === "private:plan") {
      output = JSON.stringify({
        status: "ready",
        sourceCommit: head,
        actions,
        unresolved: [],
      });
    } else if (program === "pnpm" && args[0] === "private:ship") {
      if (loseDeliveryResponse) throw new Error("Response lost");
      await mkdir(join(root, "releases", "private-ship", "1.0.200", "no-ios"), { recursive: true });
      await writeFile(releasePath, JSON.stringify({ status: "running" }));
      output = JSON.stringify({ status: "queued", version: "1.0.200", receipt: releasePath });
    } else if (program === "omnyo") {
      output = JSON.stringify({
        current: { version: installedVersion, commit: installedCommit },
        available,
      });
    } else if (program === "ps" || program === "env") {
      const pid = args[args.indexOf("-p") + 1];
      output = pid === String(process.pid) ? "fixture-start" : "";
      exitCode = pid === String(process.pid) ? 0 : 1;
    }

    return { exitCode, output, durationMs: 1, outputBytes: 1 };
  };

  return {
    path,
    head,
    merge,
    plan,
    calls,
    pull,
    runner,
    journalRoot: join(root, "journals"),
    root,
    releasePath,
    installed: (version: string) => {
      installedVersion = version;
      installedCommit = null;
      available = null;
    },
    publish: async (receipt: ReleaseReceipt = { status: "complete" }, commit = head) => {
      await mkdir(join(root, "releases", "private-ship", "1.0.200", "no-ios"), { recursive: true });
      await writeFile(releasePath, JSON.stringify({ sourceCommit: commit, ...receipt }));
      available = { version: "1.0.200", commit };
    },
    ticket: async (
      version: string,
      pid: number,
      receipt: ReleaseReceipt | null,
      mode: "ship" | "prepare" = "ship",
    ) => {
      const lane = join(root, "releases", "private-ship-lane", "tickets");
      const path = join(root, "releases", "private-ship", version, "no-ios", "receipt.json");
      await mkdir(lane, { recursive: true });
      await writeFile(
        join(lane, `000${version}.json`),
        JSON.stringify({
          jobId: `${version}-no-ios`,
          version,
          pid,
          processStart: "fixture-start",
          sequence: 1,
        }),
      );

      await mkdir(dirname(path), { recursive: true });
      await writeFile(join(dirname(path), "job.json"), JSON.stringify({ mode }));

      if (receipt) await writeFile(path, JSON.stringify(receipt));

      return path;
    },
    checks: (next: typeof checks, exit = 0) => {
      checks = next;
      checksExit = exit;
    },
    loseMerge: () => {
      loseMergeResponse = true;
    },
    loseDelivery: (lost = true) => {
      loseDeliveryResponse = lost;
    },
  };
}

describe("Sentry workflow host effects", () => {
  it.each(["sentry-run:run-fixture-other", "quoted sentry-run:run-fixture"])(
    "refuses a pull request without the exact owned marker: %s",
    async (body) => {
      const f = await fixture();
      f.pull.body = body;
      const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
      await expect(host.merge(f.merge)).rejects.toThrow("owned reviewed repair");
      expect(f.calls.some((call) => call[2] === "merge")).toBe(false);
    },
  );

  it("accepts the exact owned marker in a CRLF pull request body", async () => {
    const f = await fixture();
    f.pull.body += "\r\n";
    f.checks([{ name: "tests", bucket: "pending" }]);
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    expect((await host.merge(f.merge)).status).toBe("pending");
  });

  it("waits for required checks without submitting a merge", async () => {
    const f = await fixture();
    f.checks([{ name: "tests", bucket: "pending" }]);
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    expect((await host.merge(f.merge)).status).toBe("pending");
    expect(f.calls.some((call) => call[2] === "merge")).toBe(false);
  });

  it("merges a pull request that GitHub reports no checks for", async () => {
    const f = await fixture();
    f.checks(null);
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    expect((await host.merge(f.merge)).status).toBe("merged");
    expect(f.calls.filter((call) => call[2] === "merge")).toHaveLength(1);
  });

  it("waits for checks to appear on a pull request opened moments ago", async () => {
    const f = await fixture();
    f.checks(null);
    f.pull.createdAt = new Date().toISOString();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    expect(await host.merge(f.merge)).toMatchObject({ status: "pending" });
    expect(f.calls.some((call) => call[2] === "merge")).toBe(false);
  });

  it("stops when GitHub has checks that do not report as passing", async () => {
    const f = await fixture();
    f.checks([{ name: "tests", bucket: "fail" }], 1);
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    expect(await host.merge(f.merge)).toMatchObject({ status: "blocked" });
    expect(f.calls.some((call) => call[2] === "merge")).toBe(false);
  });

  it("recovers a lost merge response and never submits a second merge", async () => {
    const f = await fixture();
    f.loseMerge();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    expect((await host.merge(f.merge)).status).toBe("merged");
    expect((await host.merge(f.merge)).status).toBe("merged");
    expect(f.calls.filter((call) => call[2] === "merge")).toHaveLength(1);
    expect(f.calls.some((call) => call.includes("--admin") || call.includes("--force"))).toBe(
      false,
    );
  });

  it("refuses a changed head and evidence outside the repository", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    f.pull.headRefOid = "b".repeat(40);
    await expect(host.merge(f.merge)).rejects.toThrow("does not match");
    expect(f.calls.some((call) => call[2] === "merge")).toBe(false);
    expect(() =>
      hostContract.workflowMerge.input.parse({
        ...f.merge,
        review: { ...f.merge.review, evidencePath: "../outside.json" },
      }),
    ).toThrow();
  });

  it.each(["fixture/omnyo", "fixture/omnyo-private"])(
    "never starts a release while planning or waiting for %s",
    async (repository) => {
      const f = await fixture(undefined, repository);
      const planned = await new WorkflowHost(f.journalRoot, undefined, f.runner).plan(f.plan);
      const host = new WorkflowHost(f.journalRoot, undefined, f.runner);

      expect(planned).toMatchObject({ status: "planned", kind: "runtime", releaseRequired: true });
      expect(await host.plan(f.plan)).toEqual(planned);
      expect(f.calls.filter((call) => call[1] === "private:plan")).toHaveLength(1);

      const input = {
        runId: f.plan.runId,
        planPath: planned.planPath,
        planDigest: planned.planDigest,
      };

      expect((await host.deliver(input)).status).toBe("pending");
      await f.publish({
        status: "running",
        phases: { "coordinator-offer": { status: "complete" } },
      });
      expect(await host.deliver(input)).toMatchObject({
        status: "complete",
        offeredVersion: "1.0.200",
        receiptPath: f.releasePath,
      });
      expect((await host.verify(input)).status).toBe("pending");
      f.installed("1.0.201");
      expect((await host.verify(input)).status).toBe("verified");
      expect(f.calls.some((call) => call[1] === "private:ship")).toBe(false);
    },
  );

  it("skips the release gate when the installed release already contains the repair", async () => {
    const f = await fixture();
    await f.publish();
    f.installed("1.0.200");
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);

    expect(await host.plan(f.plan)).toMatchObject({ kind: "runtime", releaseRequired: false });
  });

  it("verifies a no-delivery plan without a delivery journal", async () => {
    const f = await fixture([]);
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);
    expect(planned).toMatchObject({ status: "planned", kind: "none" });

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    await expect(host.verify({ ...input, planDigest: "a".repeat(64) })).rejects.toThrow(
      "Delivery plan changed after verification",
    );
    await expect(host.verify(input)).resolves.toEqual({
      status: "verified",
      sourceCommit: f.head,
      proof: "No product runtime changed",
    });
    expect(f.calls).toEqual([["pnpm", "private:plan"]]);
  });

  it("keeps a blocked plan blocked before a publisher attempts it", async () => {
    const f = await fixture([{ kind: "web" }]);
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);
    expect(planned).toMatchObject({
      status: "blocked",
      reason: "Web delivery requires the source-bound selective test artifact",
    });

    await expect(
      host.verify({
        runId: f.plan.runId,
        planPath: planned.planPath,
        planDigest: planned.planDigest,
      }),
    ).resolves.toEqual({
      status: "blocked",
      sourceCommit: f.head,
      proof: planned.reason,
    });
    expect(f.calls).toEqual([["pnpm", "private:plan"]]);
  });

  it("starts one requested release on approval and never repeats it", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    const requested = await host.release(input);

    expect(requested).toMatchObject({
      status: "pending",
      offeredVersion: "1.0.200",
      receiptPath: f.releasePath,
    });
    expect(await host.release(input)).toEqual(requested);
    expect(f.calls.filter((call) => call[1] === "private:ship")).toEqual([
      ["pnpm", "private:ship", "--release"],
    ]);
    expect((await host.deliver(input)).status).toBe("pending");
    await f.publish();
    expect((await host.deliver(input)).status).toBe("complete");
  });

  it.each([
    ["before its receipt exists", null],
    ["before it pushes its source", { status: "running", phases: {} }],
  ])("joins a live release %s instead of starting another", async (_label, receipt) => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const queued = await f.ticket("1.0.201", process.pid, receipt);
    const planned = await host.plan(f.plan);

    expect(
      await host.release({
        runId: f.plan.runId,
        planPath: planned.planPath,
        planDigest: planned.planDigest,
      }),
    ).toMatchObject({ status: "pending", offeredVersion: "1.0.201", receiptPath: queued });
    expect(f.calls.some((call) => call[1] === "private:ship")).toBe(false);
  });

  it("starts a release when the lane only holds a dead job or one frozen before the repair", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const tree = git(f.path, "hash-object", "-t", "tree", "/dev/null");
    const unrelated = git(f.path, "commit-tree", tree, "-m", "older release");
    await f.ticket("1.0.201", 999_999_999, null);
    await f.ticket("1.0.202", process.pid, {
      status: "running",
      sourceCommit: unrelated,
      phases: { "source-push": { status: "complete" } },
    });
    const planned = await host.plan(f.plan);

    expect(
      await host.release({
        runId: f.plan.runId,
        planPath: planned.planPath,
        planDigest: planned.planDigest,
      }),
    ).toMatchObject({ status: "pending", offeredVersion: "1.0.200" });
    expect(f.calls.filter((call) => call[1] === "private:ship")).toHaveLength(1);
  });

  it("never replays an unconfirmed request but joins the release it started", async () => {
    const f = await fixture();
    f.loseDelivery();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    expect((await host.release(input)).status).toBe("blocked");
    const queued = await f.ticket("1.0.200", process.pid, null);
    expect(await host.release(input)).toMatchObject({ status: "pending", receiptPath: queued });
    expect(f.calls.filter((call) => call[1] === "private:ship")).toHaveLength(1);
    const content = JSON.parse(await readFile(planned.planPath, "utf8"));
    content.kind = "none";
    await writeFile(planned.planPath, JSON.stringify(content));
    await expect(host.deliver(input)).rejects.toThrow("changed after verification");
  });

  it("returns a failed release to the owner and lets a new approval start another", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    await host.release(input);
    await writeFile(f.releasePath, JSON.stringify({ status: "failed", phases: {} }));
    expect((await host.deliver(input)).status).toBe("release-failed");
    expect((await host.release(input)).status).toBe("pending");
    expect(f.calls.filter((call) => call[1] === "private:ship")).toHaveLength(2);
  });

  it("asks again when an unconfirmed request left no release, then starts one on approval", async () => {
    const f = await fixture();
    f.loseDelivery();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    expect((await host.release(input)).status).toBe("blocked");
    expect((await host.release(input)).status).toBe("release-failed");
    f.loseDelivery(false);
    expect((await host.release(input)).status).toBe("pending");
    expect(f.calls.filter((call) => call[1] === "private:ship")).toHaveLength(2);
  });

  it("reports a failed release once, so waiting for the next release stays put", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    await host.release(input);
    await writeFile(f.releasePath, JSON.stringify({ status: "failed", phases: {} }));
    expect((await host.deliver(input)).status).toBe("release-failed");
    expect((await host.deliver(input)).status).toBe("pending");
    await f.publish();
    expect((await host.deliver(input)).status).toBe("complete");
  });

  it("asks again when a joined release stops before writing its receipt", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const queued = await f.ticket("1.0.201", process.pid, null);
    const planned = await host.plan(f.plan);

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    expect(await host.release(input)).toMatchObject({ status: "pending", receiptPath: queued });
    expect((await host.deliver(input)).status).toBe("pending");
    await rm(join(f.root, "releases", "private-ship-lane", "tickets"), { recursive: true });
    expect((await host.deliver(input)).status).toBe("release-failed");
    expect((await host.deliver(input)).status).toBe("pending");
    expect((await host.release(input)).status).toBe("pending");
    expect(f.calls.filter((call) => call[1] === "private:ship")).toHaveLength(1);
  });

  it("pauses on an ambiguous release instead of starting another", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    const planned = await host.plan(f.plan);

    const input = {
      runId: f.plan.runId,
      planPath: planned.planPath,
      planDigest: planned.planDigest,
    };

    await host.release(input);
    await writeFile(
      f.releasePath,
      JSON.stringify({
        status: "ambiguous",
        phases: { "coordinator-offer": { status: "intent" } },
      }),
    );
    expect((await host.deliver(input)).status).toBe("blocked");
    expect((await host.release(input)).status).toBe("blocked");
    expect(f.calls.filter((call) => call[1] === "private:ship")).toHaveLength(1);
  });

  it("does not count a prepare-only job as a release that will ship", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    await f.ticket("1.0.201", process.pid, null, "prepare");
    const planned = await host.plan(f.plan);

    expect(
      await host.release({
        runId: f.plan.runId,
        planPath: planned.planPath,
        planDigest: planned.planDigest,
      }),
    ).toMatchObject({ status: "pending", offeredVersion: "1.0.200" });
    expect(f.calls.filter((call) => call[1] === "private:ship")).toHaveLength(1);
  });

  it("ignores stray files and unreadable receipts beside releases", async () => {
    const f = await fixture();
    const host = new WorkflowHost(f.journalRoot, undefined, f.runner);
    await mkdir(join(f.root, "releases", "private-ship", "1.0.199", "broken"), { recursive: true });
    await writeFile(join(f.root, "releases", "private-ship", "1.0.199", ".DS_Store"), "");
    await writeFile(
      join(f.root, "releases", "private-ship", "1.0.199", "broken", "receipt.json"),
      "{",
    );

    expect(await host.plan(f.plan)).toMatchObject({ releaseRequired: true });
  });
});

async function pluginFixture() {
  const root = await mkdtemp(join(tmpdir(), "sentry-plugin-baseline-"));
  scratch.push(root);
  const active = join(root, "active");
  const candidate = join(root, "candidate");
  await mkdir(join(active, "demo"), { recursive: true });
  git(active, "init", "-b", "main");
  git(active, "config", "commit.gpgsign", "false");
  git(active, "config", "user.name", "Test");
  git(active, "config", "user.email", "test@example.invalid");
  await writeFile(
    join(active, "demo/package.json"),
    JSON.stringify({
      name: "omnyo-plugin-demo",
      version: "0.1.0",
      omnyo: { name: "Demo", server: "./server.ts", app: "./app.tsx" },
    }),
  );
  await writeFile(join(active, "demo/fix.ts"), "before\n");
  await writeFile(join(active, "demo/other.ts"), "keep\n");
  await writeFile(join(active, "demo/.gitignore"), "dist/\n");
  await mkdir(join(active, "demo/docs/evidence"), { recursive: true });
  await writeFile(join(active, "demo/docs/evidence/install.json"), "{}\n");
  git(active, "add", "demo");
  git(active, "commit", "-m", "baseline");
  const base = git(active, "rev-parse", "HEAD");
  git(root, "clone", "--shared", active, candidate);
  git(candidate, "remote", "set-url", "origin", "https://github.com/fixture/omnyo-plugins.git");
  git(candidate, "config", "commit.gpgsign", "false");
  git(candidate, "config", "user.name", "Test");
  git(candidate, "config", "user.email", "test@example.invalid");
  await writeFile(join(candidate, "demo/fix.ts"), "after\n");
  git(candidate, "commit", "-am", "fix");
  let source = "path:" + join(active, "demo");
  let builds = 0;
  let activeRoot = join(active, "demo");

  const runner: typeof execute = async (program, args, cwd, timeout, capture, signal) => {
    if (program === "git") return execute(program, args, cwd, timeout, capture, signal);

    if (program === "omnyo" && args[1] === "build") {
      builds++;
      const dist = join(candidate, "demo/dist");
      await mkdir(dist, { recursive: true });

      for (const [name, body] of [
        ["server.js", "export default () => {}"],
        ["server.meta.json", "{}"],
        ["app.js", "export default () => null"],
        ["app.css", ".demo{}"],
        ["app.meta.json", "{}"],
      ])
        await writeFile(join(dist, name), body);

      return { exitCode: 0, output: "{}", durationMs: 1, outputBytes: 1 };
    }

    const output =
      args[1] === "list"
        ? { plugins: [{ id: "demo", rootDir: activeRoot, source }] }
        : { requested: source, resolved: source };

    return { exitCode: 0, output: JSON.stringify(output), durationMs: 1, outputBytes: 1 };
  };

  const input = hostContract.workflowPlan.input.parse({
    runId: "baseline-one",
    path: candidate,
    repository: "fixture/omnyo-plugins",
    baseCommit: base,
    mergeCommit: git(candidate, "rev-parse", "HEAD"),
    changedFiles: ["demo/fix.ts"],
    selectionPath: null,
    nativeRequired: [],
  });

  return {
    root,
    active,
    candidate,
    input,
    host: new WorkflowHost(join(root, "journal"), undefined, runner),
    builds: () => builds,
    activateSnapshot: (path: string) => {
      activeRoot = path;
      source = "path:" + path;
    },
    packaged: async () => {
      activeRoot = join(root, "packaged");
      await mkdir(activeRoot);
    },
  };
}

describe("Installed plugin source preservation", () => {
  it("requires the guarded installer for a standalone plugin plan", async () => {
    const f = await pluginFixture();
    const plan = await f.host.plan(f.input);

    await expect(
      f.host.deliver({
        runId: f.input.runId,
        planPath: plan.planPath,
        planDigest: plan.planDigest,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "Standalone plugin delivery requires the guarded installer",
    });
    expect(f.builds()).toBe(0);
  });

  it("permits a reviewed repair while retaining the other installed source", async () => {
    const f = await pluginFixture();
    const plan = await f.host.plan(f.input);

    expect(plan.status).toBe("planned");

    const targets = await f.host.pluginTargets({
      runId: f.input.runId,
      planPath: plan.planPath,
      planDigest: plan.planDigest,
    });

    expect(targets.targets[0]).toMatchObject({ pluginId: "demo", version: "0.1.0" });
    const target = targets.targets[0]!;
    expect(target.source).toBe(
      "path:" +
        join(f.root, "journal", f.input.runId, "plugin-runtimes", "demo", target.snapshotDigest),
    );
    const snapshot = target.source.slice(5);
    expect(await readFile(join(snapshot, "app-entry.js"), "utf8")).toContain('import "./app.css"');
    expect(JSON.parse(await readFile(join(snapshot, "package.json"), "utf8")).omnyo.server).toBe(
      "./server.js",
    );
    await f.host.pluginTargets({
      runId: f.input.runId,
      planPath: plan.planPath,
      planDigest: plan.planDigest,
    });
    expect(f.builds()).toBe(1);
    f.activateSnapshot(snapshot);
    await f.host.pluginTargets({
      runId: f.input.runId,
      planPath: plan.planPath,
      planDigest: plan.planDigest,
    });
    await writeFile(join(snapshot, "server.js"), "tampered");
    await expect(
      f.host.pluginTargets({
        runId: f.input.runId,
        planPath: plan.planPath,
        planDigest: plan.planDigest,
      }),
    ).rejects.toThrow("snapshot bytes changed");
  });

  it("ignores non-shipped receipts changed after installation", async () => {
    const f = await pluginFixture();
    await writeFile(join(f.active, "demo/docs/evidence/install.json"), '{"installed":true}\n');
    expect((await f.host.plan(f.input)).status).toBe("planned");
  });

  it("rejects dropping an installed uncommitted change outside the repair", async () => {
    const f = await pluginFixture();
    await writeFile(join(f.active, "demo/other.ts"), "foreign live change\n");
    await expect(f.host.plan(f.input)).rejects.toThrow("outside the reviewed repair");
  });

  it("rejects replacing a newer installed change in the repair's own file", async () => {
    const f = await pluginFixture();
    await writeFile(join(f.active, "demo/fix.ts"), "newer live behavior\n");
    git(f.active, "commit", "-am", "new live behavior");
    await expect(f.host.plan(f.input)).rejects.toThrow("outside the reviewed repair");
  });

  it("checks content again immediately before yielding installation targets", async () => {
    const f = await pluginFixture();
    const plan = await f.host.plan(f.input);
    await writeFile(join(f.active, "demo/other.ts"), "live change after plan\n");
    await expect(
      f.host.pluginTargets({
        runId: f.input.runId,
        planPath: plan.planPath,
        planDigest: plan.planDigest,
      }),
    ).rejects.toThrow("outside the reviewed repair");
  });

  it("refuses a packaged installation without complete source evidence", async () => {
    const f = await pluginFixture();
    await f.packaged();
    await expect(f.host.plan(f.input)).rejects.toThrow("no verifiable complete source tree");
  });
});

describe("Bootstrap runtime source marker", () => {
  it("binds packaged bytes to clean source and refuses a dirty source claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentry-runtime-marker-"));
    scratch.push(root);
    const plugin = join(root, "sentry");
    await mkdir(join(plugin, "scripts"), { recursive: true });
    await mkdir(join(plugin, "dist"));
    await mkdir(join(plugin, "skills"));
    await mkdir(join(plugin, "docs/evidence"), { recursive: true });
    await copyFile(
      resolve("scripts/package-runtime.mjs"),
      join(plugin, "scripts/package-runtime.mjs"),
    );
    await symlink(resolve("node_modules"), join(plugin, "node_modules"));
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-sentry",
        version: "0.3.1",
        omnyo: {
          name: "Sentry",
          server: "./server.ts",
          app: "./app.tsx",
          host: "./host.ts",
          skills: ["skills"],
        },
      }),
    );
    await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\ndocs/evidence/\n");
    await writeFile(join(plugin, "server.ts"), "export default () => {};\n");
    await writeFile(join(plugin, "README.md"), "Sentry\n");
    await writeFile(join(plugin, "PLUGIN_OVERVIEW.md"), "Sentry\n");

    for (const name of [
      "server.js",
      "server.meta.json",
      "host.js",
      "host.meta.json",
      "app.js",
      "app.css",
      "app.meta.json",
    ])
      await writeFile(
        join(plugin, "dist", name),
        name.endsWith("json") ? "{}" : "export default {};\n",
      );
    git(root, "init", "-b", "main");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "remote", "add", "origin", "https://github.com/fixture/omnyo-plugins.git");
    git(root, "add", ".");
    git(root, "commit", "-m", "source");

    const output = execFileSync(process.execPath, [join(plugin, "scripts/package-runtime.mjs")], {
      encoding: "utf8",
    });

    const packaged = JSON.parse(output);

    const metadata = JSON.parse(
      await readFile(join(packaged.directory, "omnyo-workflow-source.json"), "utf8"),
    );

    expect(metadata.sourceCommit).toBe(git(root, "rev-parse", "HEAD"));
    expect(metadata.sourceFiles["server.ts"].oid).toBe(
      git(root, "rev-parse", "HEAD:sentry/server.ts"),
    );
    expect(
      metadata.runtimeFiles.some(
        (file: { path: string }) => file.path === "omnyo-workflow-source.json",
      ),
    ).toBe(false);
    const expected = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
    expect(packaged.build).toBe(expected.slice(0, 20));
    await writeFile(join(plugin, "server.ts"), "uncommitted change\n");
    expect(() =>
      execFileSync(process.execPath, [join(plugin, "scripts/package-runtime.mjs")], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});

describe("Runtime delivery scope", () => {
  it("leaves unrelated unpublished changes to the owner's release instead of blocking", async () => {
    const f = await fixture();
    await mkdir(join(f.path, "apps/server/src"), { recursive: true });
    await writeFile(join(f.path, "apps/server/src/foreign.ts"), "unpublished product change\n");
    git(f.path, "add", "apps/server/src/foreign.ts");
    git(f.path, "commit", "-m", "unrelated change");
    const current = git(f.path, "rev-parse", "HEAD");

    const runner: typeof execute = async (program, args, cwd, timeout, capture, signal) => {
      if (program === "pnpm" && args[0] === "private:plan")
        return {
          exitCode: 0,
          output: JSON.stringify({
            status: "ready",
            sourceCommit: current,
            actions: [{ kind: "runtime" }],
            unresolved: [],
          }),
          durationMs: 1,
          outputBytes: 1,
        };

      return f.runner(program, args, cwd, timeout, capture, signal);
    };

    const host = new WorkflowHost(f.journalRoot, undefined, runner);

    expect(await host.plan({ ...f.plan, baseCommit: current, mergeCommit: current })).toMatchObject(
      { status: "planned", kind: "runtime", releaseRequired: true },
    );
    expect(f.calls.some((call) => call[1] === "private:ship")).toBe(false);
  });
});
