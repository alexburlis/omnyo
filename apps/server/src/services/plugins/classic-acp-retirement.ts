import {
  getInstalledPluginRegistration,
  getPluginSettingsValues,
  installedPlugins,
  setInstalledPluginEnabled,
  setPluginSettingsValues,
  upsertInstalledPlugin,
  type DbConnection,
} from "@omnyo/db";
import { eq } from "drizzle-orm";
import {
  isBundledPluginEnabledByDefault,
  type BundledPluginRegistration,
} from "./builtin-registry.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";

const CLASSIC_ID = "provider-acp";

const NEXT_ID = "omnyo--provider-acp-next";

const NEXT_NAME = "provider-acp-next";

export async function retireClassicAcp(args: {
  db: DbConnection;
  bundledPlugins: readonly BundledPluginRegistration[];
  checkEngineRange: (manifest: PluginManifest) => string | undefined;
  checkPluginSdkRange: (manifest: PluginManifest) => string | undefined;
}): Promise<void> {
  const { db } = args;
  const classic = getInstalledPluginRegistration(db, CLASSIC_ID);

  if (
    classic === undefined ||
    classic.removedAt !== null ||
    classic.source !== `builtin:${CLASSIC_ID}` ||
    classic.sourceKind !== "builtin" ||
    classic.sourceBuiltinName !== CLASSIC_ID
  )
    return;

  const bundle = args.bundledPlugins.find(
    (plugin) => plugin.pluginId === NEXT_ID && plugin.name === NEXT_NAME,
  );

  if (bundle === undefined) {
    throw new Error(
      "Cannot retire Classic ACP without the bundled ACP provider",
    );
  }

  const manifest = await readPluginManifest(bundle.rootDir);

  const problem =
    args.checkEngineRange(manifest) ?? args.checkPluginSdkRange(manifest);

  if (manifest.id !== NEXT_ID || problem !== undefined) {
    throw new Error(
      `Cannot retire Classic ACP: ${problem ?? "bundled ACP provider has an unexpected plugin id"}`,
    );
  }

  const next = getInstalledPluginRegistration(db, NEXT_ID);

  if (
    next !== undefined &&
    (next.source !== `builtin:${NEXT_NAME}` ||
      next.sourceKind !== "builtin" ||
      next.sourceBuiltinName !== NEXT_NAME)
  ) {
    throw new Error(
      "Cannot retire Classic ACP while its successor id belongs to an external plugin",
    );
  }

  const nextActive = next?.removedAt === null && next.enabled;
  const nextSettings = getPluginSettingsValues(db, NEXT_ID);

  const carrySettings =
    !nextActive &&
    (next === undefined || next.removedAt === null) &&
    (classic.enabled ||
      next === undefined ||
      (next.enabledFollowsDefault && nextSettings.customAgents === undefined));

  const followsDefault =
    !nextActive &&
    !classic.enabled &&
    classic.enabledFollowsDefault &&
    (next === undefined || next.enabledFollowsDefault);

  const enabled =
    nextActive ||
    classic.enabled ||
    (followsDefault && isBundledPluginEnabledByDefault(bundle));

  db.$client.transaction(() => {
    if (next === undefined) {
      upsertInstalledPlugin(db, {
        id: NEXT_ID,
        source: `builtin:${NEXT_NAME}`,
        provenance: { kind: "builtin" },
        sourceIntent: { kind: "builtin", name: NEXT_NAME },
        exactResolution: { kind: "builtin" },
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        rootDir: bundle.rootDir,
        version: manifest.version,
        enabled,
        enabledFollowsDefault: followsDefault,
      });
    } else if (
      next.removedAt === null &&
      !followsDefault &&
      (next.enabled !== enabled || next.enabledFollowsDefault)
    ) {
      setInstalledPluginEnabled(db, NEXT_ID, enabled);
    }

    if (carrySettings) {
      const { customAgents } = getPluginSettingsValues(db, CLASSIC_ID);
      setPluginSettingsValues(db, NEXT_ID, {
        customAgents: customAgents ?? JSON.stringify(""),
      });
    }

    db.update(installedPlugins)
      .set({ removedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(installedPlugins.id, CLASSIC_ID))
      .run();
  })();
}
