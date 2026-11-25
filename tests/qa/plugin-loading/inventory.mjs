import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function checkPluginInventory({ browser, origin, inventoryPath }) {
  const entries = JSON.parse(await readFile(inventoryPath, "utf8"));
  assert.ok(Array.isArray(entries) && entries.length > 0);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);

  const collector = await build({
    entryPoints: [
      fileURLToPath(new URL("./inventory-browser.mjs", import.meta.url)),
    ],
    bundle: true,
    format: "iife",
    globalName: "pluginInventory",
    write: false,
    logLevel: "silent",
  });

  const assets = new Map([
    ["/fixture/collector.js", collector.outputFiles[0].contents],
  ]);

  for (const [i, entry] of entries.entries()) {
    const bytes = await readFile(entry.js);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      entry.id,
    );
    assets.set(`/fixture/entry-${i}.js`, bytes);
  }

  const context = await browser.newContext({ serviceWorkers: "block" });

  try {
    let collecting = false;
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());

      if (url.origin !== origin) return route.abort();
      const asset = assets.get(url.pathname);

      if (asset)
        return route.fulfill({
          contentType: "text/javascript",
          body: Buffer.from(asset),
        });

      if (collecting) return route.abort();

      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(origin + "/settings", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        typeof globalThis.__omnyoPluginRuntime?.pluginSdkApp
          .usePluginResource === "function",
    );
    collecting = true;

    await page.addScriptTag({ url: origin + "/fixture/collector.js" });

    const rows = await page.evaluate(
      (ids) => globalThis.pluginInventory.collect(ids),
      entries.map((entry) => entry.id),
    );

    assert.equal(rows.length, entries.length);

    return {
      browser: browser.version(),
      registeredFrontends: rows.length,
      registrations: rows,
    };
  } finally {
    await context.close();
  }
}
