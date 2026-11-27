import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

// Failure contracts at the real rendered browser/RPC boundary: unavailable
// data must be visible, all ten dimensions must remain selectable, model
// speed tiers must stay distinct, stale responses must not overwrite newer
// filters, and responsive controls/downloads must remain usable. Backend E2E
// owns accounting arithmetic; these fixtures only exercise UI/transport behavior.
// Backfilled token buckets must render throughput without fabricating missing
// execution/concurrency coverage.
// Async load, realtime updates, query latency and large counters must preserve
// dashboard geometry at desktop and narrow widths. All three views reserve
// their loaded footprint. Estimated model timeline speed preserves null gaps.
// The redesign's independent full-range facets must retain truthful percentages,
// explicit Other/Unknown, role intersections and keyboard drilldowns without
// fabricating correlated agent topology. Dense plots must use bounded focusable
// controls and coalesced realtime signals, rather than one DOM control per point.
// A normal mobile throughput peak must remain visible, and axis labels must use
// legible physical pixels rather than shrinking with the SVG coordinate system.
// Host CSS delay/error must not publish an unstyled Stats page: the generation's
// dashboard waits for its own stylesheet, and a primary load failure stays
// visible in the host error boundary instead of publishing a broken dashboard.
// A delayed Stats stylesheet must not hold Omnyo's global DOM guard and block
// unrelated host React updates while the CSS request remains pending.
const origin = process.env.OMNYO_TEST_URL;

const pluginInventory = JSON.parse(
  execFileSync("omnyo", ["plugin", "list", "--json"], { encoding: "utf8" }),
);

const bundle = pluginInventory.plugins.find((plugin) => plugin.id === "stats")?.app?.bundle;

if (!bundle?.jsUrl || !bundle?.cssUrl || !bundle?.hash)
  throw new Error("Installed Stats public frontend bundle is unavailable");

const assetUrls = [bundle.jsUrl, bundle.cssUrl].map((url) => new URL(url, origin).href);

const layoutOnly = process.argv.includes("--layout-only");

const stylesheetOnly = process.argv.includes("--stylesheet-only");

if (!origin)
  throw new Error("Set OMNYO_TEST_URL to the running Omnyo server for live Chrome acceptance");

const evidence = resolve(process.env.OMNYO_THREAD_STORAGE ?? ".", "stats-redesign-evidence");

await mkdir(evidence, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });

const errors = [];

const checks = [];

const rpcCalls = [];

const fixtureQueries = [];

const layoutMeasurements = [];

const redrawMeasurements = [];

const readabilityMeasurements = [];

const assetRecords = new Map();

const stylesheetMeasurements = [];

async function recordAsset(response) {
  const url = response.url();

  if (!assetUrls.includes(url)) return;
  const bytes = await response.body();
  assetRecords.set(url, {
    url,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function stylesheetAcceptance() {
  for (const outcome of ["delay", "error"]) {
    const page = await browser.newPage({ viewport: { width: 384, height: 1000 } });
    const messages = [];
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        messages.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
    let routeHeld;
    let notifyHeld;

    const held = new Promise((resolveHeld) => {
      notifyHeld = resolveHeld;
    });

    await page.route(assetUrls[1], async (route) => {
      routeHeld = route;
      notifyHeld();

      if (outcome === "error") await route.abort("failed");
    });
    await page.goto(`${origin}/plugins/stats/stats`, { waitUntil: "domcontentloaded" });
    await held;

    if (outcome === "delay")
      await page.locator('link[data-omnyo-plugin-css="stats"]').waitFor({ state: "attached" });
    // Wait only for the host's observable load continuation. The old path
    // publishes unstyled Stats during this same CSS-pending interval.
    await page.waitForTimeout(500);
    const panelBefore = await page.getByTestId("stats-panel").count();
    const navBefore = await page.getByText("Stats", { exact: true }).count();

    const blockedHostMoves = messages.filter((message) =>
      message.includes('[Omnyo] plugin "stats" tried to move'),
    );

    const before = { outcome, panelBefore, navBefore, blockedHostMoves, messages: [...messages] };
    await writeFile(
      `${evidence}/stylesheet-publication-measurements.json`,
      `${JSON.stringify({ checkedAt: new Date().toISOString(), bundleHash: bundle.hash, measurement: before }, null, 2)}\n`,
    );

    if (outcome === "delay") {
      assert.deepEqual(
        blockedHostMoves,
        [],
        "CSS-pending Stats must not block unrelated host DOM updates",
      );
      assert.equal(
        panelBefore,
        0,
        "CSS-pending generation must not publish an unstyled Stats panel",
      );
      assert.ok(routeHeld);
      await routeHeld.continue();
      await page.getByTestId("stats-panel").waitFor({ timeout: 30000 });
      assert.ok(
        (await page.getByText("Stats", { exact: true }).count()) > 0,
        "Stats navigation must publish after its stylesheet loads",
      );
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="stats-panel"]')?.getAttribute("aria-busy") ===
          "false",
      );

      const styled = await page.getByTestId("stats-panel").evaluate((element) => ({
        containerType: getComputedStyle(element).containerType,
        metricMinHeight: getComputedStyle(element.querySelector(".stats-metric")).minHeight,
      }));

      assert.equal(styled.containerType, "inline-size");
      assert.equal(styled.metricMinHeight, "170px");
      assert.deepEqual(
        messages.filter((message) => message.includes('[Omnyo] plugin "stats" tried to move')),
        [],
        "Stats stylesheet readiness must not block unrelated host DOM updates",
      );
      stylesheetMeasurements.push({ ...before, styled });
    } else {
      const failure = page.getByText("plugin stats crashed", { exact: true });

      await failure.waitFor({ state: "visible", timeout: 15000 });
      assert.ok(
        messages.some((message) =>
          /\[plugin:stats\] slot "stats\/navPanel\/stats" crashed.*Stats stylesheet (?:could not load|was not registered by Omnyo)\./.test(
            message,
          ),
        ),
        "The Stats host boundary must identify its primary stylesheet failure in diagnostics",
      );

      assert.equal(
        await page.getByTestId("stats-panel").count(),
        0,
        "CSS-failed generation must not publish an unstyled Stats panel",
      );
      assert.deepEqual(
        messages.filter((message) => message.includes('[Omnyo] plugin "stats" tried to move')),
        [],
      );
      stylesheetMeasurements.push({
        ...before,
        messages,
        renderedError: await failure.innerText(),
      });
    }

    await page.close();
  }

  checks.push(
    "primary stylesheet delay withholds dashboard DOM without blocking host updates; stylesheet failure renders the host error boundary",
  );
}

async function frames(page) {
  await page.evaluate(
    () =>
      new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
      ),
  );
}

async function geometry(page, view) {
  await frames(page);
  assert.equal(await page.getByText(/Updating stats/i).count(), 0);

  return page.evaluate((currentView) => {
    const selectors = {
      summary: '[aria-label="Global live and lifetime totals"]',
      generated: '[data-testid="summary-generated"]',
      footer: '[data-testid="stats-footer"]',
      ...(currentView === "coverage"
        ? { body: '[data-testid="stats-health"]' }
        : { range: '[aria-label="Range"]', filters: '[aria-label="Active filters"]' }),
    };

    if (currentView === "speed") {
      selectors.body = '[data-testid="stats-speed"]';
      selectors.speedControls = '[data-testid="stats-speed-controls"]';
      selectors.speedTotals = '[data-testid="stats-speed-totals"]';
      selectors.speedFrame = '[data-testid="stats-speed-frame"]';
    }

    if (currentView === "overview") {
      selectors.fabric = '[data-testid="stats-fabric"]';
      selectors.totals = '[data-testid="stats-range-totals"]';
      selectors.breakdown = '[data-testid="stats-breakdown-frame"]';
    }

    const panel = document.querySelector('[data-testid="stats-panel"]');

    return Object.fromEntries(
      Object.entries(selectors).map(([key, selector]) => {
        const element = panel?.querySelector(selector);

        if (!element) throw new Error(`Layout target missing: ${key}`);
        const rect = element.getBoundingClientRect();

        return [key, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
      }),
    );
  }, view);
}

function assertGeometry(before, after, label) {
  let maxDelta = 0;

  for (const key of Object.keys(before))
    for (const axis of ["x", "y", "width", "height"]) {
      const delta = Math.abs(before[key][axis] - after[key][axis]);

      maxDelta = Math.max(maxDelta, delta);
      assert.ok(delta <= 1, `${label}: ${key}.${axis} shifted ${delta}px`);
    }

  return maxDelta;
}

async function layoutAcceptance(width, view) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const allowed = new WeakSet();
    const NativeWebSocket = window.WebSocket;

    window.__statsLayout = { sockets: [], shifts: [] };
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__statsLayout.sockets.push(this);
        this.addEventListener(
          "message",
          (event) => {
            if (allowed.has(event)) return;

            try {
              const value = JSON.parse(event.data);

              if (value.type === "plugin-signal" && value.pluginId === "stats")
                event.stopImmediatePropagation();
            } catch {}
          },
          true,
        );
      }
    };
    window.__statsLayout.emit = (data = true) => {
      const socket = window.__statsLayout.sockets.find((candidate) => candidate.readyState === 1);

      if (!socket) throw new Error("No connected Omnyo WebSocket for Stats realtime proof");

      const event = new MessageEvent("message", {
        data: JSON.stringify({
          type: "plugin-signal",
          pluginId: "stats",
          channel: "stats-changed",
          payload: { live: true, data },
        }),
      });

      allowed.add(event);
      socket.dispatchEvent(event);
    };

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.sources.some((source) => source.node?.closest?.('[data-testid="stats-panel"]')))
          window.__statsLayout.shifts.push({
            value: entry.value,
            recentInput: entry.hadRecentInput,
            sources: entry.sources.map((source) => ({
              tag:
                source.node?.nodeType === 3
                  ? source.node.parentElement?.tagName
                  : source.node?.tagName,
              testId:
                source.node?.parentElement
                  ?.closest?.("[data-testid]")
                  ?.getAttribute("data-testid") ?? null,
              previous: source.previousRect.toJSON(),
              current: source.currentRect.toJSON(),
            })),
          });
    }).observe({ type: "layout-shift", buffered: true });
  });
  let hold = true;
  let extreme = false;
  const pending = [];

  const requestCounts = { report: 0, summary: 0, health: 0, refresh: 0 };
  const cssRequests = [];
  page.on("response", (response) => {
    if (/\.css(?:\?|$)/.test(response.url()))
      cssRequests.push({ url: response.url(), status: response.status() });
  });
  page.on("requestfailed", (request) => {
    if (/\.css(?:\?|$)/.test(request.url()))
      cssRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });

  const reply = async (route, input) => {
    const result = report(input);

    if (extreme) {
      result.summary = {
        ...result.summary,
        running: 999999999,
        activeChats: 999999999,
        nestedAgents: 999999999,
        mainChats: 999999999,
        subagentChats: 999999999,
        unknownChats: 999999999,
        tps5m: 999999999999,
        allTime: makeCounters(999999999999999),
      };
      result.summary.allTime.input = 999999999999999;
      result.summary.allTime.cached = 999999999999999;
      result.health.indexing = true;
      result.health.backfillPending = 999999;
      result.health.databasePath = `/fixture/${"long-path/".repeat(30)}stats.sqlite`;
      result.health.accounts = Array.from({ length: 30 }, (_, index) => ({
        id: `account-${index}`,
        label: `Long account ${index} ${"label ".repeat(20)}`,
        provider: "codex",
      }));
      result.groups = [];
      result.groupCount = 0;
      result.speeds = [];
      result.facets = result.facets.map((facet) => ({ ...facet, groups: [] }));
      result.series = Array.from({ length: 600 }, (_, index) => ({
        at: Date.now() - (600 - index) * 60000,
        output: 999999999999,
        tps: 999999999999 / 60,
        modelTps: index % 3 === 0 ? null : 999999999999,
        agents: index % 4,
        peak: 999999999,
        observedMs: 60000,
      }));
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, result }),
    });
  };

  await page.route("**/plugins/stats/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").at(-1);

    if (method in requestCounts) requestCounts[method] += 1;

    if (method === "report") {
      const input = route.request().postDataJSON() ?? {};

      if (hold) pending.push({ route, input });
      else await reply(route, input);
    } else
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          result:
            method === "summary" ? summary() : method === "health" ? health() : { accepted: true },
        }),
      });
  });

  const awaitPending = async () => {
    const deadline = performance.now() + 15000;

    while (pending.length === 0) {
      if (performance.now() >= deadline)
        throw new Error(`${view}/${width} awaited Stats report was not requested`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  };

  const release = async () => {
    hold = false;

    while (pending.length) {
      const next = pending.shift();

      await reply(next.route, next.input);
    }

    await page
      .getByTestId("stats-panel")
      .filter({ has: page.getByTestId("summary-generated").filter({ hasText: /\d/ }) })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="stats-panel"]')?.getAttribute("aria-busy") ===
        "false",
    );
    await frames(page);
  };

  const routePath = `/plugins/stats/stats${view === "overview" ? "" : `/${view === "speed" ? "speed" : "coverage"}`}`;

  await page.goto(`${origin}${routePath}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("stats-footer").waitFor({ state: "attached" });
  await awaitPending();
  await page.evaluate(() => document.fonts.ready);
  const initial = await geometry(page, view);

  await page.evaluate(() => {
    window.__statsLayout.shifts = [];
  });
  await release();
  const loaded = await geometry(page, view);

  if (view === "overview") {
    const readability = await page.locator('.stats-chart[data-metric="tps"]').evaluate((chart) => {
      const peak = chart.querySelector(".stats-chart-stat span");
      const plot = chart.querySelector("svg.stats-chart-plot");
      const axis = chart.querySelector(".stats-chart-axis");

      if (!peak || !plot || !axis) throw new Error("Chart readability target missing");

      return {
        peakText: peak.textContent,
        peakWidth: peak.clientWidth,
        peakScrollWidth: peak.scrollWidth,
        plotHeight: plot.getBoundingClientRect().height,
        axisFontSize: Number.parseFloat(getComputedStyle(axis).fontSize),
      };
    });

    assert.ok(
      readability.peakScrollWidth <= readability.peakWidth,
      `${width}px normal chart peak must fit its numeric column`,
    );
    assert.equal(readability.plotHeight, 210, `${width}px plot retains its reserved height`);
    assert.ok(
      readability.axisFontSize >= 10,
      `${width}px axis labels retain at least10physical pixels`,
    );
    readabilityMeasurements.push({ width, ...readability });
  }

  let initialDelta;

  try {
    initialDelta = assertGeometry(initial, loaded, `initial ${view}/${width}`);
  } catch (error) {
    await writeFile(
      `${evidence}/ui-layout-failure-details.json`,
      `${JSON.stringify({ checkedAt: new Date().toISOString(), width, view, stage: "initial", initial, loaded, message: error.message, shifts: await page.evaluate(() => window.__statsLayout.shifts) }, null, 2)}\n`,
    );
    await page
      .getByTestId("stats-panel")
      .screenshot({ path: `${evidence}/stats-layout-failure.png` });
    throw error;
  }

  hold = true;
  extreme = true;
  await page.evaluate(() => window.__statsLayout.emit());
  await awaitPending();
  const pendingUpdate = await geometry(page, view);

  assert.equal(await page.getByText(/Updating stats/i).count(), 0);
  const pendingDelta = assertGeometry(loaded, pendingUpdate, `pending realtime ${view}/${width}`);

  await release();
  const updated = await geometry(page, view);
  const updateDelta = assertGeometry(loaded, updated, `extreme realtime ${view}/${width}`);
  let queryDelta = 0;

  if (view !== "coverage") {
    hold = true;
    await page.getByLabel("Range", { exact: true }).selectOption("all");
    await awaitPending();
    queryDelta = assertGeometry(
      updated,
      await geometry(page, view),
      `pending range ${view}/${width}`,
    );
    await release();
    queryDelta = Math.max(
      queryDelta,
      assertGeometry(updated, await geometry(page, view), `loaded range ${view}/${width}`),
    );
  }

  hold = true;
  const updateShifts = await page.evaluate(() => window.__statsLayout.shifts);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("stats-footer").waitFor({ state: "attached" });
  await awaitPending();
  await page.evaluate(() => document.fonts.ready);
  const reloading = await geometry(page, view);

  await page.evaluate(() => {
    window.__statsLayout.shifts = [];
  });
  await release();

  const reloaded = await geometry(page, view);
  let reloadDelta;

  try {
    reloadDelta = assertGeometry(reloading, reloaded, `full reload ${view}/${width}`);
  } catch (error) {
    await writeFile(
      `${evidence}/ui-layout-reload-failure-details.json`,
      `${JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          width,
          view,
          reloading,
          reloaded,
          message: error.message,
          shifts: await page.evaluate(() => window.__statsLayout.shifts),
          styles: await page.evaluate(() => {
            const panel = document.querySelector('[data-testid="stats-panel"]');

            return [...(panel?.querySelectorAll(".stats-metric") ?? [])].map((element) => ({
              height: getComputedStyle(element).height,
              rect: element.getBoundingClientRect().toJSON(),
            }));
          }),
          cssRequests,
          stylesheets: await page.evaluate(() =>
            [...document.styleSheets].map((sheet) => ({
              href: sheet.href,
              disabled: sheet.disabled,
              hasStatsRules: [...sheet.cssRules].some((rule) =>
                rule.cssText.includes(".stats-page"),
              ),
              rules: sheet.cssRules.length,
            })),
          ),
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  }

  const reloadShifts = await page.evaluate(() => window.__statsLayout.shifts);

  const shifts = [...updateShifts, ...reloadShifts];

  const cls = shifts
    .filter((entry) => !entry.recentInput)
    .reduce((sum, entry) => sum + entry.value, 0);

  layoutMeasurements.push({
    width,
    view,
    initialDelta,
    pendingDelta,
    updateDelta,
    queryDelta,
    reloadDelta,
    cls,
    totalShiftValue: shifts.reduce((sum, entry) => sum + entry.value, 0),
    measuredTargets: Object.keys(initial),
    shifts,
  });
  await writeFile(
    `${evidence}/ui-layout-measurements.json`,
    `${JSON.stringify({ checkedAt: new Date().toISOString(), layoutMeasurements }, null, 2)}\n`,
  );
  assert.equal(cls, 0, `${view}/${width} asynchronous Stats CLS must be zero`);
  assert.equal(
    shifts.reduce((sum, entry) => sum + entry.value, 0),
    0,
    `${view}/${width} Stats layout shifts including recent input must be zero`,
  );

  if (view === "overview" && width === 1360) {
    hold = false;
    const before = { ...requestCounts };
    await page.evaluate(() => {
      for (let index = 0; index < 100; index++) window.__statsLayout.emit(false);
    });
    const deadline = performance.now() + 10000;

    while (requestCounts.summary === before.summary) {
      if (performance.now() > deadline)
        throw new Error("live-only signal burst did not update summary");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }

    await page.waitForTimeout(1000);

    const liveOnly = {
      summary: requestCounts.summary - before.summary,
      report: requestCounts.report - before.report,
    };

    assert.equal(liveOnly.summary, 1, "100 coalesced live-only signals must make one summary read");
    assert.equal(liveOnly.report, 0, "live-only ticks must not redraw report/facets");
    const beforeData = { ...requestCounts };
    await page.evaluate(() => {
      for (let index = 0; index < 100; index++) window.__statsLayout.emit(true);
    });
    const dataDeadline = performance.now() + 10000;

    while (requestCounts.report === beforeData.report) {
      if (performance.now() > dataDeadline)
        throw new Error("data signal burst did not update report");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }

    await page.waitForTimeout(1000);

    const data = {
      summary: requestCounts.summary - beforeData.summary,
      report: requestCounts.report - beforeData.report,
    };

    assert.equal(data.report, 1, "100 coalesced data signals must make one report read");
    const chartFocusTargets = await page.locator('svg[role="group"][tabindex="0"]').count();
    assert.equal(
      chartFocusTargets,
      2,
      "two dense600-point plots retain onlytwo plot focus targets",
    );
    const after = await geometry(page, view);
    assertGeometry(updated, after, "coalesced live/data bursts");
    const burstShifts = await page.evaluate(() => window.__statsLayout.shifts);
    const burstShiftValue = burstShifts.reduce((sum, entry) => sum + entry.value, 0);
    assert.equal(
      burstShiftValue,
      0,
      "summary-only and dense-report redraw bursts must retain zero Stats layout shift",
    );
    redrawMeasurements.push({
      signalsPerBurst: 100,
      liveOnly,
      data,
      points: 600,
      chartFocusTargets,
      burstShiftValue,
    });
  }

  await page.screenshot({ path: `${evidence}/stats-layout-${view}-${width}.png` });
  await page.close();
}

const dimensions = [
  "machine",
  "project",
  "chat",
  "provider",
  "model",
  "effort",
  "mode",
  "account",
  "chatRole",
  "agentRole",
];

const makeCounters = (output = 1000) => ({
  input: 2000,
  output,
  total: output + 2000,
  cached: 500,
  cacheRead: 400,
  cacheWrite: 100,
  reasoning: 100,
  usageEvents: 10,
  turns: 4,
  failedTurns: 1,
  measuredTurns: 3,
  modelMs: 10000,
  speedOutput: output,
  agentMs: 30000,
  unknownBaselines: 0,
  toolCalls: 2,
  nativeTokens: 100,
  nativeToolUses: 3,
  nativeMs: 5000,
});

const summary = () => ({
  asOf: Date.now(),
  running: 4,
  activeChats: 2,
  nestedAgents: 2,
  mainChats: 1,
  subagentChats: 1,
  unknownChats: 0,
  tps5m: 12.5,
  output5m: 3750,
  allTime: makeCounters(120000),
  collectionStart: Date.now() - 30 * 86400000,
  lastIngestAt: Date.now(),
  observedSeconds5m: 280,
  liveReady: true,
});

const health = () => ({
  databasePath: "/fixture/stats.sqlite",
  databaseBytes: 800000,
  walBytes: 40000,
  cohorts: 20,
  chats: 10,
  minuteRows: 400,
  dailyRows: 100,
  observationRows: 300,
  speedRows: 50,
  backfillPending: 0,
  queueDepth: 0,
  indexing: false,
  error: null,
  accountState: "Account Pooler roster available; per-request attribution unavailable",
  accounts: [{ id: "fixture-account", label: "Existing account", provider: "codex" }],
  retention: "Raw observations 7 days; minute detail 30 days; daily and lifetime totals retained",
  lastMaintenanceAt: Date.now(),
  sourcePages: 10,
  sourceEvents: 100,
  lastPageMs: 3,
  roleReadFailures: 0,
});

function report(input = {}) {
  const now = Date.now();
  const range = input.range ?? "day";
  const by = input.groupBy ?? "model";

  const labels =
    by === "mode"
      ? ["Normal", "Fast", "Ultrafast"]
      : by === "account"
        ? ["Unknown account"]
        : by === "chatRole"
          ? ["Main chats", "Subagent chats", "Unknown"]
          : by === "agentRole"
            ? ["Main agents", "Subagents", "Unknown"]
            : [`${range} ${by} Alpha`, `${range} ${by} Beta`];

  const groups = labels.map((label, index) => ({
    key:
      by === "mode"
        ? ["default", "fast", "ultrafast"][index]
        : by === "account"
          ? ""
          : by === "chatRole" || by === "agentRole"
            ? ["main", "subagent", "unknown"][index]
            : `${by}-${index}`,
    label,
    deleted: by === "chat" && index === 1,
    counters: makeCounters(1000 + index),
    tps: 12.5,
    modelTps: 100,
    medianTps: 90,
    active: 2,
  }));

  const counters = makeCounters();

  const facets = ["model", "provider", "machine", "effort", "chatRole", "agentRole"].map(
    (dimension) => {
      const role = dimension === "chatRole" || dimension === "agentRole";

      return {
        dimension,
        totalOutput: 1000,
        totalGroups: role ? 3 : 7,
        groups: (role ? [600, 300, 100] : [400, 250, 150, 100, 60, 40]).map((output, index) => ({
          key: role
            ? ["main", "subagent", "unknown"][index]
            : index === 5
              ? "__other"
              : `${dimension}-${index}`,
          label: role
            ? (dimension === "chatRole"
                ? ["Main chats", "Subagent chats", "Unknown"]
                : ["Main agents", "Subagents", "Unknown"])[index]
            : index === 5
              ? "Other"
              : `${range} ${dimension} ${["Alpha", "Beta", "Gamma", "Delta", "Epsilon"][index]}`,
          output,
          agentMs: output * 10,
          active: index === 0 ? 2 : 0,
        })),
      };
    },
  );

  return {
    asOf: now,
    from: now - 86400000,
    to: now,
    resolutionSeconds: 60,
    counters,
    facets,
    groups,
    groupCount: groups.length,
    nextOffset: null,
    series: [
      {
        at: now - 180000,
        output: 500,
        tps: 500 / 60,
        modelTps: null,
        agents: null,
        peak: null,
        observedMs: 0,
      },
      {
        at: now - 120000,
        output: 1000,
        tps: 1000 / 60,
        modelTps: 125,
        agents: 2.5,
        peak: 4,
        observedMs: 60000,
      },
      {
        at: now - 60000,
        output: 166440,
        tps: 2774,
        modelTps: null,
        agents: 0,
        peak: 0,
        observedMs: 60000,
      },
    ],
    speeds: ["default", "fast", "ultrafast"].map((mode, index) => ({
      model: "Model Alpha",
      provider: "codex",
      effort: "max",
      mode,
      counters: makeCounters(1000 + index),
      modelTps: 100 + index * 20,
      medianTps: 90 + index * 20,
      medianSampleCount: 3,
    })),
    summary: summary(),
    health: health(),
    medianWindowDays: 30,
  };
}

async function installFixtures(page, mode = () => "normal") {
  await page.route("**/plugins/stats/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").at(-1);

    if (mode() === "transport-error") return route.abort("failed");
    const input = route.request().postDataJSON() ?? {};

    if (method === "report") fixtureQueries.push(input);

    let result =
      method === "summary"
        ? summary()
        : method === "health"
          ? health()
          : method === "refresh"
            ? { accepted: true }
            : report(input);

    if (method === "report" && mode() === "empty")
      result = { ...result, groups: [], groupCount: 0, speeds: [], counters: makeCounters(0) };

    if (method === "report" && mode() === "history-error")
      result.health.error = "Fixture history could not be read";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, result }),
    });
  });
}

try {
  await stylesheetAcceptance();

  if (stylesheetOnly) {
    await writeFile(
      `${evidence}/stylesheet-acceptance.json`,
      `${JSON.stringify({ checkedAt: new Date().toISOString(), bundleHash: bundle.hash, stylesheetMeasurements, surface: "real Chrome primary Stats CSS request delayed/failed; zero Stats host-guard warnings, withheld dashboard DOM, rendered Stats host error and precise console cause", storage: "Chrome profile removed by browser.close" }, null, 2)}\n`,
    );
    console.log(`PASS: Stats primary stylesheet lifecycle; ${evidence}/stylesheet-acceptance.json`);
  } else {
    if (!layoutOnly) {
      const preview = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
      preview.on("pageerror", (error) => errors.push(error.message));
      preview.on("response", (response) => {
        void recordAsset(response).catch((error) => errors.push(error.message));
      });
      // Static screenshots retain actual public RPC values. Suppress only Stats
      // realtime signals during capture so component replacement cannot race the
      // screenshot; separate layout/redraw cases exercise the real signal boundary.
      await preview.addInitScript(() => {
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = class extends OriginalWebSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener(
              "message",
              (event) => {
                try {
                  const value = JSON.parse(event.data);

                  if (value.type === "plugin-signal" && value.pluginId === "stats")
                    event.stopImmediatePropagation();
                } catch {}
              },
              true,
            );
          }
        };
      });
      await preview.goto(`${origin}/plugins/stats/stats`);
      await preview.getByTestId("stats-fabric").waitFor({ timeout: 30000 });
      await preview
        .getByTestId("summary-generated")
        .filter({ hasText: /\d/ })
        .waitFor({ timeout: 30000 });
      await preview.waitForFunction(
        () =>
          document.querySelector('[data-testid="stats-panel"]')?.getAttribute("aria-busy") ===
          "false",
      );
      await frames(preview);
      await preview
        .getByTestId("stats-panel")
        .screenshot({ path: `${evidence}/stats-desktop.png` });
      await preview
        .getByTestId("stats-fabric")
        .getByText("groups", { exact: false })
        .first()
        .waitFor();
      await preview
        .getByTestId("stats-fabric")
        .screenshot({ path: `${evidence}/stats-fabric-desktop.png` });
      await preview
        .locator(".stats-chart-grid")
        .screenshot({ path: `${evidence}/stats-charts-desktop.png` });
      await preview.setViewportSize({ width: 390, height: 844 });
      await preview.waitForFunction(
        () =>
          document.querySelector('[data-testid="stats-panel"]')?.getAttribute("aria-busy") ===
          "false",
      );
      await preview
        .getByTestId("stats-fabric")
        .getByText("groups", { exact: false })
        .first()
        .waitFor();
      await frames(preview);
      await preview.getByTestId("stats-panel").screenshot({ path: `${evidence}/stats-mobile.png` });
      await preview
        .getByTestId("stats-fabric")
        .screenshot({ path: `${evidence}/stats-fabric-mobile.png` });
      await preview
        .locator(".stats-chart-grid")
        .screenshot({ path: `${evidence}/stats-charts-mobile.png` });
      console.log(`Live previews: ${evidence}/stats-desktop.png; ${evidence}/stats-mobile.png`);
      await preview.close();
    }

    for (const width of [1360, 384])
      for (const view of ["overview", "speed", "coverage"]) await layoutAcceptance(width, view);

    checks.push(
      "six desktop/narrow view loads, realtime updates, pending ranges and full reloads retain geometry and zero Stats CLS",
    );

    if (layoutOnly) {
      const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });

      await mobile.goto(`${origin}/plugins/stats/stats`);
      await mobile.getByTestId("stats-breakdown").waitFor({ timeout: 30000 });
      await mobile
        .getByTestId("summary-generated")
        .filter({ hasText: /\d/ })
        .waitFor({ timeout: 30000 });
      await frames(mobile);
      await mobile.getByTestId("stats-panel").screenshot({ path: `${evidence}/stats-mobile.png` });

      const tps = await mobile
        .getByTestId("summary-tps")
        .locator("span")
        .first()
        .evaluate((element) => ({
          text: element.textContent,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));

      if (tps.text?.length < 9)
        assert.ok(
          tps.scrollWidth <= tps.clientWidth,
          "Ordinary mobile TPS must fit its numeric column",
        );
      await mobile.close();
      assert.deepEqual(errors, []);
      await writeFile(
        `${evidence}/ui-layout-acceptance.json`,
        `${JSON.stringify({ checkedAt: new Date().toISOString(), browser: "headless real Google Chrome", origin, checks, layoutMeasurements, mobileTps: tps, errors, surface: "public RPC/WebSocket transport fixtures; PerformanceObserver and DOM bounding boxes", storage: "Chrome closed in finally; profile/download scratch disposed; small screenshots/JSON retained" }, null, 2)}\n`,
      );
      console.log(
        `PASS: six strict-zero Stats layout cases; ${evidence}/ui-layout-acceptance.json`,
      );
    } else {
      const live = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
      live.on("pageerror", (error) => errors.push(error.message));
      live.on("request", (request) => {
        if (request.url().includes("/plugins/stats/rpc/"))
          rpcCalls.push(request.url().split("/").at(-1));
      });
      await live.goto(`${origin}/plugins/stats/stats`);
      const panel = live.getByTestId("stats-panel");
      await panel.waitFor({ timeout: 30000 });
      await live.getByRole("heading", { name: "Stats", exact: true }).waitFor();
      await live.getByTestId("summary-generated").waitFor({ timeout: 30000 });
      await live.getByRole("group", { name: "Total output throughput", exact: true }).waitFor();
      await live.getByRole("group", { name: "Agents working in parallel", exact: true }).waitFor();
      const by = live.getByLabel("Group by", { exact: true });

      const optionValues = await by
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value));

      assert.deepEqual([...optionValues].sort(), [...dimensions].sort());
      await panel.screenshot({ path: `${evidence}/stats-desktop.png` });
      await panel.getByRole("button", { name: "Model speed", exact: true }).click();
      await live.getByTestId("model-speed").waitFor();
      await panel.screenshot({ path: `${evidence}/stats-model-speed.png` });
      await panel.getByRole("button", { name: "Coverage & storage", exact: true }).click();
      await panel.screenshot({ path: `${evidence}/stats-coverage.png` });
      await panel.getByRole("button", { name: "Overview", exact: true }).click();
      await live.getByTestId("stats-breakdown").waitFor({ timeout: 30000 });
      await live
        .getByTestId("summary-generated")
        .filter({ hasText: /\d/ })
        .waitFor({ timeout: 30000 });
      await live.setViewportSize({ width: 390, height: 844 });
      await live.getByTestId("stats-breakdown").waitFor({ timeout: 30000 });
      await live
        .getByTestId("summary-generated")
        .filter({ hasText: /\d/ })
        .waitFor({ timeout: 30000 });
      await frames(live);
      await panel.screenshot({ path: `${evidence}/stats-mobile.png` });
      assert.ok(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        "Stats must fit a narrow viewport",
      );
      checks.push(
        "live Stats page, summary, throughput/concurrency charts, all dimensions, model speed, coverage, and 390px viewport",
      );

      let fixtureMode = "normal";

      const fixture = await browser.newPage({
        viewport: { width: 1360, height: 1000 },
        acceptDownloads: true,
      });

      fixture.on("pageerror", (error) => errors.push(error.message));
      await installFixtures(fixture, () => fixtureMode);
      await fixture.goto(`${origin}/plugins/stats/stats`);
      await fixture.getByTestId("summary-generated").waitFor();

      const throughput = fixture.getByRole("group", {
        name: "Total output throughput",
        exact: true,
      });

      const concurrency = fixture.getByRole("group", {
        name: "Agents working in parallel",
        exact: true,
      });

      const throughputDescription = fixture
        .locator("section")
        .filter({ has: throughput })
        .locator('[aria-live="polite"]');

      const concurrencyDescription = fixture
        .locator("section")
        .filter({ has: concurrency })
        .locator('[aria-live="polite"]');

      await throughput.focus();
      await throughput.press("Home");
      await frames(fixture);
      assert.match(
        await throughputDescription.innerText(),
        /8\.3 tok\/s.*execution coverage unavailable/,
      );
      await throughput.press("ArrowRight");
      await frames(fixture);
      assert.match(await throughputDescription.innerText(), /16\.7 tok\/s/);
      await concurrency.focus();
      await concurrency.press("Home");
      await frames(fixture);
      assert.match(await concurrencyDescription.innerText(), /2\.5 agents.*peak 4/);
      await concurrency.press("End");
      await frames(fixture);
      assert.match(await concurrencyDescription.innerText(), /0 agents.*peak 0/);
      const plotBounds = await throughput.boundingBox();
      assert.ok(plotBounds);
      await fixture.mouse.move(
        plotBounds.x + plotBounds.width * (360 / 704),
        plotBounds.y + plotBounds.height / 2,
      );
      await frames(fixture);
      assert.match(await throughputDescription.innerText(), /16\.7 tok\/s/);

      for (const disclosure of await fixture.getByText("Chart data", { exact: true }).all())
        await disclosure.click();

      const tpsData = fixture
        .getByRole("table")
        .filter({ has: fixture.getByRole("columnheader", { name: "tok/s", exact: true }) });

      const agentData = fixture
        .getByRole("table")
        .filter({ has: fixture.getByRole("columnheader", { name: "agents", exact: true }) });

      assert.equal(
        await tpsData.getByRole("row").nth(1).getByRole("cell").nth(0).innerText(),
        "8.3",
      );
      assert.equal(
        await agentData.getByRole("row").nth(1).getByRole("cell").nth(0).innerText(),
        "—",
      );
      checks.push(
        "backfilled output renders historical throughput while missing concurrency stays unavailable",
      );
      await fixture.getByLabel("Throughput metric", { exact: true }).selectOption("model");
      const modelPlot = fixture.getByRole("group", { name: "Estimated model speed", exact: true });
      await modelPlot.focus();
      await modelPlot.press("Home");
      await frames(fixture);
      assert.match(
        await fixture
          .locator("section")
          .filter({ has: modelPlot })
          .locator('[aria-live="polite"]')
          .innerText(),
        /125 tok\/s estimated model speed/,
      );
      assert.equal(
        await tpsData.getByRole("row").nth(1).getByRole("cell").first().innerText(),
        "—",
      );
      assert.equal(
        await tpsData.getByRole("row").nth(2).getByRole("cell").first().innerText(),
        "125",
      );
      await fixture.getByLabel("Throughput metric", { exact: true }).selectOption("output");
      checks.push("estimated model timeline has measured speed and explicit unavailable gaps");
      const fixtureBy = fixture.getByLabel("Group by", { exact: true });

      for (const dimension of dimensions) {
        await fixtureBy.selectOption(dimension);

        const text =
          dimension === "mode"
            ? "Ultrafast"
            : dimension === "account"
              ? "Unknown account"
              : dimension === "chatRole" || dimension === "agentRole"
                ? "Unknown"
                : `day ${dimension} Alpha`;

        await fixture.getByTestId("stats-breakdown").getByText(text, { exact: true }).waitFor();

        const key =
          dimension === "mode"
            ? "ultrafast"
            : dimension === "account"
              ? ""
              : dimension === "chatRole" || dimension === "agentRole"
                ? "unknown"
                : `${dimension}-0`;

        const filteredResponse = fixture.waitForResponse(
          (response) =>
            response.url().endsWith("/plugins/stats/rpc/report") &&
            response.request().postDataJSON()?.filters?.[dimension] === key,
        );

        await fixture
          .getByTestId("stats-breakdown")
          .getByRole("button", { name: text, exact: true })
          .click();
        await filteredResponse;
        assert.equal(fixtureQueries.at(-1)?.filters?.[dimension], key);

        const clearedResponse = fixture.waitForResponse(
          (response) =>
            response.url().endsWith("/plugins/stats/rpc/report") &&
            response.request().postDataJSON()?.filters?.[dimension] === undefined,
        );

        await fixture.getByRole("button", { name: /^Remove .* filter$/ }).click();
        await clearedResponse;
        assert.equal(fixtureQueries.at(-1)?.filters?.[dimension], undefined);
      }

      const fabric = fixture.getByTestId("stats-fabric");

      const modelNode = fabric.getByRole("button", {
        name: "Filter Model day model Alpha",
        exact: true,
      });

      assert.match(await modelNode.innerText(), /40\s*%/);
      assert.equal(
        await fabric.getByRole("button", { name: "Filter Model Other", exact: true }).isDisabled(),
        true,
      );
      await fabric.getByText(/Independent breakdowns of the full filtered range/).waitFor();

      const mainFilter = fixture.waitForResponse(
        (response) =>
          response.url().endsWith("/plugins/stats/rpc/report") &&
          response.request().postDataJSON()?.filters?.chatRole === "main",
      );

      const mainNode = fabric.getByRole("button", {
        name: "Filter Chat role Main chats",
        exact: true,
      });

      await mainNode.focus();
      await mainNode.press("Enter");
      await mainFilter;

      const nativeFilter = fixture.waitForResponse(
        (response) =>
          response.url().endsWith("/plugins/stats/rpc/report") &&
          response.request().postDataJSON()?.filters?.chatRole === "main" &&
          response.request().postDataJSON()?.filters?.agentRole === "subagent",
      );

      await fabric
        .getByRole("button", { name: "Filter Execution role Subagents", exact: true })
        .click();
      await nativeFilter;
      assert.equal(fixtureQueries.at(-1)?.filters?.chatRole, "main");
      assert.equal(fixtureQueries.at(-1)?.filters?.agentRole, "subagent");
      await fixture.getByRole("button", { name: "Remove Chat role filter", exact: true }).click();
      await fixture
        .getByRole("button", { name: "Remove Execution role filter", exact: true })
        .click();
      await fixture.waitForFunction(
        () =>
          document.querySelector('[data-testid="stats-panel"]')?.getAttribute("aria-busy") ===
          "false",
      );
      checks.push(
        "full-range fabric shares, explicit Other, and keyboard chat/execution-role intersection drilldowns",
      );

      await fixture
        .getByTestId("stats-panel")
        .getByRole("button", { name: "Model speed", exact: true })
        .click();
      const speedTable = fixture.getByTestId("model-speed");
      await speedTable.getByText("Normal", { exact: true }).waitFor();
      await speedTable.getByText("Fast", { exact: true }).waitFor();
      await speedTable.getByText("Ultrafast", { exact: true }).waitFor();
      await fixture
        .getByTestId("stats-panel")
        .getByRole("button", { name: "Overview", exact: true })
        .click();
      await fixtureBy.selectOption("model");
      await fixture
        .getByTestId("stats-breakdown")
        .getByText("day model Alpha", { exact: true })
        .waitFor();

      for (const format of ["CSV", "JSON"]) {
        const downloadStarted = fixture.waitForEvent("download");
        await fixture
          .getByTestId("stats-panel")
          .getByRole("button", { name: `Download page ${format}`, exact: true })
          .click();
        const download = await downloadStarted;
        const path = await download.path();
        assert.ok(path);
        const text = await readFile(path, "utf8");
        assert.ok(text.includes("day model Alpha"), "Export must include the displayed page");

        if (format === "JSON") assert.ok(JSON.parse(text));
      }

      checks.push(
        "every dimension including Omnyo chat/native execution roles, Unknown account, Normal/Fast/Ultrafast, and page CSV/JSON downloads",
      );

      fixtureMode = "history-error";
      await fixture.reload();
      await fixture
        .getByRole("alert")
        .filter({ hasText: "Fixture history could not be read" })
        .waitFor();
      fixtureMode = "empty";
      await fixture.reload();
      await fixture.getByTestId("stats-breakdown").waitFor();
      assert.equal(
        await fixture
          .getByTestId("stats-breakdown")
          .getByText("day model Alpha", { exact: true })
          .count(),
        0,
      );
      fixtureMode = "transport-error";
      await fixture.reload();
      await fixture.getByRole("alert").waitFor();
      checks.push("incomplete history, empty history, and transport failure remain visible");

      const race = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
      race.on("pageerror", (error) => errors.push(error.message));
      let holdWeek = true;
      let heldRoute;
      let notifyHeld;

      const weekHeld = new Promise((resolveHeld) => {
        notifyHeld = resolveHeld;
      });

      await race.route("**/plugins/stats/rpc/*", async (route) => {
        const method = new URL(route.request().url()).pathname.split("/").at(-1);
        const input = route.request().postDataJSON() ?? {};

        if (method === "report" && input.range === "week" && holdWeek) {
          holdWeek = false;
          heldRoute = route;
          notifyHeld();

          return;
        }

        const result =
          method === "report"
            ? report(input)
            : method === "summary"
              ? summary()
              : method === "health"
                ? health()
                : { accepted: true };

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, result }),
        });
      });
      await race.goto(`${origin}/plugins/stats/stats`);
      const range = race.getByLabel("Range", { exact: true });
      await range.waitFor();
      await race
        .getByTestId("stats-breakdown")
        .getByText("day model Alpha", { exact: true })
        .waitFor();
      await range.selectOption("week");
      await weekHeld;
      await range.selectOption("all");
      await race
        .getByTestId("stats-breakdown")
        .getByText("all model Alpha", { exact: true })
        .waitFor();
      assert.ok(heldRoute);
      await heldRoute.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, result: report({ range: "week", groupBy: "model" }) }),
      });
      await race.evaluate(
        () =>
          new Promise((resolveFrame) =>
            requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
          ),
      );
      assert.equal(await range.inputValue(), "all");
      await race
        .getByTestId("stats-breakdown")
        .getByText("all model Alpha", { exact: true })
        .waitFor();
      assert.equal(
        await race
          .getByTestId("stats-breakdown")
          .getByText("week model Alpha", { exact: true })
          .count(),
        0,
      );
      checks.push("a delayed old RPC response cannot overwrite the selected range");

      assert.deepEqual(errors, []);
      await writeFile(
        `${evidence}/ui-layout-acceptance.json`,
        `${JSON.stringify({ checkedAt: new Date().toISOString(), browser: "headless real Google Chrome", origin, layoutMeasurements, redrawMeasurements, readabilityMeasurements, errors, surface: "deterministic public RPC/WebSocket fixtures; strictzero Stats PerformanceObserver and DOM bounding boxes", storage: "Chrome profile/download scratch removed by browser.close; compact screenshots and JSON retained" }, null, 2)}\n`,
      );
      await writeFile(
        `${evidence}/ui-acceptance.json`,
        `${JSON.stringify({ checkedAt: new Date().toISOString(), browser: "headless real Google Chrome", origin, checks, rpcCalls, bundleHash: bundle.hash, assets: [...assetRecords.values()], stylesheetMeasurements, layoutMeasurements, redrawMeasurements, readabilityMeasurements, viewport: { desktop: 1360, mobile: 390, narrowLayout: 384 }, errors, surface: "live installed Omnyo page plus deterministic public RPC/WebSocket transport fixtures; PerformanceObserver and DOM bounding boxes", storage: "browser profile/download scratch removed by browser.close; screenshots and receipt retained" }, null, 2)}\n`,
      );
      console.log(
        `PASS: ${checks.length} Stats Chrome acceptance checkpoints; ${evidence}/ui-acceptance.json`,
      );
    }
  }
} finally {
  await browser.close();
}
