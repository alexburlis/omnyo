import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = process.env.OMNYO_TEST_URL ?? "http://127.0.0.1:38886";

const threadId = process.env.OMNYO_THREAD_ID;

const projectId = process.env.OMNYO_PROJECT_ID;

const evidence = process.argv[2] ?? "evidence/workflow-activity";

assert.ok(threadId && projectId && evidence);

await mkdir(evidence, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });

const checks = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const bootstrap = await (await page.request.get(`${origin}/api/v1/sidebar-bootstrap`)).json();

  const template = bootstrap.projects
    .find((project) => project.id === projectId)
    .threads.find((thread) => thread.id === threadId);

  assert.ok(template);
  let pendingInput = false;
  let runs = [{ id: "wfr_fixture_queued", status: "queued" }];
  let fail = false;
  let calls = 0;
  let descendant = false;
  let failChild = false;
  await page.route("**/api/v1/sidebar-bootstrap*", (route) =>
    route.fulfill({
      json: {
        ...bootstrap,
        projects: bootstrap.projects.map((project) => ({
          ...project,
          threads:
            project.id === projectId
              ? [
                  {
                    ...template,
                    status: "idle",
                    runtime: { displayStatus: "idle" },
                    queuedWork: "none",
                    hasPendingInteraction: pendingInput,
                    lastReadAt: Date.now(),
                    latestAttentionAt: Date.now() - 1000,
                    activity: Object.fromEntries(
                      Object.keys(template.activity).map((key) => [key, 0]),
                    ),
                  },
                  ...(descendant
                    ? [
                        {
                          ...template,
                          id: "thr_fixture_workflow_child",
                          title: "Workflow child",
                          parentThreadId: threadId,
                          status: "idle",
                          runtime: { displayStatus: "idle" },
                          queuedWork: "none",
                          hasPendingInteraction: false,
                          lastReadAt: Date.now(),
                          latestAttentionAt: Date.now() - 1000,
                          activity: Object.fromEntries(
                            Object.keys(template.activity).map((key) => [key, 0]),
                          ),
                        },
                      ]
                    : []),
                ]
              : [],
        })),
        personalProject: { ...bootstrap.personalProject, threads: [] },
      },
    }),
  );
  await page.route("**/plugins/tidy/rpc/ready_ids", (route) =>
    route.fulfill({
      json: { ok: true, result: { threadIds: [threadId] } },
    }),
  );
  await page.route("**/plugins/decisions/rpc/open_index", (route) =>
    route.fulfill({
      json: { ok: true, result: { threads: [] } },
    }),
  );
  await page.route("**/plugins/workflows/rpc/workflowActiveRuns", async (route) => {
    calls += 1;
    const id = route.request().postDataJSON().threadId;
    assert.ok(id === threadId || id === "thr_fixture_workflow_child");
    const child = id === "thr_fixture_workflow_child";
    await route.fulfill(
      (child ? failChild : fail)
        ? { status: 503, json: { error: "Controlled unavailable progress" } }
        : {
            json: { ok: true, result: { runs: child ? [] : runs } },
          },
    );
  });
  await page.goto(`${origin}/projects/${projectId}/threads/${threadId}`);
  await page.getByRole("button", { name: "Chat view", exact: true }).click();
  await page.getByRole("button", { name: "Group chats by status", exact: true }).click();

  const expectGroup = async (group) => {
    await page.waitForFunction(
      ({ threadId, group }) =>
        document
          .querySelector(`[data-chat-groups="list"] [data-sidebar-thread-id="${threadId}"]`)
          ?.getAttribute("data-chat-group") === group,
      { threadId, group },
      { timeout: 12000 },
    );
  };

  await expectGroup("working");
  assert.equal(await page.locator(`[data-archive-suggestion="${threadId}"]`).count(), 0);
  checks.push(
    "Queued hidden workflow work keeps an idle Ready parent Working with no archive suggestion",
  );
  await page.screenshot({ path: `${evidence}/queued-parent.png` });
  runs = [
    { id: "wfr_fixture_running", status: "running" },
    { id: "wfr_fixture_second", status: "queued" },
  ];
  const before = calls;
  await page.waitForResponse((response) => response.url().endsWith("/workflowActiveRuns"), {
    timeout: 12000,
  });
  assert.ok(calls > before);
  await expectGroup("working");
  runs = [{ id: "wfr_fixture_second", status: "queued" }];
  await page.waitForResponse((response) => response.url().endsWith("/workflowActiveRuns"), {
    timeout: 12000,
  });
  await expectGroup("working");
  checks.push(
    "One remaining run keeps the parent Working after another run settles, including between worker calls",
  );
  fail = true;
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not check workflow progress" })
    .waitFor({ timeout: 12000 });
  await expectGroup("working");
  checks.push("A failed progress read remains visible and cannot declare active work complete");
  fail = false;
  runs = [];
  await expectGroup("ready");
  checks.push(
    "The parent returns to Ready without reloading only after every workflow is terminal",
  );
  descendant = true;
  failChild = true;
  await page.reload();
  await expectGroup("unfinished");
  await page.getByRole("alert").filter({ hasText: "Could not check workflow progress" }).waitFor();
  assert.equal(await page.locator(`[data-archive-suggestion="${threadId}"]`).count(), 0);
  failChild = false;
  await expectGroup("ready");
  checks.push(
    "Unknown descendant workflow activity blocks the parent's Ready mark until the read succeeds",
  );
  descendant = false;
  pendingInput = true;
  runs = [{ id: "wfr_fixture_running", status: "running" }];
  await page.reload();
  await expectGroup("read-needs-you");
  checks.push("Pending user input still outranks running subagents");
  await writeFile(
    `${evidence}/e2e.json`,
    JSON.stringify(
      {
        passed: true,
        checks,
        calls,
        browser: "Headless Google Chrome",
        surface: "Installed Omnyo sidebar with controlled workflow state",
        mutations: "No agent prompts, real archives, workflow starts or provider writes",
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    `${evidence}/failure.json`,
    JSON.stringify({ checks, error: String(error), at: new Date().toISOString() }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
