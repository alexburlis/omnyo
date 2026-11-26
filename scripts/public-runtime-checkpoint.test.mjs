import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preparePublicRuntime } from "./public-runtime-checkpoint.mjs";

const sourceCommit = "a".repeat(40);

const identity = { sourceCommit, version: "1.0.183", protocolVersion: 268 };

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

const bundledVerifier = build({
  entryPoints: [
    join(repository, "packages/server-archive/src/runtime-identity.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
}).then((result) => result.outputFiles[0].contents);

async function fixture(
  t,
  html = `<html><head><meta name="omnyo-web-source" content="${sourceCommit}"></head></html>`,
) {
  const scratch = join(homedir(), "scratch/omnyo");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "codex-runtime-checkpoint-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "packages/omnyo-app");

  for (const path of ["dist", "app/dist", "server/dist", "host-daemon/dist"])
    await mkdir(join(packageRoot, path), { recursive: true });

  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "omnyo-app",
      version: identity.version,
      type: "module",
    }),
  );
  await writeFile(
    join(packageRoot, "dist/runtime-identity-verifier.js"),
    await bundledVerifier,
  );
  await writeFile(
    join(packageRoot, "server/dist/index.js"),
    "export default 1;\n",
  );
  await writeFile(join(packageRoot, "app/dist/index.html"), html);

  const verifier = await import(
    pathToFileURL(join(packageRoot, "dist/runtime-identity-verifier.js")).href
  );

  const runtime = await verifier.createRuntimeIdentity(packageRoot, {
    runtimeVersion: identity.version,
    hostDaemonProtocolVersion: identity.protocolVersion,
  });

  await writeFile(
    join(packageRoot, "dist/runtime-identity.json"),
    JSON.stringify(runtime),
  );

  return {
    root,
    packageRoot,
    runtime,
    verifier,
    outputDirectory: join(root, "out"),
  };
}

test("freezes the verified inventory without dependencies and survives later workspace changes", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.packageRoot, "node_modules"));
  await writeFile(
    join(f.packageRoot, "node_modules/private-data"),
    "not runtime",
  );
  const receipt = await preparePublicRuntime({ ...f, identity });

  assert.deepEqual(receipt, {
    schema: 1,
    ...identity,
    runtimeSha256: f.runtime.runtimeSha256,
    runtimePath: "runtime",
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(join(f.outputDirectory, "runtime-prepared.json")),
    ),
    receipt,
  );
  assert.deepEqual((await readdir(join(f.outputDirectory, "runtime"))).sort(), [
    "app",
    "dist",
    "host-daemon",
    "package.json",
    "server",
  ]);
  await writeFile(
    join(f.packageRoot, "server/dist/index.js"),
    "changed source\n",
  );
  await f.verifier.verifyRuntimeIdentity(
    join(f.outputDirectory, "runtime"),
    f.runtime,
  );
  assert.equal(
    await readFile(
      join(f.outputDirectory, "runtime/server/dist/index.js"),
      "utf8",
    ),
    "export default 1;\n",
  );
  await assert.rejects(
    preparePublicRuntime({ ...f, identity }),
    /digest mismatch/u,
  );
});

test("refuses release source, version or protocol mismatches before writing a receipt", async (t) => {
  const f = await fixture(t);

  for (const changed of [
    { sourceCommit: "b".repeat(40) },
    { version: "1.0.184" },
    { protocolVersion: 269 },
  ])
    await assert.rejects(
      preparePublicRuntime({ ...f, identity: { ...identity, ...changed } }),
      /differs from the selected release/u,
    );

  await assert.rejects(
    readFile(join(f.outputDirectory, "runtime-prepared.json")),
    {
      code: "ENOENT",
    },
  );
});

test("requires exactly one valid public source marker", async (t) => {
  const marker = `<meta name="omnyo-web-source" content="${sourceCommit}">`;

  for (const html of [
    "<html></html>",
    marker + marker,
    marker.replace(sourceCommit, "unknown"),
  ]) {
    const f = await fixture(t, html);
    await assert.rejects(
      preparePublicRuntime({ ...f, identity }),
      /differs from the selected release/u,
    );
    await assert.rejects(
      readFile(join(f.outputDirectory, "runtime-prepared.json")),
      {
        code: "ENOENT",
      },
    );
  }
});

test("refuses changed inventory, symlinks and an occupied snapshot destination", async (t) => {
  const f = await fixture(t);
  await mkdir(f.outputDirectory);
  await mkdir(join(f.outputDirectory, "runtime"));
  await writeFile(join(f.outputDirectory, "runtime/foreign"), "keep");
  await assert.rejects(preparePublicRuntime({ ...f, identity }), {
    code: "EEXIST",
  });
  assert.equal(
    await readFile(join(f.outputDirectory, "runtime/foreign"), "utf8"),
    "keep",
  );
  await symlink("index.js", join(f.packageRoot, "server/dist/linked.js"));
  await assert.rejects(preparePublicRuntime({ ...f, identity }), /symlink/u);
});

test("refuses output inside the runtime package", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    preparePublicRuntime({ ...f, outputDirectory: f.packageRoot, identity }),
    /outside the package/u,
  );
  await assert.rejects(
    preparePublicRuntime({
      ...f,
      outputDirectory: join(f.packageRoot, "new-output"),
      identity,
    }),
    /outside the package/u,
  );
  await assert.rejects(readdir(join(f.packageRoot, "new-output")), {
    code: "ENOENT",
  });
});

test("keeps an existing receipt and removes only its rejected snapshot", async (t) => {
  const f = await fixture(t);
  await mkdir(f.outputDirectory);
  const receiptPath = join(f.outputDirectory, "runtime-prepared.json");
  await writeFile(receiptPath, "existing receipt\n");
  await assert.rejects(preparePublicRuntime({ ...f, identity }), {
    code: "EEXIST",
  });
  assert.equal(await readFile(receiptPath, "utf8"), "existing receipt\n");
  assert.deepEqual(await readdir(f.outputDirectory), ["runtime-prepared.json"]);
});
