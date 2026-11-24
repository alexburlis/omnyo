import {
  type InstructionMode,
  type ReasoningLevel,
  type ServiceTier,
  type RuntimePermissionScope,
} from "@omnyo/plugin-sdk/provider-bridge";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudePermissionMode } from "../interactive-contract.js";
import type {
  ClaudeMutableFlagSettings,
  ClaudeSdkReasoningEffort,
  SdkSessionOptions,
} from "./sdk-session.js";

export interface BuildSessionOptionsArgs {
  additionalWorkspaceWriteRoots?: readonly string[];
  baseInstructions?: string;
  cwd: string;
  instructionMode: InstructionMode;
  model?: string;
  permissionMode: ClaudePermissionMode;
  permissionScope: RuntimePermissionScope;
  plugins?: Options["plugins"];
  reasoningLevel?: ReasoningLevel;
  serviceTier: ServiceTier;
  workflowsEnabled: boolean;
  chromeEnabled: boolean;
  disable1MContext: boolean;
  allowModelFallback: boolean;
  sandboxEnabled: boolean;
  memoryEnabled?: boolean;
}

type WorkspaceWriteSandboxArgs = Pick<
  BuildSessionOptionsArgs,
  | "additionalWorkspaceWriteRoots"
  | "permissionMode"
  | "permissionScope"
  | "sandboxEnabled"
>;

export interface PermissionEscalationWorkContext {
  agentId?: string;
  promptId?: string;
  toolUseId?: string;
}

interface ResolveExecutableOnPathArgs {
  executableName: string;
  pathEnv: string | undefined;
}

interface ResolveClaudeCodeExecutableArgs {
  env: NodeJS.ProcessEnv;
}

const SUMMARIZED_ADAPTIVE_THINKING = {
  type: "adaptive",
  display: "summarized",
} satisfies Exclude<Options["thinking"], undefined>;

const CLAUDE_CODE_EXECUTABLE_ENV = "OMNYO_CLAUDE_CODE_EXECUTABLE";

export function toSdkEffort(
  reasoningLevel: ReasoningLevel,
): ClaudeSdkReasoningEffort | undefined {
  switch (reasoningLevel) {
    case "ultracode":
      return "xhigh";
    case "none":
      return "low";
    case "ultra":
      return "max";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return reasoningLevel;
    default:
      return undefined;
  }
}

function buildFlagSettings(params: BuildSessionOptionsArgs): Settings {
  return {
    autoMemoryEnabled: params.memoryEnabled ?? true,
    enableWorkflows: params.workflowsEnabled,
    ultracode: params.reasoningLevel === "ultracode",
    fastMode: params.serviceTier === "fast",
    ...buildModelFallbackSettings(params.allowModelFallback),
  };
}

export function buildModelFallbackSettings(allowModelFallback: boolean) {
  const disableModelFallback = allowModelFallback === true ? "0" : "1";

  return {
    switchModelsOnFlag: allowModelFallback === true,
    env: {
      CLAUDE_CODE_NO_MODEL_FALLBACK: disableModelFallback,
      CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: disableModelFallback,
    },
  } satisfies Pick<Settings, "env" | "switchModelsOnFlag">;
}

export function buildSessionSettingsEnv(args: {
  env: NodeJS.ProcessEnv;
  allowModelFallback: boolean;
  disable1MContext: boolean;
}): NodeJS.ProcessEnv {
  return {
    ...args.env,
    CLAUDE_CODE_DISABLE_1M_CONTEXT: args.disable1MContext ? "1" : "0",
    ...buildModelFallbackSettings(args.allowModelFallback).env,
  };
}

export function buildChromeExtraArgs(
  chromeEnabled: boolean,
): Options["extraArgs"] | undefined {
  return chromeEnabled ? { chrome: null } : undefined;
}

export function buildMutableFlagSettings(args: {
  memoryEnabled: boolean;
  reasoningLevel: ReasoningLevel | undefined;
  workflowsEnabled: boolean;
  serviceTier: ServiceTier;
}): ClaudeMutableFlagSettings {
  const effortLevel =
    args.reasoningLevel === undefined
      ? undefined
      : toSdkEffort(args.reasoningLevel);

  return {
    autoMemoryEnabled: args.memoryEnabled,
    enableWorkflows: args.workflowsEnabled,
    ...(effortLevel !== undefined ? { effortLevel } : {}),
    ultracode: args.reasoningLevel === "ultracode",
    fastMode: args.serviceTier === "fast",
  };
}

export function buildReadonlyDenialMessage(): string {
  return "Omnyo readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.";
}

export function buildWorkspaceWriteDenialMessage(): string {
  return "Omnyo's workspace sandbox allows work inside the current workspace only. Stay inside the workspace or explain why extra access is needed.";
}

function isWorkspaceWriteSession(params: WorkspaceWriteSandboxArgs): boolean {
  return (
    params.permissionScope === "workspace" &&
    (params.permissionMode === "acceptEdits" ||
      params.permissionMode === "auto")
  );
}

function omnyoServerDomains(env: NodeJS.ProcessEnv): string[] {
  const serverUrl = env.OMNYO_SERVER_URL?.trim();

  if (!serverUrl || !URL.canParse(serverUrl)) {
    return [];
  }

  return [new URL(serverUrl).hostname];
}

export function buildWorkspaceWriteSandbox(
  params: WorkspaceWriteSandboxArgs,
  env: NodeJS.ProcessEnv,
): Options["sandbox"] | undefined {
  if (!params.sandboxEnabled || !isWorkspaceWriteSession(params)) {
    return undefined;
  }

  const allowWrite = params.additionalWorkspaceWriteRoots ?? [];
  const allowedDomains = omnyoServerDomains(env);

  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    network: {
      allowLocalBinding: true,
      ...(allowedDomains.length > 0 ? { allowedDomains } : {}),
    },
    ...(allowWrite.length > 0
      ? { filesystem: { allowWrite: [...allowWrite] } }
      : {}),
  };
}

const CLAUDE_WINDOWS_EXECUTABLE_NAME = "claude.exe";

function isExecutableFile(candidatePath: string): boolean {
  try {
    accessSync(candidatePath, constants.X_OK);

    return statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function resolveExecutableOnPath(
  args: ResolveExecutableOnPathArgs,
): string | null {
  if (!args.pathEnv) {
    return null;
  }

  for (const searchDir of args.pathEnv.split(delimiter)) {
    if (!searchDir) {
      continue;
    }

    const candidate = join(searchDir, args.executableName);

    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function wellKnownClaudeExecutablePaths(env: NodeJS.ProcessEnv): string[] {
  if (process.getuid?.() === 0) {
    return [];
  }

  if (process.platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();

    return userProfile
      ? [join(userProfile, ".local", "bin", CLAUDE_WINDOWS_EXECUTABLE_NAME)]
      : [];
  }

  const candidatePaths: string[] = [];
  const home = env.HOME?.trim();

  if (home) {
    candidatePaths.push(
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
    );
  }

  candidatePaths.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");

  return candidatePaths;
}

export function resolveClaudeCodeExecutable(
  args: ResolveClaudeCodeExecutableArgs,
): string | null {
  const explicitPath = args.env[CLAUDE_CODE_EXECUTABLE_ENV];
  const trimmedExplicitPath = explicitPath?.trim();

  if (trimmedExplicitPath && trimmedExplicitPath.length > 0) {
    try {
      accessSync(trimmedExplicitPath, constants.X_OK);

      return trimmedExplicitPath;
    } catch {
      throw new Error(
        `${CLAUDE_CODE_EXECUTABLE_ENV} must point to an executable Claude CLI path: ${trimmedExplicitPath}`,
      );
    }
  }

  const executableOnPath = resolveExecutableOnPath({
    executableName:
      process.platform === "win32" ? CLAUDE_WINDOWS_EXECUTABLE_NAME : "claude",
    pathEnv: args.env.PATH ?? args.env.Path,
  });

  if (executableOnPath) {
    return executableOnPath;
  }

  for (const candidate of wellKnownClaudeExecutablePaths(args.env)) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function buildSessionOptions(
  params: BuildSessionOptionsArgs,
  env: NodeJS.ProcessEnv,
): SdkSessionOptions {
  const systemPrompt: Exclude<Options["systemPrompt"], undefined> =
    params.instructionMode === "replace"
      ? {
          type: "custom",
          prompt:
            params.baseInstructions ?? "You are a helpful coding assistant.",
          snapshot: false,
        }
      : {
          type: "preset",
          preset: "claude_code",
          snapshot: false,
          ...(params.baseInstructions && params.baseInstructions.length > 0
            ? { append: params.baseInstructions }
            : {}),
        };

  const model = params.model;
  const sandbox = buildWorkspaceWriteSandbox(params, env);

  const additionalDirectories = isWorkspaceWriteSession(params)
    ? (params.additionalWorkspaceWriteRoots ?? [])
    : [];

  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable({ env });
  const flagSettings = buildFlagSettings(params);

  const effort =
    params.reasoningLevel === undefined
      ? undefined
      : toSdkEffort(params.reasoningLevel);

  const extraArgs = buildChromeExtraArgs(params.chromeEnabled);

  return {
    cwd: params.cwd,
    systemPrompt,
    model,
    env: buildSessionSettingsEnv({ ...params, env }),
    permissionMode: params.permissionMode,
    allowBypassPermissions: params.permissionScope === "full",
    ...(effort !== undefined ? { effort } : {}),
    ...(effort !== undefined ? { thinking: SUMMARIZED_ADAPTIVE_THINKING } : {}),
    settings: flagSettings,
    ...(extraArgs ? { extraArgs } : {}),
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    ...(params.plugins ? { plugins: params.plugins } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(additionalDirectories.length > 0
      ? { additionalDirectories: [...additionalDirectories] }
      : {}),
  };
}
