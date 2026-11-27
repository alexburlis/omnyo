import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { entry, snapshot, waiting } from "./inbox-fixtures.ts";

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const installed = process.argv.includes("--installed");

const evidence = resolve(
  process.argv.slice(2).find((value) => !value.startsWith("--")) ??
    join(tmpdir(), "chat-topics-inbox-feed"),
);

const bundle = installed ? null : await readFile(resolve("dist/app.js"), "utf8");

const styles = installed ? null : await readFile(resolve("dist/app.css"), "utf8");

const READ_POSTS = new Set(["/api/v1/threads/plugin-metadata", "/api/v1/files/list"]);

const SECTION_ORDER = ["inbox", "failed", "finished", "ready", "run", "waiting", "shelf"];

const result = { origin, installed, at: new Date().toISOString(), checks: [], blocked: {} };

const browser = await chromium.launch({ channel: "chrome", headless: true });

function threadIdOf(url) {
  const match = /\/threads\/([^/?#]+)/u.exec(new URL(url).pathname);

  return match === null ? null : decodeURIComponent(match[1]);
}

function pickChats(bootstrap) {
  const visible = [...bootstrap.projects, bootstrap.personalProject]
    .flatMap((project) => project.threads)
    .filter((thread) => thread.visibility === "visible" && thread.archivedAt === null);

  const related = new Set(
    visible.flatMap((thread) => [thread.parentThreadId, thread.sourceThreadId]).filter(Boolean),
  );

  return visible.filter(
    (thread) =>
      thread.parentThreadId === null &&
      thread.sourceThreadId === null &&
      thread.shelvedAt === null &&
      !related.has(thread.id),
  );
}

try {
  await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];

  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);

  const bootstrap = await (await page.request.get(`${origin}/api/v1/sidebar-bootstrap`)).json();
  const chats = pickChats(bootstrap);

  assert.ok(chats.length >= 5, "Five unrelated visible chats are needed");
  const [need, ready, finished, running, waits] = chats.slice(0, 5);
  const title = (thread) => `Inbox e2e ${thread.id}`;

  const of = (thread, change = {}) =>
    entry(thread.id, { projectId: thread.projectId, title: title(thread), ...change });

  const needCard = of(need);

  const entries = {
    [need.id]: of(need, {
      card: { ...needCard.card, kind: "question", questionMode: "required" },
      reason: { kind: "recap", text: "Pick the release scope.", threadId: need.id },
    }),
    [ready.id]: of(ready, {
      card: { ...needCard.card, primary: { kind: "archive" } },
      reason: { kind: "recap", text: "The fix is delivered.", threadId: ready.id },
    }),
    [finished.id]: of(finished, {
      reason: { kind: "recap", text: `Continued in ${title(running)}`, threadId: running.id },
    }),
  };

  const state = {
    revision: 0,
    inbox: new Map(Object.entries(entries)),
    moves: new Map(),
    acts: [],
    undos: [],
  };

  const current = () => {
    state.revision += 1;

    return snapshot({
      revision: `inbox-feed-e2e-${state.revision}`,
      inbox: [...state.inbox.values()],
      running: [of(running, { view: "running", card: null })],
      waiting: [
        {
          ...waiting(waits.id, { group: "on-you", waitId: "wait-e2e-report" }),
          projectId: waits.projectId,
          title: title(waits),
        },
      ],
    });
  };

  if (bundle !== null) {
    const plugins = await (await page.request.get(`${origin}/api/v1/plugins`)).json();

    const assets = (Array.isArray(plugins) ? plugins : plugins.plugins).find(
      (plugin) => plugin.id === "chat-topics",
    )?.app?.bundle;

    assert.ok(assets?.jsUrl, "Chat Topics is installed");
    await page.route(`${origin}${assets.jsUrl}`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: bundle }),
    );

    if (assets.cssUrl)
      await page.route(`${origin}${assets.cssUrl}`, (route) =>
        route.fulfill({ contentType: "text/css", body: styles }),
      );
  }

  await page.route(/\/api\/v1\/sidebar-bootstrap/u, async (route) => {
    const response = await route.fetch();
    const body = await response.json();

    for (const project of [...body.projects, body.personalProject])
      for (const thread of project.threads)
        if (chats.slice(0, 5).some((chat) => chat.id === thread.id)) {
          thread.title = title(thread);
          thread.status = "idle";
          thread.runtime = { displayStatus: "idle" };
          thread.queuedWork = "none";
        }

    await route.fulfill({ response, json: body });
  });

  await page.route(/\/api\/v1\//u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/v1/inbox" && request.method() === "GET")
      return route.fulfill({ json: current() });

    if (path === "/api/v1/inbox/act") {
      const act = request.postDataJSON();
      const moveId = `inbox-feed-e2e-move-${state.acts.length + 1}`;

      state.acts.push(act);

      if (act.action === "archive" && state.inbox.has(act.threadId)) {
        state.moves.set(moveId, state.inbox.get(act.threadId));
        state.inbox.delete(act.threadId);
      }

      return route.fulfill({ json: { moveId, entry: null } });
    }

    if (path === "/api/v1/inbox/undo") {
      const { moveId } = request.postDataJSON();
      const moved = state.moves.get(moveId);

      state.undos.push(moveId);

      if (moved !== undefined) state.inbox.set(moved.threadId, moved);

      return route.fulfill({ json: { moveId: null, entry: moved ?? null } });
    }

    if (
      request.method() === "GET" ||
      READ_POSTS.has(path) ||
      /^\/api\/v1\/hosts\/[^/]+\/paths\/exist$/u.test(path) ||
      /^\/api\/v1\/plugins\/[^/]+\/rpc\//u.test(path)
    )
      return route.fallback();

    const blocked = `${request.method()} ${path}`;

    result.blocked[blocked] = (result.blocked[blocked] ?? 0) + 1;

    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto(origin);
  const list = page.locator("[data-chat-topics]");

  await list.waitFor({ state: "visible", timeout: 60_000 });

  if ((await list.getAttribute("data-chat-scope")) !== "inbox")
    await page.locator('button[data-rail-tile][aria-label^="Inbox"]').first().click();
  await page.waitForFunction(
    () => document.querySelector("[data-chat-topics]")?.getAttribute("data-chat-scope") === "inbox",
  );

  const feed = list.locator("[data-feed]");
  const card = (thread) => feed.locator(`[data-feed-row="${thread.id}"]`);

  const sectionOf = (thread) =>
    card(thread).evaluate(
      (element) =>
        element.closest("[data-feed-section]")?.getAttribute("data-feed-section") ?? null,
    );

  const away = async () => {
    await page.mouse.move(1200, 450);
    await page.waitForTimeout(300);
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-feed]")
          ?.getAnimations({ subtree: true })
          .every(
            (animation) =>
              animation.playState !== "running" ||
              animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
          ) ?? true,
    );
  };

  const shownSections = () =>
    feed
      .locator("[data-feed-section]")
      .evaluateAll((sections) => sections.map((section) => section.dataset.feedSection));

  const filledSections = SECTION_ORDER.filter((key) => key !== "shelf" && key !== "failed");

  await card(need).waitFor();
  assert.deepEqual(
    await shownSections(),
    filledSections,
    "The Inbox shows Needs you, Finished, Ready to archive, Running and Waiting in order and leaves the empty Shelf out",
  );
  result.checks.push("Sections with chats show in the default order; empty sections stay out");

  const running$ = feed.locator("[data-feed-running]");

  assert.equal(await running$.getAttribute("aria-expanded"), "true", "Running starts open");
  await card(running).waitFor();
  result.checks.push("Running starts open");
  assert.deepEqual(
    {
      need: await sectionOf(need),
      finished: await sectionOf(finished),
      ready: await sectionOf(ready),
      running: await sectionOf(running),
      waiting: await sectionOf(waits),
    },
    { need: "inbox", finished: "finished", ready: "ready", running: "run", waiting: "waiting" },
    "Each chat sits in the section its server state names",
  );

  const listed = await feed
    .locator("[data-feed-row]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.feedRow));

  assert.equal(new Set(listed).size, listed.length, "Each chat appears once");
  assert.equal(
    await card(need).locator('[data-inbox-reason="needs-you"]').innerText(),
    "Pick the release scope.",
    "A card that needs you states its reason",
  );
  result.checks.push("Server state places each chat once, with its reason under the title");
  const handoff = card(finished).getByRole("link", { name: `Continued in ${title(running)}` });
  await handoff.click();
  await page.waitForURL((url) => threadIdOf(url.href) === running.id);
  assert.equal(threadIdOf(page.url()), running.id);
  result.checks.push("The original chat names its handoff and opens the continuation");
  await page.screenshot({ path: `${evidence}/inbox.png` });

  if (process.argv.includes("--handoff-only")) {
    assert.deepEqual(errors, []);
    await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ checks: result.checks, evidence }));
    process.exitCode = 0;
    await browser.close();
    process.exit(0);
  }

  const viewMenu = page.getByRole("menu", { name: "Inbox view" });

  const rightClickEmptySpace = async () => {
    const listBox = await list.boundingBox();
    const lastBox = await feed.locator("[data-feed-section]").last().boundingBox();
    const bottom = listBox.y + listBox.height;

    assert.ok(bottom - (lastBox.y + lastBox.height) > 40, "The Inbox leaves empty space below");
    await page.mouse.click(listBox.x + listBox.width / 2, bottom - 20, { button: "right" });
    await viewMenu.waitFor();
  };

  await card(finished).locator(".ctf-title").click({ button: "right" });
  await page.getByRole("menu").first().waitFor();
  assert.equal(await viewMenu.count(), 0, "Right-clicking a chat opens its chat menu");
  await page
    .getByRole("menu")
    .first()
    .locator('[role="menuitem"]:not([data-disabled])')
    .first()
    .click({ button: "right" });
  await page.waitForTimeout(200);
  assert.equal(await viewMenu.count(), 0, "Right-clicking inside the chat menu opens no view menu");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").first().waitFor({ state: "detached" });

  await card(finished).locator(".ctf-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Wait", exact: true }).click();
  const waitOptions = card(finished).locator(".ctf-card-body");

  await waitOptions.getByRole("button", { name: /Tomorrow 09:00/u }).waitFor();
  await waitOptions.getByRole("button", { name: /On you/u }).waitFor();
  assert.equal(state.acts.length, 0, "Opening Wait sends no Inbox action");
  await page.getByRole("menu").first().waitFor({ state: "detached" });
  await waitOptions.getByRole("button", { name: /On you/u }).click();
  await card(finished).getByRole("textbox", { name: "What will you report?" }).waitFor();
  await page.keyboard.press("Escape");
  await waitOptions.waitFor({ state: "detached" });
  result.checks.push("Right-click Wait opens the existing date and On you choices");

  await rightClickEmptySpace();
  const showEmpty = viewMenu.getByRole("menuitemcheckbox", { name: "Show empty sections" });

  assert.equal(
    await showEmpty.getAttribute("aria-checked"),
    "false",
    "Empty sections start hidden",
  );
  assert.equal(
    await viewMenu
      .getByRole("menuitemcheckbox", { name: "Needs you" })
      .getAttribute("aria-disabled"),
    "true",
    "Needs you cannot be hidden",
  );
  await page.screenshot({ path: `${evidence}/view-menu.png` });
  await showEmpty.click();
  await viewMenu.waitFor({ state: "detached" });
  await feed.locator('[data-feed-section="shelf"]').waitFor();
  assert.deepEqual(
    await shownSections(),
    SECTION_ORDER,
    "Show empty sections adds the empty Shelf",
  );

  await rightClickEmptySpace();
  await viewMenu.getByRole("menuitemcheckbox", { name: "Waiting" }).click();
  await feed.locator('[data-feed-section="waiting"]').waitFor({ state: "detached" });

  await rightClickEmptySpace();
  await viewMenu.getByRole("menuitemcheckbox", { name: "Running" }).click();
  await feed.locator('[data-feed-section="run"]').waitFor({ state: "detached" });
  await card(finished).locator("[data-feed-item]").focus();
  await page.keyboard.press("Escape");

  await feed
    .locator('[data-feed-section="finished"] .ctf-heading-label')
    .click({ button: "right" });
  await viewMenu.waitFor();
  await viewMenu.getByRole("menuitem", { name: "Reset to default" }).click();
  await feed.locator('[data-feed-section="shelf"]').waitFor({ state: "detached" });
  assert.deepEqual(
    await shownSections(),
    filledSections,
    "Reset to default restores the default sections",
  );
  assert.equal(
    await running$.getAttribute("aria-expanded"),
    "true",
    "Escape while Running is hidden leaves Running open",
  );
  result.checks.push(
    "Right-clicking empty space or a heading opens the Inbox view menu, which shows empty sections, hides a section and resets; a chat keeps its own menu",
  );

  const rects = () =>
    feed.locator("[data-feed-row]").evaluateAll((rows) =>
      rows.map((row) => {
        const box = row.getBoundingClientRect();

        return `${row.dataset.feedRow}:${box.top.toFixed(1)}:${box.height.toFixed(1)}`;
      }),
    );

  await away();
  const resting = await rects();

  await card(finished).hover();
  await page.waitForTimeout(300);
  const hovering = await rects();

  await card(finished).locator(".cg-row-menu").first().click();
  await page.getByRole("menuitem").first().waitFor();
  assert.equal(await card(finished).getAttribute("data-menu-open"), "true");
  const withMenu = await rects();

  await page.keyboard.press("Escape");
  await away();
  assert.deepEqual(hovering, resting, "Hover moves and resizes nothing");
  assert.deepEqual(withMenu, resting, "An open chat menu moves and resizes nothing");
  assert.equal(await card(finished).getAttribute("data-menu-open"), "false");
  result.checks.push("Hover and the chat menu leave every card in place");

  await card(need).locator(".ctf-title").click();
  await page.waitForURL((url) => threadIdOf(url) === need.id);
  await card(finished).locator(".ctf-row-detail-text").click();
  await page.waitForURL((url) => threadIdOf(url) === running.id);
  await away();
  assert.equal(await sectionOf(need), "inbox", "An opened card keeps its place");
  result.checks.push("A title opens its chat and a handoff line opens its continuation");

  const order = await feed
    .locator("[data-feed-item]")
    .evaluateAll((links) => links.map((link) => link.dataset.sidebarThreadId));

  const at = order.indexOf(finished.id);

  await card(finished).locator("[data-feed-item]").focus();
  const keys = [];

  for (const key of ["j", "k", "k"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    keys.push(threadIdOf(page.url()));
  }

  assert.deepEqual(
    keys,
    [order[at + 1], order[at], order[at - 1]],
    "J and K open the next and previous chats in list order",
  );
  result.checks.push("J and K step through the Inbox in list order");

  await card(ready).locator(".ctf-title").click();
  await page.waitForURL((url) => threadIdOf(url) === ready.id);
  assert.equal(state.acts.length, 0, "Opening a card sends no Inbox action");
  await card(ready).locator("[data-feed-item]").focus();
  await page.keyboard.press("Enter");
  await card(ready).waitFor({ state: "detached" });
  assert.equal(state.acts.length, 1, "Enter sends one Inbox action");
  assert.equal(state.acts[0].action, "archive", "Enter takes the card's primary action");
  assert.equal(state.acts[0].threadId, ready.id, "The action targets the focused card");
  assert.equal(state.acts[0].latch, entries[ready.id].latch, "The action carries the shown latch");
  await feed.getByRole("button", { name: "Undo" }).waitFor();
  result.checks.push("Enter archives a ready card at once and offers Undo");

  await page.keyboard.press("z");
  await card(ready).waitFor();
  assert.deepEqual(state.undos, ["inbox-feed-e2e-move-1"], "Z undoes the last move");
  assert.equal(await sectionOf(ready), "ready", "Undo returns the card to its section");
  result.checks.push("Z undoes the move and the card returns");

  await card(waits).locator(".ctf-title").click({ button: "right" });
  const report = page.getByRole("menuitem", { name: "Report event and resume", exact: true });

  await report.waitFor();
  const submitted = page.waitForRequest((request) => request.url().endsWith("/api/v1/inbox/act"));

  await report.click();
  assert.deepEqual((await submitted).postDataJSON(), {
    action: "happened",
    threadId: waits.id,
    waitId: "wait-e2e-report",
    note: null,
  });
  result.checks.push("Right-click Report event and resume reports the selected On you wait");

  await page.setViewportSize({ width: 390, height: 844 });

  if (!(await list.isVisible()))
    await page.getByRole("button", { name: /^Toggle sidebar/u }).click();
  await list.waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  assert.equal(
    await list.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
    false,
    "The 390px Inbox has no horizontal overflow",
  );
  await page.screenshot({ path: `${evidence}/narrow.png` });
  result.checks.push("The 390px Inbox has no horizontal overflow");

  assert.deepEqual(errors, [], "The Inbox raises no page errors");
  result.acts = state.acts;
  result.undos = state.undos;
  await writeFile(`${evidence}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: "passed",
      installed,
      checks: result.checks,
      blockedWrites: result.blocked,
      evidence,
    }),
  );
} finally {
  await browser.close();
}
