import type { AgentProcessContainment } from "./agent-process-containment.js";
import type { IsolatedFilesystemMutator } from "./workspace-read-client.js";
import type { WorkspaceReadCoalescer } from "./workspace-read-coalescer.js";
import type { CommandMetadataCatalog } from "./command-metadata.js";
import {
  CommandDispatchError,
  ExpectedCommandDispatchError,
} from "./command-errors.js";

export {
  CommandDispatchError,
  ExpectedCommandDispatchError,
} from "./command-errors.js";

import type { DesktopBrowserBroker } from "./desktop-browser-broker.js";
import type { ManagedPreviewManager } from "./previews/managed-preview-manager.js";
import type { PreviewHostTransport } from "./previews/preview-transport.js";
import type { TerminalManager } from "./terminals/terminal-manager.js";
import {
  CompetingTurnError,
  type AgentRuntimeBridgeLaunch,
} from "@omnyo/agent-runtime";
import type { AvailableModel } from "@omnyo/domain";
import type { EventSink } from "./event-sink.js";
import {
  COMPETING_TURN_ERROR_CODE,
  type EnvironmentHookProgressMessage,
  type HostDaemonCommand,
  type ProviderHealthResult,
  type ProviderUsageResult,
  type HostDaemonBridgeLaunch,
  type HostDaemonContributedEnvEntry,
  type HostDaemonInjectedSkillSource,
  type HostDaemonOnlineRpcCommand,
  type HostDaemonConnectTunnelIdentity,
  type WorkspaceContext,
} from "@omnyo/host-daemon-contract";
import { BRIDGE_JSON_RPC_ERRORS } from "@omnyo/provider-bridge-protocol";
import type {
  ProviderInstallationCommand,
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
} from "@omnyo/provider-bridge-protocol";
import { ensurePluginProcessDataDir } from "@omnyo/process-utils";
import type { InteractiveResolveCommandInput } from "./interactive-request-registry.js";
import type { RuntimeManager, RuntimeEntry } from "./runtime-manager.js";
import type { FetchProjectAttachment } from "./project-attachments.js";
import type { FetchSkillTree } from "./skill-trees.js";
import type { HostDaemonLogger } from "./logger.js";
import type { ServerMoveService } from "./server-move/service.js";
import {
  ensureCachedPluginHostArtifact,
  type FetchPluginHostArtifact,
} from "./plugin-host-artifact-cache.js";

type DispatchCommand = HostDaemonCommand | HostDaemonOnlineRpcCommand;

export type CommandOf<TType extends DispatchCommand["type"]> = Extract<
  DispatchCommand,
  { type: TType }
>;

export interface CommandDispatchOptions {
  managedPreviews?: ManagedPreviewManager;
  terminals?: Pick<TerminalManager, "foreground">;
  previewTransport?: PreviewHostTransport;
  agentProcessContainment?: AgentProcessContainment;
  commandMetadata?: Pick<CommandMetadataCatalog, "list">;
  filesystemMutator?: Pick<
    IsolatedFilesystemMutator,
    "execute" | "replaceDirectory"
  >;
  emitEnvironmentHookProgress?: (
    message: EnvironmentHookProgressMessage,
  ) => void;
  desktopBrowserBroker?: DesktopBrowserBroker;
  dataDir: string;
  logger: Pick<HostDaemonLogger, "debug" | "warn">;
  fetchProjectAttachment: FetchProjectAttachment;
  fetchSkillTree?: FetchSkillTree;
  fetchPluginHostArtifact?: FetchPluginHostArtifact;
  runtimeManager: RuntimeManager;
  workspaceReads: WorkspaceReadCoalescer;
  eventSink: Pick<EventSink, "emit" | "flush">;
  listModels: (args: {
    selectedModel?: string;
    providerId: string;
    bridgeLaunch: AgentRuntimeBridgeLaunch;
    cwd?: string;
    contributedEnv: readonly HostDaemonContributedEnvEntry[];
  }) => Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;
  providerHealth: (args: {
    providerId: string;
    bridgeLaunch: AgentRuntimeBridgeLaunch;
    cwd?: string;
  }) => Promise<ProviderHealthResult>;
  providerUsage: (args: {
    providerId: string;
    bridgeLaunch: AgentRuntimeBridgeLaunch;
    cwd?: string;
    contributedEnv?: readonly HostDaemonContributedEnvEntry[];
  }) => Promise<ProviderUsageResult>;
  providerInstallationStatus: (args: {
    providerId: string;
    bridgeLaunch: AgentRuntimeBridgeLaunch;
    cwd?: string;
    requirement?: "thread_rewind";
    checkUpdates?: boolean;
  }) => Promise<ProviderInstallationStatus>;
  providerInstallationRun: (args: {
    providerId: string;
    action: "install" | "update";
    bridgeLaunch: AgentRuntimeBridgeLaunch;
    cwd?: string;
  }) => Promise<ProviderInstallationRunResult>;
  streamProviderInstallation?: (args: {
    providerId: string;
    plan: ProviderInstallationCommand;
    env?: NodeJS.ProcessEnv;
  }) => ReadableStream<Uint8Array>;
  refreshShellEnv: (args: { allowStale: boolean }) => Promise<void>;
  resolveInteractiveRequest?: (
    request: InteractiveResolveCommandInput,
  ) => Promise<void>;
  ensureConnectTunnelIdentity?: () => Promise<HostDaemonConnectTunnelIdentity>;
  serverMove?: ServerMoveService;
  runtimeUpdateOwnCommands?: number;
  runtimeUpdatePluginBlockers?: () => string[];
  closeRuntimeUpdatePluginLeases?: (
    pluginIds: readonly string[],
  ) => Promise<string[]>;
  threadStorageRootPath: string;
}

export function isExpectedCommandDispatchError(
  error: unknown,
): error is ExpectedCommandDispatchError {
  return error instanceof ExpectedCommandDispatchError;
}

const EXPECTED_ONLINE_RPC_FAILURE_CODES = new Set([
  "file_too_large",
  "provision_cancelled",
]);

export function isExpectedOnlineRpcFailureError(error: unknown): boolean {
  return (
    isExpectedCommandDispatchError(error) ||
    EXPECTED_ONLINE_RPC_FAILURE_CODES.has(getErrorCode(error))
  );
}

const MISSING_EXECUTABLE_PATTERN = /\bENOENT\b/;

const SPAWN_PATTERN = /\bspawn\b/;

export async function resolveRuntimeBridgeLaunch(
  bridgeLaunch: HostDaemonBridgeLaunch,
  options: Pick<
    CommandDispatchOptions,
    "dataDir" | "fetchPluginHostArtifact" | "logger"
  >,
): Promise<AgentRuntimeBridgeLaunch> {
  const capabilities = {
    ...bridgeLaunch.capabilities,
    permissionModes: [...bridgeLaunch.capabilities.permissionModes],
  };

  const providerOptions = { ...bridgeLaunch.providerOptions };
  const envPassthrough = [...bridgeLaunch.envPassthrough];

  const dataDir = await ensurePluginProcessDataDir({
    daemonDataDir: options.dataDir,
    pluginId: bridgeLaunch.pluginId,
    kind: "bridge-data",
  });

  if (options.fetchPluginHostArtifact === undefined) {
    throw new CommandDispatchError(
      "provider_bridge_unavailable",
      "This daemon has no plugin host artifact fetcher configured",
    );
  }

  const artifactPath = await ensureCachedPluginHostArtifact({
    dataDir: options.dataDir,
    pluginId: bridgeLaunch.pluginId,
    fetchArtifact: options.fetchPluginHostArtifact,
    digest: bridgeLaunch.source.digest,
    byteLength: bridgeLaunch.source.byteLength,
    logger: options.logger,
  });

  return {
    pluginId: bridgeLaunch.pluginId,
    dataDir,
    source: {
      kind: "artifact",
      digest: bridgeLaunch.source.digest,
      artifactPath,
    },
    capabilities,
    providerOptions,
    envPassthrough,
  };
}

export function getErrorCode(error: unknown): string {
  if (error instanceof CommandDispatchError) {
    return error.code;
  }

  if (error instanceof CompetingTurnError) {
    return COMPETING_TURN_ERROR_CODE;
  }

  if (isBridgeMissingExecutableError(error)) {
    return "missing_executable";
  }

  if (isStructuredSpawnMissingExecutableError(error)) {
    return "missing_executable";
  }

  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  if (isMessageOnlySpawnMissingExecutableError(error)) {
    return "missing_executable";
  }

  return "command_failed";
}

function isBridgeMissingExecutableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE
  );
}

function isStructuredSpawnMissingExecutableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    "code" in error &&
    error.code === "ENOENT" &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn")
  );
}

function isMessageOnlySpawnMissingExecutableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    MISSING_EXECUTABLE_PATTERN.test(error.message) &&
    SPAWN_PATTERN.test(error.message)
  );
}

export async function requireWorkspaceEnvironment(
  args: {
    environmentId: string;
    injectedSkillSources?: readonly HostDaemonInjectedSkillSource[];
    targetThreadId?: string;
    workspaceContext: WorkspaceContext;
  },
  runtimeManager: RuntimeManager,
): Promise<RuntimeEntry> {
  const existing = await runtimeManager.getOrAwait(args.environmentId);

  if (existing) {
    if (existing.path !== args.workspaceContext.workspacePath) {
      await runtimeManager.forgetEnvironment(args.environmentId);
      throw new ExpectedCommandDispatchError(
        "workspace_type_mismatch",
        `Loaded environment ${args.environmentId} is bound to ${existing.path}, not ${args.workspaceContext.workspacePath}`,
      );
    }
  }

  return runtimeManager.ensureEnvironment({
    environmentId: args.environmentId,
    ...(args.injectedSkillSources !== undefined
      ? { injectedSkillSources: args.injectedSkillSources }
      : {}),
    ...(args.targetThreadId !== undefined
      ? { targetThreadId: args.targetThreadId }
      : {}),
    workspacePath: args.workspaceContext.workspacePath,
  });
}
