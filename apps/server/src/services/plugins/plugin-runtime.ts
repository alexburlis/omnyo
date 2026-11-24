import { verifyBuiltinPluginArtifact } from "./builtin-plugin-artifacts.js";
import {
  isMaintenanceFrozen,
  isServerMoveFrozen,
} from "../server-move/freeze-state.js";
import { CONNECT_HOLD_SOURCES } from "../server-move/connect-hold.js";
import type { MachineEnrollmentService } from "../machines/machine-services.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  providerWithoutBridgeMessage,
  type NormalizedPluginProviderDeclaration,
  type PluginThreadEventBatch,
} from "@omnyo/plugin-sdk/internal/host-policy";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  type FSWatcher,
} from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
import semver from "semver";
import { HOST_ARTIFACT_MAX_BYTES } from "@omnyo/host-daemon-contract/protocol";
import {
  calculateExponentialBackoffDelay,
  getErrorMessage,
  isPluginOwnedIconPath,
  parseNamespacedGlyph,
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_VERSION,
  type Thread,
  type ThreadQueuedMessage,
} from "@omnyo/domain";
import {
  buildPluginApp,
  buildPluginHost,
  isPluginHostArtifactFresh,
  isIgnoredPluginDevPath,
  serverBundleExpectsHostZod,
} from "@omnyo/plugin-build";
import { PluginHostArtifactRegistry } from "./plugin-host-artifact-registry.js";
import { getPluginBuildToolchain } from "./build-toolchain.js";
import { createNodeOmnyoSdk, type OmnyoSdk } from "@omnyo/sdk";
import {
  deletePluginHostGeneration,
  getInstalledPlugin,
  getPluginArtifact,
  type PluginArtifactRow,
  getPluginHostGeneration,
  getPluginSafeMode,
  listInstalledPlugins,
  listPluginHostGenerationIds,
  listPluginSchedules,
  prunePluginSchedules,
  upsertPluginSchedule,
  setPluginHostGeneration,
  type InstalledPluginRow,
} from "@omnyo/db";
import { toThreadResponseFromThread } from "../threads/thread-runtime-display.js";
import { activeMaintenanceKind } from "../threads/maintenance-run.js";
import {
  brandingAssetHash,
  loadPluginAppBundle,
  loadPluginBrandingAssets,
  parsePluginAppBundleMeta,
  isPluginArtifactRuntimeCompatible,
  readPluginAppBundleMeta,
  validatePluginArtifactMeta,
  type PluginAppBundleSnapshot,
  type PluginBrandingAssetSet,
} from "./app-bundle.js";
import { parsePluginSource, hashInstallDir } from "./install-sources.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";
import { buildPluginProviderRegistration } from "../providers/plugin-provider-registration.js";
import type { ProviderInstallRank } from "../providers/provider-registry.js";
import { BUNDLED_PLUGINS } from "./builtin-registry.js";
import { readPluginSettingsValuesSync } from "./plugin-settings.js";
import type { PluginSecretStores } from "./plugin-secrets.js";
import {
  nextCronRunAt,
  raceTimeout,
  settledWithin,
} from "./plugin-time-box.js";
import type {
  PluginHookName,
  PluginSettingDescriptors,
} from "@omnyo/plugin-sdk";
import type {
  PluginHookInvocation,
  PluginHookRegistration,
} from "./plugin-hook-registry.js";
import type { PluginEnvironmentProviderRecord } from "./plugin-environment-provider-registry.js";
import type { PluginMachineProviderRecord } from "./plugin-machine-provider-registry.js";
import {
  isPluginSdkRangeSatisfied,
  pluginSdkRangeProblem,
} from "./sdk-compat.js";
import {
  createPluginApi,
  isNeedsConfigurationError,
  PluginContextStaleError,
  type PluginApi,
  type PluginThreadEventName,
  type PluginThreadEventPayloads,
} from "./plugin-api.js";
import type {
  PluginHandlerStats,
  PluginRuntimeStatus,
} from "@omnyo/server-contract";
import type {
  LoadedPlugin,
  PluginServiceDeps,
  PluginHostArtifactSnapshot,
  PluginWireLookup,
  ServiceRuntime,
} from "./plugin-service-internal.js";
import { createKeyedLock } from "../lib/async-deduper.js";
import { runEventLoopWork } from "../system/event-loop-work.js";
import { abortPluginToolCallsForPlugin } from "./plugin-tool-calls.js";
import { buildCachedPluginServer } from "./plugin-server-cache.js";
import { createPluginRpcCallerRegistry } from "./plugin-rpc-caller.js";

const serverRuntimeDir = dirname(fileURLToPath(import.meta.url));

const pluginSdkRuntimePath = join(serverRuntimeDir, "plugin-sdk-runtime.js");

const zodRuntimePath = join(serverRuntimeDir, "zod-runtime.js");

const PLUGIN_SDK_SPECIFIER = "@omnyo/plugin-sdk";

const ZOD_SPECIFIER = "zod";

async function hashFile(
  path: string,
): Promise<{ digest: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;

  for await (const chunk of createReadStream(path)) {
    byteLength += chunk.byteLength;
    hash.update(chunk);
  }

  return { digest: hash.digest("hex"), byteLength };
}

const runtimeRequire = createRequire(import.meta.url);

const pluginSdkRuntimeEntry = existsSync(pluginSdkRuntimePath)
  ? pluginSdkRuntimePath
  : runtimeRequire.resolve(PLUGIN_SDK_SPECIFIER);

const pluginRuntimeExternalUrls = new Map(
  Object.entries({
    [PLUGIN_SDK_SPECIFIER]: pluginSdkRuntimeEntry,
    "better-sqlite3": runtimeRequire.resolve("better-sqlite3"),
  }).map(([specifier, path]) => [specifier, pathToFileURL(path).href]),
);

const serverZodRuntimeUrl = pathToFileURL(
  existsSync(zodRuntimePath)
    ? zodRuntimePath
    : join(serverRuntimeDir, "zod-runtime.ts"),
).href;

async function usesServerZodRuntime(
  sourceKind: InstalledPluginRow["sourceKind"],
  serverEntry: string,
  immutableArtifact: boolean,
): Promise<boolean> {
  if (!serverEntry.endsWith(`${sep}dist${sep}server.js`)) return false;

  if (sourceKind === "builtin") return true;

  return (
    immutableArtifact &&
    serverBundleExpectsHostZod(await readFile(serverEntry, "utf8"))
  );
}

interface MutableRoot {
  id: number;
  epoch: number;
  version: string;
}

const mutableRoots = new Map<string, MutableRoot>();

const hostZodParentUrls = new Set<string>();

const MUTABLE_ROOT_MARKER = /[?&]omnyoPluginLoad=(\d+)\.(\d+)/;

let nextMutableRootId = 1;

let nextMutableRootEpoch = 1;

let mutableRootHooks: { deregister: () => void } | null = null;

function registerMutableRootHooks(): void {
  if (mutableRootHooks !== null) return;
  mutableRootHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentUrl = context.parentURL?.split("?")[0];

      if (
        specifier === ZOD_SPECIFIER &&
        parentUrl !== undefined &&
        hostZodParentUrls.has(parentUrl)
      ) {
        return { url: serverZodRuntimeUrl, shortCircuit: true };
      }

      const parent = MUTABLE_ROOT_MARKER.exec(context.parentURL ?? "");
      const runtimeExternalUrl = pluginRuntimeExternalUrls.get(specifier);

      if (runtimeExternalUrl !== undefined) {
        return { url: runtimeExternalUrl, shortCircuit: true };
      }

      const resolved = nextResolve(specifier, context);

      if (mutableRoots.size === 0) return resolved;

      if (!resolved.url.startsWith("file:")) return resolved;
      let match: MutableRoot | undefined;
      let matchedLength = 0;

      for (const [rootUrl, root] of mutableRoots) {
        if (rootUrl.length <= matchedLength) continue;

        if (!resolved.url.startsWith(rootUrl)) continue;
        match = root;
        matchedLength = rootUrl.length;
      }

      if (match === undefined) return resolved;

      const epoch =
        parent !== null && Number(parent[1]) === match.id
          ? parent[2]
          : match.epoch;

      const separator = resolved.url.includes("?") ? "&" : "?";

      return {
        ...resolved,
        url: `${resolved.url}${separator}omnyoPluginLoad=${match.id}.${epoch}`,
        shortCircuit: true,
      };
    },
  });
}

const PROVIDER_ICON_CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function readPluginProviderIcon(
  rootDir: string,
  icon: string | undefined,
): { bytes: Uint8Array; contentType: string; hash: string } | null {
  if (icon === undefined || !isPluginOwnedIconPath(icon)) {
    return null;
  }

  const asset = icon;
  const contentType = PROVIDER_ICON_CONTENT_TYPES[extname(asset).toLowerCase()];

  if (contentType === undefined) {
    return null;
  }

  const resolved = resolve(rootDir, asset);

  if (!resolved.startsWith(resolve(rootDir) + sep)) {
    return null;
  }

  try {
    const bytes = new Uint8Array(readFileSync(resolved));

    return { bytes, contentType, hash: brandingAssetHash(bytes) };
  } catch {
    return null;
  }
}

function mutableRootDir(rootDir: string): string {
  try {
    return realpathSync(rootDir);
  } catch {
    return rootDir;
  }
}

function mutableRootUrl(canonicalDir: string): string {
  return pathToFileURL(join(canonicalDir, "/")).href;
}

function detachCommonJsModule(entry: NodeModule): void {
  const parent = entry.parent;

  if (parent === null || parent === undefined) return;
  const index = parent.children.indexOf(entry);

  if (index >= 0) parent.children.splice(index, 1);
}

function evictCommonJsCache(canonicalDir: string): Map<string, NodeModule> {
  const prefix = join(canonicalDir, "/");
  const cache = createRequire(import.meta.url).cache;
  const evicted = new Map<string, NodeModule>();

  for (const filename of Object.keys(cache)) {
    if (!filename.startsWith(prefix)) continue;
    const entry = cache[filename];

    if (entry !== undefined) {
      evicted.set(filename, entry);
      detachCommonJsModule(entry);
    }

    delete cache[filename];
  }

  return evicted;
}

function setMutableRootVersion(
  rootDir: string,
  version: string,
): { rootUrl: string; rollback: () => void } {
  registerMutableRootHooks();
  const canonicalDir = mutableRootDir(rootDir);
  const rootUrl = mutableRootUrl(canonicalDir);
  const previous = mutableRoots.get(rootUrl);

  if (previous?.version === version) {
    return { rootUrl, rollback: () => {} };
  }

  mutableRoots.set(rootUrl, {
    id: previous?.id ?? nextMutableRootId++,
    epoch: nextMutableRootEpoch++,
    version,
  });
  const evicted = evictCommonJsCache(canonicalDir);

  return {
    rootUrl,
    rollback: () => {
      if (previous === undefined) mutableRoots.delete(rootUrl);
      else mutableRoots.set(rootUrl, previous);
      const cache = createRequire(import.meta.url).cache;

      for (const [filename, entry] of evicted) {
        if (cache[filename] !== undefined) continue;
        cache[filename] = entry;
        const parent = entry.parent;

        if (
          parent !== null &&
          parent !== undefined &&
          !parent.children.includes(entry)
        ) {
          parent.children.push(entry);
        }
      }
    },
  };
}

export function forgetMutableRoot(rootDir: string): void {
  releaseMutableRoots([mutableRootUrl(mutableRootDir(rootDir))]);
}

function releaseMutableRoots(rootUrls: Iterable<string>): void {
  for (const rootUrl of rootUrls) {
    mutableRoots.delete(rootUrl);

    for (const parentUrl of hostZodParentUrls) {
      if (parentUrl.startsWith(rootUrl)) hostZodParentUrls.delete(parentUrl);
    }
  }

  if (mutableRoots.size > 0 || mutableRootHooks === null) return;
  mutableRootHooks.deregister();
  mutableRootHooks = null;
}

type PluginDevBuildKind = "frontend" | "host";

const DEV_BUILD_PROBLEM_LABELS: Record<PluginDevBuildKind, string> = {
  frontend: "frontend bundle build failed",
  host: "host bundle build failed",
};

const PREVIOUS_INSTANCE_KEPT = "the previous instance is still running";

const DEFAULT_LOAD_TIMEOUT_MS = 30_000;

const DEFAULT_SERVICE_STOP_TIMEOUT_MS = 5_000;

const DEFAULT_SERVICE_RESTART_BASE_MS = 1_000;

const SERVICE_RESTART_MAX_MS = 60_000;

const SERVICE_HEALTHY_RESET_MS = 5 * 60_000;

interface ServiceInstance {
  id: string;
  service: ServiceRuntime;
  controller: AbortController;
  uncaughtError: { error: unknown } | undefined;
}

interface PluginRuntimeContext {
  machineEnrollments: MachineEnrollmentService | null;
  deps: PluginServiceDeps;
  secretStores: PluginSecretStores;
  includedBuiltinNames: ReadonlySet<string>;
  settingsChanged?: () => void;
  afterDeferredLifecycle?: () => Promise<void>;
}

export interface SafeModeActivationRefusalArgs {
  pluginId: string;
  provenance: InstalledPluginRow["provenance"];
  builtinName: string | null;
  action: "install" | "update";
}

const PLUGIN_SAFE_MODE_DETAIL = "safe mode is on";

export interface PluginLoadHold {
  sources: readonly string[];
  detail: string;
  isActive(): Promise<boolean>;
}

export function createPluginRuntime(context: PluginRuntimeContext) {
  const { deps } = context;
  const settingsChanged = context.settingsChanged ?? (() => {});
  const logger = deps.logger;
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;

  const serviceStopTimeoutMs =
    deps.serviceStopTimeoutMs ?? DEFAULT_SERVICE_STOP_TIMEOUT_MS;

  const serviceRestartBaseMs =
    deps.serviceRestartBaseMs ?? DEFAULT_SERVICE_RESTART_BASE_MS;

  const loaded = new Map<string, LoadedPlugin>();
  const initializedSourceBuiltinIds = new Set<string>();
  deps.pendingInteractions?.setPluginDirectory({
    isLoaded: (pluginId) => loaded.has(pluginId),
  });

  const unavailableProviderRegistrations = new Map<
    string,
    Array<{ dispose(): void }>
  >();

  const withLifecycleLock = createKeyedLock<string>();
  const withArtifactLock = createKeyedLock<string>();
  const withPluginOperationLock = createKeyedLock<string>();
  const REGISTRATION_MUTATION_KEY = "plugin-registration-mutations";
  const builtinSourceWatchers: FSWatcher[] = [];

  const statuses = new Map<
    string,
    { status: PluginRuntimeStatus; detail: string | null }
  >();

  const baseStatuses = new Map<
    string,
    { status: PluginRuntimeStatus; detail: string | null }
  >();

  const devBuildProblems = new Map<
    string,
    Partial<Record<PluginDevBuildKind, string>>
  >();

  const statusListeners = new Map<
    string,
    Set<(status: PluginRuntimeStatus, detail: string | null) => void>
  >();

  const stabilizingPluginIds = new Set<string>();
  const appBundles = new Map<string, PluginAppBundleSnapshot>();

  const hostArtifacts =
    deps.pluginHostArtifacts ?? new PluginHostArtifactRegistry();

  const brandingAssets = new Map<string, PluginBrandingAssetSet>();

  const identities = new Map<
    string,
    { manifest: PluginManifest; brandingAssets: PluginBrandingAssetSet }
  >();

  const hungServices = new Map<string, Set<string>>();
  const pendingReloads = new Map<string, symbol>();
  let shuttingDown = false;
  const needsConfiguration = new Map<string, string>();
  const agentToolProblems = new Map<string, string>();
  const handlerStats = new Map<string, PluginHandlerStats>();
  let boundSdk: OmnyoSdk | undefined;
  let boundLoopbackBaseUrl: string | undefined;
  const rpcCallers = createPluginRpcCallerRegistry();
  let loadHold: PluginLoadHold | null = null;
  let pendingLoads = 0;
  const disposalFailures = new Set<string>();
  const executingInstances = new Set<LoadedPlugin>();

  function frameworkHeld(row: InstalledPluginRow): boolean {
    return (
      isServerMoveFrozen(deps.db) &&
      (isMaintenanceFrozen(deps.db) ||
        !CONNECT_HOLD_SOURCES.some((source) => source === row.source))
    );
  }

  function getMaintenanceActivity() {
    return {
      pluginLoads: pendingLoads,
      pluginInvocations: [...executingInstances].reduce(
        (total, instance) => total + instance.invocations.size,
        0,
      ),
      hungServices:
        [...hungServices.values()].reduce(
          (total, hung) => total + hung.size,
          0,
        ) + disposalFailures.size,
    };
  }

  function publishStatus(
    id: string,
    status: PluginRuntimeStatus,
    detail: string | null,
  ): void {
    statuses.set(id, { status, detail });

    for (const listener of statusListeners.get(id) ?? []) {
      listener(status, detail);
    }
  }

  function setStatus(
    id: string,
    status: PluginRuntimeStatus,
    detail: string | null = null,
  ): void {
    baseStatuses.set(id, { status, detail });
    const buildProblems = devBuildProblems.get(id);
    publishStatus(
      id,
      status,
      [detail, buildProblems?.frontend, buildProblems?.host]
        .filter((part): part is string => part !== null && part !== undefined)
        .join("; ") || null,
    );
  }

  function getStatus(row: Pick<InstalledPluginRow, "id" | "enabled">): {
    status: PluginRuntimeStatus;
    detail: string | null;
  } {
    return (
      statuses.get(row.id) ?? {
        status: row.enabled ? "starting" : "disabled",
        detail: null,
      }
    );
  }

  function setDevBuildProblem(
    id: string,
    kind: PluginDevBuildKind,
    message: string | null,
  ): void {
    const problems = devBuildProblems.get(id) ?? {};

    if (message === null) {
      if (problems[kind] === undefined) return;
      delete problems[kind];
    } else {
      problems[kind] = `${DEV_BUILD_PROBLEM_LABELS[kind]}: ${message}`;
    }

    if (Object.keys(problems).length === 0) devBuildProblems.delete(id);
    else devBuildProblems.set(id, problems);
    const base = baseStatuses.get(id);

    if (base !== undefined) setStatus(id, base.status, base.detail);
  }

  function statsFor(id: string): PluginHandlerStats {
    let stats = handlerStats.get(id);

    if (!stats) {
      stats = { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 };
      handlerStats.set(id, stats);
    }

    return stats;
  }

  function reportNeedsConfiguration(id: string, message: string): void {
    needsConfiguration.set(id, message);
    setStatus(id, "needs-configuration", message);
  }

  function reportAgentToolProblem(id: string, message: string): void {
    agentToolProblems.set(id, message);
    logger.warn(`[plugin:${id}] ${message}`);

    if (statuses.get(id)?.status === "running") {
      setStatus(id, "running", message);
    }
  }

  function findAgentToolOwner(
    name: string,
    excludePluginId: string,
  ): string | undefined {
    for (const [otherId, plugin] of loaded) {
      if (otherId === excludePluginId) continue;

      if (plugin.handle.agentTools.some((tool) => tool.name === name)) {
        return otherId;
      }
    }

    return undefined;
  }

  const serviceContext = new AsyncLocalStorage<ServiceInstance>();

  function runService(id: string, service: ServiceRuntime): void {
    const controller = new AbortController();
    service.controller = controller;
    service.state = "running";
    service.startedAt = Date.now();

    const instance: ServiceInstance = {
      id,
      service,
      controller,
      uncaughtError: undefined,
    };

    const current = serviceContext.run(instance, async () => {
      await service.record.start(controller.signal);
    });

    service.current = current;
    current.then(
      () =>
        instance.uncaughtError === undefined
          ? onServiceSettled(id, service, { crashed: false })
          : onServiceSettled(id, service, {
              crashed: true,
              error: instance.uncaughtError.error,
            }),
      (error: unknown) =>
        onServiceSettled(id, service, {
          crashed: true,
          error: instance.uncaughtError?.error ?? error,
        }),
    );
  }

  const reportedStaleErrors = new WeakSet<PluginContextStaleError>();
  const pluginCodeLocations = new Map<string, string>();

  function pluginOwningStack(error: unknown): string | undefined {
    if (!(error instanceof Error) || typeof error.stack !== "string") {
      return undefined;
    }

    for (const [location, pluginId] of pluginCodeLocations) {
      if (error.stack.includes(location)) return pluginId;
    }

    return undefined;
  }

  function reportStaleError(error: unknown): boolean {
    if (!(error instanceof PluginContextStaleError)) return false;

    if (!reportedStaleErrors.has(error)) {
      reportedStaleErrors.add(error);
      logger.warn(
        { err: error },
        `[plugin:${error.pluginId}] ${error.message}`,
      );
    }

    return true;
  }

  function containPluginError(error: unknown): boolean {
    if (reportStaleError(error)) return true;
    const pluginId = pluginOwningStack(error);

    if (pluginId === undefined) return false;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { err: error },
      `[plugin:${pluginId}] uncaught error: ${message}`,
    );

    if (statuses.get(pluginId)?.status === "running") {
      setStatus(pluginId, "running", `uncaught error: ${message}`);
    }

    return true;
  }

  function handleUncaughtException(error: unknown): boolean {
    const instance = serviceContext.getStore();

    if (instance === undefined) return containPluginError(error);
    const { id, service, controller } = instance;
    const name = service.record.name;
    const message = error instanceof Error ? error.message : String(error);

    if (service.controller !== controller || service.disposed) {
      logger.warn(
        `[plugin:${id}] service ${name} raised an uncaught exception from a stopped run: ${message}`,
      );

      return true;
    }

    if (instance.uncaughtError !== undefined) return true;
    instance.uncaughtError = { error };
    logger.warn(
      { err: error },
      `[plugin:${id}] service ${name} raised an uncaught exception outside start(): ${message} — aborting it`,
    );
    const current = service.current;
    controller.abort();

    if (current === null) return true;

    const stopTimeoutMs =
      service.record.experimental_stopTimeoutMs ?? serviceStopTimeoutMs;

    void settledWithin(current, stopTimeoutMs).then((settled) => {
      if (settled || service.controller !== controller || service.disposed) {
        return;
      }

      setStatus(
        id,
        "degraded",
        `service ${name} did not stop after an uncaught exception`,
      );
      logger.warn(
        `[plugin:${id}] service ${name} did not stop within ${stopTimeoutMs}ms of its uncaught exception — plugin degraded until it does`,
      );
    });

    return true;
  }

  function onServiceSettled(
    id: string,
    service: ServiceRuntime,
    outcome: { crashed: false } | { crashed: true; error: unknown },
  ): void {
    service.current = null;
    service.controller = null;

    if (service.disposed) return;
    const name = service.record.name;

    if (!outcome.crashed) {
      service.state = "stopped";
      logger.info(`[plugin:${id}] service ${name} stopped`);

      return;
    }

    if (isNeedsConfigurationError(outcome.error)) {
      service.state = "stopped";
      reportNeedsConfiguration(
        id,
        outcome.error.message || `service ${name} needs configuration`,
      );
      logger.info(
        `[plugin:${id}] service ${name} needs configuration; not restarting until reload`,
      );

      return;
    }

    const message =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);

    if (stabilizingPluginIds.has(id)) {
      service.state = "stopped";
      setStatus(id, "error", `service ${name} crashed: ${message}`);
      logger.warn(
        `[plugin:${id}] service ${name} crashed during activation: ${message}`,
      );

      return;
    }

    if (Date.now() - service.startedAt >= SERVICE_HEALTHY_RESET_MS) {
      service.consecutiveCrashes = 0;
    }

    const delayMs = calculateExponentialBackoffDelay({
      attempt: service.consecutiveCrashes + 1,
      baseDelayMs: serviceRestartBaseMs,
      maxDelayMs: SERVICE_RESTART_MAX_MS,
    });

    service.consecutiveCrashes += 1;
    service.state = "backoff";
    logger.warn(
      `[plugin:${id}] service ${name} crashed: ${message} — restarting in ${delayMs}ms`,
    );

    const timer = setTimeout(() => {
      service.restartTimer = null;

      if (!service.disposed) runService(id, service);
    }, delayMs);

    timer.unref?.();
    service.restartTimer = timer;
  }

  async function stopServices(id: string, plugin: LoadedPlugin): Promise<void> {
    for (const service of plugin.services) {
      service.disposed = true;

      if (service.restartTimer !== null) {
        clearTimeout(service.restartTimer);
        service.restartTimer = null;
      }

      service.controller?.abort();
    }

    for (const service of plugin.services) {
      const current = service.current;
      const name = service.record.name;

      if (current !== null) {
        const stopTimeoutMs =
          service.record.experimental_stopTimeoutMs ?? serviceStopTimeoutMs;

        const stopped = await settledWithin(current, stopTimeoutMs);

        if (!stopped) {
          let hung = hungServices.get(id);

          if (!hung) {
            hung = new Set();
            hungServices.set(id, hung);
          }

          hung.add(name);
          setStatus(id, "degraded", `service ${name} did not stop`);
          logger.warn(
            `[plugin:${id}] service ${name} did not stop within ${stopTimeoutMs}ms — plugin degraded until it does`,
          );
          void current.then(
            () => onHungServiceSettled(id, name),
            () => onHungServiceSettled(id, name),
          );
        }
      }

      service.state = "stopped";
    }
  }

  function onHungServiceSettled(id: string, name: string): void {
    const hung = hungServices.get(id);

    if (!hung) return;
    hung.delete(name);

    logger.info(`[plugin:${id}] service ${name} eventually stopped`);

    if (hung.size > 0) return;
    hungServices.delete(id);
    const intent = pendingReloads.get(id);
    void withLifecycleLock(id, async () => {
      if ((hungServices.get(id)?.size ?? 0) > 0) return;

      if (intent === undefined) {
        const row = getInstalledPlugin(deps.db, id);

        if (row !== undefined && !row.enabled) {
          setStatus(id, "disabled");
          await context.afterDeferredLifecycle?.();
        }

        return;
      }

      if (shuttingDown || pendingReloads.get(id) !== intent) return;
      const row = getInstalledPlugin(deps.db, id);

      if (row === undefined || !row.enabled || loaded.has(id)) {
        pendingReloads.delete(id);

        return;
      }

      await loadOne(row);
      await context.afterDeferredLifecycle?.();
    }).catch((error) => {
      logger.warn(
        { err: error },
        `[plugin:${id}] deferred reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  const recordOwners = new WeakMap<object, LoadedPlugin>();

  function ownedRecord<R extends object>(record: R, owner: LoadedPlugin): R {
    recordOwners.set(record, owner);

    return record;
  }

  function listPluginHooks<K extends PluginHookName>(
    hook: K,
  ): PluginHookRegistration<K>[] {
    const registrations: PluginHookRegistration<K>[] = [];

    for (const [id, plugin] of loaded) {
      const handler = plugin.handle.hooks[hook];

      if (handler !== null) {
        registrations.push(ownedRecord({ pluginId: id, handler }, plugin));
      }
    }

    return registrations;
  }

  function resolveRegisteredProviderIcon(
    pluginId: string,
    plugin: LoadedPlugin,
    icon: string | null,
  ): ReturnType<typeof readPluginProviderIcon> {
    const declared = icon === null ? null : parseNamespacedGlyph(icon);

    return declared !== null
      ? (brandingAssets.get(pluginId)?.icons.get(declared.name) ?? null)
      : readPluginProviderIcon(plugin.manifest.rootDir, icon ?? undefined);
  }

  function listPluginEnvironmentCompositions() {
    return Array.from(loaded).flatMap(([pluginId, plugin]) =>
      Array.from(
        plugin.handle.environmentCompositions.values(),
        (composition) => {
          const icon = resolveRegisteredProviderIcon(
            pluginId,
            plugin,
            composition.icon,
          );

          return ownedRecord(
            { pluginId, composition, ...(icon === null ? {} : { icon }) },
            plugin,
          );
        },
      ),
    );
  }

  function collectUniqueProviderRecords<
    P extends { id: string; icon: string | null },
  >(kindLabel: string, select: (plugin: LoadedPlugin) => Iterable<P>) {
    const records: Array<{
      pluginId: string;
      provider: P;
      icon?: NonNullable<ReturnType<typeof readPluginProviderIcon>>;
    }> = [];

    const seen = new Set<string>();

    for (const [pluginId, plugin] of loaded) {
      for (const provider of select(plugin)) {
        if (seen.has(provider.id)) {
          logger.warn(
            `[plugin:${pluginId}] ${kindLabel} provider "${provider.id}" is already registered by another plugin; ignoring`,
          );
          continue;
        }

        seen.add(provider.id);

        const icon = resolveRegisteredProviderIcon(
          pluginId,
          plugin,
          provider.icon,
        );

        records.push(
          ownedRecord(
            { pluginId, provider, ...(icon === null ? {} : { icon }) },
            plugin,
          ),
        );
      }
    }

    return records;
  }

  function listPluginEnvironmentProviders(): PluginEnvironmentProviderRecord[] {
    return collectUniqueProviderRecords("environment", (plugin) =>
      plugin.handle.environmentProviders.values(),
    );
  }

  function getPluginEnvironmentProvider(
    id: string,
  ): PluginEnvironmentProviderRecord | undefined {
    return listPluginEnvironmentProviders().find(
      (record) => record.provider.id === id,
    );
  }

  function listPluginEventSources() {
    return [...loaded].flatMap(([pluginId, plugin]) =>
      [...plugin.handle.eventSources.values()].map((source) =>
        ownedRecord({ pluginId, source }, plugin),
      ),
    );
  }

  function listPluginServerAccessProviders() {
    return [...loaded].flatMap(([pluginId, plugin]) =>
      [...plugin.handle.serverAccessProviders.values()].map((provider) =>
        ownedRecord({ pluginId, provider }, plugin),
      ),
    );
  }

  function listPluginMachineProviders(): PluginMachineProviderRecord[] {
    return collectUniqueProviderRecords("machine", (plugin) =>
      plugin.handle.machineProviders.values(),
    );
  }

  function getPluginMachineProvider(
    id: string,
  ): PluginMachineProviderRecord | undefined {
    return listPluginMachineProviders().find(
      (record) => record.provider.id === id,
    );
  }

  function hasThreadEventHandlers(event: PluginThreadEventName): boolean {
    if (loaded.size === 0) return false;

    for (const plugin of loaded.values()) {
      if (plugin.handle.threadEventHandlers[event].length > 0) return true;
    }

    return false;
  }

  type PluginInvocationOutcome<T> =
    | { ok: true; value: T }
    | { ok: false; error: string; cause: unknown };

  async function invokeWrapped<T>(
    instance: LoadedPlugin,
    label: string,
    run: (signal: AbortSignal) => T | Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<PluginInvocationOutcome<T>> {
    const id = instance.pluginId;
    const row = getInstalledPlugin(deps.db, id);

    if (row !== undefined && frameworkHeld(row)) {
      return {
        ok: false,
        error: "Plugin work is held for server maintenance",
        cause: new Error("Plugin admission held"),
      };
    }

    const released = instance.released.signal;

    if (released.aborted) {
      return {
        ok: false,
        error: `${label} not started: plugin "${id}" was reloaded or disabled`,
        cause: undefined,
      };
    }

    const lifetime = instance.stopping.signal.aborted
      ? released
      : instance.stopping.signal;

    const signal =
      callerSignal === undefined
        ? lifetime
        : AbortSignal.any([callerSignal, lifetime]);

    const stats = statsFor(id);
    const startedAt = performance.now();

    const execution = runEventLoopWork(`plugin:${id} ${label}`, () =>
      run(signal),
    );

    const settled = execution.then(
      () => undefined,
      () => undefined,
    );

    instance.invocations.add(settled);
    executingInstances.add(instance);
    void settled.then(() => {
      instance.invocations.delete(settled);

      if (instance.invocations.size === 0) executingInstances.delete(instance);
      const elapsedMs = performance.now() - startedAt;
      stats.count += 1;
      stats.totalMs += elapsedMs;

      if (elapsedMs > stats.maxMs) stats.maxMs = elapsedMs;
    });
    let releaseCaller: (() => void) | undefined;

    const callerReleased = new Promise<never>((_resolve, reject) => {
      releaseCaller = () =>
        reject(
          new Error(
            `plugin "${id}" was reloaded or disabled before ${label} finished`,
          ),
        );
      released.addEventListener("abort", releaseCaller, { once: true });
    });

    try {
      return {
        ok: true,
        value: await Promise.race([execution, callerReleased]),
      };
    } catch (error) {
      const message = getErrorMessage(error);
      stats.errorCount += 1;

      if (!reportStaleError(error)) {
        logger.warn(
          { err: error },
          `[plugin:${id}] ${label} failed: ${message}`,
        );

        if (
          loaded.get(id) === instance &&
          statuses.get(id)?.status === "running"
        ) {
          setStatus(id, "running", `${label} failed: ${message}`);
        }
      }

      return { ok: false, error: message, cause: error };
    } finally {
      if (releaseCaller !== undefined) {
        released.removeEventListener("abort", releaseCaller);
      }

      void execution.catch((error: unknown) => {
        if (released.aborted && !reportStaleError(error)) {
          logger.warn(
            { err: error },
            `[plugin:${id}] ${label} failed after its caller was released: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }
  }

  async function invokeOwned<T>(
    record: object,
    label: string,
    run: () => Promise<T>,
  ): Promise<PluginHookInvocation<T>> {
    const owner = recordOwners.get(record);

    if (
      owner === undefined ||
      loaded.get(owner.pluginId) !== owner ||
      owner.stopping.signal.aborted
    ) {
      return {
        ok: false,
        error: `${label} has no current loaded plugin owner`,
      };
    }

    const outcome = await invokeWrapped(owner, label, () => run());

    return outcome.ok
      ? { ok: true, value: outcome.value }
      : { ok: false, error: outcome.error };
  }

  async function drainInvocations(instance: LoadedPlugin): Promise<void> {
    if (instance.invocations.size === 0) return;

    const drained = await settledWithin(
      Promise.all([...instance.invocations]),
      serviceStopTimeoutMs,
    );

    if (!drained) {
      logger.warn(
        `plugin ${instance.pluginId}: ${instance.invocations.size} in-flight invocation(s) did not settle before dispose; releasing their callers`,
      );
    }
  }

  async function waitForWebSocketsClosed(
    instance: LoadedPlugin,
  ): Promise<void> {
    const deadline = Date.now() + serviceStopTimeoutMs;

    while (
      instance.handle.websocketRoutes.some((route) => route.sockets.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function emitThreadEvent<E extends PluginThreadEventName>(
    event: E,
    buildPayload: () => PluginThreadEventPayloads[E] | null,
    appended?: { threadId: string; batch: PluginThreadEventBatch | undefined },
  ): void {
    if (!hasThreadEventHandlers(event)) return;
    setImmediate(() => {
      const subscriptions = [...loaded.values()].map((plugin) => ({
        plugin,
        handlers: [...plugin.handle.threadEventHandlers[event]].filter(
          (handler) => {
            const filter = plugin.handle.threadEventFilters.get(handler);

            return (
              filter === undefined ||
              appended === undefined ||
              filter(appended.threadId, appended.batch)
            );
          },
        ),
      }));

      if (subscriptions.every(({ handlers }) => handlers.length === 0)) return;
      let payload: PluginThreadEventPayloads[E] | null;

      try {
        payload = buildPayload();
      } catch (error) {
        logger.warn(
          `failed to build ${event} plugin event payload: ${error instanceof Error ? error.message : String(error)}`,
        );

        payload = null;
      }

      if (payload === null) {
        if (appended !== undefined) {
          for (const { plugin, handlers } of subscriptions) {
            for (const handler of handlers) {
              plugin.handle.threadEventFilters.get(handler)?.(
                appended.threadId,
                undefined,
              );
            }
          }
        }

        return;
      }

      const delivered = payload;

      for (const { plugin, handlers } of subscriptions) {
        for (const handler of handlers) {
          void invokeWrapped(plugin, `${event} handler`, () =>
            handler(delivered),
          ).then((outcome) => {
            if (!outcome.ok && appended !== undefined) {
              plugin.handle.threadEventFilters.get(handler)?.(
                appended.threadId,
                undefined,
              );
            }
          });
        }
      }
    });
  }

  function buildQueuedMessageEventEmitter(
    event: Extract<PluginThreadEventName, `message.${string}`>,
  ): (entry: ThreadQueuedMessage) => void {
    return (entry) => {
      emitThreadEvent(event, () => ({ entry }));
    };
  }

  function buildThreadDto(thread: Thread) {
    return {
      ...toThreadResponseFromThread({ db: deps.db, hub: deps.hub }, { thread }),
      experimental_maintenance: activeMaintenanceKind(deps.db, thread),
    };
  }

  function checkEngineRange(manifest: PluginManifest): string | undefined {
    if (!manifest.coreEngineRange) return undefined;
    const version = semver.coerce(deps.appVersion);

    if (!version) {
      logger.warn(
        `cannot parse app version "${deps.appVersion}" for engines check; skipping`,
      );

      return undefined;
    }

    if (version.major === 0 && version.minor === 0 && version.patch === 0) {
      return undefined;
    }

    if (!semver.satisfies(version, manifest.coreEngineRange)) {
      return `requires Omnyo ${manifest.coreEngineRange}, this is ${version.version}`;
    }

    return undefined;
  }

  function checkPluginSdkRange(manifest: PluginManifest): string | undefined {
    if (!manifest.pluginSdkRange) return undefined;

    if (!isPluginSdkRangeSatisfied(manifest.pluginSdkRange)) {
      return pluginSdkRangeProblem(manifest.pluginSdkRange);
    }

    return undefined;
  }

  async function runFactoryTimeBoxed(
    factory: (api: PluginApi) => unknown,
    api: PluginApi,
  ): Promise<void> {
    await raceTimeout(
      Promise.resolve().then(() => factory(api)),
      loadTimeoutMs,
      `load timed out after ${loadTimeoutMs}ms`,
    );
  }

  function sourceKind(source: string): "path" | "git" | "npm" | "builtin" {
    try {
      return parsePluginSource(source).kind;
    } catch {
      return "path";
    }
  }

  function isPackagedBuiltinEntry(args: {
    kind: ReturnType<typeof sourceKind>;
    manifest: PluginManifest;
    rootDir: string;
    artifact: "app" | "server" | "host";
  }): boolean {
    const entry = {
      app: args.manifest.appEntry,
      server: args.manifest.serverEntry,
      host: args.manifest.hostEntry,
    }[args.artifact];

    return (
      args.kind === "builtin" &&
      entry === resolve(args.rootDir, "dist", `${args.artifact}.js`)
    );
  }

  async function packagedBuiltinArtifactProblem(
    row: InstalledPluginRow,
    manifest: PluginManifest,
  ): Promise<string | null> {
    const kind = sourceKind(row.source);

    if (
      !isPackagedBuiltinEntry({
        kind,
        manifest,
        rootDir: row.rootDir,
        artifact: "server",
      })
    ) {
      return null;
    }

    async function validate(
      artifact: "server" | "app" | "host",
    ): Promise<string | null> {
      let raw: string;

      try {
        raw = await readFile(
          join(row.rootDir, "dist", `${artifact}.meta.json`),
          "utf8",
        );
      } catch {
        return `${artifact} artifact for plugin "${manifest.id}" is missing dist/${artifact}.meta.json`;
      }

      return validatePluginArtifactMeta({
        artifact,
        raw,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
      });
    }

    const serverProblem = await validate("server");

    if (serverProblem !== null) return serverProblem;

    if (
      isPackagedBuiltinEntry({
        kind,
        manifest,
        rootDir: row.rootDir,
        artifact: "app",
      })
    ) {
      const appProblem = await validate("app");

      if (appProblem !== null) return appProblem;
    }

    if (
      isPackagedBuiltinEntry({
        kind,
        manifest,
        rootDir: row.rootDir,
        artifact: "host",
      })
    ) {
      return validate("host");
    }

    return null;
  }

  function isPrebuiltServerSdkCompatible(
    meta: { sdkMajor: number; sdkVersion: string } | null,
  ): boolean {
    if (!isPluginArtifactRuntimeCompatible(meta)) return false;

    if (meta === null) return false;

    if (PLUGIN_SDK_MAJOR === 0) return meta.sdkVersion === PLUGIN_SDK_VERSION;

    return true;
  }

  async function isMutableAppBundleStale(rootDir: string): Promise<boolean> {
    let artifactMtimeMs: number;

    try {
      artifactMtimeMs = (await stat(join(rootDir, "dist", "app.js"))).mtimeMs;
    } catch {
      return true;
    }

    const pendingDirectories = [""];

    while (pendingDirectories.length > 0) {
      const relativeDirectory = pendingDirectories.pop();

      if (relativeDirectory === undefined) break;
      const directory = join(rootDir, relativeDirectory);
      let entries;

      try {
        const directoryStats = await stat(directory);

        if (directoryStats.mtimeMs > artifactMtimeMs) return true;
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return true;
      }

      for (const entry of entries) {
        const relativePath = join(relativeDirectory, entry.name);

        if (isIgnoredPluginDevPath(relativePath)) continue;

        try {
          const entryStats = await stat(join(rootDir, relativePath));

          if (entryStats.mtimeMs > artifactMtimeMs) return true;
        } catch {
          return true;
        }

        if (entry.isDirectory()) pendingDirectories.push(relativePath);
      }
    }

    return false;
  }

  type ResolvedServerEntry = {
    path: string;
    digest: string;
    loader: "cjs" | "esm";
  };

  async function packageScopeIsEsm(
    entryPath: string,
    rootDir: string,
  ): Promise<boolean> {
    const directories = [dirname(entryPath), rootDir];

    for (const directory of new Set(directories)) {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );

        if (typeof parsed !== "object" || parsed === null) return false;

        if ("type" in parsed) return Reflect.get(parsed, "type") === "module";
      } catch {}
    }

    return false;
  }

  async function verifyImmutableInstalledArtifact(
    row: InstalledPluginRow,
    manifest: PluginManifest,
  ): Promise<PluginArtifactRow | undefined> {
    if (row.activeArtifactId === null || row.sourceKind === "builtin")
      return undefined;
    const artifact = getPluginArtifact(deps.db, row.activeArtifactId);

    if (
      !row.activeArtifactId.startsWith("identity_v1_") &&
      artifact?.sourceKind !== "path"
    )
      return undefined;

    if (
      artifact === undefined ||
      artifact.pluginId !== row.id ||
      artifact.sourceKind !== row.sourceKind ||
      artifact.validationResult !== "valid" ||
      artifact.path !== row.rootDir ||
      artifact.contentHash === null ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.contentHash)
    )
      throw new Error(
        "Immutable installed plugin artifact differs from its verified record",
      );
    const rootInfo = await lstat(row.rootDir);

    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      realpathSync(row.rootDir) !== row.rootDir ||
      !row.rootDir.startsWith(resolve(deps.dataDir, "plugins/cache") + sep)
    )
      throw new Error(
        "Immutable plugin artifact is outside its installed owner",
      );

    if ((await hashInstallDir(row.rootDir)) !== artifact.contentHash)
      throw new Error(
        "Immutable installed plugin bytes differ from their verified digest",
      );
    const surfaces: Array<"server" | "app" | "host"> = ["server"];

    if (manifest.appEntry !== undefined) surfaces.push("app");

    if (manifest.hostEntry !== undefined) surfaces.push("host");

    for (const surface of surfaces) {
      const problem = validatePluginArtifactMeta({
        artifact: surface,
        raw: await readFile(
          join(row.rootDir, "dist", `${surface}.meta.json`),
          "utf8",
        ),
        pluginId: row.id,
        pluginVersion: row.version,
      });

      if (problem !== null) throw new Error(problem);
    }

    if (
      !(await packageScopeIsEsm(
        join(row.rootDir, "dist/server.js"),
        row.rootDir,
      ))
    )
      throw new Error(
        "Immutable server artifact requires an explicit ESM package scope",
      );

    return artifact;
  }

  async function resolveServerEntry(
    row: InstalledPluginRow,
    manifest: PluginManifest,
    immutableArtifact: PluginArtifactRow | undefined,
  ): Promise<ResolvedServerEntry> {
    if (immutableArtifact !== undefined) {
      const path = join(immutableArtifact.path, "dist/server.js");

      return { path, digest: (await hashFile(path)).digest, loader: "esm" };
    }

    async function buildSource(
      serverEntry = manifest.serverEntry,
    ): Promise<ResolvedServerEntry> {
      const built = await withArtifactLock(`server:${row.id}`, async () =>
        buildCachedPluginServer({
          rootDir: row.rootDir,
          dataDir: deps.dataDir,
          pluginId: row.id,
          sdkVersion: PLUGIN_SDK_VERSION,
          coreVersion: deps.appVersion,
          validatedConfig: {
            serverEntry,
            packageName: manifest.packageName,
            pluginVersion: manifest.version,
          },
          toolchain: () => getPluginBuildToolchain(deps),
          runtimeImports: {
            [PLUGIN_SDK_SPECIFIER]: {
              path: pluginSdkRuntimeEntry,
            },
            "better-sqlite3": {
              path: runtimeRequire.resolve("better-sqlite3"),
              external: true,
            },
          },
          fallbackResolve: (specifier) => {
            try {
              const resolved = import.meta.resolve(specifier);

              return resolved.startsWith("file:")
                ? fileURLToPath(resolved)
                : resolved;
            } catch {}

            try {
              return runtimeRequire.resolve(specifier);
            } catch {
              return undefined;
            }
          },
        }),
      );

      return { ...built, loader: "cjs" };
    }

    if (row.sourceKind === "path") return buildSource();

    if (
      row.sourceKind === "builtin" &&
      !isPackagedBuiltinEntry({
        kind: row.sourceKind,
        manifest,
        rootDir: row.rootDir,
        artifact: "server",
      })
    ) {
      if (initializedSourceBuiltinIds.has(row.id)) return buildSource();
      initializedSourceBuiltinIds.add(row.id);
      const { digest } = await hashFile(manifest.serverEntry);

      return { path: manifest.serverEntry, digest, loader: "esm" };
    }

    const distJsPath = join(row.rootDir, "dist", "server.js");

    try {
      await stat(distJsPath);
    } catch {
      return buildSource();
    }

    let meta: { sdkMajor: number; sdkVersion: string } | null = null;

    try {
      meta = parsePluginAppBundleMeta(
        await readFile(join(row.rootDir, "dist", "server.meta.json"), "utf8"),
      );
    } catch {}

    if (!isPrebuiltServerSdkCompatible(meta)) {
      logger.warn(
        `plugin ${row.id}: ignoring prebuilt dist/server.js (built with SDK ${meta?.sdkVersion ?? "unknown"}, running SDK is ${PLUGIN_SDK_VERSION}) — loading from source`,
      );

      return buildSource();
    }

    const { digest } = await hashFile(distJsPath);

    if (await packageScopeIsEsm(distJsPath, row.rootDir)) {
      return { path: distJsPath, digest, loader: "esm" };
    }

    return buildSource(distJsPath);
  }

  async function loadAppBundleCandidate(
    row: InstalledPluginRow,
    manifest: PluginManifest,
    immutableArtifact: PluginArtifactRow | undefined,
  ): Promise<{
    snapshot: PluginAppBundleSnapshot;
    problem: string | null;
  }> {
    if (manifest.appEntry === undefined) {
      return {
        snapshot: { state: { hasApp: false, bundle: null }, assets: null },
        problem: null,
      };
    }

    const kind = row.sourceKind;

    if (
      immutableArtifact === undefined &&
      (kind === "path" || kind === "builtin") &&
      !isPackagedBuiltinEntry({
        kind,
        manifest,
        rootDir: row.rootDir,
        artifact: "app",
      })
    ) {
      const meta = await readPluginAppBundleMeta(row.rootDir);
      const sdkChanged = meta?.sdkVersion !== PLUGIN_SDK_VERSION;

      const sourceChanged =
        !sdkChanged && (await isMutableAppBundleStale(row.rootDir));

      if (sdkChanged || sourceChanged) {
        const reason = sdkChanged
          ? `built with SDK ${meta?.sdkVersion ?? "unknown"}, running SDK is ${PLUGIN_SDK_VERSION}`
          : "plugin source is newer than dist/app.js";

        logger.info(`plugin ${row.id}: rebuilding frontend bundle (${reason})`);

        try {
          await buildPluginApp(
            row.rootDir,
            deps.appVersion,
            await getPluginBuildToolchain(deps),
          );
          setDevBuildProblem(row.id, "frontend", null);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);

          logger.warn(
            `plugin ${row.id}: frontend bundle rebuild failed: ${message}`,
          );

          return {
            snapshot: { state: { hasApp: true, bundle: null }, assets: null },
            problem: `frontend bundle rebuild failed: ${message}`,
          };
        }
      }
    }

    return {
      snapshot: await loadPluginAppBundle(row.id, row.rootDir),
      problem: null,
    };
  }

  async function loadHostArtifactCandidate(
    row: InstalledPluginRow,
    manifest: PluginManifest,
    allowPersistedGeneration: boolean,
    immutableArtifact: PluginArtifactRow | undefined,
  ): Promise<PluginHostArtifactSnapshot | null> {
    if (manifest.hostEntry === undefined) return null;
    const kind = row.sourceKind;

    if (
      immutableArtifact === undefined &&
      (kind === "path" || kind === "builtin") &&
      !isPackagedBuiltinEntry({
        kind,
        manifest,
        rootDir: row.rootDir,
        artifact: "host",
      })
    ) {
      let validMetadata = false;

      try {
        validMetadata =
          validatePluginArtifactMeta({
            artifact: "host",
            raw: await readFile(
              join(row.rootDir, "dist", "host.meta.json"),
              "utf8",
            ),
            pluginId: manifest.id,
            pluginVersion: manifest.version,
          }) === null;
      } catch {}

      if (
        !validMetadata ||
        !(await isPluginHostArtifactFresh(row.rootDir, deps.appVersion))
      ) {
        await buildPluginHost(
          row.rootDir,
          deps.appVersion,
          await getPluginBuildToolchain(deps),
        );
      }

      setDevBuildProblem(row.id, "host", null);
    }

    const jsPath = join(row.rootDir, "dist", "host.js");
    const metaPath = join(row.rootDir, "dist", "host.meta.json");

    const artifactStats = await stat(jsPath).catch((error) => {
      throw new Error(
        `host artifact for plugin "${manifest.id}" is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (artifactStats.size > HOST_ARTIFACT_MAX_BYTES) {
      throw new Error(
        `host artifact for plugin "${manifest.id}" exceeds the ${HOST_ARTIFACT_MAX_BYTES} byte limit`,
      );
    }

    const [artifact, rawMeta] = await Promise.all([
      hashFile(jsPath),
      readFile(metaPath, "utf8"),
    ]).catch((error) => {
      throw new Error(
        `host artifact for plugin "${manifest.id}" is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (artifact.byteLength > HOST_ARTIFACT_MAX_BYTES) {
      throw new Error(
        `host artifact for plugin "${manifest.id}" exceeds the ${HOST_ARTIFACT_MAX_BYTES} byte limit`,
      );
    }

    const metadataProblem = validatePluginArtifactMeta({
      artifact: "host",
      raw: rawMeta,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
    });

    if (metadataProblem !== null) throw new Error(metadataProblem);
    let declaredDigest: unknown;

    try {
      const parsed: unknown = JSON.parse(rawMeta);
      declaredDigest =
        typeof parsed === "object" && parsed !== null
          ? Reflect.get(parsed, "artifactDigest")
          : undefined;
    } catch {
      declaredDigest = undefined;
    }

    const digest = artifact.digest;

    if (declaredDigest !== digest) {
      throw new Error(
        `host artifact for plugin "${manifest.id}" has digest ${String(declaredDigest)}, expected ${digest}`,
      );
    }

    const persisted = getPluginHostGeneration(deps.db, row.id);

    const generation =
      allowPersistedGeneration &&
      !loaded.has(row.id) &&
      persisted?.digest === digest &&
      persisted.byteLength === artifact.byteLength
        ? persisted.generation
        : randomUUID();

    return {
      path: jsPath,
      byteLength: artifact.byteLength,
      digest,
      generation,
    };
  }

  async function populateIdentity(row: InstalledPluginRow): Promise<void> {
    try {
      const manifest = await readPluginManifest(row.rootDir);
      identities.set(row.id, {
        manifest,
        brandingAssets: await loadPluginBrandingAssets(row.id, manifest),
      });
    } catch {
      identities.delete(row.id);
    }
  }

  function disposeUnavailableProviderRegistrations(pluginId: string): void {
    const registrations = unavailableProviderRegistrations.get(pluginId);

    if (registrations === undefined) return;
    unavailableProviderRegistrations.delete(pluginId);

    for (const registration of registrations) registration.dispose();
  }

  function providerInstallRank(row: InstalledPluginRow): ProviderInstallRank {
    const name = row.sourceKind === "builtin" ? row.sourceBuiltinName : null;

    const bundledIndex =
      name === null
        ? -1
        : BUNDLED_PLUGINS.findIndex((plugin) => plugin.name === name);

    return {
      bundledIndex: bundledIndex === -1 ? null : bundledIndex,
      installedAt: row.installedAt,
    };
  }

  function registerPluginProvider(args: {
    available: boolean;
    declaration: NormalizedPluginProviderDeclaration;
    row: InstalledPluginRow;
    settingsDescriptors: PluginSettingDescriptors;
    brandingAssets: PluginBrandingAssetSet;
  }): { dispose(): void } {
    if (!deps.providerRegistry) {
      throw new Error("the provider registry is unavailable in this host");
    }

    const declaredIcon =
      args.declaration.icon === undefined
        ? null
        : parseNamespacedGlyph(args.declaration.icon);

    let icon: { bytes: Uint8Array; contentType: string; hash: string } | null;

    if (declaredIcon !== null) {
      const asset =
        declaredIcon.pluginId === args.row.id
          ? args.brandingAssets.icons.get(declaredIcon.name)
          : undefined;

      if (asset === undefined) {
        throw new Error(
          `provider "${args.declaration.id}" icon "${args.declaration.icon}" is not an icon declared by plugin "${args.row.id}"`,
        );
      }

      icon = {
        bytes: asset.bytes,
        contentType: asset.contentType,
        hash: asset.hash,
      };
    } else {
      icon = readPluginProviderIcon(args.row.rootDir, args.declaration.icon);
    }

    return deps.providerRegistry.register({
      ...buildPluginProviderRegistration({
        available: args.available,
        pluginId: args.row.id,
        declaration: args.declaration,
        iconHash: icon?.hash ?? null,
        readSettings: () =>
          readPluginSettingsValuesSync({
            db: deps.db,
            pluginId: args.row.id,
            descriptors: args.settingsDescriptors,
          }),
      }),
      ...(icon === null ? {} : { icon }),
      pluginId: args.row.id,
      iconNames: new Set(args.brandingAssets.icons.keys()),
      installRank: providerInstallRank(args.row),
    });
  }

  function replaceUnavailableProviderRegistrations(
    row: InstalledPluginRow,
    declarations: readonly NormalizedPluginProviderDeclaration[],
    settingsDescriptors: PluginSettingDescriptors,
    brandingAssets: PluginBrandingAssetSet,
  ): void {
    disposeUnavailableProviderRegistrations(row.id);
    const registrations: Array<{ dispose(): void }> = [];

    try {
      for (const declaration of declarations) {
        registrations.push(
          registerPluginProvider({
            available: false,
            declaration,
            row,
            settingsDescriptors,
            brandingAssets,
          }),
        );
      }
    } catch (error) {
      for (const registration of registrations) registration.dispose();
      throw error;
    }

    if (registrations.length > 0) {
      unavailableProviderRegistrations.set(row.id, registrations);
    }
  }

  function hungServicesDetail(hung: ReadonlySet<string>): string {
    return `service ${[...hung].join(", ")} did not stop`;
  }

  async function runDisposeHooks(
    plugin: LoadedPlugin,
    options: { errors?: unknown[]; deadline?: number },
  ): Promise<void> {
    for (const hook of plugin.handle.disposeHooks.splice(0).reverse()) {
      try {
        const work = hook();

        if (work !== undefined && options.deadline !== undefined) {
          await raceTimeout(
            work,
            Math.max(0, options.deadline - Date.now()),
            "candidate disposal deadline exceeded",
          );
        } else {
          await work;
        }
      } catch (error) {
        options.errors?.push(error);
        logger.warn(
          `plugin ${plugin.pluginId} dispose hook failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function discardCandidate(candidate: LoadedPlugin): Promise<void> {
    candidate.stopping.abort();

    try {
      deps.pendingInteractions?.interruptOwnedPluginInteractions(candidate);
    } catch (error) {
      logger.warn(
        `plugin ${candidate.pluginId} interaction cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await runDisposeHooks(candidate, {
      deadline: Date.now() + serviceStopTimeoutMs,
    });

    for (const database of candidate.handle.databaseHandles.splice(0)) {
      try {
        database.close();
      } catch {}
    }

    candidate.released.abort();
    candidate.handle.invalidate();
  }

  function setLoadHold(hold: PluginLoadHold | null): void {
    loadHold = hold;
  }

  async function heldDetail(row: InstalledPluginRow): Promise<string | null> {
    if (frameworkHeld(row)) return "Paused for server maintenance";
    const hold = loadHold;

    if (hold === null || !row.enabled || !hold.sources.includes(row.source)) {
      return null;
    }

    return (await hold.isActive()) ? hold.detail : null;
  }

  function isSafeModeExempt(args: {
    provenance: InstalledPluginRow["provenance"];
    builtinName: string | null;
  }): boolean {
    return (
      args.provenance === "builtin" ||
      (args.builtinName !== null &&
        context.includedBuiltinNames.has(args.builtinName))
    );
  }

  function isSafeModeExemptRow(
    row: Pick<
      InstalledPluginRow,
      "provenance" | "sourceKind" | "sourceBuiltinName"
    >,
  ): boolean {
    return isSafeModeExempt({
      provenance: row.provenance,
      builtinName: row.sourceKind === "builtin" ? row.sourceBuiltinName : null,
    });
  }

  function isSuppressedBySafeMode(
    row: Pick<
      InstalledPluginRow,
      "enabled" | "provenance" | "sourceKind" | "sourceBuiltinName"
    >,
  ): boolean {
    return (
      row.enabled && !isSafeModeExemptRow(row) && getPluginSafeMode(deps.db)
    );
  }

  function safeModeActivationRefusal(
    args: SafeModeActivationRefusalArgs,
  ): string | null {
    if (isSafeModeExempt(args) || !getPluginSafeMode(deps.db)) return null;

    return `plugin safe mode is on; turn it off with \`omnyo plugin safe-mode off\` before you ${args.action} "${args.pluginId}"`;
  }

  async function loadOne(
    row: InstalledPluginRow,
    allowPersistedGeneration = false,
  ): Promise<string | null> {
    pendingLoads++;

    try {
      return await loadOneInner(row, allowPersistedGeneration);
    } finally {
      pendingLoads--;
    }
  }

  async function loadOneInner(
    row: InstalledPluginRow,
    allowPersistedGeneration: boolean,
  ): Promise<string | null> {
    pendingReloads.delete(row.id);

    if (shuttingDown) return null;
    const intent = Symbol(row.id);
    const held = await heldDetail(row);

    if (held !== null) {
      await disposeOne(row.id);
      await populateIdentity(row);
      setStatus(row.id, "disabled", held);
      logger.warn(`plugin ${row.id} not loaded (held): ${held}`);

      return null;
    }

    if (isSuppressedBySafeMode(row)) {
      await disposeOne(row.id);
      await populateIdentity(row);

      if ((hungServices.get(row.id)?.size ?? 0) === 0) {
        setStatus(row.id, "disabled", PLUGIN_SAFE_MODE_DETAIL);
      }

      return null;
    }

    if (row.enabled && !loaded.has(row.id)) setStatus(row.id, "starting");
    await populateIdentity(row);

    if (!row.enabled) {
      await disposeOne(row.id);
      setStatus(row.id, "disabled");

      return null;
    }

    const previous = loaded.get(row.id);

    function failBeforeFactory(
      status: PluginRuntimeStatus,
      detail: string,
    ): string {
      if (previous !== undefined) {
        setStatus(row.id, "running", `reload failed: ${detail}`);
        logger.warn(
          `plugin ${row.id} reload failed (kept previous instance): ${detail}`,
        );

        return `${detail} (${PREVIOUS_INSTANCE_KEPT})`;
      }

      setStatus(row.id, status, detail);
      logger.warn(`plugin ${row.id} not loaded (${status}): ${detail}`);

      return detail;
    }

    const hung = hungServices.get(row.id);

    if (hung !== undefined && hung.size > 0) {
      const detail = hungServicesDetail(hung);
      setStatus(row.id, "degraded", detail);
      logger.warn(`plugin ${row.id} not loaded (degraded): ${detail}`);

      if (!shuttingDown) pendingReloads.set(row.id, intent);

      return detail;
    }

    try {
      await stat(row.rootDir);
    } catch {
      return failBeforeFactory(
        "missing",
        `plugin directory not found: ${row.rootDir} (reinstall)`,
      );
    }

    let manifest: PluginManifest;
    let immutableArtifact: PluginArtifactRow | undefined;

    try {
      await verifyBuiltinPluginArtifact({
        db: deps.db,
        dataDir: deps.dataDir,
        row,
      });
      manifest = await readPluginManifest(row.rootDir);
      immutableArtifact = await verifyImmutableInstalledArtifact(row, manifest);
    } catch (error) {
      return failBeforeFactory(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }

    const engineProblem =
      checkEngineRange(manifest) ?? checkPluginSdkRange(manifest);

    if (engineProblem) {
      return failBeforeFactory("incompatible", engineProblem);
    }

    const artifactProblem = await packagedBuiltinArtifactProblem(row, manifest);

    if (artifactProblem !== null) {
      return failBeforeFactory("incompatible", artifactProblem);
    }

    const appBundleCandidate = await loadAppBundleCandidate(
      row,
      manifest,
      immutableArtifact,
    );

    let hostArtifactCandidate: PluginHostArtifactSnapshot | null = null;
    let hostArtifactProblem: string | null = null;

    try {
      hostArtifactCandidate = await loadHostArtifactCandidate(
        row,
        manifest,
        allowPersistedGeneration,
        immutableArtifact,
      );
    } catch (error) {
      hostArtifactProblem =
        error instanceof Error ? error.message : String(error);

      if (previous !== undefined) {
        return failBeforeFactory("error", hostArtifactProblem);
      }
    }

    const brandingAssetCandidate = await loadPluginBrandingAssets(
      row.id,
      manifest,
    );

    const settingsDescriptorsRef: { current: PluginSettingDescriptors } = {
      current: {},
    };

    const stopping = new AbortController();

    const handle = createPluginApi({
      pluginId: row.id,
      logger: deps.logger,
      db: deps.db,
      dataDir: deps.dataDir,
      secrets: context.secretStores.forPlugin(row.id),
      getSdk: () => boundSdk,
      getMachineEnrollments: () => {
        if (!context.machineEnrollments)
          throw new Error(
            "Machine enrollment is unavailable in this plugin host",
          );

        return context.machineEnrollments.forOwner(row.id);
      },
      getAppUrl: deps.getAppUrl ?? (() => null),
      getLoopbackBaseUrl: () => boundLoopbackBaseUrl,
      rpcCaller: rpcCallers.issue(row.id),
      publishSignal: (channel, payload) => {
        deps.hub.notifyPluginSignal(row.id, channel, payload);
      },
      settingsChanged: () => {
        deps.onSettingsChanged?.(row.id);
        settingsChanged();
      },
      reportNeedsConfiguration: (message) => {
        reportNeedsConfiguration(row.id, message);
      },
      isAgentToolNameTaken: (name) => findAgentToolOwner(name, row.id),
      isEventSourceFamilyTaken: (family) => {
        for (const [pluginId, plugin] of loaded)
          if (pluginId !== row.id && plugin.handle.eventSources.has(family))
            return pluginId;

        return undefined;
      },
      isEnvironmentProviderIdTaken: (id) => {
        for (const [pluginId, plugin] of loaded) {
          if (
            pluginId !== row.id &&
            (plugin.handle.environmentProviders.has(id) ||
              plugin.handle.environmentCompositions.has(id))
          ) {
            return pluginId;
          }
        }

        return undefined;
      },
      isMachineProviderIdTaken: (id) => {
        for (const [pluginId, plugin] of loaded) {
          if (pluginId !== row.id && plugin.handle.machineProviders.has(id)) {
            return pluginId;
          }
        }

        return undefined;
      },
      reportAgentToolProblem: (message) => {
        reportAgentToolProblem(row.id, message);
      },
      requestQueueDrain: () => {
        deps.requestQueueDrain?.();
      },
      requestInteraction: (args) => {
        if (!deps.pendingInteractions) {
          throw new Error("Plugin interactions are unavailable in this host");
        }

        if (stopping.signal.aborted) {
          throw new Error(`plugin "${row.id}" is disposing`);
        }

        return deps.pendingInteractions.requestPluginInteraction({
          ...args,
          pluginId: row.id,
          owner: plugin,
        });
      },
      ensureSharedPortTunnel: (hostId) => {
        if (!deps.ensureSharedPortTunnel) {
          throw new Error("host shared-port control plane is unavailable");
        }

        return deps.ensureSharedPortTunnel(hostId);
      },
      validateSharedPortDeclaration: (hostId, ports) => {
        if (!deps.sharedPorts) {
          throw new Error("host shared-port control plane is unavailable");
        }

        return deps.sharedPorts.validateSharedPortDeclaration(hostId, ports);
      },
      declareSharedPorts: (hostId, ports) => {
        if (!deps.sharedPorts) {
          throw new Error("host shared-port control plane is unavailable");
        }

        deps.sharedPorts.declareSharedPorts({
          ownerId: row.id,
          hostId,
          ports,
        });
      },
      replaceDeclaredSharedPorts: (declarations) => {
        if (declarations.length > 0 && !deps.sharedPorts) {
          throw new Error("host shared-port control plane is unavailable");
        }

        deps.sharedPorts?.replaceDeclarationsForOwner(row.id, declarations);
      },
      callPluginHost: (args) => {
        if (hostArtifactCandidate === null) {
          throw new Error(
            `plugin "${row.id}" does not declare an omnyo.host entry`,
          );
        }

        if (!deps.callPluginHost) {
          throw new Error("host plugin transport is unavailable");
        }

        return deps.callPluginHost({
          pluginId: row.id,
          ...args,
          artifact: hostArtifactCandidate,
        });
      },
      registerAiService: (declaration) =>
        deps.aiServices.register({
          ...declaration,
          pluginId: row.id,
          builtin: row.sourceKind === "builtin",
        }),
      registerProvider: (declaration) => {
        return registerPluginProvider({
          available: true,
          declaration,
          row,
          settingsDescriptors: settingsDescriptorsRef.current,
          brandingAssets: brandingAssetCandidate,
        });
      },
      declaredIconNames: new Set(manifest.branding.icons.keys()),
      brandingIcon: manifest.branding.icon,
      assertProviderRegistrable: (providerId) => {
        if (manifest.hostEntry !== undefined) {
          return;
        }

        throw new Error(providerWithoutBridgeMessage(providerId));
      },
      isProviderIdTaken: (providerId) => {
        if (!deps.providerRegistry) {
          throw new Error("the provider registry is unavailable in this host");
        }

        const existing = deps.providerRegistry.get(providerId);

        return existing !== null && existing.pluginId !== row.id;
      },
    });

    settingsDescriptorsRef.current = handle.settings.descriptors;
    const rollbackGenerations: Array<() => void> = [];
    const candidateModuleRootUrls = new Set<string>();

    const plugin: LoadedPlugin = {
      pluginId: row.id,
      manifest,
      handle,
      moduleRootUrls: candidateModuleRootUrls,
      services: [],
      hostArtifact: hostArtifactCandidate,
      stopping,
      released: new AbortController(),
      invocations: new Set(),
    };

    try {
      const serverEntry = await resolveServerEntry(
        row,
        manifest,
        immutableArtifact,
      );

      if (row.sourceKind === "path" || row.sourceKind === "builtin") {
        const mutation = setMutableRootVersion(
          row.rootDir,
          serverEntry.loader === "esm"
            ? `esm:${serverEntry.digest}`
            : `${serverEntry.loader}:${serverEntry.digest}:${nextMutableRootEpoch}`,
        );

        rollbackGenerations.push(mutation.rollback);
        candidateModuleRootUrls.add(mutation.rootUrl);
      }

      if (
        await usesServerZodRuntime(
          row.sourceKind,
          serverEntry.path,
          immutableArtifact !== undefined,
        )
      ) {
        hostZodParentUrls.add(pathToFileURL(serverEntry.path).href);
      }

      let mod: { default?: unknown };

      if (serverEntry.loader === "cjs") {
        const filename = runtimeRequire.resolve(serverEntry.path);
        pluginCodeLocations.set(filename, row.id);

        try {
          const exported: unknown = runtimeRequire(filename);
          mod =
            typeof exported === "function"
              ? { default: exported }
              : (exported as { default?: unknown });
        } finally {
          const entry = runtimeRequire.cache[filename];

          if (entry !== undefined) detachCommonJsModule(entry);
          delete runtimeRequire.cache[filename];
        }
      } else {
        const mutation = setMutableRootVersion(
          dirname(serverEntry.path),
          `esm:${serverEntry.digest}`,
        );

        rollbackGenerations.push(mutation.rollback);
        candidateModuleRootUrls.add(mutation.rootUrl);
        pluginCodeLocations.set(mutation.rootUrl, row.id);
        mod = (await import(pathToFileURL(serverEntry.path).href)) as {
          default?: unknown;
        };
      }

      const factory = mod.default;

      if (typeof factory !== "function") {
        throw new Error(
          `server entry must default-export a factory (api) => void, got ${typeof factory}`,
        );
      }

      if ((await heldDetail(row)) !== null) {
        await discardCandidate(plugin);

        return null;
      }

      await runFactoryTimeBoxed(
        factory as (api: PluginApi) => unknown,
        handle.api,
      );
    } catch (error) {
      for (const rollback of rollbackGenerations.reverse()) rollback();
      await discardCandidate(plugin);
      let message = error instanceof Error ? error.message : String(error);

      if (/ERR_DLOPEN_FAILED|\.node/.test(message)) {
        message += " (native dependencies are not supported in Omnyo plugins)";
      }

      if (previous !== undefined) {
        setStatus(row.id, "running", `reload failed: ${message}`);
      } else {
        setStatus(row.id, "error", message);
      }

      logger.warn(
        `plugin ${row.id} failed to load: ${statuses.get(row.id)?.detail}`,
      );

      return previous !== undefined
        ? `${message} (${PREVIOUS_INSTANCE_KEPT})`
        : message;
    }

    if ((await heldDetail(row)) !== null) {
      for (const rollback of rollbackGenerations.reverse()) rollback();
      await discardCandidate(plugin);
      setStatus(row.id, "disabled", "Paused for server maintenance");

      return null;
    }

    if (hostArtifactProblem !== null) {
      for (const rollback of rollbackGenerations.reverse()) rollback();

      try {
        replaceUnavailableProviderRegistrations(
          row,
          handle.listProviderDeclarations(),
          handle.settings.descriptors,
          brandingAssetCandidate,
        );
      } catch (error) {
        hostArtifactProblem += `; failed to retain provider declaration: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }

      await discardCandidate(plugin);
      setStatus(row.id, "error", hostArtifactProblem);
      logger.warn(`plugin ${row.id} failed to load: ${hostArtifactProblem}`);

      return hostArtifactProblem;
    }

    plugin.services = handle.backgroundServices.map((record) => ({
      record,
      state: "stopped" as const,
      controller: null,
      current: null,
      restartTimer: null,
      consecutiveCrashes: 0,
      startedAt: 0,
      disposed: false,
    }));

    if (previous !== undefined) {
      await disposePluginInstance(previous, "replace");
      const hungAfterDispose = hungServices.get(row.id);

      if (hungAfterDispose !== undefined && hungAfterDispose.size > 0) {
        for (const rollback of rollbackGenerations.reverse()) rollback();
        loaded.delete(row.id);
        deps.sharedPorts?.clearDeclarationsForOwner(row.id);
        await discardCandidate(plugin);

        if (!shuttingDown) pendingReloads.set(row.id, intent);

        return hungServicesDetail(hungAfterDispose);
      }

      releaseMutableRoots(
        [...previous.moduleRootUrls].filter(
          (rootUrl) => !candidateModuleRootUrls.has(rootUrl),
        ),
      );
    }

    const latestRow = getInstalledPlugin(deps.db, row.id);

    const latestHold =
      latestRow === undefined ? null : await heldDetail(latestRow);

    const activationRow = getInstalledPlugin(deps.db, row.id);

    if (
      shuttingDown ||
      activationRow === undefined ||
      !activationRow.enabled ||
      isSuppressedBySafeMode(activationRow) ||
      latestHold !== null
    ) {
      for (const rollback of rollbackGenerations.reverse()) rollback();
      loaded.delete(row.id);
      deps.sharedPorts?.clearDeclarationsForOwner(row.id);
      await discardCandidate(plugin);

      return null;
    }

    if (hostArtifactCandidate === null) {
      deletePluginHostGeneration(deps.db, row.id);
    } else {
      setPluginHostGeneration(deps.db, row.id, hostArtifactCandidate);
    }

    disposeUnavailableProviderRegistrations(row.id);
    loaded.set(row.id, plugin);
    appBundles.set(row.id, appBundleCandidate.snapshot);

    if (hostArtifactCandidate === null) hostArtifacts.delete(row.id);
    else hostArtifacts.set(row.id, hostArtifactCandidate);
    brandingAssets.set(row.id, brandingAssetCandidate);
    needsConfiguration.delete(row.id);
    agentToolProblems.delete(row.id);
    handle.activate();
    const now = Date.now();
    const previousSchedules = listPluginSchedules(deps.db, row.id);
    prunePluginSchedules(
      deps.db,
      row.id,
      handle.schedules.map((schedule) => schedule.name),
    );

    for (const schedule of handle.schedules) {
      if (
        previousSchedules.some(
          (previous) =>
            previous.name === schedule.name && previous.cron === schedule.cron,
        )
      )
        continue;
      upsertPluginSchedule(deps.db, {
        pluginId: row.id,
        name: schedule.name,
        cron: schedule.cron,
        nextRunAt: nextCronRunAt(schedule.cron, now),
      });
    }

    for (const service of plugin.services) {
      runService(row.id, service);
    }

    if (!needsConfiguration.has(row.id)) {
      const details = [
        agentToolProblems.get(row.id),
        appBundleCandidate.problem,
      ].filter((detail): detail is string => typeof detail === "string");

      setStatus(
        row.id,
        "running",
        details.length > 0 ? details.join("; ") : null,
      );
    }

    logger.info(`plugin ${row.id}@${manifest.version} loaded`);

    return null;
  }

  async function disposePluginInstance(
    plugin: LoadedPlugin,
    hostWorker: "stop" | "replace",
    strict = false,
  ): Promise<void> {
    const id = plugin.pluginId;
    const errors: unknown[] = [];

    try {
      deletePluginHostGeneration(deps.db, id);
      plugin.handle.closeWebSockets();
      plugin.stopping.abort();

      if (
        plugin.hostArtifact !== null &&
        deps.disposePluginHost &&
        hostWorker === "stop"
      ) {
        try {
          await deps.disposePluginHost({
            pluginId: id,
            generation: plugin.hostArtifact.generation,
          });
        } catch (error) {
          errors.push(error);
          logger.warn(
            `plugin ${id} host-worker cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      abortPluginToolCallsForPlugin(id, "plugin-disposed");

      try {
        deps.pendingInteractions?.interruptOwnedPluginInteractions(plugin);
      } catch (error) {
        errors.push(error);
        logger.warn(
          `plugin ${id} interaction cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      await stopServices(id, plugin);
      await waitForWebSocketsClosed(plugin);

      await runDisposeHooks(plugin, { errors });

      await drainInvocations(plugin);

      if (plugin.invocations.size > 0)
        errors.push(new Error("Plugin invocations did not settle"));

      if ((hungServices.get(id)?.size ?? 0) > 0)
        errors.push(new Error("Registered plugin services did not stop"));

      for (const database of plugin.handle.databaseHandles.splice(0)) {
        try {
          database.close();
        } catch (error) {
          errors.push(error);
          logger.warn(
            `plugin ${id} database close failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      plugin.released.abort();
      plugin.handle.invalidate();
    }

    if (errors.length > 0) {
      disposalFailures.add(id);

      if (strict)
        throw new AggregateError(errors, `Plugin ${id} did not quiesce`);
    } else disposalFailures.delete(id);
  }

  async function disposeOne(id: string, strict = false): Promise<void> {
    await disposeLoaded(id, "stop", strict);
  }

  async function disposeForReplacement(id: string): Promise<void> {
    await disposeLoaded(id, "replace", false);
  }

  async function disposeLoaded(
    id: string,
    hostWorker: "stop" | "replace",
    strict: boolean,
  ): Promise<void> {
    pendingReloads.delete(id);
    disposeUnavailableProviderRegistrations(id);
    const plugin = loaded.get(id);

    if (!plugin) {
      deletePluginHostGeneration(deps.db, id);

      return;
    }

    loaded.delete(id);

    try {
      deps.pendingInteractions?.interruptPluginInteractions(id);
    } catch (error) {
      logger.warn(
        `plugin ${id} interaction cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await disposePluginInstance(plugin, hostWorker, strict);
    releaseMutableRoots(plugin.moduleRootUrls);
    hostArtifacts.delete(id);
    deps.sharedPorts?.clearDeclarationsForOwner(id);
  }

  async function disposeAll(): Promise<void> {
    shuttingDown = true;
    pendingReloads.clear();

    const pluginIds = new Set([
      ...loaded.keys(),
      ...unavailableProviderRegistrations.keys(),
      ...listPluginHostGenerationIds(deps.db),
    ]);

    for (const id of pluginIds) {
      await withLifecycleLock(id, () => disposeOne(id));
    }
  }

  async function loadAll(): Promise<void> {
    shuttingDown = false;

    const rows = listInstalledPlugins(deps.db).sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    for (const row of rows) {
      if (loaded.has(row.id)) continue;
      await withLifecycleLock(row.id, () => loadOne(row, true));
    }
  }

  function wireLookup<T>(
    id: string,
    find: (plugin: LoadedPlugin) => T | undefined,
  ): PluginWireLookup<T> {
    const plugin = loaded.get(id);

    if (!plugin) {
      const row = getInstalledPlugin(deps.db, id);

      if (!row) return { outcome: "unknown-plugin" };

      return {
        outcome: "not-running",
        ...getStatus(row),
      };
    }

    const value = find(plugin);

    if (value === undefined) return { outcome: "not-found" };

    return { outcome: "found", value, owner: plugin };
  }

  function bindSdk(args: { baseUrl: string }): void {
    boundSdk = createNodeOmnyoSdk({ baseUrl: args.baseUrl });
    boundLoopbackBaseUrl = args.baseUrl;
  }

  return {
    REGISTRATION_MUTATION_KEY,
    getMaintenanceActivity,
    agentToolProblems,
    appBundles,
    hostArtifacts,
    bindSdk,
    resolveRpcCaller: rpcCallers.resolve,
    buildThreadDto,
    builtinSourceWatchers,
    checkEngineRange,
    checkPluginSdkRange,
    disposeAll,
    disposeOne,
    disposeForReplacement,
    buildQueuedMessageEventEmitter,
    emitThreadEvent,
    getStatus,
    handlerStats,
    handleUncaughtException,
    hungServices,
    invokeOwned,
    invokeWrapped,
    isSafeModeExemptRow,
    isSuppressedBySafeMode,
    listPluginHooks,
    listPluginEnvironmentCompositions,
    listPluginEnvironmentProviders,
    getPluginEnvironmentProvider,
    listPluginMachineProviders,
    listPluginServerAccessProviders,
    listPluginEventSources,
    getPluginMachineProvider,
    identities,
    isPackagedBuiltinEntry,
    loadAll,
    loaded,
    loadOne,
    brandingAssets,
    safeModeActivationRefusal,
    setDevBuildProblem,
    setLoadHold,
    heldDetail,
    setStatus,
    sourceKind,
    stabilizingPluginIds,
    statuses,
    statusListeners,
    wireLookup,
    withArtifactLock,
    withLifecycleLock,
    withPluginOperationLock,
  };
}
