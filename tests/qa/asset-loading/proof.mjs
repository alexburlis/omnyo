import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const [playwrightModule, evidenceDirectory] = process.argv.slice(2);

assert.ok(
  playwrightModule && evidenceDirectory,
  "Usage: proof.mjs <existing-playwright-module> <new-evidence-directory>",
);

const repository = fileURLToPath(new URL("../../../", import.meta.url));

const evidence = resolve(evidenceDirectory);

await mkdir(dirname(evidence), { recursive: true });

await mkdir(evidence);

const scratch = await mkdtemp(join(tmpdir(), "omnyo-asset-loading-"));

const staticDir = join(scratch, "current");

const dataDir = join(scratch, "data");

const browserHome = join(scratch, "browser-home");

const browserProfile = join(scratch, "chrome-profile");

const inputs = [
  "apps/server/src/server.ts",
  "apps/server/src/services/system/static-app-assets.ts",
  "apps/app/src/lib/define-split.tsx",
  "apps/app/src/lib/split-load.ts",
  "tests/qa/asset-loading/proof.mjs",
  "tests/qa/asset-loading/FAILURE-MODES.md",
];

const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  surface:
    "Production static routes, retained asset helper and defineSplit in real Chrome",
  sourceHashes: {},
  activations: [],
  responses: [],
  checks: [],
  blockedRequests: [],
  screenshots: [],
  cleanup: null,
};

let context;

let listener;

let stage = "initialize isolated inputs";

let failure;

async function hashes() {
  return Object.fromEntries(
    await Promise.all(
      inputs.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(repository, path)))
          .digest("hex"),
      ]),
    ),
  );
}

async function generate(version) {
  const source = join(scratch, "source", version);

  await mkdir(source, { recursive: true });
  await rm(staticDir, { recursive: true, force: true });

  const kinds = ["after-b", "after-c", "expired"];

  for (const kind of kinds) {
    await writeFile(
      join(source, `${kind}.tsx`),
      `export default function View(){return <p data-testid="${kind}">${version} ${kind} loaded</p>}`,
    );
  }

  await writeFile(
    join(source, "main.tsx"),
    `import {useState} from "react";
import {createRoot} from "react-dom/client";
import {defineSplit} from ${JSON.stringify(join(repository, "apps/app/src/lib/define-split.tsx"))};
${kinds.map((kind, index) => `const Split${index}=defineSplit({id:"proof-${kind}",loading:()=> <p>Loading view</p>,load:()=>import("./${kind}.tsx").then(module=>module.default)});`).join("\n")}
function App(){const [opened,setOpened]=useState([]);return <main><h1>Omnyo asset loading proof ${version}</h1><label>Draft<textarea aria-label="Draft" defaultValue={localStorage.getItem("omnyo-asset-proof-draft")??""} onChange={event=>localStorage.setItem("omnyo-asset-proof-draft",event.target.value)}/></label>${kinds.map((kind, index) => `<button onClick={()=>setOpened(previous=>[...previous,${index}])}>Open ${kind}</button>{opened.includes(${index})&&<Split${index}/>} `).join("")}</main>}
createRoot(document.getElementById("app")).render(<App/>);`,
  );

  const bundled = await build({
    entryPoints: [join(source, "main.tsx")],
    outdir: join(staticDir, "assets"),
    entryNames: "shell-[hash]",
    chunkNames: "[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    nodePaths: [join(repository, "apps/app/node_modules")],
    metafile: true,
    logLevel: "silent",
  });

  const entries = Object.entries(bundled.metafile.outputs);

  const moduleUrl = (name) => {
    const output = entries.find(
      ([, detail]) =>
        detail.entryPoint && basename(detail.entryPoint) === `${name}.tsx`,
    );

    assert.ok(output, `Missing bundled entry ${name}`);

    return `/${relative(staticDir, resolve(output[0])).split("\\").join("/")}`;
  };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Omnyo asset proof ${version}</title><style>body{font:18px system-ui;max-width:820px;margin:60px auto;padding:24px;background:#f5f7fb;color:#182238}button,textarea{font:inherit;margin:12px;padding:12px}textarea{display:block;width:90%;height:100px}main{background:white;padding:24px;border-radius:16px}button{cursor:pointer}p[role=alert]{padding:18px;background:#fff0f0}</style></head><body data-generation="${version}"><div id="app"></div><script type="module" src="${moduleUrl("main")}"></script></body></html>`;

  await writeFile(join(staticDir, "index.html"), html);

  return Object.fromEntries(kinds.map((kind) => [kind, moduleUrl(kind)]));
}

try {
  await mkdir(browserHome);
  await mkdir(dataDir);

  const isolatedEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: browserHome,
    TMPDIR: scratch,
    LANG: "C.UTF-8",
    NODE_ENV: "test",
    OMNYO_DATA_DIR: dataDir,
  };

  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, isolatedEnv);
  report.sourceHashes = await hashes();

  const serverRequire = createRequire(
    join(repository, "apps/server/package.json"),
  );

  const { Hono } = serverRequire("hono");
  const { serve } = serverRequire("@hono/node-server");

  const { registerStaticAppRoutes } = await import(
    pathToFileURL(join(repository, "apps/server/src/server.ts")).href
  );

  const { prepareStaticAppAssets } = await import(
    pathToFileURL(
      join(repository, "apps/server/src/services/system/static-app-assets.ts"),
    ).href
  );

  const { chromium } = serverRequire(resolve(playwrightModule));
  let activeApp = new Hono();

  listener = serve({
    fetch: (request) => activeApp.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  });

  if (!listener.listening) await once(listener, "listening");

  const origin = `http://127.0.0.1:${listener.address().port}`;

  const activate = async (version) => {
    const modules = await generate(version);
    const roots = await prepareStaticAppAssets({ staticDir, dataDir });

    activeApp = new Hono();
    registerStaticAppRoutes(activeApp, staticDir, roots);

    const response = await fetch(origin);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.ok((await response.text()).includes(`data-generation="${version}"`));
    report.activations.push({
      version,
      roots: roots.map((root) => basename(root)),
      modules,
    });

    return { modules, roots };
  };

  stage = "open A and preserve a synthetic draft";
  const original = await activate("A");

  context = await chromium.launchPersistentContext(browserProfile, {
    channel: "chrome",
    headless: true,
    env: isolatedEnv,
    viewport: { width: 1100, height: 800 },
  });
  report.browser = { channel: "chrome", version: context.browser().version() };
  context.setDefaultTimeout(10_000);
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin)
      await route.continue();
    else {
      report.blockedRequests.push(route.request().url());
      await route.abort();
    }
  });

  const page = await context.newPage();

  page.on("response", (response) => {
    if (response.url().startsWith(`${origin}/assets/`))
      report.responses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  await page.goto(origin);
  await page
    .getByRole("heading", { name: "Omnyo asset loading proof A" })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Draft" })
    .fill("Synthetic draft survives the server update.");

  for (const [version, kind] of [
    ["B", "after-b"],
    ["C", "after-c"],
  ]) {
    stage = `import A module after activating ${version}`;
    await activate(version);
    assert.equal(
      report.responses.filter(
        (response) => response.path === original.modules[kind],
      ).length,
      0,
    );

    const response = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === original.modules[kind],
    );

    await page
      .getByRole("button", { name: `Open ${kind}`, exact: true })
      .click();
    assert.equal((await response).status(), 200);
    await page.getByTestId(kind).waitFor();
    assert.equal(
      await page.getByTestId(kind).textContent(),
      `A ${kind} loaded`,
    );
    report.checks.push(`A lazy module rendered after ${version}`);
  }

  stage = "expire A and expose production reload recovery";
  const current = await activate("D");

  assert.equal(current.roots.length, 3);
  assert.equal(
    report.responses.filter(
      (response) => response.path === original.modules.expired,
    ).length,
    0,
  );

  const missing = page.waitForResponse(
    (response) => new URL(response.url()).pathname === original.modules.expired,
  );

  await page.getByRole("button", { name: "Open expired", exact: true }).click();
  assert.equal((await missing).status(), 404);
  await page
    .getByRole("button", { name: "Reload Omnyo", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Omnyo asset loading proof A" })
      .count(),
    1,
  );
  await page.screenshot({ path: join(evidence, "expired-reload.png") });
  report.screenshots.push("expired-reload.png");

  stage = "reload into D without losing the draft";
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "Reload Omnyo", exact: true }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Omnyo asset loading proof D" })
    .waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Draft" }).inputValue(),
    "Synthetic draft survives the server update.",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("omnyo-asset-proof-draft")),
    "Synthetic draft survives the server update.",
  );
  await page.screenshot({ path: join(evidence, "recovered-d.png") });
  report.screenshots.push("recovered-d.png");
  report.checks.push(
    "Expired A module returned 404 and offered Reload Omnyo",
    "User reload rendered D and preserved the local draft",
    "Three complete generation roots retained",
  );
  assert.deepEqual(report.blockedRequests, []);
  assert.deepEqual(
    await hashes(),
    report.sourceHashes,
    "Source changed during the browser proof",
  );
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.failure = {
    stage,
    message: error instanceof Error ? error.message : String(error),
  };
} finally {
  const cleanupErrors = [];

  for (const [name, close] of [
    ["browser", async () => context?.close()],
    [
      "listener",
      async () => {
        if (!listener) return;
        listener.closeAllConnections();
        await new Promise((done, reject) =>
          listener.close((error) => (error ? reject(error) : done())),
        );
      },
    ],
    ["scratch", async () => rm(scratch, { recursive: true, force: true })],
  ]) {
    try {
      await close();
    } catch {
      cleanupErrors.push(name);
    }
  }

  const scratchAbsent = await access(scratch).then(
    () => false,
    (error) => error.code === "ENOENT",
  );

  report.cleanup = {
    removedScratch: scratch,
    scratchAbsent,
    listenerClosed: !listener?.listening,
    browserClosed: !context?.browser()?.isConnected(),
    errors: cleanupErrors,
  };

  if (!scratchAbsent || cleanupErrors.length > 0) {
    report.status = "failed";
    failure ??= new Error("Owned proof cleanup did not complete");
  }

  report.completedAt = new Date().toISOString();
  await writeFile(
    join(evidence, "receipt.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

if (failure) throw failure;

process.stdout.write(
  `Asset loading browser proof passed: ${join(evidence, "receipt.json")}\n`,
);
