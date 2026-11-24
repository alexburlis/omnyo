import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  getInstalledPluginRegistration,
  getPluginSettingsValues,
  migrate,
  setPluginSettingsValues,
  upsertInstalledPlugin,
  type DbConnection,
} from "@omnyo/db";
import type { Logger } from "@omnyo/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";
import { openSecretVault } from "@omnyo/secret-storage";

const names = ["composer-predictions", "account-usage"] as const;

const loads = globalThis as typeof globalThis & {
  __privateBuiltinLoads?: string[];
};

describe("private builtin migration before plugin activation", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService | undefined;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "omnyo-private-migration-"));
    vi.stubGlobal("__privateBuiltinLoads", []);

    for (const id of names.flatMap((name) => [name, `omnyo--${name}`])) {
      const root = join(workDir, id);
      await mkdir(root);
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: `omnyo-plugin-${id}`,
          version: "0.1.0",
          type: "module",
          omnyo: {
            name: id,
            description: "Private migration fixture",
            branding: { icon: "ChartColumn" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(root, "server.ts"),
        `export default function plugin(api) { globalThis.__privateBuiltinLoads.push(api.pluginId); }\n`,
      );
    }
  });

  afterEach(async () => {
    await service?.stop();
    db.$client.close();
    vi.unstubAllGlobals();
    await rm(workDir, { recursive: true, force: true });
  });

  function seed(id: string, enabled: boolean, builtin = false) {
    const name = id.replace(/^omnyo--/, "");
    const rootDir = join(workDir, id);
    upsertInstalledPlugin(db, {
      id,
      enabled,
      enabledFollowsDefault: false,
      rootDir,
      version: "0.1.0",
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      source: builtin ? `builtin:${name}` : `path:${rootDir}`,
      provenance: builtin ? { kind: "builtin" } : { kind: "direct" },
      sourceIntent: builtin
        ? { kind: "builtin", name }
        : { kind: "path", canonicalPath: rootDir },
      exactResolution: builtin ? { kind: "builtin" } : { kind: "path" },
    });
  }

  async function makeService(missingComposer = false) {
    return createPluginService({
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
      bundledPlugins: names.map((name) => ({
        name,
        pluginId: `omnyo--${name}`,
        autoInstall: true,
        defaultEnabled: true,
        rootDir:
          missingComposer && name === "composer-predictions"
            ? join(workDir, "missing")
            : join(workDir, `omnyo--${name}`),
      })),
    });
  }

  it("preserves disabled intent and settings, disables both old IDs, and changes nothing on second startup", async () => {
    seed("composer-predictions", false);
    seed("account-usage", true);

    const settings = {
      enabled: "false",
      cliPath: JSON.stringify("/tools/custom-codex"),
    };

    setPluginSettingsValues(db, "composer-predictions", settings);
    service = await makeService();
    await service.start();
    expect(
      getInstalledPluginRegistration(db, "composer-predictions")?.enabled,
    ).toBe(false);
    expect(getInstalledPluginRegistration(db, "account-usage")?.enabled).toBe(
      false,
    );
    expect(
      getInstalledPluginRegistration(db, "omnyo--composer-predictions"),
    ).toMatchObject({ enabled: false, enabledFollowsDefault: false });
    expect(getPluginSettingsValues(db, "omnyo--composer-predictions")).toEqual(
      settings,
    );
    expect(loads.__privateBuiltinLoads).toEqual(["omnyo--account-usage"]);

    const before = names
      .flatMap((name) => [name, `omnyo--${name}`])
      .map((id) => getInstalledPluginRegistration(db, id));

    await service.stop();
    loads.__privateBuiltinLoads = [];
    service = await makeService();
    await service.start();
    expect(
      names
        .flatMap((name) => [name, `omnyo--${name}`])
        .map((id) => getInstalledPluginRegistration(db, id)),
    ).toEqual(before);
    expect(getPluginSettingsValues(db, "omnyo--composer-predictions")).toEqual(
      settings,
    );
    expect(loads.__privateBuiltinLoads).toEqual(["omnyo--account-usage"]);
  });

  it("preserves an existing downstream choice instead of overwriting it from the old ID", async () => {
    seed("composer-predictions", true);
    seed("omnyo--composer-predictions", false, true);
    setPluginSettingsValues(db, "composer-predictions", {
      enabled: "true",
      cliPath: JSON.stringify("/old/codex"),
    });

    const chosen = {
      enabled: "false",
      cliPath: JSON.stringify("/chosen/codex"),
    };

    setPluginSettingsValues(db, "omnyo--composer-predictions", chosen);
    service = await makeService();
    await service.start();
    expect(
      getInstalledPluginRegistration(db, "composer-predictions")?.enabled,
    ).toBe(false);
    expect(
      getInstalledPluginRegistration(db, "omnyo--composer-predictions")
        ?.enabled,
    ).toBe(false);
    expect(getPluginSettingsValues(db, "omnyo--composer-predictions")).toEqual(
      chosen,
    );
    expect(loads.__privateBuiltinLoads).not.toContain("composer-predictions");
    expect(loads.__privateBuiltinLoads).not.toContain(
      "omnyo--composer-predictions",
    );
  });

  it("rolls back registration and keeps the standalone enabled if settings migration fails", async () => {
    seed("composer-predictions", true);
    setPluginSettingsValues(db, "composer-predictions", { enabled: "false" });
    db.$client
      .exec(`CREATE TRIGGER reject_private_settings BEFORE INSERT ON plugin_settings
      WHEN NEW.plugin_id = 'omnyo--composer-predictions'
      BEGIN SELECT RAISE(ABORT, 'migration fixture failure'); END`);
    service = await makeService();
    await expect(service.start()).rejects.toThrow("migration fixture failure");
    expect(
      getInstalledPluginRegistration(db, "composer-predictions")?.enabled,
    ).toBe(true);
    expect(
      getInstalledPluginRegistration(db, "omnyo--composer-predictions"),
    ).toBeUndefined();
    expect(loads.__privateBuiltinLoads).toEqual([]);
  });

  it("leaves the standalone enabled when its bundled replacement is unavailable", async () => {
    seed("composer-predictions", true);
    service = await makeService(true);
    await service.start();
    expect(
      getInstalledPluginRegistration(db, "composer-predictions")?.enabled,
    ).toBe(true);
    expect(
      getInstalledPluginRegistration(db, "omnyo--composer-predictions"),
    ).toBeUndefined();
    expect(loads.__privateBuiltinLoads).toContain("composer-predictions");
  });
});
