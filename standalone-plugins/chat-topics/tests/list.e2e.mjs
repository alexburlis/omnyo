import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { z } from "zod";
import { assertNotificationMarkers } from "./notification-markers.mjs";

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const evidence = resolve(process.argv[2] ?? "evidence/installed-list");

const threadSchema = z.object({
  id: z.string(),
  visibility: z.string(),
  archivedAt: z.number().nullable(),
  deletedAt: z.number().nullable(),
});

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  threads: z.array(threadSchema),
});

const bootstrapSchema = z.object({
  projects: z.array(projectSchema),
  personalProject: projectSchema,
});

const checks = [];

const errors = [];

const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.request.get(`${origin}/api/v1/sidebar-bootstrap`);
  assert.equal(response.status(), 200, "The installed sidebar must be reachable");
  const bootstrap = bootstrapSchema.parse(await response.json());
  const liveIds = new Set();
  const liveByProject = new Map();
  const catalog = [...bootstrap.projects, bootstrap.personalProject];

  for (const project of catalog) {
    const ids = project.threads.filter(
      (thread) =>
        thread.visibility === "visible" && thread.archivedAt === null && thread.deletedAt === null,
    );

    liveByProject.set(project.id, ids.length);

    for (const thread of ids) liveIds.add(thread.id);
  }

  await page.goto(origin);
  const list = page.locator("[data-chat-topics]");
  await list.waitFor({ state: "visible", timeout: 90000 });
  const initialView = await list.getAttribute("data-chat-topics");

  const initialScope = await list.getAttribute("data-chat-scope");
  const scoped = initialScope !== null;

  async function checkCount(expected = liveIds.size, scope = null) {
    await page.waitForFunction(
      ([count, key]) => {
        const element = document.querySelector("[data-chat-topics]");

        return (
          element?.getAttribute("data-chat-total") === String(count) &&
          (key === null || element.getAttribute("data-chat-scope") === key)
        );
      },
      [expected, scope],
      { timeout: 20000 },
    );
    assert.equal(
      Number(await list.getAttribute("data-chat-reachable")),
      expected,
      "Every visible live chat must remain reachable in the sidebar tree",
    );
  }

  const railTile = (name) =>
    page
      .getByRole("group", { name: "Projects" })
      .getByRole("button", {
        name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(,|$)`, "u"),
      })
      .and(page.locator("[data-rail-tile]"));

  async function selectScope(key) {
    if (key === "inbox")
      await page
        .getByRole("button", { name: /^Inbox(,|$)/u })
        .first()
        .click();
    else await railTile(catalog.find((project) => project.id === key).name).click();
  }

  async function checkNoOverlap(label) {
    const overlaps = await list.evaluate(async (element) => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

      const boxes = [...element.querySelectorAll(".ct-item, .ctf-row")]
        .map((item) => item.getBoundingClientRect())
        .sort((a, b) => a.top - b.top);

      return boxes.filter((box, index) => index > 0 && box.top < boxes[index - 1].bottom - 1)
        .length;
    });

    assert.equal(overlaps, 0, `${label}: sidebar rows must not overlap`);
  }

  try {
    if (scoped) {
      await selectScope("inbox");
      await checkCount(liveIds.size, "inbox");
      await checkNoOverlap("Inbox scope");
      await page.screenshot({ path: `${evidence}/inbox-desktop.png` });
      checks.push("Inbox scope: live chat count and tree reachability match bootstrap");

      const firstId = await list
        .locator("[data-sidebar-thread-id]")
        .first()
        .getAttribute("data-sidebar-thread-id");

      const shared = catalog.find((project) =>
        project.threads.some((thread) => thread.id === firstId),
      ).id;

      await selectScope(shared);
      await checkCount(liveByProject.get(shared), shared);
      await checkNoOverlap("Project scope after Inbox");
      await page.screenshot({ path: `${evidence}/shared-project-desktop.png` });
      checks.push("Rows kept from Inbox are re-laid out without overlap in their project scope");

      const busiest = [...liveByProject].sort((a, b) => b[1] - a[1])[0];
      await selectScope(busiest[0]);
      await checkCount(busiest[1], busiest[0]);
      await checkNoOverlap("Busiest project scope");
      const markedRows = await assertNotificationMarkers(page, list);
      checks.push({ notificationMarkers: markedRows });
      await page.screenshot({ path: `${evidence}/project-desktop.png` });
      checks.push(`Project scope: ${busiest[1]} chats of the busiest project are reachable`);

      const emptyProjects = [];

      for (const project of catalog)
        if (
          liveByProject.get(project.id) === 0 &&
          (await railTile(project.name).count()) > 0 &&
          (await railTile(project.name).first().isVisible())
        )
          emptyProjects.push(project);

      let navigationOnly = 0;

      for (const project of emptyProjects) {
        await selectScope(project.id);
        await checkCount(0, project.id);

        if ((await list.locator('[role="tree"] [role="treeitem"]').count()) > 0) {
          assert.equal(
            await list.locator(".ct-empty").count(),
            0,
            "A project with shared navigation but no chats lists its navigation instead of the empty state",
          );
          navigationOnly += 1;
          continue;
        }

        await page.locator(".ct-empty").waitFor({ state: "visible", timeout: 5000 });
        await page.screenshot({ path: `${evidence}/empty-project-desktop.png` });
        checks.push("Empty project scope shows its empty state with New chat");
        break;
      }

      if (navigationOnly > 0)
        checks.push(
          `${navigationOnly} project(s) without chats list their shared navigation instead of the empty state`,
        );

      await selectScope("inbox");
    } else {
      for (const view of ["Projects", "Inbox"]) {
        await list
          .getByRole("group", { name: "Chat view" })
          .getByRole("button", { name: view, exact: true })
          .click();
        await checkCount();
        await page.screenshot({ path: `${evidence}/${view.toLowerCase()}-desktop.png` });
        checks.push(`${view}: live chat count and tree reachability match bootstrap`);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });

    if (!(await list.isVisible()))
      await page.getByRole("button", { name: /^Toggle sidebar/u }).click();
    await list.waitFor({ state: "visible", timeout: 5000 });
    await checkCount();
    assert.equal(
      await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      "The narrow sidebar must not overflow horizontally",
    );
    await page.screenshot({ path: `${evidence}/inbox-narrow.png` });
    checks.push("390px sidebar has no horizontal overflow");
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 });

    if (scoped) await selectScope(initialScope).catch(() => {});
    else if (initialView === "projects" || initialView === "inbox")
      await list
        .getByRole("button", {
          name: initialView === "projects" ? "Projects" : "Inbox",
          exact: true,
        })
        .click();
  }

  assert.deepEqual(errors, [], "The rendered plugin must have no page errors");
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        origin,
        liveChats: liveIds.size,
        checks,
        limits:
          "Read-only installed UI check. No provider turn, title mutation, or settings change is performed.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ liveChats: liveIds.size, checks: checks.length, evidence }));
} finally {
  await browser.close();
}
