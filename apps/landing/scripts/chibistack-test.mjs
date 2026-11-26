import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const root = process.env.SITE_TEST_ROOT ?? "/app";

const port = process.env.SITE_TEST_PORT ?? "8080";

const origin = `http://127.0.0.1:${port}`;

const { values } = parseArgs({
  options: {
    "workflow-state": { type: "string" },
    "workflow-sha256": { type: "string" },
    "starter-sha256": { type: "string" },
    "workflow-revision": { type: "string" },
    "explore-state": { type: "string" },
    "explore-absent-marker": { type: "string" },
  },
});

const pinnedExploreState = values["explore-state"];

if (pinnedExploreState !== undefined)
  assert.ok(
    ["inactive", "active"].includes(pinnedExploreState),
    "--explore-state must be inactive or active",
  );

const absentMarker = values["explore-absent-marker"];

if (absentMarker !== undefined) {
  assert.ok(
    absentMarker.length > 0,
    "--explore-absent-marker must not be empty",
  );
  assert.ok(
    pinnedExploreState === undefined || pinnedExploreState === "active",
    "--explore-absent-marker is only valid with an active Explore state",
  );
}

const expectedWorkflowState = values["workflow-state"];

if (expectedWorkflowState !== undefined)
  assert.ok(["draft", "published"].includes(expectedWorkflowState));

const expectedWorkflowDigest = values["workflow-sha256"];

const expectedWorkflowRevision = values["workflow-revision"];

const expectedStarterDigest = values["starter-sha256"];

if (expectedStarterDigest !== undefined) {
  assert.match(expectedStarterDigest, /^[a-f0-9]{64}$/);
  assert.equal(expectedWorkflowState, "published");
}

if (expectedWorkflowDigest !== undefined)
  assert.match(expectedWorkflowDigest, /^[a-f0-9]{64}$/);

if (expectedWorkflowRevision !== undefined)
  assert.match(expectedWorkflowRevision, /^[1-9][0-9]*$/);

if (expectedWorkflowState === "published") {
  assert.ok(expectedWorkflowDigest, "published smoke needs --workflow-sha256");
  assert.ok(
    expectedWorkflowRevision,
    "published smoke needs --workflow-revision",
  );
}

const workflowPath = "/workflows/weekly-content-feed";

const workflowPreview = `${workflowPath}/preview.png`;

const workflowFile = (digest) => `${workflowPath}/file/${digest}`;

const workflowInstaller = "/downloads/Omnyo-Weekly-Content-Feed-Setup.zip";

if (root === "/app") {
  assert.equal(
    process.getuid(),
    65532,
    "run the image test as the application UID",
  );
}

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: port },
  stdio: ["ignore", "inherit", "inherit"],
});

const closed = new Promise((resolve) => server.once("close", resolve));

let spawnError;

server.once("error", (error) => {
  spawnError = error;
});

const seenBodies = [];

async function fetchPath(path, method = "GET", headers = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    signal: AbortSignal.timeout(3000),
  });

  const body = Buffer.from(await response.arrayBuffer());
  seenBodies.push(body);

  return new Response(body.byteLength > 0 ? body : null, {
    status: response.status,
    headers: response.headers,
  });
}

async function get(path) {
  const response = await fetchPath(path);
  assert.equal(
    response.status,
    200,
    `${path} returned HTTP ${response.status}`,
  );

  return response;
}

const exploreSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const exploreKinds = ["prompt", "workflow", "plugin", "guide"];

const exploreCtaKinds = {
  prompt: "copy-prompt",
  workflow: "get-workflow",
  plugin: "find-in-omnyo",
  guide: "read-guide",
};

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value, min, max) {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}

function isExplorePath(value) {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\s\\]/u.test(value)
  );
}

function isExploreSlug(value) {
  return isBoundedString(value, 1, 64) && exploreSlugPattern.test(value);
}

function validateExploreCatalog(catalog) {
  assert.ok(isPlainObject(catalog), "catalog must be an object");
  assert.equal(catalog.schemaVersion, 1, "catalog schemaVersion must be 1");
  assert.ok(Array.isArray(catalog.items), "catalog items must be an array");
  assert.ok(catalog.items.length <= 500, "catalog has more than 500 items");

  const keys = new Set();

  catalog.items.forEach((item, index) => {
    const label = `catalog item ${index}`;
    assert.ok(isPlainObject(item), `${label} must be an object`);
    assert.ok(exploreKinds.includes(item.kind), `${label} has a bad kind`);
    assert.ok(isExploreSlug(item.slug), `${label} has a bad slug`);

    const key = `${item.kind}/${item.slug}`;
    assert.ok(!keys.has(key), `${label} duplicates ${key}`);
    keys.add(key);

    assert.ok(isBoundedString(item.title, 1, 120), `${key} has a bad title`);
    assert.ok(
      isBoundedString(item.summary, 1, 400),
      `${key} has a bad summary`,
    );
    assert.ok(
      isBoundedString(item.publisher, 1, 80),
      `${key} has a bad publisher`,
    );
    assert.ok(
      Array.isArray(item.tags) &&
        item.tags.length <= 12 &&
        item.tags.every((tag) => isBoundedString(tag, 1, 32)),
      `${key} has bad tags`,
    );
    assert.ok(isExplorePath(item.path), `${key} has a bad path`);

    if (item.preview !== null) {
      assert.ok(isPlainObject(item.preview), `${key} has a bad preview`);
      assert.ok(isExplorePath(item.preview.path), `${key} preview path`);
      assert.ok(
        isBoundedString(item.preview.alt, 1, 300),
        `${key} preview alt`,
      );
      assert.ok(
        Number.isSafeInteger(item.preview.width) && item.preview.width > 0,
        `${key} preview width`,
      );
      assert.ok(
        Number.isSafeInteger(item.preview.height) && item.preview.height > 0,
        `${key} preview height`,
      );
    }

    const cta = item.cta;
    assert.ok(isPlainObject(cta), `${key} needs a cta`);
    assert.equal(cta.kind, exploreCtaKinds[item.kind], `${key} cta kind`);
    assert.ok(isBoundedString(cta.label, 1, 40), `${key} has a bad cta label`);

    if (item.kind === "prompt") {
      assert.ok(isExplorePath(cta.textPath), `${key} cta textPath`);
      assert.equal(item.path, `/explore/prompts/${item.slug}`, `${key} path`);
      assert.equal(cta.textPath, `${item.path}/text`, `${key} textPath`);
    } else if (item.kind === "plugin") {
      assert.ok(isExploreSlug(cta.pluginId), `${key} cta pluginId`);
      assert.ok(isExploreSlug(cta.marketplace), `${key} cta marketplace`);
      assert.ok(isBoundedString(cta.install, 1, 200), `${key} cta install`);
      assert.equal(item.path, `/explore/plugins/${item.slug}`, `${key} path`);
    } else {
      assert.ok(isExplorePath(cta.path), `${key} cta path`);
    }
  });

  return catalog.items;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) return listFiles(path);

      return entry.isFile() ? [path] : [];
    }),
  );

  return nested.flat();
}

function assertHeaders(response, path, expected) {
  for (const [header, value] of Object.entries(expected))
    assert.equal(
      (response.headers.get(header) ?? "").toLowerCase(),
      value,
      `${path} ${header}`,
    );
}

const exploreTextHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

async function assertHiddenResource(path) {
  const response = await fetchPath(path);
  assert.equal(
    response.status,
    404,
    `${path} returned HTTP ${response.status}`,
  );
  assert.match(
    response.headers.get("x-robots-tag") ?? "",
    /noindex/,
    `${path} must be noindex`,
  );
  assert.equal(
    (response.headers.get("cache-control") ?? "").toLowerCase(),
    "no-store",
    `${path} must not be cached`,
  );
  assert.equal(
    (await response.arrayBuffer()).byteLength,
    0,
    `${path} 404 must have a null body`,
  );
}

try {
  const deadline = Date.now() + 30_000;
  let ready = false;
  let lastError;

  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(server.exitCode, null, "application exited before readiness");
    assert.equal(
      server.signalCode,
      null,
      "application was killed before readiness",
    );

    try {
      const response = await get("/api/v0/health");
      assert.deepEqual(await response.json(), { ok: true });
      ready = true;
      break;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }

  assert.ok(ready, `readiness deadline exceeded: ${lastError?.message}`);

  const home = await get("/");
  assert.doesNotMatch(
    home.headers.get("x-robots-tag") ?? "",
    /noindex/,
    "production must stay indexable",
  );
  const html = await home.text();
  assert.match(html, /<title>Omnyo/);
  assert.match(html, /<link rel="canonical" href="https:\/\/omnyohq\.com\/"/);
  assert.match(
    html,
    /href="https:\/\/github\.com\/alexburlis\/omnyo-releases\/releases\/download\/macos\/Omnyo-macOS\.zip"/,
    "home must link the macOS download",
  );
  assert.match(
    html,
    /href="https:\/\/github\.com\/get-bb\/bb"/,
    "home must credit bb",
  );
  const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(asset, "home must reference a built static asset");
  assert.match(html, /data-consent-panel/, "home must mount cookie settings");
  assert.doesNotMatch(
    html,
    /<script[^>]+src="https?:/,
    "pages must not load third-party scripts before consent",
  );

  for (const [headers, choice] of [
    [{}, null],
    [{ "sec-gpc": "1" }, "rejected"],
    [{ dnt: "1" }, "rejected"],
  ]) {
    const response = await fetchPath("/api/consent-default", "GET", headers);
    assert.equal(response.status, 200, "/api/consent-default status");
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store",
      "/api/consent-default must not be cached",
    );
    assert.deepEqual(await response.json(), { choice });
  }

  await Promise.all(
    [
      "/ox/static/array.js",
      "/ox/array/retired-test-project/config.js",
      "/ox/decide/",
    ].map(async (path) => {
      const response = await fetchPath(path);
      assert.equal(response.status, 410, `${path} must stay closed`);
    }),
  );

  const sitemap = await (await get("/sitemap.xml")).text();

  const exploreIndex = await fetchPath("/explore");
  assert.ok(
    [200, 404].includes(exploreIndex.status),
    `/explore returned HTTP ${exploreIndex.status}`,
  );
  const exploreState = exploreIndex.status === 200 ? "active" : "inactive";

  if (pinnedExploreState !== undefined)
    assert.equal(exploreState, pinnedExploreState);

  if (absentMarker !== undefined)
    assert.equal(
      exploreState,
      "active",
      "--explore-absent-marker is only valid with an active Explore state",
    );

  const gallery = await fetchPath("/workflows");
  assert.ok([200, 404].includes(gallery.status));
  await gallery.arrayBuffer();
  const workflowState = gallery.status === 200 ? "published" : "draft";
  const workflowHtml = [];

  if (expectedWorkflowState !== undefined)
    assert.equal(workflowState, expectedWorkflowState);

  if (workflowState === "draft") {
    assert.doesNotMatch(
      html,
      /href="(?:https:\/\/omnyohq\.com)?\/workflows(?:\/|"|\?)/,
    );
    assert.doesNotMatch(sitemap, /https:\/\/omnyohq\.com\/workflows(?:\/|<)/);
    await Promise.all(
      [
        workflowPath,
        workflowFile(expectedWorkflowDigest ?? "a".repeat(64)),
        workflowPreview,
      ].map(async (path) => {
        const response = await fetchPath(path);
        await response.arrayBuffer();
        assert.equal(response.status, 404, `${path} must hide a draft`);
      }),
    );
  } else {
    assert.match(html, /href="(?:https:\/\/omnyohq\.com)?\/workflows"/);

    let workflowDigest;
    let workflowRevision;

    for (const path of ["/workflows", workflowPath]) {
      assert.ok(sitemap.includes(`<loc>https://omnyohq.com${path}</loc>`));
      const response = await get(path);
      assert.doesNotMatch(
        response.headers.get("x-robots-tag") ?? "",
        /noindex/,
      );
      const text = await response.text();
      workflowHtml.push(text);
      assert.ok(
        text.includes(`href="https://omnyohq.com${path}"`),
        `${path} needs a canonical URL`,
      );
      assert.match(text, /Weekly Content Feed/);

      if (path === workflowPath) {
        workflowDigest = text.match(
          /weekly-content-feed\/file\/([a-f0-9]{64})"/,
        )?.[1];
        workflowRevision = text
          .replaceAll("<!-- -->", "")
          .match(/Workflow revision ([1-9][0-9]*)/u)?.[1];
        assert.ok(workflowDigest, "SSR must pin the downloadable digest");
        assert.ok(workflowRevision, "SSR must show the workflow revision");
        assert.ok(
          text.includes(
            `href="omnyo://workflows/import/${workflowDigest.slice(0, 32)}"`,
          ),
          "The installed-app link must open the pinned workflow",
        );
        assert.ok(
          text.includes(
            `class="wf-get" href="${workflowInstaller}" download=""`,
          ),
          "The primary install action must download the signed starter",
        );
        assert.match(text, /aria-label="Review decisions"/);
        assert.match(text, /What a complete run delivers/);

        if (expectedWorkflowDigest !== undefined)
          assert.equal(workflowDigest, expectedWorkflowDigest);

        if (expectedWorkflowRevision !== undefined)
          assert.equal(workflowRevision, expectedWorkflowRevision);
        assert.ok(
          text.includes(workflowPreview),
          "SSR must show the public preview",
        );
      }
    }

    assert.doesNotMatch(
      sitemap,
      /\/workflows\/weekly-content-feed\/(?:file|preview)/,
    );
    const response = await get(workflowFile(workflowDigest));

    for (const [header, expected] of [
      ["content-type", /^application\/octet-stream(?:;|$)/],
      [
        "content-disposition",
        /^attachment;.*weekly-content-feed\.omnyoworkflow/,
      ],
      ["x-content-type-options", /^nosniff$/],
      ["x-robots-tag", /noindex/],
      ["cache-control", /no-store/],
    ])
      assert.match(response.headers.get(header) ?? "", expected, header);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      workflowDigest,
    );
    assert.equal(
      JSON.parse(bytes.toString("utf8")).revision,
      Number(workflowRevision),
    );
    const preview = await get(workflowPreview);
    assert.match(preview.headers.get("content-type") ?? "", /^image\/png/);
    assert.doesNotMatch(
      preview.headers.get("cache-control") ?? "",
      /immutable/,
    );
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    assert.equal(
      previewBytes.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    const installer = await get(workflowInstaller);
    const installerBytes = Buffer.from(await installer.arrayBuffer());
    assert.equal(installerBytes.subarray(0, 4).toString("hex"), "504b0304");

    if (expectedStarterDigest !== undefined)
      assert.equal(
        createHash("sha256").update(installerBytes).digest("hex"),
        expectedStarterDigest,
        "The served starter must match the approved ZIP",
      );

    for (const path of [
      "/workflows/unknown-workflow",
      `${workflowPath}/file/${"0".repeat(64)}`,
    ]) {
      const response = await fetchPath(path);
      await response.arrayBuffer();
      assert.equal(
        response.status,
        404,
        `${path} must reject an unknown listing or digest`,
      );
    }
  }

  const guide = sitemap.match(
    /<loc>https:\/\/omnyohq\.com(\/guides\/[^<]+)<\/loc>/,
  )?.[1];

  assert.ok(guide, "the sitemap must list a guide");
  assert.match(
    await (await get("/robots.txt")).text(),
    /Sitemap: https:\/\/omnyohq\.com\/sitemap\.xml/,
  );

  const pages = ["/plugin-guide", "/privacy", guide];

  const pageHtml = await Promise.all(
    pages.map(async (path) => {
      const text = await (await get(path)).text();
      assert.match(text, /<title>[^<]*Omnyo/, `${path} must render`);

      return text;
    }),
  );

  const exploreHtml = [];
  const exploreCatalogPaths = [];
  let exploreCatalogItems = 0;

  if (exploreState === "inactive") {
    for (const path of [
      "/explore/catalog.json",
      "/explore/prompts/review-a-product-update/text",
    ])
      await assertHiddenResource(path);

    for (const path of [
      "/explore/prompts/review-a-product-update",
      "/explore/plugins/browser-automation",
    ]) {
      const response = await fetchPath(path);
      assert.equal(
        response.status,
        404,
        `${path} must be hidden while Explore is inactive`,
      );
    }

    for (const text of [html, ...pageHtml, ...workflowHtml])
      assert.doesNotMatch(
        text,
        /href="(?:https:\/\/omnyohq\.com)?\/explore(?:[/?#"])/,
      );

    assert.doesNotMatch(
      sitemap,
      /<loc>https:\/\/omnyohq\.com\/explore(?:\/|<)/,
    );
  } else {
    const indexText = await exploreIndex.text();
    exploreHtml.push(indexText);
    assert.doesNotMatch(
      exploreIndex.headers.get("x-robots-tag") ?? "",
      /noindex/,
      "/explore must be indexable",
    );
    assert.equal(
      (exploreIndex.headers.get("cache-control") ?? "").toLowerCase(),
      "no-store",
    );
    assert.match(indexText, /<title>[^<]*Explore/);

    for (const path of [
      "/explore",
      "/explore?type=prompt",
      "/explore?q=review",
      "/explore?type=plugin&q=browser",
      "/explore?q=zz-no-explore-match",
    ]) {
      const text =
        path === "/explore" ? indexText : await (await get(path)).text();

      assert.ok(
        text.includes(
          '<link rel="canonical" href="https://omnyohq.com/explore"',
        ),
        `${path} must keep the /explore canonical`,
      );
    }

    const promptView = await (await get("/explore?type=prompt")).text();
    assert.ok(
      promptView.includes('href="/explore/prompts/review-a-product-update"'),
      "type=prompt must list the prompt card",
    );
    assert.ok(
      !promptView.includes('href="/explore/plugins/browser-automation"'),
      "type=prompt must not list the plugin card",
    );

    const emptyView = await (
      await get("/explore?q=zz-no-explore-match")
    ).text();

    assert.match(emptyView, /data-explore-empty/);
    assert.ok(
      emptyView.includes('href="/explore"'),
      "the empty view must offer to clear filters",
    );

    const catalogResponse = await get("/explore/catalog.json");
    assertHeaders(catalogResponse, "/explore/catalog.json", {
      "content-type": "application/json; charset=utf-8",
      ...exploreTextHeaders,
    });
    assert.match(catalogResponse.headers.get("x-robots-tag") ?? "", /noindex/);
    const items = validateExploreCatalog(await catalogResponse.json());
    exploreCatalogItems = items.length;

    const kinds = new Set(items.map((item) => item.kind));

    const requiredKinds =
      workflowState === "published"
        ? exploreKinds
        : exploreKinds.filter((kind) => kind !== "workflow");

    for (const kind of requiredKinds)
      assert.ok(kinds.has(kind), `catalog must contain a ${kind} item`);

    if (workflowState === "draft")
      assert.ok(
        !kinds.has("workflow"),
        "catalog must not list a draft workflow",
      );

    const catalogKeys = items.map((item) => `${item.kind}/${item.slug}`);

    for (const key of [
      "prompt/review-a-product-update",
      "plugin/browser-automation",
      "guide/run-an-agent-on-a-schedule",
    ])
      assert.ok(catalogKeys.includes(key), `catalog must contain ${key}`);

    for (const item of items) {
      const response = await get(item.path);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
      assert.doesNotMatch(
        response.headers.get("x-robots-tag") ?? "",
        /noindex/,
      );
      const text = await response.text();
      assert.match(text, /<title>[^<]+<\/title>/, `${item.path} needs a title`);

      if (item.path.startsWith("/explore/")) {
        exploreHtml.push(text);
        exploreCatalogPaths.push(item.path);
        assert.ok(
          text.includes(
            `<link rel="canonical" href="https://omnyohq.com${item.path}"`,
          ),
          `${item.path} needs a self canonical`,
        );
        assert.ok(
          text.includes('href="/explore"'),
          `${item.path} must link back to Explore`,
        );
      }

      if (item.kind === "prompt") {
        assert.ok(
          text.includes(`href="${item.cta.textPath}"`),
          `${item.path} must link its prompt text`,
        );
        const textResponse = await get(item.cta.textPath);
        assertHeaders(textResponse, item.cta.textPath, {
          "content-type": "text/plain; charset=utf-8",
          ...exploreTextHeaders,
        });
        assert.match(textResponse.headers.get("x-robots-tag") ?? "", /noindex/);
        const bytes = new Uint8Array(await textResponse.arrayBuffer());
        const prompt = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        assert.ok(prompt.length > 0, `${item.cta.textPath} must not be empty`);
        assert.ok(!prompt.includes("\r"), `${item.cta.textPath} must use LF`);
        assert.ok(
          prompt.endsWith("\n") && !prompt.endsWith("\n\n"),
          `${item.cta.textPath} must end in exactly one newline`,
        );
      }
    }

    for (const path of [
      "/explore/prompts/unknown-prompt",
      "/explore/plugins/unknown-plugin",
      "/explore/prompts/Review-A-Product-Update",
      "/explore/plugins/Browser-Automation",
    ]) {
      const response = await fetchPath(path);
      assert.equal(
        response.status,
        404,
        `${path} returned HTTP ${response.status}`,
      );
    }

    for (const path of [
      "/explore/prompts/unknown-prompt/text",
      "/explore/prompts/Review-A-Product-Update/text",
    ])
      await assertHiddenResource(path);

    const locs = Array.from(
      sitemap.matchAll(/<loc>([^<]*)<\/loc>/g),
      (match) => match[1],
    );

    assert.equal(
      new Set(locs).size,
      locs.length,
      "sitemap locs must be unique",
    );

    for (const path of ["/explore", ...exploreCatalogPaths])
      assert.equal(
        locs.filter((loc) => loc === `https://omnyohq.com${path}`).length,
        1,
        `${path} must appear in the sitemap exactly once`,
      );

    assert.doesNotMatch(
      sitemap,
      /<loc>[^<]*\/explore\/(?:catalog\.json|prompts\/[^<]*\/text)/,
    );

    for (const text of [html, pageHtml.at(0), pageHtml.at(2), ...workflowHtml])
      assert.ok(
        text.includes('href="/explore"'),
        "site navigation must link Explore",
      );
  }

  const linkedAssets = new Set(
    [html, ...pageHtml, ...exploreHtml].flatMap((text) =>
      Array.from(
        text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),
        (match) => match[1],
      ),
    ),
  );

  await Promise.all(
    [...linkedAssets].map(async (path) => {
      await (await get(path)).arrayBuffer();
    }),
  );

  const files = [
    asset,
    "/logo.png",
    "/model.glb",
    "/releases/latest.json",
    "/og.png",
  ];

  const responses = await Promise.all(files.map(get));
  assert.match(
    responses.at(1).headers.get("content-type") ?? "",
    /^image\/png/,
  );
  assert.match(
    responses.at(2).headers.get("content-type") ?? "",
    /^model\/gltf-binary/,
  );
  assert.match(responses.at(0).headers.get("cache-control") ?? "", /immutable/);
  await Promise.all(
    responses.map(async (response) => {
      assert.ok(
        (await response.arrayBuffer()).byteLength > 0,
        "asset must not be empty",
      );
    }),
  );
  assert.equal((await fetchPath("/logo.png", "HEAD")).status, 200);

  const badHost = await new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: "/", headers: { host: "a b" } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );

    request.once("error", reject);
    request.end();
  });

  assert.equal(badHost, 400, "a malformed Host header must not crash a page");

  const dropped = [
    "/dashboard",
    "/marketplace",
    "/marketplace/v2/marketplace.json",
    "/api/subscribe",
    "/blog",
    "/server.mjs",
    "/../server.mjs",
  ];

  await Promise.all(
    dropped.map(async (path) => {
      const response = await fetchPath(path);
      await response.arrayBuffer();
      assert.equal(
        response.status,
        404,
        `${path} returned HTTP ${response.status}`,
      );
    }),
  );

  if (absentMarker !== undefined) {
    const needle = Buffer.from(absentMarker, "utf8");

    for (const body of seenBodies)
      assert.ok(
        !body.includes(needle),
        `--explore-absent-marker "${absentMarker}" appeared in an HTTP response`,
      );

    const clientRoot = join(root, "dist", "client");

    for (const file of await listFiles(clientRoot))
      assert.ok(
        !(await readFile(file)).includes(needle),
        `--explore-absent-marker "${absentMarker}" appeared in ${file}`,
      );
  }

  console.log(
    `PASS readiness, home, indexable, consent default, analytics proxy, guides, plugin guide, privacy, sitemap, linked assets, static files, latest.json, removed routes, ${workflowState} workflows and ${exploreState} explore${absentMarker === undefined ? "" : " with the absent marker checked"}`,
  );
} finally {
  server.kill("SIGTERM");
  const force = setTimeout(() => server.kill("SIGKILL"), 3000);
  await closed;
  clearTimeout(force);
}
