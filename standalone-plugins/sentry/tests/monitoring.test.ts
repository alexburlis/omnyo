import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { SentryStore } from "../src/store";
import { SentryRunner } from "../src/runner";
import { incident, route, sentryIssue } from "./fixtures";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();

  for (const dispose of disposers.splice(0)) await dispose();
});

function setup() {
  const host = createFakePluginHost({ pluginId: "sentry" });
  disposers.push(() => host.harness.lifecycle.dispose());
  const store = new SentryStore(host.api.storage);
  store.saveRoute(route());

  return { ...host, store };
}

const optIn = { projectId: "proj_app", autoSolve: true, dailyLimit: 2 };

describe("native asynchronous environment binding", () => {
  it("preserves the registered environment when spawn initially returns a null environment ID", () => {
    const { store } = setup();
    const queued = store.enqueue(incident(), route(), false, true);
    store.bindThread(queued.id, "thr_registered", "env_registered");
    store.bindThread(queued.id, "thr_registered", null);
    expect(store.getRun(queued.id).environmentId).toBe("env_registered");
  });
});

describe("opt-in monitoring and automatic start allowance", () => {
  it("watches a legacy enabled route without launching automatic solvers, including after reload", () => {
    const { store, api } = setup();
    store.acceptPage(route(), [incident()], null, "2026-10-18T10:00:00Z");
    store.acceptPage(route(), [incident(), incident("102")], null, "2026-10-18T10:05:00Z");
    const reloaded = new SentryStore(api.storage);
    expect(reloaded.policy("proj_app")).toEqual({
      projectId: "proj_app",
      autoSolve: false,
      dailyLimit: 10,
    });
    expect(reloaded.listRuns()).toHaveLength(0);
    expect(reloaded.badge()).toMatchObject({ count: 2, watchedRoutes: 1 });
    reloaded.enqueue(incident("103"), route());
    expect(reloaded.claimNext()).toBeNull();
  });

  it("starts only new observations after opt-in and promotes a queued automatic run for manual start", () => {
    const { store } = setup();
    store.acceptPage(route(), [incident()], null, "2026-10-18T10:00:00Z");
    store.savePolicy(optIn);
    store.acceptPage(route(), [incident()], null, "2026-10-18T10:05:00Z");
    expect(store.listRuns()).toHaveLength(0);
    store.acceptPage(route(), [incident(), incident("102")], null, "2026-10-18T10:10:00Z");
    const queued = store.listRuns()[0]!;
    store.savePolicy({ ...optIn, autoSolve: false });
    expect(store.claimNext()).toBeNull();
    const manual = store.enqueue(incident("102"), route(), false, true);
    expect(manual.id).toBe(queued.id);
    expect(manual.manual).toBe(true);
    expect(store.claimNext()?.id).toBe(queued.id);
    expect(store.policyUsage("proj_app").started).toBe(0);
  });

  it("holds an old queued target after reconfiguration and binds an explicit manual selection to the current route", () => {
    const { store } = setup();
    store.savePolicy(optIn);
    const old = store.enqueue(incident(), route());
    const changed = store.saveRoute({ ...route(), baseRef: "next" });
    expect(store.claimNext()).toBeNull();
    const manual = store.enqueue(incident(), changed, false, true);
    expect(manual.id).not.toBe(old.id);
    expect(store.getRun(old.id).state).toBe("cancelled");
    expect(manual.route.baseRef).toBe("next");
    expect(store.claimNext()?.id).toBe(manual.id);
  });

  it("honors an explicit local manual request when the existing queued automatic candidate requested PR delivery", () => {
    const { store } = setup();
    store.savePolicy(optIn);
    const pr = store.saveRoute({ ...route(), delivery: "pr", githubRepository: "owner/client" });
    const automatic = store.enqueue(incident(), pr);
    const manual = store.enqueue(incident(), { ...pr, delivery: "local" }, false, true);
    expect(manual.route.delivery).toBe("local");
    expect(store.getRun(automatic.id).state).toBe("cancelled");
  });

  it("enforces durable per-project UTC daily limits, without charging manual starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T23:59:00Z"));
    const { store, api } = setup();
    store.savePolicy(optIn);

    for (const id of ["201", "202", "203"]) store.enqueue(incident(id), route());

    for (let index = 0; index < 2; index++) {
      const claimed = store.claimNext()!;
      store.updateRun(claimed.id, { spawnRequestedAt: new Date().toISOString(), state: "no-fix" });
      store.release(claimed.id);
    }

    const reloaded = new SentryStore(api.storage);
    expect(reloaded.policyUsage("proj_app")).toMatchObject({
      day: "2026-10-18",
      started: 2,
      remaining: 0,
    });
    expect(reloaded.claimNext()).toBeNull();

    const other = {
      ...route(),
      id: "other",
      name: "Other",
      projectId: "proj_other",
      environment: "staging",
    };

    reloaded.saveRoute(other);
    reloaded.savePolicy({ ...optIn, projectId: "proj_other" });
    const independent = reloaded.enqueue(incident("301"), other);
    expect(reloaded.claimNext()?.id).toBe(independent.id);
    reloaded.updateRun(independent.id, {
      spawnRequestedAt: new Date().toISOString(),
      state: "no-fix",
    });
    reloaded.release(independent.id);
    const manual = reloaded.enqueue(incident("204"), route(), false, true);
    expect(reloaded.claimNext()?.id).toBe(manual.id);
    reloaded.updateRun(manual.id, { state: "no-fix" });
    reloaded.release(manual.id);
    vi.setSystemTime(new Date("2026-10-19T00:00:01Z"));
    expect(reloaded.policyUsage("proj_app")).toMatchObject({ started: 0, remaining: 2 });
    expect(reloaded.claimNext()?.incident.id).toBe("203");
  });

  it("refunds only unsubmitted preflight reservations and keeps accepted starts counted", () => {
    const { store } = setup();
    store.savePolicy({ ...optIn, dailyLimit: 1 });
    const first = store.enqueue(incident(), route());
    store.claimNext();
    expect(store.policyUsage("proj_app").started).toBe(1);
    store.updateRun(first.id, { state: "failed" });
    store.release(first.id);
    expect(store.policyUsage("proj_app").started).toBe(0);
    const second = store.enqueue(incident("102"), route());
    store.claimNext();
    store.updateRun(second.id, { spawnRequestedAt: new Date().toISOString(), state: "failed" });
    store.release(second.id);
    expect(store.policyUsage("proj_app").started).toBe(1);
    store.reclaim(second.id);
    expect(store.policyUsage("proj_app").started).toBe(1);
    expect(() => store.savePolicy({ ...optIn, dailyLimit: 0 })).toThrow();
  });
});

describe("current open-issue membership and badge", () => {
  it("counts every distinct open issue beyond the visible page, then retires membership only after a complete scan", () => {
    const { store } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T10:06:00Z"));
    const firstPage = Array.from({ length: 200 }, (_, index) => incident(String(index + 1000)));
    store.acceptPage(route(), firstPage, "page-2", "2026-10-18T10:00:00Z");
    store.acceptPage(route(), [incident("1300")], null, "2026-10-18T10:00:00Z");
    expect(store.listIncidents()).toHaveLength(200);
    expect(store.badge().count).toBe(201);
    store.acceptPage(route(), [incident("1300")], "page-2", "2026-10-18T10:05:00Z");
    expect(store.badge()).toMatchObject({ count: 201, freshness: "partial" });
    store.saveSync("client", { ...store.sync("client"), error: "network-error" });
    expect(store.badge()).toMatchObject({ count: 201, freshness: "stale" });
    store.acceptPage(route(), [], null, "2026-10-18T10:05:00Z");
    expect(store.badge().count).toBe(1);
    expect(store.listIncidents().map((value) => value.id)).toEqual(["1300"]);
    store.saveRoute({ ...route(), enabled: false });
    expect(store.badge()).toMatchObject({ count: 0, freshness: "unconfigured" });
  });

  it("clears obsolete membership and baseline when a paused route changes its scope", () => {
    const { store } = setup();
    store.acceptPage(route(), [incident()], null, "2026-10-18T10:00:00Z");
    store.savePolicy(optIn);
    const changed = store.saveRoute({ ...route(), enabled: false, environment: "staging" });
    const watched = store.saveRoute({ ...changed, enabled: true });
    expect(store.sync(watched.id).completedAt).toBeNull();
    expect(store.badge().count).toBe(0);
    store.acceptPage(watched, [incident("102")], null, "2026-10-18T10:05:00Z");
    expect(store.listRuns()).toHaveLength(0);
  });

  it("starts with a clean membership and scan cursor after an issue level filter changes", () => {
    const { store } = setup();
    store.acceptPage(route(), [incident()], "stale-cursor", "2026-10-18T10:00:00Z");

    const paused = store.saveRoute({ ...route(), enabled: false, levels: ["fatal"] });
    const watched = store.saveRoute({ ...paused, enabled: true });

    expect(store.sync(watched.id)).toMatchObject({ cursor: null, scanStartedAt: null });
    expect(store.listIncidents()).toEqual([]);
  });

  it("refuses a wildcard environment that overlaps an enabled route in the same scope", () => {
    const { store } = setup();
    expect(() => store.saveRoute({ ...route(), id: "all", environment: "*" })).toThrow(
      "Route overlaps an enabled route: client",
    );

    const scoped = store.saveRoute({
      ...route(),
      id: "other",
      environment: "*",
      sentryProjectId: "200",
    });

    expect(scoped.enabled).toBe(true);
  });

  it("ignores an in-flight page from the previous route version", () => {
    const { store } = setup();
    const previous = store.getRoute("client");
    store.saveRoute({ ...previous, enabled: false, environment: "staging" });
    store.saveRoute({ ...store.getRoute("client"), enabled: true });
    store.acceptPage(previous, [incident()], null, "2026-10-18T10:05:00Z");
    expect(store.badge().count).toBe(0);
    expect(store.sync("client").completedAt).toBeNull();
  });

  it("deduplicates badges across watched routes and retains historical run evidence", () => {
    const { store } = setup();
    const second = { ...route(), id: "other", environment: "staging" };
    store.saveRoute(second);
    store.acceptPage(route(), [incident()], null, "2026-10-18T10:00:00Z");
    store.acceptPage(
      second,
      [{ ...incident(), matchedRouteIds: ["other"] }],
      null,
      "2026-10-18T10:00:00Z",
    );
    const manual = store.enqueue(incident(), route(), false, true);
    expect(store.badge().count).toBe(1);
    expect(store.listIncidents()[0]?.matchedRouteIds.sort()).toEqual(["client", "other"]);
    store.acceptPage(route(), [], null, "2026-10-18T10:05:00Z");
    store.acceptPage(second, [], null, "2026-10-18T10:05:00Z");
    expect(store.badge().count).toBe(0);
    expect(store.getRun(manual.id).incident.id).toBe("101");
  });

  it("shares concurrent full-sync requests so cron and two clients do not interleave scans", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    disposers.push(() => host.harness.lifecycle.dispose());
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let requested = 0;

    const runner = new SentryRunner(
      host.api,
      async () => ({ apiOrigin: "https://de.sentry.io", apiToken: "fixture-non-secret" }),
      async () => {
        requested++;
        await gate;

        return Response.json([sentryIssue()]);
      },
    );

    runner.store.saveRoute(route());
    const first = runner.sync(false);
    const second = runner.sync(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    expect(requested).toBe(1);
    expect(runner.store.badge().count).toBe(1);
  });

  it("scans a second webhook scope even while another project's scan is running", async () => {
    const { api, store } = setup();
    const firstRoute = store.getRoute("client");

    const secondRoute = store.saveRoute({
      ...firstRoute,
      id: "other",
      sentryProjectId: "200",
    });

    let release = () => {};

    let requestedFirst = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstRequest = new Promise<void>((resolve) => {
      requestedFirst = resolve;
    });

    const requested: string[] = [];

    const runner = new SentryRunner(
      api,
      async () => ({ apiOrigin: "https://de.sentry.io", apiToken: "fixture-non-secret" }),
      async (input) => {
        const projectId = new URL(String(input)).searchParams.get("project")!;
        requested.push(projectId);

        if (projectId === firstRoute.sentryProjectId) {
          requestedFirst();
          await gate;
        }

        return Response.json([{ ...sentryIssue(projectId), project: { id: projectId } }]);
      },
    );

    const first = runner.sync(false, [firstRoute.id]);
    await firstRequest;
    const second = runner.sync(false, [secondRoute.id]);
    release();
    const [, result] = await Promise.all([first, second]);
    expect(requested).toEqual([firstRoute.sentryProjectId, secondRoute.sentryProjectId]);
    expect(result.candidates.map((issue) => issue.projectId)).toEqual([
      secondRoute.sentryProjectId,
    ]);
    expect(store.badge().count).toBe(2);
  });

  it("scans every watched route at once and keeps route order in the result", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    disposers.push(() => host.harness.lifecycle.dispose());
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;

    const runner = new SentryRunner(
      host.api,
      async () => ({ apiOrigin: "https://de.sentry.io", apiToken: "fixture-non-secret" }),
      async (input) => {
        const project = new URL(String(input)).searchParams.get("project")!;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight--;

        return Response.json([{ ...sentryIssue(project), project: { id: project } }]);
      },
    );

    const ids = ["201", "202", "203", "204", "205", "206"];

    for (const id of ids)
      runner.store.saveRoute({ ...route(), id: "route-" + id, sentryProjectId: id });
    const work = runner.sync(false);

    for (let tick = 0; tick < 50; tick++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releases).toHaveLength(6);

    for (const release of releases.splice(0)) release();
    const result = await work;
    expect(peak).toBe(6);
    expect(result.scanned).toBe(6);
    expect(result.candidates.map((value) => value.id)).toEqual(ids);
    expect(ids.every((id) => runner.store.sync("route-" + id).completedAt)).toBe(true);
  });

  it("rescans a large route as parallel last-seen slices without losing or keeping stale issues", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    disposers.push(() => host.harness.lifecycle.dispose());
    const start = Date.parse("2026-11-01T00:00:00Z");

    let open = Array.from({ length: 250 }, (_, index) => ({
      id: String(1000 + index),
      lastSeen: new Date(start + index * 60000).toISOString(),
    }));

    let inFlight = 0;
    let peak = 0;
    let requests = 0;

    const runner = new SentryRunner(
      host.api,
      async () => ({ apiOrigin: "https://de.sentry.io", apiToken: "fixture-non-secret" }),
      async (input) => {
        const url = new URL(String(input));
        const before = /lastSeen:<=(\S+)/u.exec(url.searchParams.get("query") ?? "")?.[1];

        const rows = open
          .filter((issue) => !before || Date.parse(issue.lastSeen) <= Date.parse(before))
          .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

        const offset = Number(url.searchParams.get("cursor")?.split(":")[1] ?? 0);
        requests++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => setImmediate(resolve));
        inFlight--;
        const next = new URL(url);
        next.searchParams.set("cursor", "0:" + (offset + 100) + ":0");

        return Response.json(
          rows
            .slice(offset, offset + 100)
            .map((issue) => ({ ...sentryIssue(issue.id), lastSeen: issue.lastSeen })),
          {
            headers:
              offset + 100 < rows.length ? { link: `<${next}>; rel="next"; results="true"` } : {},
          },
        );
      },
    );

    runner.store.saveRoute(route());

    const members = () =>
      host.api.storage
        .database()
        .prepare("SELECT incident_id FROM route_incidents WHERE route_id=? ORDER BY incident_id")
        .all("client")
        .map((row) => z.object({ incident_id: z.string() }).parse(row).incident_id);

    await runner.sync(false);
    expect(peak).toBe(1);
    expect(members()).toHaveLength(250);

    const resolved = "1120";

    open = [
      ...open.filter((issue) => issue.id !== resolved),
      ...Array.from({ length: 30 }, (_, index) => ({
        id: String(2000 + index),
        lastSeen: new Date(start + (300 + index) * 60000).toISOString(),
      })),
    ];
    peak = 0;
    requests = 0;
    const result = await runner.sync(false);

    expect(peak).toBe(4);
    expect(requests).toBe(5);
    expect(result.scanned).toBe(5);
    expect(members()).toEqual(open.map((issue) => "acme:" + issue.id).sort());
    expect(members()).not.toContain("acme:" + resolved);
    expect(runner.store.sync("client")).toMatchObject({ cursor: null, error: null });
    expect(runner.store.badge()).toMatchObject({ count: 279, freshness: "live" });
  });

  it("uses a full bounded provider scan for resolution reconciliation, never a last-seen-only window", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    disposers.push(() => host.harness.lifecycle.dispose());
    const urls: string[] = [];

    const runner = new SentryRunner(
      host.api,
      async () => ({ apiOrigin: "https://de.sentry.io", apiToken: "fixture-non-secret" }),
      async (input) => {
        urls.push(String(input));

        return new Response(JSON.stringify([sentryIssue()]));
      },
    );

    runner.store.saveRoute(route());
    await runner.sync(false);
    await runner.sync(false);
    expect(urls).toHaveLength(2);
    expect(
      urls.every((value) => !new URL(value).searchParams.get("query")?.includes("lastSeen")),
    ).toBe(true);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});

it("bounds status history before decoding and preserves full selected batch records", async () => {
  const { store, api } = setup();
  const database = api.storage.database();
  database.prepare("INSERT INTO project_batches VALUES (?,?)").run("old-incompatible", "{}");
  database.prepare("INSERT INTO incidents VALUES (?,?)").run("unwatched-incompatible", "{}");
  store.acceptPage(route(), [incident()], null, "2026-10-18T10:00:00Z");

  for (let index = 1; index <= 51; index++)
    store.saveBatch({
      id: `batch-${index}`,
      projectId: "proj_app",
      hostId: null,
      sourceId: null,
      rootPath: null,
      routes: [route()],
      incidents: [incident()],
      state: "complete",
      threadId: null,
      spawnRequestedAt: null,
      summaryMarker: null,
      summarySentAt: null,
      runIds: [],
      blocked: [],
      summary: null,
      reason: null,
      reportRequests: 0,
      lastTurnSeq: null,
      createdAt: "2026-10-18T10:00:00Z",
      updatedAt: "2026-10-18T10:00:00Z",
    });

  const runner = new SentryRunner(api, async () => ({ apiOrigin: "https://fixture.invalid" }));
  const status = await runner.status();
  expect(status.batches).toHaveLength(50);
  expect(status.batches[0]).toMatchObject({ id: "batch-51", issueCount: 1 });
  expect(status.batches[0]).not.toHaveProperty("incidents");
  expect(status.incidents.map((value) => value.key)).toEqual([incident().key]);
  expect(store.getBatch("batch-1").incidents).toHaveLength(1);
  expect(() => store.getBatch("old-incompatible")).toThrow();
});
