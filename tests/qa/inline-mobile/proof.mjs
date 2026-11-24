import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [modulePath, baseUrl, outputPath] = process.argv.slice(2);

if (!modulePath || !baseUrl || !outputPath) {
  throw new Error(
    "Usage: proof.mjs <existing-playwright-module> <local-fixture-url> <evidence-directory>",
  );
}

const url = new URL(baseUrl);

assert.equal(url.protocol, "http:");

assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));

const output = resolve(outputPath);

const root = fileURLToPath(new URL("../../..", import.meta.url));

const inputs = [
  "plugins/inline-vis/app.tsx",
  "plugins/inline-vis/README.md",
  "plugins/inline-vis/PLUGIN_OVERVIEW.md",
  "apps/app/src/components/ui/markdown-preview.tsx",
  "tests/qa/inline-mobile/fixture.tsx",
  "tests/qa/inline-mobile/fixture.css",
  "tests/qa/inline-mobile/vite.config.ts",
  "tests/qa/inline-mobile/index.html",
  "tests/qa/inline-mobile/proof.mjs",
];

async function hashes() {
  return Object.fromEntries(
    await Promise.all(
      inputs.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(resolve(root, path)))
          .digest("hex"),
      ]),
    ),
  );
}

await mkdir(output, { recursive: true });

const sourceHashes = await hashes();

const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);

const browser = await chromium.launch({ channel: "chrome", headless: true });

const measurements = [];

const deniedRequests = [];

const browserErrors = [];

const viewports = [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 844, height: 390 },
];

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport,
      hasTouch: viewport.width < 768,
    });

    try {
      const page = await context.newPage();
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());

        if (requestUrl.origin === url.origin) await route.continue();
        else {
          deniedRequests.push(requestUrl.origin);
          await route.abort();
        }
      });
      await page.goto(url.href, { waitUntil: "networkidle" });
      const markdown = page.getByTestId("markdown");
      await markdown.getByRole("button", { name: "Show more" }).waitFor();

      const file = await page.evaluate(
        () => globalThis.__inlineMobileProof.file,
      );

      const filename = markdown.locator("header span[title]");
      assert.equal(await filename.textContent(), "mobile-preview.md");
      assert.equal(await filename.getAttribute("title"), file);
      const copy = markdown.getByRole("button", { name: `Copy ${file}` });

      const open = markdown.getByRole("button", {
        name: `Open ${file} in sidebar`,
      });

      const expand = markdown.getByRole("button", { name: "Show more" });

      for (const control of [copy, open, expand]) {
        const box = await control.boundingBox();
        assert.ok(
          box && box.width >= 44 && box.height >= 44,
          "Markdown control is smaller than 44px",
        );
      }

      await copy.click();
      await open.click();

      const calls = await page.evaluate(
        () => globalThis.__inlineMobileProof.calls,
      );

      assert.ok(
        calls.some(
          (call) =>
            call.method === "copy" && call.value.startsWith("# Mobile preview"),
        ),
      );
      assert.ok(
        calls.some(
          (call) => call.method === "open" && call.value.target.path === file,
        ),
      );
      await expand.click();

      const documentRegion = markdown.getByRole("region", {
        name: `Document ${file}`,
        exact: true,
      });

      const documentBox = await documentRegion.boundingBox();
      assert.ok(
        documentBox && documentBox.height <= viewport.height * 0.7 + 2,
        "Markdown reader exceeded 70svh",
      );
      assert.equal(
        await documentRegion.evaluate(
          (element) => getComputedStyle(element).containerType,
        ),
        "inline-size",
      );
      await documentRegion.focus();
      const beforeScroll = await page.evaluate(() => window.scrollY);
      await page.keyboard.press("PageDown");
      await page.waitForFunction(
        () =>
          document.querySelector("[data-inline-vis-document]").scrollTop > 0,
      );
      assert.ok(
        Math.abs((await page.evaluate(() => window.scrollY)) - beforeScroll) <=
          1,
        "Document keyboard scroll escaped to the page",
      );
      await documentRegion.evaluate((element) => {
        element.scrollTop = 0;
      });

      const table = markdown.getByRole("region", {
        name: "Table (scroll horizontally for more columns)",
        exact: true,
      });

      await table.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[aria-label="Table (scroll horizontally for more columns)"]',
          ).scrollLeft > 0,
      );
      assert.equal(
        await table
          .locator("th")
          .first()
          .evaluate((element) => getComputedStyle(element).whiteSpace),
        "nowrap",
      );
      assert.equal(await page.evaluate(() => window.scrollX), 0);
      const frameHeights = {};

      for (const name of ["tall-html", "short-html", "closed-fence"]) {
        const section = page.getByTestId(name);
        const iframe = section.locator("iframe");
        await iframe.waitFor();
        assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts");

        const action = section.getByRole(
          name === "closed-fence" ? "button" : "link",
        );

        const actionBox = await action.boundingBox();
        assert.ok(
          actionBox && actionBox.width >= 44 && actionBox.height >= 44,
          "HTML control is smaller than 44px",
        );

        const contentHeight =
          name === "short-html" ? 120 : name === "closed-fence" ? 900 : 1800;

        await page
          .waitForFunction(
            ({ name, expected }) => {
              const frame = document.querySelector(
                `[data-testid="${name}"] iframe`,
              );

              return (
                frame !== null &&
                Math.abs(frame.getBoundingClientRect().height - expected) <= 2
              );
            },
            { name, expected: Math.min(contentHeight, viewport.height * 0.7) },
            { timeout: 10_000 },
          )
          .catch(async (error) => {
            const hostBox = await iframe.boundingBox();

            const inner = await iframe
              .contentFrame()
              .locator("html")
              .evaluate((element) => ({
                text: document.body?.textContent,
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight,
                contentHeight: element.getBoundingClientRect().height,
                readyState: document.readyState,
              }));

            throw new Error(
              `Autoheight did not settle at ${viewport.width}x${viewport.height} for ${name}: ${JSON.stringify({ hostBox, inner, expected: Math.min(contentHeight, viewport.height * 0.7) })}`,
              { cause: error },
            );
          });
        const box = await iframe.boundingBox();
        assert.ok(
          box && box.height <= viewport.height * 0.7 + 2,
          "HTML frame exceeded 70svh",
        );
        frameHeights[name] = box.height;
      }

      assert.ok(
        frameHeights["short-html"] < 200,
        "Short HTML stopped fitting its own content",
      );
      assert.ok(
        frameHeights["tall-html"] > frameHeights["short-html"],
        "HTML autoheight distinction was lost",
      );
      const fence = page.getByTestId("closed-fence");
      await fence.getByRole("button", { name: "Show source" }).click();
      await fence.getByTestId("fence-source").waitFor();
      await fence.getByRole("button", { name: "Hide source" }).click();
      assert.equal(await fence.getByTestId("fence-source").count(), 0);
      assert.equal(
        await page.getByTestId("streaming-fence").textContent(),
        "Writing visualization…",
      );
      assert.equal(
        await page.getByTestId("unclosed-fence").textContent(),
        "Unclosed source retained",
      );
      await page.getByRole("button", { name: "Remount previews" }).click();
      await markdown.getByRole("button", { name: "Show less" }).waitFor();

      const geometry = await page.evaluate(() => ({
        viewportWidth: innerWidth,
        pageWidth: document.documentElement.scrollWidth,
      }));

      assert.ok(
        geometry.pageWidth <= geometry.viewportWidth + 1,
        "Fixture page has horizontal overflow",
      );
      await markdown.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(output, `${viewport.width}x${viewport.height}.jpg`),
        type: "jpeg",
        quality: 80,
      });
      measurements.push({
        viewport,
        geometry,
        frameHeights,
        documentHeight: documentBox.height,
        copy: true,
        open: true,
        keyboard: true,
        expansionRemembered: true,
        fencedStates: true,
      });
    } finally {
      await context.close();
    }
  }

  assert.deepEqual(
    await hashes(),
    sourceHashes,
    "Source changed during the browser proof",
  );
  assert.deepEqual(
    deniedRequests,
    [],
    "Fixture attempted requests outside its local origin",
  );
  assert.deepEqual(
    browserErrors,
    [],
    "Production components raised browser errors",
  );
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        browser: "Chrome",
        scope: "production components with local RPC fixture",
        sourceHashes,
        measurements,
        deniedRequests,
        browserErrors,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await writeFile(
    resolve(output, "failure.json"),
    JSON.stringify(
      {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        sourceHashes,
        measurements,
        deniedRequests,
        browserErrors,
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
}
