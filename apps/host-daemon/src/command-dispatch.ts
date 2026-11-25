import {
  manageClaudeProfiles,
  withClaudeProfileEnvironment,
} from "./claude-profiles.js";
import { prepareWorkspaceIdentityV1 } from "./command-handlers/prepare-workspace-identity-v1.js";
import { installGlobalSkills } from "./command-handlers/install-global-skills.js";
import {
  resolveExecutable,
  withVcsProcessPriority,
} from "@omnyo/process-utils";
import { operationEnvironment } from "./operation-environment.js";
import {
  runEnvironmentHook,
  cancelEnvironmentHook,
} from "./command-handlers/environment-hook.js";
import {
  parseHostDaemonOnlineRpcResultForCommand,
  onboardingProviderExecutables,
  type HostDaemonOnlineRpcResultForCommand,
  providerCliInstallEventSchema,
  type DesktopBrowserBrokerCommand,
  type DesktopBrowserBrokerResult,
  type HostDaemonCommand,
  type HostDaemonCommandResult,
  type HostDaemonOnlineRpcCommand,
  type HostDaemonOnlineRpcCommandType,
  type HostDaemonOnlineRpcResult,
  type HostDaemonSettledCommandType,
  type ProviderCliInstallEvent,
  type ProviderInstallationOperation,
} from "@omnyo/host-daemon-contract";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeBridgeLaunch } from "@omnyo/agent-runtime";
import semver from "semver";
import {
  ExpectedCommandDispatchError,
  getErrorCode,
  resolveRuntimeBridgeLaunch,
  type CommandOf,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";
import {
  cancelEnvironmentProvision,
  provisionEnvironment,
} from "./command-handlers/environment.js";
import { resolveInteractiveRequest } from "./command-handlers/interactive.js";
import { pickHostFolder } from "./command-handlers/native-folder-picker.js";
import {
  ProviderInstallationInProgressError,
  streamProviderInstallation,
} from "./provider-installation.js";
import type {
  ProviderInstallationStatus,
  ProviderInstallationVerification,
} from "@omnyo/provider-bridge-protocol";
import {
  discardThreadRewind,
  deleteThreadStorage,
  ensureThreadRuntime,
  prepareThreadRewind,
  startThread,
  submitTurn,
} from "./command-handlers/thread.js";
import { WorkspaceError } from "@omnyo/host-workspace";
import {
  cloneProject,
  resolveProjectCloneDefaultPath,
} from "./command-handlers/project.js";
import {
  requireResolvedWorkspaceForCommand,
  resolveWorkspaceForCommand,
  workspaceResolutionFailureFromError,
} from "./workspace-resolution.js";
import { userExecutableProcessOptions } from "./user-executable-env.js";
import type {
  ServerMoveService,
  WorkerUpdateScope,
} from "./server-move/service.js";
import {
  readIsolatedFilesystemCommand,
  readIsolatedWorkspaceAgentContext,
} from "./workspace-read-client.js";
import type { FilesystemMutationCommand } from "./workspace-read-protocol.js";
import type { ReadonlyFilesystemCommand } from "./workspace-read-protocol.js";
import { workspaceReadKey } from "./workspace-read-coalescer.js";

const THREAD_STOP_ACTIVE_TURN_WAIT_MS = 5_000;

const READONLY_FILESYSTEM_MUTATION_TYPES: ReadonlySet<
  FilesystemMutationCommand["type"]
> = new Set(["host.inspect_git_source", "host.list_branch_options"]);

type RuntimeStopCommand =
  | CommandOf<"thread.stop">
  | CommandOf<"thread.storage.delete">;

async function stopThreadRuntime(
  command: RuntimeStopCommand,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"thread.stop">> {
  const released =
    await options.runtimeManager.releaseThreadFromOtherEnvironments({
      activeTurn: "interrupt",
      environmentId: command.environmentId,
      threadId: command.threadId,
    });

  const entry = await options.runtimeManager.getOrAwait(command.environmentId);

  if (!entry) {
    await options.eventSink.flush();

    return { providerCheckpointId: released.providerCheckpointId };
  }

  let providerCheckpointId = released.providerCheckpointId;

  if (entry.runtime.hasThread(command.threadId)) {
    if (
      command.type === "thread.stop" &&
      command.intent === "release" &&
      entry.runtime.getActiveTurnId(command.threadId) !== null
    ) {
      await options.eventSink.flush();

      return { providerCheckpointId, activeTurnRetained: true };
    }

    if (command.type !== "thread.stop" || command.intent !== "release") {
      await entry.runtime.waitForActiveTurn(command.threadId, {
        timeoutMs: THREAD_STOP_ACTIVE_TURN_WAIT_MS,
      });
    }

    const result = await entry.runtime.stopThread({
      threadId: command.threadId,
    });

    providerCheckpointId = result.providerCheckpointId ?? providerCheckpointId;
  }

  await options.eventSink.flush();

  return { providerCheckpointId };
}

export {
  getErrorCode,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";

type CommandHandlerMap = {
  [TType in HostDaemonSettledCommandType]: (
    command: Extract<HostDaemonCommand, { type: TType }>,
    options: CommandDispatchOptions,
  ) => Promise<HostDaemonCommandResult<TType>>;
};

type OnlineRpcHandlerMap = {
  [TType in HostDaemonOnlineRpcCommandType]: (
    command: Extract<HostDaemonOnlineRpcCommand, { type: TType }>,
    options: CommandDispatchOptions,
  ) => Promise<HostDaemonOnlineRpcResult<TType>>;
};

function throwExpectedWorkspacePathNotFoundOrRethrow(error: unknown): never {
  if (error instanceof WorkspaceError && error.code === "path_not_found") {
    throw new ExpectedCommandDispatchError(error.code, error.message);
  }

  throw error;
}

function providerCliEnvFromShellEnv(
  shellEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return shellEnv.PATH ? { ...process.env, PATH: shellEnv.PATH } : process.env;
}

function handleProviderCliInstallEventLine(
  line: string,
  events: ProviderCliInstallEvent[],
  onEvent?: (event: ProviderCliInstallEvent) => void,
): void {
  const trimmedLine = line.trim();

  if (trimmedLine.length === 0) {
    return;
  }

  const event = providerCliInstallEventSchema.parse(JSON.parse(trimmedLine));
  events.push(event);
  onEvent?.(event);
}

function collectProviderCliInstallEventLines(
  buffer: string,
  events: ProviderCliInstallEvent[],
  onEvent?: (event: ProviderCliInstallEvent) => void,
): string {
  const lines = buffer.split(/\r?\n/u);
  const lastLine = lines.pop();

  for (const line of lines) {
    handleProviderCliInstallEventLine(line, events, onEvent);
  }

  return lastLine ?? "";
}

async function readProviderCliInstallEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (event: ProviderCliInstallEvent) => void,
): Promise<ProviderCliInstallEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: ProviderCliInstallEvent[] = [];
  let buffer = "";

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    buffer += decoder.decode(result.value, { stream: true });
    buffer = collectProviderCliInstallEventLines(buffer, events, onEvent);
  }

  buffer += decoder.decode();
  handleProviderCliInstallEventLine(buffer, events, onEvent);

  return events;
}

function failProviderInstallationVerification(args: {
  providerId: string;
  events: ProviderCliInstallEvent[];
  message: string;
}): ProviderCliInstallEvent[] {
  const verifiedEvents = [...args.events];

  const completedIndex = verifiedEvents.findIndex(
    (event) => event.type === "completed" && event.success,
  );

  const completedEvent = verifiedEvents[completedIndex];

  if (completedEvent?.type !== "completed") {
    return args.events;
  }

  verifiedEvents[completedIndex] = { ...completedEvent, success: false };
  verifiedEvents.splice(completedIndex, 0, {
    type: "error",
    provider: args.providerId,
    code: "provider_installation_verification_failed",
    message: args.message,
  });

  return verifiedEvents;
}

function installationVerificationPassed(
  verification: ProviderInstallationVerification,
  status: ProviderInstallationStatus,
): boolean {
  switch (verification.kind) {
    case "installed":
      return status.installed;
    case "version_at_least": {
      const actual =
        status.currentVersion === null
          ? null
          : semver.valid(status.currentVersion);

      const expected = semver.valid(verification.version);

      return (
        actual !== null && expected !== null && semver.gte(actual, expected)
      );
    }

    case "version_changed": {
      const actual = status.currentVersion;

      if (actual === null) return false;
      const parsedActual = semver.valid(actual);
      const parsedPrevious = semver.valid(verification.previousVersion);

      return parsedActual !== null && parsedPrevious !== null
        ? semver.gt(parsedActual, parsedPrevious)
        : actual !== verification.previousVersion;
    }
  }

  return false;
}

async function runProviderInstallationOnHost(
  command: CommandOf<"provider.installation.run">,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<"provider.installation.run">> {
  const admission = requireServerMove(options);

  if (
    !admission.tryAcquireProviderUpdateHold(
      options.runtimeUpdateOwnCommands ?? 0,
    )
  )
    throw new ExpectedCommandDispatchError(
      "runtime_update_busy",
      runtimeUpdateBusyMessage(
        admission,
        options.runtimeUpdateOwnCommands ?? 0,
        null,
        [],
        "provider",
      ),
    );

  try {
    return await executeProviderInstallationOnHost(command, options);
  } finally {
    admission.releaseRuntimeUpdateHold();
  }
}

async function executeProviderInstallationOnHost(
  command:
    | CommandOf<"provider.installation.run">
    | CommandOf<"provider.installation.start">,
  options: CommandDispatchOptions,
  callbacks?: {
    onVerifying: () => void;
    onEvent: (event: ProviderCliInstallEvent) => void;
  },
): Promise<HostDaemonOnlineRpcResult<"provider.installation.run">> {
  try {
    const env = providerCliEnvFromShellEnv(
      options.runtimeManager.getShellEnv(),
    );

    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );

    const maintenanceArgs = {
      providerId: command.providerId,
      bridgeLaunch,
    };

    const run = await options.providerInstallationRun({
      ...maintenanceArgs,
      action: command.action,
    });

    if (!run.available) {
      return {
        events: [
          {
            type: "error",
            provider: command.providerId,
            code: "provider_installation_unavailable",
            message: run.message,
          },
        ],
      };
    }

    const stream =
      options.streamProviderInstallation ?? streamProviderInstallation;

    let events = await readProviderCliInstallEvents(
      stream({
        providerId: command.providerId,
        plan: run.command,
        env,
      }),
      callbacks?.onEvent,
    );

    if (events.some((event) => event.type === "completed" && event.success)) {
      callbacks?.onVerifying();

      try {
        const status =
          await options.providerInstallationStatus(maintenanceArgs);

        if (!installationVerificationPassed(run.verification, status)) {
          events = failProviderInstallationVerification({
            providerId: command.providerId,
            events,
            message: `${command.providerId} ${command.action} exited successfully, but the provider could not verify the installed result.`,
          });
        }
      } catch {
        events = failProviderInstallationVerification({
          providerId: command.providerId,
          events,
          message: `${command.providerId} ${command.action} exited successfully, but its installation status could not be verified.`,
        });
      }
    }

    if (events.some((event) => event.type === "completed" && event.success)) {
      await options.runtimeManager.invalidateProviderMaintenanceRuntime();
    }

    return { events };
  } catch (error) {
    if (error instanceof ProviderInstallationInProgressError) {
      return {
        events: [
          {
            type: "error",
            provider: command.providerId,
            code: "provider_installation_in_progress",
            message: error.message,
          },
        ],
      };
    }

    throw error;
  }
}

interface ProviderInstallationOperationEntry {
  command: CommandOf<"provider.installation.start">;
  operation: ProviderInstallationOperation;
}

const providerInstallationOperations = new WeakMap<
  ServerMoveService,
  Map<string, ProviderInstallationOperationEntry>
>();

const PROVIDER_INSTALLATION_OPERATION_MAX_ENTRIES = 32;

function installationOperationSnapshot(
  operation: ProviderInstallationOperation,
): ProviderInstallationOperation {
  return {
    ...operation,
    events: operation.events
      .filter(
        (event) =>
          event.type !== "completed" ||
          operation.state === "completed" ||
          operation.state === "failed",
      )
      .map((event) => ({ ...event })),
  };
}

async function settleProviderInstallationOperation(args: {
  entry: ProviderInstallationOperationEntry;
  options: CommandDispatchOptions;
  admission: ServerMoveService;
}): Promise<void> {
  const { entry, options, admission } = args;
  const { command, operation } = entry;
  let state: "completed" | "failed" = "failed";

  try {
    const result = await executeProviderInstallationOnHost(command, options, {
      onVerifying: () => {
        operation.state = "verifying";
      },
      onEvent: (event) => {
        operation.events.push(event);
      },
    });

    operation.events = result.events;
    state = result.events.some(
      (event) => event.type === "completed" && event.success,
    )
      ? "completed"
      : "failed";
  } catch (error) {
    operation.events = operation.events.map((event) =>
      event.type === "completed" ? { ...event, success: false } : event,
    );
    operation.events.push({
      type: "error",
      provider: command.providerId,
      code: getErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      admission.releaseRuntimeUpdateHold(command.operationId);
    } catch (error) {
      state = "failed";
      operation.events = operation.events.map((event) =>
        event.type === "completed" ? { ...event, success: false } : event,
      );
      operation.events.push({
        type: "error",
        provider: command.providerId,
        code: getErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
      options.logger.warn(
        { err: error, operationId: command.operationId },
        "Provider installation admission could not be released",
      );
    }

    operation.state = state;
  }
}

async function startProviderInstallationOnHost(
  command: CommandOf<"provider.installation.start">,
  options: CommandDispatchOptions,
): Promise<ProviderInstallationOperation> {
  const admission = requireServerMove(options);
  let operations = providerInstallationOperations.get(admission);

  if (operations === undefined) {
    operations = new Map();
    providerInstallationOperations.set(admission, operations);
  }

  const previous = operations.get(command.operationId);

  if (previous !== undefined) {
    if (!isDeepStrictEqual(previous.command, command))
      throw new ExpectedCommandDispatchError(
        "provider_installation_operation_conflict",
        "Installation operation already exists with different inputs",
      );

    return installationOperationSnapshot(previous.operation);
  }

  if (
    admission.runtimeUpdateStatus().held ||
    !admission.tryAcquireProviderUpdateHold(
      options.runtimeUpdateOwnCommands ?? 0,
      command.operationId,
    )
  )
    throw new ExpectedCommandDispatchError(
      "runtime_update_busy",
      runtimeUpdateBusyMessage(
        admission,
        options.runtimeUpdateOwnCommands ?? 0,
        command.operationId,
        [],
        "provider",
      ),
    );

  for (const [operationId, entry] of operations) {
    if (operations.size < PROVIDER_INSTALLATION_OPERATION_MAX_ENTRIES) break;

    if (
      entry.operation.state === "completed" ||
      entry.operation.state === "failed"
    ) {
      operations.delete(operationId);
    }
  }

  const entry: ProviderInstallationOperationEntry = {
    command,
    operation: {
      operationId: command.operationId,
      providerId: command.providerId,
      action: command.action,
      state: "installing",
      events: [],
    },
  };

  operations.set(command.operationId, entry);
  void settleProviderInstallationOperation({ entry, options, admission });

  return installationOperationSnapshot(entry.operation);
}

async function withRetainedThreadEnvironment<TResult>(
  command: CommandOf<
    | "thread.rewind.discard"
    | "thread.rewind.prepare"
    | "thread.start"
    | "turn.submit"
  >,
  options: CommandDispatchOptions,
  work: () => Promise<TResult>,
): Promise<TResult> {
  const release =
    await options.runtimeManager.retainEnvironmentForThreadCommand(
      command.environmentId,
      command.threadId,
    );

  try {
    return await work();
  } finally {
    release();
  }
}

function requireServerMove(options: CommandDispatchOptions): ServerMoveService {
  if (!options.serverMove) {
    throw new Error("Server move is unavailable on this daemon");
  }

  return options.serverMove;
}

function runtimeUpdateBusyMessage(
  admission: ServerMoveService,
  ownCommands: number,
  ownerId: string | null,
  pluginIds: string[],
  scope: WorkerUpdateScope = "runtime",
): string {
  const status = admission.runtimeUpdateStatus(scope);

  const blockers = [
    ...(status.held && status.holdOwner !== ownerId
      ? ["another update holds admission"]
      : []),
    ...(status.directProbe ? ["direct probe"] : []),
    ...(status.activation ? ["server activation"] : []),
    ...(status.activity === null
      ? ["activity unknown"]
      : Object.entries(status.activity).flatMap(([kind, count]) => {
          if (!Number.isSafeInteger(count) || count < 0)
            return [`${kind} invalid`];

          if (
            scope === "provider" &&
            (kind === "terminals" || kind === "pluginHosts")
          )
            return [];
          const busy = kind === "commands" ? count - ownCommands : count;

          if (busy <= 0) return [];

          return kind === "pluginHosts" && pluginIds.length > 0
            ? [`${kind} ${String(busy)} (${pluginIds.join(", ")})`]
            : [`${kind} ${String(busy)}`];
        })),
  ];

  return blockers.length === 0
    ? `Worker activity prevents a ${scope} update`
    : `Worker activity prevents a ${scope} update: ${blockers.join(", ")}`;
}

async function forwardDesktopBrowserCommand<
  TCommand extends DesktopBrowserBrokerCommand,
>(
  command: TCommand,
  options: CommandDispatchOptions,
): Promise<DesktopBrowserBrokerResult<TCommand["type"]>> {
  if (!options.desktopBrowserBroker)
    throw new Error("Desktop browser broker unavailable");

  return options.desktopBrowserBroker.request(command);
}

async function withResolvedBridgeLaunch<TResult>(
  command: CommandOf<"provider.list_models" | "provider.health">,
  options: CommandDispatchOptions,
  call: (args: {
    providerId: string;
    bridgeLaunch: AgentRuntimeBridgeLaunch;
    cwd?: string;
  }) => Promise<TResult>,
): Promise<TResult> {
  const bridgeLaunch = await resolveRuntimeBridgeLaunch(
    command.bridgeLaunch,
    options,
  );

  return call({
    providerId: command.providerId,
    ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
    bridgeLaunch,
  });
}

function readIsolatedHostCommand<TCommand extends ReadonlyFilesystemCommand>(
  command: TCommand,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>> {
  return readIsolatedFilesystemCommand(
    command,
    userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
  );
}

async function mutateIsolatedHostCommand<
  TCommand extends Exclude<
    FilesystemMutationCommand,
    { type: "skill.replace_directory" }
  >,
>(
  command: TCommand,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>> {
  if (options.filesystemMutator === undefined)
    throw new Error("Filesystem mutator is unavailable");

  try {
    return await options.filesystemMutator.execute(
      command,
      userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
    );
  } finally {
    if (!READONLY_FILESYSTEM_MUTATION_TYPES.has(command.type))
      options.workspaceReads.invalidateAll();
  }
}

function readWorkspaceCommand<
  TCommand extends CommandOf<
    | "workspace.status"
    | "workspace.diff"
    | "workspace.diffFiles"
    | "workspace.diffPatch"
    | "workspace.gitActivity"
  >,
>(
  command: TCommand,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>> {
  if (
    command.type === "workspace.diffPatch" ||
    command.type === "workspace.gitActivity"
  ) {
    return readIsolatedHostCommand(command, options);
  }

  const processOptions = userExecutableProcessOptions(
    options.runtimeManager.getShellEnv(),
  );

  const { environmentId, workspaceContext, ...request } = command;

  return options.workspaceReads.read({
    environmentId,
    workspacePath: workspaceContext.workspacePath,
    key: workspaceReadKey({ request, processOptions }),
    load: () => readIsolatedFilesystemCommand(command, processOptions),
    parse: (value) => parseHostDaemonOnlineRpcResultForCommand(command, value),
  });
}

async function readAvailableWorkspace<
  TCommand extends CommandOf<
    | "workspace.status"
    | "workspace.diff"
    | "workspace.diffFiles"
    | "workspace.diffPatch"
    | "workspace.gitActivity"
  >,
>(
  command: TCommand,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>> {
  const resolution = await resolveWorkspaceForCommand({
    environmentId: command.environmentId,
    requireGit: true,
    runtimeManager: options.runtimeManager,
    workspaceContext: command.workspaceContext,
  });

  if (!resolution.ok) {
    return parseHostDaemonOnlineRpcResultForCommand(command, {
      outcome: "unavailable",
      failure: resolution.failure,
    });
  }

  try {
    return await readWorkspaceCommand(command, options);
  } catch (error) {
    return parseHostDaemonOnlineRpcResultForCommand(command, {
      outcome: "unavailable",
      failure: workspaceResolutionFailureFromError({
        error,
        workspacePath: command.workspaceContext.workspacePath,
      }),
    });
  }
}

const commandHandlers: CommandHandlerMap = {
  "thread.rewind.discard": (command, options) =>
    withRetainedThreadEnvironment(command, options, () =>
      discardThreadRewind(command, options),
    ),
  "thread.rewind.prepare": (command, options) =>
    withRetainedThreadEnvironment(command, options, async () =>
      prepareThreadRewind(
        {
          ...command,
          contributedEnv: await withClaudeProfileEnvironment({
            context: command,
            options,
          }),
        },
        options,
      ),
    ),
  "thread.start": (command, options) =>
    withRetainedThreadEnvironment(command, options, async () =>
      startThread(
        {
          ...command,
          contributedEnv: await withClaudeProfileEnvironment({
            context: command,
            options,
          }),
        },
        options,
      ),
    ),
  "turn.submit": (command, options) =>
    withRetainedThreadEnvironment(command, options, async () => {
      const resolved = {
        ...command,
        resumeContext: {
          ...command.resumeContext,
          contributedEnv: await withClaudeProfileEnvironment({
            context: command.resumeContext,
            options,
          }),
        },
      };

      const entry = await ensureThreadRuntime(resolved, options);

      return submitTurn(resolved, entry, options);
    }),
  "thread.stop": stopThreadRuntime,
  "thread.storage.delete": async (command, options) => {
    const result = await stopThreadRuntime(command, options);
    await deleteThreadStorage(command, options);

    return result;
  },
  "thread.speed.set": async (command, options) => {
    const owners = options.runtimeManager.listThreadOwnerEntries(
      command.threadId,
    );

    const entry = owners[0];

    if (!entry || owners.length !== 1)
      throw new ExpectedCommandDispatchError(
        "unknown_thread_runtime",
        "No unique live session is available for this speed change",
      );
    await entry.runtime.setThreadSpeed({
      threadId: command.threadId,
      serviceTier: command.serviceTier,
    });

    return { ok: true };
  },
  "thread.goal.clear": async (command, options) => {
    const entry = await ensureThreadRuntime(
      {
        ...command,
        resumeContext: {
          ...command.resumeContext,
          contributedEnv: await withClaudeProfileEnvironment({
            context: command.resumeContext,
            options,
          }),
        },
      },
      options,
    );

    const result = await entry.runtime.clearThreadGoal({
      threadId: command.threadId,
    });

    await options.eventSink.flush();

    return result;
  },
  "thread.plan.cancel": async (command, options) => {
    const owners = options.runtimeManager.listThreadOwnerEntries(
      command.threadId,
    );

    if (owners.length === 0) {
      throw new ExpectedCommandDispatchError(
        "unknown_thread_runtime",
        `No provider runtime available for thread ${command.threadId}`,
      );
    }

    const owner = owners.find(
      (entry) =>
        entry.runtime.getActiveTurnId(command.threadId) ===
        command.expectedTurnId,
    );

    if (!owner) {
      return { cancelled: false };
    }

    await owner.runtime.stopThread({ threadId: command.threadId });
    await options.eventSink.flush();

    return { cancelled: true };
  },
  "thread.rename": async (command, options) => {
    const entry = await options.runtimeManager.getOrAwait(
      command.environmentId,
    );

    if (!entry) {
      return {};
    }

    await entry.runtime.renameThread({
      threadId: command.threadId,
      title: command.title,
    });

    return {};
  },
  "thread.archive": async (command, options) => {
    const entry = await requireResolvedWorkspaceForCommand({
      environmentId: command.environmentId,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });

    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );

    await entry.runtime.archiveThread({
      threadId: command.threadId,
      providerId: command.providerId,
      providerThreadId: command.providerThreadId,
      bridgeLaunch,
    });

    return {};
  },
  "thread.unarchive": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );

    await options.runtimeManager.withProviderMaintenanceRuntime(
      { dataDir: options.dataDir },
      (runtime) =>
        runtime.unarchiveThread({
          threadId: command.threadId,
          providerId: command.providerId,
          providerThreadId: command.providerThreadId,
          bridgeLaunch,
        }),
    );

    return {};
  },
  "interactive.resolve": resolveInteractiveRequest,
  "environment.attach": provisionEnvironment,
  "project.clone": (command, options) =>
    cloneProject({
      dataDir: options.dataDir,
      projectSlug: command.projectSlug,
      env: operationEnvironment(
        command.contributedEnv,
        {
          ...process.env,
          ...options.runtimeManager.getShellEnv(),
        },
        true,
      ),
      remoteUrl: command.remoteUrl,
      onProgress: (text) =>
        options.emitEnvironmentHookProgress?.({
          type: "environment.hook.progress",
          operationId: command.operationId,
          entry: { type: "output", text, status: null },
        }),
      ...userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
      ...(command.targetPath !== undefined
        ? { targetPath: command.targetPath }
        : {}),
    }),
  "environment.attach.cancel": cancelEnvironmentProvision,
  "workspace.commit": async (command, options) => {
    const entry = await requireResolvedWorkspaceForCommand({
      environmentId: command.environmentId,
      requireGit: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });

    return entry.workspace.commit({
      message: command.message,
      noVerify: true,
    });
  },
  "workspace.pull_request_action": async (command, options) => {
    const entry = await requireResolvedWorkspaceForCommand({
      environmentId: command.environmentId,
      requireGit: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });

    await entry.workspace.runPullRequestAction(
      command.operation === "merge"
        ? { operation: "merge", method: command.method }
        : { operation: command.operation },
      userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
    );

    return {};
  },
};

const onlineRpcHandlers: OnlineRpcHandlerMap = {
  "terminal.foreground": async (command, options) => {
    if (options.terminals === undefined) {
      throw new ExpectedCommandDispatchError(
        "terminal_not_found",
        "Terminals are unavailable on this computer",
      );
    }

    return options.terminals.foreground(command.terminalId);
  },
  "host.preview.status": async (command, options) => {
    if (options.managedPreviews === undefined) {
      throw new ExpectedCommandDispatchError(
        "preview_unavailable",
        "Managed previews are unavailable",
      );
    }

    return options.managedPreviews.status(command.preview);
  },
  "host.preview.ensure": async (command, options) => {
    if (options.managedPreviews === undefined) {
      throw new ExpectedCommandDispatchError(
        "preview_unavailable",
        "Managed previews are unavailable",
      );
    }

    await requireResolvedWorkspaceForCommand({
      environmentId: command.preview.environmentId,
      workspaceContext: command.workspaceContext,
      runtimeManager: options.runtimeManager,
    });

    return options.managedPreviews.ensure(
      command.preview,
      command.contributedEnv,
    );
  },
  "preview.http": async (command, options) => {
    if (options.previewTransport === undefined)
      throw new Error("Preview transport is unavailable");

    return options.previewTransport.http(command);
  },
  "preview.socket.open": async (command, options) => {
    if (options.previewTransport === undefined)
      throw new Error("Preview transport is unavailable");

    return options.previewTransport.open(command);
  },
  "preview.socket.read": async (command, options) => {
    if (options.previewTransport === undefined)
      throw new Error("Preview transport is unavailable");

    return options.previewTransport.read(command);
  },
  "preview.socket.write": async (command, options) => {
    if (options.previewTransport === undefined)
      throw new Error("Preview transport is unavailable");

    return options.previewTransport.write(command);
  },
  "preview.socket.close": async (command, options) => {
    if (options.previewTransport === undefined)
      throw new Error("Preview transport is unavailable");

    return options.previewTransport.close(command);
  },
  "runtime_update.acquire": async (command, options) => {
    const admission = requireServerMove(options);
    const ownCommands = options.runtimeUpdateOwnCommands ?? 0;

    if (command.closePluginLeases.length > 0)
      await options.closeRuntimeUpdatePluginLeases?.(command.closePluginLeases);

    if (!admission.tryAcquireRuntimeUpdateHold(ownCommands, command.ownerId))
      throw new ExpectedCommandDispatchError(
        "runtime_update_busy",
        runtimeUpdateBusyMessage(
          admission,
          ownCommands,
          command.ownerId,
          options.runtimeUpdatePluginBlockers?.() ?? [],
        ),
      );

    return { held: true };
  },
  "runtime_update.release": async (command, options) => {
    requireServerMove(options).releaseRuntimeUpdateHold(command.ownerId);

    return { released: true };
  },
  "environment.hook.run": runEnvironmentHook,
  "environment.hook.cancel": cancelEnvironmentHook,
  "desktop.browser.list_instances": forwardDesktopBrowserCommand,
  "desktop.browser.profile_renderer": forwardDesktopBrowserCommand,
  "desktop.browser.list_tabs": forwardDesktopBrowserCommand,
  "desktop.browser.create_tab": forwardDesktopBrowserCommand,
  "desktop.browser.reveal_tab": forwardDesktopBrowserCommand,
  "desktop.browser.close_tab": forwardDesktopBrowserCommand,
  "desktop.browser.capture_tab": forwardDesktopBrowserCommand,
  "desktop.browser.acquire_control": forwardDesktopBrowserCommand,
  "desktop.browser.open_connection": forwardDesktopBrowserCommand,
  "desktop.browser.release_control": forwardDesktopBrowserCommand,
  "desktop.browser.list_import_sources": forwardDesktopBrowserCommand,
  "desktop.browser.import_cookies": forwardDesktopBrowserCommand,
  "desktop.browser.cookie_sync_status": forwardDesktopBrowserCommand,
  "desktop.browser.cookie_sync_configure": forwardDesktopBrowserCommand,
  "desktop.browser.cookie_sync_run": forwardDesktopBrowserCommand,
  "connect-tunnel.ensure-identity": async (_command, options) => {
    if (!options.ensureConnectTunnelIdentity) {
      throw new Error("Omnyo connect tunnel identity is unavailable");
    }

    return options.ensureConnectTunnelIdentity();
  },
  "host.list_files": readIsolatedHostCommand,
  "host.list_paths": readIsolatedHostCommand,
  "host.mkdir": mutateIsolatedHostCommand,
  "host.move_path": mutateIsolatedHostCommand,
  "host.remove_path": mutateIsolatedHostCommand,
  "host.browse_directory": readIsolatedHostCommand,
  "host.paths_exist": readIsolatedHostCommand,
  "host.rtk_status": async (_command, options) => ({
    installed:
      resolveExecutable("rtk", {
        cwd: process.cwd(),
        env: options.runtimeManager.getShellEnv(),
      }) !== undefined,
  }),
  "host.detect_provider_clis": async (command, options) => {
    const env = options.runtimeManager.getShellEnv();

    const candidates = new Map<
      string,
      { id: string; displayName: string; command: string; cwd: string }
    >(
      onboardingProviderExecutables.map((candidate) => [
        candidate.id,
        {
          ...candidate,
          command:
            candidate.id === "claude-code"
              ? env.OMNYO_CLAUDE_CODE_EXECUTABLE?.trim() || candidate.command
              : candidate.command,
          cwd: process.cwd(),
        },
      ]),
    );

    for (const candidate of command.customAgents) {
      candidates.set(candidate.id, {
        ...candidate,
        cwd: candidate.cwd ?? process.cwd(),
      });
    }

    return {
      providers: [...candidates.values()].map(
        ({ id, displayName, command, cwd }) => ({
          id,
          displayName,
          installed:
            resolveExecutable(command, { cwd, env }) !== undefined ||
            (id === "claude-code" &&
              command === "claude" &&
              process.platform === "win32" &&
              resolveExecutable(
                join(homedir(), ".local", "bin", "claude.exe"),
                { cwd, env },
              ) !== undefined),
        }),
      ),
    };
  },
  "host.agent_processes.terminate": async (_command, options) => {
    const containment = options.agentProcessContainment;

    if (containment === undefined) {
      return { contained: false, terminatedProcessCount: 0 };
    }

    return {
      contained: true,
      terminatedProcessCount: await containment.terminate(),
    };
  },
  "host.prepare_workspace_identity_v1": (command, options) =>
    prepareWorkspaceIdentityV1({
      rootPath: command.rootPath,
      dataDir: options.dataDir,
      admission: options.runtimeManager,
    }),
  "project.inspect": readIsolatedHostCommand,
  "project.clone_default_path": async (command, options) => ({
    path: resolveProjectCloneDefaultPath(options.dataDir, command.projectSlug),
  }),
  "host.pick_folder": pickHostFolder,
  "plugin.host.call": async () => {
    throw new Error("plugin.host.call must be routed by CommandRouter");
  },
  "plugin.host.cancel": async () => {
    throw new Error("plugin.host.cancel must be routed by CommandRouter");
  },
  "plugin.host.dispose": async () => {
    throw new Error("plugin.host.dispose must be routed by CommandRouter");
  },
  "host.list_commands": readIsolatedHostCommand,
  "host.list_command_metadata": (command, options) => {
    if (!options.commandMetadata)
      throw new Error("Command metadata catalog is unavailable");

    return options.commandMetadata.list(command);
  },
  "host.list_skills": readIsolatedHostCommand,
  "host.read_workspace_agent_context": readIsolatedWorkspaceAgentContext,
  "host.delete_skill": mutateIsolatedHostCommand,
  "host.write_skill": mutateIsolatedHostCommand,
  "host.install_global_skills": (command, options) => {
    const mutator = options.filesystemMutator;

    if (mutator === undefined)
      throw new Error("Filesystem mutator is unavailable");

    return installGlobalSkills(command, {
      ...options,
      replaceDirectory: (args) => mutator.replaceDirectory(args),
    });
  },
  "host.housekeeping.status": async (_command, options) =>
    options.runtimeManager.getHousekeepingStatus(),
  "host.global_skills_status": readIsolatedHostCommand,
  "host.inspect_git_source": mutateIsolatedHostCommand,
  "host.list_branch_options": mutateIsolatedHostCommand,
  "host.read_file": readIsolatedHostCommand,
  "host.read_file_chunk": readIsolatedHostCommand,
  "host.read_file_relative": readIsolatedHostCommand,
  "host.write_file": mutateIsolatedHostCommand,
  "claude-profile/manage": (command, options) =>
    manageClaudeProfiles(command.request, options),
  "provider.list_models": (command, options) =>
    withResolvedBridgeLaunch(command, options, async (args) =>
      options.listModels({
        ...args,
        contributedEnv: await withClaudeProfileEnvironment({
          options,
          context: {
            ...command,
            ...(command.cwd === undefined
              ? {}
              : { workspaceContext: { workspacePath: command.cwd } }),
          },
        }),
      }),
    ),
  "provider.health": (command, options) =>
    withResolvedBridgeLaunch(command, options, (args) =>
      options.providerHealth(args),
    ),
  "provider.usage": async (command, options) => {
    const [bridgeLaunch, contributedEnv] = await Promise.all([
      resolveRuntimeBridgeLaunch(command.bridgeLaunch, options),
      withClaudeProfileEnvironment({
        options,
        context: { ...command, contributedEnv: [] },
      }),
    ]);

    return options.providerUsage({
      providerId: command.providerId,
      bridgeLaunch,
      ...(contributedEnv.length === 0 ? {} : { contributedEnv }),
    });
  },
  "host.discover_repos": readIsolatedHostCommand,
  "provider.installation.status": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );

    return options.providerInstallationStatus({
      providerId: command.providerId,
      bridgeLaunch,
    });
  },
  "provider.installation.run": runProviderInstallationOnHost,
  "provider.installation.start": startProviderInstallationOnHost,
  "provider.installation.get": async (command, options) => {
    const admission = requireServerMove(options);

    const entry = providerInstallationOperations
      .get(admission)
      ?.get(command.operationId);

    const { held, holdOwner } = admission.runtimeUpdateStatus();

    return {
      operation:
        entry === undefined
          ? null
          : installationOperationSnapshot(entry.operation),
      held,
      holdOwner,
    };
  },
  "workspace.status": readAvailableWorkspace,
  "workspace.diff": readAvailableWorkspace,
  "workspace.diffFiles": readAvailableWorkspace,
  "workspace.diffPatch": readAvailableWorkspace,
  "workspace.gitActivity": readAvailableWorkspace,
  "workspace.pull_request": async (command, options) => {
    const resolution = await resolveWorkspaceForCommand({
      environmentId: command.environmentId,
      requireGit: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });

    if (!resolution.ok) {
      return resolution.failure.code === "not_git_repo"
        ? { outcome: "absent" }
        : { outcome: "unavailable", message: resolution.failure.message };
    }

    const lookup = await resolution.entry.workspace.getPullRequest(
      userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
    );

    switch (lookup.outcome) {
      case "found":
        return { outcome: "available", pullRequest: lookup.pullRequest };
      case "none":
        return { outcome: "absent" };
      case "unavailable":
        return { outcome: "unavailable", message: lookup.message };
    }
  },
  "server_access.inspect_direct_probe": (_command, options) =>
    requireServerMove(options).inspectDirectProbe(),
  "server_access.probe_direct": (command, options) =>
    requireServerMove(options).probeDirect(command),
  "server_access.prove_current_primary": (command, options) =>
    requireServerMove(options).proveCurrentPrimary(command),
  "server_access.release_direct_probe": (command, options) =>
    requireServerMove(options).releaseDirectProbe(command),
  "server_move.inspect": (command, options) =>
    requireServerMove(options).inspect(command),
  "server_move.probe": (command, options) =>
    requireServerMove(options).probe(command),
  "server_move.prepare": (command, options) =>
    requireServerMove(options).prepare(command),
  "server_move.activate": (command, options) =>
    requireServerMove(options).activate(command),
  "server_move.abort": (command, options) =>
    requireServerMove(options).abort(command),
  "server_move.delete_old_copy": (_command, options) =>
    requireServerMove(options).deleteOldCopy(),
};

export async function dispatchCommand<
  TType extends HostDaemonSettledCommandType,
>(
  command: Extract<HostDaemonCommand, { type: TType }>,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<TType>> {
  try {
    return await withVcsProcessPriority("interactive", () =>
      commandHandlers[command.type](command, options),
    );
  } catch (error) {
    throwExpectedWorkspacePathNotFoundOrRethrow(error);
  } finally {
    invalidateWorkspaceReadsAfterCommand(command, options);
  }
}

function invalidateWorkspaceReadsAfterCommand(
  command: Extract<HostDaemonCommand, { type: HostDaemonSettledCommandType }>,
  options: CommandDispatchOptions,
): void {
  if (command.type === "project.clone") return;
  options.workspaceReads.invalidateEnvironment(command.environmentId);
}

export async function dispatchOnlineRpcCommand<
  TType extends HostDaemonOnlineRpcCommandType,
>(
  command: Extract<HostDaemonOnlineRpcCommand, { type: TType }>,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<TType>> {
  try {
    return await withVcsProcessPriority(
      command.type === "workspace.pull_request"
        ? "background"
        : command.type === "workspace.status"
          ? "status"
          : "interactive",
      () => onlineRpcHandlers[command.type](command, options),
    );
  } catch (error) {
    throwExpectedWorkspacePathNotFoundOrRethrow(error);
  }
}
