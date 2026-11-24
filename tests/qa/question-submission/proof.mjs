import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const [mode, output, baseline] = process.argv.slice(2);

assert(
  output && ["prepare", "check"].includes(mode),
  "Usage: proof.mjs prepare|check OUTPUT [BASELINE_FORM_OR_PLAYWRIGHT_MODULE]",
);

const owner = resolve(root, "apps/app/src/components/ui/question-form.tsx");

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

if (mode === "prepare") {
  assert(baseline, "Supply the original question-form.tsx");
  await mkdir(output, { recursive: true });
  const hashes = {};

  for (const side of ["before", "after"]) {
    const source = await readFile(side === "before" ? baseline : owner, "utf8");
    hashes[side] = createHash("sha256").update(source).digest("hex");

    const bundle = await build({
      stdin: {
        contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {QuestionForm} from ${JSON.stringify(owner)};
const questions=[{id:'q',prompt:'Choose an answer',shortLabel:'Answer',multiSelect:false,allowFreeText:true,options:[]}];
function App(){const [done,setDone]=useState(false);return done?<div role="status">Answer accepted</div>:<QuestionForm questions={questions} draftKey="fixture" disabled={false} cancelDisabled={false} onCancel={()=>{}} onSubmit={async(answers)=>{const response=await fetch('/answer',{method:'POST',body:JSON.stringify(answers)});if(!response.ok)throw Error('Delivery failed');setDone(true)}}/>}
window.proof={ready:false};
createRoot(document.getElementById('root')).render(<App/>);window.proof.ready=true;`,
        loader: "tsx",
        resolveDir: resolve(root, "apps/app"),
      },
      bundle: true,
      write: false,
      minify: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "bound-form",
          setup(builder) {
            builder.onLoad({ filter: /\/question-form\.tsx$/ }, (args) =>
              args.path !== owner
                ? null
                : {
                    contents: source,
                    loader: "tsx",
                    resolveDir:
                      side === "before"
                        ? resolve(root, "packages/shared-ui/src/components/ui")
                        : resolve(owner, ".."),
                  },
            );
          },
        },
      ],
    });

    await writeFile(
      resolve(output, `${side}.js`),
      bundle.outputFiles[0].contents,
    );
  }

  await writeFile(
    resolve(output, "inputs.json"),
    JSON.stringify(
      {
        hashes,
        delayMs: 500,
        surface:
          "Production React shared question form in isolated Chrome; controlled local HTTP acceptance; no live provider effects",
      },
      null,
      2,
    ),
  );
  console.log("Prepared both production-mode bundles");
} else {
  const inputs = JSON.parse(
    await readFile(resolve(output, "inputs.json"), "utf8"),
  );

  const requests = [];

  const server = createServer(async (request, response) => {
    if (request.url === "/answer") {
      let body = "";

      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      await delay(inputs.delayMs);
      response.writeHead(200).end("accepted");
    } else if (request.url.endsWith(".js")) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(
        await readFile(
          resolve(
            output,
            request.url === "/before.js" ? "before.js" : "after.js",
          ),
        ),
      );
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<html><head><style>body{background:#202020;color:#eee;font:16px system-ui;padding:20px}button,textarea{font:inherit;margin:8px;padding:12px}textarea{display:block}svg{width:18px;height:18px}</style></head><body><div id="root"></div><script src="/${request.url === "/before" ? "before" : "after"}.js"></script></body></html>`,
      );
    }
  });

  assert(baseline, "Supply an installed Playwright module path");
  const { chromium } = await import(pathToFileURL(resolve(baseline)).href);
  let browser;
  const report = { ...inputs, checks: [], requests, errors: [] };

  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    browser = await chromium.launch({ channel: "chrome", headless: true });

    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });

    page.on("pageerror", (error) => report.errors.push(error.message));

    for (const method of ["click", "shortcut"]) {
      for (const side of ["before", "after"]) {
        let accept;

        const delivery = new Promise((resolve) => {
          accept = resolve;
        });

        await page.route("**/answer", async (route) => {
          await delivery;
          await route.continue();
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/${side}`);
        await page.getByRole("textbox").fill("Keep my answer");

        if (method === "click")
          await page.getByRole("button", { name: "Submit answer" }).click();
        else await page.getByRole("textbox").press("Meta+Enter");

        if (side === "after") {
          await page
            .getByRole("status")
            .filter({ hasText: "Sending answer" })
            .waitFor();
          assert.equal(await page.getByRole("textbox").count(), 0);
          report.checks.push(
            `${method}: compact acknowledgement before HTTP acceptance`,
          );

          if (method === "click")
            await page.screenshot({
              path: resolve(output, "sending-answer.png"),
            });
        } else {
          assert.equal(await page.getByRole("textbox").count(), 1);
          assert.equal(await page.getByRole("status").count(), 0);
          report.checks.push(
            `${method}: baseline leaves the question open until HTTP acceptance`,
          );
        }

        accept();
        await page
          .getByRole("status")
          .filter({ hasText: "Answer accepted" })
          .waitFor();
        await page.unroute("**/answer");
      }
    }

    assert.equal(requests.length, 4);
    assert(requests.every((answer) => answer.q.freeText === "Keep my answer"));
    assert.deepEqual(report.errors, []);
    await writeFile(
      resolve(output, "browser-results.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();

    if (server.listening) await new Promise((done) => server.close(done));
  }
}
