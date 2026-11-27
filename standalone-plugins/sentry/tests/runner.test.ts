import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import { SentryRunner, WorkerNotStarted } from "../src/runner";
import { SentryStore } from "../src/store";
import { incident, projects, route } from "./fixtures";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function setup() {
  const host = createFakePluginHost({ pluginId: "sentry" });
  disposers.push(() => host.harness.lifecycle.dispose());
  const store = new SentryStore(host.api.storage);
  store.saveRoute(route());
  store.savePolicy({ projectId: route().projectId, autoSolve: true, dailyLimit: 10 });

  return store;
}

describe("durable dispatch and ownership", () => {
  it("does not recover a claim while its existing launch is still in preflight", async () => {
    let release = () => {};

    let entered = () => {};

    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });

    const preflight = new Promise<void>((resolve) => {
      entered = resolve;
    });

    let launches = 0;

    const host = createFakePluginHost({
      pluginId: "sentry",
      sdk: {
        projects,
        providers: {
          models: async () => {
            entered();
            await ready;

            return { models: [{ id: "gpt-6.1-sol" }] };
          },
        },
        threads: {
          spawn: () => ({ id: "thr_fixture_" + ++launches, environmentId: null }),
        },
      },
    });

    disposers.push(() => host.harness.lifecycle.dispose());
    const runner = new SentryRunner(host.api, async () => ({ apiOrigin: "https://de.sentry.io" }));
    const configured = runner.store.saveRoute(route());
    const run = runner.store.enqueue(incident(), configured, false, true);
    const first = runner.dispatch();
    await preflight;

    try {
      await runner.reconcile();
    } finally {
      release();
    }

    await Promise.all([first, runner.dispatch()]);
    expect(launches).toBe(1);
    expect(runner.store.hasClaim(run.id)).toBe(true);
    expect(runner.store.getRun(run.id).threadId).toBe("thr_fixture_1");
  });

  it("reuses the workspace attached after launching the investigation worker", async () => {
    const configured = route();
    const path = "/worktrees/sentry-fix";
    const launched: unknown[] = [];
    let workspaceRunId = "wrong-run";

    const host = createFakePluginHost({
      pluginId: "sentry",
      sdk: {
        providers: {
          models: () => ({
            models: [
              { id: "gpt-6.2-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
            ],
          }),
        },
        threads: {
          spawn: (request) => {
            launched.push(request);

            return launched.length === 1
              ? { id: "thr_investigate", environmentId: null }
              : {
                  id: "thr_repair",
                  environmentId:
                    request.environment?.type === "reuse"
                      ? request.environment.environmentId
                      : null,
                };
          },
          get: ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              projectId: configured.projectId,
              originPluginId: "sentry",
              environmentId: "env_fix",
              status: "idle",
            }),
        },
        environments: {
          get: () => ({
            id: "env_fix",
            projectId: configured.projectId,
            hostId: configured.hostId,
            path,
            status: "ready",
            lifecycle: { phase: "active" },
            environmentProviderId: "sentry-worktree",
            environmentProviderSelection: {
              inputs: { runId: workspaceRunId, routeVersion: configured.version },
            },
          }),
        },
      },
    });

    disposers.push(() => host.harness.lifecycle.dispose());

    const runner = new SentryRunner(host.api, async () => ({
      apiOrigin: "https://sentry.invalid",
    }));

    const run = runner.store.enqueue(incident(), configured);
    runner.store.saveModelDefault("solver", {
      providerId: "codex",
      model: "gpt-6.2-sol",
      reasoningLevel: "high",
      serviceTier: "default",
    });

    await runner.startWorkflowWorker(run.id, "investigate", "try_first", "investigate", false);
    runner.store.updateRun(run.id, { worktreePath: path });
    const unready = runner.startWorkflowWorker(run.id, "repair", "try_second", "repair", false);

    await expect(unready).rejects.toThrow("workspace is not ready for reuse");
    await expect(unready).rejects.toBeInstanceOf(WorkerNotStarted);
    expect(launched).toHaveLength(1);

    workspaceRunId = run.id;
    await runner.startWorkflowWorker(run.id, "repair", "try_second", "repair", false);

    expect(launched).toMatchObject([
      {
        model: "gpt-6.2-sol",
        reasoningLevel: "high",
        environment: { type: "provider" },
      },
      {
        model: "gpt-6.2-sol",
        reasoningLevel: "high",
        environment: { type: "reuse", environmentId: "env_fix" },
      },
    ]);
    expect(runner.store.getRun(run.id).environmentId).toBe("env_fix");
  });

  it("refuses a worker before creating its chat while another run holds the execution slot", async () => {
    const launched: unknown[] = [];

    const host = createFakePluginHost({
      pluginId: "sentry",
      sdk: {
        threads: {
          spawn: (request) => {
            launched.push(request);

            return { id: "thr_unexpected", environmentId: null };
          },
        },
      },
    });

    disposers.push(() => host.harness.lifecycle.dispose());

    const runner = new SentryRunner(host.api, async () => ({
      apiOrigin: "https://sentry.invalid",
    }));

    const waiting = runner.store.enqueue(incident("101"), route());
    const holder = runner.store.enqueue(incident("102"), route());
    runner.store.reclaim(holder.id);

    const refused = runner.startWorkflowWorker(waiting.id, "repair", "try_busy", "repair", false);

    await expect(refused).rejects.toBeInstanceOf(WorkerNotStarted);
    await expect(refused).rejects.toThrow(
      "Another investigation (CLIENT-102) is using the execution slot",
    );
    expect(launched).toEqual([]);
    expect(runner.store.hasClaim(waiting.id)).toBe(false);
    expect(runner.store.hasClaim(holder.id)).toBe(true);
  });

  it("imports the first page as a baseline, then queues only a new incident", () => {
    const store = setup();
    const configured = route();
    store.acceptPage(configured, [incident()], null, "2026-10-18T10:10:00Z");
    expect(store.listRuns()).toHaveLength(0);
    expect(store.listIncidents()).toHaveLength(1);
    store.acceptPage(configured, [incident(), incident("102")], null, "2026-10-18T10:15:00Z");
    expect(store.listRuns().map((row) => row.incident.id)).toEqual(["102"]);
  });

  it("does not finish a watermark until all pages are stored", () => {
    const store = setup();
    const configured = route();
    store.acceptPage(configured, [incident()], "next", "2026-10-18T10:10:00Z");
    expect(store.sync(configured.id).completedAt).toBeNull();
    expect(store.sync(configured.id).cursor).toBe("next");
    store.acceptPage(configured, [incident("102")], null, "2026-10-18T10:10:00Z");
    expect(store.sync(configured.id).completedAt).toBe("2026-10-18T10:10:00Z");
    expect(store.listRuns()).toHaveLength(0);
  });

  it("keeps repeated events and concurrent queue attempts with one owner", () => {
    const store = setup();
    const configured = route();
    const first = store.enqueue(incident(), configured);
    const second = store.enqueue(incident(), configured);
    expect(second.id).toBe(first.id);
    expect(store.listRuns()).toHaveLength(1);
    expect(store.claimNext()?.id).toBe(first.id);
    expect(store.claimNext()).toBeNull();
  });

  it("serializes repository work until the recorded producer has stopped", () => {
    const store = setup();
    const first = store.enqueue(incident(), route());
    store.enqueue(incident("102"), route());
    expect(store.claimNext()?.id).toBe(first.id);
    store.updateRun(first.id, { state: "local-ready" });
    expect(store.claimNext()).toBeNull();
    store.release(first.id);
    expect(store.claimNext()?.incident.id).toBe("102");
  });

  it("retains a bound thread across a fresh store instance and does not duplicate its run", () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    disposers.push(() => host.harness.lifecycle.dispose());
    const first = new SentryStore(host.api.storage);
    first.saveRoute(route());
    first.savePolicy({ projectId: route().projectId, autoSolve: true, dailyLimit: 10 });
    const run = first.enqueue(incident(), route());
    first.claimNext();
    first.bindThread(run.id, "thr_real", "env_real");
    const reloaded = new SentryStore(host.api.storage);
    expect(reloaded.getRun(run.id).threadId).toBe("thr_real");
    expect(reloaded.enqueue(incident(), route()).id).toBe(run.id);
    expect(reloaded.claimNext()).toBeNull();
  });

  it("keeps route snapshots fixed while pause revokes publication", () => {
    const store = setup();
    const configured = store.saveRoute({ ...route(), enabled: true });
    const run = store.enqueue(incident(), configured);
    store.saveRoute({ ...configured, enabled: false, baseRef: "different" });
    expect(store.getRun(run.id).route.baseRef).toBe("main");
    expect(store.getRoute(configured.id).enabled).toBe(false);
  });
});

it("preserves a legacy queued package's handoff pointer when dispatch clears its status reason", () => {
  const host = createFakePluginHost({ pluginId: "legacy-fixture" });
  disposers.push(() => host.harness.lifecycle.dispose());
  const legacyStore = new SentryStore(host.api.storage);
  legacyStore.saveRoute(route());
  const legacy = legacyStore.enqueue(incident(), route(), false, true);
  const db = host.api.storage.database();

  const payload = {
    ...legacy,
    batchId: "batch_legacy",
    reason: "Full handoff: /retained/package-handoff.md",
  };

  Reflect.deleteProperty(payload, "packageHandoff");
  db.prepare("UPDATE runs SET payload=? WHERE id=?").run(JSON.stringify(payload), legacy.id);
  legacyStore.saveBatch({
    id: "batch_legacy",
    projectId: "proj_app",
    hostId: "host_mac",
    sourceId: null,
    rootPath: null,
    routes: [route()],
    incidents: [incident()],
    state: "planning",
    threadId: "thr_coordinator",
    spawnRequestedAt: null,
    summaryMarker: null,
    summarySentAt: null,
    runIds: [legacy.id],
    blocked: [],
    summary: null,
    reason: null,
    reportRequests: 0,
    lastTurnSeq: null,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  });
  legacyStore.claimNext();
  expect(legacyStore.getRun(legacy.id).reason).toBeNull();
  expect(legacyStore.getRun(legacy.id).packageHandoff).toBe(
    "Full handoff: /retained/package-handoff.md",
  );
});

it("retains an explicit queued selection across a busy slot and restart without bypassing route guards", () => {
  const host = createFakePluginHost({ pluginId: "manual-selection" });
  disposers.push(() => host.harness.lifecycle.dispose());
  const store = new SentryStore(host.api.storage);
  const configured = store.saveRoute(route());
  const active = store.enqueue(incident(), configured, false, true);
  store.claimNext();
  const older = store.enqueue(incident("102"), configured, false, true);
  const selected = store.enqueue(incident("103"), configured, false, true);
  store.requestStart(selected.id);
  expect(store.claimNext()).toBeNull();
  const reloaded = new SentryStore(host.api.storage);
  reloaded.release(active.id);
  expect(reloaded.claimNext()?.id).toBe(selected.id);
  reloaded.release(selected.id);
  const blocked = store.enqueue(incident("104"), configured, false, true);
  store.requestStart(blocked.id);
  store.saveRoute({ ...configured, baseRef: "other" });
  expect(store.claimNext()).toBeNull();
  expect(store.getRun(older.id).threadId).toBeNull();
  expect(store.getRun(blocked.id).reason).toContain("Route changed");
  expect(store.getRun(blocked.id).manualStartRequestedAt).not.toBeNull();
});
