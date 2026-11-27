import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  getInstalledPluginRegistration,
  getPluginKvValue,
  getPluginSettingsValues,
  listPluginSchedules,
  migrate,
  setPluginKvValue,
  setPluginSettingsValues,
  upsertInstalledPlugin,
  upsertPluginSchedule,
  type DbConnection,
} from "@omnyo/db";
import type { Logger } from "@omnyo/logger";
import { openSecretVault } from "@omnyo/secret-storage";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";

const CLASSIC = "provider-acp";

const NEXT = "omnyo--provider-acp-next";

const legacySettings = {
  customAgents: JSON.stringify('[{"id":"custom"}]'),
  retained: "opaque",
};

const nextSettings = { customAgents: JSON.stringify('[{"id":"next"}]') };

describe("Classic ACP retirement before activation", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService | undefined;
  const loads: string[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "omnyo-acp-retirement-"));
    db = createConnection(join(workDir, "app.db"));
    migrate(db);
    loads.length = 0;
    vi.stubGlobal("__acpRetirementLoads", loads);

    for (const id of [CLASSIC, NEXT, "external"]) {
      const rootDir = join(workDir, id);
      await mkdir(rootDir);
      await writeFile(
        join(rootDir, "package.json"),
        JSON.stringify({
          name: `omnyo-plugin-${id}`,
          version: "0.1.0",
          type: "module",
          omnyo: {
            name: id,
            description: "ACP migration fixture",
            branding: { icon: "Zap" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(rootDir, "server.ts"),
        "export default function plugin(api) { globalThis.__acpRetirementLoads.push(api.pluginId); }\n",
      );
    }
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    db.$client.close();
    vi.unstubAllGlobals();
    await rm(workDir, { recursive: true, force: true });
  });

  function seed(
    id: string,
    enabled: boolean,
    followsDefault = false,
    external = false,
  ) {
    const name = id === NEXT ? "provider-acp-next" : id;
    const rootDir = join(workDir, id);
    upsertInstalledPlugin(db, {
      id,
      enabled,
      enabledFollowsDefault: followsDefault,
      rootDir,
      version: "0.1.0",
      source: external ? `path:${rootDir}` : `builtin:${name}`,
      provenance: external ? { kind: "direct" } : { kind: "builtin" },
      sourceIntent: external
        ? { kind: "path", canonicalPath: rootDir }
        : { kind: "builtin", name },
      exactResolution: external ? { kind: "path" } : { kind: "builtin" },
      activeArtifactId: null,
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
    });
  }

  async function start({ missingBundle = false, defaultEnabled = false } = {}) {
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: testLogger as unknown as Logger,
      dataDir: join(workDir, "data"),
      vault: await openSecretVault(join(workDir, "data")),
      appVersion: "0.46.0",
      bundledPlugins: [
        {
          name: "provider-acp-next",
          pluginId: NEXT,
          autoInstall: true,
          defaultEnabled,
          rootDir: join(workDir, missingBundle ? "missing" : NEXT),
        },
      ],
    });
    await service.start();

    return service;
  }

  it("migrates an active Classic, keeps its inputs, and respects later Next edits across startup", async () => {
    seed(CLASSIC, true);
    seed(NEXT, false, true);
    seed("external", true, false, true);
    setPluginSettingsValues(db, CLASSIC, legacySettings);
    setPluginSettingsValues(db, NEXT, nextSettings);
    setPluginKvValue(db, CLASSIC, "retained", "opaque");
    upsertPluginSchedule(db, {
      pluginId: CLASSIC,
      name: "retained",
      cron: "0 * * * *",
      nextRunAt: Date.now() + 3_600_000,
    });
    const secretDir = join(workDir, "data", "plugins", CLASSIC, "secrets");
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, "fixture"), "fixture-value");
    const classicBefore = getInstalledPluginRegistration(db, CLASSIC);
    const externalBefore = getInstalledPluginRegistration(db, "external");
    const active = await start();
    expect(getInstalledPluginRegistration(db, NEXT)).toMatchObject({
      enabled: true,
      enabledFollowsDefault: false,
    });
    expect(getPluginSettingsValues(db, NEXT)).toEqual({
      customAgents: legacySettings.customAgents,
    });
    expect(getPluginSettingsValues(db, CLASSIC)).toEqual(legacySettings);
    expect(getPluginKvValue(db, CLASSIC, "retained")).toBe("opaque");
    expect(
      listPluginSchedules(db).map((schedule) => schedule.pluginId),
    ).toEqual([CLASSIC]);
    expect(await readFile(join(secretDir, "fixture"), "utf8")).toBe(
      "fixture-value",
    );
    expect(getInstalledPluginRegistration(db, CLASSIC)).toEqual({
      ...classicBefore,
      removedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(getInstalledPluginRegistration(db, "external")).toEqual(
      externalBefore,
    );
    expect(loads).toEqual(["external", NEXT]);
    expect(active.list().map((plugin) => plugin.id)).toEqual([
      "external",
      NEXT,
    ]);
    expect(
      active
        .providerCatalog()
        .some((provider) => provider.pluginId === CLASSIC),
    ).toBe(false);
    setPluginSettingsValues(db, NEXT, nextSettings);
    await active.setEnabled(NEXT, false);
    const rowIds = [CLASSIC, NEXT, "external"];
    const rows = rowIds.map((id) => getInstalledPluginRegistration(db, id));
    await active.stop();
    db.$client.close();
    db = createConnection(join(workDir, "app.db"));
    loads.length = 0;
    await start();
    expect(rowIds.map((id) => getInstalledPluginRegistration(db, id))).toEqual(
      rows,
    );
    expect(getPluginSettingsValues(db, NEXT)).toEqual(nextSettings);
    expect(getPluginSettingsValues(db, CLASSIC)).toEqual(legacySettings);
    expect(loads).toEqual(["external"]);
  });

  it.each([
    {
      label: "active Next",
      classicEnabled: true,
      classicDefault: false,
      nextEnabled: true,
      nextDefault: false,
      enabled: true,
      settings: "next",
    },
    {
      label: "active Next recorded with a previous default",
      classicEnabled: false,
      classicDefault: true,
      nextEnabled: true,
      nextDefault: true,
      enabled: true,
      settings: "next",
    },
    {
      label: "Classic selected over explicitly disabled Next",
      classicEnabled: true,
      classicDefault: false,
      nextEnabled: false,
      nextDefault: false,
      enabled: true,
      settings: "classic",
    },
    {
      label: "explicit Classic disable",
      classicEnabled: false,
      classicDefault: false,
      nextEnabled: false,
      nextDefault: true,
      enabled: false,
      settings: "next",
    },
    {
      label: "explicit Next disable",
      classicEnabled: false,
      classicDefault: true,
      nextEnabled: false,
      nextDefault: false,
      enabled: false,
      settings: "next",
    },
    {
      label: "untouched defaults",
      classicEnabled: false,
      classicDefault: true,
      nextEnabled: false,
      nextDefault: true,
      enabled: false,
      settings: "next",
    },
  ])("preserves $label", async (fixture) => {
    seed(CLASSIC, fixture.classicEnabled, fixture.classicDefault);
    seed(NEXT, fixture.nextEnabled, fixture.nextDefault);
    setPluginSettingsValues(db, CLASSIC, legacySettings);
    setPluginSettingsValues(db, NEXT, nextSettings);
    await start();
    expect(getInstalledPluginRegistration(db, NEXT)?.enabled).toBe(
      fixture.enabled,
    );
    expect(getPluginSettingsValues(db, NEXT)).toEqual(
      fixture.settings === "classic"
        ? { customAgents: legacySettings.customAgents }
        : nextSettings,
    );
    expect(getPluginSettingsValues(db, CLASSIC)).toEqual(legacySettings);
    expect(loads).toEqual(fixture.enabled ? [NEXT] : []);
  });

  it.each([true, false])(
    "creates Next from a Classic-only installation (enabled: %s)",
    async (enabled) => {
      seed(CLASSIC, enabled);
      setPluginSettingsValues(db, CLASSIC, legacySettings);
      await start();
      expect(getInstalledPluginRegistration(db, NEXT)).toMatchObject({
        enabled,
        enabledFollowsDefault: false,
      });
      expect(getPluginSettingsValues(db, NEXT)).toEqual({
        customAgents: legacySettings.customAgents,
      });
    },
  );

  it("keeps an external plugin with the Classic ID outside the migration", async () => {
    seed(CLASSIC, true, false, true);
    setPluginSettingsValues(db, CLASSIC, legacySettings);
    const before = getInstalledPluginRegistration(db, CLASSIC);
    await start();
    expect(getInstalledPluginRegistration(db, CLASSIC)).toEqual(before);
    expect(getPluginSettingsValues(db, CLASSIC)).toEqual(legacySettings);
    expect(loads).toEqual([CLASSIC]);
  });

  it("keeps ACP opt-in on a fresh installation", async () => {
    await start();
    expect(getInstalledPluginRegistration(db, NEXT)).toMatchObject({
      enabled: false,
      enabledFollowsDefault: true,
    });
    expect(loads).toEqual([]);
  });

  it.each([false, true])(
    "uses the actual bundle default for untouched legacy rows (default: %s)",
    async (defaultEnabled) => {
      seed(CLASSIC, false, true);
      await start({ defaultEnabled });
      expect(getInstalledPluginRegistration(db, NEXT)).toMatchObject({
        enabled: defaultEnabled,
        enabledFollowsDefault: true,
      });
      expect(loads).toEqual(defaultEnabled ? [NEXT] : []);
    },
  );

  it("carries disabled Classic settings into an untouched Next registration", async () => {
    seed(CLASSIC, false);
    seed(NEXT, false, true);
    setPluginSettingsValues(db, CLASSIC, legacySettings);
    await start();
    expect(getInstalledPluginRegistration(db, NEXT)?.enabled).toBe(false);
    expect(getPluginSettingsValues(db, NEXT)).toEqual({
      customAgents: legacySettings.customAgents,
    });
  });

  it("uses Classic's effective empty agents when its active selection replaces stale Next settings", async () => {
    seed(CLASSIC, true);
    seed(NEXT, false);
    setPluginSettingsValues(db, NEXT, nextSettings);
    await start();
    expect(getPluginSettingsValues(db, NEXT)).toEqual({
      customAgents: JSON.stringify(""),
    });
  });

  it("rolls back Next registration and Classic retirement together when settings fail", async () => {
    seed(CLASSIC, true);
    setPluginSettingsValues(db, CLASSIC, legacySettings);
    const before = getInstalledPluginRegistration(db, CLASSIC);
    db.$client
      .exec(`CREATE TRIGGER reject_acp_settings BEFORE INSERT ON plugin_settings
      WHEN NEW.plugin_id = '${NEXT}' BEGIN SELECT RAISE(ABORT, 'migration fixture failure'); END`);
    await expect(start()).rejects.toThrow("migration fixture failure");
    expect(getInstalledPluginRegistration(db, CLASSIC)).toEqual(before);
    expect(getInstalledPluginRegistration(db, NEXT)).toBeUndefined();
    expect(getPluginSettingsValues(db, CLASSIC)).toEqual(legacySettings);
    expect(loads).toEqual([]);
  });

  it("fails before retiring Classic when Next is unavailable", async () => {
    seed(CLASSIC, true);
    const before = getInstalledPluginRegistration(db, CLASSIC);
    await expect(start({ missingBundle: true })).rejects.toThrow();
    expect(getInstalledPluginRegistration(db, CLASSIC)).toEqual(before);
    expect(loads).toEqual([]);
  });
});
