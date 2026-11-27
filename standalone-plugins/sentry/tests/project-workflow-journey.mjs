import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@omnyo/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { createSentryPlugin } from "../server.ts";
import { SentryStore } from "../src/store.ts";
import entry from "../host.ts";
import { route, sentryIssue } from "./fixtures.ts";
import { TurnHistory } from "./turn-events.ts";

// Integration boundary: actual SQLite + plugin RPC/tools/events + native Git host;
// only Sentry HTTP and model execution are deterministic stand-ins.
const root = await mkdtemp(join(tmpdir(), "sentry-project-journey-"));

const hostEntry = experimental_createHostEntryHarness(entry, {
  experimental_paths: { dataDir: join(root, "host"), tempDir: root },
});

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let host;

const threads = new Map();

const turnHistory = new TurnHistory();

const environments = new Map();

const ownershipConflicts = [];

let loseSpawn = false;

let failStop = false;

let nextThread = 0;

const modelInputs = [];

let sends = 0;

try {
  const umbrella = join(root, "app");
  await mkdir(umbrella);
  environments.set("env_checkout", {
    environmentProviderId: "project-checkout",
    path: umbrella,
  });

  for (const name of ["client", "ios"]) {
    const path = join(umbrella, name);
    await mkdir(path);
    git(path, "init", "-b", "main");
    git(path, "config", "commit.gpgsign", "false");
    await writeFile(join(path, "code.txt"), "base\n");
    git(path, "add", "code.txt");
    git(
      path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "base",
    );
    await writeFile(join(path, "foreign.txt"), "preserve me\n");
  }

  await mkdir(join(umbrella, ".git")); // Omnyo umbrella metadata is not a Git repository.

  const project = {
    id: "proj_app",
    name: "Umbrella",
    sources: [{ id: "src_app", type: "local_path", hostId: "host_mac", path: umbrella }],
  };

  const factory = createSentryPlugin(async (input) => {
    const url = new URL(String(input));
    const projectId = url.searchParams.get("project");

    return new Response(
      JSON.stringify(
        [1, 2].map((index) => ({
          ...sentryIssue(String(Number(projectId) + index)),
          project: { id: projectId },
        })),
      ),
    );
  });

  host = createFakePluginHost({
    pluginId: "sentry",
    agentSkillIds: ["sentry", "solve-sentry-issues"],
    settings: { apiToken: "fixture-non-secret" },
    experimental_callHostRpc: (call) => hostEntry.experimental_call(call.method, call.input),
    sdk: {
      projects: { list: () => [project] },
      providers: {
        models: () => ({
          models: [
            {
              id: "gpt-6.1-sol",
              supportedReasoningEfforts: [{ reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
            },
          ],
        }),
      },
      threads: {
        spawn: async (input) => {
          modelInputs.push(input);
          const id = "thr_journey_" + ++nextThread;
          const environmentId = "env_journey_" + nextThread;
          threads.set(id, {
            id,
            environmentId,
            status: "active",
            queuedMessageCount: 0,
            activeBackgroundAgentCount: 0,
          });
          const selection = input.environment;

          const provider = host.harness.inspection.registrations.environmentProviders.get(
            selection.environmentProviderId,
          );

          const context = {
            inputs: selection.inputs,
            project,
            host: { id: "host_mac" },
            thread: { id, environmentId },
            pathKey: id + "-1",
            signal: new AbortController().signal,
            experimental_claimPath: async () => true,
            report: () => {},
          };

          assert.equal((await provider.validate(context)).action, "accept");
          const created = await provider.create(context);
          assert.equal(created.status, "created");

          for (const existing of environments.values()) {
            if (
              existing.path === created.path &&
              existing.environmentProviderId !== selection.environmentProviderId
            ) {
              ownershipConflicts.push(created.path);
              throw new Error("Workspace already belongs to another environment provider");
            }
          }

          await access(created.path);
          environments.set(environmentId, {
            environmentProviderId: selection.environmentProviderId,
            environmentProviderSelection: { inputs: selection.inputs },
            hostId: "host_mac",
            path: created.path,
            ownsPath: created.ownsPath,
          });

          if (loseSpawn) {
            loseSpawn = false;
            throw new Error("lost spawn response after environment binding");
          }

          return { id, environmentId };
        },
        get: ({ threadId }) => threads.get(threadId),
        list: () => [...threads.values()],
        stop: ({ threadId }) => {
          if (failStop === true || failStop === threadId)
            throw new Error("native stop not acknowledged");
          threads.get(threadId).status = "idle";

          return {};
        },
        send: ({ threadId, input }) => {
          sends++;
          threads.get(threadId).status = "active";
          threads.get(threadId).history = [{ id: "summary", createdAt: Date.now(), input }];

          return {};
        },
        promptHistory: ({ threadId }) => threads.get(threadId).history ?? [],
        queuedMessages: { list: () => [] },
        events: { list: (query) => turnHistory.list(query) },
      },
      environments: { get: ({ environmentId }) => environments.get(environmentId) },
      plugins: {
        callRpc: () => ({
          id: "notice",
          status: "queued",
          duplicate: false,
          durable: true,
          acceptedTargetCount: 1,
        }),
      },
    },
  });
  await factory(host.api);
  let store = new SentryStore(host.api.storage);

  for (const [id, projectId, name] of [
    ["client", "100", "client"],
    ["ios", "200", "ios"],
  ])
    store.saveRoute({
      ...route(),
      id,
      sentryProjectId: projectId,
      repositoryPath: join(umbrella, name),
    });

  const discovered = await host.harness.behavior.callRpc("projects.repositories", {
    projectId: "proj_app",
  });

  assert.deepEqual(
    discovered.map((repository) => repository.name),
    ["client", "ios"],
  );
  loseSpawn = true;
  const batch = await host.harness.behavior.callRpc("projects.solveAll", { projectId: "proj_app" });
  await host.harness.behavior.runSchedule("sync");
  assert.deepEqual(ownershipConflicts, [], "coordinator must not claim the project checkout");
  assert.equal(modelInputs.length, 1);
  let current = store.getBatch(batch.id);
  assert.equal(current.threadId, "thr_journey_1");
  assert.equal(current.incidents.length, 4);
  assert.equal(environments.get("env_journey_1").ownsPath, true);

  const forged = await host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: "thr_forged" },
      pluginMetadata: { batchId: batch.id },
      project: { id: "proj_app" },
      host: { id: "host_mac" },
    }),
  );

  assert.equal(forged.tools.length, 0);

  const configured = await host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: current.threadId },
      project: { id: "proj_app" },
      host: { id: "host_mac" },
    }),
  );

  assert(configured.tools.some((tool) => tool.name === "sentry_queue_package"));
  const ctx = { threadId: current.threadId, projectId: "proj_app" };

  const keys = current.incidents
    .filter((issue) => issue.projectId === "100")
    .map((issue) => issue.key);

  const grouped = JSON.parse(
    await host.harness.behavior.callAgentTool(
      "sentry_queue_package",
      {
        routeId: "client",
        issueKeys: keys,
        title: "Related parser errors",
        rationale: "Verify both request variants before a repair",
      },
      ctx,
    ),
  );

  await host.harness.behavior.runSchedule("sync");
  assert.equal(modelInputs.length, 2);
  assert.equal(modelInputs[1].reasoningLevel, "ultra");
  assert.equal(modelInputs[1].serviceTier, "default");
  assert.notEqual(store.getRun(grouped.id).worktreePath, join(umbrella, "client"));
  assert.equal(await readFile(join(umbrella, "client", "foreign.txt"), "utf8"), "preserve me\n");

  const blocked = current.incidents
    .filter((issue) => issue.projectId !== "100")
    .map((issue) => ({ issueKey: issue.key, reason: "Need native affected-release evidence" }));

  const waiting = JSON.parse(
    await host.harness.behavior.callAgentTool(
      "sentry_finish_project",
      { summary: "One grouped package; native issues need evidence", blocked },
      ctx,
    ),
  );

  assert.equal(waiting.state, "waiting");
  // Recreate the coordinator instance over persisted SQLite; worker completion
  // deliberately has no idle event, so startup must recover it from native state.
  await host.harness.behavior.callAgentTool(
    "sentry_finish_run",
    {
      outcome: "needs-evidence",
      classification: "Hypothesis",
      summary: "The package needs evidence from the affected release",
      rootCause: "The triggering input is unavailable",
      issueFindings: keys.map((key) => ({
        key,
        outcome: "blocked",
        summary: "Missing triggering input",
        evidence: [],
      })),
    },
    { threadId: store.getRun(grouped.id).threadId, projectId: "proj_app" },
  );
  turnHistory.completedTurn("thr_journey_1");
  threads.get("thr_journey_1").status = "idle";
  threads.get("thr_journey_2").status = "idle";
  host = await host.harness.lifecycle.reload(factory);
  store = new SentryStore(host.api.storage);
  const service = host.harness.behavior.runService("reconcile");
  await host.harness.behavior.runSchedule("sync");
  service.controller.abort();
  await service.done;

  if (process.argv.includes("--diagnose")) {
    console.log(
      JSON.stringify({
        run: store.getRun(grouped.id),
        calls: host.harness.inspection.sdk.callsTo("threads.get"),
        stops: host.harness.inspection.sdk.callsTo("threads.stop"),
        logs: host.harness.inspection.logEntries,
        threads: [...threads.values()],
      }),
    );
    process.exitCode = 1;
    throw new Error("bounded reload diagnostic");
  }

  assert.equal(store.hasClaim(grouped.id), false);
  assert.equal(sends, 1);
  assert.equal(store.getBatch(batch.id).state, "summarizing");
  assert.equal(modelInputs.length, 2);
  // Stop refusal must stay visible and retain ownership until native stop succeeds.
  failStop = true;
  await assert.rejects(host.harness.behavior.callRpc("batches.stop", { id: batch.id }));
  assert.notEqual(store.getBatch(batch.id).state, "cancelled");
  failStop = false;
  await host.harness.behavior.callRpc("batches.stop", { id: batch.id });
  assert.equal(store.getBatch(batch.id).state, "cancelled");

  const second = await host.harness.behavior.callRpc("projects.solveAll", {
    projectId: "proj_app",
  });

  await host.harness.behavior.runSchedule("sync");
  const secondBatch = store.getBatch(second.id);
  const iosKey = secondBatch.incidents.find((issue) => issue.projectId === "200").key;

  const iosRun = JSON.parse(
    await host.harness.behavior.callAgentTool(
      "sentry_queue_package",
      {
        routeId: "ios",
        issueKeys: [iosKey],
        title: "Native issue",
        rationale: "Separate repository owns this failure",
      },
      { threadId: secondBatch.threadId, projectId: "proj_app" },
    ),
  );

  await host.harness.behavior.runSchedule("sync");
  failStop = store.getRun(iosRun.id).threadId;
  await assert.rejects(host.harness.behavior.callRpc("batches.stop", { id: second.id }));
  assert.notEqual(
    store.getBatch(second.id).state,
    "cancelled",
    "A child stop refusal must retain unfinished project ownership",
  );
  failStop = false;
  await host.harness.behavior.callRpc("batches.stop", { id: second.id });
  assert.equal(store.getBatch(second.id).state, "cancelled");

  for (const input of modelInputs) assert.equal(input.serviceTier, "default");
  const worktree = store.getRun(grouped.id);

  if (worktree.worktreePath) {
    const removed = await hostEntry.experimental_call("removeWorktree", {
      sourcePath: worktree.route.repositoryPath,
      path: worktree.worktreePath,
      branch: worktree.branch,
    });

    assert.equal(removed.removed, true);
  }

  console.log(
    JSON.stringify(
      {
        surface: "Official Omnyo plugin harness + real SQLite + native Git host",
        checks: [
          "lost coordinator spawn response recovers actual environment binding",
          "wrong metadata has no coordinator tools",
          "actual project/source/host provider binding",
          "complete multi-repository inventory",
          "isolated Ultra package worktree",
          "canonical untracked sentinel preserved",
          "reload recovers missed worker completion",
          "one summary callback to existing coordinator",
          "native stop refusal retains ownership",
          "producer worktree cleanup",
        ],
        modelCalls: 0,
        providerWrites: 0,
        modelSelections: modelInputs.map((input) => ({
          model: input.model,
          reasoning: input.reasoningLevel,
          tier: input.serviceTier,
        })),
        limits:
          "Sentry HTTP and agent execution are deterministic stand-ins; no new real model turn or product fix is claimed.",
      },
      null,
      2,
    ),
  );
} finally {
  await host?.harness.lifecycle.dispose();
  await hostEntry.experimental_dispose();
  await rm(root, { recursive: true, force: true });
  assert.equal(
    await access(root).then(
      () => true,
      () => false,
    ),
    false,
  );
}
