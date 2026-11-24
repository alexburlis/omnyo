import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createConnection,
  createPluginArtifact,
  migrate,
  upsertInstalledPlugin,
} from "@omnyo/db";
import {
  readBundledPluginName,
  readPrivateDeliverySnapshot,
  verifyPrivateDeliveryApproval,
} from "../../src/services/system/private-delivery-guard.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(inventoryName = ".omnyo-builtin-files.json") {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-delivery-guard-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const db = createConnection(":memory:");
  migrate(db);
  cleanups.push(async () => {
    db.$client.close();
  });
  const rootDir = join(dataDir, "plugins", "cache", "builtin", "artifact");

  const inventory =
    '[{"path":"dist/server.js","sha256":"' + "f".repeat(64) + '"}]';

  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, inventoryName), inventory);
  createPluginArtifact(db, {
    id: "artifact",
    pluginId: "fixture",
    sourceKind: "builtin",
    npmResolvedVersion: null,
    gitResolvedCommit: null,
    gitCheckoutRoot: null,
    bundledRootDir: join(dataDir, "packaged"),
    path: rootDir,
    integrity: createHash("sha256").update(inventory).digest("hex"),
    contentHash: createHash("sha256").update(inventory).digest("hex"),
    validationResult: "valid",
    validatedAt: Date.now(),
  });
  upsertInstalledPlugin(db, {
    id: "fixture",
    source: "builtin:fixture",
    provenance: { kind: "builtin" },
    sourceIntent: { kind: "builtin", name: "fixture" },
    exactResolution: { kind: "builtin" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    enabledFollowsDefault: false,
    rootDir,
    activeArtifactId: "artifact",
    version: "1.0.0",
    enabled: false,
  });

  const manifest = {
    version: "0.46.244+private.1",
    sourceCommit: "b".repeat(40),
    runtimeSha256: "c".repeat(64),
  };

  const guard = {
    snapshot: () => readPrivateDeliverySnapshot({ dataDir, db }),
    bundledName: async (pluginId: string) =>
      readBundledPluginName({ db, pluginId }),
    flush: async () => undefined,
  };

  const snapshot = await guard.snapshot();
  const approval = { schema: 1, ...manifest, snapshot };
  const path = join(dataDir, "private-server-update", "approved-delivery.json");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(approval));

  return { dataDir, db, rootDir, inventory, manifest, guard, approval, path };
}

it("binds disabled managed builtin fixes to their actual inventory bytes", async () => {
  const f = await fixture();
  expect(await f.guard.snapshot()).toEqual({
    webStateSha256: null,
    bundledPlugins: [
      {
        id: "fixture",
        rootDir: f.rootDir,
        inventorySha256: createHash("sha256").update(f.inventory).digest("hex"),
      },
    ],
  });
  expect(await verifyPrivateDeliveryApproval(f)).toEqual(f.approval);
  await writeFile(
    join(f.rootDir, ".omnyo-builtin-files.json"),
    "changed inventory",
  );
  await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow("inventory");
});

it("rejects replacement approval instead of adopting a newer snapshot for a held runtime", async () => {
  const f = await fixture();
  const expected = await verifyPrivateDeliveryApproval(f);
  await mkdir(join(f.dataDir, "private-web-updates"));
  await writeFile(
    join(f.dataDir, "private-web-updates", "active.json"),
    "new web bytes",
  );
  await writeFile(
    f.path,
    JSON.stringify({ ...f.approval, snapshot: await f.guard.snapshot() }),
  );
  await expect(
    verifyPrivateDeliveryApproval({ ...f, expected }),
  ).rejects.toThrow("approval changed");
});

it("accepts an untagged 1.x approval and refuses a malformed version", async () => {
  const f = await fixture();
  const manifest = { ...f.manifest, version: "1.0.1" };
  const approval = { ...f.approval, version: "1.0.1" };
  await writeFile(f.path, JSON.stringify(approval));
  expect(await verifyPrivateDeliveryApproval({ ...f, manifest })).toEqual(
    approval,
  );
  await writeFile(f.path, JSON.stringify({ ...approval, version: "1.0" }));
  await expect(
    verifyPrivateDeliveryApproval({
      ...f,
      manifest: { ...manifest, version: "1.0" },
    }),
  ).rejects.toThrow("no valid delivery approval");
});

it("refuses missing or misbound approval before reading a runtime as safe", async () => {
  const f = await fixture();
  await expect(
    verifyPrivateDeliveryApproval({
      ...f,
      manifest: { ...f.manifest, sourceCommit: "d".repeat(40) },
    }),
  ).rejects.toThrow("approval changed");
  await rm(f.path);
  await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow(
    "no valid delivery approval",
  );
});

it("reads canonical managed inventory bytes without replacing its artifact binding", async () => {
  const f = await fixture(".omnyo-builtin-files.json");
  expect(await verifyPrivateDeliveryApproval(f)).toEqual(f.approval);
  expect(
    await readFile(join(f.rootDir, ".omnyo-builtin-files.json"), "utf8"),
  ).toBe(f.inventory);
  await expect(
    readFile(join(f.rootDir, ".bb-builtin-files.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([".omnyo-builtin-files.json", ".bb-builtin-files.json"])(
  "refuses dual or malformed inventories for managed %s input",
  async (name) => {
    const f = await fixture(name);

    const other =
      name === ".omnyo-builtin-files.json"
        ? ".bb-builtin-files.json"
        : ".omnyo-builtin-files.json";

    await writeFile(join(f.rootDir, other), f.inventory);
    await expect(f.guard.snapshot()).rejects.toThrow(
      "Ambiguous bundled plugin inventories",
    );
    await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow(
      "Ambiguous bundled plugin inventories",
    );
    expect(await readFile(join(f.rootDir, name), "utf8")).toBe(f.inventory);
    await rm(join(f.rootDir, other));

    for (const raw of [
      "{",
      "[]",
      JSON.stringify([{ path: "../escape", sha256: "f".repeat(64) }]),
      JSON.stringify([
        { path: "dist/server.js", sha256: "f".repeat(64), extra: true },
      ]),
    ]) {
      await writeFile(join(f.rootDir, name), raw);
      await expect(f.guard.snapshot()).rejects.toThrow(
        "Invalid bundled plugin inventory",
      );
    }

    await writeFile(join(f.rootDir, name), f.inventory + " ");
    await expect(f.guard.snapshot()).rejects.toThrow(
      "inventory digest differs",
    );
  },
);

async function replaceOverride(
  f: Awaited<ReturnType<typeof fixture>>,
  stagedBytes: string,
) {
  const serverBytes = "export default 2;\n";
  const rootDir = join(f.dataDir, "plugins", "cache", "builtin", "next");

  const inventory = JSON.stringify([
    {
      path: "dist/server.js",
      sha256: createHash("sha256").update(serverBytes).digest("hex"),
    },
  ]);

  await mkdir(join(rootDir, "dist"), { recursive: true });
  await writeFile(join(rootDir, "dist", "server.js"), serverBytes);
  await writeFile(join(rootDir, ".omnyo-builtin-files.json"), inventory);
  createPluginArtifact(f.db, {
    id: "next",
    pluginId: "fixture",
    sourceKind: "builtin",
    npmResolvedVersion: null,
    gitResolvedCommit: null,
    gitCheckoutRoot: null,
    bundledRootDir: join(f.dataDir, "packaged"),
    path: rootDir,
    integrity: createHash("sha256").update(inventory).digest("hex"),
    contentHash: createHash("sha256").update(inventory).digest("hex"),
    validationResult: "valid",
    validatedAt: Date.now(),
  });
  upsertInstalledPlugin(f.db, {
    id: "fixture",
    source: "builtin:fixture",
    provenance: { kind: "builtin" },
    sourceIntent: { kind: "builtin", name: "fixture" },
    exactResolution: { kind: "builtin" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    enabledFollowsDefault: false,
    rootDir,
    activeArtifactId: "next",
    version: "1.0.1",
    enabled: false,
  });

  const staged = join(
    f.dataDir,
    "app-versions",
    f.manifest.version,
    "node_modules",
    "omnyo-app",
    "server",
    "dist",
    "builtin-plugins",
    "fixture",
    "dist",
  );

  await mkdir(staged, { recursive: true });
  await writeFile(join(staged, "server.js"), stagedBytes);
}

it("installs when a later bundled plugin fix is already in the staged runtime", async () => {
  const f = await fixture();
  await replaceOverride(f, "export default 2;\n");
  expect(await verifyPrivateDeliveryApproval(f)).toEqual(f.approval);
});

it("names a later bundled plugin fix that the staged runtime lacks", async () => {
  const f = await fixture();
  await replaceOverride(f, "export default 1;\n");
  await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow(
    "Bundled plugin fixes for fixture changed after this runtime was verified and are not in it",
  );
});

it("still refuses a runtime after the active web interface changed", async () => {
  const f = await fixture();
  await mkdir(join(f.dataDir, "private-web-updates"));
  await writeFile(
    join(f.dataDir, "private-web-updates", "active.json"),
    "new web bytes",
  );
  await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow(
    "The active web interface changed after this runtime was verified",
  );
});

async function regenerateWeb(
  f: Awaited<ReturnType<typeof fixture>>,
  stagedAsset: string,
) {
  const checksum = (text: string) =>
    createHash("sha256").update(text).digest("hex");

  const descriptor = (sourceCommit: string, asset: string) => ({
    schema: 1,
    sourceCommit,
    compatibilityHash: "a".repeat(64),
    files: [
      { path: "index.html", size: asset.length, sha256: checksum(asset) },
    ],
  });

  const received = descriptor("d".repeat(40), "updated shell");
  const generationId = checksum(JSON.stringify(received));
  const webRoot = join(f.dataDir, "private-web-updates");
  const generation = join(webRoot, "generations", generationId);

  const staged = join(
    f.dataDir,
    "app-versions",
    f.manifest.version,
    "node_modules",
    "omnyo-app",
  );

  const stagedWeb = join(staged, "app", "dist");

  await Promise.all([
    mkdir(generation, { recursive: true }),
    mkdir(stagedWeb, { recursive: true }),
    mkdir(join(staged, "dist"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(generation, "web-build.json"), JSON.stringify(received)),
    writeFile(join(generation, "index.html"), "updated shell"),
    writeFile(
      join(webRoot, "active.json"),
      JSON.stringify({
        baselineId: "e".repeat(64),
        compatibilityHash: received.compatibilityHash,
        active: { id: generationId, sourceCommit: received.sourceCommit },
        previous: null,
      }),
    ),
    writeFile(
      join(stagedWeb, "web-build.json"),
      JSON.stringify(descriptor(f.manifest.sourceCommit, stagedAsset)),
    ),
    writeFile(join(stagedWeb, "index.html"), stagedAsset),
    writeFile(
      join(staged, "dist", "runtime-identity.json"),
      JSON.stringify({
        runtimeSha256: f.manifest.runtimeSha256,
      }),
    ),
  ]);

  return { generation, stagedWeb };
}

it("keeps a verified runtime offer when a later active generation has identical web assets", async () => {
  const f = await fixture();
  const heldApproval = await verifyPrivateDeliveryApproval(f);

  await regenerateWeb(f, "updated shell");

  await expect(
    verifyPrivateDeliveryApproval({ ...f, expected: heldApproval }),
  ).resolves.toEqual(f.approval);
});

it("keeps blocking a runtime offer that would overwrite changed web assets", async () => {
  const f = await fixture();

  await regenerateWeb(f, "older shell");

  await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow(
    "The active web interface changed after this runtime was verified",
  );
});

it("requires the active generation's recorded descriptor and matching runtime compatibility", async () => {
  const f = await fixture();
  const { stagedWeb, generation } = await regenerateWeb(f, "updated shell");
  const file = join(stagedWeb, "web-build.json");
  const descriptor = JSON.parse(await readFile(file, "utf8"));

  await writeFile(
    file,
    JSON.stringify({ ...descriptor, compatibilityHash: "f".repeat(64) }),
  );
  await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow(
    "active web interface changed",
  );

  await writeFile(file, JSON.stringify(descriptor));
  await writeFile(
    join(generation, "web-build.json"),
    JSON.stringify(descriptor),
  );
  await expect(verifyPrivateDeliveryApproval(f)).rejects.toThrow(
    "active web interface changed",
  );
});
