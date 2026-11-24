import { createRequire } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

const [
  playwrightModule,
  distPath,
  resultPath,
  threadPath,
  readyText,
  cacheProfile,
] = process.argv.slice(2);

if (!playwrightModule || !distPath || !resultPath || !threadPath || !readyText)
  throw Error(
    "Usage: app.mjs playwright-module dist result-json thread-path ready-text [production]",
  );

const require = createRequire(import.meta.url);

const { chromium } = require(resolve(playwrightModule));

const { WebSocket, WebSocketServer } = createRequire(
  new URL("../package.json", import.meta.url),
)("ws");

const dist = resolve(distPath),
  requests = [],
  connections = new Set(),
  peers = new Set();

const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://local").pathname;

  if (
    path.startsWith("/api/") ||
    path.startsWith("/_omnyo/") ||
    path.startsWith("/preview/")
  ) {
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
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );

    upstream.on("error", () => {
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
        res.writeHead(404);
        res.end();

        return;
      }

      file = join(dist, "index.html");
    }

    const content = await readFile(file);
    requests.push({ path, bytes: content.length, at: performance.now() });
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      ...(cacheProfile === "production" ? { vary: "Origin" } : {}),
      "cache-control": path.startsWith("/assets/")
        ? "public,max-age=31536000,immutable"
        : "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(500);
    res.end();
  }
});

server.on("connection", (s) => {
  connections.add(s);
  s.on("close", () => connections.delete(s));
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

await new Promise((r) => server.listen(0, "127.0.0.1", r));

const origin = "http://127.0.0.1:" + server.address().port;

let browser;

const report = {
  at: new Date().toISOString(),
  dist,
  cacheProfile: cacheProfile ?? "shared",
  kind: "Frozen UI with same live loopback coordinator; static HTTP body bytes, no wire compression",
  errors: [],
  httpFailures: [],
};

try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    chromiumSandbox: true,
  });

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400)
      report.httpFailures.push({
        path: new URL(r.url()).pathname,
        status: r.status(),
      });
  });
  const start = performance.now();
  await page.goto(origin + threadPath, { waitUntil: "commit", timeout: 10000 });
  await page.waitForFunction(
    (text) => document.body?.innerText.includes(text),
    readyText,
    { timeout: 20000 },
  );
  report.chatVisibleMs = performance.now() - start;
  await page.waitForTimeout(3000);
  report.observationMs = performance.now() - start;
  report.staticRequests = requests.length;
  report.staticBodyBytes = requests.reduce((n, r) => n + r.bytes, 0);
  report.assets = requests.filter((r) => r.path.startsWith("/assets/")).length;
  report.requests = requests;
  report.passed = true;
} catch (e) {
  report.error = e.name + ": " + e.message.slice(0, 120);
} finally {
  if (browser) await browser.close();

  for (const p of peers) p.terminate();
  wss.close();

  for (const s of connections) s.destroy();
  await new Promise((r) => server.close(r));
  report.cleaned = true;
  await mkdir(resolve(resultPath, ".."), { recursive: true });
  await writeFile(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, requests: undefined }));

  if (!report.passed || report.errors.length || report.httpFailures.length)
    process.exitCode = 1;
}
