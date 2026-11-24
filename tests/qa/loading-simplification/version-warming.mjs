import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const [playwrightModule, baselineModule, resultPath] = process.argv.slice(2);

if (!resultPath)
  throw Error(
    "Usage: version-warming.mjs playwright-module baseline-web-asset-prefetch.ts result.json",
  );

const require = createRequire(import.meta.url);

const { build } = require("esbuild");

const { chromium } = require(resolve(playwrightModule));

const source = `import{createWebAssetPrefetcher}from ${JSON.stringify(resolve(baselineModule))};const p=createWebAssetPrefetcher({fetchAsset:async path=>{const r=await fetch(path);await r.arrayBuffer()},waitUntilVisible:async()=>{},currentBootAssets:()=>['/assets/boot-AAAAAAAA.js'],saveData:()=>false,store:{read:()=>new Map([['feature.js',1]]),write:()=>{}},now:Date.now,warn:()=>{}});window.warm=()=>p.handleManifest({generation:'B',boot:['/assets/boot-BBBBBBBB.js'],assets:[{path:'/assets/feature-BBBBBBBB.js',bytes:50000}]});`;

const bundle = await build({
  stdin: { contents: source, resolveDir: resolve(baselineModule, "..") },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  minify: true,
  nodePaths: [resolve("apps/app/node_modules")],
});

const script = bundle.outputFiles[0].contents;

const bytes = Buffer.alloc(50000, 65);

let requests = [];

const server = createServer(async (req, res) => {
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end('<script src="/loader.js"></script><h1>Current version A</h1>');

    return;
  }

  if (req.url === "/loader.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(script);

    return;
  }

  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();

    return;
  }

  requests.push({ url: req.url, bytes: bytes.length });
  await new Promise((r) => setTimeout(r, 100));
  res.setHeader("cache-control", "public,max-age=31536000,immutable");
  res.end(bytes);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));

let browser;

const report = {
  sourceHash: createHash("sha256")
    .update(await readFile(baselineModule))
    .digest("hex"),
  at: new Date().toISOString(),
  scenario:
    "Available version B while A remains open; same immutable asset cache headers",
  trials: [],
};

try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    chromiumSandbox: true,
  });

  for (let trial = 0; trial < 5; trial++)
    for (const variant of trial % 2
      ? ["after", "before"]
      : ["before", "after"]) {
      requests = [];
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:" + server.address().port);

      if (variant === "before") await page.evaluate(() => window.warm());

      const prefetch = {
        requests: requests.length,
        bytes: requests.reduce((n, r) => n + r.bytes, 0),
      };

      requests = [];
      const t = performance.now();
      await page.evaluate(async () => {
        await Promise.all(
          ["/assets/boot-BBBBBBBB.js", "/assets/feature-BBBBBBBB.js"].map(
            async (path) => {
              const r = await fetch(path);
              await r.arrayBuffer();
            },
          ),
        );
      });
      report.trials.push({
        trial,
        variant,
        prefetch,
        requestedNextVersionMs: performance.now() - t,
        onDemandRequests: requests.length,
        onDemandBytes: requests.reduce((n, r) => n + r.bytes, 0),
      });
      await context.close();
    }
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
  report.cleaned = true;
  await mkdir(resolve(resultPath, ".."), { recursive: true });
  await writeFile(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
