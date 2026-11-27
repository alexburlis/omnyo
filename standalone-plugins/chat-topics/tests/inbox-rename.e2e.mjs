import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  const page = await browser.newPage();
  const response = await page.request.get(`${origin}/api/v1/plugins`);
  const plugins = await response.json();
  const asset = plugins.plugins.find((plugin) => plugin.id === "chat-topics").app.bundle;

  if (!process.argv.includes("--installed")) {
    const body = await readFile(new URL("../dist/app.js", import.meta.url), "utf8");
    await page.route(`${origin}${asset.jsUrl}`, (route) =>
      route.fulfill({ contentType: "text/javascript", body }),
    );
    const css = await readFile(new URL("../dist/app.css", import.meta.url), "utf8");
    await page.route(`${origin}${asset.cssUrl}`, (route) =>
      route.fulfill({ contentType: "text/css", body: css }),
    );
  }

  const saves = [];
  await page.route(/\/api\/v1\/threads\/[^/]+$/u, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });

  await page.goto(origin);
  const title = page.locator(".ctf-title").first();
  await title.waitFor();
  const row = title.locator("xpath=ancestor::*[contains(@class,'ctf-row-main')][1]");

  const metrics = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();

      return {
        height: box.height,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    });

  const before = { row: await metrics(row), title: await metrics(title) };
  await title.dblclick();
  const input = page.getByRole("textbox", { name: "Chat title", exact: true });
  await input.waitFor({ timeout: 3000 });
  const after = { row: await metrics(row), input: await metrics(input) };
  assert.deepEqual(after.row, before.row, "Editing must not resize or move the row");
  assert.equal(after.input.fontSize, before.title.fontSize);
  assert.equal(after.input.lineHeight, before.title.lineHeight);
  assert.equal(after.input.height, before.title.height);
  await page.waitForTimeout(1000);
  assert.equal(await input.count(), 1, "Navigation must preserve the rename editor");
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  await input.fill("Inbox rename verification");
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, "Inbox rename verification");
  console.log(
    "PASS: double-click keeps the row and title metrics, survives navigation, retains focus, and saves once (intercepted)",
  );
} finally {
  await browser.close();
}
