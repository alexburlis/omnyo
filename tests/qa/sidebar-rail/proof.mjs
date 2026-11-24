import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertRailReadingsLayout,
  measureRailReadings,
} from "./readings-layout.mjs";

async function bundle(directory, id, name, icon) {
  const js = await readFile(join(directory, "app.js"));
  const css = await readFile(join(directory, "app.css"), "utf8");
  const hash = createHash("sha256").update(js).update(css).digest("hex");
  const prefix = `/api/v1/plugin-app-assets/${hash.slice(0, 16)}`;

  return {
    js,
    css,
    hash,
    prefix,
    summary: {
      id,
      name,
      icon,
      version: "0.0.0",
      source: `path:/fixture/${id}`,
      rootDir: `/fixture/${id}`,
      provenance: "direct",
      isOrphanedBuiltin: false,
      publisherLabel: null,
      sourceDisplay: "Synthetic local UI fixture",
      updateState: { outcome: "pinned" },
      enabled: true,
      description: "Synthetic local UI fixture",
      screenshots: [],
      collections: [],
      iconUrl: null,
      status: "running",
      statusDetail: null,
      handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
      services: [],
      schedules: [],
      cliCommand: null,
      capabilities: [],
      hasSettings: false,
      logoUrl: null,
      logoDarkUrl: null,
      providerIds: [],
      icons: {},
      app: {
        hasApp: true,
        bundle: {
          jsUrl: `${prefix}/app.js`,
          cssUrl: `${prefix}/app.css`,
          jsBytes: js.byteLength,
          hash: hash.slice(0, 16),
          sdkMajor: 0,
          sdkVersion: "0.6.42",
          compatible: true,
        },
      },
    },
  };
}

export async function installSidebarRailPluginFixtures(
  page,
  { usageDirectory, resourcesDirectory, validateRegistry },
) {
  assert.ok(
    validateRegistry,
    "Pass the current pluginListResponseSchema.parse as validateRegistry",
  );

  const bundles = await Promise.all([
    bundle(
      resolve(usageDirectory),
      "omnyo--account-usage",
      "Account Usage",
      "ChartColumn",
    ),
    bundle(resolve(resourcesDirectory), "resources", "Resources", "Cpu"),
  ]);

  const rpcCalls = [];

  const diagnostics = {
    requests: [],
    responses: [],
    pageErrors: [],
    pluginWarnings: [],
    registries: [],
  };

  const pluginPath = (url) => {
    const path = new URL(url).pathname;

    return /^\/api\/v1\/(?:plugins(?:\/|$)|plugin-app-assets\/)/u.test(path)
      ? path
      : null;
  };

  page.on("request", (request) => {
    const path = pluginPath(request.url());

    if (path !== null && diagnostics.requests.length < 80)
      diagnostics.requests.push({ method: request.method(), path });
  });
  page.on("response", (response) => {
    const path = pluginPath(response.url());

    if (path !== null && diagnostics.responses.length < 80)
      diagnostics.responses.push({ path, status: response.status() });
  });
  page.on("pageerror", (error) => {
    if (diagnostics.pageErrors.length < 10)
      diagnostics.pageErrors.push(error.message.slice(0, 600));
  });
  page.on("console", (message) => {
    const text = message.text();

    if (
      ["error", "warning"].includes(message.type()) &&
      /plugin|ZodError|invalid_type/u.test(text) &&
      diagnostics.pluginWarnings.length < 10
    )
      diagnostics.pluginWarnings.push(text.slice(0, 600));
  });

  const now = Date.now();
  const resetAt = now + 3 * 24 * 60 * 60_000;
  const accountId = "11111111-1111-4111-8111-111111111111";

  const account = (id, name, remainingPercent, extra = {}) => ({
    bar: {
      accountId: id,
      name,
      plan: "Fixture",
      remainingPercent,
      resetAt,
      windowMinutes: 10080,
      status: "ready",
      serving: "idle",
      fiveHourWarning: null,
      ...extra,
    },
    row: {
      id,
      name,
      plan: "Fixture",
      enabled: true,
      canResetCredits: id === accountId,
      status: "ready",
      statusLabel: "Ready",
      serving: extra.serving ?? "idle",
      resetAt,
      lastUsedAt: null,
      observedAt: now,
      stale: false,
      error: null,
      cells: [
        {
          key: "weekly",
          percent: 100 - remainingPercent,
          tone: "ok",
          resetAt,
          gating: true,
        },
      ],
    },
  });

  const group = (providerId, poolProvider, accounts) => ({
    providerId,
    poolProvider,
    routingEnabled: true,
    readyCount: accounts.length,
    totalCount: accounts.length,
    nextCapacityAt: null,
    columns: [{ key: "weekly", label: "Week" }],
    weeklyBars: accounts.map((item) => item.bar),
    accounts: accounts.map((item) => item.row),
  });

  const usage = {
    fetchedAt: now,
    error: null,
    poolUnavailable: false,
    groups: [
      group("claude-code", "claude", [
        account("22222222-2222-4222-8222-222222222222", "UI fixture work", 83, {
          serving: "serving",
        }),
        account("33333333-3333-4333-8333-333333333333", "UI fixture spare", 17),
      ]),
      group("codex", "codex", [
        account(accountId, "UI fixture account", 76),
        account("44444444-4444-4444-8444-444444444444", "UI fixture limit", 1, {
          resetAt: now + 6 * 24 * 60 * 60_000,
        }),
      ]),
    ],
  };

  const overview = {
    observedAt: now,
    complete: true,
    active: 1,
    queued: 2,
    machines: [
      {
        id: "host_fixture",
        name: "Fixture Mac",
        connected: true,
        observedAt: now,
        error: null,
        snapshot: {
          cpu: 8,
          paused: false,
          blocked: false,
          gpu: { state: "ready" },
          jobs: [
            { state: "running", cpu: 2, gpu: false },
            { state: "queued", cpu: 1, gpu: false },
            { state: "queued", cpu: 1, gpu: true },
          ],
        },
      },
    ],
  };

  await page.route(/\/api\/v1\/plugins(?:\?.*)?$/u, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    assert.ok(Array.isArray(body.plugins));

    const registry = validateRegistry({
      ...body,
      plugins: [
        ...body.plugins.filter(
          (item) =>
            !["omnyo--account-usage", "account-usage", "resources"].includes(
              item.id,
            ),
        ),
        ...bundles.map((item) => item.summary),
      ],
    });

    if (diagnostics.registries.length < 10)
      diagnostics.registries.push(
        registry.plugins.map((item) => ({
          id: item.id,
          status: item.status,
          hasBundle: item.app.bundle !== null,
        })),
      );
    await route.fulfill({ response, json: registry });
  });

  for (const item of bundles) {
    await page.route(`**${item.prefix}/app.js`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: item.js,
      }),
    );
    await page.route(`**${item.prefix}/app.css`, (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: item.css }),
    );
  }

  await page.route(
    /\/api\/v1\/plugins\/(?:omnyo--account-usage|resources)\/rpc\//u,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      rpcCalls.push(path);
      let result;

      if (path.endsWith("/snapshot")) result = usage;
      else if (path.endsWith("/overview")) result = overview;
      else if (path.endsWith("/thread_work"))
        result = {
          complete: true,
          jobs: [],
          unavailableMachines: [],
        };
      else throw new Error(`Unexpected fixture RPC: ${path}`);
      await route.fulfill({ status: 200, json: { ok: true, result } });
    },
  );

  return {
    fixtureOnly: true,
    bundleHashes: Object.fromEntries(
      bundles.map((item) => [item.summary.id, item.hash]),
    ),
    rpcCalls,
    diagnostics,
  };
}

export async function runSidebarRailProof(page, evidenceDirectory, fixture) {
  const evidence = resolve(evidenceDirectory);
  await mkdir(evidence, { recursive: true });

  const report = {
    surface: "Real AppSidebar and built plugin apps in isolated Chrome",
    fixtureOnly: true,
    bundleHashes: fixture?.bundleHashes ?? null,
    diagnostics: fixture?.diagnostics ?? null,
    measurements: [],
    checks: [],
    status: "running",
  };

  const originalViewport = page.viewportSize();
  const initialUrl = page.url();
  const sidebar = page.locator('[data-sidebar="panel"]');
  const rail = page.getByTestId("app-nav-rail");

  async function showSidebar() {
    const inset = page.locator('main[data-sidebar="inset"]');
    await inset.waitFor({ state: "visible" });

    if ((await inset.getAttribute("data-sidebar-shelf")) !== null) {
      await page
        .locator("main[data-sidebar-shelf]:not([data-vaul-animate])")
        .waitFor({ state: "visible", timeout: 10_000 });

      if ((await inset.getAttribute("data-sidebar-shelf")) !== "open")
        await page
          .getByRole("button", { name: /^Toggle sidebar(?:$| \()/iu })
          .first()
          .click();
      await page
        .locator('main[data-sidebar-shelf="open"]:not([data-vaul-animate])')
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(
        () => {
          const shelf = document.querySelector(
            'main[data-sidebar-shelf="open"]',
          );

          const panel = document.querySelector(
            '[data-sidebar="panel"][data-state="open"]:not([inert])',
          );

          return (
            shelf !== null &&
            panel !== null &&
            shelf
              .getAnimations()
              .every((animation) => animation.playState !== "running")
          );
        },
        undefined,
        { timeout: 10_000 },
      );
    } else if (!(await rail.isVisible())) {
      await page
        .getByRole("button", { name: /^Toggle sidebar(?:$| \()/iu })
        .first()
        .click();
    }

    await rail.waitFor({ state: "visible" });
  }

  async function openPanel(name) {
    await showSidebar();

    const control = rail.getByRole("button", {
      name: new RegExp(`^${name}(?:$| \\()`, "u"),
    });

    if (await control.isVisible()) await control.click();
    else {
      await rail.getByRole("button", { name: "More", exact: true }).click();
      const menuItem = page.getByRole("menuitem", { name, exact: true });
      await control.or(menuItem).first().waitFor({ timeout: 10_000 });

      if (await control.isVisible()) {
        await page.keyboard.press("Escape");
        await control.click();
      } else await menuItem.click();
    }
  }

  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(initialUrl, { waitUntil: "domcontentloaded" });
      await showSidebar();
      const footer = sidebar.locator('[data-sidebar="footer"]').first();
      await footer.waitFor({ state: "visible" });

      const settings = sidebar.getByRole("button", {
        name: /^Settings(?:$| \()/u,
      });

      const measurements = [];

      for (const height of [24, 180, 24]) {
        await footer.evaluate((element, nextHeight) => {
          let child = element.querySelector(
            '[data-rail-layout-fixture="height"]',
          );

          if (child === null) {
            child = document.createElement("div");
            child.setAttribute("data-rail-layout-fixture", "height");
            child.textContent = "Synthetic footer height fixture";
            element.prepend(child);
          }

          child.style.height = `${nextHeight}px`;
          child.style.flexShrink = "0";
        }, height);
        await page.evaluate(
          () =>
            new Promise((resolveFrame) =>
              requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
            ),
        );
        const button = await settings.boundingBox();
        const row = await page.getByTestId("sidebar-footer-row").boundingBox();
        assert.ok(button && row);
        measurements.push({
          height,
          bottomGap: row.y + row.height - button.y - button.height,
        });
      }

      report.measurements.push({ viewport, settings: measurements });
      const gaps = measurements.map((item) => item.bottomGap);
      assert.ok(
        Math.max(...gaps) - Math.min(...gaps) <= 1.5,
        "Settings moves away from the bottom when a footer plugin grows",
      );
      await footer
        .locator('[data-rail-layout-fixture="height"]')
        .evaluate((element) => element.remove());
      report.checks.push(
        `${viewport.width}px: Settings stays bottom aligned across three footer heights`,
      );

      if (fixture) {
        await rail.getByRole("meter").waitFor();
        await rail
          .getByRole("region", { name: "Account usage" })
          .getByRole("img")
          .first()
          .waitFor();
        const readings = await measureRailReadings(page);
        report.measurements.push({ viewport, readings });
        assertRailReadingsLayout(readings);
        await openPanel("Usage");
        const usage = page.locator("[data-account-usage-panel]");
        await usage.getByRole("img").first().waitFor({ state: "visible" });

        const expand = usage.getByRole("button", {
          name: "Expand account usage",
          exact: true,
        });

        if (await expand.isVisible()) await expand.click();
        await usage.getByText("UI fixture account", { exact: true }).waitFor();
        await usage
          .getByRole("button", { name: /View reset credits/u })
          .waitFor();
        assert.equal(
          await sidebar.locator("[data-account-usage-panel]").count(),
          0,
        );
        assert.equal(await page.locator("[data-resources-sidebar]").count(), 0);
        report.checks.push(
          `${viewport.width}px: Usage rail destination retains weekly bars and account details`,
        );
        await page.screenshot({
          path: join(evidence, `usage-${viewport.width}.png`),
        });
        await openPanel("Resources");
        const dashboard = page.locator(".resources-dashboard-heading");
        await dashboard.waitFor();
        assert.match(
          await dashboard.innerText(),
          /1\s+running\s*\/\s*2\s+queued/u,
        );
        assert.equal(await sidebar.locator(".resources-sidebar").count(), 0);
        report.checks.push(
          `${viewport.width}px: Resources rail destination retains dashboard counts`,
        );
      }

      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "The page overflows horizontally",
      );
      await showSidebar();
      await page.screenshot({
        path: join(evidence, `rail-${viewport.width}.png`),
      });
    }

    report.status = "passed";

    return report;
  } catch (error) {
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
    report.navigation = await rail
      .locator("[data-nav-rail-item]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-nav-rail-item")),
      );
    report.pluginRuntimeAvailable = await page.evaluate(() =>
      Boolean(globalThis.__omnyoPluginRuntime?.pluginSdkApp),
    );
    await page.screenshot({ path: join(evidence, "failure.png") });
    throw error;
  } finally {
    await page
      .locator('[data-rail-layout-fixture="height"]')
      .evaluateAll((elements) =>
        elements.forEach((element) => element.remove()),
      );
    report.rpcCalls = fixture?.rpcCalls ?? [];
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(report, null, 2),
    );

    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}
