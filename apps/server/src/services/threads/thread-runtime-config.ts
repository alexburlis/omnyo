import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  resolveHostEnvironment,
  mergeHostAndProviderEnvironment,
} from "../hosts/host-environment.js";
import {
  getEnvironment,
  getHost,
  getProject,
  listThreadQuestions,
  listThreadCallbacks,
} from "@omnyo/db";
import { PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS } from "@omnyo/plugin-sdk/internal/host-policy";
import type {
  DynamicTool,
  InstructionMode,
  PermissionEscalation,
  Thread,
  ThreadTurnInitiator,
  EnvironmentStatus,
} from "@omnyo/domain";
import type {
  HostDaemonContributedEnvEntry,
  HostDaemonInjectedSkillSource,
} from "@omnyo/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { throwEnvironmentNotReady } from "../lib/lifecycle-api-errors.js";
import { requireLiveThreadStoragePath } from "./thread-storage.js";
import {
  listPluginAgentTools,
  listPluginInstructionContributions,
  getPluginSkillRootContributions,
  resolvePluginAgentConfiguration,
  resolvePluginProviderEnv,
} from "../plugins/plugin-agent-contributions.js";
import { resolveSkillCatalog } from "../skills/skill-catalog.js";
import { discoverPluginSkillIds } from "../skills/injected-skills.js";
import { UPDATE_ENVIRONMENT_DIRECTORY_TOOL } from "./thread-environment-directory.js";
import {
  DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH,
  WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH,
  readDataDirAgentInstructions,
} from "./workspace-agent-instructions.js";
import { readWorkspaceAgentContext } from "./workspace-agent-context.js";
import { resolveDeprecatedWorkspaceProvisionType } from "../environments/environment-response.js";
import { markTurnTraceSpan } from "../system/turn-trace.js";
import { resolveQuestionOwnerThread } from "./thread-parent.js";

const UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS =
  "If the user asks you to move this thread to another checkout, worktree, or directory, make sure the target directory exists, then call `update_environment_directory` with its absolute path. After it succeeds, stop work in the current turn; future turns will run in the updated environment.";

const ROOT_QUESTION_INSTRUCTIONS =
  'Omnyo owns native questions and callback dependencies. Optional questions permit continued work with a stated reversible default; required questions block only the dependent action. Skipping supplies no answer or approval. Answers immediately steer a running turn or start a turn when idle. Use omnyo question list --self --json to inspect questions. If progress makes an open question unnecessary, withdraw it with omnyo question command --self --value \'{"action":"withdraw","id":"<question-id>","revision":<current-revision>}\' --json. Continuing independent work alone does not invalidate a question that still needs an answer. Set delegable: true on a question only for a reversible choice within authority you already hold, never when it asks the owner to approve pushing, publishing, deploying, releasing, submitting, sending, purchasing, deleting data, changing an external service, creating an account or saving anything that outlives the chat. When you re-open a child chat\'s question, keep delegable only when the child set it.';

function routedQuestionInstructions(ownerThreadId: string): string {
  return `This chat reports to ${ownerThreadId}, the chat that started or parents it. That chat answers its questions; the owner never sees them. Ask with AskUserQuestion, or run omnyo question command --self --value '{"action":"open","questions":[{"prompt":"<question>","mode":"required"}]}' --json; either delivers the question to that chat as a message, and it replies with a message in this chat. Do not wait for the owner or point anyone to a question panel. A required question blocks only the dependent action: continue independent work, or end the turn with the question stated when nothing else can proceed. Logins, credentials, manual edits and approvals also go to that chat, which involves the owner when needed.`;
}

const CALLBACK_INSTRUCTIONS =
  "Before yielding for an already-running or queued source chat, register omnyo callback wait --self --from <thread-id> --reason <reason>. Include the returned callbackMarker in the source's completion request and require its reply with omnyo thread tell <your-id> --mode auto. A wait does not start work or schedule a reply.";

const ROOT_HUMAN_INPUT_INSTRUCTIONS =
  "Human login, credentials, manual edits and approvals require the appropriate input UI; never register a callback for a human.";

const CHILD_HUMAN_INPUT_INSTRUCTIONS = "Never register a callback for a human.";

const COMPLETION_ROUTE_INSTRUCTIONS =
  "Resources and scheduled automation own their completion routes. Clear only the exact resolved wait with omnyo callback clear --self --id <wait-id>.";

export interface ThreadRuntimeCommandEnvironment {
  hostId: string;
  id: string;
  path: string | null;
  status: EnvironmentStatus;
}

interface ResolveThreadRuntimeCommandConfigArgs {
  environment: ThreadRuntimeCommandEnvironment;
  model: string;
  thread: Thread;
}

interface ResolvePermissionEscalationArgs {
  initiator: ThreadTurnInitiator;
}

export interface ResolvedThreadRuntimeCommandConfig {
  contributedEnv: HostDaemonContributedEnvEntry[];
  dynamicTools: DynamicTool[];
  injectedSkillSources: HostDaemonInjectedSkillSource[];
  instructionMode: InstructionMode;
  instructions: string;
  projectId: string;
  providerId: string;
  threadStoragePath: string;
  workspacePath: string;
}

function requireWorkspacePath(
  environment: ThreadRuntimeCommandEnvironment,
): string {
  if (!environment.path) {
    throwEnvironmentNotReady(environment);
  }

  return environment.path;
}

interface DynamicToolContribution {
  tool: DynamicTool;
  instructions: string | null;
  pluginId: string | null;
}

function resolveDynamicTools(
  pluginTools: ReturnType<typeof listPluginAgentTools>,
): DynamicToolContribution[] {
  return [
    {
      tool: UPDATE_ENVIRONMENT_DIRECTORY_TOOL,
      instructions: UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS,
      pluginId: null,
    },
    ...pluginTools.map((contribution) => ({
      tool: contribution.tool,
      instructions: contribution.instructions,
      pluginId: contribution.pluginId,
    })),
  ];
}

export function resolvePermissionEscalation(
  args: ResolvePermissionEscalationArgs,
): PermissionEscalation {
  if (args.initiator !== "user") {
    return "deny";
  }

  return "ask";
}

export async function resolveThreadRuntimeCommandConfig(
  deps: LoggedWorkSessionDeps,
  args: ResolveThreadRuntimeCommandConfigArgs,
): Promise<ResolvedThreadRuntimeCommandConfig> {
  markTurnTraceSpan("runtimeConfig.started");
  const workspacePath = requireWorkspacePath(args.environment);
  const project = getProject(deps.db, args.thread.projectId);

  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }

  const environment = getEnvironment(deps.db, args.environment.id);

  if (!environment) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }

  const host = getHost(deps.db, args.environment.hostId);

  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  const workspaceIdentityPreparation = callHostRetryableOnlineRpc(deps, {
    hostId: args.environment.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.prepare_workspace_identity_v1",
      rootPath: workspacePath,
    },
  });

  const workspaceAgentContextPromise = workspaceIdentityPreparation
    .then(() =>
      readWorkspaceAgentContext(deps, {
        includeAgentInstructions: true,
        hostId: args.environment.hostId,
        workspacePath,
      }),
    )
    .then((context) => {
      markTurnTraceSpan("runtimeConfig.workspaceRead");

      return context;
    });

  const pluginSkillRoots = getPluginSkillRootContributions();

  const skillIdsByPlugin = discoverPluginSkillIds(deps.logger, {
    pluginSkillRoots,
    skillTreeRegistry: deps.skillTreeRegistry,
  });

  const conditionalConfigurationPromise = resolvePluginAgentConfiguration({
    context: {
      thread: {
        id: args.thread.id,
        title: args.thread.title,
        parentThreadId: args.thread.parentThreadId,
        sourceThreadId: args.thread.sourceThreadId,
        experimental_visibility: args.thread.visibility,
      },
      project: {
        id: project.id,
        kind: project.kind,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
      },
      environment: {
        id: environment.id,
        name: environment.name,
        path: environment.path,
        branchName: environment.branchName,
        workspaceProvisionType: resolveDeprecatedWorkspaceProvisionType(
          environment.environmentProviderId,
        ),
      },
      host: { id: host.id, name: host.name },
      provider: {
        id: args.thread.providerId,
        model: args.model,
        capabilities: {
          supportsNativeUserQuestion:
            deps.providerRegistry.get(args.thread.providerId)?.info.capabilities
              .supportsNativeUserQuestion ?? false,
        },
      },
      origin: {
        kind: args.thread.originKind,
        pluginId: args.thread.originPluginId,
      },
    },
    skillIdsByPlugin,
  }).then((configuration) => {
    markTurnTraceSpan("runtimeConfig.pluginConfig");

    return configuration;
  });

  const contributedEnvPromise = Promise.all([
    resolveHostEnvironment(deps, {
      hostId: host.id,
      projectId: project.id,
    }),
    resolvePluginProviderEnv({
      providerId: args.thread.providerId,
      context: {
        purpose: "thread",
        threadId: args.thread.id,
        projectId: project.id,
        hostId: host.id,
      },
    }),
  ]).then(([hostEnvironment, providerEnvironment]) => {
    markTurnTraceSpan("runtimeConfig.env");

    return mergeHostAndProviderEnvironment(
      hostEnvironment,
      providerEnvironment,
    );
  });

  const [
    workspaceAgentContext,
    conditionalConfiguration,
    contributedEnv,
    threadStoragePath,
  ] = await Promise.all([
    workspaceAgentContextPromise,
    conditionalConfigurationPromise,
    contributedEnvPromise,
    requireLiveThreadStoragePath(deps, {
      hostId: args.environment.hostId,
      threadId: args.thread.id,
    }),
  ]);

  const injectedSkillSources = resolveSkillCatalog(deps, {
    projectSkillSources: workspaceAgentContext.projectSkillSources,
    sharedSkillSources: workspaceAgentContext.sharedSkills.runtimeSources,
    pluginSkillSelections: conditionalConfiguration.selectedSkillIdsByPlugin,
  }).map((entry) => entry.runtimeSource);

  const dataDirAgentInstructions = readDataDirAgentInstructions(
    deps.logger,
    deps.config.dataDir,
  );

  const dynamicToolContributions = resolveDynamicTools(
    conditionalConfiguration.tools,
  );

  const dynamicTools = dynamicToolContributions.map(
    (contribution) => contribution.tool,
  );

  const instructionSections: string[] = [];
  const questions = listThreadQuestions(deps.db, args.thread.id);
  const callbacks = listThreadCallbacks(deps.db, args.thread.id);
  const questionOwnerThread = resolveQuestionOwnerThread(deps, args.thread);
  instructionSections.push(
    [
      questionOwnerThread === null
        ? ROOT_QUESTION_INSTRUCTIONS
        : routedQuestionInstructions(questionOwnerThread.id),
      CALLBACK_INSTRUCTIONS,
      questionOwnerThread === null
        ? ROOT_HUMAN_INPUT_INSTRUCTIONS
        : CHILD_HUMAN_INPUT_INSTRUCTIONS,
      COMPLETION_ROUTE_INSTRUCTIONS,
    ].join(" "),
  );

  if (questions.length > 0)
    instructionSections.push(
      `Native open questions: ${JSON.stringify(questions.map((question) => ({ id: question.id, revision: question.revision, mode: question.question.mode, prompt: question.question.prompt })))}. Do not duplicate these questions; withdraw only when the input no longer matters.`,
    );

  if (callbacks.length > 0)
    instructionSections.push(
      `Native callback dependencies: ${JSON.stringify(callbacks)}. A dependency only completes on its recorded source and exact marker, or explicit verified cancellation.`,
    );

  for (const contribution of dynamicToolContributions) {
    if (!contribution.instructions) continue;

    if (contribution.pluginId === null) {
      instructionSections.push(contribution.instructions);
    } else {
      instructionSections.push(
        `The following instructions come from the Omnyo plugin "${contribution.pluginId}" for its tool "${contribution.tool.name}":`,
        contribution.instructions,
      );
    }
  }

  for (const contribution of listPluginInstructionContributions()) {
    let text: string | null;

    try {
      text = contribution.provider({
        threadId: args.thread.id,
        projectId: args.thread.projectId,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          pluginId: contribution.pluginId,
          threadId: args.thread.id,
        },
        "Plugin instruction contribution threw; skipping",
      );
      continue;
    }

    if (text === null || text.trim().length === 0) continue;

    if (text.length > PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS) {
      text = text.slice(0, PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS);
    }

    instructionSections.push(
      `The following instructions come from the Omnyo plugin "${contribution.pluginId}":`,
      text,
    );
  }

  for (const contribution of conditionalConfiguration.dynamicInstructions) {
    instructionSections.push(
      `The following dynamic instructions come from the Omnyo plugin "${contribution.pluginId}":`,
      contribution.text,
    );
  }

  if (dataDirAgentInstructions) {
    instructionSections.push(
      `The following user instructions come from <dataDir>/${DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH}:`,
      dataDirAgentInstructions,
    );
  }

  if (workspaceAgentContext.agentInstructions) {
    instructionSections.push(
      `The following workspace instructions come from ${WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH}:`,
      workspaceAgentContext.agentInstructions,
    );
  }

  const instructions = instructionSections.join("\n\n");

  markTurnTraceSpan("runtimeConfig.built");

  return {
    contributedEnv,
    dynamicTools,
    injectedSkillSources,
    instructionMode: "append",
    instructions,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    threadStoragePath,
    workspacePath,
  };
}
