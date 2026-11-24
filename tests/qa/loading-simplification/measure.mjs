import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { performance } from "node:perf_hooks";

const [
  playwrightModule,
  buildDirectory,
  resultPath,
  scenario = "healthy",
  trial = "0",
] = process.argv.slice(2);

if (!playwrightModule || !buildDirectory || !resultPath)
  throw new Error(
    "Usage: measure.mjs playwright-module build-directory result-json [healthy|slow|transient|permanent|hung] [trial]",
  );

const require = createRequire(import.meta.url);

const { chromium } = require(resolve(playwrightModule));

const build = JSON.parse(
  await readFile(resolve(buildDirectory, "build.json"), "utf8"),
);

const dist = resolve(buildDirectory, "dist");

const requests = [];

let failures = 0;

let recovery = false;

const sockets = new Set();

const mainImports = (await readFile(resolve(dist, "main.js"), "utf8")).matchAll(
  /from[ ]*["']\.\/([^"']+)["']/g,
);

const bootDependencies = new Set(
  [...mainImports].map((match) => "/" + match[1]),
);

const dependency = build.splits["feature-0"]
  .map((i) => build.paths[i])
  .find((path) => path.includes("chunk-") && !bootDependencies.has(path));

const featureRoot = build.paths[build.splits["feature-0"][0]];

const featurePaths = build.paths.filter((path) => path.startsWith("/feature"));

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const row = { path, start: performance.now(), bytes: 0, status: 200 };
  requests.push(row);

  if (path === "/favicon.ico") {
    row.status = 204;
    res.writeHead(204);
    res.end();

    return;
  }

  const target =
    path === (scenario.endsWith("-dependency") ? dependency : featureRoot);

  const failureScenario = scenario.replace("-dependency", "");

  if (
    target &&
    !recovery &&
    (failureScenario === "permanent" ||
      (failureScenario === "transient" && failures++ < 2))
  ) {
    row.status = 503;
    res.writeHead(503, { "cache-control": "no-store" });
    res.end();

    return;
  }

  if (target && !recovery && failureScenario === "hung") {
    res.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    res.flushHeaders();

    return;
  }

  if (path.endsWith(".js") && scenario === "slow")
    await new Promise((r) => setTimeout(r, 100));

  try {
    const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));

    if (!file.startsWith(dist + "/")) throw Error("outside dist");
    const bytes = await readFile(file);
    row.bytes = bytes.length;
    res.writeHead(200, {
      "content-type": extname(path) === ".js" ? "text/javascript" : "text/html",
      "cache-control": path.endsWith(".js")
        ? "public,max-age=31536000,immutable"
        : "no-store",
    });
    res.end(bytes);
  } catch {
    row.status = 404;
    res.writeHead(404);
    res.end();
  }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));

const origin = "http://127.0.0.1:" + server.address().port;

let browser;

const result = {
  scenario,
  trial: Number(trial),
  at: new Date().toISOString(),
  build,
  units: "HTTP response body bytes; milliseconds",
  idleWindowMs: 750,
  pageErrors: [],
  cleanup: false,
};

try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    chromiumSandbox: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => result.pageErrors.push(e.message));
  const start = performance.now();
  await page.goto(origin, { waitUntil: "commit", timeout: 5000 });
  await page
    .getByRole("heading", { name: "Ready chat" })
    .waitFor({ timeout: 5000 });
  result.chatReadyMs = performance.now() - start;
  await page.getByRole("textbox").fill("keep my draft");
  await page.waitForTimeout(result.idleWindowMs);
  result.beforeIntent = {
    requests: requests.length,
    bytes: requests.reduce((n, r) => n + r.bytes, 0),
    optionalRequests: requests.filter((r) => featurePaths.includes(r.path))
      .length,
  };
  const opened = performance.now();
  await page.getByRole("button", { name: "Open 0", exact: true }).click();

  if (scenario === "permanent" || scenario === "hung") {
    try {
      await page
        .getByRole("alert")
        .waitFor({ timeout: scenario === "hung" ? 33500 : 5000 });
      result.failureVisibleMs = performance.now() - opened;
      result.retryButton = await page
        .getByRole("button", { name: "Try again", exact: true })
        .count();
      result.shellSurvived = await page
        .getByRole("heading", { name: "Ready chat" })
        .isVisible();
      result.draftBeforeRecovery = await page.getByRole("textbox").inputValue();
      recovery = true;
      const retried = performance.now();
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await page.locator('[data-feature="0"]').waitFor({ timeout: 5000 });
      result.recoveredMs = performance.now() - retried;
    } catch (e) {
      result.failureObservation = "bounded wait expired";
      result.failureError = e.name;
    }
  } else {
    await page.locator('[data-feature="0"]').waitFor({ timeout: 8000 });
    result.featureReadyMs = performance.now() - opened;
  }

  result.draft = await page.getByRole("textbox").inputValue();
  result.requests = requests;
  result.totalBytes = requests.reduce((n, r) => n + r.bytes, 0);
  result.failedResponses = requests.filter((r) => r.status >= 400).length;
} catch (e) {
  result.error = e.name + ": " + e.message.slice(0, 150);
} finally {
  if (browser) await browser.close();

  for (const socket of sockets) socket.destroy();
  await new Promise((r) => server.close(r));
  result.cleanup = true;
  await mkdir(resolve(resultPath, ".."), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({ ...result, build: undefined, requests: undefined }),
  );

  if (result.error || result.pageErrors.length) process.exitCode = 1;
}
