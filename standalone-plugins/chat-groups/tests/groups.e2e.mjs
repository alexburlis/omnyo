import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const threadId = process.env.OMNYO_THREAD_ID ?? "thr_example";

const projectId = process.env.OMNYO_PROJECT_ID ?? "proj_demo";

const evidence = process.argv[2] ?? "evidence/project-groups-actions";

const browser = await chromium.launch({ channel: "chrome", headless: true });

const checks = [];

const errors = [];

try {
  await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const liveBootstrap = await (await page.request.get(`${origin}/api/v1/sidebar-bootstrap`)).json();
  const projectName = liveBootstrap.projects.find((entry) => entry.id === projectId).name;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/projects/${projectId}/threads/${threadId}`);
  const toggle = page.getByRole("group", { name: "Chat view" });

  const openToggle = async () => {
    if (!(await toggle.isVisible()))
      await page.getByRole("button", { name: "Chat view", exact: true }).click();
    await toggle.waitFor({ timeout: 20000 });
  };

  await openToggle();
  await toggle.getByRole("button", { name: "Group chats by status" }).click();
  await page.locator('[data-chat-groups="list"]').waitFor();
  assert.equal(
    await page.locator('[data-chat-groups="list"]').evaluate((element) => element.scrollTop),
    0,
    "Opening a parent chat must keep unread groups visible at the top",
  );
  await page
    .getByRole("group", { name: "Chat project" })
    .getByText(projectName, { exact: true })
    .waitFor();
  await page.screenshot({ path: `${evidence}/live-desktop.png` });
  await toggle.getByRole("button", { name: "Show project view" }).click();
  await page.locator('[data-sidebar="content"] [data-omnyo-plugin="thread-list"]').waitFor();
  assert.equal(await page.locator('[data-chat-groups="list"]').count(), 0);
  await page.reload();
  await page.locator('[data-sidebar="content"] [data-omnyo-plugin="thread-list"]').waitFor();
  await openToggle();
  await page
    .getByRole("group", { name: "Chat view" })
    .getByRole("button", { name: "Group chats by status" })
    .click();
  await page.locator('[data-chat-groups="list"]').waitFor();
  checks.push(
    "Installed toggle restores the original project list, persists across reloads, and preserves the project pill",
  );

  const bootstrap = await (await page.request.get(`${origin}/api/v1/sidebar-bootstrap`)).json();
  const fullThread = await (await page.request.get(`${origin}/api/v1/threads/${threadId}`)).json();
  const project = bootstrap.projects.find((entry) => entry.id === projectId);

  const other = bootstrap.projects.find(
    (entry) => entry.id !== projectId && entry.threads.length > 0,
  );

  const template = project.threads.find((thread) => thread.id === threadId);
  assert.ok(template && other, "Live bootstrap must provide complete host fixtures");
  const now = Date.now();

  const activity = {
    activeBackgroundAgentCount: 0,
    activeBackgroundCommandCount: 0,
    activeGoalCount: 0,
    activePlanModeCount: 0,
    activeWorkflowCount: 0,
  };

  const fixture = (id, changes = {}) => ({
    ...template,
    id,
    title: id,
    titleFallback: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    sectionId: null,
    visibility: "visible",
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinSortKey: null,
    status: "idle",
    runtime: { displayStatus: "idle" },
    queuedWork: "none",
    activity,
    hasPendingInteraction: false,
    lastReadAt: now,
    latestAttentionAt: now - 1000,
    updatedAt: now,
    ...changes,
  });

  let rows = [
    fixture("thr_fixture_reply", {
      hasPendingInteraction: true,
      status: "active",
      runtime: { displayStatus: "active" },
      lastReadAt: null,
    }),
    fixture("thr_fixture_unread", { lastReadAt: null }),
    fixture("thr_fixture_unfinished", {
      title:
        "Review sidebar grouping and keep every sub-agent conversation beneath its parent chat",
    }),
    fixture("thr_fixture_ready"),
    fixture("thr_fixture_working", { status: "active", runtime: { displayStatus: "active" } }),
    fixture("thr_fixture_ready_unread", { lastReadAt: null }),
    fixture("thr_fixture_ready_working", {
      status: "active",
      runtime: { displayStatus: "active" },
    }),
    fixture("thr_fixture_decision"),
    fixture("thr_fixture_hidden", { visibility: "hidden" }),
    fixture("thr_fixture_archived", { archivedAt: now }),
    fixture("thr_fixture_parent", { latestAttentionAt: now + 2000, lastReadAt: now + 3000 }),
    fixture("thr_fixture_child", { parentThreadId: "thr_fixture_parent", lastReadAt: null }),
    fixture("thr_fixture_grandchild", {
      parentThreadId: "thr_fixture_child",
      lastReadAt: null,
    }),
    fixture("thr_fixture_error_child", {
      parentThreadId: "thr_fixture_parent",
      status: "error",
      runtime: { displayStatus: "error" },
      lastReadAt: null,
    }),
    fixture("thr_fixture_hidden_child", {
      parentThreadId: "thr_fixture_parent",
      visibility: "hidden",
    }),
    fixture("thr_fixture_archived_child", {
      parentThreadId: "thr_fixture_parent",
      archivedAt: now,
    }),
    fixture("thr_fixture_child_of_hidden", { parentThreadId: "thr_fixture_hidden" }),
    fixture("thr_fixture_child_of_archived", { parentThreadId: "thr_fixture_archived" }),
  ];

  const readyIds = ["thr_fixture_ready", "thr_fixture_ready_unread", "thr_fixture_ready_working"];
  let otherRows = [fixture("thr_fixture_other_project", { projectId: other.id, lastReadAt: null })];

  await page.route("**/api/v1/sidebar-bootstrap*", (route) =>
    route.fulfill({
      json: {
        ...bootstrap,
        projects: bootstrap.projects.map((entry) => ({
          ...entry,
          threads:
            entry.id === projectId
              ? rows.filter((thread) => thread.projectId === projectId)
              : entry.id === other.id
                ? [...rows.filter((thread) => thread.projectId === other.id), ...otherRows]
                : [],
        })),
        personalProject: { ...bootstrap.personalProject, threads: [] },
      },
    }),
  );
  await page.route("**/plugins/tidy/rpc/ready_ids", (route) =>
    route.fulfill({
      json: {
        ok: true,
        result: {
          threadIds: readyIds,
        },
      },
    }),
  );
  await page.route("**/plugins/decisions/rpc/open_index", (route) =>
    route.fulfill({
      json: { ok: true, result: { threads: [{ threadId: "thr_fixture_decision", count: 1 }] } },
    }),
  );
  await page.route("**/plugins/workflows/rpc/workflowActiveRuns", (route) =>
    route.fulfill({
      json: { ok: true, result: { runs: [] } },
    }),
  );
  await page.reload();
  const list = page.locator('[data-chat-groups="list"]');
  await list.locator('[data-sidebar-thread-id="thr_fixture_decision"]').waitFor();

  await page.screenshot({ path: `${evidence}/hierarchy-before-check.png` });

  const sharedProject = list.locator(
    `[data-chat-project-header="${projectId}"][data-chat-group="unfinished"]`,
  );

  const decisionRow = list.locator(".cg-row").filter({
    has: page.locator('[data-sidebar-thread-id="thr_fixture_decision"]'),
  });

  await decisionRow.scrollIntoViewIfNeeded();

  const baselineActions = await decisionRow.evaluate((row) => ({
    decisionRightGap:
      row.getBoundingClientRect().right -
      row.querySelector(".cg-row-status").getBoundingClientRect().right,
    archiveButtons: document.querySelectorAll("[data-archive-suggestion]").length,
    projectPills: document.querySelectorAll("[data-chat-project-header]").length,
  }));

  await writeFile(`${evidence}/before-actions.json`, JSON.stringify(baselineActions, null, 2));
  assert.equal(
    await sharedProject.count(),
    1,
    "The two unfinished roots in one project must share one project pill and enclosure",
  );
  assert.equal(await sharedProject.locator(".cg-project-group-name").innerText(), project.name);
  assert.equal(await list.locator(".cg-project-tag").count(), 0);

  const projectBlocks = await list.locator('[data-chat-depth="0"]').evaluateAll((roots) =>
    roots.map((row) => ({
      id: row.getAttribute("data-sidebar-thread-id"),
      block: row.closest(".cg-list-item").getAttribute("data-project-block"),
    })),
  );

  assert.equal(
    projectBlocks.find((row) => row.id === "thr_fixture_parent").block,
    projectBlocks.find((row) => row.id === "thr_fixture_unfinished").block,
  );

  const rightGap = () =>
    decisionRow.evaluate((row) => {
      const indicator = row.querySelector(".cg-row-status").getBoundingClientRect();

      return row.getBoundingClientRect().right - indicator.right;
    });

  const idleGap = await rightGap();
  assert.ok(idleGap <= 4, "The decision indicator must sit at the row's trailing edge");
  await decisionRow.hover();
  assert.equal(await rightGap(), idleGap, "Hover actions must not move the decision indicator");
  await page.keyboard.down("Meta");
  assert.equal(await decisionRow.locator(".cg-row-status").count(), 1);
  assert.equal(await rightGap(), idleGap);
  await page.keyboard.up("Meta");
  checks.push(
    "One visible project pill encloses its roots per status without repeated project labels; decision indicators stay at the trailing edge on hover and shortcut mode",
  );
  assert.deepEqual(
    await list
      .locator("[data-chat-section-header]")
      .evaluateAll((headers) =>
        headers.map((header) => header.getAttribute("data-chat-section-header")),
      ),
    ["unread", "read", "working"],
    "Unread, Read and Working must be distinct top-level sections rather than repeated row labels",
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_ready_unread"]')
        ?.getAttribute("data-chat-group") === "unread-ready",
  );

  const sectionCounts = await list
    .locator("[data-chat-section-header]")
    .evaluateAll((headers) =>
      Object.fromEntries(
        headers.map((header) => [
          header.getAttribute("data-chat-section-header"),
          Number(header.querySelector(".cg-section-count").textContent),
        ]),
      ),
    );

  assert.deepEqual(sectionCounts, { unread: 4, read: 4, working: 2 });
  assert.equal(await list.locator(".cg-read-label").count(), 0);
  const readSection = list.locator('[data-chat-section-header="read"]');
  await readSection.click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-sidebar-thread-id][data-chat-section="read"]').length === 0,
  );
  assert.equal(await readSection.getAttribute("aria-expanded"), "false");
  assert.equal(await readSection.locator(".cg-section-count").innerText(), "4");
  assert.ok(await list.locator('[data-chat-section="unread"][data-sidebar-thread-id]').count());
  await readSection.click();
  await list.locator('[data-sidebar-thread-id="thr_fixture_parent"]').waitFor();
  checks.push(
    "Unread, Read and Working are counted top-level sections; collapsing a section hides only its descendants and preserves its root count",
  );
  assert.equal(
    await list
      .locator('[data-sidebar-thread-id="thr_fixture_reply"]')
      .getAttribute("data-chat-group"),
    "unread-needs-you",
    "Unread input requests must have their own group above read input requests",
  );
  assert.equal(
    await list.locator('[data-sidebar-thread-id="thr_fixture_child"]').count(),
    0,
    "Unread sub-agent chats must stay under their collapsed parent, never become independent status rows",
  );
  const parent = list.locator('[data-sidebar-thread-id="thr_fixture_parent"]');
  assert.equal(await parent.getAttribute("data-chat-group"), "unfinished");
  const unfinishedCount = list.locator('[data-chat-group-header="unfinished"] .cg-group-count');
  assert.equal(await unfinishedCount.innerText(), "2");

  const parentRow = list.locator(".cg-row").filter({
    has: page.locator('[data-sidebar-thread-id="thr_fixture_parent"]'),
  });

  const expandParent = parentRow.getByRole("button", {
    name: "Expand sub-chats for thr_fixture_parent",
  });

  assert.equal(await expandParent.getAttribute("aria-expanded"), "false");
  await expandParent.click();
  const child = list.locator('[data-sidebar-thread-id="thr_fixture_child"]');
  await child.waitFor();
  assert.equal(await child.getAttribute("data-parent-thread-id"), "thr_fixture_parent");
  assert.equal(await child.getAttribute("data-chat-depth"), "1");
  assert.equal(await child.getAttribute("data-chat-group"), "unfinished");

  const alignment = await list.evaluate((element) => {
    const title = (id) =>
      element
        .querySelector(`[data-sidebar-thread-id="${id}"] .cg-row-title`)
        .getBoundingClientRect().left;

    const parent = element.querySelector('[data-sidebar-thread-id="thr_fixture_parent"]');

    return {
      parent: title("thr_fixture_parent"),
      leaf: title("thr_fixture_unfinished"),
      child: title("thr_fixture_child"),
      childCountLeft: parent.querySelector(".cg-child-count").getBoundingClientRect().left,
      childCount: parent.querySelector(".cg-child-count").textContent,
    };
  });

  assert.ok(
    Math.abs(alignment.parent - alignment.leaf) < 1,
    "Parent and leaf titles must share an alignment edge",
  );
  assert.equal(alignment.child - alignment.parent, 16);
  assert.equal(alignment.childCountLeft, alignment.parent);
  assert.equal(alignment.childCount, "2 sub-chats");
  assert.equal(await list.locator('[data-sidebar-thread-id="thr_fixture_grandchild"]').count(), 0);

  const childRow = list.locator(".cg-row").filter({
    has: page.locator('[data-sidebar-thread-id="thr_fixture_child"]'),
  });

  await childRow.getByRole("button", { name: "Expand sub-chats for thr_fixture_child" }).click();
  const grandchild = list.locator('[data-sidebar-thread-id="thr_fixture_grandchild"]');
  await grandchild.waitFor();
  assert.equal(await grandchild.getAttribute("data-chat-depth"), "2");
  assert.equal(await grandchild.getAttribute("data-parent-thread-id"), "thr_fixture_child");

  const nestedRows = await list
    .locator("[data-chat-depth]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-sidebar-thread-id")),
    );

  assert.ok(nestedRows.indexOf("thr_fixture_child") < nestedRows.indexOf("thr_fixture_grandchild"));
  assert.equal(await child.count(), 1);
  assert.equal(
    await unfinishedCount.innerText(),
    "2",
    "Expanding children must not increase section counts",
  );
  assert.equal(
    await list
      .locator(
        '[data-sidebar-thread-id="thr_fixture_hidden_child"], [data-sidebar-thread-id="thr_fixture_archived_child"], [data-sidebar-thread-id="thr_fixture_child_of_hidden"], [data-sidebar-thread-id="thr_fixture_child_of_archived"]',
      )
      .count(),
    0,
  );
  await page.screenshot({ path: `${evidence}/hierarchy-expanded.png` });
  await parentRow
    .getByRole("button", { name: "Collapse sub-chats for thr_fixture_parent" })
    .click();
  await child.waitFor({ state: "detached" });
  assert.equal(await grandchild.count(), 0);
  checks.push(
    "Unread and errored children stay under their parent; expandable multilevel sub-chats never increase status counts; hidden and archived branches stay excluded",
  );

  for (const [id, group] of [
    ["thr_fixture_reply", "unread-needs-you"],
    ["thr_fixture_decision", "read-needs-you"],
    ["thr_fixture_unread", "unread"],
    ["thr_fixture_ready_unread", "unread-ready"],
    ["thr_fixture_unfinished", "unfinished"],
    ["thr_fixture_ready", "ready"],
    ["thr_fixture_working", "working"],
    ["thr_fixture_ready_working", "working"],
    ["thr_fixture_other_project", "unread"],
  ]) {
    const row = list.locator(`[data-sidebar-thread-id="${id}"]`);
    await row.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      ({ id, group }) =>
        document
          .querySelector(`[data-sidebar-thread-id="${id}"]`)
          ?.getAttribute("data-chat-group") === group,
      { id, group },
    );
    assert.equal(await row.getAttribute("data-chat-group"), group, id);
  }

  assert.deepEqual(
    await list
      .locator("[data-chat-group-header]")
      .evaluateAll((headers) =>
        headers.map((header) => header.getAttribute("data-chat-group-header")),
      ),
    [
      "unread-needs-you",
      "unread",
      "unread-ready",
      "read-needs-you",
      "unfinished",
      "ready",
      "working",
    ],
  );

  const readableRow = list.locator('[data-sidebar-thread-id="thr_fixture_unfinished"]');

  const typography = await readableRow.evaluate((row) => {
    const title = row.querySelector(".cg-row-title");

    return {
      titleSize: parseFloat(getComputedStyle(title).fontSize),
      projectSize: parseFloat(
        getComputedStyle(
          document.querySelector(
            `[data-chat-project-header="${row.getAttribute("data-project-id")}"][data-chat-group="${row.getAttribute("data-chat-group")}"] .cg-project-group-name`,
          ),
        ).fontSize,
      ),
      titleHeight: title.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(title).lineHeight),
      tooltip: row.getAttribute("title"),
    };
  });

  assert.ok(typography.titleSize >= 14 && typography.projectSize >= 12);
  assert.ok(
    typography.titleHeight > typography.lineHeight * 1.5,
    "A long chat title must wrap to two visible lines",
  );
  assert.equal(
    typography.tooltip,
    rows.find((thread) => thread.id === "thr_fixture_unfinished").title,
  );

  const headingHierarchy = await list.evaluate((element) => {
    const section = element.querySelector('[data-chat-section-header="read"]');
    const status = element.querySelector('[data-chat-group-header="read-needs-you"]');

    return {
      sectionWeight: Number(getComputedStyle(section).fontWeight),
      statusWeight: Number(getComputedStyle(status).fontWeight),
      statusHeight: status.getBoundingClientRect().height,
      sectionLabel: section.querySelector(".cg-section-title").textContent,
      statusLabel: status.querySelector(".cg-group-title").textContent,
    };
  });

  assert.ok(headingHierarchy.sectionWeight > headingHierarchy.statusWeight);
  assert.ok(headingHierarchy.statusHeight <= 36);
  assert.equal(headingHierarchy.sectionLabel, "Read");
  assert.equal(headingHierarchy.statusLabel, "Needs you");
  checks.push(
    "Seven statuses retain the requested order within three primary sections; subordinate one-line status headings, aligned rows and explicit sub-chat counts make the hierarchy visible",
  );
  await page.setViewportSize({ width: 1440, height: 650 });
  await readableRow.scrollIntoViewIfNeeded();
  await list.evaluate((element) => {
    const row = element.querySelector('[data-sidebar-thread-id="thr_fixture_unfinished"]');
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - 50;
  });
  const stickyRead = list.locator('[data-sticky-section="read"]');
  await stickyRead.waitFor();
  assert.equal(await stickyRead.locator(".cg-section-title").innerText(), "Read");
  await page.screenshot({ path: `${evidence}/section-context.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  checks.push(
    "The primary Read section stays visible when scrolling through its nested status groups",
  );
  assert.equal(
    await list
      .locator(
        '[data-sidebar-thread-id="thr_fixture_hidden"], [data-sidebar-thread-id="thr_fixture_archived"]',
      )
      .count(),
    0,
  );
  checks.push(
    "Seven groups separate unread/read input requests and completion, include all projects, and exclude hidden or archived chats",
  );
  rows = rows.map((thread) =>
    thread.id === "thr_fixture_ready_unread" ? { ...thread, lastReadAt: now + 1000 } : thread,
  );
  await page.reload();
  const moved = page.locator('[data-sidebar-thread-id="thr_fixture_ready_unread"]');
  await moved.waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_ready_unread"]')
        ?.getAttribute("data-chat-group") === "ready",
  );
  assert.equal(await moved.getAttribute("data-chat-group"), "ready");
  assert.equal(await moved.count(), 1);
  checks.push("A read marked chat moves from Unread to Ready to archive without duplication");
  await page.screenshot({ path: `${evidence}/grouping-fixtures.png` });
  await page.route("**/api/v1/threads/thr_fixture_unread/read", async (route) => {
    assert.equal(route.request().method(), "POST");
    rows = rows.map((thread) =>
      thread.id === "thr_fixture_unread" ? { ...thread, lastReadAt: now + 2000 } : thread,
    );
    const read = rows.find((thread) => thread.id === "thr_fixture_unread");
    await route.fulfill({
      json: { ...fullThread, ...read, activeBackgroundAgentCount: 0, queuedMessageCount: 0 },
    });
  });

  const unreadRow = page
    .locator(".cg-row")
    .filter({ has: page.locator('[data-sidebar-thread-id="thr_fixture_unread"]') });

  await unreadRow.getByRole("button", { name: "Chat actions for thr_fixture_unread" }).click();
  await page.getByRole("menuitem", { name: "Mark as read", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_unread"]')
        ?.getAttribute("data-chat-group") === "unfinished",
  );
  checks.push(
    "The row's Mark as read action updates its live group through Omnyo's mutation path, with the write confined to a controlled browser response",
  );

  rows = [
    fixture("thr_fixture_parent"),
    fixture("thr_fixture_child", { parentThreadId: "thr_fixture_parent", lastReadAt: null }),
    fixture("thr_fixture_grandchild", { parentThreadId: "thr_fixture_child", lastReadAt: null }),
    fixture("thr_fixture_working_unread", {
      status: "active",
      runtime: { displayStatus: "active" },
      lastReadAt: null,
    }),
    fixture("thr_fixture_queued_unread", { queuedWork: "waiting", lastReadAt: null }),
    fixture("thr_fixture_queued_failed", { queuedWork: "failed", lastReadAt: null }),
    fixture("thr_fixture_background_unread", {
      activity: { ...activity, activeBackgroundCommandCount: 1 },
      lastReadAt: null,
    }),
    fixture("thr_fixture_root_error", {
      status: "error",
      runtime: { displayStatus: "error" },
      lastReadAt: null,
    }),
    fixture("thr_fixture_ready"),
  ];
  await page.reload();
  await parent.waitFor();

  for (const [id, group] of [
    ["thr_fixture_parent", "unfinished"],
    ["thr_fixture_working_unread", "working"],
    ["thr_fixture_queued_unread", "working"],
    ["thr_fixture_queued_failed", "unread-needs-you"],
    ["thr_fixture_background_unread", "working"],
    ["thr_fixture_root_error", "unread-needs-you"],
    ["thr_fixture_ready", "ready"],
  ]) {
    await page.waitForFunction(
      ({ id, group }) =>
        document
          .querySelector(`[data-sidebar-thread-id="${id}"]`)
          ?.getAttribute("data-chat-group") === group,
      { id, group },
    );
  }

  rows = rows.map((thread) =>
    thread.id === "thr_fixture_grandchild" ? { ...thread, hasPendingInteraction: true } : thread,
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_parent"]')
        ?.getAttribute("data-chat-group") === "read-needs-you",
  );
  rows = rows.map((thread) =>
    thread.id === "thr_fixture_grandchild"
      ? {
          ...thread,
          hasPendingInteraction: false,
          status: "active",
          runtime: { displayStatus: "active" },
        }
      : thread,
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_parent"]')
        ?.getAttribute("data-chat-group") === "working",
  );
  rows = rows.map((thread) =>
    thread.id === "thr_fixture_grandchild"
      ? { ...thread, status: "idle", runtime: { displayStatus: "idle" } }
      : thread,
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_parent"]')
        ?.getAttribute("data-chat-group") === "unfinished",
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_ready"]')
        ?.getAttribute("data-chat-group") === "ready",
  );

  const colors = await list
    .locator("[data-chat-group-header]")
    .evaluateAll((headers) =>
      headers.map((header) => getComputedStyle(header.querySelector(".cg-group-icon")).color),
    );

  assert.equal(
    new Set(colors).size,
    5,
    "Attention, unread replies, unfinished, ready and working retain distinct theme colors",
  );

  const groupCounts = await list
    .locator("[data-chat-group-header]")
    .evaluateAll((headers) =>
      Object.fromEntries(
        headers.map((header) => [
          header.getAttribute("data-chat-group-header"),
          Number(header.querySelector(".cg-group-count").textContent),
        ]),
      ),
    );

  assert.deepEqual(groupCounts, {
    "unread-needs-you": 2,
    unread: 1,
    unfinished: 1,
    ready: 1,
    working: 3,
  });
  assert.ok(
    Object.values(groupCounts).every((count) => count > 0),
    "Empty sections must not clutter the list",
  );
  checks.push(
    "Actual child input and active work roll up to the root across depths; successful or errored unread child replies do not; active, queued and background unread roots stay Working",
  );
  checks.push(
    "All five section accents resolve to distinct theme colors and counts include only top-level chats",
  );

  readyIds.push("thr_fixture_parent");
  rows = rows.map((thread) =>
    thread.id === "thr_fixture_grandchild" ? { ...thread, hasPendingInteraction: true } : thread,
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_parent"]')
        ?.getAttribute("data-chat-group") === "read-needs-you",
  );
  assert.equal(
    await parentRow.locator(".cg-row-status").getAttribute("aria-label"),
    "Sub-chat needs input",
  );
  rows = rows.map((thread) =>
    thread.id === "thr_fixture_grandchild"
      ? {
          ...thread,
          hasPendingInteraction: false,
          status: "active",
          runtime: { displayStatus: "active" },
        }
      : thread,
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_parent"]')
        ?.getAttribute("data-chat-group") === "working",
  );
  assert.equal(
    await parentRow.locator(".cg-row-status").getAttribute("aria-label"),
    "Sub-chats working",
  );
  rows = rows.map((thread) =>
    thread.id === "thr_fixture_grandchild"
      ? { ...thread, status: "idle", runtime: { displayStatus: "idle" } }
      : thread,
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-sidebar-thread-id="thr_fixture_parent"]')
        ?.getAttribute("data-chat-group") === "ready",
  );
  checks.push(
    "A parent's stale completion glyph yields to actual child input and live work; unread child replies do not block an idle parent's completion mark",
  );

  const grandchildResponse = () => ({
    ...fullThread,
    ...rows.find((thread) => thread.id === "thr_fixture_grandchild"),
    activeBackgroundAgentCount: 0,
    queuedMessageCount: 0,
  });

  await page.route("**/api/v1/threads/thr_fixture_grandchild", (route) =>
    route.fulfill({ json: grandchildResponse() }),
  );
  await page.route("**/api/v1/threads/thr_fixture_grandchild/read", (route) =>
    route.fulfill({ json: grandchildResponse() }),
  );
  await parentRow.getByRole("button", { name: "Expand sub-chats for thr_fixture_parent" }).click();
  await childRow.getByRole("button", { name: "Expand sub-chats for thr_fixture_child" }).click();
  assert.equal(
    await grandchild.getAttribute("href"),
    `/projects/${projectId}/threads/thr_fixture_grandchild`,
  );
  await grandchild.click();
  await page.waitForURL(`**/threads/thr_fixture_grandchild`);
  await list
    .locator('[data-sidebar-thread-id="thr_fixture_grandchild"][aria-current="page"]')
    .waitFor();
  assert.equal(await grandchild.getAttribute("aria-current"), "page");
  await list.locator('[data-chat-section-header="read"]').click();
  await grandchild.waitFor({ state: "detached" });
  await page.goBack();
  await page.waitForURL(`**/threads/${threadId}`);
  await page.goForward();
  await page.waitForURL("**/threads/thr_fixture_grandchild");
  await grandchild.waitFor();
  assert.equal(
    await list.locator('[data-chat-section-header="read"]').getAttribute("aria-expanded"),
    "true",
  );
  await page.reload();
  await list
    .locator('[data-sidebar-thread-id="thr_fixture_grandchild"][aria-current="page"]')
    .waitFor();
  assert.equal(await grandchild.getAttribute("aria-current"), "page");
  assert.equal(
    await parentRow
      .getByRole("button", { name: "Collapse sub-chats for thr_fixture_parent" })
      .getAttribute("aria-expanded"),
    "true",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('button[data-sidebar="trigger"]').first().click();
  await page.waitForFunction(
    () => document.querySelector('main[data-sidebar="inset"]')?.getBoundingClientRect().left > 250,
  );

  const parentToggleBounds = await parentRow
    .getByRole("button", { name: "Collapse sub-chats for thr_fixture_parent" })
    .boundingBox();

  assert.ok(
    parentToggleBounds &&
      parentToggleBounds.x >= 0 &&
      parentToggleBounds.x + parentToggleBounds.width <= 390,
  );
  await parentRow
    .getByRole("button", { name: "Collapse sub-chats for thr_fixture_parent" })
    .click();
  await child.waitFor({ state: "detached" });
  await parentRow.getByRole("button", { name: "Expand sub-chats for thr_fixture_parent" }).click();
  await grandchild.waitFor();
  await page.screenshot({ path: `${evidence}/hierarchy-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/projects/${projectId}/threads/${threadId}`);
  checks.push(
    "Child links use Omnyo navigation, direct child URLs reveal their ancestry on reload, and compact expansion stays operable without navigating away",
  );

  otherRows = [];
  rows = [
    fixture("thr_fixture_ready", { latestAttentionAt: now + 3000 }),
    fixture("thr_fixture_ready_unread", { latestAttentionAt: now + 1000 }),
    fixture("thr_fixture_ready_working", { projectId: other.id, latestAttentionAt: now + 2000 }),
  ];

  for (const id of readyIds.filter((id) => rows.some((thread) => thread.id === id))) {
    const response = () => ({
      ...fullThread,
      ...rows.find((thread) => thread.id === id),
      activeBackgroundAgentCount: 0,
      queuedMessageCount: 0,
    });

    await page.route(`**/api/v1/threads/${id}`, (route) => route.fulfill({ json: response() }));
    await page.route(`**/api/v1/threads/${id}/read`, (route) =>
      route.fulfill({ json: response() }),
    );
  }

  const archiveWrites = [];
  let pendingArchive = null;
  await page.route("**/plugins/tidy/rpc/archive", (route) => {
    assert.equal(route.request().method(), "POST");
    const input = route.request().postDataJSON();
    assert.equal(input.threadIds.length, 1);
    assert.ok(rows.some((thread) => thread.id === input.threadIds[0]));
    archiveWrites.push(input.threadIds[0]);
    pendingArchive = route;
  });

  const openFixture = async (id) => {
    await page.goto(`${origin}/projects/${projectId}/threads/${id}`);
    await list.locator(`[data-archive-suggestion="${id}"]`).waitFor();
  };

  const clickArchive = async (id, header = false) => {
    const button = header
      ? page.getByRole("button", { name: "Archive chat and open next", exact: true })
      : list.locator(`[data-archive-suggestion="${id}"]`);

    await button.waitFor({ timeout: 20000 });
    assert.equal(
      await button.count(),
      1,
      "Both sidebar and header suggestions must be direct archive actions",
    );
    await button.click();
    await page.waitForTimeout(100);
    assert.ok(pendingArchive, "The archive suggestion must call Tidy's checked archive endpoint");
    assert.equal(await button.isDisabled(), true);
    assert.ok(
      page.url().endsWith(`/threads/${id}`),
      "Do not navigate before archive acknowledgement",
    );
  };

  const succeedArchive = async (id) => {
    rows = rows.filter((thread) => thread.id !== id);
    const route = pendingArchive;
    pendingArchive = null;
    await route.fulfill({ json: { ok: true, result: { archived: 1, failures: [] } } });
  };

  await openFixture("thr_fixture_ready");
  assert.deepEqual(
    await list
      .locator('[data-chat-depth="0"]')
      .evaluateAll((roots) => roots.map((row) => row.getAttribute("data-sidebar-thread-id"))),
    ["thr_fixture_ready", "thr_fixture_ready_unread", "thr_fixture_ready_working"],
    "Interleaved activity must become contiguous project blocks while preserving each project's recency order",
  );
  assert.equal(
    await list
      .locator(`[data-chat-project-header="${projectId}"][data-chat-group="unread-ready"]`)
      .count(),
    1,
  );
  assert.equal(
    await list
      .locator(`[data-chat-project-header="${other.id}"][data-chat-group="unread-ready"]`)
      .count(),
    1,
  );
  await clickArchive("thr_fixture_ready");
  assert.deepEqual(archiveWrites, ["thr_fixture_ready"]);
  await page.screenshot({ path: `${evidence}/archive-pending.png` });
  await succeedArchive("thr_fixture_ready");
  await page.waitForURL("**/threads/thr_fixture_ready_unread");
  await page.reload();
  await list.locator('[data-archive-suggestion="thr_fixture_ready_unread"]').waitFor();
  assert.equal(await list.locator('[data-sidebar-thread-id="thr_fixture_ready"]').count(), 0);
  await page.screenshot({ path: `${evidence}/archive-next.png` });

  for (const header of [false, true]) {
    await clickArchive("thr_fixture_ready_unread", header);
    const failedArchive = pendingArchive;
    pendingArchive = null;
    await failedArchive.fulfill({
      json: {
        ok: true,
        result: {
          archived: 0,
          failures: [{ threadId: "thr_fixture_ready_unread", message: "Chat still has work." }],
        },
      },
    });

    const feedback = header
      ? page.locator("[data-archive-action-error]")
      : list
          .locator(".cg-row")
          .filter({ has: page.locator('[data-sidebar-thread-id="thr_fixture_ready_unread"]') })
          .getByRole("alert");

    await feedback.waitFor();
    assert.ok(page.url().endsWith("/threads/thr_fixture_ready_unread"));
    assert.equal(
      await list.locator('[data-archive-suggestion="thr_fixture_ready_unread"]').isDisabled(),
      false,
    );
    await page.screenshot({
      path: `${evidence}/archive-${header ? "header" : "sidebar"}-failure.png`,
    });
  }

  await clickArchive("thr_fixture_ready_unread", true);
  await succeedArchive("thr_fixture_ready_unread");
  await page.waitForURL("**/threads/thr_fixture_ready_working");
  await page.reload();
  await clickArchive("thr_fixture_ready_working");
  await succeedArchive("thr_fixture_ready_working");
  await page.waitForURL((url) => url.pathname === "/");
  await page
    .locator("main")
    .getByRole("button", { name: `Project: ${other.name}`, exact: true })
    .waitFor();
  await page.screenshot({ path: `${evidence}/archive-empty.png` });
  assert.deepEqual(archiveWrites, [
    "thr_fixture_ready",
    "thr_fixture_ready_unread",
    "thr_fixture_ready_unread",
    "thr_fixture_ready_unread",
    "thr_fixture_ready_working",
  ]);
  checks.push(
    "Sidebar and header archive suggestions issue one checked write, wait for success before opening the next root, remain on failure with a visible error, and open the project's new-chat screen when the queue is empty",
  );
  await page.goto(`${origin}/projects/${projectId}/threads/${threadId}`);

  rows = Array.from({ length: 500 }, (_, index) =>
    fixture(`thr_fixture_bulk_${String(index).padStart(4, "0")}`, {
      latestAttentionAt: now - index * 1000,
    }),
  );
  await page.reload();
  const largeList = page.locator('[data-chat-groups="list"]');
  await largeList.locator('[data-chat-group-header="unfinished"]').waitFor();
  assert.ok(
    (await largeList.locator("[data-sidebar-thread-id]").count()) < 100,
    "500 chats must not mount 500 rows",
  );
  await largeList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await largeList.locator('[data-sidebar-thread-id="thr_fixture_bulk_0499"]').waitFor();
  await largeList.evaluate((element) => {
    element.scrollTop = 0;
  });
  const unfinishedGroup = largeList.locator('[data-chat-group-header="unfinished"]');
  await unfinishedGroup.waitFor();
  assert.ok((await unfinishedGroup.innerText()).includes("500"));
  await unfinishedGroup.click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-chat-group="unfinished"]').length === 0,
  );
  assert.equal(await unfinishedGroup.getAttribute("aria-expanded"), "false");
  checks.push(
    "500 chats keep a bounded rendered row count; the final row stays reachable; groups collapse while keeping their full count",
  );

  await page.unrouteAll({ behavior: "wait" });
  await page.reload();
  await page.locator('[data-chat-groups="list"]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.cg-project-pill[data-compact="true"]').waitFor();
  const sidebarButton = page.locator('button[data-sidebar="trigger"]').first();
  await sidebarButton.click();
  await openToggle();
  await page.waitForFunction(() => {
    const main = document.querySelector('main[data-sidebar="inset"]');

    return (
      main !== null &&
      main.getAttribute("data-sidebar-shelf") === "open" &&
      main.getBoundingClientRect().left > 250 &&
      main.getAnimations().length === 0
    );
  });

  await openToggle();

  const statusButton = page
    .getByRole("group", { name: "Chat view" })
    .getByRole("button", { name: "Group chats by status" });

  const bounds = await statusButton.boundingBox();
  assert.ok(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390,
    "The mobile toggle must fit the visible sidebar",
  );
  await page.screenshot({ path: `${evidence}/mobile.png` });
  await sidebarButton.click();
  await page.waitForFunction(() => {
    const main = document.querySelector('main[data-sidebar="inset"]');

    return (
      main !== null &&
      main.getAttribute("data-sidebar-shelf") === "closed" &&
      Math.abs(main.getBoundingClientRect().left) < 1 &&
      main.getAnimations().length === 0
    );
  });

  const pill = page
    .getByRole("group", { name: "Chat project" })
    .getByText(projectName, { exact: true });

  assert.ok(await pill.isVisible(), "The compact chat must show the project name");
  await page.screenshot({ path: `${evidence}/mobile-chat.png` });
  checks.push("Compact layout keeps the view toggle and the named project pill");
  assert.deepEqual(errors, []);
  await writeFile(
    `${evidence}/e2e.json`,
    JSON.stringify(
      {
        passed: true,
        checks,
        errors,
        at: new Date().toISOString(),
        browser: "Headless Google Chrome",
        surface: "Installed Omnyo UI plus controlled classification responses",
        mutations:
          "UI preferences and archive/read requests fulfilled only by controlled browser routes; no real archive or prompt dispatch",
      },
      null,
      2,
    ),
  );
  console.log(`PASS: ${evidence}/e2e.json`);
} catch (error) {
  await writeFile(
    `${evidence}/failure.json`,
    JSON.stringify(
      { passed: false, checks, errors, error: error.message, at: new Date().toISOString() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
