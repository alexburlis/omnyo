import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApp } from "../../../apps/server/src/server.ts";
import { createTestAppHarness } from "../../../apps/server/test/helpers/test-app.ts";

const [playwrightPath, output] = process.argv.slice(2);

assert.ok(
  playwrightPath && output,
  "Pass the existing Playwright module and result path",
);

const { chromium } = createRequire(import.meta.url)(resolve(playwrightPath));

const root = await mkdtemp(join(resolve(output, ".."), "static-proof-"));

await mkdir(join(root, "assets"));

await writeFile(
  join(root, "index.html"),
  '<h1>Asset cache proof</h1><link rel="icon" href="data:,">',
);

await writeFile(join(root, "assets", "feature.js"), "export const value = 42;");

const harness = await createTestAppHarness();

const app = createApp(harness.deps, { staticDir: root });

const requests: string[] = [];

const server = createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${address.port}`;
  const path = request.url ?? "/";

  if (path.startsWith("/assets/")) requests.push(path);

  const result = await app.app.fetch(
    new Request(new URL(path, origin), {
      headers: new Headers(
        Object.entries(request.headers).flatMap(([name, value]) =>
          typeof value === "string" ? [[name, value]] : [],
        ),
      ),
    }),
  );

  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
});

server.listen(0, "127.0.0.1");

await once(server, "listening");

const address = server.address();

assert.ok(address && typeof address !== "string");

let browser;

const rows = [];

try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    chromiumSandbox: true,
  });

  for (let trial = 0; trial < 5; trial++) {
    requests.length = 0;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);

    const value = await page.evaluate(async () => {
      const result = await fetch("/assets/feature.js", {
        cache: "force-cache",
      });

      await result.arrayBuffer();

      return (await import(/* @vite-ignore */ "/assets/feature.js")).value;
    });

    assert.equal(value, 42);
    assert.equal(requests.length, 1);
    rows.push({ trial, requests: requests.length, value });
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await app.closeWebSockets();
  await harness.cleanup();
  await rm(root, { recursive: true });
}

await writeFile(
  output,
  JSON.stringify(
    {
      status: "passed",
      surface: "Real createApp static routes and Chrome",
      rows,
      cleaned: true,
    },
    null,
    2,
  ),
);

console.log(JSON.stringify({ status: "passed", rows, cleaned: true }));
