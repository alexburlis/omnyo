import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, join, dirname } from "node:path";
import { performance } from "node:perf_hooks";

const [playwrightModule, distPath, resultPath, profile, scenarioPath] =
  process.argv.slice(2);

if (!scenarioPath || !["before", "after"].includes(profile))
  throw Error(
    "Usage: measure.mjs playwright-module dist result.json before|after scenario.json",
  );

const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));

for (const field of [
  "threadPath",
  "threadId",
  "readyText",
  "switchPath",
  "switchThreadId",
])
  assert.equal(typeof scenario[field], "string");

const require = createRequire(import.meta.url);

const { chromium } = require(resolve(playwrightModule));

const { WebSocket, WebSocketServer } = createRequire(
  new URL("../package.json", import.meta.url),
)("ws");

const dist = resolve(distPath);

const { threadPath, threadId, readyText, switchPath, switchThreadId } =
  scenario;

const requests = [];

const sockets = new Set();

const peers = new Set();

const upstreamRequests = new Set();

const types = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const report = {
  at: new Date().toISOString(),
  profile,
  source: {
    indexSha256: createHash("sha256")
      .update(await readFile(join(dist, "index.html")))
      .digest("hex"),
  },
  limits:
    "Frozen production UI, loopback static server and same live backend. No provider sends. Encoded body bytes exclude HTTP/TLS headers. Optional plugin backend failures are reported separately from core navigation.",
  browserErrors: [],
  httpFailures: [],
  blockedMutations: [],
  teardownFailures: [],
  requests,
  cleaned: false,
};

let tearingDown = false;

const server = createServer(async (req, res) => {
  if (tearingDown) {
    res.writeHead(503);
    res.end();

    return;
  }

  const path = new URL(req.url, "http://local").pathname;

  const record = {
    path,
    method: req.method,
    startedAt: performance.now(),
    status: null,
    encodedBodyBytes: 0,
    decodedBodyBytes: 0,
    kind: "static",
    phase: "active",
  };

  requests.push(record);

  if (
    path.startsWith("/api/") ||
    path.startsWith("/_omnyo/") ||
    path.startsWith("/preview/")
  ) {
    record.kind = "api";

    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      !path.startsWith("/api/v1/plugins/") &&
      path !== "/api/v1/files/list" &&
      path !== "/api/v1/threads/plugin-metadata"
    ) {
      report.blockedMutations.push({ method: req.method, path });
      record.status = 409;
      res.writeHead(409, { "content-type": "application/json" });
      res.end('{"error":"read-only benchmark"}');

      return;
    }

    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 38886,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: "127.0.0.1:38886",
          origin: "http://127.0.0.1:38886",
        },
      },
      (upstreamResponse) => {
        record.status = upstreamResponse.statusCode;
        record.headersMs = performance.now() - record.startedAt;
        res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.on("data", (chunk) => {
          record.encodedBodyBytes += chunk.length;
        });
        upstreamResponse.on("end", () => {
          record.totalMs = performance.now() - record.startedAt;
        });
        upstreamResponse.pipe(res);
      },
    );

    upstreamRequests.add(upstream);
    upstream.on("close", () => upstreamRequests.delete(upstream));
    upstream.on("error", (error) => {
      record.error = error.code ?? error.name;
      record.status = 502;
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);

    return;
  }

  try {
    let file = resolve(dist, "." + path);

    if (!file.startsWith(dist + "/")) file = join(dist, "index.html");

    try {
      if (!(await stat(file)).isFile()) file = join(dist, "index.html");
    } catch {
      if (path.startsWith("/assets/")) {
        record.status = 404;
        res.writeHead(404);
        res.end();

        return;
      }

      file = join(dist, "index.html");
    }

    const original = await readFile(file);
    let content = original;
    let encoding;
    const accepted = String(req.headers["accept-encoding"] ?? "");

    for (const [name, suffix] of [
      ["br", ".br"],
      ["gzip", ".gz"],
    ]) {
      if (!accepted.includes(name)) continue;

      try {
        content = await readFile(file + suffix);
        encoding = name;
        break;
      } catch {}
    }

    const isAsset = path.startsWith("/assets/");

    const vary = [
      encoding ? "Accept-Encoding" : null,
      profile === "before" ? "Origin" : null,
    ]
      .filter(Boolean)
      .join(", ");

    record.status = 200;
    record.decodedBodyBytes = original.length;
    record.encodedBodyBytes = content.length;
    record.encoding = encoding ?? null;
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "content-length": content.length,
      "cache-control": isAsset
        ? "public,max-age=31536000,immutable"
        : "no-cache",
      ...(vary ? { vary } : {}),
      ...(profile === "after" && isAsset
        ? { "access-control-allow-origin": "*" }
        : req.headers.origin
          ? { "access-control-allow-origin": req.headers.origin }
          : {}),
      ...(encoding ? { "content-encoding": encoding } : {}),
    });
    res.end(content);
    record.totalMs = performance.now() - record.startedAt;
  } catch (error) {
    record.status = 500;
    record.error = error.code ?? error.name;
    res.writeHead(500);
    res.end();
  }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const upstream = new WebSocket("ws://127.0.0.1:38886" + req.url, {
    origin: "http://127.0.0.1:38886",
  });

  peers.add(upstream);
  upstream.on("error", () => socket.destroy());
  upstream.on("open", () =>
    wss.handleUpgrade(req, socket, head, (client) => {
      peers.add(client);
      client.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data, { binary });
      });
      upstream.on("message", (data, binary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      client.on("close", () => upstream.close());
      upstream.on("close", () => client.close());
    }),
  );
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const origin = "http://127.0.0.1:" + server.address().port;

let browser;

try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    chromiumSandbox: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });

  await context.addInitScript(() => {
    window.__latencyWebSockets = [];
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args);

        const entry = {
          path: new URL(args[0], location.href).pathname,
          startedAt: performance.now(),
        };

        window.__latencyWebSockets.push(entry);
        this.addEventListener("open", () => {
          entry.openedAt = performance.now();
        });
        this.addEventListener("error", () => {
          entry.error = true;
        });
      }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => report.browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && response.status() !== 409)
      (tearingDown ? report.teardownFailures : report.httpFailures).push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  const start = performance.now();
  process.stderr.write("latency stage: open chat\n");
  await page.goto(origin + threadPath, { waitUntil: "commit", timeout: 10000 });
  await page.waitForFunction(
    ({ id, text }) => {
      const root = document.querySelector(`[data-thread-initial-load="${id}"]`);

      return (
        root &&
        root.getAttribute("aria-busy") === "false" &&
        document.body.innerText.includes(text)
      );
    },
    { id: threadId, text: readyText },
    { timeout: 20000 },
  );
  process.stderr.write("latency stage: chat visible\n");
  report.chatVisibleMs = performance.now() - start;
  await page.waitForFunction(
    () => window.__latencyWebSockets.some((socket) => socket.openedAt),
    {},
    { timeout: 5000 },
  );
  report.webSockets = await page.evaluate(() => window.__latencyWebSockets);
  report.webSocketOpenMs = Math.min(
    ...report.webSockets
      .filter((socket) => socket.openedAt)
      .map((socket) => socket.openedAt),
  );
  await page.waitForTimeout(500);

  report.coldRequests = requests.length;
  report.coldStaticEncodedBodyBytes = requests
    .filter((request) => request.kind === "static")
    .reduce((sum, request) => sum + request.encodedBodyBytes, 0);
  report.coldStaticDecodedBodyBytes = requests
    .filter((request) => request.kind === "static")
    .reduce((sum, request) => sum + request.decodedBodyBytes, 0);
  process.stderr.write("latency stage: switch chat\n");
  const switchStart = performance.now();
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, switchPath);
  await page.waitForFunction(
    (id) => {
      const root = document.querySelector(`[data-thread-initial-load="${id}"]`);

      return root && root.getAttribute("aria-busy") === "false";
    },
    switchThreadId,
    { timeout: 10000 },
  );
  report.chatSwitchMs = performance.now() - switchStart;
  process.stderr.write("latency stage: return chat\n");
  const returnStart = performance.now();
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, threadPath);
  await page.waitForFunction(
    (id) => {
      const root = document.querySelector(`[data-thread-initial-load="${id}"]`);

      return root && root.getAttribute("aria-busy") === "false";
    },
    threadId,
    { timeout: 10000 },
  );
  report.chatReturnMs = performance.now() - returnStart;

  process.stderr.write("latency stage: settings\n");

  const settingsButton = page.getByRole("button", {
    name: "Settings and more",
    exact: true,
  });

  await settingsButton.click();

  const settings = page.getByRole("menuitem", { name: /^Settings/ }).first();
  const at = performance.now();
  await settings.click();
  await page
    .getByRole("switch", { name: "Show Git status", exact: true })
    .waitFor({ timeout: 10000 });
  report.settingsVisibleMs = performance.now() - at;
  report.coreFailures = report.httpFailures.filter(
    (failure) => !failure.path.startsWith("/api/v1/plugins/"),
  );
  report.passed =
    report.browserErrors.length === 0 &&
    report.coreFailures.length === 0 &&
    report.blockedMutations.length === 0;
} catch (error) {
  report.failure = error.name + ": " + error.message.slice(0, 200);
  report.passed = false;
} finally {
  process.stderr.write("latency stage: cleanup\n");
  tearingDown = true;
  const closed = new Promise((resolve) => server.close(resolve));

  for (const request of requests)
    if (request.totalMs === undefined) request.phase = "teardown";

  for (const peer of peers) peer.terminate();
  wss.close();

  for (const socket of sockets) socket.destroy();

  if (browser) await browser.close();
  process.stderr.write("latency stage: browser closed\n");

  for (const upstream of upstreamRequests) upstream.destroy();

  for (const socket of sockets) socket.destroy();
  await closed;
  process.stderr.write("latency stage: server closed\n");
  report.cleaned = true;
  report.staticRequests = requests.filter(
    (request) => request.kind === "static",
  ).length;
  report.staticUniqueAssets = new Set(
    requests
      .filter((request) => request.path.startsWith("/assets/"))
      .map((request) => request.path),
  ).size;
  report.staticEncodedBodyBytes = requests
    .filter((request) => request.kind === "static")
    .reduce((sum, request) => sum + request.encodedBodyBytes, 0);
  report.staticDecodedBodyBytes = requests
    .filter((request) => request.kind === "static")
    .reduce((sum, request) => sum + request.decodedBodyBytes, 0);
  await mkdir(dirname(resolve(resultPath)), { recursive: true });
  await writeFile(resultPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      ...report,
      requests: undefined,
      blockedMutations: undefined,
    }),
  );

  if (!report.passed) process.exitCode = 1;
}
