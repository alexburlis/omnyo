import { diagnosticRunningReadFetch } from "../system/running-read-diagnostics.js";
import { isPerformanceDiagnosticsEnabled } from "../system/performance-diagnostics.js";
import {
  createNodeOmnyoSdk,
  createRequestTimeoutFetch,
  DEFAULT_CORE_REQUEST_TIMEOUT_MS,
} from "@omnyo/sdk";
import { INBOX_CALLER_PLUGIN_HEADER } from "@omnyo/domain";
import {
  environmentCompositionSchema,
  createThreadEventFilter,
  validateEventSourceDeclaration,
  validatePluginErrorReport,
  validateServerAccessProviderDeclaration,
  type NormalizedPluginEnvironmentComposition,
  type NormalizedPluginInteractionRequest,
  type PluginThreadEventFilter,
} from "@omnyo/plugin-sdk/internal/host-policy";
import { captureProcessError } from "@omnyo/process-utils/error-reporting";
import { createMachineBootstrapApi } from "../machines/bootstrap.js";
import type { MachineEnrollments } from "../machines/enrollments.js";
import { listServerAccessProviders } from "./plugin-server-access-registry.js";
import { detachActivePluginToolCallForUserInput } from "./plugin-tool-calls.js";
import { fillPluginPresentation } from "./plugin-presentation.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import {
  deletePluginKvValue,
  getPluginKvValue,
  getHost,
  listPluginKvKeys,
  setPluginKvValue,
  type DbConnection,
} from "@omnyo/db";
import type { ThreadEventItemPresentation } from "@omnyo/domain";
import type {
  PluginApi,
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginRowPresentation,
  PluginSdk,
  PluginAgentToolResult,
  PluginAgents,
  PluginBackground,
  PluginCli,
  PluginCliCommandInfo,
  PluginCliContext,
  PluginCliResult,
  PluginEnvironments,
  PluginHooks,
  PluginHookHandler,
  PluginHookName,
  PluginEvents,
  PluginHttp,
  PluginHttpAuthMode,
  PluginHttpHandler,
  PluginHosts,
  PluginKvStorage,
  PluginLogger,
  PluginMentionProviderRegistration,
  PluginMentionTrigger,
  PluginMachines,
  PluginAiServices,
  PluginProviderDeclaration,
  ExperimentalPluginProviderEnvContext,
  ExperimentalPluginProviderEnvEntry,
  ExperimentalPluginProviderEnvHealth,
  ExperimentalPluginProviderEnvHealthContext,
  ExperimentalPluginProviderModelNotice,
  ExperimentalPluginProviderModelNoticeContext,
  ExperimentalPluginWebSocket,
  ExperimentalPluginWebSocketHandler,
  PluginProviders,
  PluginRealtime,
  PluginRpc,
  PluginSecrets,
  PluginServerApi,
  PluginSettingDescriptors,
  PluginSettingValue,
  PluginSettings,
  PluginSettingsValues,
  PluginStatusApi,
  PluginStorage,
  PluginThreadEventHandler,
  PluginThreadEventName,
  PluginUi,
  StandardSchemaV1,
  PluginRpcContract,
  ExperimentalPluginRpcHandlerContext,
} from "@omnyo/plugin-sdk";
import {
  KV_VALUE_MAX_BYTES,
  normalizeAgentToolRegistration,
  normalizeCliRegistration,
  normalizeHttpRouteRegistration,
  normalizeInteractionRequest,
  normalizeMentionProviderRegistration,
  normalizeRealtimePayload,
  normalizeRpcRegistration,
  publishRpcMethod,
  normalizeWebSocketRouteRegistration,
  pluginCliCollisionWarning,
  registerSettingDescriptors,
  runPluginStorageMigrations,
  isStandardSchema,
  aiServiceAlreadyRegisteredMessage,
  registerPluginHook,
  validateBackgroundServiceRegistration,
  validatePluginEnvironmentProviderDeclaration,
  validatePluginMachineProviderDeclaration,
  providerAlreadyRegisteredMessage,
  providerIconRefusalMessage,
  undeclaredIconProblem,
  validateProviderEnvContribution,
  validateScheduleRegistration,
  validateSettingsUpdate,
  validatePluginAiServiceDeclaration,
  validatePluginProviderDeclaration,
} from "@omnyo/plugin-sdk/internal/host-policy";
import type {
  NormalizedPluginAiService,
  NormalizedPluginEnvironmentProvider,
  NormalizedPluginMachineProvider,
  NormalizedPluginProviderDeclaration,
} from "@omnyo/plugin-sdk/internal/host-policy";
import type {
  OmnyoSdk,
  ThreadForkArgs,
  PluginThreadMetadataListArgs,
  ThreadPluginMetadataArgs,
  ThreadPluginMetadataUpdateArgs,
  ThreadSpawnArgs,
} from "@omnyo/sdk";
import { requestEnvironmentProviderRecheck } from "./plugin-environment-provider-registry.js";
import { requestServerAccessRecheck } from "./plugin-server-access-registry.js";
import {
  createPluginRpcCallerSdk,
  type PluginRpcCallerCredential,
} from "./plugin-rpc-caller.js";
import type { ServerLogger } from "../../types.js";
import type { PluginInteractionResult } from "../interactions/pending-interactions.js";
import { createBoundedMentionSearch } from "./plugin-mention-search.js";
import { appendPluginLogLine } from "./plugin-log.js";
import {
  readPluginSettingsValues,
  sealLegacySecretSettings,
  writePluginSettingsUpdate,
} from "./plugin-settings.js";
import type { PluginSecretStore } from "./plugin-secrets.js";

export type {
  PluginApi,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginCliCommandInfo,
  PluginCliContext,
  PluginMentionTrigger,
  PluginThreadEventName,
  PluginThreadEventPayloads,
} from "@omnyo/plugin-sdk";

export class PluginContextStaleError extends Error {
  constructor(readonly pluginId: string) {
    super(
      `plugin "${pluginId}" used a stale API handle — it was reloaded or disabled; ` +
        `re-entry happens via a fresh factory call`,
    );
    this.name = "PluginContextStaleError";
  }
}

export function isNeedsConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

export type PluginHookRecords = {
  [K in PluginHookName]: PluginHookHandler<K> | null;
};

type PluginThreadEventHandlers = {
  [E in PluginThreadEventName]: Array<PluginThreadEventHandler<E>>;
};

export interface PluginHttpRouteRecord {
  method: string;
  path: string;
  auth: PluginHttpAuthMode;
  handler: PluginHttpHandler;
}

export interface PluginWebSocketRouteRecord {
  path: string;
  auth: PluginHttpAuthMode;
  handler: ExperimentalPluginWebSocketHandler;
  active: boolean;
  sockets: Set<ExperimentalPluginWebSocket>;
}

export interface PluginRpcHandler {
  threadBootstrap: boolean;
  dispatchReadiness: boolean;
  publication: ReturnType<typeof publishRpcMethod>;
  inputSchema: StandardSchemaV1;
  outputSchema: StandardSchemaV1;
  handler: (
    input: unknown,
    context: ExperimentalPluginRpcHandlerContext,
  ) => unknown;
}

export interface PluginAgentToolRecord {
  name: string;
  description: string;
  presentation: PluginRowPresentation | null;
  instructions: string | null;
  inputSchema: unknown;
  parse(
    input: unknown,
  ): { ok: true; value: unknown } | { ok: false; error: string };
  execute(
    params: unknown,
    ctx: PluginAgentToolContext,
  ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
}

interface PluginMentionProviderRecord {
  id: string;
  label: string;
  triggers: readonly PluginMentionTrigger[];
  search: ReturnType<typeof createBoundedMentionSearch>;
  resolve: PluginMentionProviderRegistration["resolve"];
}

export interface PluginBackgroundServiceRecord {
  name: string;
  start: (signal: AbortSignal) => void | Promise<void>;
  experimental_stopTimeoutMs: number | null;
}

interface PluginScheduleRecord {
  name: string;
  cron: string;
  fn: () => void | Promise<void>;
}

interface PluginCliRegistrationRecord {
  name: string;
  summary: string;
  commands: PluginCliCommandInfo[];
  rendersHelp: boolean;
  run: (
    argv: string[],
    ctx: PluginCliContext,
  ) => PluginCliResult | Promise<PluginCliResult>;
}

type PluginSettingsListener = (
  next: Record<string, PluginSettingValue | undefined>,
  prev: Record<string, PluginSettingValue | undefined>,
) => void;

export interface PluginApiHandle {
  api: PluginApi;
  disposeHooks: Array<() => void | Promise<void>>;

  installHandlers: Array<() => void | Promise<void>>;
  settings: {
    descriptors: PluginSettingDescriptors;
    listeners: PluginSettingsListener[];
  };
  databaseHandles: Database.Database[];
  threadEventHandlers: PluginThreadEventHandlers;
  threadEventFilters: WeakMap<object, PluginThreadEventFilter>;

  hooks: PluginHookRecords;
  environmentCompositions: Map<string, NormalizedPluginEnvironmentComposition>;
  environmentProviders: Map<string, NormalizedPluginEnvironmentProvider>;
  machineProviders: Map<string, NormalizedPluginMachineProvider>;
  serverAccessProviders: Map<
    string,
    import("@omnyo/plugin-sdk").ServerAccessProviderDeclaration
  >;
  eventSources: Map<
    string,
    import("@omnyo/plugin-sdk").PluginEventSourceDeclaration
  >;

  httpRoutes: PluginHttpRouteRecord[];
  websocketRoutes: PluginWebSocketRouteRecord[];
  rpcHandlers: Map<string, PluginRpcHandler>;
  hostWorkerExitHandlers: PluginHostWorkerExitHandler[];
  hostSignalHandlers: PluginHostSignalHandler[];
  backgroundServices: PluginBackgroundServiceRecord[];
  schedules: PluginScheduleRecord[];
  cli: { registration: PluginCliRegistrationRecord | null };
  agentTools: PluginAgentToolRecord[];
  listProviderDeclarations(): NormalizedPluginProviderDeclaration[];
  providerEnvResolvers: ReadonlyMap<string, PluginProviderEnvResolver>;
  providerEnvHealthResolvers: ReadonlyMap<
    string,
    PluginProviderEnvHealthResolver
  >;
  providerModelNoticeResolvers: ReadonlyMap<
    string,
    PluginProviderModelNoticeResolver
  >;
  agentConfigurationProvider: PluginAgentConfigurationProvider | null;
  instructionProvider: PluginInstructionProvider | null;
  mentionProviders: PluginMentionProviderRecord[];
  activate(): void;
  closeWebSockets(): void;
  invalidate(): void;
}

type PluginHostWorkerExitHandler = (event: {
  hostId: string;
}) => void | Promise<void>;

interface PluginHostSignalHandler {
  signal: string;
  payloadSchema: StandardSchemaV1;
  handler: (event: {
    hostId: string;
    payload: unknown;
  }) => void | Promise<void>;
}

type PluginInstructionProvider = (ctx: {
  threadId: string;
  projectId: string;
}) => string | null;

type PluginAgentConfigurationProvider = (
  context: PluginAgentConfigurationContext,
) => PluginAgentConfiguration;

export type PluginProviderEnvResolver = (
  context: ExperimentalPluginProviderEnvContext,
) =>
  | readonly ExperimentalPluginProviderEnvEntry[]
  | Promise<readonly ExperimentalPluginProviderEnvEntry[]>;

export type PluginProviderEnvHealthResolver = (
  context: ExperimentalPluginProviderEnvHealthContext,
) =>
  | ExperimentalPluginProviderEnvHealth
  | null
  | Promise<ExperimentalPluginProviderEnvHealth | null>;

export type PluginProviderModelNoticeResolver = (
  context: ExperimentalPluginProviderModelNoticeContext,
) =>
  | ExperimentalPluginProviderModelNotice
  | null
  | Promise<ExperimentalPluginProviderModelNotice | null>;

function withPluginThreadAttribution<
  TArgs extends ThreadForkArgs | ThreadSpawnArgs,
>(args: TArgs, pluginId: string): TArgs {
  const claimsHome =
    "experimental_pluginHome" in args && args.experimental_pluginHome === true;

  const attribution: Pick<ThreadSpawnArgs, "origin" | "originPluginId"> =
    args.pluginMetadata !== undefined || claimsHome
      ? { origin: "plugin", originPluginId: pluginId }
      : args.origin === undefined || args.origin === "plugin"
        ? { origin: "plugin", originPluginId: args.originPluginId ?? pluginId }
        : { origin: args.origin };

  return { ...args, ...attribution };
}

function createPluginIdentifiedSdk(args: {
  assertLive(): void;
  db: DbConnection;
  logger: ServerLogger;
  sdk: OmnyoSdk;
  baseUrl: string;
  pluginId: string;
}): OmnyoSdk {
  const timeoutFetch = diagnosticRunningReadFetch(
    createRequestTimeoutFetch({
      timeoutMs: DEFAULT_CORE_REQUEST_TIMEOUT_MS,
    }),
    () => isPerformanceDiagnosticsEnabled(args.db),
    args.logger,
  );

  const identified = createNodeOmnyoSdk({
    baseUrl: args.baseUrl,
    fetch: (input, init) => {
      args.assertLive();
      const headers = new Headers(init?.headers);
      headers.set(INBOX_CALLER_PLUGIN_HEADER, args.pluginId);

      return timeoutFetch(input, { ...init, headers });
    },
  });

  return {
    ...identified,
    subscribe(input) {
      args.assertLive();

      return args.sdk.subscribe(input);
    },
    experimental_desktopBrowsers: {
      ...identified.experimental_desktopBrowsers,
      subscribe(input) {
        args.assertLive();

        return identified.experimental_desktopBrowsers.subscribe(input);
      },
    },
  };
}

function wrapSdkForPlugin(
  sdk: OmnyoSdk,
  pluginId: string,
  rpcCallerSdk: OmnyoSdk,
  assertLive: () => void,
): PluginSdk {
  return {
    ...sdk,
    plugins: {
      ...sdk.plugins,
      callRpc(args) {
        assertLive();

        return rpcCallerSdk.plugins.callRpc(args);
      },
    },
    threads: {
      ...sdk.threads,
      send(args) {
        return sdk.threads.send({
          ...args,
          messageSource: { kind: "plugin", pluginId },
        });
      },
      experimental_listStartMachines(args) {
        return sdk.threads.experimental_listStartMachines({
          ...args,
          pluginId,
        });
      },
      experimental_moveStart(args) {
        return sdk.threads.experimental_moveStart({
          ...args,
          initiator: { kind: "plugin", pluginId },
        });
      },
      experimental_importNative(args) {
        return sdk.threads.experimental_importNative({
          ...args,
          origin: "plugin",
          originPluginId: pluginId,
        });
      },
      queuedMessages: {
        ...sdk.threads.queuedMessages,
        create(args) {
          return sdk.threads.queuedMessages.create({
            ...args,
            messageSource: { kind: "plugin", pluginId },
          });
        },
      },
      async getPluginMetadata(
        args: Omit<ThreadPluginMetadataArgs, "pluginId"> & {
          pluginId?: string;
        },
      ) {
        return sdk.threads.getPluginMetadata({
          ...args,
          pluginId: args.pluginId ?? pluginId,
        });
      },
      async experimental_listPluginMetadata(
        args: Omit<PluginThreadMetadataListArgs, "pluginId"> & {
          pluginId?: string;
        },
      ) {
        return sdk.threads.experimental_listPluginMetadata({
          ...args,
          pluginId: args.pluginId ?? pluginId,
        });
      },
      async updatePluginMetadata(
        args: Omit<ThreadPluginMetadataUpdateArgs, "pluginId"> & {
          pluginId?: string;
        },
      ) {
        return sdk.threads.updatePluginMetadata({
          ...args,
          pluginId: args.pluginId ?? pluginId,
        });
      },
      fork(args: ThreadForkArgs) {
        return sdk.threads.fork(withPluginThreadAttribution(args, pluginId));
      },
      spawn(args: ThreadSpawnArgs) {
        return sdk.threads.spawn(withPluginThreadAttribution(args, pluginId));
      },
    },
  };
}

function createStagedRegistrations<
  TDeclaration,
  TNormalized extends { id: string },
  TBinding,
>(options: {
  validate: (declaration: TDeclaration) => TNormalized;
  bind: (id: string) => TBinding;
  isTaken?: (id: string) => boolean;
  registerLive: (
    declaration: TNormalized,
    binding: TBinding,
  ) => { dispose(): void };
  alreadyRegisteredMessage: (id: string) => string;
  assertLive: () => void;
  isActivated: () => boolean;
  disposeHooks: Array<() => void | Promise<void>>;
}): {
  register(declaration: TDeclaration): { dispose(): void };
  flush(): void;
  values(): TNormalized[];
} {
  const entries = new Map<
    string,
    {
      declaration: TNormalized;
      binding: TBinding;
      disposer: { dispose(): void } | null;
      disposed: boolean;
    }
  >();

  return {
    register(declaration) {
      options.assertLive();
      const normalized = options.validate(declaration);
      const binding = options.bind(normalized.id);

      if (entries.has(normalized.id)) {
        throw new Error(options.alreadyRegisteredMessage(normalized.id));
      }

      const entry = {
        declaration: normalized,
        binding,
        disposer: null as { dispose(): void } | null,
        disposed: false,
      };

      if (options.isActivated()) {
        entry.disposer = options.registerLive(normalized, binding);
      } else if (options.isTaken?.(normalized.id) === true) {
        throw new Error(options.alreadyRegisteredMessage(normalized.id));
      }

      entries.set(normalized.id, entry);

      const dispose = (): void => {
        if (entry.disposed) return;
        entry.disposed = true;
        entry.disposer?.dispose();

        if (entries.get(normalized.id) === entry) {
          entries.delete(normalized.id);
        }
      };

      options.disposeHooks.push(dispose);

      return { dispose };
    },
    flush() {
      for (const entry of entries.values()) {
        if (!entry.disposed && entry.disposer === null) {
          entry.disposer = options.registerLive(
            entry.declaration,
            entry.binding,
          );
        }
      }
    },
    values() {
      return [...entries.values()].map((entry) => entry.declaration);
    },
  };
}

const PLUGIN_HOST_CALL_MAX_TIMEOUT_MS = 30 * 60_000;

export function createPluginApi(options: {
  pluginId: string;
  logger: ServerLogger;
  db: DbConnection;
  dataDir: string;
  secrets: PluginSecretStore;
  getSdk: () => OmnyoSdk | undefined;
  getMachineEnrollments: () => MachineEnrollments;
  getAppUrl: () => string | null;
  getLoopbackBaseUrl: () => string | undefined;

  rpcCaller: PluginRpcCallerCredential;
  publishSignal: (channel: string, payload: unknown) => void;
  settingsChanged: () => void;
  reportNeedsConfiguration: (message: string) => void;
  isAgentToolNameTaken: (name: string) => string | undefined;
  isEnvironmentProviderIdTaken: (id: string) => string | undefined;
  isEventSourceFamilyTaken: (family: string) => string | undefined;
  isMachineProviderIdTaken: (id: string) => string | undefined;
  reportAgentToolProblem: (message: string) => void;

  requestQueueDrain: () => void;

  declaredIconNames: ReadonlySet<string>;
  brandingIcon: string | undefined;
  requestInteraction: (
    args: Omit<NormalizedPluginInteractionRequest, "presentation"> & {
      presentation: ThreadEventItemPresentation;
      signal?: AbortSignal;
    },
  ) => Promise<PluginInteractionResult>;
  ensureSharedPortTunnel: PluginHosts["ensureSharedPortTunnel"];
  validateSharedPortDeclaration: (
    hostId: string,
    ports: readonly number[],
  ) => readonly number[];
  declareSharedPorts: PluginHosts["declareSharedPorts"];
  replaceDeclaredSharedPorts: (
    declarations: readonly {
      hostId: string;
      ports: readonly number[];
    }[],
  ) => void;
  callPluginHost: (args: {
    contract: PluginRpcContract;
    method: string;
    input: unknown;
    hostId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<unknown>;
  registerProvider: (declaration: NormalizedPluginProviderDeclaration) => {
    dispose(): void;
  };
  registerAiService: (declaration: NormalizedPluginAiService) => {
    dispose(): void;
  };
  isProviderIdTaken: (providerId: string) => boolean;
  assertProviderRegistrable: (providerId: string) => void;
}): PluginApiHandle {
  const {
    pluginId,
    logger,
    db,
    dataDir,
    secrets,
    getSdk,
    getAppUrl,
    getLoopbackBaseUrl,
    rpcCaller,
    publishSignal,
    settingsChanged,
    reportNeedsConfiguration,
    isAgentToolNameTaken,
    reportAgentToolProblem,
    requestQueueDrain,
    declaredIconNames,
    brandingIcon,
    requestInteraction,
    ensureSharedPortTunnel,
    validateSharedPortDeclaration,
    declareSharedPorts,
    replaceDeclaredSharedPorts,
    callPluginHost,
    registerProvider,
    registerAiService,
    isProviderIdTaken,
    assertProviderRegistrable,
  } = options;

  let invalidated = false;
  let activated = false;
  let wrappedSdk: PluginSdk | undefined;
  let pendingNeedsConfiguration: string | null = null;
  const pendingAgentToolProblems: string[] = [];
  const pendingSharedPorts = new Map<string, readonly number[]>();
  const disposeHooks: Array<() => void | Promise<void>> = [];
  const installHandlers: Array<() => void | Promise<void>> = [];

  const settingsRecord: PluginApiHandle["settings"] = {
    descriptors: {},
    listeners: [],
  };

  const databaseHandles: Database.Database[] = [];

  const threadEventHandlers: PluginThreadEventHandlers = {
    "experimental_thread.events": [],
    "experimental_thread.parentChanged": [],
    "experimental_thread.maintenance": [],
    "experimental_terminal.input": [],
    "experimental_host.deleted": [],
    "experimental_environment.removed": [],
    "thread.created": [],
    "thread.active": [],
    "thread.idle": [],
    "thread.failed": [],
    "thread.archived": [],
    "thread.deleted": [],
    "interaction.pending": [],
    "message.queued": [],
    "message.dispatched": [],
    "turn.failed": [],
    "message.cancelled": [],
    "thread.unarchived": [],
  };

  const threadEventFilters = new WeakMap<object, PluginThreadEventFilter>();

  const hooks: PluginHookRecords = {
    "message.dispatch": null,
  };

  const environmentCompositions = new Map<
    string,
    NormalizedPluginEnvironmentComposition
  >();

  const environmentProviders = new Map<
    string,
    NormalizedPluginEnvironmentProvider
  >();

  const machineProviders = new Map<string, NormalizedPluginMachineProvider>();

  const serverAccessProviders = new Map<
    string,
    import("@omnyo/plugin-sdk").ServerAccessProviderDeclaration
  >();

  const eventSources = new Map<
    string,
    import("@omnyo/plugin-sdk").PluginEventSourceDeclaration
  >();

  const httpRoutes: PluginHttpRouteRecord[] = [];
  const websocketRoutes: PluginWebSocketRouteRecord[] = [];
  const rpcHandlers = new Map<string, PluginRpcHandler>();
  const hostWorkerExitHandlers: PluginHostWorkerExitHandler[] = [];
  const hostSignalHandlers: PluginHostSignalHandler[] = [];
  const backgroundServices: PluginBackgroundServiceRecord[] = [];
  const schedules: PluginScheduleRecord[] = [];

  let staleError: PluginContextStaleError | undefined;

  function stale(): PluginContextStaleError {
    staleError ??= new PluginContextStaleError(pluginId);

    return staleError;
  }

  function assertLive(): void {
    if (invalidated) throw stale();
  }

  const prefix = `[plugin:${pluginId}]`;

  function emitLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    logger[level](`${prefix} ${message}`);
    appendPluginLogLine(dataDir, pluginId, level, message);
  }

  const log: PluginLogger = {
    debug: (message) => emitLog("debug", message),
    info: (message) => emitLog("info", message),
    warn: (message) => emitLog("warn", message),
    error: (message) => emitLog("error", message),
  };

  async function requestInput(
    request: Parameters<PluginUi["requestInput"]>[0],
    requestOptions?: Parameters<PluginUi["requestInput"]>[1],
  ) {
    assertLive();
    const normalized = normalizeInteractionRequest(request);
    const glyph = normalized.presentation?.icon?.glyph;

    const iconProblem =
      glyph === undefined
        ? null
        : undeclaredIconProblem(pluginId, declaredIconNames, glyph);

    if (iconProblem !== null) {
      throw new Error(`ui.requestInput presentation.icon ${iconProblem}`);
    }

    const pending = requestInteraction({
      ...normalized,
      presentation: fillPluginPresentation({
        declared: normalized.presentation,
        brandingIcon,
        label: {
          pending: `Waiting for ${normalized.title}`,
          completed: `Submitted ${normalized.title}`,
        },
      }),
      signal: requestOptions?.signal,
    });

    if (!requestOptions?.signal?.aborted) {
      detachActivePluginToolCallForUserInput();
    }

    return pending;
  }

  const kv: PluginKvStorage = {
    async get(key) {
      assertLive();
      const raw = getPluginKvValue(db, pluginId, key);

      if (raw === undefined) return undefined;

      return JSON.parse(raw);
    },
    async set(key, value) {
      assertLive();
      const json = JSON.stringify(value);

      if (json === undefined) {
        throw new Error(`kv value for "${key}" is not JSON-serializable`);
      }

      const bytes = Buffer.byteLength(json, "utf8");

      if (bytes > KV_VALUE_MAX_BYTES) {
        throw new Error(
          `kv value for "${key}" is ${bytes} bytes; the limit is ${KV_VALUE_MAX_BYTES} (256KB). ` +
            `Store large data in storage.database() instead.`,
        );
      }

      setPluginKvValue(db, pluginId, key, json);
    },
    async delete(key) {
      assertLive();
      deletePluginKvValue(db, pluginId, key);
    },
    async list(kvPrefix) {
      assertLive();

      return listPluginKvKeys(db, pluginId, kvPrefix);
    },
  };

  const experimental_secrets: PluginSecrets = {
    async get(name) {
      assertLive();
      await secrets.sealLegacyTreeOnce();

      return secrets.get(name);
    },
    async set(name, value) {
      assertLive();
      await secrets.sealLegacyTreeOnce();
      await secrets.set(name, value);
    },
    async delete(name) {
      assertLive();
      await secrets.sealLegacyTreeOnce();
      await secrets.delete(name);
    },
    async list(secretPrefix) {
      assertLive();
      await secrets.sealLegacyTreeOnce();

      return secrets.list(secretPrefix);
    },
  };

  let databaseHandle: Database.Database | undefined;

  const storage: PluginStorage = {
    kv,
    database() {
      assertLive();

      if (databaseHandle?.open) return databaseHandle;

      if (databaseHandle) {
        const index = databaseHandles.indexOf(databaseHandle);

        if (index !== -1) databaseHandles.splice(index, 1);
      }

      const dir = join(dataDir, "plugins", pluginId);
      mkdirSync(dir, { recursive: true });
      const database = new Database(join(dir, "data.db"));
      database.pragma("auto_vacuum = INCREMENTAL");
      database.pragma("journal_mode = WAL");
      database.pragma("busy_timeout = 5000");
      databaseHandle = database;
      databaseHandles.push(database);

      return database;
    },
    migrate(database, statements) {
      assertLive();
      runPluginStorageMigrations(database, statements);
    },
  };

  const settings: PluginSettings = {
    define(descriptors) {
      assertLive();

      const validated = registerSettingDescriptors(
        settingsRecord.descriptors,
        descriptors as Record<string, unknown>,
      );

      void sealLegacySecretSettings({ secrets, descriptors: validated });

      type Values = PluginSettingsValues<typeof descriptors>;

      return {
        async get() {
          assertLive();

          return (await readPluginSettingsValues({
            db,
            secrets,
            pluginId,
            descriptors: validated,
          })) as Values;
        },
        async experimental_set(values) {
          assertLive();
          const rawValues: Record<string, unknown> = {};

          for (const [key, value] of Object.entries(values)) {
            rawValues[key] = value;
          }

          const errors = validateSettingsUpdate(validated, rawValues);

          if (errors.length > 0) {
            throw new Error(errors.join("; "));
          }

          const storeArgs = {
            db,
            secrets,
            pluginId,
            descriptors: settingsRecord.descriptors,
          };

          const prev = await readPluginSettingsValues(storeArgs);
          await writePluginSettingsUpdate({ ...storeArgs, values: rawValues });
          const next = await readPluginSettingsValues(storeArgs);

          if (JSON.stringify(next) !== JSON.stringify(prev)) {
            for (const listener of settingsRecord.listeners) {
              try {
                listener(next, prev);
              } catch (error) {
                emitLog(
                  "warn",
                  `settings onChange listener failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }

            if (activated) settingsChanged();
          }

          return (await readPluginSettingsValues({
            db,
            secrets,
            pluginId,
            descriptors: validated,
          })) as Values;
        },
        onChange(listener) {
          assertLive();
          settingsRecord.listeners.push(listener as PluginSettingsListener);
        },
      };
    },
  };

  const http: PluginHttp = {
    route(method, path, handler, opts) {
      assertLive();

      const route = normalizeHttpRouteRegistration(
        method,
        path,
        handler,
        opts,
        httpRoutes,
      );

      httpRoutes.push({ ...route, handler });
    },
    experimental_websocket(path, handler, opts) {
      assertLive();

      const route = normalizeWebSocketRouteRegistration(
        path,
        handler,
        opts,
        websocketRoutes,
      );

      websocketRoutes.push({
        ...route,
        handler,
        active: true,
        sockets: new Set(),
      });
    },
  };

  const rpc: PluginRpc = {
    register(contract, handlers, options) {
      assertLive();

      for (const [name, record] of normalizeRpcRegistration(
        contract,
        handlers,
        rpcHandlers,
        options,
      )) {
        rpcHandlers.set(name, record);
      }
    },
  };

  const realtime: PluginRealtime = {
    publish(channel, payload) {
      assertLive();
      publishSignal(channel, normalizeRealtimePayload(channel, payload));
    },
  };

  const background: PluginBackground = {
    service(name, service) {
      assertLive();
      backgroundServices.push(
        validateBackgroundServiceRegistration(
          name,
          service,
          backgroundServices,
        ),
      );
    },
    schedule(name, cron, fn) {
      assertLive();
      schedules.push(
        validateScheduleRegistration(
          name,
          cron,
          fn,
          schedules,
          (expression) => {
            CronExpressionParser.parse(expression);
          },
        ),
      );
    },
  };

  const agentTools: PluginAgentToolRecord[] = [];

  const providerRegistrations = createStagedRegistrations({
    validate: (declaration: PluginProviderDeclaration) => {
      const normalized = validatePluginProviderDeclaration(declaration);

      const problem =
        normalized.icon === undefined
          ? null
          : undeclaredIconProblem(pluginId, declaredIconNames, normalized.icon);

      if (problem !== null) {
        throw new Error(providerIconRefusalMessage(normalized.id, problem));
      }

      return normalized;
    },
    bind: assertProviderRegistrable,
    isTaken: isProviderIdTaken,
    registerLive: registerProvider,
    alreadyRegisteredMessage: providerAlreadyRegisteredMessage,
    assertLive,
    isActivated: () => activated,
    disposeHooks,
  });

  const providerEnvResolvers = new Map<string, PluginProviderEnvResolver>();

  const providerEnvHealthResolvers = new Map<
    string,
    PluginProviderEnvHealthResolver
  >();

  const providerModelNoticeResolvers = new Map<
    string,
    PluginProviderModelNoticeResolver
  >();

  let agentConfigurationProvider: PluginAgentConfigurationProvider | null =
    null;

  let instructionProvider: PluginInstructionProvider | null = null;

  const agents: PluginAgents = {
    configure(provider) {
      assertLive();

      if (agentConfigurationProvider !== null) {
        throw new Error("agent configuration is already registered");
      }

      if (typeof provider !== "function") {
        throw new Error(
          "configure requires a provider function (context) => ({ tools, skills, instructions? })",
        );
      }

      agentConfigurationProvider = provider;
    },
    contributeInstructions(provider) {
      assertLive();

      if (instructionProvider !== null) {
        throw new Error("agent instructions are already registered");
      }

      if (typeof provider !== "function") {
        throw new Error(
          "contributeInstructions requires a provider function (ctx) => string | null",
        );
      }

      instructionProvider = provider;
    },
    registerTool(tool: {
      name: string;
      description: string;
      instructions?: string;
      presentation?: PluginRowPresentation;
      parameters: unknown;
      execute(
        params: never,
        ctx: PluginAgentToolContext,
      ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
    }) {
      assertLive();

      const record = normalizeAgentToolRegistration({
        pluginId,
        declaredIconNames,
        tool,
      });

      const owner = isAgentToolNameTaken(record.name);

      if (owner !== undefined) {
        const problem = `tool "${record.name}" is already registered by plugin "${owner}" — not registered`;

        if (activated) reportAgentToolProblem(problem);
        else pendingAgentToolProblems.push(problem);

        return;
      }

      if (agentTools.some((existing) => existing.name === record.name)) {
        throw new Error(`tool "${record.name}" is already registered`);
      }

      agentTools.push(record);
    },
  };

  const mentionProviders: PluginMentionProviderRecord[] = [];

  const ui: PluginUi = {
    requestInput,
    registerMentionProvider(provider) {
      assertLive();

      const record = normalizeMentionProviderRegistration(
        provider,
        mentionProviders,
      );

      mentionProviders.push({
        ...record,
        search: createBoundedMentionSearch(record.search),
      });
    },
  };

  const cliRecord: PluginApiHandle["cli"] = { registration: null };

  const cli: PluginCli = {
    register(registration) {
      assertLive();
      cliRecord.registration = normalizeCliRegistration(
        registration,
        cliRecord.registration !== null,
      );
    },
  };

  const status: PluginStatusApi = {
    needsConfiguration(message) {
      assertLive();

      const normalized =
        typeof message === "string" && message.length > 0
          ? message
          : "needs configuration";

      if (activated) reportNeedsConfiguration(normalized);
      else pendingNeedsConfiguration = normalized;
    },
  };

  const server: PluginServerApi = {
    get experimental_appUrl(): string | null {
      assertLive();

      return getAppUrl();
    },
    get loopbackBaseUrl(): string {
      assertLive();
      const baseUrl = getLoopbackBaseUrl();

      if (baseUrl === undefined) {
        throw new Error(
          "api.server.loopbackBaseUrl is not available until the server is listening — " +
            "use it inside handlers, services, or timers, not at factory load time",
        );
      }

      return baseUrl;
    },
    get experimental_dataDir(): string {
      assertLive();

      return dataDir;
    },
  };

  const hosts: PluginHosts = {
    experimental_client({ contract, experimental_signals }) {
      assertLive();

      return {
        async call(method, input, callOptions) {
          assertLive();

          if (!activated) {
            throw new Error(
              "host plugin calls are unavailable during factory registration; call from a handler, service, or timer",
            );
          }

          if (typeof method !== "string" || contract[method] === undefined) {
            throw new Error(`unknown host rpc method "${String(method)}"`);
          }

          if (
            typeof callOptions !== "object" ||
            callOptions === null ||
            typeof callOptions.hostId !== "string" ||
            callOptions.hostId.length === 0
          ) {
            throw new Error(`host rpc method "${method}" requires a host id`);
          }

          return callPluginHost({
            contract,
            method,
            input,
            hostId: callOptions.hostId,
            ...(callOptions.signal === undefined
              ? {}
              : { signal: callOptions.signal }),
            ...(callOptions.timeoutMs === undefined
              ? {}
              : {
                  timeoutMs: Math.min(
                    Math.max(1_000, Math.floor(callOptions.timeoutMs)),
                    PLUGIN_HOST_CALL_MAX_TIMEOUT_MS,
                  ),
                }),
          });
        },
        experimental_onWorkerExit(handler) {
          assertLive();

          if (typeof handler !== "function") {
            throw new Error("host worker exit subscription requires a handler");
          }

          hostWorkerExitHandlers.push(handler);
          let subscribed = true;

          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostWorkerExitHandlers.indexOf(handler);

            if (index >= 0) hostWorkerExitHandlers.splice(index, 1);
          };
        },
        experimental_onSignal(signal, handler) {
          assertLive();
          const descriptor = experimental_signals?.[signal];

          if (
            typeof signal !== "string" ||
            signal.length === 0 ||
            typeof descriptor !== "object" ||
            descriptor === null ||
            !isStandardSchema(descriptor.payload)
          ) {
            throw new Error(`unknown host signal "${String(signal)}"`);
          }

          if (typeof handler !== "function") {
            throw new Error("host signal subscription requires a handler");
          }

          const record: PluginHostSignalHandler = {
            signal,
            payloadSchema: descriptor.payload,
            handler,
          };

          hostSignalHandlers.push(record);
          let subscribed = true;

          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostSignalHandlers.indexOf(record);

            if (index >= 0) hostSignalHandlers.splice(index, 1);
          };
        },
      };
    },
    ensureSharedPortTunnel(hostId) {
      assertLive();

      return ensureSharedPortTunnel(hostId);
    },
    declareSharedPorts(hostId, ports) {
      assertLive();

      if (activated) declareSharedPorts(hostId, ports);
      else {
        pendingSharedPorts.set(
          hostId,
          validateSharedPortDeclaration(hostId, ports),
        );
      }
    },
  };

  const events: PluginEvents = {
    on(event, handler, options) {
      assertLive();
      const handlers = threadEventHandlers[event];

      if (handlers === undefined) {
        throw new Error(
          `unknown event "${String(event)}" — supported events: ${Object.keys(
            threadEventHandlers,
          ).join(", ")}`,
        );
      }

      if (options === undefined) {
        handlers.push(handler);
      } else {
        if (event !== "experimental_thread.events") {
          throw new Error(
            "Event type filters require experimental_thread.events",
          );
        }

        const subscription: typeof handler = (payload) => handler(payload);
        threadEventFilters.set(
          subscription,
          createThreadEventFilter(options.experimental_eventTypes),
        );
        handlers.push(subscription);
      }
    },
  };

  const experimental_hooks: PluginHooks = {
    on(hook, handler) {
      registerPluginHook(hooks, assertLive, hook, handler);
    },
    async recheck(hook) {
      assertLive();

      void hook;

      requestQueueDrain();
    },
  };

  const providers: PluginProviders = {
    register: providerRegistrations.register,
    experimental_contributeEnv(providerId, resolve) {
      assertLive();
      validateProviderEnvContribution(
        "provider environment contribution",
        providerId,
        resolve,
        providerEnvResolvers,
      );
      providerEnvResolvers.set(providerId, resolve);
    },
    experimental_contributeEnvHealth(providerId, resolve) {
      assertLive();
      validateProviderEnvContribution(
        "provider environment health contribution",
        providerId,
        resolve,
        providerEnvHealthResolvers,
      );
      providerEnvHealthResolvers.set(providerId, resolve);
    },
    experimental_contributeModelNotice(providerId, resolve) {
      assertLive();
      validateProviderEnvContribution(
        "provider model notice contribution",
        providerId,
        resolve,
        providerModelNoticeResolvers,
      );
      providerModelNoticeResolvers.set(providerId, resolve);
    },
  };

  const experimental_environments: PluginEnvironments = {
    register(
      declaration:
        | import("@omnyo/plugin-sdk").PluginEnvironmentProviderDeclaration
        | NormalizedPluginEnvironmentComposition,
    ) {
      assertLive();

      if ("machineProviderId" in declaration) {
        const composition = environmentCompositionSchema.parse(declaration);

        const problem =
          composition.icon === null
            ? null
            : undeclaredIconProblem(
                pluginId,
                declaredIconNames,
                composition.icon,
              );

        if (problem !== null)
          throw new Error(providerIconRefusalMessage(composition.id, problem));
        const owner = options.isEnvironmentProviderIdTaken(composition.id);

        if (owner !== undefined)
          throw new Error(
            `environment provider "${composition.id}" is already registered by plugin "${owner}"`,
          );

        if (environmentProviders.has(composition.id))
          throw new Error(
            "Environment ID is already registered as a concrete provider",
          );
        environmentCompositions.set(composition.id, composition);

        return;
      }

      if (environmentCompositions.has(declaration.id))
        throw new Error(
          "Environment ID is already registered as a composition",
        );

      const provider =
        validatePluginEnvironmentProviderDeclaration(declaration);

      const problem =
        provider.icon === null
          ? null
          : undeclaredIconProblem(pluginId, declaredIconNames, provider.icon);

      if (problem !== null)
        throw new Error(providerIconRefusalMessage(provider.id, problem));
      const owner = options.isEnvironmentProviderIdTaken(provider.id);

      if (owner !== undefined) {
        throw new Error(
          `environment provider "${provider.id}" is already registered by plugin "${owner}"`,
        );
      }

      environmentProviders.set(provider.id, provider);
    },
    async recheck() {
      assertLive();
      requestEnvironmentProviderRecheck(options.pluginId);
    },
  };

  const experimental_eventSources: import("@omnyo/plugin-sdk").PluginEventSources =
    {
      register(source) {
        assertLive();
        validateEventSourceDeclaration(source);

        const owner = eventSources.has(source.family)
          ? pluginId
          : options.isEventSourceFamilyTaken(source.family);

        if (owner !== undefined)
          throw new Error(
            `event source "${source.family}" is already registered by plugin "${owner}"`,
          );

        eventSources.set(source.family, source);
      },
    };

  const experimental_serverAccess: import("@omnyo/plugin-sdk").PluginServerAccess =
    {
      register(declaration) {
        assertLive();
        validateServerAccessProviderDeclaration(declaration);

        if (
          serverAccessProviders.has(declaration.id) ||
          listServerAccessProviders().some(
            (entry) =>
              entry.provider.id === declaration.id &&
              entry.pluginId !== pluginId,
          )
        ) {
          throw new Error(
            `Server access provider "${declaration.id}" is already registered`,
          );
        }

        serverAccessProviders.set(declaration.id, declaration);
      },
      recheck() {
        assertLive();
        requestServerAccessRecheck(options.pluginId);
      },
    };

  const enrollmentApi: MachineEnrollments = {
    clearPending(key) {
      assertLive();
      options.getMachineEnrollments().clearPending(key);
    },
    prepare(request) {
      assertLive();

      return options.getMachineEnrollments().prepare(request);
    },
    waitForConnection(request) {
      assertLive();

      return options.getMachineEnrollments().waitForConnection(request);
    },
  };

  const experimental_machines: PluginMachines = {
    ...createMachineBootstrapApi(enrollmentApi),
    async getResource(hostId) {
      assertLive();

      return getHost(db, hostId)?.resource ?? null;
    },
    register(declaration) {
      assertLive();
      const provider = validatePluginMachineProviderDeclaration(declaration);

      const problem = undeclaredIconProblem(
        pluginId,
        declaredIconNames,
        provider.icon,
      );

      if (problem !== null) {
        throw new Error(providerIconRefusalMessage(provider.id, problem));
      }

      const owner = options.isMachineProviderIdTaken(provider.id);

      if (owner !== undefined) {
        throw new Error(
          `machine provider "${provider.id}" is already registered by plugin "${owner}"`,
        );
      }

      machineProviders.set(provider.id, provider);
    },
  };

  const aiServiceRegistrations = createStagedRegistrations({
    validate: validatePluginAiServiceDeclaration,
    bind: () => null,
    registerLive: (declaration) => registerAiService(declaration),
    alreadyRegisteredMessage: aiServiceAlreadyRegisteredMessage,
    assertLive,
    isActivated: () => activated,
    disposeHooks,
  });

  const experimental_aiServices: PluginAiServices = {
    register: aiServiceRegistrations.register,
  };

  const api: PluginApi = {
    pluginId,
    log,
    experimental_reportError(error, report) {
      assertLive();
      const valid = validatePluginErrorReport(error, report);
      captureProcessError(valid.error, {
        level: "error",
        stage: "plugin",
        ...(valid.experimental_diagnostic === undefined
          ? {}
          : {
              diagnostic: {
                operation: "plugin" as const,
                dependency: "plugin" as const,
                ...valid.experimental_diagnostic,
              },
            }),
        tags: {
          plugin: pluginId,
          operation: valid.operation,
          code: valid.code,
        },
        fingerprint: ["plugin", pluginId, valid.operation, valid.code],
      });
    },
    settings,
    storage,
    http,
    rpc,
    realtime,
    background,
    cli,
    agents,
    providers,
    ui,
    events,
    experimental_hooks,
    experimental_environments,
    experimental_machines,
    experimental_serverAccess,
    experimental_eventSources,
    experimental_secrets,
    status,
    server,
    hosts,
    experimental_aiServices,
    get sdk(): PluginSdk {
      assertLive();
      const sdk = getSdk();
      const loopbackBaseUrl = getLoopbackBaseUrl();

      if (!sdk || loopbackBaseUrl === undefined) {
        throw new Error(
          "api.sdk is not available until the server is listening — " +
            "use it inside handlers, services, or timers, not at factory load time",
        );
      }

      wrappedSdk ??= wrapSdkForPlugin(
        createPluginIdentifiedSdk({
          assertLive,
          sdk,
          baseUrl: loopbackBaseUrl,
          pluginId,
          db: options.db,
          logger: options.logger,
        }),
        pluginId,
        createPluginRpcCallerSdk({
          baseUrl: loopbackBaseUrl,
          token: rpcCaller.token,
        }),
        assertLive,
      );

      return wrappedSdk;
    },
    onDispose(hook) {
      assertLive();
      disposeHooks.push(hook);
    },
    onInstall(handler) {
      assertLive();

      if (typeof handler !== "function") {
        throw new Error("onInstall expects a function");
      }

      installHandlers.push(handler);
    },
  };

  return {
    api,
    disposeHooks,
    installHandlers,
    settings: settingsRecord,
    databaseHandles,
    threadEventHandlers,
    threadEventFilters,
    hooks,
    environmentCompositions,
    environmentProviders,
    machineProviders,
    serverAccessProviders,
    eventSources,
    httpRoutes,
    websocketRoutes,
    rpcHandlers,
    hostWorkerExitHandlers,
    hostSignalHandlers,
    backgroundServices,
    schedules,
    cli: cliRecord,
    agentTools,
    listProviderDeclarations: providerRegistrations.values,
    providerEnvResolvers,
    providerEnvHealthResolvers,
    providerModelNoticeResolvers,
    get agentConfigurationProvider() {
      return agentConfigurationProvider;
    },
    get instructionProvider() {
      return instructionProvider;
    },
    mentionProviders,
    activate() {
      if (activated) return;
      assertLive();
      replaceDeclaredSharedPorts(
        [...pendingSharedPorts].map(([hostId, ports]) => ({ hostId, ports })),
      );
      providerRegistrations.flush();
      aiServiceRegistrations.flush();
      activated = true;

      const cliWarning = cliRecord.registration
        ? pluginCliCollisionWarning(pluginId, cliRecord.registration.name)
        : null;

      if (cliWarning) emitLog("warn", cliWarning);
      pendingSharedPorts.clear();

      for (const problem of pendingAgentToolProblems) {
        reportAgentToolProblem(problem);
      }

      pendingAgentToolProblems.length = 0;

      if (pendingNeedsConfiguration !== null) {
        reportNeedsConfiguration(pendingNeedsConfiguration);
        pendingNeedsConfiguration = null;
      }
    },
    closeWebSockets() {
      for (const route of websocketRoutes) {
        route.active = false;

        for (const socket of route.sockets) {
          try {
            socket.close(1012, "Plugin reloaded or disabled");
          } catch (error) {
            emitLog(
              "warn",
              `websocket ${route.path} close failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    },
    invalidate() {
      invalidated = true;
      rpcCaller.revoke();
    },
  };
}
