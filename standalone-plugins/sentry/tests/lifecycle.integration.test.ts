import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { runSchema } from "../contract";
import { createSentryPlugin } from "../server";
import { SentryRunner } from "../src/runner";
import { incident, projects, route, sentryIssue } from "./fixtures";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function retainedResult(outcome: "fix-ready" | "needs-evidence" | "no-fix" = "fix-ready") {
  return {
    outcome,
    classification: "Proven by inspection" as const,
    summary: "Retained structured completion",
    rootCause: "Source-bound finding retained",
    change: "Existing repair retained",
    commit: outcome === "fix-ready" ? "a".repeat(40) : null,
    changedFiles: [],
    reproduction: null,
    checks: [],
    limitations: [],
  };
}

function setup(resolveFixedIssues = false, mergeReviewedPullRequests = false) {
  const host = createFakePluginHost({
    pluginId: "sentry",
    sdk: {
      projects,
      providers: {
        models: () => ({
          models: [{ id: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }],
        }),
      },
      threads: {
        spawn: () => ({ id: "thr_owned", environmentId: "env_owned" }),
        stop: () => ({}),
        get: () => ({
          id: "thr_owned",
          status: "idle",
          queuedMessageCount: 0,
          activeBackgroundAgentCount: 0,
        }),
        send: () => ({}),
      },
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

  disposers.push(() => host.harness.lifecycle.dispose());

  const runner = new SentryRunner(host.api, async () => ({
    apiOrigin: "https://de.sentry.io",
    resolveFixedIssues,
    mergeReviewedPullRequests,
  }));

  runner.store.saveRoute(route());
  runner.store.savePolicy({ projectId: route().projectId, autoSolve: true, dailyLimit: 10 });

  return { ...host, runner };
}

describe("scheduler, SQLite and native worker recovery", () => {
  it.each(["main", "2.0", "origin/2.0"])(
    "hands off the authorized PR base and conditional next-release resolution for %s",
    async (baseRef) => {
      const { runner, harness } = setup(true);

      const configured = runner.store.saveRoute({
        ...route(),
        baseRef,
        delivery: "pr",
        githubRepository: "fixture/example",
      });

      let prompt: string | undefined;

      harness.inspection.sdk.stub(
        "threads.spawn",
        (input: Parameters<typeof runner.api.sdk.threads.spawn>[0]) => {
          prompt = input.prompt;

          return { id: "thr_owned", environmentId: "env_owned" };
        },
      );
      runner.store.enqueue(incident(), configured);
      await runner.dispatch();
      expect(prompt).toContain(
        `opens a draft PR into ${JSON.stringify(baseRef.replace(/^origin\//u, ""))} in "fixture/example"`,
      );
      expect(prompt).toContain("the enabled route authorizes this draft PR; do not ask again");
      expect(prompt).toContain("omnyo pursue goal --max 6 'Sentry run ");
      expect(prompt).toContain("omnyo pursue status");
      expect(prompt).toContain(
        "every authorized delivery and Sentry reconciliation step is verified",
      );
      expect(prompt).toContain("Use the bundled solve-sentry-issues skill");
      expect(prompt).toContain("Establish and record the intended development branch and version");
      expect(prompt).toContain(
        'omnyo thread spawn --parent-self --environment "$OMNYO_ENVIRONMENT_ID" --provider codex --model gpt-6.1-sol --reasoning-level max',
      );
      expect(prompt).toContain("even for a local or unmerged repair");
      expect(prompt).toContain("Never substitute unconditional resolution");
      expect(prompt).toContain("If submission would deploy production");
      expect(prompt).toContain("Read the state back after each change");
      expect(prompt).toContain("Merging is not enabled in Sentry plugin settings");
      expect(prompt).not.toContain("gh pr merge");
    },
  );

  it("authorizes the merge only after review, verification and required checks", async () => {
    const { runner, harness } = setup(true, true);

    const configured = runner.store.saveRoute({
      ...route(),
      delivery: "pr",
      githubRepository: "fixture/example",
    });

    runner.store.saveModelDefault("reviewer", {
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
    });

    let prompt: string | undefined;

    harness.inspection.sdk.stub(
      "threads.spawn",
      (input: Parameters<typeof runner.api.sdk.threads.spawn>[0]) => {
        prompt = input.prompt;

        return { id: "thr_owned", environmentId: "env_owned" };
      },
    );
    runner.store.enqueue(incident(), configured);
    await runner.dispatch();
    expect(prompt).toContain(
      "--provider claude-code --model claude-opus-5-5 --reasoning-level high --title",
    );
    expect(prompt).toContain("the independent reviewer's last verdict was APPROVE");
    expect(prompt).toContain("gh pr checks <number> --watch --required");
    expect(prompt).toContain("gh pr merge <number> --squash");
    expect(prompt).toContain("Never use --admin, bypass branch protection");
    expect(prompt).not.toContain("Merging is not enabled");
  });

  it("starts the solver on the model chosen for that start", async () => {
    const { runner, harness } = setup();
    const picked = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
    const spawned: unknown[] = [];

    harness.inspection.sdk.stub(
      "providers.models",
      (input: Parameters<typeof runner.api.sdk.providers.models>[0]) => ({
        models:
          input?.providerId === "claude-code"
            ? [{ id: "claude-opus-5-5", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }]
            : [],
      }),
    );
    harness.inspection.sdk.stub(
      "threads.spawn",
      (input: Parameters<typeof runner.api.sdk.threads.spawn>[0]) => {
        spawned.push(input);

        return { id: "thr_owned", environmentId: "env_owned" };
      },
    );

    const queued = runner.store.enqueue(incident(), route(), false, true);
    runner.store.updateRun(queued.id, { model: picked });
    await runner.dispatch();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
    });
    expect(spawned[0]).not.toHaveProperty("serviceTier");
    expect(runner.store.getRun(queued.id).model).toEqual(picked);
  });

  it("names the unavailable model and submits no worker", async () => {
    const { runner, harness } = setup();
    let spawned = 0;
    harness.inspection.sdk.stub("providers.models", () => ({ models: [] }));
    harness.inspection.sdk.stub("threads.spawn", () => {
      spawned++;

      return { id: "thr_owned", environmentId: "env_owned" };
    });

    const queued = runner.store.enqueue(incident(), route(), false, true);
    await runner.dispatch();
    expect(spawned).toBe(0);
    expect(runner.store.getRun(queued.id).state).toBe("failed");
    expect(runner.store.getRun(queued.id).reason).toContain("gpt-6.1-sol · max");
  });

  it("keeps an enabled PR handoff out of Sentry triage when the setting is off", async () => {
    const { runner, harness } = setup(false);

    const configured = runner.store.saveRoute({
      ...route(),
      delivery: "pr",
      githubRepository: "fixture/example",
    });

    let prompt: string | undefined;

    harness.inspection.sdk.stub(
      "threads.spawn",
      (input: Parameters<typeof runner.api.sdk.threads.spawn>[0]) => {
        prompt = input.prompt;

        return { id: "thr_owned", environmentId: "env_owned" };
      },
    );
    runner.store.enqueue(incident(), configured);
    await runner.dispatch();
    expect(prompt).toContain('opens a draft PR into "main" in "fixture/example"');
    expect(prompt).toContain(
      "triage is not enabled in Sentry plugin settings. Do not change any Sentry issue state",
    );
    expect(prompt).not.toContain("mark **resolved in the next release**");
    expect(prompt).not.toContain("redacting");
  });

  it.each(["local", "paused-pr"])(
    "keeps a %s handoff out of PR publication and Sentry resolution",
    async (mode) => {
      const { runner, harness } = setup();
      let prompt: string | undefined;

      harness.inspection.sdk.stub(
        "threads.spawn",
        (input: Parameters<typeof runner.api.sdk.threads.spawn>[0]) => {
          prompt = input.prompt;

          return { id: "thr_owned", environmentId: "env_owned" };
        },
      );

      const configured =
        mode === "local"
          ? route()
          : {
              ...route(),
              enabled: false,
              delivery: "pr" as const,
              githubRepository: "fixture/example",
            };

      runner.store.enqueue(incident(), configured);
      await runner.dispatch();
      expect(prompt).toContain(
        "this is a local-only run. Commit locally and submit through sentry_finish_run. Do not push, open a PR or merge.",
      );
      expect(prompt).toContain("triage is not enabled in Sentry plugin settings");
      expect(prompt).not.toContain("mark **resolved in the next release**");
      expect(prompt).not.toContain("opens a draft PR into");
      expect(prompt).not.toContain("gh pr merge");
    },
  );

  it("releases a preflight-only failure without losing the queued successor", async () => {
    const { runner, harness } = setup();
    const first = runner.store.enqueue(incident(), route());
    const second = runner.store.enqueue(incident("102"), route());
    harness.inspection.sdk.stub("providers.models", () => ({ models: [] }));
    await runner.dispatch();
    expect(runner.store.getRun(first.id).state).toBe("failed");
    expect(runner.store.hasClaim(first.id)).toBe(false);
    expect(runner.store.getRun(second.id).state).toBe("queued");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    harness.inspection.sdk.stub("providers.models", () => ({
      models: [{ id: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }],
    }));
    await runner.dispatch();
    expect(runner.store.getRun(second.id).threadId).toBe("thr_owned");
  });

  it("selects the oldest incident beyond the bounded status-page window", async () => {
    const { runner, harness } = setup();
    const first = runner.store.enqueue(incident("1000"), route());

    for (let index = 1001; index < 1102; index++)
      runner.store.enqueue(incident(String(index)), route());
    expect(runner.store.listRuns()).toHaveLength(100);
    await runner.dispatch();
    expect(runner.store.getRun(first.id).threadId).toBe("thr_owned");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("releases a verified idle result without calling runtime stop and starts its successor", async () => {
    const { runner, harness } = setup();
    const first = runner.store.enqueue(incident(), route());
    const second = runner.store.enqueue(incident("102"), route());
    let starts = 0;
    harness.inspection.sdk.stub("threads.spawn", () => ({
      id: ++starts === 1 ? "thr_owned" : "thr_successor",
      environmentId: "env_" + starts,
    }));
    await runner.dispatch();
    runner.store.updateRun(first.id, { state: "local-ready", result: retainedResult() });
    harness.inspection.sdk.stub("threads.stop", () => {
      throw new Error("Native runtime stop was refused");
    });
    await runner.idle("thr_owned");
    expect(runner.store.hasClaim(first.id)).toBe(false);
    expect(runner.store.getRun(second.id).threadId).toBe("thr_successor");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it.each(["active", "stopping", "error", "unavailable"])(
    "retains a completed claim when the native producer is %s",
    async (status) => {
      const { runner, harness } = setup();
      const first = runner.store.enqueue(incident(), route());
      runner.store.enqueue(incident("102"), route());
      await runner.dispatch();
      runner.store.updateRun(first.id, { state: "local-ready", result: retainedResult() });
      harness.inspection.sdk.stub("threads.get", () => {
        if (status === "unavailable") throw new Error("Host unavailable");

        return { id: "thr_owned", status };
      });
      await runner.idle("thr_owned");
      expect(runner.store.hasClaim(first.id)).toBe(true);
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    },
  );

  it.each(["queuedMessageCount", "activeBackgroundAgentCount"])(
    "retains execution while an idle completed owner still has %s",
    async (field) => {
      const { runner, harness } = setup();
      const first = runner.store.enqueue(incident(), route());
      await runner.dispatch();
      runner.store.updateRun(first.id, { state: "local-ready", result: retainedResult() });
      harness.inspection.sdk.stub("threads.get", () => ({
        id: "thr_owned",
        status: "idle",
        queuedMessageCount: 0,
        activeBackgroundAgentCount: 0,
        [field]: 1,
      }));
      await runner.idle("thr_owned");
      expect(runner.store.hasClaim(first.id)).toBe(true);
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    },
  );

  it("reconciles an idle settled claim through the supported recovery route without replacing its worker", async () => {
    const host = createFakePluginHost({
      pluginId: "sentry",
      sdk: {
        threads: {
          get: () => ({
            id: "thr_retained",
            status: "idle",
            queuedMessageCount: 0,
            activeBackgroundAgentCount: 0,
          }),
        },
      },
    });

    disposers.push(() => host.harness.lifecycle.dispose());
    await createSentryPlugin()(host.api);
    const runner = new SentryRunner(host.api, async () => ({ apiOrigin: "https://de.sentry.io" }));
    runner.store.saveRoute(route());
    const run = runner.store.enqueue(incident(), route(), false, true);
    runner.store.claimNext();
    runner.store.bindThread(run.id, "thr_retained", "env_retained");
    runner.store.updateRun(run.id, {
      state: "needs-evidence",
      result: retainedResult("needs-evidence"),
    });
    await host.harness.behavior.callRpc("queue.reconcile", null);
    expect(runner.store.hasClaim(run.id)).toBe(false);
    expect(runner.store.getRun(run.id).threadId).toBe("thr_retained");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("starts the explicitly retried queued owner ahead of ordinary backlog without creating a replacement", async () => {
    const { runner, harness } = setup();
    const earlier = runner.store.enqueue(incident(), route(), false, true);
    const selected = runner.store.enqueue(incident("102"), route(), false, true);
    const result = await runner.retry(selected.id);
    expect(result.id).toBe(selected.id);
    expect(result.threadId).toBe("thr_owned");
    expect(runner.store.getRun(earlier.id).state).toBe("queued");
    expect(runner.store.listRuns()).toHaveLength(2);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("promotes the same automatically queued owner for an explicit manual retry with auto solve off", async () => {
    const { runner } = setup();
    runner.store.savePolicy({ projectId: "proj_app", autoSolve: false, dailyLimit: 1 });
    const queued = runner.store.enqueue(incident(), route());
    expect(queued.manual).toBe(false);
    const started = await runner.retry(queued.id);
    expect(started.id).toBe(queued.id);
    expect(started.manual).toBe(true);
    expect(started.threadId).toBe("thr_owned");
    expect(runner.store.listRuns()).toHaveLength(1);
  });

  it("does not resume a released failed worker while a different incident owns execution", async () => {
    const { runner, harness } = setup();
    const first = runner.store.enqueue(incident(), route());
    await runner.dispatch();
    runner.store.updateRun(first.id, { state: "failed" });
    runner.store.release(first.id);
    const second = runner.store.enqueue(incident("102"), route());
    runner.store.claimNext();
    expect(runner.store.hasClaim(second.id)).toBe(true);
    await expect(runner.retry(first.id)).rejects.toThrow();
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("adopts a core-recorded launch after a lost spawn response without creating another worker", async () => {
    const { runner, harness } = setup();
    const queued = runner.store.enqueue(incident(), route());
    harness.inspection.sdk.stub("threads.spawn", () => {
      throw new Error("response lost after acceptance");
    });
    await runner.dispatch();
    expect(runner.store.hasClaim(queued.id)).toBe(true);
    harness.inspection.sdk.stub("threads.list", () => [
      { id: "thr_owned", environmentId: "env_owned" },
    ]);
    harness.inspection.sdk.stub("environments.get", () => ({
      environmentProviderId: "sentry-worktree",
      hostId: "host_mac",
      environmentProviderSelection: { inputs: { runId: queued.id, routeVersion: 1 } },
    }));
    harness.inspection.sdk.stub("threads.get", () => ({ id: "thr_owned", status: "active" }));
    await runner.reconcile();
    await runner.dispatch();
    expect(runner.store.getRun(queued.id).threadId).toBe("thr_owned");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("previews a paused route without enabling it or creating a worker", async () => {
    const host = createFakePluginHost({
      pluginId: "sentry",
      settings: { apiToken: "fixture-non-secret" },
    });

    disposers.push(() => host.harness.lifecycle.dispose());
    await createSentryPlugin(
      async () =>
        new Response(JSON.stringify([sentryIssue()]), {
          headers: { "content-type": "application/json" },
        }),
    )(host.api);
    await host.harness.behavior.callRpc("routes.save", route());
    const preview = await host.harness.behavior.callRpc("sync", { dryRun: true });
    expect(preview).toMatchObject({ scanned: 1, candidates: [{ id: "101" }] });
    expect(await host.harness.behavior.callRpc("status", null)).toMatchObject({
      routes: [{ enabled: false }],
      runs: [],
    });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it.each(["needs-evidence", "no-fix"] as const)(
    "refreshes an owned %s report after release without disturbing another producer",
    async (outcome) => {
      const { runner, harness } = setup();
      await createSentryPlugin()(runner.api);
      const first = runner.store.enqueue(incident(), route());
      await runner.dispatch();
      await runner.finish(
        "thr_owned",
        "proj_app",
        retainedResult(outcome),
        new AbortController().signal,
      );
      await runner.idle("thr_owned");
      expect(runner.store.hasClaim(first.id)).toBe(false);

      const other = runner.store.saveRoute({
        ...route(),
        id: "other",
        sentryProjectId: "200",
        repositoryPath: "/projects/umbrella/other",
      });

      const second = runner.store.enqueue(
        { ...incident("102"), projectId: "200", matchedRouteIds: ["other"] },
        other,
      );

      runner.store.claimNext();
      runner.store.bindThread(second.id, "thr_other", "env_other");
      runner.store.updateRun(second.id, { state: "investigating" });

      const queued = runner.store.enqueue(
        { ...incident("103"), projectId: "200", matchedRouteIds: ["other"] },
        other,
      );

      const batch = runner.store.saveBatch({
        id: "batch_waiting",
        projectId: "proj_app",
        hostId: "host_mac",
        sourceId: null,
        rootPath: "/projects/umbrella",
        routes: [other],
        incidents: [
          runner.store.getRun(second.id).incident,
          runner.store.getRun(queued.id).incident,
        ],
        state: "waiting",
        threadId: "thr_coordinator",
        spawnRequestedAt: "2026-10-19T00:00:00Z",
        summaryMarker: null,
        summarySentAt: null,
        runIds: [second.id, queued.id],
        blocked: [],
        summary: null,
        reason: null,
        reportRequests: 0,
        lastTurnSeq: null,
        createdAt: "2026-10-19T00:00:00Z",
        updatedAt: "2026-10-19T00:00:00Z",
      });

      const foreign = runner.store.getRun(second.id);
      const queuedBefore = runner.store.getRun(queued.id);
      let reloaded!: SentryRunner;

      const replacement = await harness.lifecycle.reload(async (api) => {
        await createSentryPlugin()(api);
        reloaded = new SentryRunner(api, async () => ({ apiOrigin: "https://de.sentry.io" }));
      });

      disposers.push(() => replacement.harness.lifecycle.dispose());
      const reloadedHarness = replacement.harness;
      reloadedHarness.inspection.sdk.stub("threads.get", (input: { threadId: string }) => ({
        id: input.threadId,
        status: "active",
        queuedMessageCount: 0,
        activeBackgroundAgentCount: 0,
      }));
      await reloadedHarness.behavior.callRpc("queue.reconcile", null);

      const revised = {
        ...retainedResult(outcome),
        summary: "Updated local proof; initiating failure remains blocked".padEnd(501, "."),
        commit: "b".repeat(40),
      };

      const response = await reloadedHarness.behavior.callAgentTool("sentry_finish_run", revised, {
        threadId: "thr_owned",
        projectId: "proj_app",
      });

      const updated = runSchema.parse(JSON.parse(z.string().parse(response)));
      expect(updated).toMatchObject({
        id: first.id,
        threadId: "thr_owned",
        state: outcome,
        result: revised,
      });
      expect(updated.reason).toHaveLength(500);
      expect(updated.reason).toContain("Updated local proof");
      expect(reloaded.store.getRun(first.id).result).toEqual(revised);
      expect(reloaded.store.hasClaim(first.id)).toBe(false);
      expect(reloaded.store.hasClaim(second.id)).toBe(true);
      expect(reloaded.store.getRun(second.id)).toEqual(foreign);
      expect(reloaded.store.getRun(queued.id)).toEqual(queuedBefore);
      expect(reloaded.store.getBatch(batch.id)).toEqual(batch);
      expect(reloadedHarness.experimental_hostRpcCalls).toHaveLength(0);
      expect(reloadedHarness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      expect(reloadedHarness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      expect(reloadedHarness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    },
  );

  it("resumes a claimed preflight after reload when no submission intent exists", async () => {
    const { runner, harness } = setup();
    const queued = runner.store.enqueue(incident(), route());
    runner.store.claimNext();
    harness.inspection.sdk.stub("threads.list", () => []);
    await runner.reconcile();
    await runner.dispatch();
    expect(runner.store.getRun(queued.id).threadId).toBe("thr_owned");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("keeps a delivered local result idempotent when Retry is invoked", async () => {
    const { runner, harness } = setup();
    const queued = runner.store.enqueue(incident(), route());
    await runner.dispatch();
    runner.store.updateRun(queued.id, { state: "local-ready", result: retainedResult() });
    await runner.idle("thr_owned");
    await runner.retry(queued.id);
    expect(runner.store.hasClaim(queued.id)).toBe(false);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
});
