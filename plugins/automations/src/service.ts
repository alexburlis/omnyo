import type { createWorkflowDispatch } from "./workflow-dispatch.js";
import { isAbsolute, join } from "node:path";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { ScriptHostRouting } from "./script-host.js";
import {
  createAutomation,
  createManualRun,
  decodeAutomationRow,
  deleteAutomation,
  getAutomationForProject,
  listAllAutomations,
  listAutomationRuns,
  listAutomationsForProject,
  listRunningAutomationRunsByThread,
  setAutomationEnabled,
  toAutomationResponse,
  toAutomationRunResponse,
  updateAutomation,
  closeAutomationRun,
  type AutomationEnvValues,
  type AutomationRow,
  type Db,
} from "./data.js";
import type { AutomationEnvStore } from "./env-secrets.js";
import { createAutomationId } from "./ids.js";
import {
  providerRoutingForEnvironment,
  resolvePermissionMode,
} from "./provider-permissions.js";
import { publishAutomationChange } from "./realtime.js";
import { isPrintableWorkingDirectoryPath } from "./limits.js";
import {
  AUTOMATION_RUNS_LIMIT_MAX,
  WORKING_DIRECTORY_CONTROL_CHARACTER_MESSAGE,
  automationRunListResponseSchema,
  automationsOverviewResponseSchema,
  type AgentExecutionUpdate,
  type AutomationExecution,
  type AutomationExecutionRequest,
  type AutomationDetailReadResult,
  type AutomationOverview,
  type AutomationDetailResponse,
  type AutomationReadProblem,
  type AutomationReadResult,
  type AutomationRunListResponse,
  type AutomationRunRpcResponse,
  type AutomationResponse,
  type AutomationScriptWorkingDirectory,
  type AutomationsOverviewResponse,
  type ResolvedCreateAutomationInput,
  type ResolvedAutomationRunsInput,
  type RunAutomationInput,
  type ScriptExecutionUpdate,
  type UpdateAutomationInput,
} from "./rpc-types.js";
import {
  computeInitialNextRunAt,
  computeNextScheduledTime,
  validateOnceDefinition,
  validateScheduleDefinition,
} from "./schedule-helpers.js";
import {
  automationScriptDir,
  deleteAutomationScriptDir,
  deleteAutomationScriptFile,
  readAutomationScript,
  writeInlineAutomationScript,
} from "./script-files.js";
import { errorMessage, executeAgentRun, executeScriptRun } from "./run.js";
import {
  createScriptWorkingDirectoryResolver,
  projectPathForHost,
} from "./working-directory.js";

type ServiceApi = Pick<PluginApi, "realtime" | "log"> & {
  server: Pick<PluginApi["server"], "loopbackBaseUrl">;
  sdk: {
    system: { config(): Promise<{ primaryHostId: string | null }> };
    projects: Pick<PluginApi["sdk"]["projects"], "get" | "list">;
    providers: Pick<PluginApi["sdk"]["providers"], "list">;
    threads: Pick<
      PluginApi["sdk"]["threads"],
      "get" | "send" | "spawn" | "events" | "retry"
    >;
    experimental_inbox: Pick<
      PluginApi["sdk"]["experimental_inbox"],
      "waits" | "cancelWait" | "registerWait"
    >;
  };
};

export interface AutomationService {
  overview(): Promise<AutomationsOverviewResponse>;
  list(input: { projectId: string }): AutomationReadResult[];
  get(input: {
    projectId: string;
    automationId: string;
  }): Promise<AutomationDetailReadResult>;
  create(
    input: ResolvedCreateAutomationInput,
  ): Promise<AutomationDetailResponse>;
  update(input: UpdateAutomationInput): Promise<AutomationDetailResponse>;
  delete(input: {
    projectId: string;
    automationId: string;
  }): Promise<{ ok: true }>;
  pause(input: { projectId: string; automationId: string }): AutomationResponse;
  resume(input: {
    projectId: string;
    automationId: string;
  }): AutomationResponse;
  run(input: RunAutomationInput): Promise<AutomationRunRpcResponse>;
  runs(input: ResolvedAutomationRunsInput): AutomationRunListResponse;
}

function requireProjectAutomation(
  db: Db,
  args: { projectId: string; automationId: string },
): AutomationRow {
  const automation = getAutomationForProject(db, args);

  if (!automation) throw new Error("Automation not found");

  return automation;
}

function validateTrigger(
  trigger: ResolvedCreateAutomationInput["trigger"],
  now = Date.now(),
): void {
  if (trigger.triggerType === "schedule") {
    validateScheduleDefinition({
      cron: trigger.cron,
      timezone: trigger.timezone,
    });
  } else {
    validateOnceDefinition({ runAt: trigger.runAt, now });
  }
}

function computeNextRunAt(
  trigger: ResolvedCreateAutomationInput["trigger"],
  now: number,
): number {
  if (trigger.triggerType === "once") {
    return trigger.runAt;
  }

  return computeNextScheduledTime({
    cron: trigger.cron,
    timezone: trigger.timezone,
    now,
  });
}

async function assertNotRecursiveCreation(
  api: Pick<ServiceApi, "sdk">,
  db: Db,
  createdByThreadId: string | undefined,
): Promise<void> {
  if (createdByThreadId === undefined) return;

  if (listRunningAutomationRunsByThread(db, createdByThreadId).length > 0) {
    throw new Error(
      "Threads executing an automation run cannot create automations",
    );
  }

  const thread = await api.sdk.threads.get({ threadId: createdByThreadId });

  if (thread.originPluginId === "automations") {
    throw new Error("Automation-spawned threads cannot create automations");
  }
}

type ResolvedStoredExecution = {
  execution: AutomationExecution;
  writtenScriptFile?: string;
};

const PROJECT_WORKING_DIRECTORY = { type: "project" } as const;

const AUTOMATION_STORAGE_WORKING_DIRECTORY = {
  type: "automation-storage",
} as const;

function validateScriptWorkingDirectory(
  workingDirectory: AutomationScriptWorkingDirectory,
): void {
  if (workingDirectory.type !== "path") return;

  if (!isAbsolute(workingDirectory.path)) {
    throw new Error(
      "A script working directory must be automation-storage, project, or an absolute path on the Omnyo server host",
    );
  }

  if (!isPrintableWorkingDirectoryPath(workingDirectory.path)) {
    throw new Error(WORKING_DIRECTORY_CONTROL_CHARACTER_MESSAGE);
  }
}

async function resolveStoredExecution(args: {
  pluginDataDir: string;
  automationId: string;
  execution: AutomationExecutionRequest;
  defaultWorkingDirectory: AutomationScriptWorkingDirectory;
}): Promise<ResolvedStoredExecution> {
  if (args.execution.mode !== "script") {
    return { execution: args.execution };
  }

  const execution = {
    ...args.execution,
    workingDirectory:
      args.execution.workingDirectory ?? args.defaultWorkingDirectory,
  };

  validateScriptWorkingDirectory(execution.workingDirectory);

  if (execution.script !== undefined) {
    const scriptFile = await writeInlineAutomationScript({
      dataDir: args.pluginDataDir,
      automationId: args.automationId,
      content: execution.script,
      scriptFile: execution.scriptFile,
    });

    const { script: _script, ...rest } = execution;

    return {
      execution: { ...rest, scriptFile },
      writtenScriptFile: scriptFile,
    };
  }

  return { execution };
}

async function applyScriptExecutionUpdate(args: {
  pluginDataDir: string;
  automationId: string;
  current: Extract<AutomationExecution, { mode: "script" }>;
  update: ScriptExecutionUpdate;
}): Promise<ResolvedStoredExecution> {
  const { current, update } = args;

  if (update.workingDirectory !== undefined) {
    validateScriptWorkingDirectory(update.workingDirectory);
  }

  const { env: currentEnv, ...settings } = current;
  const env = update.env ?? currentEnv;

  const next = {
    ...settings,
    ...(update.interpreter !== undefined
      ? { interpreter: update.interpreter }
      : {}),
    ...(update.timeoutMs !== undefined ? { timeoutMs: update.timeoutMs } : {}),
    ...(update.workingDirectory !== undefined
      ? { workingDirectory: update.workingDirectory }
      : {}),
    ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
  };

  if (update.script === undefined) return { execution: next };

  const scriptFile = await writeInlineAutomationScript({
    dataDir: args.pluginDataDir,
    automationId: args.automationId,
    content: update.script,
    scriptFile: update.scriptFile ?? current.scriptFile,
  });

  const { script: _script, ...rest } = next;

  return {
    execution: { ...rest, scriptFile },
    writtenScriptFile: scriptFile,
  };
}

async function discardUncommittedScript(args: {
  api: Pick<ServiceApi, "log">;
  pluginDataDir: string;
  automationId: string;
  scriptFile: string | undefined;
}): Promise<void> {
  if (args.scriptFile === undefined) return;

  try {
    await deleteAutomationScriptFile({
      dataDir: args.pluginDataDir,
      automationId: args.automationId,
      scriptFile: args.scriptFile,
    });
  } catch (error) {
    args.api.log.warn(
      `Failed to discard uncommitted script for automation ${args.automationId}: ${errorMessage(error)}`,
    );
  }
}

function withStoredScriptPath(
  pluginDataDir: string,
  automation: AutomationResponse,
): AutomationResponse {
  if (
    automation.execution.mode !== "script" ||
    automation.execution.scriptFile === undefined
  ) {
    return automation;
  }

  return {
    ...automation,
    execution: {
      ...automation.execution,
      storedScriptPath: join(
        automationScriptDir(pluginDataDir, automation.id),
        automation.execution.scriptFile,
      ),
    },
  };
}

function scriptEnv(
  execution: AutomationExecution,
): Readonly<Record<string, string>> | undefined {
  return execution.mode === "script" ? execution.env : undefined;
}

function toStoredAutomationResponse(
  pluginDataDir: string,
  env: AutomationEnvValues,
  row: AutomationRow,
): AutomationResponse {
  return withStoredScriptPath(pluginDataDir, toAutomationResponse(row, env));
}

type AutomationWriteOperation = "run" | "pause" | "resume" | "update";

const MISSING_PROMPT_OPERATION: Record<AutomationWriteOperation, string> = {
  run: "it can run",
  pause: "it can be paused",
  resume: "it can be resumed",
  update: "other fields can be updated",
};

const INVALID_DATA_OPERATION: Record<AutomationWriteOperation, string> = {
  run: "run",
  pause: "paused",
  resume: "resumed",
  update: "updated",
};

function automationWriteError(
  row: AutomationRow,
  operation: AutomationWriteOperation,
  problem: AutomationReadProblem["problem"],
): Error {
  return problem === "missing-agent-prompt"
    ? new Error(
        `Automation "${row.name}" requires a prompt before ${MISSING_PROMPT_OPERATION[operation]}. Edit it and add a prompt first.`,
      )
    : new Error(
        `Automation "${row.name}" has invalid stored data and cannot be ${INVALID_DATA_OPERATION[operation]}. Delete it and recreate it.`,
      );
}

function requireCanonicalAutomationForWrite(
  pluginDataDir: string,
  env: AutomationEnvValues,
  row: AutomationRow,
  operation: AutomationWriteOperation,
): AutomationResponse {
  const decoded = decodeAutomationRow(row, env);

  if ("error" in decoded) {
    throw automationWriteError(row, operation, decoded.automation.problem);
  }

  return withStoredScriptPath(pluginDataDir, decoded.automation);
}

function toStoredAutomationReadResult(
  api: Pick<ServiceApi, "log">,
  pluginDataDir: string,
  env: AutomationEnvValues,
  row: AutomationRow,
): AutomationReadResult {
  const decoded = decodeAutomationRow(row, env);

  if (!("error" in decoded)) {
    return withStoredScriptPath(pluginDataDir, decoded.automation);
  }

  if (decoded.automation.problem === "invalid-stored-data") {
    api.log.warn(
      `Malformed stored automation ${row.id}: ${decoded.error.message}`,
    );
  }

  return decoded.automation;
}

async function resolveWorkingDirectoryForDisplay(args: {
  api: Pick<ServiceApi, "log" | "sdk">;
  pluginDataDir: string;
  scriptHostRouting?: ScriptHostRouting;
  automation: AutomationResponse;
  workingDirectory: AutomationScriptWorkingDirectory;
}): Promise<string | null> {
  try {
    const serverHostId = (await args.api.sdk.system.config()).primaryHostId;
    const hostId = args.scriptHostRouting?.hostId(serverHostId) ?? serverHostId;

    if (
      args.workingDirectory.type === "automation-storage" &&
      hostId !== serverHostId
    )
      return null;

    const resolve = createScriptWorkingDirectoryResolver({
      sdk: args.api.sdk,
      pluginDataDir: args.pluginDataDir,
      serverHostId: hostId,
    });

    return await resolve(args.automation.projectId, args.workingDirectory);
  } catch (error) {
    args.api.log.warn(
      `Failed to resolve working directory for automation ${args.automation.id}: ${errorMessage(error)}`,
    );

    return null;
  }
}

async function withResolvedWorkingDirectory(args: {
  api: Pick<ServiceApi, "log" | "sdk">;
  pluginDataDir: string;
  scriptHostRouting?: ScriptHostRouting;
  automation: AutomationResponse;
}): Promise<AutomationDetailResponse> {
  const { automation } = args;
  const { execution } = automation;

  if (execution.mode !== "script") return { ...automation, execution };

  return {
    ...automation,
    execution: {
      ...execution,
      resolvedWorkingDirectory: await resolveWorkingDirectoryForDisplay({
        api: args.api,
        pluginDataDir: args.pluginDataDir,
        scriptHostRouting: args.scriptHostRouting,
        automation,
        workingDirectory: execution.workingDirectory,
      }),
    },
  };
}

async function toEditableAutomationResponse(args: {
  api: Pick<ServiceApi, "log" | "sdk">;
  pluginDataDir: string;
  scriptHostRouting?: ScriptHostRouting;
  automation: AutomationResponse;
}): Promise<AutomationDetailResponse> {
  const detail = await withResolvedWorkingDirectory(args);
  const { execution } = detail;

  if (execution.mode !== "script" || execution.scriptFile === undefined) {
    return detail;
  }

  const { scriptFile, ...rest } = execution;

  return {
    ...detail,
    execution: {
      ...rest,
      script: await readAutomationScript({
        dataDir: args.pluginDataDir,
        automationId: detail.id,
        scriptFile,
      }),
    },
  };
}

async function toEditableAutomationReadResult(args: {
  api: Pick<ServiceApi, "log" | "sdk">;
  pluginDataDir: string;
  env: AutomationEnvValues;
  scriptHostRouting?: ScriptHostRouting;
  row: AutomationRow;
}): Promise<AutomationDetailReadResult> {
  const automation = toStoredAutomationReadResult(
    args.api,
    args.pluginDataDir,
    args.env,
    args.row,
  );

  if ("problem" in automation) return automation;

  return toEditableAutomationResponse({
    api: args.api,
    pluginDataDir: args.pluginDataDir,
    scriptHostRouting: args.scriptHostRouting,
    automation,
  });
}

async function cleanupSupersededScript(args: {
  api: Pick<ServiceApi, "log">;
  pluginDataDir: string;
  automationId: string;
  previous: AutomationExecution;
  next: AutomationExecution;
}): Promise<void> {
  if (args.previous.mode !== "script") return;

  try {
    if (args.next.mode !== "script") {
      await deleteAutomationScriptDir({
        dataDir: args.pluginDataDir,
        automationId: args.automationId,
      });

      return;
    }

    if (
      args.previous.scriptFile !== undefined &&
      args.next.scriptFile !== undefined &&
      args.previous.scriptFile !== args.next.scriptFile
    ) {
      await deleteAutomationScriptFile({
        dataDir: args.pluginDataDir,
        automationId: args.automationId,
        scriptFile: args.previous.scriptFile,
      });
    }
  } catch (error) {
    args.api.log.warn(
      `Failed to remove superseded script for automation ${args.automationId}: ${errorMessage(error)}`,
    );
  }
}

function encodeRunCursor(startedAt: number, id: string): string {
  return Buffer.from(`${startedAt}:${id}`, "utf8").toString("base64url");
}

function applyAgentExecutionUpdate(
  execution: AutomationExecution,
  update: AgentExecutionUpdate,
): Extract<AutomationExecution, { mode: "agent" }> {
  if (execution.mode !== "agent") {
    throw new Error(
      "Agent execution options can only update agent automations",
    );
  }

  const next = {
    ...execution,
    ...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
    ...(update.providerId !== undefined
      ? { providerId: update.providerId }
      : {}),
    ...(update.model !== undefined ? { model: update.model } : {}),
    ...(update.reasoningLevel !== undefined
      ? { reasoningLevel: update.reasoningLevel }
      : {}),
    ...(update.permissionMode !== undefined
      ? { permissionMode: update.permissionMode }
      : {}),
  };

  if (update.serviceTier === null) {
    delete next.serviceTier;
  } else if (update.serviceTier !== undefined) {
    next.serviceTier = update.serviceTier;
  }

  if (update.target === undefined) return next;

  if (update.target.type === "target-thread") {
    return { ...next, targetThreadId: update.target.threadId };
  }

  const { targetThreadId: _targetThreadId, ...withoutTargetThread } = next;

  return {
    ...withoutTargetThread,
    environment: update.target.environment,
  };
}

function parseRunCursor(
  cursor: string | undefined,
): { startedAt: number; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");

  if (separator <= 0) throw new Error("Invalid runs cursor");
  const startedAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isFinite(startedAt) || id.length === 0) {
    throw new Error("Invalid runs cursor");
  }

  return { startedAt, id };
}

function toAutomationOverview(
  automation: AutomationReadResult,
): AutomationOverview | AutomationReadProblem {
  if ("problem" in automation || automation.execution.mode !== "agent") {
    return automation;
  }

  const { prompt: _prompt, ...execution } = automation.execution;

  return { ...automation, execution };
}

async function projectNameById(
  api: Pick<ServiceApi, "sdk" | "log">,
): Promise<Map<string, string>> {
  try {
    const projects = projectSummaryListSchema.parse(
      await api.sdk.projects.list({ includePersonal: true }),
    );

    return new Map(
      projects
        .filter(
          (project) =>
            project.deletedAt === undefined || project.deletedAt === null,
        )
        .map((project) => [project.id, project.name ?? project.id]),
    );
  } catch (error) {
    api.log.warn(
      `Failed to list projects for automations overview: ${errorMessage(error)}`,
    );

    return new Map();
  }
}

const projectAvailableSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["standard", "personal"]),
    sources: z.array(z.unknown()),
  })
  .passthrough();

const projectSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    deletedAt: z.number().nullable().optional(),
  })
  .passthrough();

const projectSummaryListSchema = z.array(projectSummarySchema);

async function requireProjectAvailable(
  api: Pick<ServiceApi, "sdk">,
  projectId: string,
): Promise<z.infer<typeof projectAvailableSchema>> {
  try {
    return projectAvailableSchema.parse(
      await api.sdk.projects.get({ projectId }),
    );
  } catch (error) {
    throw new Error(
      `Project ${projectId} is not available: ${errorMessage(error)}`,
    );
  }
}

function defaultScriptWorkingDirectory(
  project: z.infer<typeof projectAvailableSchema>,
  serverHostId: string | null,
): AutomationScriptWorkingDirectory {
  if (
    project.kind === "personal" ||
    serverHostId === null ||
    projectPathForHost(project, serverHostId) === null
  ) {
    return AUTOMATION_STORAGE_WORKING_DIRECTORY;
  }

  return PROJECT_WORKING_DIRECTORY;
}

export function createAutomationService(args: {
  api: ServiceApi;
  db: Db;
  env: AutomationEnvStore;
  pluginDataDir: string;
  scriptHostRouting?: ScriptHostRouting;
  workflows?: ReturnType<typeof createWorkflowDispatch>;
}): AutomationService {
  const { api, db, env, pluginDataDir, scriptHostRouting } = args;

  const executionHostId = async () => {
    const primaryHostId = (await api.sdk.system.config()).primaryHostId;

    return scriptHostRouting?.hostId(primaryHostId) ?? primaryHostId;
  };

  return {
    async overview() {
      const projects = await projectNameById(api);
      const automations: AutomationsOverviewResponse["automations"] = [];

      for (const row of listAllAutomations(db)) {
        const projectName = projects.get(row.projectId);

        automations.push({
          automation: toAutomationOverview(
            toStoredAutomationReadResult(api, pluginDataDir, env, row),
          ),
          project: {
            id: row.projectId,
            name: projectName ?? row.projectId,
          },
        });
      }

      return automationsOverviewResponseSchema.parse({ automations });
    },

    list(input) {
      return listAutomationsForProject(db, input.projectId).map((row) =>
        toStoredAutomationReadResult(api, pluginDataDir, env, row),
      );
    },

    get(input) {
      return toEditableAutomationReadResult({
        api,
        pluginDataDir,
        env,
        scriptHostRouting,
        row: requireProjectAutomation(db, input),
      });
    },

    async create(payload) {
      const project = await requireProjectAvailable(api, payload.projectId);
      const now = Date.now();
      validateTrigger(payload.trigger, now);
      await assertNotRecursiveCreation(api, db, payload.createdByThreadId);

      if (payload.execution.mode === "agent") {
        await resolvePermissionMode(
          api,
          payload.execution.providerId,
          payload.execution.permissionMode,
          providerRoutingForEnvironment(payload.execution.environment),
        );
      }

      const automationId = createAutomationId();

      const stored = await resolveStoredExecution({
        pluginDataDir,
        automationId,
        execution: payload.execution,
        defaultWorkingDirectory:
          payload.execution.mode === "script" &&
          payload.execution.workingDirectory === undefined
            ? defaultScriptWorkingDirectory(project, await executionHostId())
            : AUTOMATION_STORAGE_WORKING_DIRECTORY,
      });

      let created: AutomationRow;

      try {
        await env.write(automationId, scriptEnv(stored.execution));
        created = createAutomation(db, {
          id: automationId,
          projectId: payload.projectId,
          name: payload.name,
          enabled: payload.enabled,
          trigger: payload.trigger,
          runMode: stored.execution.mode,
          execution: stored.execution,
          origin: payload.origin,
          createdByThreadId: payload.createdByThreadId ?? null,
          nextRunAt: computeInitialNextRunAt({
            trigger: payload.trigger,
            enabled: payload.enabled,
            now,
          }),
        });
      } catch (error) {
        await discardUncommittedScript({
          api,
          pluginDataDir,
          automationId,
          scriptFile: stored.writtenScriptFile,
        });
        await env.write(automationId, undefined);
        throw error;
      }

      publishAutomationChange(api, payload.projectId, "automations-changed");

      return withResolvedWorkingDirectory({
        api,
        pluginDataDir,
        scriptHostRouting,
        automation: toStoredAutomationResponse(pluginDataDir, env, created),
      });
    },

    async update(input) {
      const project = await requireProjectAvailable(api, input.projectId);
      const current = requireProjectAutomation(db, input);
      const currentAutomation = decodeAutomationRow(current, env).automation;

      if (
        "problem" in currentAutomation &&
        currentAutomation.problem === "invalid-stored-data"
      ) {
        throw automationWriteError(
          current,
          "update",
          currentAutomation.problem,
        );
      }

      if (
        [input.execution, input.agent, input.script].filter(
          (entry) => entry !== undefined,
        ).length > 1
      ) {
        throw new Error(
          "execution, agent, and script updates cannot be combined",
        );
      }

      const now = Date.now();
      const currentExecution = currentAutomation.execution;

      if (currentExecution.mode === "workflow")
        throw new Error("Edit an imported workflow through its setup.");
      let stagedScriptFile: string | undefined;
      const patch: Parameters<typeof updateAutomation>[2]["patch"] = {};

      if (input.name !== undefined) patch.name = input.name;

      if (input.trigger !== undefined) {
        validateTrigger(input.trigger, now);
        patch.trigger = input.trigger;
        patch.nextRunAt = current.enabled
          ? computeNextRunAt(input.trigger, now)
          : null;
      }

      if (input.execution !== undefined) {
        if (input.execution.mode === "agent") {
          await resolvePermissionMode(
            api,
            input.execution.providerId,
            input.execution.permissionMode,
            providerRoutingForEnvironment(input.execution.environment),
          );
        }

        const stored = await resolveStoredExecution({
          pluginDataDir,
          automationId: current.id,
          execution: input.execution,
          defaultWorkingDirectory:
            currentExecution.mode === "script"
              ? currentExecution.workingDirectory
              : input.execution.mode === "script" &&
                  input.execution.workingDirectory === undefined
                ? defaultScriptWorkingDirectory(
                    project,
                    await executionHostId(),
                  )
                : AUTOMATION_STORAGE_WORKING_DIRECTORY,
        });

        patch.execution = stored.execution;
        stagedScriptFile = stored.writtenScriptFile;
      }

      if (input.agent !== undefined) {
        const updatedExecution = applyAgentExecutionUpdate(
          currentExecution,
          input.agent,
        );

        if (
          input.agent.providerId !== undefined ||
          input.agent.permissionMode !== undefined ||
          input.agent.target?.type === "environment"
        ) {
          await resolvePermissionMode(
            api,
            updatedExecution.providerId,
            updatedExecution.permissionMode,
            providerRoutingForEnvironment(updatedExecution.environment),
          );
        }

        patch.execution = updatedExecution;
      }

      if (input.script !== undefined) {
        if (currentExecution.mode !== "script") {
          throw new Error(
            "Script execution options can only update script automations",
          );
        }

        const stored = await applyScriptExecutionUpdate({
          pluginDataDir,
          automationId: current.id,
          current: currentExecution,
          update: input.script,
        });

        patch.execution = stored.execution;
        stagedScriptFile = stored.writtenScriptFile;
      }

      if (
        "problem" in currentAutomation &&
        currentAutomation.problem === "missing-agent-prompt" &&
        (patch.execution === undefined ||
          (patch.execution.mode === "agent" && patch.execution.prompt === ""))
      ) {
        throw automationWriteError(
          current,
          "update",
          currentAutomation.problem,
        );
      }

      const previousEnv = env.values(current.id);

      const nextEnv =
        patch.execution === undefined
          ? previousEnv
          : scriptEnv(patch.execution);

      let updated: AutomationRow | null;

      try {
        await env.write(current.id, { ...previousEnv, ...nextEnv });
        updated = updateAutomation(db, env, {
          projectId: input.projectId,
          automationId: input.automationId,
          patch,
        });
      } catch (error) {
        await discardUncommittedScript({
          api,
          pluginDataDir,
          automationId: current.id,
          scriptFile: stagedScriptFile,
        });
        await env.write(current.id, previousEnv);
        throw error;
      }

      if (!updated) {
        await discardUncommittedScript({
          api,
          pluginDataDir,
          automationId: current.id,
          scriptFile: stagedScriptFile,
        });
        await env.write(current.id, previousEnv);
        throw new Error("Automation not found");
      }

      await env.write(current.id, nextEnv);

      if (patch.execution !== undefined) {
        await cleanupSupersededScript({
          api,
          pluginDataDir,
          automationId: current.id,
          previous: currentExecution,
          next: patch.execution,
        });
      }

      publishAutomationChange(api, input.projectId, "automations-changed");

      return withResolvedWorkingDirectory({
        api,
        pluginDataDir,
        scriptHostRouting,
        automation: toStoredAutomationResponse(pluginDataDir, env, updated),
      });
    },

    async delete(input) {
      const automation = requireProjectAutomation(db, input);
      deleteAutomation(db, input);
      await env.write(automation.id, undefined);
      await deleteAutomationScriptDir({
        dataDir: pluginDataDir,
        automationId: automation.id,
      });
      publishAutomationChange(api, input.projectId, [
        "automations-changed",
        "automation-runs-changed",
      ]);

      return { ok: true };
    },

    pause(input) {
      const current = requireProjectAutomation(db, input);
      requireCanonicalAutomationForWrite(pluginDataDir, env, current, "pause");

      const updated = setAutomationEnabled(db, {
        projectId: input.projectId,
        automationId: current.id,
        enabled: false,
        nextRunAt: null,
      });

      if (!updated) throw new Error("Automation not found");
      publishAutomationChange(api, input.projectId, "automations-changed");

      return toStoredAutomationResponse(pluginDataDir, env, updated);
    },

    resume(input) {
      const current = requireProjectAutomation(db, input);

      const canonical = requireCanonicalAutomationForWrite(
        pluginDataDir,
        env,
        current,
        "resume",
      );

      const { trigger } = canonical;

      if (canonical.execution.mode === "workflow")
        throw new Error("Enable the schedule from the workflow setup.");
      const now = Date.now();
      validateTrigger(trigger, now);

      const updated = setAutomationEnabled(db, {
        projectId: input.projectId,
        automationId: current.id,
        enabled: true,
        nextRunAt: computeNextRunAt(trigger, now),
        lastError: null,
        resetConsecutiveFailures: true,
      });

      if (!updated) throw new Error("Automation not found");
      publishAutomationChange(api, input.projectId, "automations-changed");

      return toStoredAutomationResponse(pluginDataDir, env, updated);
    },

    async run(input) {
      const automation = requireProjectAutomation(db, input);

      const { execution } = requireCanonicalAutomationForWrite(
        pluginDataDir,
        env,
        automation,
        "run",
      );

      const now = Date.now();

      const workflows = args.workflows;

      const prepared =
        execution.mode === "workflow"
          ? await workflows?.prepare(automation)
          : undefined;

      if (execution.mode === "workflow" && !prepared)
        throw new Error("Workflow dispatch is unavailable.");

      const { run, deduped } = createManualRun(db, {
        automationId: automation.id,
        runMode: automation.runMode,
        idempotencyKey: input.idempotencyKey ?? null,
        now,
        persistClaim: prepared?.persist,
      });

      if (!deduped) {
        publishAutomationChange(
          api,
          input.projectId,
          "automation-runs-changed",
        );

        const closeFailedRun = (error: unknown): void => {
          closeAutomationRun(db, {
            runId: run.id,
            status: "failed",
            error: errorMessage(error),
            now: Date.now(),
          });
        };

        void (async () => {
          try {
            if (execution.mode === "agent") {
              await executeAgentRun(api, db, {
                automation,
                run,
                execution,
                onFailure: closeFailedRun,
              });
            } else if (execution.mode === "workflow") {
              await workflows?.reconcile(run);
            } else {
              await executeScriptRun(api, db, {
                pluginDataDir,
                automation,
                run,
                execution,
                onFailure: closeFailedRun,
                scriptHostRouting,
                resolveWorkingDirectory: createScriptWorkingDirectoryResolver({
                  sdk: api.sdk,
                  pluginDataDir,
                  serverHostId: await executionHostId(),
                }),
              });
            }
          } catch (error) {
            closeFailedRun(error);
            api.log.error(
              `Manual automation run ${run.id} failed unexpectedly: ${errorMessage(error)}`,
            );
            publishAutomationChange(api, input.projectId, [
              "automations-changed",
              "automation-runs-changed",
            ]);
          }
        })();
      }

      return { run: toAutomationRunResponse(run) };
    },

    runs(input) {
      requireProjectAutomation(db, input);
      const limit = Math.min(input.limit, AUTOMATION_RUNS_LIMIT_MAX);

      const runs = listAutomationRuns(db, {
        automationId: input.automationId,
        limit: limit + 1,
        cursor: parseRunCursor(input.cursor),
      });

      const hasMore = runs.length > limit;
      const page = hasMore ? runs.slice(0, limit) : runs;
      const last = page[page.length - 1];

      return automationRunListResponseSchema.parse({
        runs: page.map(toAutomationRunResponse),
        nextCursor:
          hasMore && last ? encodeRunCursor(last.startedAt, last.id) : null,
      });
    },
  };
}
