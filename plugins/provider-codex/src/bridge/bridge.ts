#!/usr/bin/env node

import { selectedSkillMentions } from "../selected-skill-mentions.js";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveCodexHome } from "../codex-home.js";
import { isDeepStrictEqual } from "node:util";
import {
  isStandaloneBuiltinCompactCommand,
  type DynamicTool,
  type PromptInput,
  type ThreadDelta,
  type ProviderRateLimitState,
  sanitizeInheritedChildProcessEnv,
  buildShellEnvOverrides,
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  initializeParamsSchema,
  modelListParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  skillsConfigureParamsSchema,
  threadArchiveParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadGoalClearParamsSchema,
  threadSpeedSetParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadUnarchiveParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeExecutionOptions,
  type InitializeResult,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  decodeBridgeJsonRpcResponse,
  runBridgeRequest,
  withoutBridgeRuntimeEnv,
  type BridgeJsonRpcResponse,
  type DecodedInteractiveRequest,
  type PreparedProviderCommandDispatch,
  type ProviderRuntimeEvent,
  experimental_defineProviderBridge,
  type ProviderRecoveryHint,
} from "@omnyo/plugin-sdk/provider-bridge";
import { z } from "zod";
import { listPooledModelCatalog } from "./pool-model-list.js";
import {
  CODEX_MACOS_PERMISSION_EXTENSION_KIND,
  summarizeCodexMacOsPermissions,
} from "../extension-kinds.js";
import {
  buildCodexInteractiveResult,
  decodeCodexInteractiveRequest,
  extractCodexMacOsPermissionRequest,
  type CodexMacOsPermissionRequest,
} from "../interactive-requests.js";
import {
  CODEX_DAYBREAK_OPTION_ID,
  cyberProgramForTurn,
  isDaybreakAliasModel,
  parseModelCatalog,
  type CodexCyberProgram,
  type CodexModelCatalog,
} from "../models.js";
import { resolveCodexMcpElicitationAppIcon } from "../mcp-elicitation-host.js";
import { macOsPermissionPresentation } from "../presentation.js";
import {
  codexTurnSchema,
  codexRateLimitReadResponseSchema,
} from "../schemas.js";
import {
  codexSupportsAgentsEnabled,
  codexWorkspaceProfile,
  codexPermissionProfileListSchema,
  codexSandboxConfigSchema,
  codexSandboxRequirementsSchema,
  resolveCodexSandboxControl,
  type CodexSandboxControl,
  resolveCodexInstructionOverrides,
  toCodexDynamicTools,
  toCodexPermissionSettings,
  toCodexServiceTier,
  toCodexUserInput,
  type OmnyoThreadForkParams,
  type OmnyoThreadStartParams,
  type CodexSessionOptions,
} from "../session-params.js";
import type { ThreadResumeParams } from "../generated/codex-app-server/schema/v2/ThreadResumeParams.js";
import {
  digestInstructionSections,
  InstructionContextStore,
  instructionRefreshMessage,
  sameInstructionSections,
  type InstructionSectionDigests,
} from "./instruction-refresh.js";
import {
  createCodexEventTranslator,
  type CodexEventTranslator,
} from "../translator.js";
import {
  createCodexAppServerConnection,
  CodexAppServerExitedError,
  CodexAppServerRpcError,
  type CodexAppServerConnection,
  type CodexAppServerExitInfo,
  type CodexAppServerRequestResponder,
} from "./app-server-connection.js";
import {
  getCodexProviderHealth,
  getCodexProviderInstallationRun,
  getCodexProviderInstallationStatus,
  getCodexProviderUsage,
} from "./provider-maintenance.js";
import {
  SUBAGENT_UNLOAD_DELAY_SECS,
  SubAgentUnloader,
} from "./subagent-unload.js";

type OmnyoThreadResumeParams = ThreadResumeParams & {
  excludeTurns: boolean;
  permissions?: string | null;
};

const codexBridgeCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({ method: z.literal("model/list"), params: modelListParamsSchema }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: threadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: threadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: threadForkParamsSchema,
  }),
  z.object({
    method: z.literal("thread/speed/set"),
    params: threadSpeedSetParamsSchema,
  }),
  z.object({ method: z.literal("turn/start"), params: turnStartParamsSchema }),
  z.object({ method: z.literal("turn/steer"), params: turnSteerParamsSchema }),
  z.object({
    method: z.literal("thread/stop"),
    params: threadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: threadDiscardParamsSchema,
  }),
  z.object({
    method: z.literal("thread/name/set"),
    params: threadNameSetParamsSchema,
  }),
  z.object({
    method: z.literal("thread/archive"),
    params: threadArchiveParamsSchema,
  }),
  z.object({
    method: z.literal("thread/unarchive"),
    params: threadUnarchiveParamsSchema,
  }),
  z.object({
    method: z.literal("thread/goal/clear"),
    params: threadGoalClearParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

type CodexBridgeCommand = z.infer<typeof codexBridgeCommandSchema>;

const codexBridgeCommandMethodValues = codexBridgeCommandSchema.options.map(
  (option) => option.shape.method.value,
);

type DecodedCodexBridgeRequest =
  | { kind: "request"; request: CodexBridgeCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodeCodexBridgeJsonRpcRequest(
  raw: unknown,
): DecodedCodexBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);

  if (!envelope.success) {
    return { kind: "ignored" };
  }

  const command = codexBridgeCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });

  if (command.success) {
    return {
      kind: "request",
      request: { ...command.data, id: envelope.data.id },
    };
  }

  if (
    !(codexBridgeCommandMethodValues as readonly string[]).includes(
      envelope.data.method,
    )
  ) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method,
    };
  }

  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  };
}

interface BridgeNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface BridgeRuntimeRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const { send, sendResult, sendError } = createBridgeIo<
  BridgeNotification | BridgeRuntimeRequest
>();

function sendNotification(
  method: string,
  params: Record<string, unknown>,
): void {
  send({ jsonrpc: "2.0", method, params });
}

const pendingRuntimeRequests = new Map<
  number,
  (response: BridgeJsonRpcResponse) => void
>();

let runtimeRequestIdCounter = 0;

function sendRuntimeRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  runtimeRequestIdCounter += 1;
  const requestId = runtimeRequestIdCounter;

  const responsePromise = new Promise<unknown>(
    (resolveResponse, rejectResponse) => {
      pendingRuntimeRequests.set(requestId, (response) => {
        if ("error" in response) {
          rejectResponse(
            new Error(response.error.message ?? "Runtime request failed"),
          );

          return;
        }

        resolveResponse(response.result);
      });
    },
  );

  send({ jsonrpc: "2.0", id: requestId, method, params });

  return responsePromise;
}

const CODEX_APP_SERVER_COMMAND_ENV = "OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND";

const CODEX_APP_SERVER_ARGS_ENV = "OMNYO_CODEX_BRIDGE_APP_SERVER_ARGS";

const CODEX_POOL_BASE_URL_ENV = "CODEX_OPENAI_BASE_URL";

const CODEX_POOL_AUTH_TOKEN_ENV = "CODEX_POOL_AUTH_TOKEN";

const CODEX_HOME_ENV = "CODEX_HOME";

const APP_SERVER_LAUNCH_ENV_NAMES = [
  CODEX_POOL_BASE_URL_ENV,
  CODEX_POOL_AUTH_TOKEN_ENV,
  CODEX_HOME_ENV,
] as const;

const APP_SERVER_PROCESS_CONTROL_ENV_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "ZDOTDIR",
  "SHELLOPTS",
  "BASHOPTS",
  "ELECTRON_RUN_AS_NODE",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "SSLKEYLOGFILE",
  "REQUESTS_CA_BUNDLE",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
  "AWS_CA_BUNDLE",
]);

const CODEX_POOL_MODEL_PROVIDER = "omnyo-account-pool";

const LEGACY_POOL_MODEL_PROVIDER_V1 = "bb-account-pool";

const CODEX_DEFAULT_MODEL_PROVIDER = "openai";

interface LegacyPoolProviderAdmissionV1 {
  version: 1;
  nativeThreadId: string;
  provider: typeof LEGACY_POOL_MODEL_PROVIDER_V1;
}

function codexPoolProvider(
  env: NodeJS.ProcessEnv,
): typeof CODEX_POOL_MODEL_PROVIDER | null {
  return env[CODEX_POOL_BASE_URL_ENV] && env[CODEX_POOL_AUTH_TOKEN_ENV]
    ? CODEX_POOL_MODEL_PROVIDER
    : null;
}

const CODEX_INITIALIZE_PARAMS = {
  clientInfo: { name: "omnyo", version: "1.0.0", title: null },
  capabilities: { experimentalApi: true },
};

const CHILD_REQUEST_TIMEOUT_MS = 60_000;

const RATE_LIMIT_RECOVERY_TIMEOUT_MS = 5_000;

const INTERRUPT_SETTLEMENT_TIMEOUT_MS = 5_000;

const CODEX_ARCHIVED_SESSION_ERROR_PATTERN =
  /\b(?:session|thread)\s+\S+\s+is archived\b/i;

const CODEX_ACTIVE_WRITER_ERROR_PATTERN =
  /\bthread\s+\S+\s+already has an active writer\b/i;

const CODEX_ACTIVE_WRITER_RETRY_DELAYS_MS = [100, 400, 1_000] as const;

const CODEX_ALREADY_ARCHIVED_ERROR_PATTERN =
  /\bno rollout found for thread id\b/i;

const CODEX_NOT_ARCHIVED_ERROR_PATTERN =
  /\bno archived rollout found for thread id\b/i;

const CODEX_EMPTY_ROLLOUT_RENAME_ERROR_PATTERN = /\brollout at .+ is empty\b/i;

const CODEX_RENAME_RETRY_DELAYS_MS = [50, 200] as const;

const CODEX_AUTH_REQUIRED_TEXT_PATTERN =
  /\b(?:40[13]|auth(?:entication|orization)?|unauthori[sz]ed)\b/i;

const CODEX_RATE_LIMITED_TEXT_PATTERN =
  /\b(?:429|credits?|quota|rate[-\s]?limit(?:ed)?|usage limit)\b/i;

function classifyTerminalAccountError(
  delta: Extract<ThreadDelta, { kind: "provider.error" }>,
): "authRequired" | "rateLimited" | null {
  const category = delta.errorInfo?.category;

  if (category === "unauthorized") {
    return "authRequired";
  }

  if (category === "rate-limit") {
    return "rateLimited";
  }

  if (category !== undefined && category !== "unknown") {
    return null;
  }

  const text = [delta.message, delta.detail]
    .filter((part) => part !== undefined)
    .join("\n");

  if (CODEX_AUTH_REQUIRED_TEXT_PATTERN.test(text)) {
    return "authRequired";
  }

  if (CODEX_RATE_LIMITED_TEXT_PATTERN.test(text)) {
    return "rateLimited";
  }

  return null;
}

function archivedSessionHint(message: string): ProviderRecoveryHint | null {
  return CODEX_ARCHIVED_SESSION_ERROR_PATTERN.test(message)
    ? { kind: "sessionArchived", message, retryable: true }
    : null;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const MISSING_CODEX_CLI_GUIDANCE =
  "Omnyo could not find the Codex CLI on this machine. Install Codex (https://developers.openai.com/codex/cli) or put `codex` on PATH, then retry.";

export function resolveAppServerLaunch(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  return resolveSessionAppServerLaunch(env, null);
}

function resolveSessionAppServerLaunch(
  env: NodeJS.ProcessEnv,
  legacyAdmission: LegacyPoolProviderAdmissionV1 | null,
): { command: string; args: string[] } {
  const command = env[CODEX_APP_SERVER_COMMAND_ENV];
  const rawArgs = env[CODEX_APP_SERVER_ARGS_ENV];

  const args = [
    ...(command
      ? rawArgs
        ? z.array(z.string()).parse(JSON.parse(rawArgs))
        : []
      : ["app-server"]),
    "-c",
    `thread_unload_delay_secs=${SUBAGENT_UNLOAD_DELAY_SECS}`,
    "-c",
    "features.step_model_switching=true",
  ];

  const poolBaseUrl = env[CODEX_POOL_BASE_URL_ENV];
  const currentPoolProvider = codexPoolProvider(env);

  if (currentPoolProvider === null) {
    if (legacyAdmission !== null) {
      throw new Error(
        "The saved session requires the configured Account Pool route.",
      );
    }

    return { command: command ?? "codex", args };
  }

  const poolProvider = legacyAdmission?.provider ?? currentPoolProvider;

  return {
    command: command ?? "codex",
    args: [
      ...args,
      "-c",
      `openai_base_url=${JSON.stringify(poolBaseUrl)}`,
      "-c",
      `model_provider=${JSON.stringify(poolProvider)}`,
      "-c",
      `model_providers.${poolProvider}.name="OpenAI"`,
      "-c",
      `model_providers.${poolProvider}.base_url=${JSON.stringify(poolBaseUrl)}`,
      "-c",
      `model_providers.${poolProvider}.wire_api="responses"`,
      "-c",
      `model_providers.${poolProvider}.requires_openai_auth=true`,
      "-c",
      `model_providers.${poolProvider}.supports_websockets=false`,
      "-c",
      `model_providers.${poolProvider}.env_http_headers.x-omnyo-account-pool-token="CODEX_POOL_AUTH_TOKEN"`,
    ],
  };
}

function appServerLaunchEnv(
  envVars: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const name of APP_SERVER_LAUNCH_ENV_NAMES) {
    const value = envVars?.[name];

    if (value !== undefined) env[name] = value;
  }

  return env;
}

function buildAppServerEnv(
  envVars: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env = appServerLaunchEnv(envVars);

  for (const [name, value] of Object.entries(buildShellEnvOverrides(envVars))) {
    const normalized = name.toUpperCase();

    if (
      APP_SERVER_PROCESS_CONTROL_ENV_NAMES.has(normalized) ||
      normalized.startsWith("LD_") ||
      normalized.startsWith("DYLD_") ||
      normalized.startsWith("CODEX_") ||
      normalized.startsWith("OPENAI_") ||
      normalized.startsWith("NODE_") ||
      normalized.startsWith("SSL_") ||
      normalized.startsWith("OPENSSL_") ||
      normalized.startsWith("CURL_") ||
      normalized.endsWith("_PROXY")
    )
      continue;
    env[name] = value;
  }

  return withoutBridgeRuntimeEnv(sanitizeInheritedChildProcessEnv({ env }));
}

function isCodexSpawnFailure(error: unknown): boolean {
  return error instanceof CodexAppServerExitedError && error.spawnFailed;
}

function describeCodexLaunchError(error: unknown): string {
  if (isCodexSpawnFailure(error)) {
    return MISSING_CODEX_CLI_GUIDANCE;
  }

  return error instanceof Error ? error.message : String(error);
}

interface CodexSessionConstruction {
  cwd: string;
  instructionMode: "append" | "replace";
  dynamicTools: DynamicTool[] | undefined;
}

interface ResponseOpenedTurn {
  nativeStarted: boolean;
  waiters: Array<(started: boolean) => void>;
}

const codexTurnNotificationPeekSchema = z
  .object({
    threadId: z.string(),
    turn: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough();

interface UnopenedDispatch {
  clientRequestId: TurnStartParamsShape["clientRequestId"];
  prepared: PreparedProviderCommandDispatch;
}

interface PendingCompactionDispatch extends UnopenedDispatch {
  accepted: boolean;
  outcome: UnopenedDispatchOutcome | null;
}

type UnopenedDispatchOutcome =
  | { status: "completed" }
  | { status: "failed"; error: { message: string } };

const codexThreadStatusChangedParamsSchema = z
  .object({
    threadId: z.string(),
    status: z.object({ type: z.string() }).passthrough(),
  })
  .passthrough();

interface CodexBridgeSession {
  appThreadId: string;
  codexThreadId: string | null;
  serial: number;
  connection: CodexAppServerConnection | null;
  translator: CodexEventTranslator;
  construction: CodexSessionConstruction;
  constructionSignature: string;
  configuredInstructions: InstructionSectionDigests;
  instructionsInContext: InstructionSectionDigests | null;
  environmentHash: string;
  legacyPoolProviderAdmissionV1: LegacyPoolProviderAdmissionV1 | null;
  turnPermissionSettings: ReturnType<typeof toCodexPermissionSettings>;
  sandboxControl: CodexSandboxControl;
  openCodexTurnIds: Set<string>;
  codexThreadIdsByTurnId: Map<string, string>;
  responseOpenedTurns: Map<string, ResponseOpenedTurn>;
  unopenedCompactionDispatches: PendingCompactionDispatch[];
  turnSettledWaiters: Map<string, Array<() => void>>;
  awaitingReplayedUsage: boolean;
  identityAnnounced: boolean;
  pendingPreIdentityDeltas: ThreadDelta[];
  turnRateLimits: ProviderRateLimitState | null;
  quotaRecoveryAttempted: boolean;
  quotaRecoveryAllowed: boolean;
  rebuildBeforeNextTurnReason: string | null;
  daybreakEnabled: boolean | null;
  modelCatalog: Promise<CodexModelCatalog | null> | null;
  publishedSessionOptions: string | null;
  closing: boolean;
  previousChildExit: Promise<void> | null;
  releasePromise: Promise<void> | null;
  subAgentUnloader: SubAgentUnloader;
}

function createSubAgentUnloader(
  session: () => CodexBridgeSession,
): SubAgentUnloader {
  return new SubAgentUnloader({
    mainThreadId: () => session().codexThreadId,
    connection: () => session().connection,
    isSubAgentOpen: (threadId) => session().translator.isSubAgentOpen(threadId),
    warn: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
}

const sessionsByOmnyoThreadId = new Map<string, CodexBridgeSession>();

const maintenanceConnections = new Set<CodexAppServerConnection>();

interface ModelListClient {
  connection: CodexAppServerConnection;
  clientVersion: string | null;
}

let modelListClient: ModelListClient | null = null;

let modelListConnectionPromise: Promise<ModelListClient> | null = null;

let modelListEnvKey = "[]";

let sessionSerialCounter = 0;

let configuredSkillExtraRoots: string[] | null = null;

let instructionContextStore: InstructionContextStore | null = null;

const codexCompactionItemSchema = z
  .object({
    threadId: z.string(),
    item: z.object({ type: z.literal("contextCompaction") }).passthrough(),
  })
  .passthrough();

async function readInstructionContext(
  codexThreadId: string,
): Promise<InstructionSectionDigests | null> {
  if (instructionContextStore === null) {
    return null;
  }

  try {
    return await instructionContextStore.read(codexThreadId);
  } catch (error) {
    process.stderr.write(
      `Could not read which Omnyo instructions codex thread ${codexThreadId} holds; its next turn resends them in full: ${describeCodexLaunchError(error)}\n`,
    );

    return null;
  }
}

async function recordInstructionContext(
  session: CodexBridgeSession,
  sections: InstructionSectionDigests,
): Promise<void> {
  session.instructionsInContext = sections;
  const codexThreadId = session.codexThreadId;

  if (instructionContextStore === null || codexThreadId === null) {
    return;
  }

  try {
    await instructionContextStore.write(codexThreadId, sections);
  } catch (error) {
    process.stderr.write(
      `Could not save which Omnyo instructions codex thread ${codexThreadId} holds: ${describeCodexLaunchError(error)}\n`,
    );
  }
}

async function refreshInstructionsBeforeTurn(
  session: CodexBridgeSession,
  connection: CodexAppServerConnection,
  codexThreadId: string,
  instructions: string | undefined,
): Promise<void> {
  if (session.construction.instructionMode !== "append") {
    return;
  }

  const message = instructionRefreshMessage(
    session.instructionsInContext,
    instructions,
  );

  if (message === null) {
    return;
  }

  try {
    await connection.request({
      method: "thread/inject_items",
      params: {
        threadId: codexThreadId,
        items: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: message }],
          },
        ],
      },
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    process.stderr.write(
      `Could not send updated Omnyo instructions to codex thread ${codexThreadId}; this turn keeps the earlier ones and the next turn retries: ${describeCodexLaunchError(error)}\n`,
    );

    return;
  }

  await recordInstructionContext(
    session,
    digestInstructionSections(instructions),
  );
}

const LEGACY_BRIDGE_MINTED_ID_PATTERN = /^bt[0-9a-f]{8}-\d+-/;

function stripLegacyBridgeIdPrefix(id: string): string {
  const match = LEGACY_BRIDGE_MINTED_ID_PATTERN.exec(id);

  return match ? id.slice(match[0].length) : id;
}

function currentSession(
  appThreadId: string,
  serial: number,
): CodexBridgeSession | undefined {
  const session = sessionsByOmnyoThreadId.get(appThreadId);

  if (!session || session.serial !== serial || session.closing) {
    return undefined;
  }

  return session;
}

function releaseSession(session: CodexBridgeSession): Promise<void> {
  if (session.releasePromise !== null) {
    return session.releasePromise;
  }

  session.closing = true;

  if (sessionsByOmnyoThreadId.get(session.appThreadId) === session) {
    sessionsByOmnyoThreadId.delete(session.appThreadId);
  }

  const previousChildExit = session.previousChildExit;
  session.previousChildExit = null;
  const currentChildExit = session.connection?.kill() ?? Promise.resolve();
  session.connection = null;

  const releasePromise =
    previousChildExit === null
      ? currentChildExit
      : Promise.all([previousChildExit, currentChildExit]).then(
          () => undefined,
        );

  session.releasePromise = releasePromise;

  return releasePromise;
}

const codexProviderOptionsSchema = z
  .object({
    memoryEnabled: z.boolean().optional(),
    providerSubagentsEnabled: z.boolean().optional(),
    additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
  })
  .passthrough();

interface DecodedCodexOptions {
  sessionOptions: CodexSessionOptions;
  additionalWorkspaceWriteRoots: string[];
  daybreak: boolean | null;
}

function decodeCodexOptions(
  options: BridgeExecutionOptions,
): DecodedCodexOptions {
  const decoded = codexProviderOptionsSchema.parse(
    options.providerOptions ?? {},
  );

  return {
    sessionOptions: {
      ...options,
      ...(decoded.memoryEnabled !== undefined
        ? { memoryEnabled: decoded.memoryEnabled }
        : {}),
      ...(decoded.providerSubagentsEnabled !== undefined
        ? { providerSubagentsEnabled: decoded.providerSubagentsEnabled }
        : {}),
    },
    additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots ?? [],
    daybreak: requestedDaybreak(options),
  };
}

function requestedDaybreak(options: BridgeExecutionOptions): boolean | null {
  const requested = options.sessionOptions?.[CODEX_DAYBREAK_OPTION_ID];

  return typeof requested === "boolean" ? requested : null;
}

function environmentHash(
  envVars: Readonly<Record<string, string>> | undefined,
): string {
  const entries = Object.entries(envVars ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function constructionSignature(
  cwd: string,
  sessionOptions: CodexSessionOptions,
  envHash: string,
): string {
  return JSON.stringify({
    cwd,
    reasoningLevel: sessionOptions.reasoningLevel ?? null,
    memoryEnabled: sessionOptions.memoryEnabled ?? null,
    providerSubagentsEnabled: sessionOptions.providerSubagentsEnabled ?? null,
    envHash,
  });
}

function sendThreadDeltas(
  session: CodexBridgeSession,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }

  const outDeltas: ThreadDelta[] = [];

  for (const delta of deltas) {
    if (delta.kind === "input.accepted") {
      session.unopenedCompactionDispatches =
        session.unopenedCompactionDispatches.filter(
          (dispatch) => dispatch.clientRequestId !== delta.clientRequestId,
        );
    }

    if (delta.kind === "provider.rateLimits") {
      session.turnRateLimits = delta.rateLimits;
    }

    if (delta.kind === "turn.open") {
      session.translator.resetRateLimits();
      session.turnRateLimits = null;
      session.quotaRecoveryAttempted = false;
      session.awaitingReplayedUsage = false;

      if (delta.providerTurnId !== undefined) {
        session.openCodexTurnIds.add(delta.providerTurnId);
      }
    }

    if (delta.kind === "turn.boundary" && delta.providerTurnId !== undefined) {
      session.openCodexTurnIds.delete(delta.providerTurnId);
      session.codexThreadIdsByTurnId.delete(delta.providerTurnId);
      settleResponseOpenedTurn(session, delta.providerTurnId);
      const waiters = session.turnSettledWaiters.get(delta.providerTurnId);

      if (waiters !== undefined) {
        session.turnSettledWaiters.delete(delta.providerTurnId);

        for (const resolve of waiters) {
          resolve();
        }
      }
    }

    if (session.awaitingReplayedUsage) {
      if (delta.kind === "usage") {
        continue;
      }

      if (delta.kind === "contextWindow") {
        const { providerTurnId: _replayedTurnId, ...threadScoped } = delta;
        outDeltas.push(threadScoped);
        continue;
      }
    }

    outDeltas.push(delta);
  }

  if (!session.identityAnnounced) {
    session.pendingPreIdentityDeltas.push(...outDeltas);

    return;
  }

  sendNotification(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId: session.appThreadId,
    deltas: outDeltas,
  });
}

function announceSessionIdentity(
  session: CodexBridgeSession,
  codexThreadId: string,
): void {
  if (session.codexThreadId === null) {
    session.codexThreadId = codexThreadId;
  }

  if (session.identityAnnounced) {
    return;
  }

  session.identityAnnounced = true;
  sendNotification(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: session.appThreadId,
    providerThreadId: codexThreadId,
    sessionRestorable: true,
  });
  const buffered = session.pendingPreIdentityDeltas;
  session.pendingPreIdentityDeltas = [];
  sendThreadDeltas(session, buffered);
}

const codexThreadStartedNotificationSchema = z
  .object({ thread: z.object({ id: z.string().min(1) }).passthrough() })
  .passthrough();

function toProviderRuntimeEvent(
  method: string,
  params: unknown,
): ProviderRuntimeEvent {
  return {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {}),
  } as ProviderRuntimeEvent;
}

async function handleChildNotification(
  appThreadId: string,
  serial: number,
  method: string,
  params: unknown,
): Promise<void> {
  const session = currentSession(appThreadId, serial);

  if (!session) {
    return;
  }

  if (method === "thread/started") {
    const parsed = codexThreadStartedNotificationSchema.safeParse(params);

    if (parsed.success) {
      announceSessionIdentity(session, parsed.data.thread.id);
    }
  }

  if (method === "thread/status/changed") {
    settleCompactionDispatchesWhenCodexIsNotRunning(session, params);
  }

  if (method === "item/completed") {
    const compaction = codexCompactionItemSchema.safeParse(params);

    if (
      compaction.success &&
      compaction.data.threadId === session.codexThreadId &&
      !sameInstructionSections(
        session.instructionsInContext ?? {},
        session.configuredInstructions,
      )
    ) {
      await recordInstructionContext(session, session.configuredInstructions);
    }
  }

  session.subAgentUnloader.observe(method, params);

  if (method === "turn/started") {
    const parsed = codexTurnNotificationPeekSchema.safeParse(params);

    if (parsed.success) {
      session.codexThreadIdsByTurnId.set(
        parsed.data.turn.id,
        parsed.data.threadId,
      );

      if (parsed.data.threadId === session.codexThreadId) {
        markResponseOpenedTurnNativelyStarted(session, parsed.data.turn.id);
      }
    }
  }

  const deltas = session.translator.translateEvent(
    toProviderRuntimeEvent(method, params),
  );

  const quotaFailure = deltas.some(
    (delta) =>
      delta.kind === "provider.error" &&
      delta.willRetry !== true &&
      delta.errorInfo?.category === "rate-limit",
  );

  const quota = session.turnRateLimits;

  const blockedWindows =
    quota?.windows.filter((window) => window.status === "blocked") ?? [];

  const quotaExplainsFailure =
    quota?.status === "blocked" &&
    (quota.kind !== "subscription-window" ||
      (blockedWindows.length > 0 &&
        blockedWindows.every(
          (window) =>
            window.resetsAtMs !== null && window.resetsAtMs > Date.now(),
        )));

  if (
    quotaFailure &&
    !quotaExplainsFailure &&
    !session.quotaRecoveryAttempted
  ) {
    session.quotaRecoveryAttempted = true;

    try {
      const snapshot =
        session.quotaRecoveryAllowed && session.connection !== null
          ? await session.connection.request({
              method: "account/rateLimits/read",
              params: { excludeResetCreditDetails: true },
              resultSchema: codexRateLimitReadResponseSchema,
              timeoutMs: RATE_LIMIT_RECOVERY_TIMEOUT_MS,
            })
          : null;

      if (currentSession(appThreadId, serial) !== session) return;
      sendThreadDeltas(session, session.translator.recoverRateLimits(snapshot));
    } catch {
      if (currentSession(appThreadId, serial) !== session) return;
      sendThreadDeltas(session, session.translator.recoverRateLimits(null));
    }

    if (currentSession(appThreadId, serial) !== session) return;
  }

  sendThreadDeltas(session, deltas);

  for (const delta of deltas) {
    if (delta.kind === "provider.error" && delta.willRetry !== true) {
      emitTerminalAccountErrorHint(session, delta);
    }
  }
}

function emitTerminalAccountErrorHint(
  session: CodexBridgeSession,
  delta: Extract<ThreadDelta, { kind: "provider.error" }>,
): void {
  const kind = classifyTerminalAccountError(delta);

  if (kind === null) {
    return;
  }

  const message = delta.detail ?? delta.message;
  session.rebuildBeforeNextTurnReason =
    kind === "authRequired"
      ? "codex session restarted after an authentication failure so a new login can take effect."
      : "codex session restarted after a rate limit so a refreshed account state can take effect.";
  sendNotification(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
    threadId: session.appThreadId,
    kind,
    message,
    retryable: false,
  });
}

const codexChildToolCallParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.union([z.string().min(1), z.null()]),
  callId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown(),
});

function handleChildRequest(
  appThreadId: string,
  serial: number,
  method: string,
  params: unknown,
  responder: CodexAppServerRequestResponder,
): void {
  const session = currentSession(appThreadId, serial);

  if (!session) {
    responder.error(
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      "codex session is no longer current",
    );

    return;
  }

  if (method === BRIDGE_INBOUND_REQUEST_METHODS.toolCall) {
    const parsed = codexChildToolCallParamsSchema.safeParse(params);

    if (!parsed.success) {
      responder.error(
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Invalid codex tool call params: ${parsed.error.message}`,
      );

      return;
    }

    void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.toolCall, {
      providerThreadId: session.codexThreadId ?? parsed.data.threadId,
      threadId: session.appThreadId,
      turnId: parsed.data.turnId,
      callId: parsed.data.callId,
      tool: parsed.data.tool,
      arguments: parsed.data.arguments ?? {},
    })
      .then((result) => {
        responder.result(result);
      })
      .catch((error: unknown) => {
        responder.error(
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      });

    return;
  }

  const macOsPermission = extractCodexMacOsPermissionRequest({
    id: 0,
    method,
    params,
  });

  if (macOsPermission !== null) {
    sendThreadDeltas(session, [buildMacOsPermissionItemDelta(macOsPermission)]);
  }

  let decoded: DecodedInteractiveRequest | null;

  try {
    decoded = decodeCodexInteractiveRequest({ id: 0, method, params });
  } catch (error) {
    responder.error(
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      error instanceof Error ? error.message : String(error),
    );

    return;
  }

  if (decoded === null) {
    responder.error(
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unhandled codex request "${method}"`,
    );

    return;
  }

  void resolveCodexMcpElicitationAppIcon(decoded)
    .then(async (request) => {
      if (currentSession(appThreadId, serial) !== session) {
        throw new Error("codex session is no longer current");
      }

      const [runtimeResult] = await Promise.allSettled([
        sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
          providerThreadId: session.codexThreadId ?? request.providerThreadId,
          threadId: session.appThreadId,
          turnId: request.turnId,
          payload: request.payload,
        }),
      ]);

      responder.result(
        buildCodexInteractiveResult(request.payload, runtimeResult),
      );
    })
    .catch((error: unknown) => {
      responder.error(
        BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    });
}

function buildMacOsPermissionItemDelta(
  request: CodexMacOsPermissionRequest,
): ThreadDelta {
  return {
    kind: "item.close",
    key: {
      providerItemId: `${request.item.approvalItemId}:macos-permission`,
    },
    status: "completed",
    item: {
      type: "extension",
      kind: CODEX_MACOS_PERMISSION_EXTENSION_KIND,
      payload: request.item,
    },
    presentation: macOsPermissionPresentation(
      summarizeCodexMacOsPermissions(request.item.permissions),
    ),
    providerTurnId: request.turnId,
  };
}

function handleChildExit(
  appThreadId: string,
  serial: number,
  info: CodexAppServerExitInfo,
): void {
  const session = currentSession(appThreadId, serial);

  if (!session) {
    return;
  }

  session.connection = null;

  const openTurnIds = [...session.openCodexTurnIds];
  const message = `codex app-server exited unexpectedly (code ${info.code ?? "null"}, signal ${info.signal ?? "null"})${info.stderrTail ? `: ${info.stderrTail}` : ""}`;
  sendThreadDeltas(
    session,
    openTurnIds.map((codexTurnId) => ({
      kind: "turn.boundary",
      providerTurnId: codexTurnId,
      status: "failed",
      error: { message },
    })),
  );
  session.openCodexTurnIds.clear();
  session.codexThreadIdsByTurnId.clear();

  for (const codexTurnId of [...session.responseOpenedTurns.keys()]) {
    settleResponseOpenedTurn(session, codexTurnId);
  }

  const unopenedCompactions = session.unopenedCompactionDispatches;
  session.unopenedCompactionDispatches = [];

  for (const dispatch of unopenedCompactions) {
    if (!dispatch.accepted) continue;
    settleUnopenedDispatch(session, dispatch, {
      status: "failed",
      error: { message },
    });
  }

  sendNotification(BRIDGE_NOTIFICATION_METHODS.error, {
    threadId: session.appThreadId,
    ...(session.codexThreadId !== null
      ? { providerThreadId: session.codexThreadId }
      : {}),
    message,
  });

  if (session.codexThreadId !== null) {
    sendThreadDeltas(
      session,
      session.translator.clearExitedChildThreadState({
        providerThreadId: session.codexThreadId,
      }),
    );
  }
}

function spawnChildConnection(callbacks: {
  legacyPoolProviderAdmissionV1?: LegacyPoolProviderAdmissionV1;
  envVars?: Readonly<Record<string, string>>;
  recordThreadId: string | null;
  onNotification: (method: string, params: unknown) => void;
  onRequest: (
    method: string,
    params: unknown,
    responder: CodexAppServerRequestResponder,
  ) => void;
  onExit: (info: CodexAppServerExitInfo) => void;
}): CodexAppServerConnection {
  const env = buildAppServerEnv(callbacks.envVars);
  const threadStorage = callbacks.envVars?.OMNYO_THREAD_STORAGE;

  if (callbacks.recordThreadId !== null && threadStorage !== undefined) {
    env.OMNYO_THREAD_ID = callbacks.recordThreadId;
    env.OMNYO_THREAD_STORAGE = threadStorage;
  }

  const launch = resolveSessionAppServerLaunch(
    appServerLaunchEnv(callbacks.envVars),
    callbacks.legacyPoolProviderAdmissionV1 ?? null,
  );

  const {
    envVars: _envVars,
    legacyPoolProviderAdmissionV1: _legacyAdmission,
    ...connectionCallbacks
  } = callbacks;

  return createCodexAppServerConnection({
    command: launch.command,
    args: launch.args,
    cwd: process.cwd(),
    env,
    ...connectionCallbacks,
  });
}

const ignoredChildResultSchema = z.unknown();

const childInitializeResultSchema = z
  .object({
    userAgent: z.string().optional(),
  })
  .catch({});

interface InitializedChild {
  clientVersion: string | null;
  supportsAgentsEnabled: boolean;
}

async function initializeChild(
  connection: CodexAppServerConnection,
): Promise<InitializedChild> {
  const { userAgent } = await connection.request({
    method: "initialize",
    params: CODEX_INITIALIZE_PARAMS,
    resultSchema: childInitializeResultSchema,
    timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
  });

  if (configuredSkillExtraRoots !== null) {
    await connection.request({
      method: "skills/extraRoots/set",
      params: { extraRoots: configuredSkillExtraRoots },
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
  }

  return {
    clientVersion:
      userAgent?.match(/^\S+\/(\d+\.\d+\.\d+)(?:[-+]\S+)?(?:\s|$)/u)?.[1] ??
      null,
    supportsAgentsEnabled: codexSupportsAgentsEnabled(userAgent),
  };
}

const UNREAD_SANDBOX_CONTROL: CodexSandboxControl = {
  kind: "sandbox",
  workspaceNetworkAccess: false,
};

async function readCodexSandboxControl(
  connection: CodexAppServerConnection,
  cwd: string,
): Promise<CodexSandboxControl> {
  const [config, requirements] = await Promise.all([
    connection.request({
      method: "config/read",
      params: { cwd },
      resultSchema: codexSandboxConfigSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    }),
    connection.request({
      method: "configRequirements/read",
      resultSchema: codexSandboxRequirementsSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    }),
  ]);

  let profiles: z.infer<typeof codexPermissionProfileListSchema> | null = null;

  if (codexWorkspaceProfile({ config, requirements }) !== null) {
    profiles = { data: [] };
    const cursors = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const page = await connection.request({
        method: "permissionProfile/list",
        params: { cwd, ...(cursor === undefined ? {} : { cursor }) },
        resultSchema: codexPermissionProfileListSchema,
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      });

      profiles.data.push(...page.data);

      if (page.nextCursor == null) break;

      if (cursors.has(page.nextCursor))
        throw new Error("Codex permission profile pagination did not advance.");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  return resolveCodexSandboxControl({ config, requirements, profiles });
}

const codexThreadIdentityResultSchema = z
  .object({
    thread: z
      .object({
        id: z.string().min(1),
        daybreakEnabled: z.boolean().nullish().catch(null),
      })
      .passthrough(),
  })
  .passthrough();

const SESSION_OPTIONS_STATE_KIND = "core/session-options";

const SESSION_MODEL_CATALOG_TIMEOUT_MS = 10_000;

function loadModelCatalog(
  connection: CodexAppServerConnection,
  launchEnv: NodeJS.ProcessEnv,
  clientVersion: string | null,
  timeoutMs: number,
): Promise<CodexModelCatalog> {
  const baseUrl = launchEnv[CODEX_POOL_BASE_URL_ENV];
  const token = launchEnv[CODEX_POOL_AUTH_TOKEN_ENV];

  if (baseUrl && token) {
    return listPooledModelCatalog({ baseUrl, token, clientVersion });
  }

  return connection
    .request({
      method: "model/list",
      params: {},
      resultSchema: ignoredChildResultSchema,
      timeoutMs,
    })
    .then(parseModelCatalog);
}

function clearLegacyDaybreakState(session: CodexBridgeSession): void {
  if (session.closing) {
    return;
  }

  const payload = {
    options: [],
  };

  const serialized = JSON.stringify(payload);

  if (session.publishedSessionOptions === serialized) {
    return;
  }

  session.publishedSessionOptions = serialized;
  sendThreadDeltas(session, [
    {
      kind: "extension.state",
      extensionKind: SESSION_OPTIONS_STATE_KIND,
      payload,
    },
  ]);
}

async function saveDaybreakChoice(
  session: CodexBridgeSession,
  connection: CodexAppServerConnection,
  codexThreadId: string,
  daybreakEnabled: boolean,
): Promise<void> {
  session.daybreakEnabled = daybreakEnabled;
  await connection
    .request({
      method: "thread/metadata/update",
      params: { threadId: codexThreadId, daybreakEnabled },
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `codex thread/metadata/update could not save the Daybreak choice: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
}

async function resolveTurnCyberAccessProgram(
  session: CodexBridgeSession,
  connection: CodexAppServerConnection,
  codexThreadId: string,
  decoded: DecodedCodexOptions,
): Promise<CodexCyberProgram | null> {
  if (
    decoded.daybreak !== null &&
    decoded.daybreak !== session.daybreakEnabled
  ) {
    await saveDaybreakChoice(
      session,
      connection,
      codexThreadId,
      decoded.daybreak,
    );
  }

  const model = decoded.sessionOptions.model;

  if (
    model === undefined ||
    (!isDaybreakAliasModel(model) && session.daybreakEnabled === null)
  ) {
    return null;
  }

  const catalog = await session.modelCatalog;
  clearLegacyDaybreakState(session);

  if (catalog === null || !catalog.daybreakAvailable) {
    return null;
  }

  const programs = catalog.cyberProgramsByModel.get(model) ?? [];

  return cyberProgramForTurn(
    programs,
    isDaybreakAliasModel(model) || !programs.includes("standard"),
  );
}

async function requestThreadConstructionWithWriterRetry(
  connection: CodexAppServerConnection,
  method: string,
  params:
    | OmnyoThreadStartParams
    | OmnyoThreadResumeParams
    | OmnyoThreadForkParams,
): Promise<z.infer<typeof codexThreadIdentityResultSchema>> {
  const sendOnce = (): Promise<
    z.infer<typeof codexThreadIdentityResultSchema>
  > =>
    connection.request({
      method,
      params,
      resultSchema: codexThreadIdentityResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });

  for (const [
    retryIndex,
    retryDelayMs,
  ] of CODEX_ACTIVE_WRITER_RETRY_DELAYS_MS.entries()) {
    try {
      return await sendOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!CODEX_ACTIVE_WRITER_ERROR_PATTERN.test(message)) {
        throw error;
      }

      process.stderr.write(
        `codex ${method} found an active rollout writer; retrying in ${retryDelayMs}ms (${retryIndex + 1}/${CODEX_ACTIVE_WRITER_RETRY_DELAYS_MS.length}).\n`,
      );
      await delay(retryDelayMs);
    }
  }

  return await sendOnce();
}

const savedPoolThreadSchema = z.object({
  thread: z
    .object({
      id: z.string().min(1),
      modelProvider: z.string().min(1),
    })
    .passthrough(),
});

const legacyPoolThreadMetadataSchemaV1 = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  modelProvider: z.literal(LEGACY_POOL_MODEL_PROVIDER_V1),
  path: z.string().min(1),
  cwd: z.string().min(1),
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  source: z.literal("vscode"),
  forkedFromId: z.string().uuid().nullable(),
  parentThreadId: z.string().uuid().nullable(),
});

const legacyPoolSessionMetaSchemaV1 = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string().uuid(),
    session_id: z.string().uuid(),
    model_provider: z.literal(LEGACY_POOL_MODEL_PROVIDER_V1),
    originator: z.enum(["bb", "bb_composer_predictions"]),
    cli_version: z.string(),
    source: z.literal("vscode"),
    forked_from_id: z.string().uuid().nullish(),
    parent_thread_id: z.string().uuid().nullish(),
    cwd: z.string().min(1),
    runtime_workspace_roots: z.array(z.string().min(1)).optional(),
  }),
});

async function admitLegacyPoolProviderV1(
  metadata: unknown,
  nativeThreadId: string,
  env: NodeJS.ProcessEnv,
): Promise<LegacyPoolProviderAdmissionV1> {
  const parsed = legacyPoolThreadMetadataSchemaV1.safeParse(metadata);

  if (!parsed.success || parsed.data.id !== nativeThreadId) {
    throw new Error(
      "The saved session has unrecognized native provider metadata.",
    );
  }

  const saved = parsed.data;

  const [codexHome, nativePath] = await Promise.all([
    realpath(resolveCodexHome(homedir(), env)),
    realpath(saved.path),
  ]);

  const nativeRelativePath = relative(codexHome, nativePath);
  const segments = nativeRelativePath.split(sep);

  if (
    isAbsolute(nativeRelativePath) ||
    segments.includes("..") ||
    !["sessions", "archived_sessions"].includes(segments[0] ?? "") ||
    segments.length < 2
  ) {
    throw new Error("The saved session is outside its native history owner.");
  }

  const file = await open(nativePath, "r");
  let firstLine: unknown;

  try {
    if (!(await file.stat()).isFile()) {
      throw new Error(
        "The saved session metadata is not a regular native file.",
      );
    }

    const chunks: Buffer[] = [];
    let length = 0;

    while (length < 1024 * 1024) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, 1024 * 1024 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);

      if (bytesRead === 0) break;

      const data = chunk.subarray(0, bytesRead);
      const newline = data.indexOf(10);

      if (newline >= 0) {
        chunks.push(data.subarray(0, newline));

        try {
          firstLine = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new Error("The saved session has malformed native metadata.");
        }

        break;
      }

      chunks.push(data);
      length += bytesRead;
    }
  } finally {
    await file.close();
  }

  const imported = legacyPoolSessionMetaSchemaV1.safeParse(firstLine);

  if (
    !imported.success ||
    imported.data.payload.id !== saved.id ||
    imported.data.payload.session_id !== saved.sessionId ||
    imported.data.payload.cli_version !== saved.cliVersion ||
    (imported.data.payload.forked_from_id ?? null) !== saved.forkedFromId ||
    (imported.data.payload.parent_thread_id ?? null) !== saved.parentThreadId
  ) {
    throw new Error(
      "The saved session is not a recognized first-party V1 native history.",
    );
  }

  return {
    version: 1,
    nativeThreadId,
    provider: LEGACY_POOL_MODEL_PROVIDER_V1,
  };
}

type CodexSessionConstructionRequest =
  | { kind: "start" }
  | { kind: "resume"; providerThreadId: string }
  | {
      kind: "fork";
      sourceProviderThreadId: string;
      sourceProviderCheckpointId?: string;
    };

interface ConstructThreadSessionArgs {
  threadId: string;
  cwd: string;
  options: BridgeExecutionOptions;
  instructionMode: "append" | "replace";
  dynamicTools?: DynamicTool[];
  request: CodexSessionConstructionRequest;
}

interface ConstructedCodexSession {
  session: CodexBridgeSession;
  codexThreadId: string;
}

async function constructThreadSession(
  args: ConstructThreadSessionArgs,
): Promise<ConstructedCodexSession> {
  const existing = sessionsByOmnyoThreadId.get(args.threadId);
  const decoded = decodeCodexOptions(args.options);
  sessionSerialCounter += 1;
  const serial = sessionSerialCounter;

  const translator = createCodexEventTranslator({
    additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots,
  });

  translator.configureInjectedTools(
    (args.dynamicTools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.presentation === undefined
        ? {}
        : { presentation: tool.presentation }),
    })),
  );
  const launchEnv = appServerLaunchEnv(decoded.sessionOptions.envVars);

  const envHash = environmentHash(decoded.sessionOptions.envVars);

  const session: CodexBridgeSession = {
    appThreadId: args.threadId,
    codexThreadId:
      args.request.kind === "resume" ? args.request.providerThreadId : null,
    serial,
    connection: null,
    translator,
    construction: {
      cwd: args.cwd,
      instructionMode: args.instructionMode,
      dynamicTools: args.dynamicTools,
    },
    constructionSignature: constructionSignature(
      args.cwd,
      decoded.sessionOptions,
      envHash,
    ),
    configuredInstructions: digestInstructionSections(
      decoded.sessionOptions.instructions,
    ),
    instructionsInContext: null,
    environmentHash: envHash,
    legacyPoolProviderAdmissionV1: null,
    turnPermissionSettings: toCodexPermissionSettings({
      additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots,
      gitWritableRoots: [],
      options: decoded.sessionOptions,
      sandboxControl: UNREAD_SANDBOX_CONTROL,
    }),
    sandboxControl: UNREAD_SANDBOX_CONTROL,
    openCodexTurnIds: new Set(),
    codexThreadIdsByTurnId: new Map(),
    responseOpenedTurns: new Map(),
    unopenedCompactionDispatches: [],
    turnSettledWaiters: new Map(),
    awaitingReplayedUsage: args.request.kind !== "start",
    identityAnnounced: false,
    pendingPreIdentityDeltas: [],
    turnRateLimits: null,
    quotaRecoveryAttempted: false,
    quotaRecoveryAllowed: !(
      launchEnv[CODEX_POOL_BASE_URL_ENV] && launchEnv[CODEX_POOL_AUTH_TOKEN_ENV]
    ),
    rebuildBeforeNextTurnReason: null,
    daybreakEnabled: null,
    modelCatalog: null,
    publishedSessionOptions: existing?.publishedSessionOptions ?? null,
    closing: false,
    previousChildExit: null,
    releasePromise: null,
    subAgentUnloader: createSubAgentUnloader(() => session),
  };

  sessionsByOmnyoThreadId.set(args.threadId, session);

  if (existing) {
    const previousChildExit = releaseSession(existing);
    session.previousChildExit = previousChildExit;
    await previousChildExit;

    if (session.previousChildExit === previousChildExit) {
      session.previousChildExit = null;
    }

    if (session.closing) {
      throw new CodexSessionReleasedError(
        new Error(
          "codex session was released while waiting for the previous app-server to exit",
        ),
      );
    }
  }

  if (args.request.kind === "resume") {
    announceSessionIdentity(session, args.request.providerThreadId);
  }

  sendThreadDeltas(session, [{ kind: "session.reset" }]);

  let notifications = Promise.resolve();

  let readingSavedProvider =
    codexPoolProvider(launchEnv) !== null && args.request.kind !== "start";

  const createSessionConnection = (
    legacyAdmission: LegacyPoolProviderAdmissionV1 | null,
  ) =>
    spawnChildConnection({
      ...(legacyAdmission === null
        ? {}
        : { legacyPoolProviderAdmissionV1: legacyAdmission }),
      envVars: decoded.sessionOptions.envVars,
      recordThreadId: args.threadId,
      onNotification: (method, params) => {
        if (readingSavedProvider) return;

        notifications = notifications
          .then(() =>
            handleChildNotification(args.threadId, serial, method, params),
          )
          .catch((error: unknown) => {
            sendNotification(BRIDGE_NOTIFICATION_METHODS.error, {
              threadId: args.threadId,
              message: describeCodexLaunchError(error),
            });
          });
      },
      onRequest: (method, params, responder) => {
        if (readingSavedProvider) {
          responder.error(
            BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
            "Native metadata admission does not serve requests.",
          );

          return;
        }

        handleChildRequest(args.threadId, serial, method, params, responder);
      },
      onExit: (info) => {
        if (readingSavedProvider) return;

        void notifications.then(() =>
          handleChildExit(args.threadId, serial, info),
        );
      },
    });

  let connection = createSessionConnection(null);
  session.connection = connection;

  try {
    let { clientVersion, supportsAgentsEnabled } =
      await initializeChild(connection);

    if (readingSavedProvider && args.request.kind !== "start") {
      const nativeThreadId =
        args.request.kind === "resume"
          ? args.request.providerThreadId
          : args.request.sourceProviderThreadId;

      const metadata = await connection.request({
        method: "thread/read",
        params: { threadId: nativeThreadId, includeTurns: false },
        resultSchema: savedPoolThreadSchema,
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      });

      if (metadata.thread.id !== nativeThreadId) {
        throw new Error(
          "The saved session returned a different native identity.",
        );
      }

      if (metadata.thread.modelProvider === LEGACY_POOL_MODEL_PROVIDER_V1) {
        if (args.request.kind === "fork") {
          throw new Error(
            "This saved session cannot be forked with the current provider. Resume it to continue.",
          );
        }

        await connection.kill();
        session.connection = null;

        const admission = await admitLegacyPoolProviderV1(
          metadata.thread,
          nativeThreadId,
          buildAppServerEnv(decoded.sessionOptions.envVars),
        );

        if (session.closing) {
          throw new CodexSessionReleasedError(
            new Error(
              "The saved session was released during native metadata admission.",
            ),
          );
        }

        session.legacyPoolProviderAdmissionV1 = admission;
        connection = createSessionConnection(admission);
        session.connection = connection;
        ({ clientVersion, supportsAgentsEnabled } =
          await initializeChild(connection));
      } else if (
        metadata.thread.modelProvider !== CODEX_POOL_MODEL_PROVIDER &&
        !(
          args.request.kind === "fork" &&
          metadata.thread.modelProvider === CODEX_DEFAULT_MODEL_PROVIDER
        )
      ) {
        throw new Error(
          "The saved session provider does not match the configured Account Pool route.",
        );
      }

      readingSavedProvider = false;
    }

    if (session.closing) {
      throw new CodexSessionReleasedError(
        new Error(
          "The saved session was released during native metadata admission.",
        ),
      );
    }

    session.sandboxControl = await readCodexSandboxControl(
      connection,
      args.cwd,
    );

    const preparedGitRoots = translator.prepareWorkspaceWriteGitRoots({
      supportsAgentsEnabled,
      sandboxControl: session.sandboxControl,
      command: {
        threadId: args.threadId,
        cwd: args.cwd,
        options: decoded.sessionOptions,
      },
    });

    const dynamicTools = toCodexDynamicTools(args.dynamicTools);

    const instructionOverrides = resolveCodexInstructionOverrides({
      instructionMode: args.instructionMode,
      options: decoded.sessionOptions,
    });

    const poolProvider =
      session.legacyPoolProviderAdmissionV1?.provider ??
      codexPoolProvider(
        appServerLaunchEnv(decoded.sessionOptions.envVars ?? {}),
      );

    const sharedConstructionParams = {
      ...preparedGitRoots.permissionSettings,
      cwd: args.cwd,
      ...instructionOverrides,
      model: decoded.sessionOptions.model ?? undefined,
      serviceTier: toCodexServiceTier(decoded.sessionOptions.serviceTier),
      ...(poolProvider === null ? {} : { modelProvider: poolProvider }),
      config:
        poolProvider === null
          ? (preparedGitRoots.config ?? undefined)
          : {
              ...(preparedGitRoots.config ?? {}),
              model_provider: poolProvider,
            },
      ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
    };

    let method: string;

    let params:
      | OmnyoThreadStartParams
      | OmnyoThreadResumeParams
      | OmnyoThreadForkParams;

    switch (args.request.kind) {
      case "start": {
        method = "thread/start";

        const startParams: OmnyoThreadStartParams = {
          ...sharedConstructionParams,
          ephemeral: false,
          experimentalRawEvents: true,
          ...(decoded.daybreak === null
            ? {}
            : { daybreakEnabled: decoded.daybreak }),
        };

        params = startParams;
        break;
      }

      case "resume": {
        method = "thread/resume";

        const resumeParams: OmnyoThreadResumeParams = {
          threadId: args.request.providerThreadId,
          excludeTurns: true,
          ...sharedConstructionParams,
        };

        params = resumeParams;
        break;
      }

      case "fork": {
        method = "thread/fork";

        const forkParams: OmnyoThreadForkParams = {
          threadId: args.request.sourceProviderThreadId,
          ...(args.request.sourceProviderCheckpointId !== undefined
            ? {
                lastTurnId: stripLegacyBridgeIdPrefix(
                  args.request.sourceProviderCheckpointId,
                ),
              }
            : {}),
          ...sharedConstructionParams,
        };

        params = forkParams;
        break;
      }
    }

    const result = await requestThreadConstructionWithWriterRetry(
      connection,
      method,
      params,
    );

    const codexThreadId = result.thread.id;
    session.codexThreadId = codexThreadId;

    if (args.request.kind === "start") {
      await recordInstructionContext(session, session.configuredInstructions);
    } else if (args.request.kind === "resume") {
      session.instructionsInContext =
        existing?.codexThreadId === codexThreadId &&
        existing.instructionsInContext !== null
          ? existing.instructionsInContext
          : await readInstructionContext(codexThreadId);
    }

    translator.activateThreadGitWritableRoots({
      providerThreadId: codexThreadId,
      threadId: args.threadId,
    });
    session.turnPermissionSettings = toCodexPermissionSettings({
      additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots,
      gitWritableRoots: translator.getThreadGitWritableRoots(args.threadId),
      options: decoded.sessionOptions,
      sandboxControl: session.sandboxControl,
    });
    announceSessionIdentity(session, codexThreadId);
    session.daybreakEnabled = result.thread.daybreakEnabled ?? null;

    if (args.request.kind === "start" && decoded.daybreak !== null) {
      session.daybreakEnabled = decoded.daybreak;
    } else if (
      decoded.daybreak !== null &&
      decoded.daybreak !== session.daybreakEnabled
    ) {
      await saveDaybreakChoice(
        session,
        connection,
        codexThreadId,
        decoded.daybreak,
      );
    }

    session.modelCatalog = loadModelCatalog(
      connection,
      launchEnv,
      clientVersion,
      SESSION_MODEL_CATALOG_TIMEOUT_MS,
    ).catch(() => null);
    clearLegacyDaybreakState(session);

    return { session, codexThreadId };
  } catch (error) {
    const released = session.closing;

    if (sessionsByOmnyoThreadId.get(args.threadId) === session) {
      sessionsByOmnyoThreadId.delete(args.threadId);
    }

    session.closing = true;
    await connection.kill();
    throw released ? new CodexSessionReleasedError(error) : error;
  }
}

class CodexSessionReleasedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CodexSessionReleasedError";
  }
}

function registerResumableSession(session: CodexBridgeSession): void {
  if (
    session.codexThreadId === null ||
    sessionsByOmnyoThreadId.has(session.appThreadId)
  ) {
    return;
  }

  sessionSerialCounter += 1;

  const replacement: CodexBridgeSession = {
    appThreadId: session.appThreadId,
    codexThreadId: session.codexThreadId,
    serial: sessionSerialCounter,
    connection: null,
    translator: session.translator,
    construction: session.construction,
    constructionSignature: session.constructionSignature,
    configuredInstructions: session.configuredInstructions,
    instructionsInContext: session.instructionsInContext,
    environmentHash: session.environmentHash,
    legacyPoolProviderAdmissionV1: session.legacyPoolProviderAdmissionV1,
    turnPermissionSettings: session.turnPermissionSettings,
    sandboxControl: session.sandboxControl,
    openCodexTurnIds: new Set(),
    codexThreadIdsByTurnId: new Map(),
    responseOpenedTurns: new Map(),
    unopenedCompactionDispatches: [],
    turnSettledWaiters: new Map(),
    awaitingReplayedUsage: true,
    identityAnnounced: session.identityAnnounced,
    pendingPreIdentityDeltas: [],
    turnRateLimits: null,
    quotaRecoveryAttempted: false,
    quotaRecoveryAllowed: session.quotaRecoveryAllowed,
    rebuildBeforeNextTurnReason: null,
    daybreakEnabled: session.daybreakEnabled,
    modelCatalog: null,
    publishedSessionOptions: session.publishedSessionOptions,
    closing: false,
    previousChildExit: null,
    releasePromise: null,
    subAgentUnloader: createSubAgentUnloader(() => replacement),
  };

  sessionsByOmnyoThreadId.set(session.appThreadId, replacement);
}

async function rebuildThreadSession(
  session: CodexBridgeSession,
  options: BridgeExecutionOptions,
  reason: string,
): Promise<CodexBridgeSession> {
  const codexThreadId = session.codexThreadId;

  if (codexThreadId === null) {
    throw new Error(
      "codex session has no provider thread id to restore from its rollout",
    );
  }

  let replacement: ConstructedCodexSession;

  try {
    replacement = await constructThreadSession({
      threadId: session.appThreadId,
      cwd: session.construction.cwd,
      options,
      instructionMode: session.construction.instructionMode,
      ...(session.construction.dynamicTools !== undefined
        ? { dynamicTools: session.construction.dynamicTools }
        : {}),
      request: { kind: "resume", providerThreadId: codexThreadId },
    });
  } catch (error) {
    if (!(error instanceof CodexSessionReleasedError)) {
      registerResumableSession(session);
    }

    throw error;
  }

  sendNotification(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
    threadId: replacement.session.appThreadId,
    providerThreadId: replacement.codexThreadId,
    reason,
    contextLost: false,
  });

  return replacement.session;
}

async function withMaintenanceChild<T>(
  fn: (connection: CodexAppServerConnection) => Promise<T>,
): Promise<T> {
  const connection = spawnChildConnection({
    recordThreadId: null,
    onNotification: () => {},
    onRequest: (_method, _params, responder) => {
      responder.error(
        BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        "maintenance codex app-server does not serve requests",
      );
    },
    onExit: () => {},
  });

  maintenanceConnections.add(connection);

  try {
    await initializeChild(connection);

    return await fn(connection);
  } finally {
    maintenanceConnections.delete(connection);
    await connection.kill();
  }
}

function modelListEnvKeyOf(
  envVars: Readonly<Record<string, string>> | undefined,
): string {
  return JSON.stringify(
    Object.entries(envVars ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

async function getModelListConnection(
  envVars: Readonly<Record<string, string>> | undefined,
): Promise<ModelListClient> {
  const envKey = modelListEnvKeyOf(envVars);

  if (envKey !== modelListEnvKey) {
    const previous = modelListClient;
    modelListEnvKey = envKey;
    modelListConnectionPromise = null;

    if (previous !== null) retireModelListConnection(previous.connection);
  }

  if (modelListClient !== null && !modelListClient.connection.exited) {
    return modelListClient;
  }

  if (modelListConnectionPromise !== null) {
    return modelListConnectionPromise;
  }

  const connectionPromise = (async () => {
    const connection = spawnChildConnection({
      ...(envVars === undefined ? {} : { envVars }),
      recordThreadId: null,
      onNotification: () => {},
      onRequest: (_method, _params, responder) => {
        responder.error(
          BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          "model-list codex app-server does not serve requests",
        );
      },
      onExit: () => {
        maintenanceConnections.delete(connection);

        if (modelListClient?.connection === connection) {
          modelListClient = null;
        }
      },
    });

    maintenanceConnections.add(connection);

    try {
      const { clientVersion } = await initializeChild(connection);

      if (modelListEnvKey !== envKey) {
        throw new Error(
          "The Codex model list environment changed while starting; try again.",
        );
      }

      const client = { connection, clientVersion };
      modelListClient = client;

      return client;
    } catch (error) {
      maintenanceConnections.delete(connection);
      await connection.kill();
      throw error;
    }
  })();

  modelListConnectionPromise = connectionPromise;

  try {
    return await connectionPromise;
  } finally {
    if (modelListConnectionPromise === connectionPromise) {
      modelListConnectionPromise = null;
    }
  }
}

function retireModelListConnection(connection: CodexAppServerConnection): void {
  maintenanceConnections.delete(connection);

  if (modelListClient?.connection === connection) {
    modelListClient = null;
  }

  connection.kill();
}

async function withChildForThread<T>(
  appThreadId: string,
  fn: (connection: CodexAppServerConnection) => Promise<T>,
): Promise<T> {
  const session = sessionsByOmnyoThreadId.get(appThreadId);

  if (
    session &&
    !session.closing &&
    session.connection !== null &&
    !session.connection.exited
  ) {
    return fn(session.connection);
  }

  return withMaintenanceChild(fn);
}

type ThreadStartParamsShape = z.infer<typeof threadStartParamsSchema>;

type TurnStartParamsShape = z.infer<typeof turnStartParamsSchema>;

type TurnSteerParamsShape = z.infer<typeof turnSteerParamsSchema>;

type ThreadStopParamsShape = z.infer<typeof threadStopParamsSchema>;

function handleInitialize(id: string | number): void {
  const result: InitializeResult = {
    protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
    capabilities: {
      sessionRestore: true,
      threadArchive: true,
      threadRename: true,
      threadGoalClear: true,
      fork: "checkpoint",
      approvalEnforcedBy: "runtime",
      grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      steerMode: "inject",
      skills: { configure: true },
    },
  };

  sendResult(id, result);
}

async function handleModelList(
  id: string | number,
  envVars: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  let connection: CodexAppServerConnection | null = null;

  try {
    const client = await getModelListConnection(envVars);
    connection = client.connection;

    const catalog = loadModelCatalog(
      connection,
      appServerLaunchEnv(envVars),
      client.clientVersion,
      CHILD_REQUEST_TIMEOUT_MS,
    );

    const defaultModel = connection
      .request({
        method: "config/read",
        params: {},
        resultSchema: z.object({
          config: z.object({ model: z.string().nullish() }),
        }),
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      })
      .then((configResult) => configResult.config.model)
      .catch(() => null);

    const [{ models, selectedOnlyModels }, configuredModel] = await Promise.all(
      [catalog, defaultModel],
    );

    if (models.some((model) => model.model === configuredModel)) {
      for (const model of models) {
        model.isDefault = model.model === configuredModel;
      }
    }

    sendResult(id, {
      models,
      selectedOnlyModels,
    });
  } catch (error) {
    if (connection !== null) {
      retireModelListConnection(connection);
    }

    sendError(
      id,
      isCodexSpawnFailure(error)
        ? BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE
        : BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      describeCodexLaunchError(error),
    );
  }
}

function sendConstructionError(
  id: string | number,
  error: unknown,
  resumable: boolean,
): void {
  const message = describeCodexLaunchError(error);
  const recovery = archivedSessionHint(message);
  sendError(
    id,
    resumable && recovery !== null
      ? BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE
      : BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    message,
    recovery === null ? undefined : { recovery },
  );
}

async function handleThreadConstruction(
  id: string | number,
  params: ThreadStartParamsShape,
  request: CodexSessionConstructionRequest,
): Promise<void> {
  try {
    const constructed = await constructThreadSession({
      threadId: params.threadId,
      cwd: params.cwd,
      options: params.options,
      instructionMode: params.instructionMode,
      ...(params.dynamicTools !== undefined
        ? { dynamicTools: params.dynamicTools }
        : {}),
      request,
    });

    sendResult(id, {
      providerThreadId: constructed.codexThreadId,
      sessionRestorable: true,
    });
  } catch (error) {
    sendConstructionError(id, error, request.kind === "resume");
  }
}

interface LiveSessionForTurn {
  session: CodexBridgeSession;
  connection: CodexAppServerConnection;
}

async function requireLiveSessionForTurn(
  params: TurnStartParamsShape,
): Promise<LiveSessionForTurn> {
  let session = sessionsByOmnyoThreadId.get(params.threadId);

  if (!session || session.closing) {
    throw new Error(`No active codex session for thread "${params.threadId}"`);
  }

  const decoded = decodeCodexOptions(params.options);

  const turnEnvVars = decoded.sessionOptions.envVars ?? {};

  const signature = constructionSignature(
    session.construction.cwd,
    decoded.sessionOptions,
    Object.keys(turnEnvVars).length === 0
      ? session.environmentHash
      : environmentHash(turnEnvVars),
  );

  if (session.connection === null || session.connection.exited) {
    session = await rebuildThreadSession(
      session,
      params.options,
      "codex app-server exited; the session was restored from its rollout.",
    );
  } else if (session.rebuildBeforeNextTurnReason !== null) {
    session = await rebuildThreadSession(
      session,
      params.options,
      session.rebuildBeforeNextTurnReason,
    );
  } else if (signature !== session.constructionSignature) {
    session = await rebuildThreadSession(
      session,
      params.options,
      "Execution settings changed; the codex session was rebuilt to apply them.",
    );
  }

  if (session.connection === null) {
    throw new Error(`No active codex session for thread "${params.threadId}"`);
  }

  return { session, connection: session.connection };
}

const codexTurnStartResultSchema = z
  .object({ turn: codexTurnSchema })
  .passthrough();

function settleAcceptedDispatch(args: {
  clientRequestId: TurnStartParamsShape["clientRequestId"];
  compaction: boolean;
  prepared: PreparedProviderCommandDispatch | null;
  session: CodexBridgeSession;
  result: unknown;
}): void {
  const { clientRequestId, prepared, session, result } = args;

  if (args.compaction) {
    const dispatch = session.unopenedCompactionDispatches.find(
      (pending) => pending.clientRequestId === clientRequestId,
    );

    if (dispatch !== undefined) {
      dispatch.accepted = true;

      if (dispatch.outcome !== null) {
        settleUnopenedDispatch(session, dispatch, dispatch.outcome);
      }
    }

    return;
  }

  const parsed = codexTurnStartResultSchema.safeParse(result);

  if (!parsed.success) {
    scheduleZeroWorkTurnSettlement({ clientRequestId, prepared, session });

    return;
  }

  if (prepared === null) {
    return;
  }

  const live = currentSession(session.appThreadId, session.serial);

  if (!live || live.codexThreadId === null) {
    return;
  }

  const codexTurnId = parsed.data.turn.id;
  live.codexThreadIdsByTurnId.set(codexTurnId, live.codexThreadId);
  const turnAlreadyOpen = live.openCodexTurnIds.has(codexTurnId);
  sendThreadDeltas(
    live,
    live.translator.openTurnFromStartResponse({
      providerThreadId: live.codexThreadId,
      turn: parsed.data.turn,
      clientRequestId,
      turnAlreadyOpen,
    }),
  );

  if (
    !turnAlreadyOpen &&
    live.openCodexTurnIds.has(codexTurnId) &&
    !live.responseOpenedTurns.has(codexTurnId)
  ) {
    live.responseOpenedTurns.set(codexTurnId, {
      nativeStarted: false,
      waiters: [],
    });
  }
}

function markResponseOpenedTurnNativelyStarted(
  session: CodexBridgeSession,
  codexTurnId: string,
): void {
  const turn = session.responseOpenedTurns.get(codexTurnId);

  if (turn === undefined || turn.nativeStarted) {
    return;
  }

  turn.nativeStarted = true;
  const waiters = turn.waiters;
  turn.waiters = [];

  for (const resolve of waiters) {
    resolve(true);
  }
}

function settleResponseOpenedTurn(
  session: CodexBridgeSession,
  codexTurnId: string,
): void {
  const turn = session.responseOpenedTurns.get(codexTurnId);

  if (turn === undefined) {
    return;
  }

  session.responseOpenedTurns.delete(codexTurnId);

  for (const resolve of turn.waiters) {
    resolve(false);
  }
}

function waitForNativeTurnStart(
  session: CodexBridgeSession,
  codexTurnId: string,
  timeoutMs: number,
): Promise<boolean> {
  const turn = session.responseOpenedTurns.get(codexTurnId);

  if (turn === undefined) {
    return Promise.resolve(false);
  }

  if (turn.nativeStarted) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const onStart = (started: boolean): void => {
      clearTimeout(timer);
      resolve(started);
    };

    const timer = setTimeout(() => {
      turn.waiters = turn.waiters.filter((waiter) => waiter !== onStart);
      resolve(false);
    }, timeoutMs);

    timer.unref?.();
    turn.waiters.push(onStart);
  });
}

const ZERO_WORK_SETTLEMENT_GRACE_MS = 250;

let syntheticZeroWorkTurnCounter = 0;

function settleUnopenedDispatch(
  session: CodexBridgeSession,
  dispatch: UnopenedDispatch,
  outcome: UnopenedDispatchOutcome,
): void {
  if (!dispatch.prepared.claim()) {
    return;
  }

  syntheticZeroWorkTurnCounter += 1;
  const providerTurnId = `zero-work-${syntheticZeroWorkTurnCounter}`;
  sendThreadDeltas(session, [
    { kind: "turn.open", providerTurnId },
    {
      kind: "input.accepted",
      clientRequestId: dispatch.clientRequestId,
      providerTurnId,
    },
    outcome.status === "completed"
      ? { kind: "turn.boundary", providerTurnId, status: "completed" }
      : {
          kind: "turn.boundary",
          providerTurnId,
          status: "failed",
          error: outcome.error,
        },
  ]);
}

function scheduleZeroWorkTurnSettlement(args: {
  clientRequestId: TurnStartParamsShape["clientRequestId"];
  prepared: PreparedProviderCommandDispatch | null;
  session: CodexBridgeSession;
}): void {
  const { clientRequestId, prepared, session } = args;

  if (prepared === null) {
    return;
  }

  const serial = session.serial;

  const timer = setTimeout(() => {
    const live = currentSession(session.appThreadId, serial);

    if (!live || live.openCodexTurnIds.size > 0) {
      return;
    }

    settleUnopenedDispatch(
      live,
      { clientRequestId, prepared },
      { status: "completed" },
    );
  }, ZERO_WORK_SETTLEMENT_GRACE_MS);

  timer.unref?.();
}

function awaitCompactionTurn(args: {
  clientRequestId: TurnStartParamsShape["clientRequestId"];
  prepared: PreparedProviderCommandDispatch | null;
  session: CodexBridgeSession;
}): void {
  const { clientRequestId, prepared, session } = args;

  if (prepared === null) {
    return;
  }

  const live = currentSession(session.appThreadId, session.serial);

  if (!live) {
    return;
  }

  live.unopenedCompactionDispatches.push({
    clientRequestId,
    prepared,
    accepted: false,
    outcome: null,
  });
}

function settleCompactionDispatchesWhenCodexIsNotRunning(
  session: CodexBridgeSession,
  params: unknown,
): void {
  if (session.unopenedCompactionDispatches.length === 0) {
    return;
  }

  const parsed = codexThreadStatusChangedParamsSchema.safeParse(params);

  if (
    !parsed.success ||
    parsed.data.threadId !== session.codexThreadId ||
    session.openCodexTurnIds.size > 0
  ) {
    return;
  }

  const status = parsed.data.status.type;

  if (status !== "idle" && status !== "systemError") {
    return;
  }

  const outcome: UnopenedDispatchOutcome =
    status === "idle"
      ? { status: "completed" }
      : {
          status: "failed",
          error: {
            message:
              "codex reported a system error before the compaction turn started",
          },
        };

  for (const dispatch of session.unopenedCompactionDispatches) {
    if (dispatch.accepted) {
      settleUnopenedDispatch(session, dispatch, outcome);
    } else {
      dispatch.outcome = outcome;
    }
  }
}

const skillListSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(
        z.object({ name: z.string(), path: z.string(), enabled: z.boolean() }),
      ),
    }),
  ),
});

async function resolveCodexSkillInput(
  session: CodexBridgeSession,
  input: PromptInput[],
) {
  if (
    !input.some(
      (chunk) =>
        chunk.type === "text" && selectedSkillMentions(chunk).length > 0,
    )
  )
    return toCodexUserInput(input);

  if (session.connection === null)
    throw new Error("Codex session is disconnected");

  const result = await session.connection.request({
    method: "skills/list",
    params: { cwds: [session.construction.cwd], forceReload: true },
    resultSchema: skillListSchema,
    timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
  });

  return toCodexUserInput(
    input,
    result.data.flatMap((entry) =>
      entry.skills.filter((skill) => skill.enabled),
    ),
  );
}

async function handleTurnStart(
  id: string | number,
  params: TurnStartParamsShape,
): Promise<void> {
  let live: LiveSessionForTurn;

  try {
    live = await requireLiveSessionForTurn(params);
  } catch (error) {
    rejectWithCodexError(id, error);

    return;
  }

  const { session, connection } = live;
  const codexThreadId = session.codexThreadId;

  if (codexThreadId === null) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      `No provider thread identity for thread "${params.threadId}"`,
    );

    return;
  }

  const input: PromptInput[] = params.input;
  const decoded = decodeCodexOptions(params.options);

  const prepared = session.translator.prepareTurnStart({
    clientRequestId: params.clientRequestId,
    providerThreadId: codexThreadId,
  });

  const compaction = isStandaloneBuiltinCompactCommand(input);

  try {
    let result: unknown;

    if (compaction) {
      awaitCompactionTurn({
        clientRequestId: params.clientRequestId,
        prepared,
        session,
      });
      result = await connection.request({
        method: "thread/compact/start",
        params: { threadId: codexThreadId },
        resultSchema: ignoredChildResultSchema,
      });
    } else {
      const releaseSubAgentUnloads = session.subAgentUnloader.hold();

      try {
        await session.subAgentUnloader.settled();
        await refreshInstructionsBeforeTurn(
          session,
          connection,
          codexThreadId,
          decoded.sessionOptions.instructions,
        );

        const permissionSettings = toCodexPermissionSettings({
          additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots,
          gitWritableRoots: session.translator.getThreadGitWritableRoots(
            params.threadId,
          ),
          options: decoded.sessionOptions,
          sandboxControl: session.sandboxControl,
        });

        const cyberAccessProgram = await resolveTurnCyberAccessProgram(
          session,
          connection,
          codexThreadId,
          decoded,
        );

        const previousPermissions = session.turnPermissionSettings;
        session.turnPermissionSettings = permissionSettings;
        result = await connection
          .request({
            method: "turn/start",
            params: {
              threadId: codexThreadId,
              input: await resolveCodexSkillInput(session, input),
              ...permissionSettings,
              model: decoded.sessionOptions.model ?? undefined,
              serviceTier: toCodexServiceTier(
                decoded.sessionOptions.serviceTier,
              ),
              ...(cyberAccessProgram === null ? {} : { cyberAccessProgram }),
            },
            resultSchema: ignoredChildResultSchema,
          })
          .catch((error: unknown) => {
            if (session.turnPermissionSettings === permissionSettings) {
              session.turnPermissionSettings = previousPermissions;
            }

            throw error;
          });
      } finally {
        releaseSubAgentUnloads();
      }
    }

    sendResult(id, { threadId: params.threadId });
    settleAcceptedDispatch({
      clientRequestId: params.clientRequestId,
      compaction,
      prepared,
      session,
      result,
    });
  } catch (error) {
    session.unopenedCompactionDispatches =
      session.unopenedCompactionDispatches.filter(
        (dispatch) => dispatch.clientRequestId !== params.clientRequestId,
      );
    prepared?.rollback();
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  }
}

const CODEX_STALE_STEER_MESSAGE_PATTERN =
  /^(?:no active turn to steer|expected active turn id `[^`]+` but found `[^`]+`)$/;

async function handleTurnSteer(
  id: string | number,
  params: TurnSteerParamsShape,
): Promise<void> {
  const session = sessionsByOmnyoThreadId.get(params.threadId);

  if (
    !session ||
    session.closing ||
    session.connection === null ||
    session.connection.exited ||
    session.codexThreadId === null
  ) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      `No active codex session for thread "${params.threadId}"`,
    );

    return;
  }

  try {
    const decoded = decodeCodexOptions(params.options);

    const permissionSettings = toCodexPermissionSettings({
      additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots,
      gitWritableRoots: session.translator.getThreadGitWritableRoots(
        params.threadId,
      ),
      options: decoded.sessionOptions,
      sandboxControl: session.sandboxControl,
    });

    if (
      !isDeepStrictEqual(session.turnPermissionSettings, permissionSettings)
    ) {
      if (!session.openCodexTurnIds.has(params.expectedTurnId)) {
        rejectStaleSteer(id, "The turn to steer is no longer active");

        return;
      }

      const failure = await interruptCodexTurn(
        session,
        session.codexThreadId,
        params.expectedTurnId,
      );

      if (failure !== null) throw failure;

      const settled = await waitForCodexTurnSettlement(
        session,
        params.expectedTurnId,
        INTERRUPT_SETTLEMENT_TIMEOUT_MS,
      );

      if (!settled) {
        throw new Error(
          "Codex did not stop the active turn before applying new permissions",
        );
      }

      await handleTurnStart(id, params);

      return;
    }

    await session.connection.request({
      method: "turn/steer",
      params: {
        threadId: session.codexThreadId,
        expectedTurnId: params.expectedTurnId,
        input: await resolveCodexSkillInput(session, params.input),
      },
      resultSchema: ignoredChildResultSchema,
    });
    sendThreadDeltas(session, [
      {
        kind: "input.accepted",
        clientRequestId: params.clientRequestId,
        providerTurnId: params.expectedTurnId,
      },
    ]);
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    if (
      error instanceof CodexAppServerRpcError &&
      error.code === -32600 &&
      CODEX_STALE_STEER_MESSAGE_PATTERN.test(error.message)
    ) {
      rejectStaleSteer(id, error.message);

      return;
    }

    rejectWithCodexError(id, error);
  }
}

function rejectStaleSteer(id: string | number, message: string): void {
  sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, message, {
    recovery: { kind: "staleTurn", message, retryable: false },
  });
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParamsShape,
): Promise<void> {
  const session = sessionsByOmnyoThreadId.get(params.threadId);

  if (params.intent === "release") {
    if (session) {
      await releaseSession(session);
    }

    sendResult(id, { ok: true });

    return;
  }

  if (
    !session ||
    session.closing ||
    session.connection === null ||
    session.connection.exited ||
    session.codexThreadId === null ||
    params.activeTurnId === null
  ) {
    sendResult(id, { ok: true });

    return;
  }

  const interruptFailure = await stopCodexRootTurns(
    session,
    session.codexThreadId,
    params.activeTurnId,
  );

  const nativeStartTimedOut =
    interruptFailure !== null &&
    isCodexNoActiveTurnRejection(interruptFailure) &&
    session.responseOpenedTurns.get(params.activeTurnId)?.nativeStarted ===
      false;

  if (interruptFailure !== null && !nativeStartTimedOut) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      interruptFailure.message,
    );

    return;
  }

  if (nativeStartTimedOut) {
    closeTurnCodexNoLongerRuns(session, params.activeTurnId);
  }

  sendThreadDeltas(
    session,
    session.translator.clearExitedChildThreadState({
      providerThreadId: session.codexThreadId,
    }),
  );
  await releaseSession(session);
  sendResult(id, { ok: true });
}

async function stopCodexRootTurns(
  session: CodexBridgeSession,
  codexThreadId: string,
  requestedTurnId: string,
): Promise<Error | null> {
  const ownedRootTurns = new Set(
    [...session.openCodexTurnIds].filter(
      (turnId) => session.codexThreadIdsByTurnId.get(turnId) === codexThreadId,
    ),
  );

  const requestedTurnOwned = ownedRootTurns.has(requestedTurnId);

  const pending = requestedTurnOwned
    ? ownedRootTurns
    : new Set([requestedTurnId]);

  const redirected = new Set<string>();
  let turnId = requestedTurnId;

  while (pending.size > 0) {
    if (session.openCodexTurnIds.has(turnId) || !requestedTurnOwned) {
      const failure = await interruptCodexTurn(session, codexThreadId, turnId);

      if (failure !== null) {
        const prefix = `expected active turn id ${turnId} but found `;

        const actualTurnId = failure.message.startsWith(prefix)
          ? failure.message.slice(prefix.length)
          : null;

        if (
          failure instanceof CodexAppServerRpcError &&
          actualTurnId !== null &&
          actualTurnId !== turnId &&
          pending.has(actualTurnId) &&
          session.openCodexTurnIds.has(actualTurnId) &&
          session.codexThreadIdsByTurnId.get(actualTurnId) === codexThreadId &&
          !redirected.has(actualTurnId)
        ) {
          redirected.add(actualTurnId);
          turnId = actualTurnId;
          continue;
        }

        return failure;
      }

      const settled = await waitForCodexTurnSettlement(
        session,
        turnId,
        INTERRUPT_SETTLEMENT_TIMEOUT_MS,
      );

      if (!settled) {
        sendThreadDeltas(session, [
          {
            kind: "turn.boundary",
            providerTurnId: turnId,
            status: "interrupted",
          },
        ]);
      }
    }

    pending.delete(turnId);

    const nextTurnId = pending.has(requestedTurnId)
      ? requestedTurnId
      : pending.values().next().value;

    if (nextTurnId === undefined) return null;
    turnId = nextTurnId;
  }

  return null;
}

async function requestCodexTurnInterrupt(
  session: CodexBridgeSession,
  codexThreadId: string,
  codexTurnId: string,
): Promise<Error | null> {
  const connection = session.connection;

  if (connection === null || connection.exited) {
    return null;
  }

  try {
    await connection.request({
      method: "turn/interrupt",
      params: { threadId: codexThreadId, turnId: codexTurnId },
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });

    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function interruptCodexTurn(
  session: CodexBridgeSession,
  codexThreadId: string,
  codexTurnId: string,
): Promise<Error | null> {
  const responseOpened = session.responseOpenedTurns.get(codexTurnId);

  const awaitingNativeStart =
    responseOpened !== undefined && !responseOpened.nativeStarted;

  const failure = await requestCodexTurnInterrupt(
    session,
    codexThreadId,
    codexTurnId,
  );

  if (failure === null || !isCodexNoActiveTurnRejection(failure)) {
    return failure;
  }

  if (!awaitingNativeStart) {
    closeTurnCodexNoLongerRuns(session, codexTurnId);

    return null;
  }

  if (!session.openCodexTurnIds.has(codexTurnId)) {
    return null;
  }

  const started = await waitForNativeTurnStart(
    session,
    codexTurnId,
    INTERRUPT_SETTLEMENT_TIMEOUT_MS,
  );

  if (!session.openCodexTurnIds.has(codexTurnId)) {
    return null;
  }

  if (!started) {
    return failure;
  }

  const retryFailure = await requestCodexTurnInterrupt(
    session,
    codexThreadId,
    codexTurnId,
  );

  if (retryFailure === null || !isCodexNoActiveTurnRejection(retryFailure)) {
    return retryFailure;
  }

  closeTurnCodexNoLongerRuns(session, codexTurnId);

  return null;
}

function isCodexNoActiveTurnRejection(failure: Error): boolean {
  return (
    failure instanceof CodexAppServerRpcError &&
    failure.code === -32600 &&
    failure.message === "no active turn to interrupt"
  );
}

function closeTurnCodexNoLongerRuns(
  session: CodexBridgeSession,
  codexTurnId: string,
): void {
  if (!session.openCodexTurnIds.has(codexTurnId)) {
    return;
  }

  sendThreadDeltas(session, [
    {
      kind: "turn.boundary",
      providerTurnId: codexTurnId,
      status: "interrupted",
    },
  ]);
}

function waitForCodexTurnSettlement(
  session: CodexBridgeSession,
  codexTurnId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!session.openCodexTurnIds.has(codexTurnId)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const waiters = session.turnSettledWaiters.get(codexTurnId);

      if (waiters !== undefined) {
        session.turnSettledWaiters.set(
          codexTurnId,
          waiters.filter((waiter) => waiter !== onSettled),
        );
      }

      resolve(false);
    }, timeoutMs);

    timer.unref?.();

    const onSettled = (): void => {
      clearTimeout(timer);
      resolve(true);
    };

    const waiters = session.turnSettledWaiters.get(codexTurnId) ?? [];
    waiters.push(onSettled);
    session.turnSettledWaiters.set(codexTurnId, waiters);
  });
}

interface ThreadRefParamsShape {
  threadId: string;
  providerThreadId: string;
}

async function handleThreadGoalClear(
  id: string | number,
  params: ThreadRefParamsShape,
): Promise<void> {
  try {
    const result = await withChildForThread(params.threadId, (connection) =>
      connection.request({
        method: "thread/goal/clear",
        params: { threadId: params.providerThreadId },
        resultSchema: z.object({ cleared: z.boolean() }),
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      }),
    );

    sendResult(id, result);
  } catch (error) {
    rejectWithCodexError(id, error);
  }
}

async function handleThreadMaintenance(
  id: string | number,
  params: ThreadRefParamsShape,
  request: { method: string; params: Record<string, unknown> },
  options?: {
    releaseAfter?: boolean;
    alreadyInRequestedState?: RegExp;
  },
): Promise<void> {
  const settle = async (): Promise<void> => {
    if (options?.releaseAfter) {
      const session = sessionsByOmnyoThreadId.get(params.threadId);

      if (session) {
        await releaseSession(session);
      }
    }

    sendResult(id, { ok: true });
  };

  try {
    await withChildForThread(params.threadId, (connection) =>
      sendMaintenanceRequestWithRetries(connection, request),
    );
    await settle();
  } catch (error) {
    if (
      error instanceof Error &&
      options?.alreadyInRequestedState?.test(error.message) === true
    ) {
      await settle();

      return;
    }

    rejectWithCodexError(id, error);
  }
}

function rejectWithCodexError(id: string | number, error: unknown): void {
  const message = describeCodexLaunchError(error);
  const recovery = archivedSessionHint(message);

  if (recovery !== null) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, message, { recovery });

    return;
  }

  const details =
    error instanceof CodexAppServerRpcError
      ? {
          ...(error.errorInfo === undefined
            ? {}
            : { errorInfo: error.errorInfo }),
          ...(error.rateLimits === undefined
            ? {}
            : { rateLimits: error.rateLimits }),
        }
      : {};

  sendError(
    id,
    BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    message,
    Object.keys(details).length === 0 ? undefined : details,
  );
}

async function sendMaintenanceRequestWithRetries(
  connection: CodexAppServerConnection,
  request: { method: string; params: Record<string, unknown> },
): Promise<void> {
  const sendOnce = (): Promise<unknown> =>
    connection.request({
      method: request.method,
      params: request.params,
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });

  if (request.method !== "thread/name/set") {
    await sendOnce();

    return;
  }

  for (const retryDelayMs of CODEX_RENAME_RETRY_DELAYS_MS) {
    try {
      await sendOnce();

      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !CODEX_EMPTY_ROLLOUT_RENAME_ERROR_PATTERN.test(error.message)
      ) {
        throw error;
      }

      process.stderr.write(
        `codex rollout is not ready; retrying rename in ${retryDelayMs}ms.\n`,
      );
      await delay(retryDelayMs);
    }
  }

  await sendOnce();
}

async function handleSkillsConfigure(
  id: string | number,
  params: z.infer<typeof skillsConfigureParamsSchema>,
): Promise<void> {
  configuredSkillExtraRoots = params.roots.map((root) => root.path);

  try {
    for (const session of sessionsByOmnyoThreadId.values()) {
      if (
        session.closing ||
        session.connection === null ||
        session.connection.exited
      ) {
        continue;
      }

      await session.connection.request({
        method: "skills/extraRoots/set",
        params: { extraRoots: configuredSkillExtraRoots },
        resultSchema: ignoredChildResultSchema,
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      });
    }

    sendResult(id, { ok: true });
  } catch (error) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleRequest(
  request: CodexBridgeCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize":
      handleInitialize(request.id);
      break;
    case "model/list":
      await handleModelList(request.id, request.params.envVars);
      break;
    case "provider/health":
      sendResult(request.id, await getCodexProviderHealth());
      break;
    case "provider/usage":
      sendResult(request.id, await getCodexProviderUsage());
      break;
    case "provider/installation/status":
      sendResult(
        request.id,
        await getCodexProviderInstallationStatus(
          request.params.requirement,
          request.params.checkUpdates,
        ),
      );
      break;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getCodexProviderInstallationRun(request.params.action),
      );
      break;
    case "thread/start":
      await handleThreadConstruction(request.id, request.params, {
        kind: "start",
      });
      break;
    case "thread/resume":
      await handleThreadConstruction(request.id, request.params, {
        kind: "resume",
        providerThreadId: request.params.providerThreadId,
      });
      break;
    case "thread/fork":
      await handleThreadConstruction(request.id, request.params, {
        kind: "fork",
        sourceProviderThreadId: request.params.sourceProviderThreadId,
        ...(request.params.sourceProviderCheckpointId !== undefined
          ? {
              sourceProviderCheckpointId:
                request.params.sourceProviderCheckpointId,
            }
          : {}),
      });
      break;
    case "thread/speed/set": {
      const session = sessionsByOmnyoThreadId.get(request.params.threadId);

      if (
        !session ||
        session.closing ||
        !session.connection ||
        !session.codexThreadId
      )
        throw new Error("No live Codex session is available");
      const codexThreadId = session.codexThreadId;
      const serviceTier = toCodexServiceTier(request.params.serviceTier);
      await session.connection.request({
        method: "thread/settings/update",
        params: { threadId: codexThreadId, serviceTier },
        resultSchema: ignoredChildResultSchema,
      });

      for (const turnId of session.openCodexTurnIds) {
        if (session.codexThreadIdsByTurnId.get(turnId) !== codexThreadId)
          continue;

        const result = await session.connection.request({
          method: "turn/settings/update",
          params: { threadId: codexThreadId, turnId, serviceTier },
          resultSchema: z.object({
            status: z.enum(["applied", "targetUnavailable"]),
          }),
        });

        if (result.status !== "applied" && session.openCodexTurnIds.has(turnId))
          throw new Error("Codex could not apply the speed to the active turn");
      }

      sendResult(request.id, { ok: true });
      break;
    }

    case "turn/start":
      await handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      await handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      await handleThreadStop(request.id, request.params);
      break;
    case "thread/discard":
      await handleThreadMaintenance(
        request.id,
        request.params,
        {
          method: "thread/archive",
          params: { threadId: request.params.providerThreadId },
        },
        { releaseAfter: true },
      );
      break;
    case "thread/name/set":
      await handleThreadMaintenance(request.id, request.params, {
        method: "thread/name/set",
        params: {
          threadId: request.params.providerThreadId,
          name: request.params.title,
        },
      });
      break;
    case "thread/archive":
      await handleThreadMaintenance(
        request.id,
        request.params,
        {
          method: "thread/archive",
          params: { threadId: request.params.providerThreadId },
        },
        {
          releaseAfter: true,
          alreadyInRequestedState: CODEX_ALREADY_ARCHIVED_ERROR_PATTERN,
        },
      );
      break;
    case "thread/unarchive":
      await handleThreadMaintenance(
        request.id,
        request.params,
        {
          method: "thread/unarchive",
          params: { threadId: request.params.providerThreadId },
        },
        { alreadyInRequestedState: CODEX_NOT_ARCHIVED_ERROR_PATTERN },
      );
      break;
    case "thread/goal/clear":
      await handleThreadGoalClear(request.id, request.params);
      break;
    case "skills/configure":
      await handleSkillsConfigure(request.id, request.params);
      break;
  }
}

function handleParsedMessage(parsed: unknown): void {
  const response = decodeBridgeJsonRpcResponse(parsed);

  if (response && typeof response.id === "number") {
    const pending = pendingRuntimeRequests.get(response.id);

    if (pending) {
      pendingRuntimeRequests.delete(response.id);
      pending(response);

      return;
    }
  }

  const decoded = decodeCodexBridgeJsonRpcRequest(parsed);

  if (decoded.kind === "ignored") {
    return;
  }

  if (decoded.kind === "unknown-method") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unknown method "${decoded.method}"`,
    );

    return;
  }

  if (decoded.kind === "invalid-params") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for "${decoded.method}": ${decoded.issues}`,
    );

    return;
  }

  runBridgeRequest({ request: decoded.request, handleRequest, sendError });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

function killAllChildren(): void {
  for (const session of sessionsByOmnyoThreadId.values()) {
    session.closing = true;
    session.connection?.kill();
    session.connection = null;
  }

  sessionsByOmnyoThreadId.clear();
  modelListClient = null;
  modelListConnectionPromise = null;
  modelListEnvKey = "[]";

  for (const connection of maintenanceConnections) {
    connection.kill();
  }

  maintenanceConnections.clear();
}

/** @internal Test cleanup for bridge tests that create a persistent child. */
export const experimental_killAllChildrenForTests = killAllChildren;

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: ({ dataDir }) => {
    instructionContextStore = new InstructionContextStore(
      join(dataDir, "codex-instruction-context"),
    );
  },
  onClose: () => {
    killAllChildren();
    process.exit(0);
  },
  onSigterm: () => {
    killAllChildren();
    process.exit(0);
  },
  onSigint: () => {
    killAllChildren();
    process.exit(0);
  },
});
