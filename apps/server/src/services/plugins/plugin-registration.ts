import { findProviderEnvironmentContainingPath } from "@omnyo/db";
import { realpathSync } from "node:fs";
import { resolve, isAbsolute, sep } from "node:path";
import { isOmnyoManagedWorkspacePath } from "../threads/workspace-paths.js";
import {
  getInstalledPlugin,
  installedPlugins,
  getInstalledPluginRegistration,
  getPluginArtifact,
  listInstalledPlugins,
  getPluginSettingsValues,
  setPluginSettingsValues,
  setInstalledPluginEnabled,
  listUnnormalizedPluginRegistrations,
  normalizeInstalledPluginRegistration,
  setInstalledPluginSourceClassification,
  upsertInstalledPlugin,
  type InstalledPluginRow,
  type LegacyPluginExactResolution,
  type NormalizeLegacyInstalledPluginInput,
  type PluginExactResolution,
  type PluginProvenance,
  type PluginSourceIntent,
} from "@omnyo/db";
import { eq } from "drizzle-orm";
import {
  BUILTIN_PLUGIN_ID_PREFIX,
  BUNDLED_PLUGINS,
  builtinPluginSource,
  isBundledPluginEnabledByDefault,
  type BundledPluginRegistration,
} from "./builtin-registry.js";
import { BUNDLED_MARKETPLACE_NAME } from "../plugin-catalog/marketplace-manifest.js";
import {
  type InstalledPlugin,
  type PluginPathRelocationEntry,
  type PluginPathRelocationResponse,
  type PluginRuntimeStatus,
  type PluginSourceSelection,
} from "@omnyo/server-contract";
import type { TelemetryEvent } from "../system/telemetry.js";
import { resolveSelectedSubdirectory } from "./collection-manifest.js";
import {
  isCommitSha,
  parsePluginSource,
  pluginRootDir,
  realPathInside,
  runInstallCommand,
} from "./install-sources.js";
import { gitRefNameForRow, gitSelectorForRow } from "./git-source-intent.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";
import {
  forgetMutableRoot,
  type SafeModeActivationRefusalArgs,
} from "./plugin-runtime.js";
import type {
  InstallRegistrationIdentity,
  RegisterInstalledArgs,
} from "./managed-plugin-artifacts.js";
import { commitInstall } from "./install-cancellation.js";
import { assertOmnyoPluginNamespacesAdopted } from "./omnyo-plugin-state-v1.js";
import type { PluginServiceDeps } from "./plugin-service-internal.js";
import {
  gitResolvedVersion,
  resolveGitRef,
  type GitRefKind,
  type NpmSourceIntentForResolution,
  type PluginResolvedUpdateVersion,
} from "./update-resolver.js";

export function pluginInstalledTelemetryEvent(
  pluginId: string,
  provenance: PluginProvenance,
  sourceIntent: PluginSourceIntent,
): Extract<TelemetryEvent, { name: "plugin_installed" }> {
  const isPublic =
    provenance.kind === "builtin" ||
    (provenance.kind === "catalog" &&
      provenance.marketplace === BUNDLED_MARKETPLACE_NAME);

  return {
    name: "plugin_installed",
    properties: {
      plugin_id: isPublic ? pluginId : null,
      provenance: provenance.kind,
      marketplace:
        isPublic && provenance.kind === "catalog"
          ? provenance.marketplace
          : null,
      source_kind: sourceIntent.kind,
    },
  };
}

interface PluginRegistrationContext {
  deps: PluginServiceDeps;
  bundledPlugins: readonly BundledPluginRegistration[];
  withLifecycleLock: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  disposeOne: (id: string) => Promise<void>;
  disposeForReplacement: (id: string) => Promise<void>;
  loadOne: (row: InstalledPluginRow) => Promise<string | null>;
  statuses: ReadonlyMap<
    string,
    { status: PluginRuntimeStatus; detail: string | null }
  >;
  validateInstallDir: (args: RegisterInstalledArgs) => Promise<PluginManifest>;
  checkEngineRange: (manifest: PluginManifest) => string | undefined;
  checkPluginSdkRange: (manifest: PluginManifest) => string | undefined;
  syncCliSkill: () => Promise<void>;
  notifyPluginsChanged: () => void;
  list: () => InstalledPlugin[];
  runInstallHandlers: (id: string) => Promise<void>;
  safeModeActivationRefusal: (
    args: SafeModeActivationRefusalArgs,
  ) => string | null;
}

export function createPluginRegistration(context: PluginRegistrationContext) {
  const {
    deps,
    safeModeActivationRefusal,
    bundledPlugins,
    withLifecycleLock,
    disposeOne,
    disposeForReplacement,
    loadOne,
    statuses,
    validateInstallDir,
    checkEngineRange,
    checkPluginSdkRange,
    syncCliSkill,
    notifyPluginsChanged,
    list,
    runInstallHandlers,
  } = context;

  const logger = deps.logger;

  const bundledPluginNamesById = new Map<string, string>(
    BUNDLED_PLUGINS.map((plugin) => [plugin.pluginId, plugin.name]),
  );

  function refuseBuiltinShadow(pluginId: string): void {
    const bundledName = bundledPluginNamesById.get(pluginId);

    if (bundledName === undefined) {
      if (!pluginId.startsWith(BUILTIN_PLUGIN_ID_PREFIX)) return;
      throw new Error(
        `install refused: plugin ids starting with "${BUILTIN_PLUGIN_ID_PREFIX}" are reserved for plugins bundled with Omnyo; rename the package so its id "${pluginId}" does not start with "${BUILTIN_PLUGIN_ID_PREFIX}"`,
      );
    }

    throw new Error(
      `install refused: plugin id "${pluginId}" is reserved by the bundled plugin "${bundledName}"; install "builtin:${bundledName}" instead`,
    );
  }

  function emptyPluginUpdateState() {
    return {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    } as const;
  }

  function rowMatchesInstallSource(
    row: InstalledPluginRow,
    provenance: PluginProvenance,
    intent: PluginSourceIntent,
  ): boolean {
    if (row.provenance !== provenance.kind || row.sourceKind !== intent.kind) {
      return false;
    }

    if (
      provenance.kind === "catalog" &&
      (row.catalogEntryId !== provenance.entryId ||
        row.catalogMarketplaceName !== provenance.marketplace)
    ) {
      return false;
    }

    if (intent.kind === "path") return row.sourcePath === intent.canonicalPath;

    if (intent.kind === "builtin") {
      return row.sourceBuiltinName === intent.name;
    }

    if (intent.kind === "npm") {
      return (
        row.sourceNpmPackage === intent.packageName &&
        row.sourceNpmRegistry === intent.registry &&
        row.sourceNpmRequestedSpec === intent.requestedSpec &&
        row.sourceNpmSpecKind === intent.specKind
      );
    }

    const selector = gitSelectorForRow(row);

    if (
      row.sourceGitUrl !== intent.url ||
      row.sourceGitSubdirectory !== intent.subdirectory ||
      selector === null
    ) {
      return false;
    }

    if (selector.kind === "ref") {
      return (
        intent.selector.kind === "ref" &&
        selector.ref === intent.selector.ref &&
        selector.refKind === intent.selector.refKind
      );
    }

    return (
      intent.selector.kind === "range" &&
      selector.range === intent.selector.range &&
      selector.tagPrefix === intent.selector.tagPrefix
    );
  }

  function registrationMatchesForActivation(
    current: InstalledPluginRow,
    expected: InstalledPluginRow,
  ): boolean {
    return (
      current.source === expected.source &&
      current.provenance === expected.provenance &&
      current.catalogEntryId === expected.catalogEntryId &&
      current.catalogMarketplaceName === expected.catalogMarketplaceName &&
      current.sourceKind === expected.sourceKind &&
      current.sourcePath === expected.sourcePath &&
      current.sourceBuiltinName === expected.sourceBuiltinName &&
      current.sourceNpmPackage === expected.sourceNpmPackage &&
      current.sourceNpmRegistry === expected.sourceNpmRegistry &&
      current.sourceNpmRequestedSpec === expected.sourceNpmRequestedSpec &&
      current.sourceNpmSpecKind === expected.sourceNpmSpecKind &&
      current.sourceGitUrl === expected.sourceGitUrl &&
      current.sourceGitSubdirectory === expected.sourceGitSubdirectory &&
      current.sourceGitRequestedRef === expected.sourceGitRequestedRef &&
      current.sourceGitRefKind === expected.sourceGitRefKind &&
      current.sourceGitRange === expected.sourceGitRange &&
      current.sourceGitTagPrefix === expected.sourceGitTagPrefix &&
      current.sourceGitResolvedTag === expected.sourceGitResolvedTag &&
      current.npmResolvedVersion === expected.npmResolvedVersion &&
      current.npmIntegrity === expected.npmIntegrity &&
      current.gitResolvedCommit === expected.gitResolvedCommit &&
      current.activeArtifactId === expected.activeArtifactId &&
      current.rootDir === expected.rootDir &&
      current.version === expected.version &&
      current.enabled === expected.enabled &&
      current.enabledFollowsDefault === expected.enabledFollowsDefault
    );
  }

  function sourceFingerprint(row: InstalledPluginRow): string {
    return JSON.stringify({
      source: row.source,
      provenance: row.provenance,
      catalogEntryId: row.catalogEntryId,
      catalogMarketplaceName: row.catalogMarketplaceName,
      sourceKind: row.sourceKind,
      sourcePath: row.sourcePath,
      sourceBuiltinName: row.sourceBuiltinName,
      sourceNpmPackage: row.sourceNpmPackage,
      sourceNpmRegistry: row.sourceNpmRegistry,
      sourceNpmRequestedSpec: row.sourceNpmRequestedSpec,
      sourceNpmSpecKind: row.sourceNpmSpecKind,
      sourceGitUrl: row.sourceGitUrl,
      sourceGitSubdirectory: row.sourceGitSubdirectory,
      sourceGitRequestedRef: row.sourceGitRequestedRef,
      sourceGitRefKind: row.sourceGitRefKind,
      sourceGitRange: row.sourceGitRange,
      sourceGitTagPrefix: row.sourceGitTagPrefix,
      sourceGitResolvedTag: row.sourceGitResolvedTag,
    });
  }

  function pathSourceMoveFrom(
    existing: InstalledPluginRow | undefined,
    identity: InstallRegistrationIdentity,
  ): InstalledPluginRow | undefined {
    if (
      existing === undefined ||
      existing.provenance !== "direct" ||
      existing.sourceKind !== "path" ||
      identity.provenance.kind !== "direct" ||
      identity.sourceIntent.kind !== "path" ||
      (existing.sourcePath === identity.sourceIntent.canonicalPath &&
        (existing.activeArtifactId === null ||
          existing.rootDir === identity.sourceIntent.canonicalPath))
    ) {
      return undefined;
    }

    return existing;
  }

  function moveStartFailure(pluginId: string): string | null {
    const runtime = statuses.get(pluginId);

    if (runtime === undefined) return "plugin reported no status";

    if (
      runtime.status === "running" ||
      runtime.status === "disabled" ||
      runtime.status === "needs-configuration"
    ) {
      return null;
    }

    return runtime.detail ?? `plugin status is ${runtime.status}`;
  }

  function sameDirectory(a: string, b: string): boolean {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return a === b;
    }
  }

  function assertInstallRegistrationAvailable(
    existing: InstalledPluginRow | undefined,
    identity: InstallRegistrationIdentity,
    pluginId: string,
  ): void {
    if (existing === undefined) return;

    if (
      !rowMatchesInstallSource(
        existing,
        identity.provenance,
        identity.sourceIntent,
      ) &&
      pathSourceMoveFrom(existing, identity) === undefined
    ) {
      throw new Error(
        `plugin id "${pluginId}" is already installed from ${existing.source}; remove it first`,
      );
    }

    if (
      identity.provenance.kind === "catalog" ||
      identity.sourceIntent.kind === "npm" ||
      identity.sourceIntent.kind === "git"
    ) {
      throw new Error(
        `plugin "${pluginId}" is already installed; use \`omnyo plugin update ${pluginId}\` or remove it before reinstalling`,
      );
    }
  }

  async function registerInstalled(
    args: RegisterInstalledArgs,
  ): Promise<InstalledPlugin> {
    const initialManifest =
      args.preparedManifest ?? (await readPluginManifest(args.rootDir));

    function assertExpectedExisting(existing: InstalledPluginRow | undefined) {
      if (
        args.expectedExistingId !== undefined &&
        (initialManifest.id !== args.expectedExistingId ||
          existing === undefined ||
          existing.id !== args.expectedExistingId ||
          existing.provenance !== "direct" ||
          existing.sourceKind !== "path" ||
          args.provenance.kind !== "direct" ||
          args.sourceIntent.kind !== "path")
      )
        throw new Error(
          "Only the named installed direct-path plugin can be rebound",
        );
    }

    assertExpectedExisting(getInstalledPlugin(deps.db, initialManifest.id));

    const safeModeRefusal = safeModeActivationRefusal({
      pluginId: initialManifest.id,
      provenance: args.provenance.kind,
      builtinName:
        args.sourceIntent.kind === "builtin" ? args.sourceIntent.name : null,
      action: "install",
    });

    if (safeModeRefusal !== null) throw new Error(safeModeRefusal);
    const existingInstall = getInstalledPlugin(deps.db, initialManifest.id);
    assertInstallRegistrationAvailable(
      existingInstall,
      args,
      initialManifest.id,
    );

    if (
      args.provenance.kind !== "builtin" &&
      args.sourceIntent.kind !== "builtin" &&
      existingInstall?.provenance !== "direct"
    ) {
      refuseBuiltinShadow(initialManifest.id);
    }

    if (args.refuseEngineMismatch) {
      const engineProblem =
        checkEngineRange(initialManifest) ??
        checkPluginSdkRange(initialManifest);

      if (engineProblem !== undefined) {
        throw new Error(
          `install refused: plugin "${initialManifest.id}" ${engineProblem}`,
        );
      }
    }

    const manifest = args.validated
      ? initialManifest
      : await validateInstallDir(args);

    let isFreshInstall = false;
    commitInstall();
    await withLifecycleLock(manifest.id, async () => {
      const existing = getInstalledPlugin(deps.db, manifest.id);
      assertExpectedExisting(existing);
      isFreshInstall = existing === undefined;
      assertInstallRegistrationAvailable(existing, args, manifest.id);

      const movedFrom =
        args.expectedExistingId === undefined
          ? pathSourceMoveFrom(existing, args)
          : existing;

      if (existing === undefined) await disposeOne(manifest.id);
      else await disposeForReplacement(manifest.id);

      try {
        await args.beforePersist?.();

        if (
          args.expectedExistingId !== undefined &&
          args.sourceIntent.kind === "path"
        ) {
          deps.db
            .update(installedPlugins)
            .set({
              source: args.source,
              sourcePath: args.sourceIntent.canonicalPath,
              rootDir: args.rootDir,
              version: manifest.version,
              updatedAt: Date.now(),
            })
            .where(eq(installedPlugins.id, manifest.id))
            .run();
        } else
          upsertInstalledPlugin(deps.db, {
            id: manifest.id,
            source: args.source,
            provenance: args.provenance,
            sourceIntent: args.sourceIntent,
            exactResolution: args.exactResolution,
            updateState: emptyPluginUpdateState(),
            activeArtifactId: args.activeArtifactId ?? null,
            rootDir: args.rootDir,
            version: manifest.version,
            enabled: movedFrom?.enabled ?? true,
            enabledFollowsDefault: false,
          });
        const row = getInstalledPlugin(deps.db, manifest.id);

        if (row) {
          await loadOne(row);
        }

        if (movedFrom !== undefined) {
          const failure = moveStartFailure(manifest.id);

          if (failure !== null) {
            throw new Error(
              `plugin "${manifest.id}" failed to start from ${args.source}: ${failure}; the install at ${movedFrom.source} was kept`,
            );
          }
        }
      } catch (error) {
        if (movedFrom !== undefined) {
          await disposeOne(manifest.id);
          restoreRegistration(movedFrom);
        }

        const previous = getInstalledPlugin(deps.db, manifest.id);

        if (previous) {
          await loadOne(previous);
        }

        throw error;
      }

      if (movedFrom !== undefined) {
        if (!sameDirectory(movedFrom.rootDir, args.rootDir)) {
          forgetMutableRoot(movedFrom.rootDir);
        }

        logger.info(
          `plugin ${manifest.id} source moved from ${movedFrom.source} to ${args.source}; settings, secrets, and schedules were kept`,
        );
      }
    });
    await syncCliSkill();
    notifyPluginsChanged();

    if (isFreshInstall) await runInstallHandlers(manifest.id);
    const entry = list().find((p) => p.id === manifest.id);

    if (!entry) throw new Error(`plugin ${manifest.id} missing after install`);
    deps.telemetry.capture(
      pluginInstalledTelemetryEvent(
        manifest.id,
        args.provenance,
        args.sourceIntent,
      ),
    );

    return entry;
  }

  async function installPathSource(
    path: string,
    selection: PluginSourceSelection,
  ): Promise<InstalledPlugin> {
    const checkoutDir = resolve(path);

    const subdirectory = await resolveSelectedSubdirectory({
      checkoutDir,
      selection,
      sourceLabel: checkoutDir,
    });

    const rootDir =
      subdirectory === null
        ? checkoutDir
        : await realPathInside(
            checkoutDir,
            pluginRootDir(checkoutDir, subdirectory),
            "plugin subdirectory",
          );

    if (
      isOmnyoManagedWorkspacePath({ dataDir: deps.dataDir, path: rootDir }) ||
      findProviderEnvironmentContainingPath(deps.db, rootDir) !== null
    ) {
      logger.warn(
        `plugin "${rootDir}" is installed from inside an Omnyo-managed workspace; ` +
          "its source will be deleted when that environment is destroyed (e.g. when the owning thread is archived). " +
          "Reinstall from a stable path outside the managed workspace to avoid losing it.",
      );
    }

    return registerInstalled({
      rootDir,
      source: `path:${rootDir}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: rootDir },
      exactResolution: { kind: "path" },
      refuseEngineMismatch: false,
      validated: false,
    });
  }

  function npmIntentForRow(
    row: InstalledPluginRow,
  ): NpmSourceIntentForResolution {
    if (
      row.sourceKind !== "npm" ||
      row.sourceNpmPackage === null ||
      row.sourceNpmRegistry === null ||
      row.sourceNpmRequestedSpec === null
    ) {
      throw new Error(`plugin "${row.id}" has corrupt normalized npm state`);
    }

    let specKind = row.sourceNpmSpecKind;

    if (specKind === null) {
      const parsed = parsePluginSource(
        row.sourceNpmRequestedSpec.length === 0
          ? `npm:${row.sourceNpmPackage}`
          : `npm:${row.sourceNpmPackage}@${row.sourceNpmRequestedSpec}`,
      );

      if (parsed.kind !== "npm") {
        throw new Error(`plugin "${row.id}" has corrupt normalized npm state`);
      }

      specKind = parsed.specKind;

      if (
        !setInstalledPluginSourceClassification(deps.db, row.id, {
          kind: "npm",
          specKind,
        })
      ) {
        throw new Error(`plugin "${row.id}" disappeared during normalization`);
      }
    }

    return {
      packageName: row.sourceNpmPackage,
      registry: row.sourceNpmRegistry,
      requestedSpec: row.sourceNpmRequestedSpec,
      specKind,
    };
  }

  function installedUpdateVersion(
    row: InstalledPluginRow,
  ): PluginResolvedUpdateVersion {
    if (row.sourceKind === "npm") {
      if (row.sourceNpmPackage === null || row.npmResolvedVersion === null) {
        throw new Error(`plugin "${row.id}" has corrupt normalized npm state`);
      }

      return {
        version: row.npmResolvedVersion,
        display: `${row.sourceNpmPackage}@${row.npmResolvedVersion}`,
      };
    }

    if (row.sourceKind === "git") {
      const ref = gitRefNameForRow(row);

      if (
        row.sourceGitUrl === null ||
        ref === null ||
        row.gitResolvedCommit === null
      ) {
        throw new Error(`plugin "${row.id}" has corrupt normalized git state`);
      }

      return gitResolvedVersion({
        url: row.sourceGitUrl,
        ref,
        commit: row.gitResolvedCommit,
      });
    }

    return { version: row.version, display: row.source };
  }

  function provenanceForRow(row: InstalledPluginRow): PluginProvenance {
    if (row.provenance !== "catalog") return { kind: row.provenance };

    if (row.catalogEntryId === null || row.catalogMarketplaceName === null) {
      throw new Error(`plugin "${row.id}" has corrupt catalog provenance`);
    }

    return {
      kind: "catalog",
      marketplace: row.catalogMarketplaceName,
      entryId: row.catalogEntryId,
    };
  }

  function sourceIntentForRow(row: InstalledPluginRow): PluginSourceIntent {
    if (row.sourceKind === "path" && row.sourcePath !== null) {
      return { kind: "path", canonicalPath: row.sourcePath };
    }

    if (row.sourceKind === "builtin" && row.sourceBuiltinName !== null) {
      return { kind: "builtin", name: row.sourceBuiltinName };
    }

    if (row.sourceKind === "npm")
      return { kind: "npm", ...npmIntentForRow(row) };

    if (row.sourceKind === "git") {
      const selector = gitSelectorForRow(row);

      if (row.sourceGitUrl !== null && selector !== null) {
        return {
          kind: "git",
          url: row.sourceGitUrl,
          subdirectory: row.sourceGitSubdirectory,
          selector,
        };
      }
    }

    throw new Error(`plugin "${row.id}" has corrupt normalized source intent`);
  }

  function exactResolutionForRow(
    row: InstalledPluginRow,
  ): PluginExactResolution {
    if (row.sourceKind === "path" || row.sourceKind === "builtin") {
      return { kind: row.sourceKind };
    }

    if (
      row.sourceKind === "npm" &&
      row.npmResolvedVersion !== null &&
      row.npmIntegrity !== null
    ) {
      return {
        kind: "npm",
        version: row.npmResolvedVersion,
        integrity: row.npmIntegrity,
      };
    }

    if (row.sourceKind === "git" && row.gitResolvedCommit !== null) {
      return { kind: "git", commit: row.gitResolvedCommit };
    }

    throw new Error(`plugin "${row.id}" has corrupt exact resolution`);
  }

  function restoreRegistration(row: InstalledPluginRow): void {
    upsertInstalledPlugin(deps.db, {
      id: row.id,
      source: row.source,
      provenance: provenanceForRow(row),
      sourceIntent: sourceIntentForRow(row),
      exactResolution: exactResolutionForRow(row),
      updateState: {
        lastCheckAt: row.lastUpdateCheckAt,
        availableCompatibleVersion: row.availableCompatibleVersion,
        newestIncompatibleVersion: row.newestIncompatibleVersion,
        statusDetail: row.updateStatusDetail,
      },
      activeArtifactId: row.activeArtifactId,
      rootDir: row.rootDir,
      version: row.version,
      enabled: row.enabled,
      enabledFollowsDefault: row.enabledFollowsDefault,
    });
  }

  function findBundledPlugin(
    name: string,
  ): BundledPluginRegistration | undefined {
    return bundledPlugins.find((plugin) => plugin.name === name);
  }

  function bundledPluginProvenance(
    plugin: BundledPluginRegistration,
    existing?: InstalledPluginRow,
  ): PluginProvenance {
    if (
      existing?.provenance === "catalog" &&
      existing.catalogMarketplaceName === BUNDLED_MARKETPLACE_NAME
    ) {
      return {
        kind: "catalog",
        marketplace: BUNDLED_MARKETPLACE_NAME,
        entryId: plugin.name,
      };
    }

    return plugin.autoInstall
      ? { kind: "builtin" }
      : {
          kind: "catalog",
          marketplace: BUNDLED_MARKETPLACE_NAME,
          entryId: plugin.name,
        };
  }

  async function installBuiltinSource(
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "builtin" }>,
  ): Promise<InstalledPlugin> {
    const bundled = findBundledPlugin(parsed.name);

    if (!bundled) {
      throw new Error(`unknown builtin plugin "${parsed.name}"`);
    }

    return registerInstalled({
      rootDir: bundled.rootDir,
      source: builtinPluginSource(parsed.name),
      provenance: bundledPluginProvenance(bundled),
      sourceIntent: { kind: "builtin", name: parsed.name },
      exactResolution: { kind: "builtin" },
      refuseEngineMismatch: false,
      validated: false,
    });
  }

  function migrateStandaloneBundled(
    bundled: BundledPluginRegistration,
    manifest: PluginManifest,
    existing: InstalledPluginRow | undefined,
  ): InstalledPluginRow | undefined {
    const legacyId =
      manifest.id === "omnyo--composer-predictions"
        ? "composer-predictions"
        : manifest.id === "omnyo--account-usage"
          ? "account-usage"
          : null;

    if (
      legacyId === null ||
      bundled.pluginId !== manifest.id ||
      bundled.name !== legacyId ||
      checkEngineRange(manifest) !== undefined ||
      checkPluginSdkRange(manifest) !== undefined
    )
      return existing;
    const legacy = getInstalledPluginRegistration(deps.db, legacyId);

    if (legacy === undefined) return existing;

    if (
      existing !== undefined &&
      (existing.sourceKind !== "builtin" ||
        existing.sourceBuiltinName !== bundled.name)
    )
      return existing;
    deps.db.$client.transaction(() => {
      if (existing === undefined) {
        upsertInstalledPlugin(deps.db, {
          id: manifest.id,
          source: builtinPluginSource(bundled.name),
          provenance: bundledPluginProvenance(bundled, undefined),
          sourceIntent: { kind: "builtin", name: bundled.name },
          exactResolution: { kind: "builtin" },
          updateState: emptyPluginUpdateState(),
          activeArtifactId: null,
          rootDir: bundled.rootDir,
          version: manifest.version,
          enabled: legacy.removedAt === null && legacy.enabled,
          enabledFollowsDefault: false,
        });
        setPluginSettingsValues(
          deps.db,
          manifest.id,
          getPluginSettingsValues(deps.db, legacyId),
        );
      }

      if (legacy.enabled || legacy.enabledFollowsDefault) {
        setInstalledPluginEnabled(deps.db, legacyId, false);
      }
    })();

    return getInstalledPluginRegistration(deps.db, manifest.id);
  }

  async function reconcileBundled(
    mode: "startup" | "resume" = "startup",
  ): Promise<void> {
    assertOmnyoPluginNamespacesAdopted(deps.db);

    for (const bundled of bundledPlugins) {
      const source = builtinPluginSource(bundled.name);
      const defaultEnabled = isBundledPluginEnabledByDefault(bundled);
      let manifest: PluginManifest;

      try {
        manifest = await readPluginManifest(bundled.rootDir);
      } catch (error) {
        logger.warn(
          `bundled plugin ${bundled.name} is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      if (mode === "resume") {
        const existing = getInstalledPluginRegistration(deps.db, manifest.id);

        if (
          existing?.sourceKind === "builtin" &&
          existing.sourceBuiltinName === bundled.name &&
          existing.removedAt === null &&
          existing.rootDir !== bundled.rootDir &&
          existing.activeArtifactId === null
        ) {
          deps.db
            .update(installedPlugins)
            .set({ rootDir: bundled.rootDir, updatedAt: Date.now() })
            .where(eq(installedPlugins.id, existing.id))
            .run();
        }

        continue;
      }

      const existing = migrateStandaloneBundled(
        bundled,
        manifest,
        getInstalledPluginRegistration(deps.db, manifest.id),
      );

      if (
        existing?.sourceKind === "builtin" &&
        existing.sourceBuiltinName === bundled.name &&
        existing.activeArtifactId !== null &&
        getPluginArtifact(deps.db, existing.activeArtifactId)
          ?.bundledRootDir === bundled.rootDir
      ) {
        if (
          existing.removedAt === null &&
          existing.enabledFollowsDefault &&
          existing.enabled !== defaultEnabled
        ) {
          deps.db
            .update(installedPlugins)
            .set({ enabled: defaultEnabled, updatedAt: Date.now() })
            .where(eq(installedPlugins.id, existing.id))
            .run();
        }

        continue;
      }

      const provenance = bundledPluginProvenance(bundled, existing);

      if (existing?.removedAt !== null && existing?.removedAt !== undefined) {
        continue;
      }

      if (!bundled.autoInstall && existing === undefined) {
        continue;
      }

      const enabledFollowsDefault =
        existing === undefined || existing.enabledFollowsDefault;

      const enabled = enabledFollowsDefault ? defaultEnabled : existing.enabled;

      const sameBundledSource =
        existing?.sourceKind === "builtin" &&
        existing.sourceBuiltinName === bundled.name;

      if (
        existing !== undefined &&
        !sameBundledSource &&
        !rowMatchesInstallSource(existing, provenance, {
          kind: "builtin",
          name: bundled.name,
        })
      ) {
        logger.warn(
          `bundled plugin ${bundled.name} resolved to id "${manifest.id}", but that id is already installed from ${existing.source}; skipping bundled reconciliation`,
        );
        continue;
      }

      if (
        existing === undefined ||
        !rowMatchesInstallSource(existing, provenance, {
          kind: "builtin",
          name: bundled.name,
        }) ||
        existing.version !== manifest.version ||
        existing.rootDir !== bundled.rootDir ||
        existing.enabled !== enabled
      ) {
        upsertInstalledPlugin(deps.db, {
          id: manifest.id,
          source,
          provenance,
          sourceIntent: { kind: "builtin", name: bundled.name },
          exactResolution: { kind: "builtin" },
          updateState: emptyPluginUpdateState(),
          activeArtifactId: null,
          rootDir: bundled.rootDir,
          version: manifest.version,
          enabled,
          enabledFollowsDefault,
        });
      }
    }
  }

  async function backfillNormalizedPluginRegistrations(): Promise<void> {
    for (const row of listUnnormalizedPluginRegistrations(deps.db)) {
      const parsed = parsePluginSource(row.source);
      let sourceIntent: NormalizeLegacyInstalledPluginInput["sourceIntent"];
      let exactResolution: LegacyPluginExactResolution;
      let provenance: PluginProvenance = { kind: "direct" };

      if (parsed.kind === "path") {
        sourceIntent = { kind: "path", canonicalPath: resolve(parsed.path) };
        exactResolution = { kind: "path" };
      } else if (parsed.kind === "builtin") {
        provenance = { kind: "builtin" };
        sourceIntent = { kind: "builtin", name: parsed.name };
        exactResolution = { kind: "builtin" };
      } else if (parsed.kind === "npm") {
        sourceIntent = {
          kind: "npm",
          packageName: parsed.name,
          registry:
            process.env.npm_config_registry ?? "https://registry.npmjs.org",
          requestedSpec: parsed.spec,
          specKind: parsed.specKind,
        };
        exactResolution = {
          kind: "npm",
          version: parsed.specKind === "exact" ? parsed.spec : row.version,
          integrity: null,
        };
      } else {
        const ref =
          parsed.selector.kind === "range" ? parsed.spec : parsed.selector.ref;

        let refKind: GitRefKind | null = isCommitSha(ref) ? "commit" : null;

        try {
          const remote = await resolveGitRef({ url: parsed.url, ref });

          if (remote.outcome === "resolved") refKind = remote.refKind;
        } catch {}

        sourceIntent = {
          kind: "git",
          url: parsed.url,
          subdirectory: null,
          selector: { kind: "ref", ref, refKind },
        };
        let commit: string | null = isCommitSha(ref) ? ref : null;

        try {
          commit = await runInstallCommand("git", [
            "-C",
            row.rootDir,
            "rev-parse",
            "HEAD",
          ]);
        } catch {}

        exactResolution = { kind: "git", commit };
      }

      normalizeInstalledPluginRegistration(deps.db, {
        ...row,
        provenance,
        sourceIntent,
        exactResolution,
        updateState: emptyPluginUpdateState(),
        activeArtifactId: null,
      });
    }
  }

  async function rebindInstalledPath(
    pluginId: string,
    path: string,
  ): Promise<string> {
    if (!isAbsolute(path))
      throw new Error("Plugin root must be an absolute path");
    const rootDir = realpathSync(path);

    const entry = await registerInstalled({
      rootDir,
      source: `path:${rootDir}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: rootDir },
      exactResolution: { kind: "path" },
      refuseEngineMismatch: false,
      validated: false,
      expectedExistingId: pluginId,
    });

    return entry.rootDir;
  }

  function existingRealPath(path: string): string | null {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  }

  function setPathSourceColumns(
    pluginId: string,
    columns: { source: string; sourcePath: string; rootDir: string },
  ): void {
    deps.db
      .update(installedPlugins)
      .set({ ...columns, updatedAt: Date.now() })
      .where(eq(installedPlugins.id, pluginId))
      .run();
  }

  async function relocatePathSource(plan: {
    pluginId: string;
    from: string;
    to: string;
    mode: PluginPathRelocationEntry["mode"];
  }): Promise<PluginPathRelocationEntry> {
    const current = getInstalledPluginRegistration(deps.db, plan.pluginId);

    if (
      current === undefined ||
      current.removedAt !== null ||
      current.sourcePath !== plan.from ||
      (current.activeArtifactId === null) !== (plan.mode === "checkout")
    )
      throw new Error(
        `plugin "${plan.pluginId}" changed while it was being relocated; run the command again`,
      );

    const previous = {
      source: current.source,
      sourcePath: plan.from,
      rootDir: current.rootDir,
    };

    const next = {
      source: `path:${plan.to}`,
      sourcePath: plan.to,
      rootDir: plan.mode === "checkout" ? plan.to : current.rootDir,
    };

    const reload = plan.mode === "checkout" && current.enabled;

    if (reload) await disposeForReplacement(plan.pluginId);
    setPathSourceColumns(plan.pluginId, next);

    if (reload) {
      const row = getInstalledPlugin(deps.db, plan.pluginId);

      if (row) await loadOne(row);
      const failure = moveStartFailure(plan.pluginId);

      if (failure !== null) {
        await disposeOne(plan.pluginId);
        setPathSourceColumns(plan.pluginId, previous);
        const restored = getInstalledPlugin(deps.db, plan.pluginId);

        if (restored) await loadOne(restored);
        throw new Error(
          `plugin "${plan.pluginId}" failed to start from ${plan.to}: ${failure}; it still runs from ${plan.from}`,
        );
      }
    }

    logger.info(
      `plugin ${plan.pluginId} source relocated from ${plan.from} to ${plan.to}; settings, secrets, and schedules were kept`,
    );

    return {
      pluginId: plan.pluginId,
      from: plan.from,
      to: plan.to,
      mode: plan.mode,
      reloaded: reload,
    };
  }

  async function relocatePathSources(args: {
    from: string;
    to: string;
    dryRun: boolean;
  }): Promise<PluginPathRelocationResponse> {
    if (!isAbsolute(args.from) || !isAbsolute(args.to))
      throw new Error("Both folders must be absolute paths");
    const from = resolve(args.from);
    const to = resolve(args.to);

    if (from === to) throw new Error("The old and new folders are the same");

    if (existingRealPath(to) !== to)
      throw new Error(
        `${to} must be the folder's own path, not a link or a missing folder`,
      );

    if (existingRealPath(from) !== to)
      throw new Error(
        `${from} does not lead to ${to}; keep a link from the old folder to the new one until the plugins are relocated`,
      );

    const plans = listInstalledPlugins(deps.db).flatMap((row) => {
      const sourcePath = row.sourcePath;

      if (
        row.provenance !== "direct" ||
        row.sourceKind !== "path" ||
        sourcePath === null ||
        (sourcePath !== from && !sourcePath.startsWith(from + sep))
      )
        return [];
      const target = to + sourcePath.slice(from.length);
      const registration = getInstalledPluginRegistration(deps.db, row.id);
      const mode = row.activeArtifactId === null ? "checkout" : "snapshot";

      if (
        row.source !== `path:${sourcePath}` ||
        existingRealPath(target) !== target ||
        existingRealPath(sourcePath) !== target
      )
        throw new Error(
          `plugin "${row.id}" is not installed from a folder that moved to ${target}`,
        );

      if (mode === "checkout" && registration?.rootDir !== sourcePath)
        throw new Error(
          `plugin "${row.id}" runs from ${registration?.rootDir ?? "an unknown folder"} instead of its source; install it from ${target} instead`,
        );

      return [
        {
          pluginId: row.id,
          from: sourcePath,
          to: target,
          mode,
          enabled: row.enabled,
        } as const,
      ];
    });

    plans.sort((a, b) => a.pluginId.localeCompare(b.pluginId));

    if (args.dryRun)
      return {
        dryRun: true,
        relocated: plans.map(({ enabled, ...plan }) => ({
          ...plan,
          reloaded: plan.mode === "checkout" && enabled,
        })),
      };

    const relocated: PluginPathRelocationEntry[] = [];

    for (const plan of plans)
      relocated.push(
        await withLifecycleLock(plan.pluginId, () => relocatePathSource(plan)),
      );

    if (relocated.length > 0) {
      await syncCliSkill();
      notifyPluginsChanged();
    }

    return { dryRun: false, relocated };
  }

  return {
    assertInstallRegistrationAvailable,
    backfillNormalizedPluginRegistrations,
    emptyPluginUpdateState,
    installBuiltinSource,
    installPathSource,
    installedUpdateVersion,
    npmIntentForRow,
    provenanceForRow,
    reconcileBundled,
    registerInstalled,
    registrationMatchesForActivation,
    refuseBuiltinShadow,
    restoreRegistration,
    sourceFingerprint,
    rebindInstalledPath,
    relocatePathSources,
  };
}
