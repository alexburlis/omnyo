import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, test } from "vitest";
import type { MaintenanceStatus } from "@omnyo/server-contract";
import { registerOriginAdoptionStaticRoutesV1 } from "../../src/server.js";
import { createOriginAdoptionV1 } from "../../src/services/maintenance/origin-adoption-v1.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-neutral-assets-")),
  );

  const dataDir = join(root, "private");
  const bundle = join(root, "bundle");
  await Promise.all([
    mkdir(dataDir, { mode: 0o700 }),
    mkdir(join(bundle, "assets"), { recursive: true }),
  ]);

  const status: MaintenanceStatus = {
    contractVersion: 1,
    privateUpdateManifestSchema: 2,
    runtime: {
      runtimeId: "control-runtime",
      processId: process.pid,
      parentProcessId: process.ppid,
      launchId: "control-launch",
      dataDir,
      serverHostId: "host-original",
      appVersion: "0.46.242+private.1",
      protocolVersion: 253,
    },
    hold: {
      version: 1,
      id: "selected-hold",
      ownerId: "owner",
      kind: "desktop-update",
      phase: "held",
      serverHostId: "host-original",
      createdAt: Date.now(),
      artifact: null,
    },
    activity: {
      runningThreads: 0,
      pendingInteractions: 0,
      hostRpcs: 0,
      provisioning: 0,
      queuedDispatches: 0,
      pluginLoads: 0,
      pluginInvocations: 0,
      hungServices: 0,
    },
  };

  const selected = [
    {
      file: "origin-adoption-v1.html",
      path: "/origin-adoption-v1.html",
      value:
        '<!doctype html><script type="module" src="/origin-adoption-v1/assets/entry-abcd1234.js"></script>',
    },
    {
      file: "assets/entry-abcd1234.js",
      path: "/origin-adoption-v1/assets/entry-abcd1234.js",
      value: 'document.title="neutral";',
    },
  ];

  await Promise.all(
    selected.map((value) => writeFile(join(bundle, value.file), value.value)),
  );
  await writeFile(
    join(bundle, "manifest.json"),
    JSON.stringify({
      version: 1,
      files: selected.map((value) => ({
        file: value.file,
        path: value.path,
        bytes: Buffer.byteLength(value.value),
        sha256: createHash("sha256").update(value.value).digest("hex"),
      })),
    }),
  );

  const owner = createOriginAdoptionV1({
    dataDir,
    status: () => status,
    assetPaths: async () => selected.map((value) => value.path),
  });

  const ticket = {
    version: 1,
    adoptionId: "selected-hold",
    id: "a".repeat(64),
    selectedIds: ["a".repeat(64)],
    nonce: "b".repeat(64),
    fromOrigin: "https://bb.alexburlis.com",
    toOrigin: "https://app.omnyohq.com",
  };

  await owner.prepare({
    ticket,
    holdId: "selected-hold",
    ownerId: "owner",
    expectedRuntimeId: "control-runtime",
    expectedServerHostId: "host-original",
  });
  const app = new Hono();
  registerOriginAdoptionStaticRoutesV1(app, owner, bundle);
  let ordinaryFallbacks = 0;
  app.get("*", (context) => {
    ordinaryFallbacks++;

    return context.text("ordinary", 418);
  });

  const request = (path: string, host = "app.omnyohq.com") =>
    app.request("https://" + host + path, { headers: { host } });

  return {
    root,
    bundle,
    status,
    selected,
    request,
    ordinaryFallbacks: () => ordinaryFallbacks,
    cleanup: () => rm(root, { recursive: true }),
  };
}

test("serves only the sealed neutral page and manifest-listed bytes under the actual held old-peer owner", async () => {
  const f = await fixture();

  try {
    for (const selected of f.selected) {
      const response = await f.request(selected.path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(selected.value);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    for (const path of [
      "/origin-adoption-v1/assets/unlisted-abcd1234.js",
      "/origin-adoption-v1/assets/entry%2Fescape.js",
    ])
      expect((await f.request(path)).status).toBe(403);
    expect(
      (await f.request(f.selected[0].path, "foreign.invalid")).status,
    ).toBe(403);
    expect(f.ordinaryFallbacks()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("refuses changed bundle bytes and stale runtime ownership before ordinary entry", async () => {
  const f = await fixture();

  try {
    await writeFile(join(f.bundle, f.selected[1].file), "changed bytes");
    expect((await f.request(f.selected[1].path)).status).toBe(409);
    f.status.runtime.runtimeId = "different-runtime";
    expect((await f.request(f.selected[0].path)).status).toBe(403);
    expect(f.ordinaryFallbacks()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
