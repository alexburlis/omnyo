import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { work } from "./work-fixtures.ts";

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const installed = process.argv.includes("--installed");

const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => console.error(error.message));
  const response = await (await page.request.get(`${origin}/api/v1/plugins`)).json();

  const plugin = (Array.isArray(response) ? response : response.plugins).find(
    (p) => p.id === "chat-topics",
  );

  assert.ok(plugin?.app?.bundle?.jsUrl, "Chat Topics is installed");

  if (!installed) {
    const bundle = await readFile(resolve("dist/app.js"), "utf8");
    await page.route(`${origin}${plugin.app.bundle.jsUrl}`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: bundle }),
    );
  }

  await page.route(/\/api\/v1\/sidebar-bootstrap/u, async (route) => {
    const response = await route.fetch();
    const body = await response.json();

    const roots = [...body.projects, body.personalProject].flatMap((project) =>
      project.threads.filter((thread) => thread.parentThreadId === null).slice(0, 1),
    );

    assert.ok(roots.length >= 3, "Fixture needs three projects with chats");

    for (const [index, thread] of roots.slice(0, 3).entries()) {
      thread.visibility = "visible";
      thread.archivedAt = null;
      thread.shelvedAt = null;
      thread.work = work(index < 2 ? "working" : "open");
      thread.status = index < 2 ? "active" : "idle";
      thread.hasPendingInteraction = false;
      thread.queuedWork = "none";
    }

    await route.fulfill({ response, json: body });
  });
  await page.goto(origin);
  await page.locator("[data-chat-topics]").waitFor();
  await page.locator('button[data-rail-tile][aria-label^="Inbox"]').first().click();
  const feed = page.locator("[data-chat-topics] [data-feed]");
  const running = feed.locator('[data-feed-section="run"]');
  await running.waitFor();
  await feed.locator('[data-feed-section]:not([data-feed-section="run"])').first().waitFor();

  const sections = await feed
    .locator("[data-feed-section]")
    .evaluateAll((items) => items.map((el) => el.dataset.feedSection));

  assert.deepEqual(
    sections,
    ["inbox", "finished", "ready", "run", "waiting", "shelf"].filter((key) =>
      sections.includes(key),
    ),
    "Running sits after the attention sections and before Waiting and Shelf",
  );
  assert.ok(sections.includes("run"), "Running shows while chats run");

  const ids = await feed
    .locator("[data-feed-row]")
    .evaluateAll((items) => items.map((el) => el.dataset.feedRow));

  assert.equal(new Set(ids).size, ids.length, "Each chat appears in exactly one Inbox category");
  const toggle = running.locator("[data-feed-running]");
  const directRows = ":scope > [data-feed-row], :scope > [data-chat-row-menu] > [data-feed-row]";

  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const rows = await running.locator(directRows).count();
  assert.ok(rows > 0, "Running chats are direct rows in one global list");
  assert.equal(
    await running.locator("[data-feed-row]").count(),
    rows,
    "No project wrappers separate running rows",
  );
  assert.equal(
    await running.locator(".ctf-running-project-name").count(),
    0,
    "No project headings",
  );
  assert.equal(
    await running
      .locator(
        ":scope > [data-feed-row] .ctf-row-project, :scope > [data-chat-row-menu] > [data-feed-row] .ctf-row-project",
      )
      .count(),
    rows,
    "Each row keeps its project icon",
  );
  await toggle.click();
  assert.equal(await running.locator("[data-feed-row]").count(), 0, "Running collapses");
  await toggle.click();
  assert.equal(await running.locator(directRows).count(), rows, "Running expands");
  await toggle.scrollIntoViewIfNeeded();

  if (process.env.OMNYO_TEST_SCREENSHOT)
    await page.screenshot({ path: process.env.OMNYO_TEST_SCREENSHOT });
  console.log(
    JSON.stringify({
      installed,
      sections,
      rows,
      collapse: true,
      expand: true,
    }),
  );
} finally {
  await browser.close();
}
