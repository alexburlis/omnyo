import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const [
  url,
  threadId,
  runId,
  outputDir,
  playwrightModule,
  expectedVerdict = "BLOCKED",
  minimumCards = "1",
] = process.argv.slice(2);

assert(["BLOCKED", "CANCELLED"].includes(expectedVerdict));

assert(["0", "1"].includes(minimumCards));

if (
  !url ||
  !threadId ||
  !runId ||
  !isAbsolute(outputDir ?? "") ||
  !isAbsolute(playwrightModule ?? "")
)
  throw new Error(
    "Explicit source thread URL/IDs and absolute output/tool module paths are required.",
  );

const target = new URL(url);

if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !target.pathname.endsWith(`/threads/${threadId}`) ||
  target.username ||
  target.password
)
  throw new Error("Owned source Omnyo thread URL required.");

await mkdir(outputDir, { mode: 0o700 });

const { chromium } = await import(pathToFileURL(playwrightModule).href);

const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

const page = await context.newPage();

page.setDefaultTimeout(4000);

let timeout;

try {
  timeout = setTimeout(() => {
    void browser.close();
  }, 14000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 6000 });
  const selector = `section[aria-label="FastLoop run"][data-run-id="${runId}"]`;

  if (minimumCards === "1") await page.locator(selector).first().waitFor({ state: "visible" });
  const optionalCards = await page.locator(selector).count();
  assert.ok(optionalCards >= Number(minimumCards));
  const show = page.getByRole("button", { name: /^Show right panel/ });
  const toolbar = page.getByRole("toolbar", { name: "Right panel views", exact: true });
  await show.or(toolbar).first().waitFor({ state: "visible" });

  if (await show.isVisible()) await show.click();
  await toolbar.waitFor({ state: "visible" });
  const plus = toolbar.getByRole("button", { name: /^Open new tab(?:$| \()/ });
  assert.equal(await plus.count(), 1);
  await plus.click();
  const action = page.locator("button[data-panel-new-tab-item]").filter({ hasText: /^FastLoop$/ });
  await action.waitFor({ state: "visible" });
  assert.equal(await action.count(), 1);

  const deliveryResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/getDelivery") && response.request().method() === "POST",
  );

  await action.click();

  const canonical = page
    .getByRole("combobox", { name: "Run", exact: true })
    .locator("xpath=ancestor::div[2]");

  await canonical.getByRole("combobox", { name: "Run", exact: true }).selectOption(runId);
  const run = canonical.locator(selector);
  await run.waitFor({ state: "visible" });
  await run
    .getByRole("heading", {
      name: expectedVerdict === "BLOCKED" ? "Blocked" : "Cancelled",
      exact: true,
    })
    .waitFor();
  const deliveryHTTP = await deliveryResponse;
  assert.equal(deliveryHTTP.status(), 200);
  const delivery = await deliveryHTTP.json();
  assert.equal(delivery.ok, true);
  await run.getByRole("heading").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outputDir, "desktop-run.png") });
  const artifact = run.getByRole("button", { name: /(?:^|\/)report\.md$/ });
  assert.equal(await artifact.count(), 1);
  await artifact.click();
  const preview = canonical.getByRole("region", { name: "Evidence preview", exact: true });
  await preview.waitFor({ state: "visible" });
  const text = await preview.locator("pre").innerText();
  assert.ok(text.includes(expectedVerdict));
  assert.equal(await preview.locator("script,iframe,object,embed,img").count(), 0);
  assert.equal(
    await canonical.locator('a[href^="file:"],a[href^="/Users/"],a[href^="/private/"]').count(),
    0,
  );
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outputDir, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.clientWidth === 390);

  if (!(await preview.isVisible())) {
    const showMobile = page.getByRole("button", { name: /^Show right panel/ });

    if (await showMobile.isVisible()) await showMobile.click();
    await canonical.getByRole("combobox", { name: "Run", exact: true }).selectOption(runId);
  }

  await canonical.locator(selector).getByRole("heading").first().scrollIntoViewIfNeeded();
  const mobileControls = [];

  for (const [name, control] of [
    ["Refresh runs", canonical.getByRole("button", { name: "Refresh runs", exact: true })],
    ["Run", canonical.getByRole("combobox", { name: "Run", exact: true })],
  ]) {
    const rect = await control.boundingBox();
    assert(
      rect && rect.width > 0 && rect.x >= 0 && rect.x + rect.width <= 390,
      `${name} exceeds mobile viewport`,
    );
    mobileControls.push({ name, left: rect.x, right: rect.x + rect.width });
  }

  await page.screenshot({ path: join(outputDir, "mobile-run.png") });

  if (!(await preview.isVisible())) {
    const showMobile = page.getByRole("button", { name: /^Show right panel/ });

    if (await showMobile.isVisible()) await showMobile.click();
    await canonical.getByRole("combobox", { name: "Run", exact: true }).selectOption(runId);
    await canonical
      .locator(selector)
      .getByRole("button", { name: /(?:^|\/)report\.md$/ })
      .click();
  }

  await preview.waitFor({ state: "visible" });

  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }));

  assert.equal(dimensions.width, 390);
  assert.ok(dimensions.body <= 390 && dimensions.document <= 390);
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outputDir, "mobile.png") });

  const receipt = {
    surface:
      "actual source Omnyo canonical FastLoop new-tab panel plus optional assistant directive and inert report preview",
    url,
    threadId,
    runId,
    observedVerdict: expectedVerdict,
    deliveryState: delivery.result.state,
    applicationFailPassQualification: false,
    optionalCards,
    canonicalLauncher: "Show right panel -> Open new tab -> FastLoop",
    reportInert: true,
    mobile: dimensions,
    mobileControls,
    providerDispatches: 0,
    sourceMutations: 0,
    browserSandbox: true,
  };

  await writeFile(join(outputDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  clearTimeout(timeout);
  await context.close();
  await browser.close();
}
