import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../../../../../plugins/browser-automation/runtime.ts";
import { runtimeRelease } from "../../../../../plugins/browser-automation/runtime-pin.ts";

const [
  binaryPath,
  chromePath,
  fixtureUrl,
  evidencePath,
  scratchParent,
  glancePath,
] = process.argv.slice(2);

assert.ok(
  binaryPath &&
    chromePath &&
    fixtureUrl &&
    evidencePath &&
    scratchParent &&
    glancePath,
  "Usage: node --import tsx proof.mjs BINARY CHROME LOCAL_URL EVIDENCE_DIR SCRATCH_PARENT GLANCE_SOURCE",
);

const url = new URL(fixtureUrl);

assert.equal(url.protocol, "http:");

assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));

assert.equal((await stat(scratchParent)).isDirectory(), true);

const repositoryRoot = fileURLToPath(
  new URL("../../../../..", import.meta.url),
);

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));

const output = resolve(evidencePath);

await mkdir(output, { recursive: true });

const sourceFiles = [
  "apps/app/src/components/plugin/PluginImagePreview.tsx",
  "apps/app/src/components/ui/image-lightbox.tsx",
  "plugins/browser-automation/visual-controls.tsx",
  "plugins/browser-automation/visual-selection.ts",
  "plugins/browser-automation/contracts.ts",
  "packages/plugin-sdk/src/app.ts",
  "packages/sdk/src/areas/projects.ts",
  "apps/app/tests/qa/orca-visual-workflow/fixture.jsx",
  "apps/app/tests/qa/orca-visual-workflow/fixture.css",
  "apps/app/tests/qa/orca-visual-workflow/journey.js",
  "apps/app/tests/qa/orca-visual-workflow/proof.mjs",
  "apps/app/tests/qa/orca-visual-workflow/vite.config.mjs",
].map((path) => resolve(repositoryRoot, path));

sourceFiles.push(
  ...[
    "contract.ts",
    "components/project-image.tsx",
    "components/page.tsx",
    "components/data.ts",
  ].map((path) => resolve(glancePath, path)),
);

async function hashes() {
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
}

const before = await hashes();

const root = await mkdtemp(join(resolve(scratchParent), "ui-proof-"));

await writeFile(
  join(output, "ui-owner.json"),
  JSON.stringify(
    {
      owner: "thr_n669hxyzd8/finish_ui_proof",
      scratch: root,
      class: "disposable owned browser profile and runtime",
      restore:
        "apps/app/tests/qa/orca-visual-workflow/proof.mjs + installed pinned runtime + local fixture",
      expectedBytes: 50000000,
    },
    null,
    2,
  ),
);

const dataDir = join(root, "data");

await mkdir(join(dataDir, "runtime"), { recursive: true });

await symlink(resolve(chromePath), join(dataDir, "runtime/chrome"));

let session;

let result;

const signal = AbortSignal.timeout(50_000);

const started = performance.now();

try {
  session = await createRuntime({
    runtime: {
      binary: resolve(binaryPath),
      version: runtimeRelease.version,
      source: "release",
    },
    dataDir,
    tempDir: join(root, "sessions"),
    signal,
  });

  const script = (
    await readFile(join(fixtureRoot, "journey.js"), "utf8")
  ).replace("__ORCA_FIXTURE_URL__", JSON.stringify(url.href));

  const run = await session.run(script, 43_000, signal);
  await writeFile(join(output, "ui-runtime.log"), run.text);
  assert.equal(run.exitCode, 0, run.text);
  const record = JSON.parse(run.text.trim());
  assert.equal(record.passed, true);
  assert.equal(run.images.length, 4);

  for (const [index, image] of run.images.entries())
    await copyFile(
      image.path,
      join(
        output,
        `ui-${index < 2 ? "desktop" : "mobile"}-${index % 2 === 0 ? "annotation" : "glance"}.jpg`,
      ),
      constants.COPYFILE_FICLONE,
    );
  assert.deepEqual(
    await hashes(),
    before,
    "Proof inputs changed during execution",
  );
  result = {
    ...record,
    elapsedMs: Math.round(performance.now() - started),
    sourceHashes: before,
    screenshots: run.images.map((image) => ({
      width: image.width,
      height: image.height,
    })),
    productionAuthVerified: false,
    runtimeDomValidation:
      "Covered separately by the real Browser Automation smoke",
  };
} finally {
  await session?.close();
  await rm(root, { recursive: true, force: true });
  await assert.rejects(stat(root), (error) => error.code === "ENOENT");
  await writeFile(
    join(output, "ui-storage-closeout.json"),
    JSON.stringify(
      {
        scratch: root,
        removed: true,
        ownedProcessesClosed: true,
        resultComplete: result !== undefined,
        retained:
          result === undefined
            ? "Failure log and command receipt; inspect any partial screenshots before retention"
            : "Compact UI logs, result JSON, source hashes and four screenshots",
      },
      null,
      2,
    ),
  );
}

assert.ok(result);

await writeFile(
  join(output, "ui-result.json"),
  JSON.stringify(result, null, 2),
);

console.log(
  JSON.stringify({
    passed: true,
    viewports: result.results.length,
    sourceFiles: sourceFiles.length,
    screenshots: result.screenshots.length,
  }),
);
