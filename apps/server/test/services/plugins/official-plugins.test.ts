import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  getInstalledPluginRegistration,
  getPluginSettingsValues,
  migrate,
  setPluginSettingsValues,
  type DbConnection,
} from "@omnyo/db";
import type { Logger } from "@omnyo/logger";
import { derivePluginId } from "@omnyo/domain";
import { registerPluginRoutes } from "../../../src/routes/plugins.js";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { createPluginInstallJobs } from "../../../src/services/plugins/plugin-install-jobs.js";
import { createPluginUpdateJobs } from "../../../src/services/plugins/plugin-update-jobs.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  BUNDLED_PLUGINS,
  listBundledPluginRegistrations,
  type BundledPluginRegistration,
} from "../../../src/services/plugins/builtin-registry.js";
import { readPluginManifest } from "../../../src/services/plugins/manifest.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { openSecretVault } from "@omnyo/secret-storage";

const logger = testLogger as unknown as Logger;

const testDir = dirname(fileURLToPath(import.meta.url));

const fixtureRoot = resolve(
  testDir,
  "..",
  "..",
  "fixtures",
  "plugins",
  "omnyo-plugin-builtin-fixture",
);

const globals = globalThis as Record<string, unknown>;

function loadCount(): number {
  return (globals.__builtinFixtureLoads as number | undefined) ?? 0;
}

function officialEntry(
  overrides: Partial<BundledPluginRegistration> = {},
): BundledPluginRegistration {
  return {
    name: "fixture",
    pluginId: "builtin-fixture",
    autoInstall: false,
    defaultEnabled: true,
    rootDir: fixtureRoot,
    ...overrides,
  };
}

async function createService(args: {
  dataDir: string;
  db: DbConnection;
  bundled: BundledPluginRegistration[];
}): Promise<PluginService> {
  return createPluginService({
    aiServices: createAiServiceRegistry(),
    telemetry: createNoopTelemetryService(),
    db: args.db,
    hub: {
      getDaemonSessionIdForHost: () => null,
      notifyPluginSignal: () => 0,
      notifySystem: () => {},
    },
    logger,
    dataDir: args.dataDir,
    vault: await openSecretVault(args.dataDir),
    appVersion: "0.9.0",
    bundledPlugins: args.bundled,
    loadTimeoutMs: 2000,
  });
}

function createRoutes(db: DbConnection, service: PluginService): Hono {
  const app = new Hono();
  registerPluginRoutes(
    app,
    { config: { serverPort: 3334 }, db, hub: { notifyThread: () => {} } },
    service,
    createPluginInstallJobs({ notifyChanged: () => {} }),
    createPluginUpdateJobs({ notifyChanged: () => {} }),
  );

  return app;
}

describe("official plugin registry invariants", () => {
  it("declares the plugin id each bundled manifest actually derives", async () => {
    for (const registration of listBundledPluginRegistrations()) {
      const manifest = await readPluginManifest(registration.rootDir);
      expect(derivePluginId(manifest.packageName), registration.name).toBe(
        registration.pluginId,
      );
    }
  });

  it("uses one unique bundled name for each plugin", () => {
    expect(new Set(BUNDLED_PLUGINS.map((plugin) => plugin.name)).size).toBe(
      BUNDLED_PLUGINS.length,
    );
  });
});

describe("store-installed official plugins", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService | undefined;

  beforeEach(async () => {
    delete globals.__builtinFixtureLoads;
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "omnyo-community-plugins-"));
  });

  afterEach(async () => {
    await service?.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("does not auto-install a bundled official plugin at startup", async () => {
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();

    expect(service.list()).toEqual([]);
    expect(loadCount()).toBe(0);
  });

  it("installs on demand with catalog provenance and survives reconcile", async () => {
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();

    const entry = await service.installOfficialPlugin("fixture");
    expect(entry).toMatchObject({
      id: "builtin-fixture",
      source: "builtin:fixture",
      provenance: "catalog",
      catalogEntryId: "fixture",
      status: "running",
    });
    expect(getInstalledPluginRegistration(db, "builtin-fixture")).toMatchObject(
      {
        provenance: "catalog",
        catalogEntryId: "fixture",
        sourceKind: "builtin",
        sourceBuiltinName: "fixture",
      },
    );

    await service.stop();
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", provenance: "catalog", status: "running" },
    ]);
  });

  it("keeps a removed official plugin uninstalled across restarts", async () => {
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();
    await service.installOfficialPlugin("fixture");

    await expect(service.remove("builtin-fixture")).resolves.toBe(true);
    expect(service.list()).toEqual([]);
    await service.stop();

    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();
    expect(service.list()).toEqual([]);

    await expect(
      service.installOfficialPlugin("fixture"),
    ).resolves.toMatchObject({ id: "builtin-fixture", status: "running" });
  });

  it("keeps an installed plugin while moving it from included to optional", async () => {
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry({ autoInstall: true })],
    });
    await service.start();
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", provenance: "builtin" },
    ]);
    await service.stop();

    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry({ autoInstall: false })],
    });
    await service.start();
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", provenance: "catalog" },
    ]);
  });

  it("explicitly installs a missing included plugin with its builtin provenance", async () => {
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry({ autoInstall: true, defaultEnabled: false })],
    });
    expect(service.list()).toEqual([]);

    await expect(
      service.installOfficialPlugin("fixture"),
    ).resolves.toMatchObject({
      id: "builtin-fixture",
      source: "builtin:fixture",
      provenance: "builtin",
      enabled: true,
      status: "running",
    });
    await service.start();
    expect(service.list()).toMatchObject([
      {
        id: "builtin-fixture",
        provenance: "builtin",
        enabled: true,
        status: "running",
      },
    ]);
  });

  it("rejects unknown official plugin names", async () => {
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await expect(service.installOfficialPlugin("missing")).rejects.toThrow(
      'unknown official plugin "missing"',
    );
  });
});

describe("removing bundled plugins", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService | undefined;

  beforeEach(async () => {
    delete globals.__builtinFixtureLoads;
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "omnyo-bundled-removal-"));
  });

  afterEach(async () => {
    await service?.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  async function startWith(entry: BundledPluginRegistration): Promise<{
    service: PluginService;
    app: Hono;
  }> {
    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [entry],
    });
    await service.start();

    return { service, app: createRoutes(db, service) };
  }

  it("refuses to remove an included core plugin and keeps it running", async () => {
    const started = await startWith(officialEntry({ autoInstall: true }));
    setPluginSettingsValues(db, "builtin-fixture", { retained: "value" });

    const response = await started.app.request("/plugins/builtin-fixture", {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error:
        '"builtin-fixture" is part of Omnyo core, so it can be disabled but not removed.',
    });
    expect(
      getInstalledPluginRegistration(db, "builtin-fixture")?.removedAt,
    ).toBeNull();
    expect(getPluginSettingsValues(db, "builtin-fixture")).toEqual({
      retained: "value",
    });
    expect(started.service.list()).toMatchObject([
      { id: "builtin-fixture", status: "running", removable: false },
    ]);
  });

  it("keeps the unknown-plugin response for an id that is not installed", async () => {
    const started = await startWith(officialEntry({ autoInstall: true }));

    const response = await started.app.request("/plugins/missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unknown plugin",
    });
  });

  it("refuses to remove a core plugin that was first installed from the store", async () => {
    const storeOnly = await startWith(officialEntry());
    await storeOnly.service.installOfficialPlugin("fixture");
    await storeOnly.service.stop();

    const started = await startWith(officialEntry({ autoInstall: true }));

    expect(started.service.list()).toMatchObject([
      { id: "builtin-fixture", provenance: "catalog", removable: false },
    ]);

    const response = await started.app.request("/plugins/builtin-fixture", {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(
      getInstalledPluginRegistration(db, "builtin-fixture")?.removedAt,
    ).toBeNull();
  });

  it("lists an orphaned builtin row as not removable", async () => {
    const started = await startWith(officialEntry({ autoInstall: true }));
    await started.service.stop();

    service = await createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [],
    });

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", isOrphanedBuiltin: true, removable: false },
    ]);
    expect(service.removalRefusal("builtin-fixture")).toBe(
      '"builtin-fixture" is part of Omnyo core, so it can be disabled but not removed.',
    );
  });
});
