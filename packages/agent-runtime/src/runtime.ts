import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  normalizeProviderThreadNameEvent,
  toProviderExternalThreadName,
} from "@omnyo/domain";
import type {
  RetainedProviderSession,
  RetainedProviderSessionReason,
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  ThreadEvent,
} from "@omnyo/domain";
import type { AdapterCommand } from "./provider-adapter.js";
import {
  BRIDGE_JSON_RPC_ERRORS,
  providerHealthResultSchema,
  providerInstallationRunResultSchema,
  providerInstallationStatusSchema,
  providerUsageResultSchema,
  ThreadEventGrammar,
  threadIdentityResultSchema,
} from "@omnyo/provider-bridge-protocol";
import {
  JsonRpcRequestTimeoutError,
  JsonRpcResponseError,
  PROVIDER_TOOL_CALL_CANCELLED_METHOD,
  providerToolCallCancellationSchema,
  getJsonRpcStringParam,
  ignoredJsonRpcResultSchema,
  parseJsonRpcLine,
  sendJsonRpcError,
  sendJsonRpcRequest,
  settleJsonRpcResponse,
} from "@omnyo/provider-bridge-protocol/bridge-kit";
import type {
  JsonRpcObject,
  ProviderCommandPlan,
  ProviderRequestCommandPlan,
  SendJsonRpcRequestArgs,
} from "@omnyo/provider-bridge-protocol/bridge-kit";
import {
  assertProviderSupportsExecutionOptions,
  toProviderExecutionContext,
} from "./execution-options.js";
import {
  handleRuntimeProviderRequest,
  RuntimeToolCalls,
  type ResolveRuntimeProviderRequestThreadIdArgs,
  type RuntimeProviderRequestKind,
} from "./runtime-provider-requests.js";
import {
  RuntimeProviderProcessManager,
  hasChildProcessExited,
  type RuntimeProviderProcess,
  type RuntimeProviderThreadDetachment,
} from "./runtime-provider-process.js";
import {
  RuntimeThreadIdentityRegistry,
  stampThreadEventScope,
} from "./runtime-thread-identity.js";
import { RuntimeThreadGoalState } from "./runtime-thread-goal-state.js";
import {
  RuntimeBackgroundWorkState,
  type RuntimeStoppedBackgroundTaskEvent,
} from "./runtime-background-work-state.js";
import { RuntimeTurnState } from "./runtime-turn-state.js";
import type {
  AgentRuntimeContributedEnvEntry,
  AgentRuntime,
  AgentRuntimeProviderRecoveryHint,
  AgentRuntimeBridgeLaunch,
  AgentRuntimeExecutionOptions,
  AgentRuntimeOptions,
  AgentRuntimeSkillRoot,
  ReapedIdleProviderSession,
  RunTurnResult,
} from "./types.js";
import {
  resolveThreadEnvironment,
  type DroppedThreadEnvironmentContribution,
  type ResolvedThreadEnvironmentEntry,
} from "./thread-shell-environment.js";
import { bridgeLaunchProcessKey } from "./bridge-launch-process-key.js";

interface RecordThreadExecutionOptionsArgs {
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

interface RestartThreadBridgeArgs {
  instructions: string | undefined;
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

interface RunThreadOperationArgs<TResult> {
  threadId: string;
  work: () => Promise<TResult>;
}

interface PreparedThreadRewind {
  state: "prepared";
  cleanupPromise: Promise<void> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  retainHistoryForForks: boolean;
  processKey: string;
  providerId: string;
  providerState: RuntimeProviderProcess["identity"];
  providerThreadId: string;
  stagingThreadId: string;
  threadId: string;
}

interface PreparingThreadRewind {
  state: "preparing";
  promise: Promise<{ providerThreadId: string }>;
}

type StagedThreadRewind = PreparingThreadRewind | PreparedThreadRewind;

interface ReapIdleProviderSessionCandidate {
  processId: number | null;
  idleSinceMs: number;
  providerThreadId: string;
  threadId: string;
  runtimeConfig: ThreadRuntimeConfig;
}

interface FindReapableIdleProviderSessionArgs {
  idleForMs: number;
  nowMs: number;
  threadId: string;
}

interface ResolveProviderProcessKeyArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  skillRoots?: readonly AgentRuntimeSkillRoot[];
  providerId: string;
}

interface ArchiveOrUnarchiveThreadArgs {
  bridgeLaunch?: AgentRuntimeBridgeLaunch;
  commandType: "thread/archive" | "thread/unarchive";
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

interface RequestRecoveryArgs {
  bridgeLaunch?: AgentRuntimeBridgeLaunch;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

const ARCHIVED_FORK_SOURCE_MESSAGE =
  "The original chat is archived in its agent. Unarchive it there, then send your message again.";

export class CompetingTurnError extends Error {
  constructor(threadId: string) {
    super(
      `Refusing to start a competing turn for thread "${threadId}" while another turn is active or starting`,
    );
    this.name = "CompetingTurnError";
  }
}

export class AgentRuntimeRecoveryError extends Error {
  readonly code: "auth_required" | "rate_limited";
  readonly recovery: AgentRuntimeProviderRecoveryHint;

  constructor(args: {
    code: "auth_required" | "rate_limited";
    message: string;
    recovery: AgentRuntimeProviderRecoveryHint;
    cause: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "AgentRuntimeRecoveryError";
    this.code = args.code;
    this.recovery = args.recovery;
  }
}

interface ResolveProviderRequestThreadIdArgs extends ResolveRuntimeProviderRequestThreadIdArgs {
  proc: ProviderProcess;
}

interface ResolveThreadStoragePathArgs {
  options: AgentRuntimeOptions;
  threadId: string;
}

const providerThreadStopResultSchema = z
  .object({
    providerCheckpointId: z.string().min(1).nullable().optional(),
  })
  .passthrough();

function resolveModelListEnvVars(
  entries: readonly AgentRuntimeContributedEnvEntry[],
  serverUrl: string | undefined,
): Record<string, string> | null {
  if (entries.length === 0) return null;

  const envVars: Record<string, string> = {};

  for (const entry of entries) {
    if (typeof entry.value === "string") {
      envVars[entry.name] = entry.value;
      continue;
    }

    if (serverUrl === undefined) {
      throw new Error(
        `Model list environment ${entry.name} needs OMNYO_SERVER_URL on this machine`,
      );
    }

    envVars[entry.name] = `${serverUrl}${entry.value.serverPath}`;
  }

  return envVars;
}

function defaultBridgeNodeEnv(): Record<string, string> | undefined {
  if (process.versions.electron === undefined) {
    return undefined;
  }

  return { ELECTRON_RUN_AS_NODE: "1" };
}

type ProviderProcess = RuntimeProviderProcess;

type ThreadRuntimeStateRelease =
  | "session-construction-abandoned"
  | "staged-rewind-released"
  | "thread-archived"
  | "thread-stopped";

function providerDetachmentSettlesBackgroundTasks(
  reason: RuntimeProviderThreadDetachment["reason"],
): boolean {
  switch (reason) {
    case "provider-exited":
      return true;
    case "runtime-shutdown":
      return false;
  }
}

function threadReleaseSettlesBackgroundTasks(
  release: ThreadRuntimeStateRelease,
): boolean {
  switch (release) {
    case "session-construction-abandoned":
    case "thread-stopped":
      return true;
    case "staged-rewind-released":
    case "thread-archived":
      return false;
  }
}

const threadGoalClearResultSchema = z.object({ cleared: z.boolean() }).strict();

const THREAD_GOAL_CLEAR_EVENT_TIMEOUT_MS = 5_000;

const PREPARED_THREAD_REWIND_TTL_MS = 5 * 60_000;

const PREPARED_THREAD_REWIND_RETRY_MS = 30_000;

interface ThreadRuntimeConfig {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  skillRoots: readonly AgentRuntimeSkillRoot[];
  contributedEnv: readonly AgentRuntimeContributedEnvEntry[];
  dynamicTools?: DynamicTool[];
  environmentId: string;
  instructionMode: InstructionMode;
  instructions?: string;
  envVars: Record<string, string>;
  options: AgentRuntimeExecutionOptions;
  processKey: string;
  projectId?: string;
  providerId: string;
  sessionRestorable: boolean;
}

interface RuntimeParsedMessageArgs {
  parsed: JsonRpcObject;
  proc: ProviderProcess;
}

interface EmitTranslatedEventsArgs {
  events: ThreadEvent[];
  proc: ProviderProcess;
  sourceThreadId?: string;
}

interface RequireProviderRequestPlanArgs {
  commandType: AdapterCommand["type"];
  plan: ProviderCommandPlan;
  providerId: string;
}

const DEFAULT_THREAD_CREATION_REQUEST_TIMEOUT_MS = 2 * 60_000;

const FAILED_CONSTRUCTION_RELEASE_TIMEOUT_MS = 5_000;

function resolveThreadStoragePath(
  args: ResolveThreadStoragePathArgs,
): string | undefined {
  const rootPath = args.options.threadStorageRootPath;

  if (!rootPath) {
    return undefined;
  }

  return path.join(rootPath, args.threadId);
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const additionalWorkspaceWriteRoots =
    options.additionalWorkspaceWriteRoots ?? [];

  const skillRoots = options.skillRoots ?? [];

  for (const skillRoot of skillRoots) {
    if (!path.isAbsolute(skillRoot.path)) {
      throw new Error(
        `Agent runtime skill root "${skillRoot.id}" must use an absolute path: ${skillRoot.path}`,
      );
    }
  }

  let nextRequestId = 1;
  const threadIdentityRegistry = new RuntimeThreadIdentityRegistry();
  const threadRuntimeConfigs = new Map<string, ThreadRuntimeConfig>();

  const threadCreationRequestTimeoutMs =
    options.threadCreation?.requestTimeoutMs ??
    DEFAULT_THREAD_CREATION_REQUEST_TIMEOUT_MS;

  const threadsAwaitingBridgeRestart = new Map<
    string,
    AgentRuntimeProviderRecoveryHint
  >();

  const threadsRetryingBridgeRestartOnIdle = new Set<string>();
  const idleProviderSessionSinceMsByThreadId = new Map<string, number>();

  const pendingTurnStarts = new Map<
    string,
    {
      clientRequestId: ClientTurnRequestId;
      sinceMs: number;
      watchdogFired: boolean;
    }
  >();

  const turnStartWatchdogThresholdMs =
    options.turnStartWatchdog?.thresholdMs ?? 120_000;

  let turnStartWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let turnStartWatchdogStopped = false;

  function refreshTurnStartWatchdog(): void {
    const pending =
      !turnStartWatchdogStopped &&
      [...pendingTurnStarts.values()].some((entry) => !entry.watchdogFired);

    if (pending && turnStartWatchdogTimer === null) {
      turnStartWatchdogTimer = setInterval(
        checkPendingTurnStarts,
        options.turnStartWatchdog?.intervalMs ?? 15_000,
      );
      turnStartWatchdogTimer.unref?.();
    } else if (!pending && turnStartWatchdogTimer !== null) {
      clearInterval(turnStartWatchdogTimer);
      turnStartWatchdogTimer = null;
    }
  }

  function clearPendingTurnStart(threadId: string): void {
    if (pendingTurnStarts.delete(threadId)) refreshTurnStartWatchdog();
  }

  function checkPendingTurnStarts(): void {
    const nowMs = Date.now();

    for (const [threadId, entry] of pendingTurnStarts) {
      if (
        entry.watchdogFired ||
        nowMs - entry.sinceMs < turnStartWatchdogThresholdMs
      ) {
        continue;
      }

      entry.watchdogFired = true;
      options.onEvent({
        type: "system/error",
        threadId,
        scope: { kind: "thread" },
        code: "provider_turn_start_timeout",
        message: `The provider accepted a turn but did not start it within ${Math.round(turnStartWatchdogThresholdMs / 1000)}s. The request may be stalled; stopping the thread interrupts it.`,
      });
    }

    refreshTurnStartWatchdog();
  }

  const threadOperationCounts = new Map<string, number>();
  const stagedThreadRewinds = new Map<string, StagedThreadRewind>();
  const suppressedThreadEventIds = new Set<string>();
  const threadGoalState = new RuntimeThreadGoalState();
  const turnState = new RuntimeTurnState();
  const toolCalls = new RuntimeToolCalls();
  const backgroundWorkState = new RuntimeBackgroundWorkState();
  const threadEventGrammar = new ThreadEventGrammar();
  const bridgeNodeEnv = defaultBridgeNodeEnv();

  const providerProcesses = new RuntimeProviderProcessManager({
    additionalWorkspaceWriteRoots,
    bridgeBundleDir: options.bridgeBundleDir,
    ...(bridgeNodeEnv !== undefined ? { bridgeNodeEnv } : {}),
    bridgeNodeExecutablePath: process.execPath,
    captureThreadExitState: (threadId) => {
      const pendingStart = pendingTurnStarts.get(threadId);

      return {
        activeTurnId: turnState.getActiveTurnId(threadId),
        pendingTurnStart: pendingStart !== undefined,
        ...(pendingStart === undefined
          ? {}
          : { pendingRequestId: pendingStart.clientRequestId }),
        providerThreadId:
          threadIdentityRegistry.getProviderThreadId(threadId) ?? null,
        threadId,
      };
    },
    containProviderProcess: options.containProviderProcess,
    createProviderIdentityState: (providerId) =>
      threadIdentityRegistry.createProviderState({ providerId }),
    env: options.env,
    getNextRequestId: () => nextRequestId++,
    handleStdoutLine: (args) =>
      handleStdoutLine(args.line, args.providerProcess),
    onProcessExit: options.onProcessExit,
    onProviderThreadDetached: ({ reason, threadId }) => {
      toolCalls.cancelThread(threadId);
      threadIdentityRegistry.clearThread(threadId);
      clearThreadRuntimeConfig(threadId);
      turnState.clearThread(threadId);
      const stoppedBackgroundTasks = backgroundWorkState.clearThread(threadId);
      threadEventGrammar.clearThread(threadId);

      if (providerDetachmentSettlesBackgroundTasks(reason)) {
        emitStoppedBackgroundTasks(stoppedBackgroundTasks);
      }
    },
    onStderr: options.onStderr,
    skillRoots,
    workspacePath: options.workspacePath,
  });

  function resolveProviderProcessKey(
    args: ResolveProviderProcessKeyArgs,
  ): string {
    const roots = args.skillRoots ?? skillRoots;

    for (const root of roots) {
      if (!path.isAbsolute(root.path)) {
        throw new Error(
          `Agent runtime skill root "${root.id}" must use an absolute path: ${root.path}`,
        );
      }
    }

    const catalogKey =
      roots.length === 0
        ? ""
        : `#skills:${createHash("sha256").update(JSON.stringify(roots)).digest("hex")}`;

    return `${args.providerId}#bridge:${bridgeLaunchProcessKey(args.bridgeLaunch)}${catalogKey}`;
  }

  function requireProviderProcessForThread(threadId: string): ProviderProcess {
    const providerId =
      threadIdentityRegistry.resolveProviderForThread(threadId);

    const config = threadRuntimeConfigs.get(threadId);

    if (config === undefined) {
      throw new Error(
        `Thread "${threadId}" has no live provider session on "${providerId}"`,
      );
    }

    return providerProcesses.requireProviderProcess({
      processKey: config.processKey,
      providerId,
    });
  }

  async function releaseThreadOnBridgeBestEffort(args: {
    proc: ProviderProcess;
    threadId: string;
  }): Promise<void> {
    if (hasChildProcessExited(args.proc.child)) {
      return;
    }

    const providerThreadId =
      threadIdentityRegistry.getProviderThreadId(args.threadId) ??
      args.threadId;

    const plan = args.proc.adapter.buildCommandPlan({
      type: "thread/stop",
      threadId: args.threadId,
      providerThreadId,
      activeTurnId: null,
    });

    if (plan.kind !== "request") {
      return;
    }

    try {
      await sendCommand({
        proc: args.proc,
        message: plan,
        resultSchema: ignoredJsonRpcResultSchema,
        timeoutMs: FAILED_CONSTRUCTION_RELEASE_TIMEOUT_MS,
      });
    } catch (error) {
      options.onStderr?.(
        `Best-effort release of thread "${args.threadId}" after a failed session construction did not complete: ${error instanceof Error ? error.message : String(error)}`,
        args.threadId,
      );
    }
  }

  async function releaseIdleProviderProcess(
    proc: ProviderProcess,
  ): Promise<void> {
    if (proc.identity.threadIds.size > 0) {
      return;
    }

    await providerProcesses.shutdownProvider({
      processKey: proc.processKey,
      providerId: proc.providerId,
    });
  }

  async function abandonFailedSessionConstruction(args: {
    proc: ProviderProcess;
    threadId: string;
  }): Promise<void> {
    await releaseThreadOnBridgeBestEffort(args);
    forgetThreadRuntimeStateForProviderState(
      args.proc.identity,
      args.threadId,
      "session-construction-abandoned",
    );

    try {
      await releaseIdleProviderProcess(args.proc);
    } catch (shutdownError) {
      options.onStderr?.(
        `Failed to retire the provider after thread "${args.threadId}" session construction failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
      );
    }
  }

  async function sendCommand<TResult>(args: {
    proc: ProviderProcess;
    message: SendJsonRpcRequestArgs<TResult>["message"];
    resultSchema: SendJsonRpcRequestArgs<TResult>["resultSchema"];
    timeoutMs?: number;
    afterTimeout?: SendJsonRpcRequestArgs<TResult>["afterTimeout"];
    recovery?: RequestRecoveryArgs;
    allowUnarchive?: boolean;
  }): Promise<TResult> {
    return sendRequestWithRecovery({
      allowUnarchive: args.allowUnarchive ?? true,
      proc: args.proc,
      recovery: args.recovery,
      request: {
        child: args.proc.child,
        getNextId: () => nextRequestId++,
        message: args.message,
        pending: args.proc.pending,
        resultSchema: args.resultSchema,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.afterTimeout !== undefined
          ? { afterTimeout: args.afterTimeout }
          : {}),
      },
    });
  }

  interface RequestRecoveryPolicy<TResult> {
    allowUnarchive: boolean;
    proc: ProviderProcess;
    recovery: RequestRecoveryArgs | undefined;
    request: SendJsonRpcRequestArgs<TResult>;
  }

  async function sendRequestWithRecovery<TResult>(
    args: RequestRecoveryPolicy<TResult>,
  ): Promise<TResult> {
    try {
      return await sendJsonRpcRequest({
        ...args.request,
        child: args.proc.child,
        pending: args.proc.pending,
      });
    } catch (error) {
      const hint = rejectionHint(error, {
        providerId: args.proc.providerId,
        ...(args.recovery === undefined
          ? {}
          : { threadId: args.recovery.threadId }),
      });

      if (hint === null) {
        throw error;
      }

      return await actOnRejection({ ...args, error, hint });
    }
  }

  async function actOnRejection<TResult>(
    args: RequestRecoveryPolicy<TResult> & {
      error: unknown;
      hint: AgentRuntimeProviderRecoveryHint;
    },
  ): Promise<TResult> {
    const { error, hint, recovery } = args;

    switch (hint.kind) {
      case "sessionArchived":
        if (recovery !== undefined && hint.retryable && args.allowUnarchive) {
          return await unarchiveAndRetryRequest({
            error,
            proc: args.proc,
            recovery,
            request: args.request,
          });
        }

        throw error;
      case "rateLimited":
        handleRecoveryHint({ hint, proc: args.proc, source: "rejection" });
        throw toRecoveryError({ cause: error, code: "rate_limited", hint });
      case "authRequired":
        handleRecoveryHint({ hint, proc: args.proc, source: "rejection" });
        throw toRecoveryError({ cause: error, code: "auth_required", hint });
      case "restartRecommended":
        handleRecoveryHint({ hint, proc: args.proc, source: "rejection" });
        throw error;
      case "staleTurn":
        throw error;
    }
  }

  function rejectionHint(
    error: unknown,
    scope: { providerId: string; threadId?: string },
  ): AgentRuntimeProviderRecoveryHint | null {
    if (!(error instanceof JsonRpcResponseError) || error.recovery === null) {
      return null;
    }

    return { ...scope, ...error.recovery };
  }

  function toRecoveryError(args: {
    cause: unknown;
    code: AgentRuntimeRecoveryError["code"];
    hint: AgentRuntimeProviderRecoveryHint;
  }): AgentRuntimeRecoveryError {
    return new AgentRuntimeRecoveryError({
      cause: args.cause,
      code: args.code,
      message: args.hint.message,
      recovery: args.hint,
    });
  }

  interface RetryableRequestArgs<TResult> {
    error: unknown;
    proc: ProviderProcess;
    recovery: RequestRecoveryArgs;
    request: SendJsonRpcRequestArgs<TResult>;
  }

  async function unarchiveAndRetryRequest<TResult>(
    args: RetryableRequestArgs<TResult>,
  ): Promise<TResult> {
    const { error, recovery } = args;
    options.onStderr?.(
      `Session "${recovery.providerThreadId}" is archived; unarchiving before retrying thread "${recovery.threadId}".`,
    );
    let retryProc: ProviderProcess;

    try {
      await archiveOrUnarchiveThread({
        commandType: "thread/unarchive",
        ...recovery,
      });
      retryProc = providerProcesses.requireProviderProcess({
        processKey: args.proc.processKey,
        providerId: args.proc.providerId,
      });
    } catch (recoveryError) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message, { cause: recoveryError });
    }

    return sendRequestWithRecovery({
      allowUnarchive: false,
      proc: retryProc,
      recovery,
      request: args.request,
    });
  }

  function resolveOmnyoThreadIdForProcess(
    proc: ProviderProcess,
    providerThreadId: string | undefined,
  ): string | undefined {
    return threadIdentityRegistry.resolveAppThreadIdForProviderThread({
      providerState: proc.identity,
      providerThreadId,
    });
  }

  function formatProviderRequestKindForSentence(
    requestKind: RuntimeProviderRequestKind,
  ): string {
    return requestKind === "tool call" ? "Tool call" : "Interactive request";
  }

  function resolveProviderRequestThreadId(
    args: ResolveProviderRequestThreadIdArgs,
  ): string | null {
    const resolvedThreadId = resolveOmnyoThreadIdForProcess(
      args.proc,
      args.providerThreadId,
    );

    if (!resolvedThreadId) {
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: `Unable to resolve Omnyo thread id for ${args.requestKind} on provider thread "${args.providerThreadId}"`,
      });

      return null;
    }

    if (args.threadIdHint && args.threadIdHint !== resolvedThreadId) {
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: `${formatProviderRequestKindForSentence(args.requestKind)} thread hint "${args.threadIdHint}" did not match resolved Omnyo thread "${resolvedThreadId}" for provider thread "${args.providerThreadId}"`,
      });

      return null;
    }

    return resolvedThreadId;
  }

  function requireProviderRequestPlan(
    args: RequireProviderRequestPlanArgs,
  ): ProviderRequestCommandPlan {
    if (args.plan.kind === "request") {
      return args.plan;
    }

    throw new Error(
      `Adapter "${args.providerId}" returned no provider request for ${args.commandType}: ${args.plan.reason}`,
    );
  }

  function setThreadRuntimeConfig(
    threadId: string,
    config: ThreadRuntimeConfig,
  ): void {
    threadRuntimeConfigs.set(threadId, config);
  }

  function updateSessionRestoreCapability(
    threadId: string,
    sessionRestorable: boolean | undefined,
  ): void {
    if (sessionRestorable === undefined) {
      return;
    }

    const current = threadRuntimeConfigs.get(threadId);

    if (current) {
      threadRuntimeConfigs.set(threadId, { ...current, sessionRestorable });
    }
  }

  function clearThreadRuntimeConfig(threadId: string): void {
    threadsAwaitingBridgeRestart.delete(threadId);
    threadsRetryingBridgeRestartOnIdle.delete(threadId);
    idleProviderSessionSinceMsByThreadId.delete(threadId);
    clearPendingTurnStart(threadId);
    threadGoalState.clearThread(threadId);
    threadRuntimeConfigs.delete(threadId);
  }

  function beginThreadOperation(threadId: string): void {
    threadOperationCounts.set(
      threadId,
      (threadOperationCounts.get(threadId) ?? 0) + 1,
    );
  }

  function finishThreadOperation(threadId: string): void {
    const current = threadOperationCounts.get(threadId);

    if (current === undefined || current <= 1) {
      threadOperationCounts.delete(threadId);
      resolveTurnWaitersIfSettled(threadId);
      retryBridgeRestartOnIdle(threadId);

      return;
    }

    threadOperationCounts.set(threadId, current - 1);
  }

  function retryBridgeRestartOnIdle(threadId: string): void {
    if (!threadsRetryingBridgeRestartOnIdle.has(threadId)) {
      return;
    }

    queueMicrotask(() => {
      const hint = threadsAwaitingBridgeRestart.get(threadId);

      if (hint === undefined) {
        threadsRetryingBridgeRestartOnIdle.delete(threadId);

        return;
      }

      if (
        threadHasInFlightOperation(threadId) ||
        turnState.getActiveTurnId(threadId) !== null
      ) {
        return;
      }

      threadsRetryingBridgeRestartOnIdle.delete(threadId);
      scheduleBridgeRestart({ hint, threadId, retryOnIdle: true });
    });
  }

  function threadHasInFlightOperation(threadId: string): boolean {
    return threadOperationCounts.has(threadId);
  }

  function threadMayStartTurn(threadId: string): boolean {
    return (
      turnState.getActiveTurnId(threadId) !== null ||
      pendingTurnStarts.has(threadId) ||
      threadHasInFlightOperation(threadId)
    );
  }

  function resolveTurnWaitersIfSettled(threadId: string): void {
    if (!threadMayStartTurn(threadId)) {
      turnState.resolveWaitersWithoutTurn(threadId);
    }
  }

  async function runThreadOperation<TResult>(
    args: RunThreadOperationArgs<TResult>,
  ): Promise<TResult> {
    beginThreadOperation(args.threadId);

    try {
      return await args.work();
    } finally {
      finishThreadOperation(args.threadId);
    }
  }

  function assertThreadCanStartTurn(threadId: string): void {
    if (
      turnState.getActiveTurnId(threadId) !== null ||
      pendingTurnStarts.has(threadId)
    ) {
      throw new CompetingTurnError(threadId);
    }
  }

  function recordProviderThreadIdentity(
    proc: ProviderProcess,
    threadId: string,
    providerThreadId: string,
  ): void {
    threadIdentityRegistry.recordProviderThreadIdentity({
      providerState: proc.identity,
      threadId,
      providerThreadId,
    });
  }

  function emitStoppedBackgroundTasks(
    events: readonly RuntimeStoppedBackgroundTaskEvent[],
  ): void {
    for (const event of events) {
      options.onEvent(event);
    }
  }

  function forgetThreadRuntimeStateForProviderState(
    providerState: RuntimeProviderProcess["identity"],
    threadId: string,
    release: ThreadRuntimeStateRelease,
  ): void {
    options.onThreadDetached?.({
      providerId: providerState.providerId,
      threadId,
    });
    threadIdentityRegistry.forgetThread({
      providerState,
      threadId,
    });
    clearThreadRuntimeConfig(threadId);
    turnState.clearThread(threadId);
    const stoppedBackgroundTasks = backgroundWorkState.clearThread(threadId);
    threadEventGrammar.clearThread(threadId);

    if (threadReleaseSettlesBackgroundTasks(release)) {
      emitStoppedBackgroundTasks(stoppedBackgroundTasks);
    }
  }

  function markProviderSessionNotIdle(threadId: string): void {
    idleProviderSessionSinceMsByThreadId.delete(threadId);
  }

  function markHostedProviderSessionIdle(threadId: string): void {
    if (
      threadIdentityRegistry.getProviderSession(threadId) === null ||
      turnState.getActiveTurnId(threadId) !== null ||
      pendingTurnStarts.has(threadId)
    ) {
      return;
    }

    if (!idleProviderSessionSinceMsByThreadId.has(threadId)) {
      idleProviderSessionSinceMsByThreadId.set(threadId, Date.now());
    }
  }

  function restartHostedProviderSessionIdleClock(threadId: string): void {
    markProviderSessionNotIdle(threadId);
    markHostedProviderSessionIdle(threadId);
  }

  function observeProviderSessionIdleState(args: {
    backgroundWorkSettled: boolean;
    event: ThreadEvent;
  }): void {
    const { event } = args;

    if (args.backgroundWorkSettled) {
      restartHostedProviderSessionIdleClock(event.threadId);
    }

    if (event.type === "turn/started") {
      clearPendingTurnStart(event.threadId);
      markProviderSessionNotIdle(event.threadId);

      return;
    }

    if (event.type === "turn/completed") {
      clearPendingTurnStart(event.threadId);
      markHostedProviderSessionIdle(event.threadId);
      resolveTurnWaitersIfSettled(event.threadId);

      return;
    }

    if (event.type === "provider/error" && event.willRetry !== true) {
      clearPendingTurnStart(event.threadId);
      markHostedProviderSessionIdle(event.threadId);
      resolveTurnWaitersIfSettled(event.threadId);
    }
  }

  function findReapableIdleProviderSession(
    args: FindReapableIdleProviderSessionArgs,
  ):
    | { candidate: ReapIdleProviderSessionCandidate }
    | { retained: RetainedProviderSession } {
    const runtimeConfig = threadRuntimeConfigs.get(args.threadId);
    const idleSinceMs = idleProviderSessionSinceMsByThreadId.get(args.threadId);
    let processId: number | null = null;

    if (runtimeConfig) {
      try {
        processId =
          providerProcesses.requireProviderProcess({
            processKey: runtimeConfig.processKey,
            providerId: runtimeConfig.providerId,
          }).child.pid ?? null;
      } catch {
        processId = null;
      }
    }

    const retained = (reason: RetainedProviderSessionReason) => ({
      retained: {
        threadId: args.threadId,
        providerId: runtimeConfig?.providerId ?? null,
        processId,
        idleForMs:
          idleSinceMs === undefined
            ? null
            : Math.max(0, args.nowMs - idleSinceMs),
        reason,
      },
    });

    if (threadHasInFlightOperation(args.threadId))
      return retained("in-flight-operation");

    if (pendingTurnStarts.has(args.threadId)) return retained("pending-turn");

    if (turnState.getActiveTurnId(args.threadId) !== null)
      return retained("active-turn");

    if (!runtimeConfig) return retained("provider-unavailable");

    if (!runtimeConfig.sessionRestorable) {
      return retained("not-restorable");
    }

    const providerThreadId = threadIdentityRegistry.getProviderThreadId(
      args.threadId,
    );

    if (!providerThreadId) {
      return retained("provider-unavailable");
    }

    if (idleSinceMs === undefined) {
      return retained("idle-time-unknown");
    }

    if (args.nowMs - idleSinceMs < args.idleForMs) {
      return retained("idle-grace");
    }

    return {
      candidate: {
        idleSinceMs,
        providerThreadId,
        runtimeConfig,
        processId,
        threadId: args.threadId,
      },
    };
  }

  function requireProviderThreadId(threadId: string): string {
    const providerThreadId =
      threadIdentityRegistry.getProviderThreadId(threadId);

    if (!providerThreadId) {
      throw new Error(`No provider thread id available for ${threadId}`);
    }

    return providerThreadId;
  }

  function handleRecoveryHint(args: {
    hint: AgentRuntimeProviderRecoveryHint;
    proc: ProviderProcess;
    source: "rejection" | "unsolicited";
  }): void {
    const { hint } = args;
    options.onProviderRecovery?.(hint);

    if (hint.kind === "restartRecommended" && hint.threadId !== undefined) {
      scheduleBridgeRestart({
        hint,
        retryOnIdle: args.source === "unsolicited",
        threadId: hint.threadId,
      });
    }
  }

  function scheduleBridgeRestart(args: {
    hint: AgentRuntimeProviderRecoveryHint;
    retryOnIdle: boolean;
    threadId: string;
  }): void {
    if (!threadRuntimeConfigs.has(args.threadId)) {
      return;
    }

    threadsAwaitingBridgeRestart.set(args.threadId, args.hint);

    if (turnState.getActiveTurnId(args.threadId) !== null) {
      return;
    }

    if (threadHasInFlightOperation(args.threadId)) {
      if (args.retryOnIdle) {
        threadsRetryingBridgeRestartOnIdle.add(args.threadId);
      }

      return;
    }

    threadsRetryingBridgeRestartOnIdle.delete(args.threadId);
    void runThreadOperation({
      threadId: args.threadId,
      work: async () => {
        const currentConfig = threadRuntimeConfigs.get(args.threadId);

        if (!currentConfig) {
          threadsAwaitingBridgeRestart.delete(args.threadId);

          return;
        }

        await restartThreadBridgeIfRecommended({
          threadId: args.threadId,
          options: currentConfig.options,
          instructions: currentConfig.instructions,
        });
      },
    }).catch((error: unknown) => {
      options.onStderr?.(
        `Bridge restart for thread "${args.threadId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        args.threadId,
      );
    });
  }

  async function restartThreadBridgeIfRecommended(
    args: RestartThreadBridgeArgs,
  ): Promise<void> {
    const hint = threadsAwaitingBridgeRestart.get(args.threadId);

    if (hint === undefined) {
      return;
    }

    const currentConfig = threadRuntimeConfigs.get(args.threadId);

    if (!currentConfig) {
      threadsAwaitingBridgeRestart.delete(args.threadId);

      return;
    }

    if (turnState.getActiveTurnId(args.threadId) !== null) {
      return;
    }

    const proc = providerProcesses.requireProviderProcess({
      processKey: currentConfig.processKey,
      providerId: currentConfig.providerId,
    });

    const hostedThreadIds = [...proc.identity.threadIds].filter(
      (threadId) => threadId !== args.threadId,
    );

    const busyThreadId = hostedThreadIds.find(
      (threadId) =>
        turnState.getActiveTurnId(threadId) !== null ||
        pendingTurnStarts.has(threadId) ||
        threadHasInFlightOperation(threadId) ||
        backgroundWorkState.hasOpenThreadWork(threadId),
    );

    if (busyThreadId !== undefined) {
      options.onStderr?.(
        `Deferring the "${currentConfig.providerId}" bridge restart recommended for thread "${args.threadId}": thread "${busyThreadId}" is mid-turn or has open background work on the same process.`,
        args.threadId,
      );

      return;
    }

    threadsAwaitingBridgeRestart.delete(args.threadId);
    const providerThreadId = requireProviderThreadId(args.threadId);

    const hostedSessions = hostedThreadIds.flatMap((threadId) => {
      const config = threadRuntimeConfigs.get(threadId);

      const hostedProviderThreadId =
        threadIdentityRegistry.getProviderThreadId(threadId);

      return config !== undefined && hostedProviderThreadId !== undefined
        ? [{ config, providerThreadId: hostedProviderThreadId, threadId }]
        : [];
    });

    options.onStderr?.(
      `Restarting the "${currentConfig.providerId}" bridge for thread "${args.threadId}": ${hint.message}`,
      args.threadId,
    );
    await providerProcesses.shutdownProvider({
      processKey: proc.processKey,
      providerId: proc.providerId,
    });
    await resumeThreadFromConfig({
      currentConfig,
      instructions: args.instructions,
      options: args.options,
      providerThreadId,
      threadId: args.threadId,
    });

    for (const hosted of hostedSessions) {
      if (
        threadIdentityRegistry.getProviderSession(hosted.threadId) !== null ||
        threadHasInFlightOperation(hosted.threadId) ||
        pendingTurnStarts.has(hosted.threadId) ||
        turnState.getActiveTurnId(hosted.threadId) !== null
      ) {
        continue;
      }

      try {
        await resumeThreadFromConfig({
          currentConfig: hosted.config,
          instructions: hosted.config.instructions,
          options: hosted.config.options,
          providerThreadId: hosted.providerThreadId,
          threadId: hosted.threadId,
        });
      } catch (error) {
        options.onStderr?.(
          `Failed to resume thread "${hosted.threadId}" after the bridge restart: ${error instanceof Error ? error.message : String(error)}`,
          hosted.threadId,
        );
      }
    }
  }

  async function resumeThreadFromConfig(args: {
    currentConfig: ThreadRuntimeConfig;
    instructions: string | undefined;
    options: AgentRuntimeExecutionOptions;
    providerThreadId: string;
    threadId: string;
  }): Promise<void> {
    const { currentConfig } = args;
    const resumeInstructions = args.instructions ?? currentConfig.instructions;
    await runtime.resumeThread({
      bridgeLaunch: currentConfig.bridgeLaunch,
      skillRoots: currentConfig.skillRoots,
      environmentId: currentConfig.environmentId,
      threadId: args.threadId,
      ...(currentConfig.projectId !== undefined
        ? { projectId: currentConfig.projectId }
        : {}),
      providerThreadId: args.providerThreadId,
      providerId: currentConfig.providerId,
      contributedEnv: currentConfig.contributedEnv,
      options: args.options,
      ...(resumeInstructions !== undefined
        ? { instructions: resumeInstructions }
        : {}),
      ...(currentConfig.dynamicTools !== undefined
        ? { dynamicTools: currentConfig.dynamicTools }
        : {}),
      instructionMode: currentConfig.instructionMode,
    });
  }

  async function archiveOrUnarchiveThread(
    args: ArchiveOrUnarchiveThreadArgs,
  ): Promise<void> {
    const { commandType, providerId, providerThreadId, threadId } = args;
    const threadConfig = threadRuntimeConfigs.get(threadId);
    const bridgeLaunch = args.bridgeLaunch ?? threadConfig?.bridgeLaunch;

    if (bridgeLaunch === undefined) {
      throw new Error(
        `Cannot ${commandType} thread "${threadId}" on "${providerId}": the thread has no live session and the request carried no bridge launch`,
      );
    }

    const processKey =
      threadConfig?.processKey ??
      resolveProviderProcessKey({ bridgeLaunch, providerId });

    await providerProcesses.ensureProvider({
      processKey,
      providerId,
      bridgeLaunch,
      skillRoots: threadConfig?.skillRoots,
    });

    const proc = providerProcesses.requireProviderProcess({
      processKey,
      providerId,
    });

    if (!proc.adapter.capabilities.supportsThreadArchive) {
      throw new Error(
        `Provider "${providerId}" does not support thread archive.`,
      );
    }

    const adapterCommand: AdapterCommand = {
      type: commandType,
      threadId,
      providerThreadId,
    };

    const cmd = requireProviderRequestPlan({
      commandType: adapterCommand.type,
      plan: proc.adapter.buildCommandPlan(adapterCommand),
      providerId,
    });

    await sendCommand({
      proc,
      message: cmd,
      resultSchema: ignoredJsonRpcResultSchema,
    });

    if (commandType === "thread/archive") {
      forgetThreadRuntimeStateForProviderState(
        proc.identity,
        threadId,
        "thread-archived",
      );
    }

    await releaseIdleProviderProcess(proc);
  }

  function recordThreadExecutionOptions(
    args: RecordThreadExecutionOptionsArgs,
  ): void {
    const currentConfig = threadRuntimeConfigs.get(args.threadId);

    if (!currentConfig) {
      return;
    }

    setThreadRuntimeConfig(args.threadId, {
      ...currentConfig,
      options: args.options,
    });
  }

  function environmentRecordsEqual(
    left: Readonly<Record<string, string>>,
    right: Readonly<Record<string, string>>,
  ): boolean {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);

    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([name, value]) => right[name] === value)
    );
  }

  function emitResolvedProviderEnvironment(args: {
    droppedContributions: DroppedThreadEnvironmentContribution[];
    entries: ResolvedThreadEnvironmentEntry[];
    providerThreadId: string;
    threadId: string;
  }): void {
    options.onEvent({
      type: "provider.env-resolved",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      entries: args.entries,
      scope: { kind: "thread" },
    });

    for (const contribution of args.droppedContributions) {
      options.onEvent({
        type: "provider/warning",
        threadId: args.threadId,
        providerThreadId: args.providerThreadId,
        category: "config",
        summary: `Dropped environment variable "${contribution.name}" from plugin "${contribution.plugin}".`,
        details:
          "OMNYO_SERVER_URL is unavailable, so its serverPath contribution was not applied.",
        scope: { kind: "thread" },
      });
    }
  }

  function resolveRuntimeThreadEnvironment(args: {
    contributedEnv: readonly AgentRuntimeContributedEnvEntry[];
    environmentId: string;
    projectId?: string;
    threadId: string;
  }): {
    droppedContributions: DroppedThreadEnvironmentContribution[];
    envVars: Record<string, string>;
    entries: ResolvedThreadEnvironmentEntry[];
  } {
    return resolveThreadEnvironment({
      baseShellEnv: options.shellEnv,
      contributedEnv: args.contributedEnv,
      environmentId: args.environmentId,
      projectId: args.projectId,
      threadStoragePath: resolveThreadStoragePath({
        options,
        threadId: args.threadId,
      }),
      threadId: args.threadId,
    });
  }

  function emitTranslatedEvents(args: EmitTranslatedEventsArgs): void {
    for (const event of args.events) {
      const scope = {
        eventThreadId: event.threadId,
        providerState: args.proc.identity,
        sourceThreadId: args.sourceThreadId,
      };

      const resolvedOmnyoThreadId =
        event.type === "thread/identity"
          ? threadIdentityRegistry.resolveProviderIdentityThreadId(scope)
          : threadIdentityRegistry.resolveProviderEventThreadId(scope);

      if (!resolvedOmnyoThreadId) {
        options.onStderr?.(
          `Dropping unscoped provider event ${event.type}; no Omnyo thread could be resolved`,
        );
        continue;
      }

      const targetThreadId = resolvedOmnyoThreadId;

      if (suppressedThreadEventIds.has(targetThreadId)) {
        continue;
      }

      if (event.type === "thread/identity" && event.providerThreadId) {
        recordProviderThreadIdentity(
          args.proc,
          targetThreadId,
          event.providerThreadId,
        );
      }

      const stampedEvent = stampThreadEventScope({
        event,
        providerThreadId:
          threadIdentityRegistry.getProviderThreadId(targetThreadId),
        threadId: targetThreadId,
      });

      const grammarResult = threadEventGrammar.observe(stampedEvent);

      if (grammarResult.kind === "violation") {
        options.onStderr?.(
          `Dropping ${stampedEvent.type} from provider "${args.proc.providerId}" in thread "${targetThreadId}" (${grammarResult.rule}): ${grammarResult.reason}.`,
        );
        continue;
      }

      const normalizedEvent = normalizeProviderThreadNameEvent(stampedEvent);

      if (
        normalizedEvent.type === "turn/completed" &&
        normalizedEvent.scope.kind === "turn"
      ) {
        toolCalls.cancelThread(targetThreadId, normalizedEvent.scope.turnId);
      }

      turnState.observe(normalizedEvent);

      const backgroundWorkWasOpen =
        backgroundWorkState.hasOpenThreadWork(targetThreadId);

      backgroundWorkState.observe(normalizedEvent);
      observeProviderSessionIdleState({
        backgroundWorkSettled:
          backgroundWorkWasOpen &&
          !backgroundWorkState.hasOpenThreadWork(targetThreadId),
        event: normalizedEvent,
      });
      options.onEvent(normalizedEvent);
      threadGoalState.observe(normalizedEvent);
    }
  }

  function handleProviderNotification(args: RuntimeParsedMessageArgs): void {
    if (args.parsed.method === PROVIDER_TOOL_CALL_CANCELLED_METHOD) {
      const cancellation = providerToolCallCancellationSchema.safeParse(
        args.parsed.params,
      );

      if (cancellation.success) {
        toolCalls.cancel(
          args.proc.interactiveRequestScope,
          cancellation.data.requestId,
        );
      }

      return;
    }

    const sourceThreadId = getJsonRpcStringParam(args.parsed, "threadId");

    if (
      sourceThreadId !== undefined &&
      suppressedThreadEventIds.has(sourceThreadId)
    ) {
      return;
    }

    const recoveryHint = args.proc.adapter.decodeRecoveryHint?.(args.parsed);

    if (recoveryHint !== null && recoveryHint !== undefined) {
      if (
        recoveryHint.threadId !== undefined &&
        !args.proc.identity.threadIds.has(recoveryHint.threadId)
      ) {
        options.onStderr?.(
          `Dropping provider/recovery ${recoveryHint.kind} from "${args.proc.providerId}": it names thread "${recoveryHint.threadId}", which that process does not host.`,
        );

        return;
      }

      handleRecoveryHint({
        hint: { providerId: args.proc.providerId, ...recoveryHint },
        proc: args.proc,
        source: "unsolicited",
      });

      return;
    }

    emitTranslatedEvents({
      events: args.proc.adapter.translateEvent(args.parsed),
      proc: args.proc,
      sourceThreadId,
    });
  }

  function handleStdoutLine(line: string, proc: ProviderProcess): void {
    const parsedLine = parseJsonRpcLine(line);

    if (
      parsedLine.kind === "non_json" ||
      parsedLine.kind === "invalid_json_rpc"
    ) {
      options.onStderr?.(line);

      return;
    }

    if (parsedLine.kind === "response") {
      settleJsonRpcResponse({
        id: parsedLine.parsedId,
        pending: proc.pending,
        response: parsedLine.parsed,
      });

      return;
    }

    if (parsedLine.kind === "request") {
      handleRuntimeProviderRequest({
        getActiveTurnId: (threadId) => turnState.getActiveTurnId(threadId),
        getThreadExecutionOptions: (threadId) =>
          threadRuntimeConfigs.get(threadId)?.options,
        onInteractiveRequest: options.onInteractiveRequest,
        onToolCall: options.onToolCall,
        toolCalls,
        parsedId: parsedLine.parsedId,
        parsedMethod: parsedLine.parsedMethod,
        providerProcess: proc,
        rawRequest: parsedLine.rawRequest,
        resolveThreadId: (request) =>
          resolveProviderRequestThreadId({
            ...request,
            proc,
          }),
      });

      return;
    }

    handleProviderNotification({
      parsed: parsedLine.parsed,
      proc,
    });
  }

  function schedulePreparedThreadRewindCleanup(
    leaseId: string,
    prepared: PreparedThreadRewind,
    delayMs: number,
  ): void {
    if (prepared.cleanupTimer !== null) {
      clearTimeout(prepared.cleanupTimer);
    }

    prepared.cleanupTimer = setTimeout(() => {
      void discardStagedThreadRewind(leaseId);
    }, delayMs);
    prepared.cleanupTimer.unref?.();
  }

  function finishPreparedThreadRewindCleanup(
    leaseId: string,
    prepared: PreparedThreadRewind,
  ): void {
    if (prepared.cleanupTimer !== null) {
      clearTimeout(prepared.cleanupTimer);
      prepared.cleanupTimer = null;
    }

    if (stagedThreadRewinds.get(leaseId) === prepared) {
      stagedThreadRewinds.delete(leaseId);
    }

    suppressedThreadEventIds.delete(prepared.stagingThreadId);
  }

  async function sendStagedThreadDiscard(
    proc: ProviderProcess,
    stagingThreadId: string,
    providerThreadId: string,
  ): Promise<void> {
    const command = proc.adapter.buildCommandPlan({
      type: "thread/discard",
      threadId: stagingThreadId,
      providerThreadId,
    });

    if (command.kind === "request") {
      await sendCommand({
        proc,
        message: command,
        resultSchema: ignoredJsonRpcResultSchema,
      });
    }
  }

  async function discardStagedThreadRewind(leaseId: string): Promise<void> {
    const staged = stagedThreadRewinds.get(leaseId);

    if (staged?.state === "preparing") {
      try {
        await staged.promise;
      } catch {
        return;
      }
    }

    const prepared = stagedThreadRewinds.get(leaseId);

    if (prepared === undefined || prepared.state !== "prepared") {
      return;
    }

    if (prepared.cleanupPromise !== null) {
      await prepared.cleanupPromise;

      return;
    }

    const cleanup = (async () => {
      let proc: ProviderProcess;

      try {
        proc = providerProcesses.requireProviderProcess({
          processKey: prepared.processKey,
          providerId: prepared.providerId,
        });
      } catch {
        forgetThreadRuntimeStateForProviderState(
          prepared.providerState,
          prepared.stagingThreadId,
          "staged-rewind-released",
        );
        finishPreparedThreadRewindCleanup(leaseId, prepared);

        return;
      }

      if (prepared.retainHistoryForForks) {
        await releaseThreadOnBridgeBestEffort({
          proc,
          threadId: prepared.stagingThreadId,
        });
        forgetThreadRuntimeStateForProviderState(
          proc.identity,
          prepared.stagingThreadId,
          "staged-rewind-released",
        );
        finishPreparedThreadRewindCleanup(leaseId, prepared);

        return;
      }

      try {
        await sendStagedThreadDiscard(
          proc,
          prepared.stagingThreadId,
          prepared.providerThreadId,
        );
      } catch (error) {
        schedulePreparedThreadRewindCleanup(
          leaseId,
          prepared,
          PREPARED_THREAD_REWIND_RETRY_MS,
        );
        options.onStderr?.(
          `Failed to discard staged rewind ${leaseId}; retrying: ${error instanceof Error ? error.message : String(error)}`,
        );

        return;
      }

      forgetThreadRuntimeStateForProviderState(
        proc.identity,
        prepared.stagingThreadId,
        "staged-rewind-released",
      );
      finishPreparedThreadRewindCleanup(leaseId, prepared);

      try {
        await releaseIdleProviderProcess(proc);
      } catch (error) {
        options.onStderr?.(
          `Failed to stop the idle provider after discarding staged rewind ${leaseId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();

    prepared.cleanupPromise = cleanup;

    try {
      await cleanup;
    } finally {
      if (
        stagedThreadRewinds.get(leaseId) === prepared &&
        prepared.cleanupPromise === cleanup
      ) {
        prepared.cleanupPromise = null;
      }
    }
  }

  const runtime: AgentRuntime = {
    async ensureProvider({
      providerId,
      bridgeLaunch,
      skillRoots: sessionSkillRoots = skillRoots,
    }) {
      await providerProcesses.ensureProvider({
        processKey: resolveProviderProcessKey({
          bridgeLaunch,
          providerId,
          skillRoots: sessionSkillRoots,
        }),
        providerId,
        bridgeLaunch,
        skillRoots: sessionSkillRoots,
      });
    },

    async startThread({
      environmentId,
      threadId,
      projectId,
      providerId,
      bridgeLaunch,
      skillRoots: sessionSkillRoots = skillRoots,
      contributedEnv = [],
      clientRequestId,
      input,
      options: execOpts,
      instructions,
      dynamicTools,
      instructionMode = "append",
      fork,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const processKey = resolveProviderProcessKey({
            bridgeLaunch,
            providerId,
            skillRoots: sessionSkillRoots,
          });

          await runtime.ensureProvider({
            providerId,
            bridgeLaunch,
            skillRoots: sessionSkillRoots,
          });

          const proc = providerProcesses.requireProviderProcess({
            processKey,
            providerId,
          });

          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId,
          });

          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv,
            environmentId,
            projectId,
            threadId,
          });

          threadIdentityRegistry.registerThreadProvider({
            providerId,
            providerState: proc.identity,
            threadId,
          });
          setThreadRuntimeConfig(threadId, {
            bridgeLaunch,
            skillRoots: sessionSkillRoots,
            contributedEnv,
            dynamicTools,
            environmentId,
            envVars: resolvedEnvironment.envVars,
            instructionMode,
            instructions,
            options: execOpts,
            processKey,
            projectId,
            providerId,
            sessionRestorable: false,
          });

          const providerExecutionContext = toProviderExecutionContext({
            envVars: resolvedEnvironment.envVars,
            execOpts,
            instructions,
          });

          const adapterCommand: AdapterCommand = fork
            ? {
                type: "thread/fork",
                threadId,
                cwd: options.workspacePath,
                sourceProviderThreadId: fork.sourceProviderThreadId,
                ...(fork.sourceProviderCheckpointId !== undefined
                  ? {
                      sourceProviderCheckpointId:
                        fork.sourceProviderCheckpointId,
                    }
                  : {}),
                options: providerExecutionContext,
                dynamicTools,
                instructionMode,
              }
            : {
                type: "thread/start",
                threadId,
                cwd: options.workspacePath,
                options: providerExecutionContext,
                dynamicTools,
                instructionMode,
              };

          if (fork) {
            for (const staged of stagedThreadRewinds.values()) {
              if (
                staged.state === "prepared" &&
                staged.providerThreadId === fork.sourceProviderThreadId
              ) {
                staged.retainHistoryForForks = true;
              }
            }
          }

          let resolved: string;

          try {
            const cmd = requireProviderRequestPlan({
              commandType: adapterCommand.type,
              plan: proc.adapter.buildCommandPlan(adapterCommand),
              providerId,
            });

            const result = await sendCommand({
              proc,
              message: cmd,
              resultSchema: threadIdentityResultSchema,
              timeoutMs: threadCreationRequestTimeoutMs,
              ...(fork
                ? {
                    recovery: {
                      providerId,
                      providerThreadId: fork.sourceProviderThreadId,
                      threadId,
                    },
                    allowUnarchive: fork.restoreArchivedSource ?? true,
                  }
                : {}),
            });

            updateSessionRestoreCapability(threadId, result.sessionRestorable);
            recordProviderThreadIdentity(
              proc,
              threadId,
              result.providerThreadId,
            );
            resolved = result.providerThreadId;
            emitResolvedProviderEnvironment({
              droppedContributions: resolvedEnvironment.droppedContributions,
              entries: resolvedEnvironment.entries,
              providerThreadId: resolved,
              threadId,
            });
          } catch (startError) {
            await abandonFailedSessionConstruction({ proc, threadId });

            if (
              fork?.restoreArchivedSource === false &&
              startError instanceof JsonRpcResponseError &&
              startError.recovery?.kind === "sessionArchived"
            ) {
              throw new Error(ARCHIVED_FORK_SOURCE_MESSAGE, {
                cause: startError,
              });
            }

            throw startError;
          }

          if (input && input.length > 0) {
            if (clientRequestId === undefined) {
              throw new Error(
                `Thread start with input requires a client request id for ${threadId}`,
              );
            }

            await runtime.runTurn({
              threadId,
              input,
              clientRequestId,
              options: execOpts,
              contributedEnv,
              instructions,
            });
          }

          markHostedProviderSessionIdle(threadId);

          return { providerThreadId: resolved };
        },
      });
    },

    async prepareThreadRewind({
      environmentId,
      threadId,
      leaseId,
      projectId,
      providerId,
      contributedEnv = [],
      sourceProviderThreadId,
      retainThroughProviderCheckpoint,
      bridgeLaunch,
      skillRoots: sessionSkillRoots = skillRoots,
      options: execOpts,
      instructions,
      dynamicTools,
      instructionMode = "append",
    }) {
      const existing = stagedThreadRewinds.get(leaseId);

      if (existing !== undefined) {
        return existing.state === "preparing"
          ? existing.promise
          : { providerThreadId: existing.providerThreadId };
      }

      const preparation = runThreadOperation({
        threadId,
        work: async () => {
          const processKey = resolveProviderProcessKey({
            bridgeLaunch,
            providerId,
            skillRoots: sessionSkillRoots,
          });

          await runtime.ensureProvider({
            providerId,
            bridgeLaunch,
            skillRoots: sessionSkillRoots,
          });

          const proc = providerProcesses.requireProviderProcess({
            processKey,
            providerId,
          });

          if (!proc.adapter.capabilities.supportsFork) {
            throw new Error(
              `Preparing a thread rewind is not supported by ${providerId}`,
            );
          }

          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId,
          });

          const stagingThreadId = `${threadId}:rewind:${leaseId}`;
          suppressedThreadEventIds.add(stagingThreadId);
          threadIdentityRegistry.registerThreadProvider({
            providerId,
            providerState: proc.identity,
            threadId: stagingThreadId,
          });
          let retainedForDiscard = false;
          let providerThreadIdForCleanup: string | undefined;

          try {
            const resolvedEnvironment = resolveRuntimeThreadEnvironment({
              contributedEnv,
              environmentId,
              projectId,
              threadId,
            });

            const adapterCommand: AdapterCommand = {
              type: "thread/fork",
              threadId: stagingThreadId,
              cwd: options.workspacePath,
              sourceProviderThreadId,
              sourceProviderCheckpointId: retainThroughProviderCheckpoint,
              options: toProviderExecutionContext({
                envVars: resolvedEnvironment.envVars,
                execOpts,
                instructions,
              }),
              dynamicTools,
              instructionMode,
            };

            const command = requireProviderRequestPlan({
              commandType: adapterCommand.type,
              plan: proc.adapter.buildCommandPlan(adapterCommand),
              providerId,
            });

            const result = await sendCommand({
              proc,
              message: command,
              resultSchema: threadIdentityResultSchema,
              timeoutMs: threadCreationRequestTimeoutMs,
              recovery: {
                bridgeLaunch,
                providerId,
                providerThreadId: sourceProviderThreadId,
                threadId: stagingThreadId,
              },
            });

            const providerThreadId = result.providerThreadId;
            providerThreadIdForCleanup = providerThreadId;
            recordProviderThreadIdentity(
              proc,
              stagingThreadId,
              providerThreadId,
            );

            const prepared: PreparedThreadRewind = {
              state: "prepared",
              cleanupPromise: null,
              cleanupTimer: null,
              retainHistoryForForks: false,
              processKey,
              providerId,
              providerState: proc.identity,
              providerThreadId,
              stagingThreadId,
              threadId,
            };

            stagedThreadRewinds.set(leaseId, prepared);
            schedulePreparedThreadRewindCleanup(
              leaseId,
              prepared,
              PREPARED_THREAD_REWIND_TTL_MS,
            );
            retainedForDiscard = true;

            return { providerThreadId };
          } finally {
            if (!retainedForDiscard) {
              if (providerThreadIdForCleanup !== undefined) {
                try {
                  await sendStagedThreadDiscard(
                    proc,
                    stagingThreadId,
                    providerThreadIdForCleanup,
                  );
                } catch (error) {
                  options.onStderr?.(
                    `Failed to discard unretained staged rewind ${leaseId}: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              } else {
                await releaseThreadOnBridgeBestEffort({
                  proc,
                  threadId: stagingThreadId,
                });
              }

              suppressedThreadEventIds.delete(stagingThreadId);
              threadIdentityRegistry.forgetThread({
                providerState: proc.identity,
                threadId: stagingThreadId,
              });
            }
          }
        },
      });

      stagedThreadRewinds.set(leaseId, {
        state: "preparing",
        promise: preparation,
      });

      try {
        return await preparation;
      } catch (error) {
        const current = stagedThreadRewinds.get(leaseId);

        if (current?.state === "preparing" && current.promise === preparation) {
          stagedThreadRewinds.delete(leaseId);
        }

        throw error;
      }
    },

    async discardThreadRewind({ leaseId }) {
      await discardStagedThreadRewind(leaseId);
    },

    async resumeThread({
      environmentId,
      threadId,
      projectId,
      providerThreadId,
      providerId,
      bridgeLaunch,
      skillRoots: sessionSkillRoots = skillRoots,
      contributedEnv = [],
      options: execOpts,
      instructions,
      dynamicTools,
      instructionMode = "append",
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const processKey = resolveProviderProcessKey({
            bridgeLaunch,
            providerId,
            skillRoots: sessionSkillRoots,
          });

          await runtime.ensureProvider({
            providerId,
            bridgeLaunch,
            skillRoots: sessionSkillRoots,
          });

          const proc = providerProcesses.requireProviderProcess({
            processKey,
            providerId,
          });

          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId,
          });

          if (providerThreadId !== undefined) {
            const ownerThreadId =
              threadIdentityRegistry.resolveAppThreadIdForProviderThread({
                providerState: proc.identity,
                providerThreadId,
              });

            if (ownerThreadId !== undefined && ownerThreadId !== threadId) {
              throw new Error(
                `Cannot resume thread "${threadId}" on "${providerId}": provider thread "${providerThreadId}" is already hosted by thread "${ownerThreadId}"`,
              );
            }
          }

          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv,
            environmentId,
            projectId,
            threadId,
          });

          threadIdentityRegistry.registerThreadProvider({
            providerId,
            providerState: proc.identity,
            threadId,
          });
          setThreadRuntimeConfig(threadId, {
            bridgeLaunch,
            skillRoots: sessionSkillRoots,
            contributedEnv,
            dynamicTools,
            environmentId,
            envVars: resolvedEnvironment.envVars,
            instructionMode,
            instructions,
            options: execOpts,
            processKey,
            projectId,
            providerId,
            sessionRestorable: false,
          });

          if (providerThreadId) {
            recordProviderThreadIdentity(proc, threadId, providerThreadId);
          }

          const adapterCommand: AdapterCommand = {
            type: "thread/resume",
            threadId,
            cwd: options.workspacePath,
            providerThreadId:
              providerThreadId ?? requireProviderThreadId(threadId),
            options: toProviderExecutionContext({
              envVars: resolvedEnvironment.envVars,
              execOpts,
              instructions,
            }),
            dynamicTools,
            instructionMode,
          };

          const plan = proc.adapter.buildCommandPlan(adapterCommand);

          if (plan.kind === "noop") {
            emitResolvedProviderEnvironment({
              droppedContributions: resolvedEnvironment.droppedContributions,
              entries: resolvedEnvironment.entries,
              providerThreadId: adapterCommand.providerThreadId,
              threadId,
            });

            return { providerThreadId: adapterCommand.providerThreadId };
          }

          let resolved: string;

          try {
            const result = await sendCommand({
              proc,
              message: plan,
              resultSchema: threadIdentityResultSchema,
              timeoutMs: threadCreationRequestTimeoutMs,
              recovery: {
                providerId,
                providerThreadId: adapterCommand.providerThreadId,
                threadId,
              },
            });

            recordProviderThreadIdentity(
              proc,
              threadId,
              result.providerThreadId,
            );
            updateSessionRestoreCapability(threadId, result.sessionRestorable);
            resolved = result.providerThreadId;
            emitResolvedProviderEnvironment({
              droppedContributions: resolvedEnvironment.droppedContributions,
              entries: resolvedEnvironment.entries,
              providerThreadId: resolved,
              threadId,
            });
          } catch (resumeError) {
            await abandonFailedSessionConstruction({ proc, threadId });
            throw resumeError;
          }

          markHostedProviderSessionIdle(threadId);

          return { providerThreadId: resolved };
        },
      });
    },

    async runTurn({
      threadId,
      input,
      clientRequestId,
      options: execOpts,
      contributedEnv,
      instructions,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          requireProviderProcessForThread(threadId);
          assertThreadCanStartTurn(threadId);
          await restartThreadBridgeIfRecommended({
            threadId,
            options: execOpts,
            instructions,
          });
          const proc = requireProviderProcessForThread(threadId);
          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId: pid,
          });
          const currentConfig = threadRuntimeConfigs.get(threadId);

          if (!currentConfig) {
            throw new Error(`No runtime configuration for thread ${threadId}`);
          }

          const resolvedContributedEnv =
            contributedEnv ?? currentConfig.contributedEnv;

          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv: resolvedContributedEnv,
            environmentId: currentConfig.environmentId,
            projectId: currentConfig.projectId,
            threadId,
          });

          const environmentChanged = !environmentRecordsEqual(
            currentConfig.envVars,
            resolvedEnvironment.envVars,
          );

          recordThreadExecutionOptions({
            threadId,
            options: execOpts,
          });

          const providerThreadId = requireProviderThreadId(threadId);

          const adapterCommand: AdapterCommand = {
            type: "turn/start",
            threadId,
            providerThreadId,
            input,
            clientRequestId,
            options: toProviderExecutionContext({
              envVars: resolvedEnvironment.envVars,
              execOpts,
              instructions,
            }),
          };

          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });

          assertThreadCanStartTurn(threadId);

          const pendingTurnStart = {
            clientRequestId,
            sinceMs: Date.now(),
            watchdogFired: false,
          };

          pendingTurnStarts.set(threadId, pendingTurnStart);
          refreshTurnStartWatchdog();
          markProviderSessionNotIdle(threadId);

          let status: RunTurnResult["status"] = "started";

          try {
            await sendCommand({
              proc,
              message: cmd,
              resultSchema: ignoredJsonRpcResultSchema,
              afterTimeout: {
                resolve: () => {},
                reject: (error) => {
                  if (pendingTurnStarts.get(threadId) !== pendingTurnStart) {
                    return;
                  }

                  clearPendingTurnStart(threadId);
                  markHostedProviderSessionIdle(threadId);
                  options.onEvent({
                    type: "system/error",
                    threadId,
                    scope: { kind: "thread" },
                    code: "provider_turn_start_failed",
                    message: `The provider failed to start the turn after its request timed out: ${error.message}`,
                  });
                },
              },
              recovery: {
                providerId: pid,
                providerThreadId: adapterCommand.providerThreadId,
                threadId,
              },
            });
          } catch (error) {
            if (!(error instanceof JsonRpcRequestTimeoutError)) {
              clearPendingTurnStart(threadId);
              markHostedProviderSessionIdle(threadId);
              throw error;
            }

            options.onStderr?.(
              `Turn start for thread "${threadId}" timed out; whether the provider starts it is unconfirmed.`,
              threadId,
            );
            status = "unconfirmed";
          }

          setThreadRuntimeConfig(threadId, {
            ...currentConfig,
            contributedEnv: resolvedContributedEnv,
            envVars: resolvedEnvironment.envVars,
            options: execOpts,
          });

          if (environmentChanged) {
            emitResolvedProviderEnvironment({
              droppedContributions: resolvedEnvironment.droppedContributions,
              entries: resolvedEnvironment.entries,
              providerThreadId,
              threadId,
            });
          }

          return { status };
        },
      });
    },

    async steerTurn({
      threadId,
      expectedTurnId,
      input,
      clientRequestId,
      options: execOpts,
      contributedEnv,
      instructions,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const currentProc = requireProviderProcessForThread(threadId);
          assertProviderSupportsExecutionOptions({
            adapter: currentProc.adapter,
            options: execOpts,
            providerId: pid,
          });

          const activeTurnId = turnState.getActiveTurnId(threadId);

          if (activeTurnId !== expectedTurnId) {
            options.onStderr?.(
              `Ignoring stale steer for thread "${threadId}" on turn "${expectedTurnId}"; active turn is ${activeTurnId ?? "none"}.`,
            );

            return {
              status: "stale",
              activeTurnId,
            };
          }

          await restartThreadBridgeIfRecommended({
            threadId,
            options: execOpts,
            instructions,
          });
          const proc = requireProviderProcessForThread(threadId);
          const currentConfig = threadRuntimeConfigs.get(threadId);

          if (!currentConfig) {
            throw new Error(`No runtime configuration for thread ${threadId}`);
          }

          const resolvedContributedEnv =
            contributedEnv ?? currentConfig.contributedEnv;

          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv: resolvedContributedEnv,
            environmentId: currentConfig.environmentId,
            projectId: currentConfig.projectId,
            threadId,
          });

          const environmentChanged = !environmentRecordsEqual(
            currentConfig.envVars,
            resolvedEnvironment.envVars,
          );

          recordThreadExecutionOptions({
            threadId,
            options: execOpts,
          });

          const providerThreadId = requireProviderThreadId(threadId);

          const adapterCommand: AdapterCommand = {
            type: "turn/steer",
            threadId,
            providerThreadId,
            expectedTurnId,
            input,
            clientRequestId,
            options: toProviderExecutionContext({
              envVars: resolvedEnvironment.envVars,
              execOpts,
              instructions,
            }),
          };

          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });

          try {
            await sendCommand({
              proc,
              message: cmd,
              resultSchema: ignoredJsonRpcResultSchema,
              recovery: {
                providerId: pid,
                providerThreadId: adapterCommand.providerThreadId,
                threadId,
              },
            });
            setThreadRuntimeConfig(threadId, {
              ...currentConfig,
              contributedEnv: resolvedContributedEnv,
              envVars: resolvedEnvironment.envVars,
              options: execOpts,
            });

            if (environmentChanged) {
              emitResolvedProviderEnvironment({
                droppedContributions: resolvedEnvironment.droppedContributions,
                entries: resolvedEnvironment.entries,
                providerThreadId,
                threadId,
              });
            }
          } catch (error) {
            if (
              error instanceof JsonRpcResponseError &&
              error.recovery?.kind === "staleTurn"
            ) {
              options.onStderr?.(
                `Dropping stale steer for thread "${threadId}": ${error.recovery.message}`,
                threadId,
              );
              turnState.clearStaleTurn(threadId, expectedTurnId);

              return {
                status: "stale",
                activeTurnId: turnState.getActiveTurnId(threadId),
              };
            }

            if (
              error instanceof JsonRpcResponseError &&
              error.code === BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN
            ) {
              turnState.clearStaleTurn(threadId, expectedTurnId);

              return {
                status: "stale",
                activeTurnId: turnState.getActiveTurnId(threadId),
              };
            }

            if (error instanceof JsonRpcRequestTimeoutError) {
              options.onStderr?.(
                `Steer for thread "${threadId}" on turn "${expectedTurnId}" timed out; its delivery is unconfirmed.`,
                threadId,
              );

              return { status: "unconfirmed" };
            }

            throw error;
          }

          return { status: "steered" };
        },
      });
    },

    async stopThread({ threadId }) {
      toolCalls.cancelThread(threadId);

      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const proc = requireProviderProcessForThread(threadId);
          const providerThreadId = requireProviderThreadId(threadId);
          const activeTurnId = turnState.getActiveTurnId(threadId);

          const adapterCommand: AdapterCommand = {
            type: "thread/stop",
            threadId,
            providerThreadId,
            activeTurnId,
          };

          const cmd = proc.adapter.buildCommandPlan(adapterCommand);

          if (cmd.kind === "noop") {
            if (activeTurnId) {
              throw new Error(
                `Adapter "${pid}" returned no provider request for thread/stop with active turn: ${cmd.reason}`,
              );
            }

            forgetThreadRuntimeStateForProviderState(
              proc.identity,
              threadId,
              "thread-stopped",
            );
            await releaseIdleProviderProcess(proc);

            return { providerCheckpointId: null };
          }

          const result = await sendCommand({
            proc,
            message: cmd,
            resultSchema: providerThreadStopResultSchema,
          });

          forgetThreadRuntimeStateForProviderState(
            proc.identity,
            threadId,
            "thread-stopped",
          );
          await releaseIdleProviderProcess(proc);

          return {
            providerCheckpointId: result.providerCheckpointId ?? null,
          };
        },
      });
    },

    async setThreadSpeed({ threadId, serviceTier }) {
      const proc = requireProviderProcessForThread(threadId);

      const command: AdapterCommand = {
        type: "thread/speed/set",
        threadId,
        providerThreadId: requireProviderThreadId(threadId),
        serviceTier,
      };

      const message = requireProviderRequestPlan({
        commandType: command.type,
        plan: proc.adapter.buildCommandPlan(command),
        providerId: threadIdentityRegistry.resolveProviderForThread(threadId),
      });

      await sendCommand({
        proc,
        message,
        resultSchema: ignoredJsonRpcResultSchema,
      });
    },

    async clearThreadGoal({ threadId }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const proc = requireProviderProcessForThread(threadId);

          const adapterCommand: AdapterCommand = {
            type: "thread/goal/clear",
            threadId,
            providerThreadId: requireProviderThreadId(threadId),
          };

          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });

          const clearRevision = threadGoalState.getClearRevision(threadId);

          const result = await sendCommand({
            proc,
            message: cmd,
            resultSchema: threadGoalClearResultSchema,
          });

          if (
            !result.cleared &&
            threadGoalState.getClearRevision(threadId) > clearRevision
          ) {
            return { cleared: true };
          }

          const confirmed = await threadGoalState.waitForGoalClear({
            afterRevision: clearRevision,
            threadId,
            timeoutMs: THREAD_GOAL_CLEAR_EVENT_TIMEOUT_MS,
          });

          return { cleared: confirmed };
        },
      });
    },

    async renameThread({ threadId, title }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const proc = requireProviderProcessForThread(threadId);

          if (!proc.adapter.capabilities.supportsThreadRename) {
            throw new Error(
              `Provider "${pid}" does not support thread rename.`,
            );
          }

          const adapterCommand: AdapterCommand = {
            type: "thread/name/set",
            threadId,
            providerThreadId: requireProviderThreadId(threadId),
            title: toProviderExternalThreadName(title),
          };

          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });

          await sendCommand({
            proc,
            message: cmd,
            resultSchema: ignoredJsonRpcResultSchema,
            recovery: {
              providerId: pid,
              providerThreadId: adapterCommand.providerThreadId,
              threadId,
            },
          });
        },
      });
    },

    async archiveThread({
      threadId,
      providerId,
      providerThreadId,
      bridgeLaunch,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          await archiveOrUnarchiveThread({
            bridgeLaunch,
            commandType: "thread/archive",
            providerId,
            providerThreadId,
            threadId,
          });
        },
      });
    },

    async unarchiveThread({
      threadId,
      providerId,
      providerThreadId,
      bridgeLaunch,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          await archiveOrUnarchiveThread({
            bridgeLaunch,
            commandType: "thread/unarchive",
            providerId,
            providerThreadId,
            threadId,
          });
        },
      });
    },

    async listModels({ providerId, bridgeLaunch, cwd, contributedEnv = [] }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });

      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });

      const envVars = resolveModelListEnvVars(
        contributedEnv,
        options.shellEnv?.OMNYO_SERVER_URL,
      );

      const command = requireProviderRequestPlan({
        commandType: "model/list",
        plan: proc.adapter.buildCommandPlan({
          type: "model/list",
          ...(cwd !== undefined ? { cwd } : {}),
          ...(envVars === null ? {} : { envVars }),
        }),
        providerId,
      });

      const result = await sendCommand({
        proc,
        message: command,
        resultSchema: ignoredJsonRpcResultSchema,
      });

      return proc.adapter.parseModelListResult(result);
    },

    async providerHealth({ providerId, bridgeLaunch, cwd }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });

      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });

      const plan = proc.adapter.buildCommandPlan({
        type: "provider/health",
        ...(cwd !== undefined ? { cwd } : {}),
      });

      if (plan.kind === "noop") {
        return { supported: false };
      }

      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerHealthResultSchema,
      });
    },

    async providerUsage({ providerId, bridgeLaunch, cwd }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });

      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });

      const plan = proc.adapter.buildCommandPlan({
        type: "provider/usage",
        ...(cwd !== undefined ? { cwd } : {}),
      });

      if (plan.kind === "noop") {
        return { supported: false };
      }

      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerUsageResultSchema,
      });
    },

    async providerInstallationStatus({
      providerId,
      bridgeLaunch,
      cwd,
      requirement,
      checkUpdates = true,
    }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });

      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });

      const plan = requireProviderRequestPlan({
        commandType: "provider/installation/status",
        plan: proc.adapter.buildCommandPlan({
          type: "provider/installation/status",
          checkUpdates,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(requirement !== undefined ? { requirement } : {}),
        }),
        providerId,
      });

      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerInstallationStatusSchema,
      });
    },

    async providerInstallationRun({ providerId, bridgeLaunch, cwd, action }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });

      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });

      const plan = requireProviderRequestPlan({
        commandType: "provider/installation/run",
        plan: proc.adapter.buildCommandPlan({
          type: "provider/installation/run",
          action,
          ...(cwd !== undefined ? { cwd } : {}),
        }),
        providerId,
      });

      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerInstallationRunResultSchema,
      });
    },

    listRunningProviders() {
      return providerProcesses.listRunningProviders();
    },

    getActiveTurnId(threadId) {
      return turnState.getActiveTurnId(threadId);
    },

    waitForActiveTurn(threadId, args) {
      if (!threadMayStartTurn(threadId)) {
        return Promise.resolve(null);
      }

      return turnState.waitForActiveTurn({
        threadId,
        timeoutMs: args.timeoutMs,
      });
    },

    getProviderSession(threadId) {
      return threadIdentityRegistry.getProviderSession(threadId);
    },

    async reapIdleProviderSessions({ idleForMs, nowMs, runThreadExclusive }) {
      const reapedSessions: ReapedIdleProviderSession[] = [];
      const retainedSessions: RetainedProviderSession[] = [];

      for (const threadId of [...threadRuntimeConfigs.keys()]) {
        const release = async (): Promise<ReapedIdleProviderSession | null> => {
          const inspection = findReapableIdleProviderSession({
            idleForMs,
            nowMs,
            threadId,
          });

          if ("retained" in inspection) {
            retainedSessions.push(inspection.retained);

            return null;
          }

          const { candidate } = inspection;

          const retain = (reason: RetainedProviderSessionReason) =>
            retainedSessions.push({
              threadId,
              providerId: candidate.runtimeConfig.providerId,
              processId: candidate.processId,
              idleForMs: Math.max(0, nowMs - candidate.idleSinceMs),
              reason,
            });

          try {
            providerProcesses.requireProviderProcess({
              processKey: candidate.runtimeConfig.processKey,
              providerId: candidate.runtimeConfig.providerId,
            });
          } catch {
            retain("provider-unavailable");

            return null;
          }

          if (backgroundWorkState.hasOpenThreadWork(candidate.threadId)) {
            retain("background-work");

            return null;
          }

          try {
            await runtime.stopThread({ threadId: candidate.threadId });
          } catch (error) {
            retain("release-failed");
            options.onStderr?.(
              `Provider session release failed for ${candidate.threadId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );

            return null;
          }

          return {
            idleForMs: Math.max(0, nowMs - candidate.idleSinceMs),
            providerId: candidate.runtimeConfig.providerId,
            providerThreadId: candidate.providerThreadId,
            threadId: candidate.threadId,
          };
        };

        const reaped = runThreadExclusive
          ? await runThreadExclusive(threadId, release)
          : await release();

        if (reaped) {
          reapedSessions.push(reaped);
        }
      }

      return { reapedSessions, retainedSessions };
    },

    hasThread(threadId) {
      return threadIdentityRegistry.getProviderSession(threadId) !== null;
    },

    getLiveThreadIds() {
      return [
        ...new Set([
          ...turnState.getActiveThreadIds(),
          ...pendingTurnStarts.keys(),
        ]),
      ];
    },

    hasOpenBackgroundWork() {
      return backgroundWorkState.hasOpenWork();
    },

    listOpenBackgroundWork() {
      return backgroundWorkState.listOpenWork();
    },

    async shutdown() {
      turnStartWatchdogStopped = true;
      refreshTurnStartWatchdog();
      await Promise.all(
        [...stagedThreadRewinds.keys()].map((leaseId) =>
          discardStagedThreadRewind(leaseId),
        ),
      );
      idleProviderSessionSinceMsByThreadId.clear();
      pendingTurnStarts.clear();
      threadOperationCounts.clear();
      threadGoalState.clear();
      turnState.clear();
      backgroundWorkState.clear();
      threadEventGrammar.clear();
      await providerProcesses.shutdown();
    },
  };

  return runtime;
}
