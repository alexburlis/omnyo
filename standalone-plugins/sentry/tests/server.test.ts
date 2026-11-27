import { afterEach, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@omnyo/plugin-sdk/testing";
import { createSentryPlugin } from "../server";
import { incident, projects, route, sentryIssue } from "./fixtures";
import { SentryStore } from "../src/store";
import { SentryRunner } from "../src/runner";
import { completionSchema } from "../contract";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function setup() {
  const agentSkillIds = await readdir(new URL("../skills/", import.meta.url));
  const host = createFakePluginHost({ pluginId: "sentry", agentSkillIds });
  disposers.push(() => host.harness.lifecycle.dispose());
  await createSentryPlugin()(host.api);

  return host;
}

describe("native plugin boundary", () => {
  it("loads the entire selected project's small inbox outside the global preview", async () => {
    const host = await setup();
    const store = new SentryStore(host.api.storage);
    const client = store.saveRoute(route());

    const lumen = store.saveRoute({
      ...route(),
      id: "lumen",
      projectId: "proj_lumen",
      sentryProjectId: "200",
    });

    const date = "2026-10-18T12:00:00Z";
    store.acceptPage(
      client,
      Array.from({ length: 205 }, (_, i) => ({ ...incident(String(1000 + i)), lastSeen: date })),
      null,
      date,
    );
    store.acceptPage(
      lumen,
      ["1", "2", "3"].map((id) => ({ ...incident(id), projectId: "200" })),
      null,
      date,
    );

    const status = await host.harness.behavior.callRpc("status", null);
    expect(status).toMatchObject({
      projectIssueCounts: expect.arrayContaining([{ projectId: "proj_lumen", count: 3 }]),
    });
    expect(store.listIncidents().some((item) => item.projectId === "200")).toBe(false);

    const read = (props: Record<string, string | number>) =>
      host.harness.behavior.callRpc("inbox.list", props);

    await expect(read({ projectId: "proj_lumen" })).resolves.toMatchObject({
      total: 3,
      incidents: [{ projectId: "200" }, { projectId: "200" }, { projectId: "200" }],
    });
    await expect(read({ projectId: "proj_lumen", search: "CLIENT-2" })).resolves.toMatchObject({
      total: 1,
      incidents: [{ id: "2" }],
    });
    const next = await read({ projectId: client.projectId, offset: 200 });
    expect(next).toMatchObject({ total: 205 });
    expect(next).toHaveProperty("incidents.length", 5);
  });

  it("loads unconfigured without spawning or leaking connection data", async () => {
    const host = await setup();
    await host.harness.behavior.runSchedule("sync");
    const status = await host.harness.behavior.callRpc("status", null);
    expect(status).toMatchObject({ connected: false, routes: [], runs: [] });
    expect(JSON.stringify(status)).not.toContain("apiToken");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("saves a new route disabled even when a client supplies enabled=true", async () => {
    const host = await setup();
    const saved = await host.harness.behavior.callRpc("routes.save", route());
    expect(saved).toMatchObject({ id: "client", enabled: false });
    await host.harness.behavior.runSchedule("sync");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("does not grant worker tools based on forged display metadata", async () => {
    const host = await setup();

    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        pluginMetadata: { runId: "run_forged" },
      }),
    );

    expect(config?.tools ?? []).toEqual([]);
    expect(config.skills).toEqual([]);
  });

  it("supplies the bundled policy and adapter to the owned single-issue worker", async () => {
    const host = await setup();
    const store = new SentryStore(host.api.storage);
    const target = store.saveRoute(route());
    const run = store.enqueue(incident(), target, true, true);
    store.bindThread(run.id, "thr_solver", "env_solver");

    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_solver" },
        project: { id: target.projectId },
        host: { id: target.hostId },
      }),
    );

    expect(config.skills).toEqual(["sentry", "solve-sentry-issues"]);

    for (const name of config.skills) {
      const body = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
      expect(body).toContain(`name: ${name}`);
    }

    expect(config.tools.map((tool) => tool.name)).toEqual([
      "sentry_run_context",
      "sentry_finish_run",
      "sentry_wait_for_diagnostics_release",
    ]);
  });
});

async function coordinatorFixture() {
  const host = await setup();
  const store = new SentryStore(host.api.storage);
  const configured = store.saveRoute(route());
  const issue = incident();

  const batch = store.saveBatch({
    id: "batch_reporting",
    projectId: configured.projectId,
    hostId: configured.hostId,
    sourceId: null,
    rootPath: "/projects/umbrella",
    routes: [configured],
    incidents: [issue],
    state: "waiting",
    threadId: "thr_coordinator",
    spawnRequestedAt: "2026-10-19T00:00:00Z",
    summaryMarker: null,
    summarySentAt: null,
    runIds: [],
    blocked: [],
    summary: null,
    reason: null,
    reportRequests: 0,
    lastTurnSeq: null,
    createdAt: "2026-10-19T00:00:00Z",
    updatedAt: "2026-10-19T00:00:00Z",
  });

  const context = {
    thread: { id: "thr_coordinator" },
    project: { id: configured.projectId },
    host: { id: configured.hostId },
  };

  const toolContext = { threadId: "thr_coordinator", projectId: configured.projectId };

  const blocked = [
    { issueKey: issue.key, reason: "Historical initiating evidence is unavailable" },
  ];

  return { host, store, batch, issue, context, toolContext, blocked };
}

describe("project completion guard", () => {
  it("refuses to complete a batch when all issues are explicitly blocked", async () => {
    const f = await coordinatorFixture();
    await expect(
      f.host.harness.behavior.callAgentTool(
        "sentry_finish_project",
        { summary: "All issues need evidence", blocked: f.blocked },
        f.toolContext,
      ),
    ).rejects.toThrow(/blocked/i);
    expect(f.store.getBatch(f.batch.id)).toMatchObject({ state: "planning", blocked: f.blocked });
  });

  it.each(["approval", "required question"])(
    "refuses terminal completion while a native %s is pending",
    async (gate) => {
      const f = await coordinatorFixture();
      const run = f.store.enqueue(f.issue, f.batch.routes[0]!, true, true);
      f.store.updateRun(run.id, {
        state: "no-fix",
        threadId: "thr_worker",
        result: completionSchema.parse({
          outcome: "no-fix",
          classification: "Proven by inspection",
          summary: "Expected cancellation",
          rootCause: "The request was cancelled by the user",
          issueFindings: [
            {
              key: f.issue.key,
              outcome: "not-actionable",
              summary: "Verified cancellation path",
              evidence: ["tests/cancellation.test.ts"],
            },
          ],
        }),
      });
      let pending = true;
      f.host.harness.inspection.sdk.stub(
        "threads.interactions.list",
        ({ threadId }: { threadId: string }) =>
          pending && gate === "approval" && threadId === f.toolContext.threadId
            ? [{ status: "pending", payload: { kind: "approval" } }]
            : [],
      );
      f.host.harness.inspection.sdk.stub(
        "experimental_attention.history",
        ({ threadId }: { threadId: string }) => ({
          callbacks: [],
          questions:
            threadId === "thr_worker" && gate === "required question"
              ? [{ state: "open", question: { mode: pending ? "required" : "optional" } }]
              : [],
        }),
      );

      const submit = () =>
        f.host.harness.behavior.callAgentTool(
          "sentry_finish_project",
          { summary: "Verified the incident was an expected cancellation", blocked: [] },
          f.toolContext,
        );

      await expect(submit()).rejects.toThrow(/approval/i);
      expect(f.store.getBatch(f.batch.id)).toMatchObject({
        state: "planning",
        reason: expect.stringMatching(/pending/i),
      });
      pending = false;
      await submit();
      expect(f.store.getBatch(f.batch.id).state).toBe("complete");
    },
  );
});

describe("completed coordinator reporting configuration", () => {
  it("retains context and final reporting after completion without granting package execution", async () => {
    const f = await coordinatorFixture();

    const active = await f.host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(f.context),
    );

    expect(active.tools.map((tool) => tool.name)).toEqual([
      "sentry_project_context",
      "sentry_queue_package",
      "sentry_finish_project",
    ]);
    expect(active.skills).toEqual(["sentry", "solve-sentry-issues"]);
    // A batch closed by an older runtime remains available for reporting.
    f.store.updateBatch(f.batch.id, {
      state: "complete",
      summary: "Historical batch summary",
      blocked: f.blocked,
    });

    const completed = await f.host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(f.context),
    );

    expect(completed.tools.map((tool) => tool.name)).toEqual([
      "sentry_project_context",
      "sentry_finish_project",
    ]);
    expect(completed.skills).toEqual(["sentry", "solve-sentry-issues"]);
    expect(completed.instructions).toContain("A new user request is separate");
    await expect(
      f.host.harness.behavior.callAgentTool(
        "sentry_queue_package",
        {
          routeId: "client",
          issueKeys: [f.blocked[0]!.issueKey],
          title: "Unexpected execution",
          rationale: "Completed reporting must not reopen package execution",
        },
        f.toolContext,
      ),
    ).rejects.toThrow();

    const context = await f.host.harness.behavior.callAgentTool(
      "sentry_project_context",
      { offset: 0 },
      f.toolContext,
    );

    expect(JSON.parse(String(context))).toMatchObject({
      batch: { id: f.batch.id, state: "complete", threadId: "thr_coordinator" },
      total: 1,
      issues: [{ issue: { key: f.blocked[0]!.issueKey }, owner: null }],
      packages: [],
    });
    const revisedSummary = "Updated proof accepted; historical initiating evidence remains blocked";
    await f.host.harness.behavior.callAgentTool(
      "sentry_finish_project",
      { summary: revisedSummary, blocked: f.blocked },
      f.toolContext,
    );
    expect(new SentryStore(f.host.api.storage).getBatch(f.batch.id)).toMatchObject({
      state: "complete",
      summary: revisedSummary,
      blocked: f.blocked,
      runIds: [],
    });
    expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("refuses a completed report refresh while a package is active without reopening execution", async () => {
    const f = await coordinatorFixture();
    const pending = f.store.enqueue(incident(), f.batch.routes[0]!, true, true);
    expect(f.store.claimNext()?.id).toBe(pending.id);

    const activeRun = f.store.updateRun(pending.id, {
      state: "investigating",
      threadId: "thr_active_worker",
    });

    expect(f.store.hasClaim(pending.id)).toBe(true);
    f.store.updateBatch(f.batch.id, {
      state: "complete",
      summary: "Original accepted summary",
      blocked: f.blocked,
      runIds: [pending.id],
    });
    await expect(
      f.host.harness.behavior.callAgentTool(
        "sentry_finish_project",
        { summary: "Premature update", blocked: f.blocked },
        f.toolContext,
      ),
    ).rejects.toThrow();
    expect(f.store.getBatch(f.batch.id)).toMatchObject({
      state: "complete",
      summary: "Original accepted summary",
      blocked: f.blocked,
      runIds: [pending.id],
    });

    const config = await f.host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(f.context),
    );

    expect(config.tools.map((tool) => tool.name)).not.toContain("sentry_queue_package");
    expect(f.store.getRun(pending.id)).toEqual(activeRun);
    expect(f.store.hasClaim(pending.id)).toBe(true);
    expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("refuses context and final-report execution while the coordinator is stopping", async () => {
    const f = await coordinatorFixture();
    f.store.updateBatch(f.batch.id, { state: "stopping" });
    await expect(
      f.host.harness.behavior.callAgentTool("sentry_project_context", { offset: 0 }, f.toolContext),
    ).rejects.toThrow();
    await expect(
      f.host.harness.behavior.callAgentTool(
        "sentry_finish_project",
        { summary: "Premature update", blocked: f.blocked },
        f.toolContext,
      ),
    ).rejects.toThrow();
    expect(f.store.getBatch(f.batch.id)).toMatchObject({ state: "stopping", summary: null });
    expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it.each(["wrong thread", "wrong project", "wrong host", "cancelled", "failed"] as const)(
    "withholds coordinator tools for %s",
    async (scenario) => {
      const f = await coordinatorFixture();
      f.store.updateBatch(f.batch.id, {
        state: scenario === "cancelled" || scenario === "failed" ? scenario : "complete",
      });

      const context = {
        thread: { id: scenario === "wrong thread" ? "thr_foreign" : "thr_coordinator" },
        project: { id: scenario === "wrong project" ? "proj_foreign" : f.batch.projectId },
        host: { id: scenario === "wrong host" ? "host_foreign" : f.batch.hostId! },
      };

      const config = await f.host.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext(context),
      );

      expect(config.tools).toEqual([]);
      expect(config.skills).toEqual([]);

      if (scenario !== "wrong host") {
        const toolContext = { threadId: context.thread.id, projectId: context.project.id };
        await expect(
          f.host.harness.behavior.callAgentTool(
            "sentry_project_context",
            { offset: 0 },
            toolContext,
          ),
        ).rejects.toThrow();
        await expect(
          f.host.harness.behavior.callAgentTool(
            "sentry_finish_project",
            { summary: "Unauthorized update", blocked: f.blocked },
            toolContext,
          ),
        ).rejects.toThrow();
      }

      expect(f.host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    },
  );
});

describe("responsive background work", () => {
  it("acknowledges sync before a gated Sentry scan, coalesces clicks and retains failures", async () => {
    let release!: (value: Response) => void;

    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });

    let requests = 0;

    const host = createFakePluginHost({
      pluginId: "sentry",
      settings: { apiToken: "fixture-non-secret" },
    });

    disposers.push(() => host.harness.lifecycle.dispose());
    await createSentryPlugin(async () => {
      requests++;

      return response;
    })(host.api);
    await host.harness.behavior.callRpc("routes.save", route());
    await host.harness.behavior.callRpc("routes.enable", { id: "client", enabled: true });

    try {
      const result = await Promise.race([
        host.harness.behavior.callRpc("sync.start", null),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);

      expect(result).toEqual({ accepted: true });
      expect(await host.harness.behavior.callRpc("status", null)).toMatchObject({ syncing: true });
      await host.harness.behavior.callRpc("sync.start", null);
      expect(requests).toBe(1);
    } finally {
      release(new Response("", { status: 503 }));
    }

    await host.harness.behavior.runSchedule("sync");
    expect(await host.harness.behavior.callRpc("status", null)).toMatchObject({
      syncing: false,
      lastError: "provider-failure",
    });
  });

  it("returns the durable queued run while native startup is gated and keeps duplicate ownership", async () => {
    let release!: (value: { id: string; environmentId: string }) => void;

    const spawned = new Promise<{ id: string; environmentId: string }>((resolve) => {
      release = resolve;
    });

    const host = createFakePluginHost({
      pluginId: "sentry",
      sdk: {
        projects,
        providers: {
          models: () => ({
            models: [
              { id: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "max" }] },
            ],
          }),
        },
        threads: { spawn: () => spawned },
      },
    });

    const runner = new SentryRunner(
      host.api,
      async () => ({ apiOrigin: "https://de.sentry.io", apiToken: "fixture-non-secret" }),
      async () =>
        new Response(JSON.stringify(sentryIssue()), {
          headers: { "content-type": "application/json" },
        }),
    );

    disposers.push(async () => {
      await runner.dispose();
      await host.harness.lifecycle.dispose();
    });
    runner.store.saveRoute(route());

    try {
      const result = await Promise.race([
        runner.investigate("client", "https://acme.sentry.io/issues/101/", "local"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);

      expect(result).toMatchObject({ id: expect.any(String), state: "queued", manual: true });

      const duplicate = await runner.investigate(
        "client",
        "https://acme.sentry.io/issues/101/",
        "local",
      );

      expect(duplicate.id).toBe(runner.store.listRuns()[0]!.id);
      expect(runner.store.listRuns()).toHaveLength(1);
    } finally {
      release({ id: "thr_owned", environmentId: "env_owned" });
    }

    await runner.dispatch();
    expect(runner.store.listRuns()[0]).toMatchObject({
      state: "investigating",
      threadId: "thr_owned",
    });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("reports a background connection failure instead of leaving a permanent syncing indicator", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    disposers.push(() => host.harness.lifecycle.dispose());
    await createSentryPlugin()(host.api);
    await host.harness.behavior.callRpc("routes.save", route());
    const store = new (await import("../src/store")).SentryStore(host.api.storage);
    store.saveRoute(route());
    expect(await host.harness.behavior.callRpc("sync.start", null)).toEqual({ accepted: true });
    await expect(host.harness.behavior.runSchedule("sync")).rejects.toThrow("access-denied");
    expect(await host.harness.behavior.callRpc("status", null)).toMatchObject({
      syncing: false,
      lastError: "access-denied",
    });
  });
});
