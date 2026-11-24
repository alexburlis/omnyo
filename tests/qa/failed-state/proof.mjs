import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const [playwrightPath, destination] = process.argv.slice(2);

assert(
  playwrightPath && destination,
  "Usage: proof.mjs PLAYWRIGHT_MODULE OUTPUT",
);

const output = resolve(destination);

await mkdir(output, { recursive: true });

const app = resolve(root, "apps/app");

const sources = [
  "src/components/thread/ThreadInboxReason.tsx",
  "src/views/home-orientation/HomeOrientation.tsx",
  "src/views/home-orientation/home-orientation.ts",
  "src/views/home-orientation/useHomeOrientation.ts",
  "src/hooks/queries/use-inbox-snapshot.ts",
  "src/hooks/cache-owners/inbox-snapshot-cache-owner.ts",
  "src/components/ui/theme.css",
  "src/app.css",
];

const texts = await Promise.all(
  sources.map((path) => readFile(join(app, path), "utf8")),
);

const hashes = Object.fromEntries(
  sources.map((path, index) => [
    path,
    createHash("sha256").update(texts[index]).digest("hex"),
  ]),
);

const base = {
  projectId: "fixture-project",
  automationId: null,
  shelved: false,
  view: "inbox",
  card: null,
  waiting: null,
  running: null,
  runs: null,
  incident: null,
  sortAt: 1,
  latch: "fixture",
  recap: null,
  archiveReady: false,
  optionalQuestion: null,
  pendingResults: 0,
};

const card = {
  kind: "problem",
  causes: [],
  primary: { kind: "resume", targetThreadId: "failed", targetTitle: null },
  actions: [],
  questionIds: [],
  questionMode: null,
  questionFrom: null,
  snoozedQuestionUntil: null,
  stillOnYou: null,
  notAssessed: null,
  failure: null,
  since: 1,
};

const snapshot = {
  revision: "fixture",
  generatedAt: 1,
  inbox: [
    {
      ...base,
      threadId: "failed",
      title: "Untangle mac",
      state: "failed",
      reason: {
        kind: "failure",
        text: "Failed: Usage limit reached",
        threadId: "failed",
      },
      card,
    },
    {
      ...base,
      threadId: "question",
      title: "Choose a branch",
      state: "needs-you",
      reason: { kind: "ask", text: "Which branch?", threadId: "question" },
      card: {
        ...card,
        kind: "question",
        primary: { kind: "answer" },
        questionMode: "required",
        questionIds: ["q1"],
      },
    },
  ],
  waiting: [],
  running: [],
  shelf: [],
  counts: {
    inbox: 2,
    needsYou: 1,
    questions: 1,
    running: 0,
    waiting: 0,
    onYou: [],
    nextBackAt: null,
  },
  lastMove: null,
};

const adapters = {
  "@/lib/sdk": `export const sdk={experimental_inbox:{snapshot:async()=>(${JSON.stringify(snapshot)})},threads:{experimental_listAncestors:async()=>({threads:[]})}}`,
  "@/components/sidebar/project-rail-catalog": `export const useProjectRailCatalog=()=>({entries:[{project:{id:'fixture-project',name:'Fixture'}}]})`,
  "@/components/sidebar/sidebarScope": `export const INBOX_SIDEBAR_SCOPE={kind:'inbox'};export const useSetSidebarScope=()=>()=>{}`,
  "@/components/ui/sidebar": `export const useSidebar=()=>({setOpen:()=>{}})`,
  "@/views/thread-detail/useOpenThreadInLayout": `export const useOpenThreadInLayout=()=>value=>{window.proof.opened=value}`,
};

const bundled = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {HomeStatusCards} from './src/views/home-orientation/HomeOrientation';import {ThreadInboxReason} from './src/components/thread/ThreadInboxReason';window.proof={opened:null};createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><HomeStatusCards/><ThreadInboxReason threadId="failed" parentThreadId={null}/><ThreadInboxReason threadId="question" parentThreadId={null}/></QueryClientProvider>);`,
    loader: "tsx",
    resolveDir: app,
  },
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  conditions: ["source"],
  tsconfig: join(app, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "synthetic-external-adapters",
      setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) =>
          adapters[args.path]
            ? { path: args.path, namespace: "fixture" }
            : null,
        );
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: adapters[args.path],
          loader: "js",
        }));
      },
    },
  ],
});

const tailwindDirectory = (
  await readdir(join(root, "node_modules/.pnpm"))
).find((name) => name.startsWith("@tailwindcss+node@4."));

assert(tailwindDirectory, "Use the repository's installed Tailwind compiler");

const { compile } = await import(
  pathToFileURL(
    join(
      root,
      "node_modules/.pnpm",
      tailwindDirectory,
      "node_modules/@tailwindcss/node/dist/index.mjs",
    ),
  ).href
);

const themeIndex = sources.indexOf("src/components/ui/theme.css");

const appStyles = texts
  .at(-1)
  .replace('@import "@/components/ui/theme.css";', texts[themeIndex]);

const compiled = await compile(appStyles, {
  base: dirname(join(app, sources[themeIndex])),
  onDependency() {},
});

const candidates = [
  ...new Set(
    texts
      .join(" ")
      .split(/[\s"'`{}(),;]+/)
      .filter(Boolean),
  ),
];

const css = compiled.build(candidates);

await writeFile(join(output, "app.js"), bundled.outputFiles[0].contents);

await writeFile(join(output, "app.css"), css);

const report = {
  status: "running",
  surface:
    "Real production React Home and thread reason with synthetic SDK data in headless Chrome",
  hashes,
  checks: [],
  errors: [],
  cleanup: null,
};

const server = createServer(async (request, response) => {
  if (request.url === "/app.js" || request.url === "/app.css") {
    response.setHeader(
      "Content-Type",
      request.url.endsWith(".js") ? "text/javascript" : "text/css",
    );
    response.end(await readFile(join(output, request.url.slice(1))));
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{margin:0;padding:16px;background:var(--background);color:var(--foreground)}#root{max-width:640px;margin:auto}</style></head><body><main id="root"></main><script src="/app.js"></script></body></html>',
    );
  }
});

let browser;

try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  const { chromium } = await import(
    pathToFileURL(resolve(playwrightPath)).href
  );

  browser = await chromium.launch({ channel: "chrome", headless: true });
  report.browser = browser.version();
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => report.errors.push(error.message));

  for (const width of [1000, 390]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.evaluate(
        (value) =>
          document.documentElement.classList.toggle("dark", value === "dark"),
        theme,
      );
      await page
        .getByRole("heading", { name: "Failed · 1", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("heading", { name: "Needs you · 1", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("status")
          .filter({ hasText: "Failed: Usage limit reached" })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByText("Needs you: Which branch?", { exact: true })
          .count(),
        1,
      );
      assert(
        !(await page.locator("body").innerText()).includes("Failed: Failed:"),
      );

      const colors = await page
        .getByRole("heading", { name: "Failed · 1", exact: true })
        .evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--destructive-text)";
          document.body.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();

          return {
            actual: getComputedStyle(element).color,
            expected,
            width: document.documentElement.scrollWidth,
            viewport: innerWidth,
          };
        });

      assert.equal(colors.actual, colors.expected);
      assert.equal(
        await page
          .getByRole("status")
          .filter({ hasText: "Failed: Usage limit reached" })
          .locator("p")
          .evaluate((element) => getComputedStyle(element).color),
        colors.expected,
      );

      const questionColor = await page
        .getByText("Needs you: Which branch?", { exact: true })
        .evaluate((element) => getComputedStyle(element).color);

      assert.notEqual(questionColor, colors.expected);

      assert(colors.width <= colors.viewport, "No horizontal overflow");
      await page.getByRole("button", { name: "Open Untangle mac" }).click();
      assert.deepEqual(await page.evaluate(() => window.proof.opened), {
        projectId: "fixture-project",
        threadId: "failed",
      });
      await page.screenshot({
        path: join(output, `${theme}-${width}.png`),
        fullPage: true,
      });
      report.checks.push({ theme, width, colors, passed: true });
    }
  }

  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  await browser?.close();

  if (server.listening) await new Promise((done) => server.close(done));
  report.cleanup = {
    browserClosed: browser === undefined || !browser.isConnected(),
    serverClosed: !server.listening,
  };
  await writeFile(
    join(output, "browser-results.json"),
    JSON.stringify(report, null, 2),
  );
}

console.log(JSON.stringify(report));
