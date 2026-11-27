import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");

const scratch = await mkdtemp(join(tmpdir(), "sentry-ui-browser-"));

const evidence = process.env.SENTRY_UI_EVIDENCE_DIR ?? join(root, "docs/evidence");

let browser;

let server;

try {
  await build({
    entryPoints: [join(root, "tests/ui-browser-entry.tsx")],
    bundle: true,
    format: "esm",
    outfile: join(scratch, "fixture.js"),
    jsx: "automatic",
  });

  const html =
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{height:100%;overflow:hidden}#root{display:flex;flex-direction:column;min-height:0}:root{--ink:#eee;--canvas:#181818;font-family:system-ui}body{background:var(--canvas);margin:0}aside{position:fixed;top:8px;left:8px}aside>span{display:flex;padding:3px}aside button{border:0;background:#25222e;color:#a698f5;padding:10px;border-radius:6px}</style><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';

  server = createServer(async (request, response) => {
    const path =
      request.url === "/fixture.js"
        ? "fixture.js"
        : request.url === "/fixture.css"
          ? "fixture.css"
          : null;

    response.setHeader(
      "content-type",
      path?.endsWith(".js") ? "text/javascript" : path ? "text/css" : "text/html",
    );
    response.end(path ? await readFile(join(scratch, path)) : html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + address.port);
  await page.getByRole("heading", { name: "Sentry issues", exact: true }).waitFor();

  // PluginPanelView owns a fixed-height flex column with overflow hidden.
  // Exercise wheel input here: auto-scrolling a locator would mask a clipped panel.
  const scrollChecks = [];

  async function wheelToEnd(selector, last, label) {
    const area = page.locator(selector);
    await area.evaluate((element) => {
      element.scrollTop = 0;
    });
    const box = await area.boundingBox();
    assert.ok(box, label + ": scroll area is mounted");
    await page.mouse.move(
      box.x + box.width / 2,
      Math.min(page.viewportSize().height - 40, box.y + 160),
    );
    await page.mouse.wheel(0, 20000);
    await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);

        return (
          element.scrollTop > 0 &&
          element.scrollTop + element.clientHeight >= element.scrollHeight - 2
        );
      },
      selector,
      { timeout: 2000 },
    );
    const lastBox = await last.boundingBox();
    assert.ok(
      lastBox && lastBox.y >= 0 && lastBox.y + lastBox.height <= page.viewportSize().height,
      label + ": final control must be reachable with wheel input",
    );
    assert.equal(
      await page.evaluate(() => document.scrollingElement.scrollTop),
      0,
      label + ": the Omnyo document must stay stationary",
    );
    scrollChecks.push({
      label,
      ...(await area.evaluate((element) => ({
        top: element.scrollTop,
        viewport: element.clientHeight,
        content: element.scrollHeight,
      }))),
    });
  }

  await page.setViewportSize({ width: 1280, height: 440 });
  await wheelToEnd(
    ".sentry-panel",
    page.getByText("Start from a Sentry issue link", { exact: true }),
    "desktop inbox",
  );
  await page.setViewportSize({ width: 1280, height: 960 });

  if (process.argv.includes("--diagnose-navigation")) {
    console.log(
      JSON.stringify(
        await page.locator("nav button").evaluateAll((buttons) =>
          buttons.map((button) => ({
            text: button.textContent,
            ariaLabel: button.getAttribute("aria-label"),
          })),
        ),
      ),
    );
  } else {
    assert.equal(await page.locator(".sentry-rail-badge").innerText(), "3");
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 600 });
    await wheelToEnd(
      ".sentry-panel",
      page.getByRole("button", { name: "Save limit for Fixture project" }),
      "projects",
    );
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.getByRole("button", { name: "Watch Client" }).click();
    const toggle = page.getByRole("switch", { name: "Auto solve for Fixture project" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await page.getByLabel("Daily automatic starts for Fixture project").fill("7");
    await page.getByRole("button", { name: "Save limit for Fixture project" }).click();
    await page.getByText("0 / 7", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Pause Client" }).click();
    await page.getByRole("button", { name: /^Investigations\b/u }).click();
    await page.getByRole("button", { name: "Open chat ↗", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(new URL(page.url()).hash, "#thread-opened");
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Inbox\b/u }).click();
    await page.getByRole("button", { name: "Start solver for CLIENT-102", exact: true }).click();
    assert.match(await page.getByRole("alert").innerText(), /retained/u);
    await page.getByRole("button", { name: "Sync now", exact: true }).click();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(
      await page.getByLabel("Repository path").inputValue(),
      "/projects/umbrella/client",
    );
    await page.getByLabel("Name", { exact: true }).fill("Edited fixture");
    await page.getByRole("button", { name: "Save route", exact: true }).click();
    await page.getByRole("heading", { name: "Edited fixture" }).waitFor();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "ui-projects.png"), fullPage: true });
    await page.getByRole("button", { name: /^Inbox\b/u }).click();
    await page.screenshot({ path: join(evidence, "ui-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidence, "ui-inbox-narrow.png"), fullPage: true });
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByLabel("Sentry organization", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByLabel("Sentry organization", { exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
      "Project setup starts at the organization field",
    );
    assert.equal(
      await page
        .locator("#root")
        .evaluate((element) => element.inert || element.getAttribute("aria-hidden") === "true"),
      false,
      "Setup keeps the Omnyo app root interactive",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "Add project", exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
      "Closing setup returns focus to its trigger",
    );
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.getByLabel("Sentry organization").fill("acme");
    await page.getByRole("button", { name: "Find projects", exact: true }).click();
    await page.getByLabel("Sentry project", { exact: true }).selectOption("200");
    await page.getByLabel("Omnyo project", { exact: true }).selectOption("proj_orbit");
    await page.getByLabel("Repository", { exact: true }).selectOption({ label: "mobile · main" });
    await page.getByLabel("Verification command", { exact: true }).fill("pnpm");
    assert.equal(
      await page.getByLabel("Arguments (JSON)", { exact: true }).isVisible(),
      true,
      "Typing a verification command must not collapse its arguments",
    );
    await page.getByLabel("Arguments (JSON)", { exact: true }).fill('["--dir","mobile","test"]');
    await wheelToEnd(
      ".sentry-dialog",
      page.getByRole("button", { name: "Save and watch", exact: true }),
      "narrow project dialog",
    );
    await page.screenshot({ path: join(evidence, "ui-narrow.png"), fullPage: true });
    await page.getByRole("button", { name: "Save and watch", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Inbox", exact: true }).click();
    await wheelToEnd(
      ".sentry-panel",
      page.getByText("Start from a Sentry issue link", { exact: true }),
      "narrow inbox after closing dialog",
    );
    await page.getByLabel("Filter Omnyo project", { exact: true }).selectOption("proj_orbit");
    await page.getByRole("button", { name: "Solve all for Orbit", exact: true }).waitFor();
    assert.deepEqual(await page.locator(".sentry-manual select option").allTextContents(), [
      "Orbit",
    ]);
    await page.getByRole("button", { name: "Solve all for Orbit", exact: true }).click();
    assert.equal(new URL(page.url()).hash, "#solve-all-proj_orbit");
    assert.equal(
      await page.getByRole("status", { name: "Inbox refresh", exact: true }).innerText(),
      "Refreshing…",
    );
    await page.getByRole("button", { name: "Sync now", exact: true }).scrollIntoViewIfNeeded();
    const before = await page.locator(".sentry-tabs").boundingBox();
    await page.getByRole("button", { name: "Sync now", exact: true }).click();
    const after = await page.locator(".sentry-tabs").boundingBox();
    assert.equal(
      await page.getByRole("status", { name: "Inbox refresh", exact: true }).innerText(),
      "",
    );
    assert.equal(before.y, after.y);
    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: join(evidence, "ui-rtl.png"), fullPage: true });
    await page.evaluate(() => {
      document.documentElement.dir = "ltr";
      document.documentElement.style.zoom = "2";
    });
    await page.setViewportSize({ width: 1280, height: 960 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: join(evidence, "ui-zoom.png"), fullPage: true });
    await page.goto("http://127.0.0.1:" + address.port + "/?portfolio");
    await page.getByRole("heading", { name: "Sentry issues", exact: true }).waitFor();
    await page.setViewportSize({ width: 1280, height: 960 });
    assert.equal(await page.locator(".sentry-project-nav button").count(), 6);
    assert.equal(await page.locator(".sentry-issue").count(), 30);
    const firstIssue = await page.locator(".sentry-issue").first().boundingBox();
    assert.ok(
      firstIssue && firstIssue.y < 500,
      "A 30-repository portfolio keeps issues near the top",
    );
    await page.screenshot({ path: join(evidence, "ui-portfolio-desktop.png"), fullPage: true });
    await page
      .getByRole("navigation", { name: "Projects in Sentry" })
      .getByRole("button", { name: /Nimbus/u })
      .click();
    assert.equal(await page.locator(".sentry-issue").count(), 6);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    assert.equal(await page.locator(".sentry-route").count(), 6);
    await page.screenshot({ path: join(evidence, "ui-portfolio-project.png"), fullPage: true });
    await page.getByRole("button", { name: "Inbox", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: join(evidence, "ui-portfolio-narrow.png"), fullPage: true });
    await page.goto("http://127.0.0.1:" + address.port + "/?loading");
    await page.getByText("Loading Sentry…").waitFor();
    assert.equal(await page.getByLabel("Filter Omnyo project").count(), 0);
    await page.waitForFunction(() => window.sentryLoading.calls.status === 1);
    await page.evaluate(() => window.sentryLoading.warm());
    await page.evaluate(() => window.sentryLoading.releaseTargets());
    await page.getByLabel("Filter Omnyo project").waitFor();
    assert.equal(
      await page
        .locator(".sentry-nav-name")
        .allTextContents()
        .then((names) => names.join(",")),
      "App,Other",
    );
    await page.getByLabel("Filter Omnyo project").selectOption("proj_app");
    await page.waitForFunction(() => window.sentryLoading.calls.pages.proj_app === 1);
    await page.evaluate(() => window.sentryLoading.releasePage("proj_app"));
    await page.getByText("CLIENT-501", { exact: true }).waitFor();
    await page.getByLabel("Filter Omnyo project").selectOption("proj_other");
    await page.waitForFunction(() => window.sentryLoading.calls.pages.proj_other === 1);
    await page.getByLabel("Filter Omnyo project").selectOption("proj_app");
    await page.waitForFunction(() => window.sentryLoading.calls.pages.proj_app === 2);

    const warmFrames = await page.evaluate(async () => {
      const frames = [];

      for (let index = 0; index < 10; index++) {
        await new Promise(requestAnimationFrame);
        frames.push({
          rows: document.querySelectorAll(".sentry-inbox .sentry-issue").length,
          retained: document.body.textContent.includes("CLIENT-501"),
          count: document.body.textContent.includes("2 issues in this view"),
          empty: document.body.textContent.includes("No matching issues"),
        });
      }

      return frames;
    });

    assert(warmFrames.every((frame) => frame.retained && frame.count && !frame.empty));
    await page.evaluate(() => window.sentryLoading.releasePage("proj_other"));
    assert.equal(await page.getByText("CLIENT-501", { exact: true }).count(), 1);
    assert.equal(await page.getByText("CLIENT-601", { exact: true }).count(), 0);
    await page.evaluate(() => window.sentryLoading.releasePage("proj_app", true));
    await page.getByText("CLIENT-511", { exact: true }).waitFor();
    assert.equal(await page.getByText("CLIENT-501", { exact: true }).count(), 0);
    const visibleRows = await page.locator(".sentry-inbox .sentry-issue").count();

    const projectBadge = await page
      .locator(".sentry-project-nav button")
      .filter({ hasText: "App" })
      .locator(".sentry-count")
      .textContent();

    assert.equal(Number(projectBadge), 2);
    assert.equal(visibleRows, 2);
    assert.equal(await page.evaluate(() => window.sentryLoading.calls.status), 1);
    await page.evaluate(() => window.sentryLoading.setVisible(false));
    await page.evaluate(() => window.sentryLoading.setVisible(true));
    await page.waitForFunction(() => window.sentryLoading.calls.pages.proj_app === 3);
    assert.equal(await page.getByText("CLIENT-511", { exact: true }).count(), 1);
    await page.evaluate(() => window.sentryLoading.releasePage("proj_app", true));
    await page.getByText("CLIENT-511", { exact: true }).waitFor();

    const reconnectReads = await page.evaluate(async () => {
      for (let index = 0; index < 10; index++) await new Promise(requestAnimationFrame);

      return window.sentryLoading.calls.pages.proj_app;
    });

    assert.equal(reconnectReads, 3);
    await page.screenshot({ path: join(evidence, "ui-warm-loading.png"), fullPage: true });
    assert.deepEqual(errors, []);
    await writeFile(
      join(evidence, "ui-browser.json"),
      JSON.stringify(
        {
          browser: "Google Chrome",
          headless: true,
          desktop: [1280, 960],
          narrow: [390, 844],
          checks: [
            "cold status waits for project names before filters and rows",
            "speculative warming does not queue another in-flight screen read",
            "retained Activity reconnect revalidates its page exactly once",
            "A to B to A immediately retains cached rows and count across ten delayed frames",
            "late other-project result cannot replace the selected project",
            "background refresh replaces retained rows with fresh rows",
            "unfiltered project badge equals visible rows and view total",
            "route edit/save",
            "add second Omnyo/Sentry project in scoped modal",
            "project-wide Solve all sends Omnyo project ID",
            "stationary overview during refresh",
            "watch/pause independently of solving",
            "per-project auto-solve opt-in and configurable cap",
            "real rail badge attachment",
            "RTL and 200 percent zoom",
            "keyboard chat link",
            "stop/retry",
            "visible error and refresh",
            "eligible issue action",
            "narrow editor has no horizontal overflow",
            "reload",
            "30-repository portfolio density and scoped navigation",
            "project setup input focus, Escape, focus return and interactive app root",
            "manual issue-link repository follows selected project",
          ],
          limits:
            "Standalone real React component fixture. Native Omnyo navigation/RPC and notification delivery require installed-runtime verification.",
          scrollChecks,
          warmFrames,
          reconnectReads,
          errors,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("Chrome component journey passed at desktop and narrow widths");
  }
} finally {
  await browser?.close();

  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
