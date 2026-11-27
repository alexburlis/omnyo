import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const projectId = process.env.OMNYO_PROJECT_ID;

const threadId = process.env.OMNYO_THREAD_ID;

assert.ok(projectId && threadId, "Run from an Omnyo thread, or supply the project and thread IDs");

const browser = await chromium.launch({ channel: "chrome", headless: true });

const checks = [];

const errors = [];

const fixtureRequests = [];

let fixtureWrites = 0;

let sidebarProvider = "branch-tree/tree";

let preferenceEntry;

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  await mkdir("evidence", { recursive: true });
  // The installed UI is tested with a client-local preference response so another
  // sidebar plugin or person can change their view without changing this proof.
  await page.route("**/api/v1/preferences/ui", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    preferenceEntry = body.preferences["sidebar.threadListProvider"];
    body.preferences["sidebar.threadListProvider"].value = sidebarProvider;
    await route.fulfill({ json: body });
  });
  await page.route("**/api/v1/preferences/ui/sidebar.threadListProvider", async (route) => {
    assert.equal(route.request().method(), "PUT");
    const body = route.request().postDataJSON();
    sidebarProvider = body.value;
    await route.fulfill({
      json: {
        key: "sidebar.threadListProvider",
        ...preferenceEntry,
        value: body.value,
        revision: body.expectedRevision + 1,
      },
    });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/projects/${projectId}/threads/${threadId}`);
  await page.locator('[data-branch-tree="list"]').waitFor({ timeout: 20000 });
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".bt-list")).display === "flex",
  );
  await page.getByRole("button", { name: "Branch this chat", exact: true }).waitFor();
  await page.screenshot({ path: "evidence/live-desktop.png" });
  checks.push("Installed frontend loads on real chat data and exposes the native header action");

  const bootstrap = await (await page.request.get(`${origin}/api/v1/sidebar-bootstrap`)).json();

  const fullThread = await (
    await page.request.get(`${origin}/api/v1/threads/${threadId}?include=environment,host`)
  ).json();

  const timelineTemplate = await (
    await page.request.get(`${origin}/api/v1/threads/${threadId}/timeline?limit=1`)
  ).json();

  const emptyTimeline = {
    ...timelineTemplate,
    maxSeq: 0,
    rows: [],
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    contextWindowUsage: undefined,
    timelinePage: {
      ...timelineTemplate.timelinePage,
      returnedSegmentCount: 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };

  const project = bootstrap.projects.find((entry) => entry.id === projectId);
  const template = project?.threads.find((thread) => thread.id === threadId);
  assert.ok(template, "The current real chat supplies the host's complete response shape");
  const now = Date.now();

  const fixture = (id, title, sourceThreadId = null, changes = {}) => ({
    ...template,
    id: `thr_bt_${id}`,
    title,
    titleFallback: null,
    sourceThreadId: sourceThreadId === null ? null : `thr_bt_${sourceThreadId}`,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    originKind: sourceThreadId === null ? null : "fork",
    originPluginId: "branch-tree",
    sectionId: null,
    visibility: "visible",
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinSortKey: null,
    status: "idle",
    runtime: { displayStatus: "idle" },
    queuedWork: "none",
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    hasPendingInteraction: false,
    lastReadAt: now,
    latestAttentionAt: now - 1000,
    createdAt: now,
    updatedAt: now,
    ...changes,
  });

  let rows = [
    fixture("root", "A better onboarding", null, { createdAt: now - 6000 }),
    fixture("copy", "Try a warmer tone", "root", { createdAt: now - 5000 }),
    fixture("nested", "Shorten the welcome", "copy", { createdAt: now - 4000 }),
    fixture("deep", "Test the first sentence", "nested", { createdAt: now - 3000 }),
    fixture("sibling", "Explore the layout", "root", { createdAt: now - 2000 }),
    fixture("other", "Check the release notes", null, { updatedAt: now - 2000 }),
    fixture("hidden", "Invisible helper", "root", { visibility: "hidden" }),
    fixture("archived", "Old direction", "root", { archivedAt: now }),
    fixture("orphan", "A surviving branch", "archived"),
    fixture("child", "An independent delegated chat", null, { parentThreadId: "thr_bt_root" }),
    fixture("working", "Running an experiment", null, {
      status: "active",
      runtime: { displayStatus: "active" },
      updatedAt: now - 1000,
    }),
  ];

  const detail = (row) => ({
    ...fullThread,
    ...row,
    queuedMessageCount: 0,
    activeBackgroundAgentCount: 0,
  });

  const bootstrapResponse = () => ({
    ...bootstrap,
    projects: bootstrap.projects.map((entry) => ({
      ...entry,
      threads: entry.id === projectId ? rows : [],
    })),
    personalProject: { ...bootstrap.personalProject, threads: [] },
  });

  await page.route("**/api/v1/sidebar-bootstrap*", (route) =>
    route.fulfill({ json: bootstrapResponse() }),
  );
  await page.route("**/api/v1/threads/thr_bt_**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const id = url.pathname.split("/")[4];
    const row = rows.find((entry) => entry.id === id);
    fixtureRequests.push({ method: request.method(), path: url.pathname });

    if (request.method() !== "GET") fixtureWrites++;

    if (url.pathname.endsWith("/timeline")) return route.fulfill({ json: emptyTimeline });

    if (url.pathname.endsWith("/events"))
      return route.fulfill({ json: { events: [], hasMore: false } });

    if (url.pathname.endsWith("/interactions")) return route.fulfill({ json: [] });

    if (url.pathname.endsWith("/queued-messages")) return route.fulfill({ json: [] });

    if (url.pathname === `/api/v1/threads/${id}` || url.pathname.endsWith("/read")) {
      return route.fulfill({ json: detail(row ?? rows[0]) });
    }

    if (request.method() === "GET") {
      return route
        .fetch({ url: request.url().replace(id, threadId) })
        .then((response) => route.fulfill({ response }));
    }

    return route.abort();
  });
  await page.goto(`${origin}/projects/${projectId}/threads/thr_bt_root`);
  const list = page.locator('[data-branch-tree="list"]');
  const link = (id) => list.locator(`[data-sidebar-thread-id="thr_bt_${id}"]`);
  await link("deep").waitFor();
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".bt-chat-link")).display === "flex",
  );
  const left = async (id) => (await link(id).boundingBox()).x;
  assert.equal(await left("root"), await left("copy"));
  assert.equal(await left("root"), await left("sibling"));
  assert.ok((await left("nested")) > (await left("copy")));
  assert.ok((await left("deep")) > (await left("nested")));

  const ids = await list
    .locator("[data-sidebar-thread-id]")
    .evaluateAll((links) => links.map((entry) => entry.dataset.sidebarThreadId));

  assert.deepEqual(ids.slice(ids.indexOf("thr_bt_root"), ids.indexOf("thr_bt_root") + 5), [
    "thr_bt_root",
    "thr_bt_copy",
    "thr_bt_nested",
    "thr_bt_deep",
    "thr_bt_sibling",
  ]);
  assert.equal(await link("hidden").count(), 0);
  assert.equal(await link("archived").count(), 0);
  assert.equal(await link("orphan").count(), 1);
  assert.equal(await link("child").count(), 1);
  await page.screenshot({ path: "evidence/tree-desktop.png" });
  const treeBox = await list.boundingBox();
  await page.screenshot({
    path: "evidence/sidebar.png",
    clip: { ...treeBox, height: Math.min(treeBox.height, 430) },
  });
  checks.push(
    "First branches align with their source, deeper branches nest, families stay adjacent, and unavailable parents lose no visible chat",
  );

  await list
    .getByRole("button", { name: "Collapse branches of Try a warmer tone", exact: true })
    .click();
  assert.equal(await link("nested").count(), 0);
  assert.equal(await link("sibling").count(), 1);
  await page.reload();
  await link("copy").waitFor();
  assert.equal(await link("nested").count(), 0);
  await page.goto(`${origin}/projects/${projectId}/threads/thr_bt_deep`);
  await link("deep").waitFor();
  assert.equal(await link("deep").getAttribute("aria-current"), "page");
  checks.push(
    "Collapse persists across reload and opening a nested branch reveals the active lineage",
  );

  await page.goto(`${origin}/projects/${projectId}/threads/thr_bt_root`);
  const draft = page.locator('[contenteditable="true"][role="textbox"]').last();
  await draft.waitFor();
  await draft.fill("Keep my unsent thought in the source chat.");
  let forkCalls = 0;
  let forkBody;
  await page.route("**/api/v1/threads/fork", async (route) => {
    forkCalls++;
    forkBody = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const branch = fixture("new", "A better onboarding (fork)", "root", { createdAt: now + 1000 });
    rows.push(branch);
    await route.fulfill({ json: detail(branch) });
  });
  const branchButton = page.getByRole("button", { name: "Branch this chat", exact: true });
  sidebarProvider = "thread-list/thread-list";

  const viewChange = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith("/preferences/ui/sidebar.threadListProvider"),
  );

  await branchButton.click();
  await branchButton.dispatchEvent("click");
  await page.waitForURL("**/threads/thr_bt_new");
  assert.equal((await viewChange).postDataJSON().value, "branch-tree/tree");
  await page.waitForFunction(
    () => document.activeElement?.id === "thread-detail-follow-up-composer",
  );
  assert.equal((await draft.innerText()).trim(), "");
  assert.equal(forkCalls, 1);
  assert.equal(forkBody.sourceThreadId, "thr_bt_root");
  assert.equal(forkBody.visibility, "visible");
  assert.equal(forkBody.originPluginId, "branch-tree");
  assert.ok(forkBody.input === undefined || forkBody.input.length === 0);
  assert.equal(forkBody.environment, undefined);
  assert.equal(forkBody.lifecycleOwnerThreadId, undefined);
  await page.goto(`${origin}/projects/${projectId}/threads/thr_bt_root`);
  await draft.waitFor();
  assert.match(await draft.innerText(), /Keep my unsent thought/);
  checks.push(
    "One click forks through the native API, opens and focuses an empty branch, selects the tree, deduplicates pending clicks, reuses the environment, and preserves the source draft",
  );

  await page.unroute("**/api/v1/threads/fork");
  await page.route("**/api/v1/threads/fork", (route) =>
    route.fulfill({
      status: 400,
      json: {
        code: "fork_source_session_unavailable",
        message: "Cannot fork: source has no active session to clone",
      },
    }),
  );
  await branchButton.click();
  await page.getByText("Send a message in this chat before branching.", { exact: true }).waitFor();
  assert.ok(page.url().endsWith("/threads/thr_bt_root"));
  assert.match(await draft.innerText(), /Keep my unsent thought/);
  checks.push(
    "Provider/session failure stays visible, leaves the source selected, and does not erase its draft",
  );

  const rootRow = list.locator('[data-branch-row="thr_bt_root"]');
  await rootRow
    .getByRole("button", { name: "Chat actions for A better onboarding", exact: true })
    .click();

  for (const name of [
    "Branch chat",
    "Open in split",
    "Rename",
    "Pin",
    "Mark as unread",
    "Archive",
    "Delete",
  ]) {
    await page.getByRole("menuitem", { name, exact: true }).waitFor();
  }

  await page.keyboard.press("Escape");
  await rootRow
    .getByRole("button", { name: "Chat actions for A better onboarding", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = list.getByRole("textbox", { name: "Chat title", exact: true });
  await rename.fill("Cancel this rename");
  await rename.press("Escape");
  assert.equal(await link("root").innerText(), "A better onboarding");
  checks.push(
    "Keyboard-accessible row actions retain native split/pin/read/archive/delete flows and Escape cancels inline renaming",
  );

  rows.push(fixture("cycle_a", "Cycle A", "cycle_b"), fixture("cycle_b", "Cycle B", "cycle_a"));
  await page.reload();
  await link("cycle_a").waitFor();
  assert.equal(await link("cycle_a").count(), 1);
  assert.equal(await link("cycle_b").count(), 1);
  checks.push("Malformed source cycles do not crash the list or duplicate or hide chats");

  rows = [fixture("scale", "Large branch family")];

  for (let i = 0; i < 700; i++)
    rows.push(fixture(`scale_${i}`, `Experiment ${i + 1}`, i === 0 ? "scale" : `scale_${i - 1}`));
  await page.goto(`${origin}/projects/${projectId}/threads/thr_bt_scale_699`);
  await link("scale_699").waitFor();
  assert.ok((await list.locator("[data-sidebar-thread-id]").count()) < 80);
  assert.ok((await link("scale_699").boundingBox()).width > 100);
  assert.equal(await list.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  checks.push(
    "A 700-level lineage renders a bounded row count, reveals the active leaf, and caps indentation without horizontal overflow",
  );

  rows = [
    fixture("root", "A better onboarding"),
    fixture("copy", "Try a warmer tone", "root"),
    fixture("nested", "Shorten the welcome", "copy"),
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/projects/${projectId}/threads/thr_bt_root`);
  await page.locator('[data-sidebar="trigger"]').click();
  await link("nested").waitFor();
  await page.screenshot({ path: "evidence/tree-mobile.png" });
  const mobileRow = list.locator('[data-branch-row="thr_bt_copy"]');
  assert.equal(
    await mobileRow
      .getByRole("button", { name: "Branch from Try a warmer tone", exact: true })
      .isVisible(),
    true,
  );
  assert.equal(await list.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await link("copy").click();
  await page.waitForURL("**/threads/thr_bt_copy");
  await page.waitForFunction(() => {
    const main = document.querySelector('main[data-sidebar="inset"]');

    return (
      main !== null &&
      main.getAttribute("data-sidebar-shelf") === "closed" &&
      Math.abs(main.getBoundingClientRect().left) < 1 &&
      main.getAnimations().length === 0
    );
  });
  await page.screenshot({ path: "evidence/chat-mobile.png" });
  checks.push(
    "Narrow screens keep branch controls visible and opening a chat closes the native sidebar drawer",
  );

  assert.deepEqual(errors, []);
  await writeFile(
    "evidence/e2e.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        browser: "Chrome",
        checks,
        errors,
        fixtureWrites,
        liveMutation: false,
        providerTurns: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Passed ${checks.length} Chrome scenarios; no provider turns or real chat mutations.`,
  );
} catch (error) {
  let errorDetails = [];

  if (await page.getByText("Error details", { exact: true }).isVisible()) {
    await page.getByText("Error details", { exact: true }).click();
    errorDetails = await page.locator("pre").allTextContents();
  }

  await page.screenshot({ path: "evidence/failure.png" });
  await writeFile(
    "evidence/failure.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        errors,
        message: error.message,
        fixtureRequests,
        errorDetails,
        sidebar: await page
          .locator('[data-sidebar="content"]')
          .innerText({ timeout: 1000 })
          .catch(() => "Sidebar is closed or unavailable"),
        rows: await page.locator("[data-sidebar-thread-id]").count(),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
}
