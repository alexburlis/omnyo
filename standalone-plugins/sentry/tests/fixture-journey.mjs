import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const repository = resolve(import.meta.dirname, "..");

const evidence = join(repository, "docs/evidence");

const stateFile = join(evidence, "fixture-state.json");

const args = process.argv.slice(2).filter((value) => value !== "--");

const value = (name) => args[args.indexOf(name) + 1];

if (value("--mode") !== "local") throw new Error("This journey permits --mode local only");

const phase = args.includes("--phase") ? value("--phase") : "start";

if (!["start", "complete"].includes(phase)) throw new Error("Use --phase start or complete");

const owner = process.env.OMNYO_THREAD_ID ?? "terminal";

const projectId = args.includes("--project") ? value("--project") : null;

const hostId = args.includes("--machine") ? value("--machine") : null;

if (phase === "start" && (!projectId?.startsWith("proj_") || !hostId?.startsWith("host_")))
  throw new Error("Start requires --project PROJECT_ID and --machine MACHINE_ID");

function api(argv) {
  return JSON.parse(
    execFileSync("omnyo", [...argv, "--json"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function git(cwd, ...argv) {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function save(state) {
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
}

assert.equal(
  api(["plugin", "rpc", "call", "sentry", "fixture.identity"]).kind,
  "sentry-local-acceptance",
  "Install the explicitly authorized acceptance snapshot first",
);

await mkdir(evidence, { recursive: true });

if (phase === "start") {
  if (
    await access(stateFile).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      "An existing journey receipt needs reconciliation; do not allocate a duplicate fixture",
    );
  const root = await mkdtemp(join(tmpdir(), "sentry-local-journey-"));
  const source = join(root, "umbrella/client");
  const sibling = join(root, "umbrella/server");

  let state = {
    owner,
    root,
    source,
    sibling,
    runId: null,
    threadId: null,
    phase: "preparing",
    sentinels: {},
    accepted: false,
  };

  await save(state);

  try {
    await mkdir(source, { recursive: true });
    await mkdir(sibling);
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Sentry acceptance fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(sibling, "init", "-b", "main");
    await writeFile(
      join(source, "normalize-labels.test.mjs"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLabels } from "./normalize-labels.mjs";
test("an absent optional label list normalizes to an empty list", () => assert.deepEqual(normalizeLabels(null), []));
test("present labels are trimmed", () => assert.deepEqual(normalizeLabels([" one ", "two"]), ["one", "two"]));
`,
    );
    await writeFile(
      join(source, "normalize-labels.mjs"),
      "export function normalizeLabels(labels) { return labels.map(value => value.trim()); }\n",
    );
    await writeFile(
      join(source, "AGENTS.md"),
      `# Controlled Sentry acceptance fixture
This repository is a disposable fixture for the Omnyo Sentry plugin implementation, owned by ${state.owner}.
The Sentry incident FIXTURE-1 is synthetic. Its provider transport is intentionally fake. Do not query or change real Sentry, GitHub, accounts or services.
The observed incident is a TypeError when an optional labels response is null. The existing node test independently specifies the intended behavior.
Reproduce with node --test normalize-labels.test.mjs, identify the exact cause, make the smallest repair, rerun that same command and locally commit only the repaired source.
Do not change the existing tests or dirty source sentinels. If additional isolated tests are necessary, define failure cases and write tests before source edits.
Use sentry_run_context and sentry_finish_run. Provide the actual before/after evidence and verified commit; delivery is local. End with a TL;DR.
No additional provider spend, premium tier, alternate provider, push, PR, deployment or production write is authorized.
`,
    );
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await writeFile(join(source, "sentinel.txt"), "committed source sentinel\n");
    git(
      source,
      "add",
      "normalize-labels.test.mjs",
      "normalize-labels.mjs",
      "AGENTS.md",
      ".gitignore",
      "sentinel.txt",
    );
    git(source, "commit", "-m", "controlled failing Sentry acceptance fixture");
    state.baseSha = git(source, "rev-parse", "HEAD");

    const baseline = spawnSync(process.execPath, ["--test", "normalize-labels.test.mjs"], {
      cwd: source,
      encoding: "utf8",
    });

    assert.equal(baseline.status, 1);
    assert.match(baseline.stdout + baseline.stderr, /Cannot read properties of null/u);
    await writeFile(join(evidence, "fixture-before.txt"), baseline.stdout + baseline.stderr);

    const contents = [
      [join(source, "sentinel.txt"), "foreign tracked edit\n"],
      [join(source, "untracked.txt"), "foreign untracked fixture sentinel\n"],
      [join(source, "ignored.txt"), "foreign ignored fixture sentinel\n"],
      [join(sibling, "sibling.txt"), "sibling repository sentinel\n"],
    ];

    for (const [path, text] of contents) {
      await writeFile(path, text);
      state.sentinels[path] = digest(text);
    }

    state.route = {
      id: "fixture_local",
      name: "Disposable local acceptance",
      enabled: false,
      organization: "omnyo-local-fixture",
      sentryProjectId: "100",
      environment: "fixture",
      projectId,
      hostId,
      repositoryPath: source,
      baseRef: "main",
      delivery: "local",
      checks: [
        {
          name: "Original null-label regression",
          command: process.execPath,
          args: ["--test", "normalize-labels.test.mjs"],
          timeoutMs: 30000,
        },
      ],
      instructionPaths: [join(source, "AGENTS.md")],
    };
    const input = join(root, "route.json");
    await writeFile(input, JSON.stringify(state.route));
    // Persist submission intent before the request; an interrupted response must be reconciled.
    state.accepted = true;
    state.phase = "submitting";
    await save(state);
    const run = api(["plugin", "rpc", "call", "sentry", "fixture.prepare", "--input-file", input]);
    state = {
      ...state,
      runId: run.id,
      threadId: run.threadId,
      environmentId: run.environmentId,
      phase: "running",
    };
    await save(state);

    if (!run.threadId)
      throw new Error(
        "The run is retained but no worker is yet identified; inspect its recorded reason before recovery",
      );
    console.log(
      JSON.stringify({
        runId: run.id,
        threadId: run.threadId,
        environmentId: run.environmentId,
        root,
        next: "Register the exact native completion callback, then run --phase complete after the worker finishes.",
      }),
    );
  } catch (error) {
    state.phase = "failed";
    state.failure = error.message;
    await save(state);

    if (!state.accepted) {
      await rm(root, { recursive: true, force: true });
      state.scratchRemoved = true;
      await save(state);
    }

    throw error;
  }
} else {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.owner, owner);
  assert(
    state.root.includes("/sentry-local-journey-") &&
      state.source === join(state.root, "umbrella/client"),
  );

  if (!state.runId) {
    const status = api(["sentry", "status"]);

    const matches = status.runs.filter(
      (run) => run.route.id === "fixture_local" && run.route.repositoryPath === state.source,
    );

    assert.equal(matches.length, 1, "Recover exactly one existing launch before any cleanup");
    state.runId = matches[0].id;
    state.threadId = matches[0].threadId;
    await save(state);
  }

  if (state.environmentId) {
    const environment = api(["environment", "show", state.environmentId]);

    if (environment.status === "destroyed") {
      const retained = JSON.parse(await readFile(join(evidence, "fixture-result.json"), "utf8"));
      assert.equal(retained.run.id, state.runId);
      assert.equal(retained.environment.id, state.environmentId);
      assert.equal(retained.canonicalSentinelsUnchanged, true);
      assert.equal(
        git(state.source, "bundle", "list-heads", join(evidence, "fixture-fix.bundle")).split(
          /\s/u,
        )[0],
        retained.run.result.commit,
      );
      assert.equal(
        await access(retained.run.worktreePath).then(
          () => true,
          () => false,
        ),
        false,
      );
      api(["plugin", "rpc", "call", "sentry", "fixture.clear"]);
      await rm(state.root, { recursive: true, force: true });
      assert.equal(
        await access(state.root).then(
          () => true,
          () => false,
        ),
        false,
      );
      state.phase = "complete";
      state.scratchRemoved = true;
      state.worktreeRemoved = true;
      state.preservedSource = "docs/evidence/fixture-fix.bundle";
      await save(state);
      console.log(
        JSON.stringify({
          result: "local-ready",
          commit: retained.run.result.commit,
          scratchRemoved: true,
          resumedAfterNativeCleanup: true,
        }),
      );
      process.exit(0);
    }
  }

  const run = api(["sentry", "runs", "show", state.runId]);
  assert.equal(
    run.state,
    "local-ready",
    "Inspect and repair the existing worker; never fabricate a successful local result",
  );
  assert(run.threadId && run.verification && run.result?.commit);
  const actual = api(["thread", "show", run.threadId]);
  assert.equal(actual.thread.projectId, state.route.projectId);
  assert.equal(actual.thread.providerId, "codex");
  assert.equal(actual.environment.hostId, state.route.hostId);
  assert.equal(actual.environment.path, run.worktreePath);
  assert.equal(actual.environment.environmentProviderId, "sentry-worktree");
  assert.equal(run.baseSha, state.baseSha);
  assert.equal(run.verification.head, run.result.commit);
  const events = api(["thread", "log", run.threadId, "--limit", "100"]);
  const execution = events.find((event) => event.type === "client/turn/requested")?.data.execution;
  assert.equal(execution?.model, "gpt-6.1-sol");
  assert.equal(execution?.reasoningLevel, "max");
  assert.equal(execution?.serviceTier, "default");
  assert(events.some((event) => event.type === "turn/started"));

  for (const [path, expected] of Object.entries(state.sentinels))
    assert.equal(digest(await readFile(path)), expected, "A canonical or sibling sentinel changed");

  const after = spawnSync(process.execPath, ["--test", "normalize-labels.test.mjs"], {
    cwd: run.worktreePath,
    encoding: "utf8",
  });

  assert.equal(after.status, 0);
  await writeFile(join(evidence, "fixture-after.txt"), after.stdout + after.stderr);
  assert.equal(git(state.source, "rev-parse", "refs/heads/" + run.branch), run.result.commit);
  git(state.source, "bundle", "create", join(evidence, "fixture-fix.bundle"), run.branch);
  git(state.source, "bundle", "verify", join(evidence, "fixture-fix.bundle"));
  assert.equal(
    git(state.source, "bundle", "list-heads", join(evidence, "fixture-fix.bundle")).split(/\s/u)[0],
    run.result.commit,
  );
  await writeFile(
    join(evidence, "fixture-fix.patch"),
    git(state.source, "diff", state.baseSha, run.result.commit) + "\n",
  );
  const output = api(["thread", "output", run.threadId]);
  await writeFile(
    join(evidence, "fixture-result.json"),
    JSON.stringify(
      {
        run,
        execution,
        projectId: actual.thread.projectId,
        hostId: actual.environment.hostId,
        environment: actual.environment,
        output,
        canonicalSentinelsUnchanged: true,
        providerBoundary:
          "Real local Codex worker and native Omnyo lifecycle; Sentry and GitHub provider writes were excluded.",
        notificationLimit:
          "Native visible-thread completion handoff; client receipt requires separate observation.",
      },
      null,
      2,
    ) + "\n",
  );
  api(["thread", "stop", run.threadId]);
  api(["thread", "archive", run.threadId]);
  assert(actual.thread.environmentId && actual.environment.id === actual.thread.environmentId);
  state.environmentId = actual.environment.id;
  state.phase = "evidence-preserved";
  await save(state);
  api(["environment", "cleanup", actual.environment.id]);
  assert.equal(
    await access(run.worktreePath).then(
      () => true,
      () => false,
    ),
    false,
    "Use the environment producer cleanup; preserve the fixture while its consumer remains",
  );
  api(["plugin", "rpc", "call", "sentry", "fixture.clear"]);
  await rm(state.root, { recursive: true, force: true });
  assert.equal(
    await access(state.root).then(
      () => true,
      () => false,
    ),
    false,
  );
  state.phase = "complete";
  state.scratchRemoved = true;
  state.worktreeRemoved = true;
  state.preservedSource = "docs/evidence/fixture-fix.bundle";
  await save(state);
  console.log(
    JSON.stringify({
      result: "local-ready",
      runId: run.id,
      threadId: run.threadId,
      commit: run.result.commit,
      canonicalSentinelsUnchanged: true,
      scratchRemoved: true,
    }),
  );
}
