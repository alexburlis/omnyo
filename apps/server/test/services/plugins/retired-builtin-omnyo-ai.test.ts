import { join } from "node:path";
import {
  createPluginArtifact,
  getAiServiceSelections,
  getInstalledPluginRegistration,
  getPluginArtifact,
  getPluginKvValue,
  getPluginSettingsValues,
  listInstalledPlugins,
  setAiServiceSelection,
  setPluginKvValue,
  setPluginSettingsValues,
  upsertInstalledPlugin,
} from "@omnyo/db";
import { systemAiServicesResponseSchema } from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { runTextAiTask } from "../../../src/services/ai/ai-tasks.js";
import { listBundledPluginRegistrations } from "../../../src/services/plugins/builtin-registry.js";
import { readJson } from "../../helpers/json.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const RETIRED_ID = "omnyo-ai";

const ARTIFACT_ID = `identity_v1_${"4f".repeat(32)}`;

function seedLiveRetiredRow(harness: TestAppHarness, enabled: boolean): void {
  const releaseRoot = join(
    harness.config.dataDir,
    "app-versions",
    "0.46.319+private.1",
    "builtin-plugins",
    RETIRED_ID,
  );

  createPluginArtifact(harness.db, {
    id: ARTIFACT_ID,
    pluginId: RETIRED_ID,
    sourceKind: "builtin",
    npmResolvedVersion: null,
    gitResolvedCommit: null,
    gitCheckoutRoot: null,
    integrity: "a".repeat(64),
    bundledRootDir: releaseRoot,
    path: join(
      harness.config.dataDir,
      "plugins",
      "cache",
      "builtin",
      ARTIFACT_ID,
    ),
    contentHash: "a".repeat(64),
    validationResult: "valid",
    validatedAt: 1,
  });
  upsertInstalledPlugin(harness.db, {
    id: RETIRED_ID,
    source: `builtin:${RETIRED_ID}`,
    provenance: { kind: "builtin" },
    sourceIntent: { kind: "builtin", name: RETIRED_ID },
    exactResolution: { kind: "builtin" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
    rootDir: releaseRoot,
    version: "0.1.0",
    enabled,
    enabledFollowsDefault: false,
  });
  setPluginSettingsValues(harness.db, RETIRED_ID, {
    model: JSON.stringify("omnyo"),
  });
  setPluginKvValue(harness.db, RETIRED_ID, "usage", "kept");
  setAiServiceSelection(harness.db, "thread-title", {
    mode: "service",
    pluginId: RETIRED_ID,
    serviceId: "omnyo",
  });
}

async function restartPlugins(harness: TestAppHarness): Promise<void> {
  await harness.pluginService.stop();
  await harness.pluginService.start({
    hold: {
      sources: listBundledPluginRegistrations().map(
        (plugin) => `builtin:${plugin.name}`,
      ),
      detail: "Builtin services are not started by the server test fixture",
      isActive: async () => true,
    },
  });
}

function otherRows(harness: TestAppHarness) {
  return listInstalledPlugins(harness.db)
    .filter((row) => row.id !== RETIRED_ID)
    .map(({ id, source, enabled, enabledFollowsDefault, version }) => ({
      id,
      source,
      enabled,
      enabledFollowsDefault,
      version,
    }));
}

describe("retired omnyo-ai builtin on an upgraded coordinator", () => {
  it.each([
    ["disabled", false],
    ["enabled", true],
  ])(
    "removes a stored %s row once at startup and keeps every plugin and AI surface working",
    async (_label, enabled) => {
      await withTestHarness(async (harness) => {
        expect(
          listBundledPluginRegistrations().some(
            (plugin) => plugin.name === RETIRED_ID,
          ),
        ).toBe(false);
        const before = otherRows(harness);
        expect(before.length).toBeGreaterThan(0);
        seedLiveRetiredRow(harness, enabled);

        await restartPlugins(harness);

        expect(getInstalledPluginRegistration(harness.db, RETIRED_ID)).toBe(
          undefined,
        );
        expect(getPluginSettingsValues(harness.db, RETIRED_ID)).toEqual({});
        expect(getPluginKvValue(harness.db, RETIRED_ID, "usage")).toBe("kept");
        expect(getPluginArtifact(harness.db, ARTIFACT_ID)?.pluginId).toBe(
          RETIRED_ID,
        );
        expect(otherRows(harness)).toEqual(before);
        expect(
          harness.pluginService.list().map((plugin) => plugin.id),
        ).not.toContain(RETIRED_ID);
        expect(
          harness.pluginService
            .list()
            .filter((plugin) => plugin.status === "degraded"),
        ).toEqual([]);

        const listed = await harness.app.request("/api/v1/plugins");
        expect(listed.status).toBe(200);
        expect(JSON.stringify(await readJson(listed))).not.toContain(
          `"${RETIRED_ID}"`,
        );

        const checked = await harness.app.request(
          "/api/v1/plugins/updates/check",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );

        expect(checked.status).toBe(200);
        expect(JSON.stringify(await readJson(checked))).not.toContain(
          `"${RETIRED_ID}"`,
        );

        const updates = await harness.app.request("/api/v1/plugins/updates");
        expect(updates.status).toBe(200);

        const settings = await harness.app.request(
          `/api/v1/plugins/${RETIRED_ID}/settings`,
        );

        expect(settings.status).toBe(404);

        const view = await harness.app.request("/api/v1/system/ai-services");
        expect(view.status).toBe(200);
        expect(
          systemAiServicesResponseSchema.parse(await readJson(view)).selections[
            "thread-title"
          ],
        ).toEqual({
          mode: "service",
          pluginId: RETIRED_ID,
          serviceId: "omnyo",
        });

        await expect(
          runTextAiTask(harness.deps, {
            task: "thread-title",
            label: "retired builtin",
            prompt: "Name this chat",
          }),
        ).resolves.toMatchObject({
          ok: false,
          reason: "unavailable",
          message: 'The selected AI service "omnyo" is not loaded',
        });

        const afterFirst = listInstalledPlugins(harness.db);
        await restartPlugins(harness);
        expect(listInstalledPlugins(harness.db)).toEqual(afterFirst);
        expect(getAiServiceSelections(harness.db)["thread-title"]).toEqual({
          mode: "service",
          pluginId: RETIRED_ID,
          serviceId: "omnyo",
        });
      });
    },
  );

  it.each([
    ["disabled", false],
    ["enabled", true],
  ])(
    "removes a stored %s row when a held boot releases maintenance",
    async (_label, enabled) => {
      await withTestHarness(
        { seedFirstPartyProviders: false },
        async (harness) => {
          const before = otherRows(harness);
          await harness.pluginService.stop();
          seedLiveRetiredRow(harness, enabled);

          await harness.pluginService.resumeMaintenancePlugins();

          expect(getInstalledPluginRegistration(harness.db, RETIRED_ID)).toBe(
            undefined,
          );
          expect(getPluginSettingsValues(harness.db, RETIRED_ID)).toEqual({});
          expect(getPluginKvValue(harness.db, RETIRED_ID, "usage")).toBe(
            "kept",
          );
          expect(otherRows(harness)).toEqual(before);
          expect(
            harness.pluginService.list().map((plugin) => plugin.id),
          ).not.toContain(RETIRED_ID);
          expect(
            harness.pluginService
              .list()
              .filter((plugin) => plugin.status === "degraded"),
          ).toEqual([]);
        },
      );
    },
  );
});
