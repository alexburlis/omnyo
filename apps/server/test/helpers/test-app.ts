import { ServerCommandMetadata } from "../../src/services/skills/command-metadata.js";
import { ProjectCommandCatalogs } from "../../src/services/threads/project-command-catalogs.js";
import { closeThreadTimelinePageBuilders } from "../../src/services/threads/timeline-page-builder.js";
import { installDefaultEnvironmentProviders } from "./environment-provider.js";
import { registerTestHarnessWarmup } from "./test-harness-warmup.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { clearAllThreadProvisionSchedules } from "../../src/services/threads/thread-startup-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import {
  createConnection,
  getAppSettings,
  getDisabledProviderIds,
  setAppSettings,
  type DbConnection,
} from "@omnyo/db";
import { defaultFeatureFlags } from "@omnyo/domain";
import { initDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import { createMachineAuthService } from "../../src/services/machine-auth.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { registerFirstPartyProviders } from "./provider-registry.js";
import { validatePluginProviderDeclaration } from "@omnyo/plugin-sdk/internal/host-policy";
import type { PluginProviderDeclaration } from "@omnyo/plugin-sdk";
import { openSecretVault } from "@omnyo/secret-storage";
import { buildPluginProviderRegistration } from "../../src/services/providers/plugin-provider-registration.js";
import { SkillTreeRegistry } from "../../src/services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "../../src/services/plugins/plugin-host-artifact-registry.js";
import type { PluginService } from "../../src/services/plugins/plugin-service.js";
import { listBundledPluginRegistrations } from "../../src/services/plugins/builtin-registry.js";
import { createProviderNativeRootsCache } from "../../src/services/providers/native-roots.js";
import { createAiServiceRegistry } from "../../src/services/ai/ai-service-registry.js";
import {
  createAppUpdateService,
  type AppUpdateService,
} from "../../src/services/system/app-update.js";
import { countRunningThreadsForAppUpdate } from "../../src/services/threads/thread-runtime-display.js";
import {
  createAppVersionService,
  type AppVersionService,
} from "../../src/services/system/app-version.js";
import { createOmnyoAppManagedConfigReloader } from "../../src/services/system/managed-app-config.js";
import { createNoopTelemetryService } from "../../src/services/system/telemetry.js";
import { TerminalSessionLifecycle } from "../../src/services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "../../src/lifecycle-dedupers.js";
import type { ServerAppDeps, ServerRuntimeConfig } from "../../src/types.js";
import type { NotificationHub } from "../../src/ws/hub.js";
import { NotificationHub as NotificationHubImpl } from "../../src/ws/hub.js";
import { WatchInterestCoordinator } from "../../src/ws/watch-interests.js";
import { HostSharedPortCoordinator } from "../../src/ws/host-shared-ports.js";
import { WorkspaceReadCaches } from "../../src/services/environments/workspace-read-cache.js";
import {
  PluginToolCallRegistry,
  setPluginToolCallRegistry,
} from "../../src/services/plugins/plugin-tool-calls.js";

const TEST_MACHINE_KEY_PREFIX = "test-daemon-key";

const TEST_SERVER_HOST = "127.0.0.1";

const TEST_TERMINAL_RPC_TIMEOUT_MS = 10_000;

export interface TestAppHarness {
  app: ReturnType<typeof createApp>["app"];
  config: ServerRuntimeConfig;
  db: DbConnection;
  deps: ServerAppDeps;
  hub: NotificationHub;
  pluginService: ReturnType<typeof createApp>["pluginService"];
  pluginCatalogService: ReturnType<typeof createApp>["pluginCatalogService"];
  serverMove: ReturnType<typeof createApp>["serverMove"];
  cleanup(): Promise<void>;
}

export interface RunningTestServer extends TestAppHarness {
  baseUrl: string;
  close(): Promise<void>;
}

export async function installTestBuiltinPlugin(
  harness: Pick<TestAppHarness, "pluginService">,
  name: "keep-awake",
): Promise<void> {
  const entry = await harness.pluginService.install(`builtin:${name}`, {
    kind: "root",
  });

  if (entry.status !== "running") {
    throw new Error(
      `test builtin ${name} did not start: ${entry.statusDetail ?? entry.status}`,
    );
  }
}

export type TestAppHarnessConfigOverrides = Partial<ServerRuntimeConfig> & {
  databaseSource?: string;
  appUpdateService?: AppUpdateService;
  appVersionService?: AppVersionService;
  terminalAttachTimeoutMs?: number;
  terminalCloseTimeoutMs?: number;
  terminalOpenTimeoutMs?: number;
  nativeRootsClock?: () => number;
  seedFirstPartyProviders?: boolean;
  extraProviders?: readonly {
    declaration: PluginProviderDeclaration;
    pluginId: string;
  }[];
};

function createTestLogger() {
  return {
    debug(): void {},
    error(): void {},
    info(): void {},
    warn(): void {},
  };
}

export const testLogger = createTestLogger();

interface TestDaemonKeyParts {
  hostId: string;
}

function encodeTestDaemonKey(args: TestDaemonKeyParts): string {
  return `${TEST_MACHINE_KEY_PREFIX}:${args.hostId}`;
}

function decodeTestDaemonKey(token: string): TestDaemonKeyParts | null {
  const parts = token.split(":");

  if (parts.length !== 2 || parts[0] !== TEST_MACHINE_KEY_PREFIX) {
    return null;
  }

  const hostId = parts[1];

  if (hostId.length === 0) {
    return null;
  }

  return { hostId };
}

export function createTestDaemonHostKey(
  args: Partial<TestDaemonKeyParts> = {},
): string {
  return encodeTestDaemonKey({
    hostId: args.hostId ?? "host-1",
  });
}

let migratedTemplate: Buffer | null = null;

async function initializeTestPlugins(
  pluginService: Pick<PluginService, "start">,
): Promise<void> {
  let startupHoldActive = true;

  try {
    await pluginService.start({
      hold: {
        sources: listBundledPluginRegistrations().map(
          (plugin) => `builtin:${plugin.name}`,
        ),
        detail: "Builtin services are not started by the server test fixture",
        isActive: async () => startupHoldActive,
      },
    });
  } finally {
    startupHoldActive = false;
  }
}

export function createTestDb(): DbConnection {
  if (migratedTemplate === null) {
    migratedTemplate = initDb(":memory:").$client.serialize();
  }

  return createConnection(migratedTemplate);
}

export async function createTestAppHarness(
  overrides: TestAppHarnessConfigOverrides = {},
): Promise<TestAppHarness> {
  const {
    databaseSource,
    appUpdateService,
    appVersionService,
    terminalAttachTimeoutMs = TEST_TERMINAL_RPC_TIMEOUT_MS,
    terminalCloseTimeoutMs,
    terminalOpenTimeoutMs = TEST_TERMINAL_RPC_TIMEOUT_MS,
    nativeRootsClock,
    seedFirstPartyProviders = true,
    ...configOverrides
  } = overrides;

  const logger = createTestLogger();
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-server-test-"));
  const vault = await openSecretVault(dataDir);

  const db =
    databaseSource === undefined ? createTestDb() : initDb(databaseSource);

  setAppSettings(db, {
    ...getAppSettings(db),
    machineGitCredentialsEnabled: false,
  });
  const hub = new NotificationHubImpl();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });

  const providerRegistry = createProviderRegistryService({
    readUserProviderPreferences: () => {
      const settings = getAppSettings(db);

      return {
        providerOrder: settings.providerOrder,
        disabledProviderIds: getDisabledProviderIds(db),
        defaultProviderId: settings.defaultProviderId,
      };
    },
  });

  const pluginHostArtifacts = new PluginHostArtifactRegistry();

  const providerNativeRoots = createProviderNativeRootsCache(
    nativeRootsClock === undefined ? {} : { now: nativeRootsClock },
  );

  for (const extra of overrides.extraProviders ?? []) {
    providerRegistry.register({
      ...buildPluginProviderRegistration({
        available: true,
        pluginId: extra.pluginId,
        declaration: validatePluginProviderDeclaration(extra.declaration),
        iconHash: null,
        readSettings: () => ({}),
      }),
      pluginId: extra.pluginId,
      iconNames: new Set<string>(),
    });
  }

  if (seedFirstPartyProviders) {
    await registerFirstPartyProviders(providerRegistry, {
      artifacts: pluginHostArtifacts,
    });
  }

  const lifecycleDedupers = createLifecycleDedupers();

  const machineAuth = await createMachineAuthService({
    db,
    logger,
    vault,
  });

  await machineAuth.ensureReady();

  const testMachineAuth = {
    ...machineAuth,
    async verifyDaemonHostKey(token: string) {
      const testKey = decodeTestDaemonKey(token);

      if (testKey) {
        return {
          keyId: `test:${testKey.hostId}`,
          metadata: testKey,
        };
      }

      return machineAuth.verifyDaemonHostKey(token);
    },
  };

  const config: ServerRuntimeConfig = {
    appAliasOrigins: [],
    appVersion: "0.0.0-test",
    builtinSkillsRootPath: join(dataDir, "builtin-skills"),
    customModels: [],
    dataDir,
    featureFlags: defaultFeatureFlags,
    performanceDiagnosticsAvailable: false,
    nativeClaudeProfilesOwnerPilotAvailable: false,
    hostDaemonPort: 3001,
    inheritedSkillsRootPaths: [],
    isDevelopment: true,
    serverPort: 3334,
    sharedSkillRoots: { user: [], project: [] },
    appUrl: "https://omnyo.example.test",
    ...configOverrides,
  };

  const terminalSessions = new TerminalSessionLifecycle({
    attachTimeoutMs: terminalAttachTimeoutMs,
    ...(terminalCloseTimeoutMs === undefined
      ? {}
      : { closeTimeoutMs: terminalCloseTimeoutMs }),
    config,
    db,
    hub,
    logger,
    openTimeoutMs: terminalOpenTimeoutMs,
    vault,
  });

  const omnyoAppManagedConfig = await createOmnyoAppManagedConfigReloader({
    config,
    hub,
    logger,
  });

  const telemetry = createNoopTelemetryService();
  const skillTreeRegistry = new SkillTreeRegistry();
  const commandMetadata = new ServerCommandMetadata({ config, logger });
  const aiServices = createAiServiceRegistry();

  const pendingInteractions = new PendingInteractionLifecycle({
    config,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth: testMachineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
    vault,
  });

  pendingInteractions.start();
  setPluginToolCallRegistry(new PluginToolCallRegistry({ logger }));

  const appVersion =
    appVersionService ??
    createAppVersionService({
      sourceCommit: null,
      installKind: null,
      config,
    });

  const appUpdate =
    appUpdateService ??
    createAppUpdateService({
      currentCommit: null,
      appSurface: "web",
      config,
      countRunningThreads: () => countRunningThreadsForAppUpdate({ db, hub }),
      dataDir: config.dataDir,
      launcher: null,
      logger,
      mode: null,
      notifyChanged: () => hub.notifySystem(["app-update-changed"]),
      setDraining: () => undefined,
      stopRunningThreads: async () => undefined,
    });

  const baseDeps: Omit<ServerAppDeps, "commandCatalogs"> = {
    appUpdate,
    appVersion,
    managedAppConfig: omnyoAppManagedConfig,
    config,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth: testMachineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    providerNativeRoots,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
    vault,
    watchInterests,
    sharedPorts,
    workspaceReadCaches,
    commandMetadata,
  };

  const commandCatalogs = new ProjectCommandCatalogs(baseDeps);
  const deps: ServerAppDeps = { ...baseDeps, commandCatalogs };

  const { app, pluginCatalogService, pluginService, serverMove } =
    createApp(deps);

  await initializeTestPlugins(pluginService);
  installDefaultEnvironmentProviders();

  return {
    app,
    config,
    db,
    deps,
    hub,
    pluginService,
    pluginCatalogService,
    serverMove,
    async cleanup(): Promise<void> {
      await commandCatalogs.dispose();
      await commandMetadata.dispose();
      clearAllThreadProvisionSchedules();
      setPluginEnvironmentProviderBridge(undefined);
      await pluginService.stop();
      await closeThreadTimelinePageBuilders(db);
      await rm(dataDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    },
  };
}

export async function withTestHarness<T>(
  run: (harness: TestAppHarness) => Promise<T>,
): Promise<T>;
export async function withTestHarness<T>(
  overrides: TestAppHarnessConfigOverrides,
  run: (harness: TestAppHarness) => Promise<T>,
): Promise<T>;
export async function withTestHarness<T>(
  overridesOrRun:
    | TestAppHarnessConfigOverrides
    | ((harness: TestAppHarness) => Promise<T>),
  maybeRun?: (harness: TestAppHarness) => Promise<T>,
): Promise<T> {
  const overrides: TestAppHarnessConfigOverrides =
    typeof overridesOrRun === "function" ? {} : overridesOrRun;

  const run = typeof overridesOrRun === "function" ? overridesOrRun : maybeRun;

  if (!run) {
    throw new Error("withTestHarness requires a run callback");
  }

  const harness = await createTestAppHarness(overrides);

  try {
    return await run(harness);
  } finally {
    await harness.cleanup();
  }
}

registerTestHarnessWarmup(() => withTestHarness(async () => undefined));

export async function startTestServer(
  overrides: TestAppHarnessConfigOverrides = {},
): Promise<RunningTestServer> {
  const harness = await createTestAppHarness(overrides);
  let addressInfo: AddressInfo | null = null;

  const { app, closeWebSockets, injectWebSocket, pluginService, serverMove } =
    createApp(harness.deps);

  await initializeTestPlugins(pluginService);

  const server = serve(
    {
      hostname: TEST_SERVER_HOST,
      port: 0,
      fetch: app.fetch,
    },
    (info) => {
      addressInfo = info;
    },
  );

  injectWebSocket(server);

  while (!addressInfo) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const resolvedAddress: AddressInfo = addressInfo;
  harness.config.serverPort = resolvedAddress.port;

  return {
    ...harness,
    app,
    pluginService,
    serverMove,
    baseUrl: `http://${TEST_SERVER_HOST}:${resolvedAddress.port}`,
    async close(): Promise<void> {
      await pluginService.stop();

      const closeServer = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
      });

      await closeWebSockets();
      await closeServer;
      await harness.cleanup();
    },
  };
}
