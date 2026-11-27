import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Fails the sidebar's tag-metadata requests on an installed Omnyo for an outage
// window, then checks that the "Could not load tags" notice clears without a
// reconnect or new chat. Pass --installed to run the installed bundle instead
// of dist/app.js.

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const installed = process.argv.includes("--installed");

const bundle = installed ? null : await readFile(resolve("dist/app.js"), "utf8");

const OUTAGE_MS = 10_000;

const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const plugins = await (await page.request.get(`${origin}/api/v1/plugins`)).json();
  const list = Array.isArray(plugins) ? plugins : plugins.plugins;
  const jsUrl = list.find((plugin) => plugin.id === "chat-topics")?.app?.bundle?.jsUrl;
  assert.ok(jsUrl, "Chat Topics app bundle URL");

  if (bundle !== null)
    await page.route(`${origin}${jsUrl}`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: bundle }),
    );

  let failures = 0;
  let outageEnds = Number.POSITIVE_INFINITY;
  await page.route(/\/api\/v1\/threads\/plugin-metadata$/u, (route) => {
    const body = route.request().postDataJSON();

    if (body?.pluginId !== "chat-topics" || Date.now() > outageEnds) return route.continue();

    if (failures === 0) outageEnds = Date.now() + OUTAGE_MS;
    failures += 1;

    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto(origin);

  const notice = page.locator("[data-chat-topics] .ct-notice", {
    hasText: "Could not load tags",
  });

  await notice.waitFor({ timeout: 30_000 });
  await notice.waitFor({ state: "detached", timeout: OUTAGE_MS + 10_000 });
  console.log(JSON.stringify({ ok: true, installed, failures }));
} finally {
  await browser.close();
}
