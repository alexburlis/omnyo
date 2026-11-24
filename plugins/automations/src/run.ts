import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  automationRunOwnsLatestRequest,
  recoverAutomationAgentRun,
} from "./agent-retry.js";
import {
  closeAutomationRun,
  disableAutomationsForTargetThread,
  getAutomation,
  listRunningAutomationRuns,
  listRunningAutomationRunsByThread,
  setAutomationEnabled,
  setAutomationRunThread,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import { executeStoredScript, mapScriptResultToRun } from "./script-runner.js";
import type { ScriptHostRouting } from "./script-host.js";
import type { AutomationExecution } from "./rpc-types.js";
import type {
  ProjectsSdk,
  ScriptWorkingDirectoryResolver,
} from "./working-directory.js";

type RunFailureHandler = (error: unknown) => void;

type AgentThreadsSdk = {
  events: Pick<PluginApi["sdk"]["threads"]["events"], "list">;
  get(
    args: Parameters<PluginApi["sdk"]["threads"]["get"]>[0],
  ): Promise<unknown>;
  send(
    args: Parameters<PluginApi["sdk"]["threads"]["send"]>[0],
  ): Promise<unknown>;
  spawn(
    args: Parameters<PluginApi["sdk"]["threads"]["spawn"]>[0],
  ): Promise<unknown>;
  retry: PluginApi["sdk"]["threads"]["retry"];
};

type AgentInboxSdk = Pick<
  PluginApi["sdk"]["experimental_inbox"],
  "waits" | "cancelWait" | "registerWait"
>;

export type AgentRunApi = Pick<PluginApi, "realtime" | "log"> & {
  sdk: { threads: AgentThreadsSdk; experimental_inbox: AgentInboxSdk };
};

const TARGET_CONTINUATION_GRACE_MS = 60 * 60 * 1_000;

const WAIT_FOR_MAX = 60;

export type ScriptRunApi = Pick<PluginApi, "realtime" | "log"> & {
  sdk: { projects: ProjectsSdk };
  server: Pick<PluginApi["server"], "loopbackBaseUrl">;
};

const sdkThreadSchema = z
  .object({
    id: z.string(),
    archivedAt: z.number().nullable(),
    deletedAt: z.number().nullable(),
    status: z.enum([
      "pending",
      "idle",
      "active",
      "starting",
      "stopping",
      "error",
    ]),
  })
  .passthrough();

type SdkThread = z.infer<typeof sdkThreadSchema>;

const projectGoneErrorSchema = z
  .object({
    status: z.literal(404),
    code: z.enum(["project_not_found", "project_unavailable"]),
  })
  .passthrough();

const threadGoneErrorSchema = z
  .object({ status: z.literal(404) })
  .passthrough();

function isThreadGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return threadGoneErrorSchema.safeParse(error).success;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProjectGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return projectGoneErrorSchema.safeParse(error).success;
}

function renderAutomationDueMessage(args: {
  automationId: string;
  prompt: string;
}): string {
  return `[omnyo automation due:${args.automationId}]\n\n${args.prompt}`;
}

function unusableThreadReason(thread: SdkThread): string | null {
  if (thread.deletedAt !== null) return "was deleted";

  if (thread.archivedAt !== null) return "was archived";

  switch (thread.status) {
    case "idle":
    case "active":
    case "error":
      return null;
    case "pending":
    case "starting":
    case "stopping":
      return `is ${thread.status}`;
  }
}

interface AgentRunArgs {
  automation: AutomationRow;
  run: AutomationRunRow;
  execution: Extract<AutomationExecution, { mode: "agent" }>;
  onFailure: RunFailureHandler;
  retryRun?: AutomationRunRow;
}

export async function executeAgentRun(
  api: AgentRunApi,
  db: Db,
  args: AgentRunArgs,
): Promise<void> {
  try {
    if (args.retryRun !== undefined) {
      await recoverAutomationAgentRun(api, db, {
        automation: args.automation,
        run: args.run,
        failedRun: args.retryRun,
      });

      return;
    }

    if (args.automation.targetThreadId !== null) {
      await reuseTargetThreadForRun(api, db, {
        ...args,
        targetThreadId: args.automation.targetThreadId,
      });

      return;
    }

    const thread = sdkThreadSchema.parse(
      await api.sdk.threads.spawn({
        projectId: args.automation.projectId,
        environment: args.execution.environment,
        prompt: renderAutomationDueMessage({
          automationId: args.automation.id,
          prompt: args.execution.prompt,
        }),
        title: args.automation.name,
        pluginMetadata: {
          automationId: args.automation.id,
          runId: args.run.id,
        },
        providerId: args.execution.providerId,
        model: args.execution.model,
        reasoningLevel: args.execution.reasoningLevel,
        ...(args.execution.serviceTier === undefined
          ? {}
          : { serviceTier: args.execution.serviceTier }),
        permissionMode: args.execution.permissionMode,
      }),
    );

    setAutomationRunThread(db, { runId: args.run.id, threadId: thread.id });
  } catch (error) {
    settleDispatchFailure(api, db, args, error);
  } finally {
    publishAutomationChange(api, args.automation.projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

function settleDispatchFailure(
  api: Pick<PluginApi, "log">,
  db: Db,
  args: AgentRunArgs,
  error: unknown,
): void {
  const message = errorMessage(error);

  if (isProjectGoneError(error)) {
    setAutomationEnabled(db, {
      projectId: args.automation.projectId,
      automationId: args.automation.id,
      enabled: false,
      nextRunAt: null,
      lastError: message,
    });
    closeAutomationRun(db, {
      runId: args.run.id,
      status: "failed",
      error: message,
      now: Date.now(),
    });
  } else {
    args.onFailure(error);
  }

  api.log.error(
    `Failed to dispatch automation ${args.automation.id}: ${message}`,
  );
}

async function reuseTargetThreadForRun(
  api: AgentRunApi,
  db: Db,
  args: AgentRunArgs & { targetThreadId: string },
): Promise<void> {
  let thread: SdkThread;

  try {
    thread = sdkThreadSchema.parse(
      await api.sdk.threads.get({ threadId: args.targetThreadId }),
    );
  } catch (error) {
    if (!isThreadGoneError(error)) throw error;
    closeRunForUnusableTargetThread(api, db, {
      ...args,
      reason: "no longer exists",
    });

    return;
  }

  const unusableReason = unusableThreadReason(thread);

  if (unusableReason !== null) {
    closeRunForUnusableTargetThread(api, db, {
      ...args,
      reason: unusableReason,
    });

    return;
  }

  setAutomationRunThread(db, {
    runId: args.run.id,
    threadId: args.targetThreadId,
  });
  await api.sdk.threads.send({
    threadId: args.targetThreadId,
    mode: "steer-if-active",
    input: [
      {
        type: "text",
        text: renderAutomationDueMessage({
          automationId: args.automation.id,
          prompt: args.execution.prompt,
        }),
        mentions: [],
      },
    ],
    permissionMode: args.execution.permissionMode,
  });
  await renewTargetContinuation(api, db, {
    automationId: args.automation.id,
    name: args.automation.name,
    targetThreadId: args.targetThreadId,
  });
}

async function renewTargetContinuation(
  api: AgentRunApi,
  db: Db,
  args: { automationId: string; name: string; targetThreadId: string },
): Promise<void> {
  const key = `automation-run:${args.automationId}`;
  const nextRunAt = getAutomation(db, args.automationId)?.nextRunAt ?? null;
  const label = `${args.name} runs again`;

  try {
    const { waits } = await api.sdk.experimental_inbox.waits({
      threadId: args.targetThreadId,
    });

    for (const wait of waits)
      if (wait.key === key)
        await api.sdk.experimental_inbox.cancelWait({
          threadId: args.targetThreadId,
          waitId: wait.id,
        });

    if (nextRunAt === null) return;

    await api.sdk.experimental_inbox.registerWait({
      threadId: args.targetThreadId,
      wait: {
        key,
        for:
          label.length <= WAIT_FOR_MAX
            ? label
            : `${label.slice(0, WAIT_FOR_MAX - 1)}…`,
        events: [key],
        by: nextRunAt + TARGET_CONTINUATION_GRACE_MS,
      },
    });
  } catch (error) {
    api.log.warn(
      `Automation ${args.automationId} kept no wait on ${args.targetThreadId}: ${errorMessage(error)}`,
    );
  }
}

function closeRunForUnusableTargetThread(
  api: Pick<PluginApi, "log">,
  db: Db,
  args: AgentRunArgs & { targetThreadId: string; reason: string },
): void {
  const now = Date.now();
  const error = `Target thread ${args.targetThreadId} ${args.reason}`;
  disableAutomationsForTargetThread(db, {
    threadId: args.targetThreadId,
    error,
    now,
  });
  closeAutomationRun(db, {
    runId: args.run.id,
    status: "failed",
    error,
    now,
  });
  api.log.error(`Automation ${args.automation.id} paused: ${error}`);
}

export async function executeScriptRun(
  api: ScriptRunApi,
  db: Db,
  args: {
    pluginDataDir: string;
    automation: AutomationRow;
    run: AutomationRunRow;
    execution: Extract<AutomationExecution, { mode: "script" }>;
    onFailure: RunFailureHandler;
    resolveWorkingDirectory: ScriptWorkingDirectoryResolver;
    scriptHostRouting?: ScriptHostRouting;
  },
): Promise<void> {
  try {
    const scriptFile = args.execution.scriptFile;

    if (scriptFile === undefined) {
      closeAutomationRun(db, {
        runId: args.run.id,
        status: "failed",
        error: "Script automation is missing a stored script file",
        now: Date.now(),
      });

      return;
    }

    const workingDir = await args.resolveWorkingDirectory(
      args.automation.projectId,
      args.execution.workingDirectory,
    );

    if (workingDir === null) {
      throw new Error(
        `Project ${args.automation.projectId} has no source on the Omnyo server host`,
      );
    }

    const runArgs = {
      pluginDataDir: args.pluginDataDir,
      automationId: args.automation.id,
      runId: args.run.id,
      projectId: args.automation.projectId,
      scriptFile,
      interpreter: args.execution.interpreter,
      timeoutMs: args.execution.timeoutMs,
      env: args.execution.env,
      serverUrl: api.server.loopbackBaseUrl,
      workingDir,
    };

    const result = args.scriptHostRouting
      ? await args.scriptHostRouting.execute(
          runArgs,
          args.execution.workingDirectory,
        )
      : await executeStoredScript(runArgs);

    const mapped = mapScriptResultToRun(result);
    closeAutomationRun(db, {
      runId: args.run.id,
      status: mapped.status,
      skipReason: mapped.skipReason,
      output: mapped.output,
      exitCode: mapped.exitCode,
      error: mapped.error,
      now: Date.now(),
    });
  } catch (error) {
    if (isScriptHostOffline(error)) {
      closeAutomationRun(db, {
        runId: args.run.id,
        status: "skipped",
        skipReason: `script host offline: ${errorMessage(error)}`,
        now: Date.now(),
      });
      api.log.warn(
        `Skipped automation ${args.automation.id}: its script host is offline`,
      );

      return;
    }

    args.onFailure(error);
    api.log.error(
      `Failed to run script for automation ${args.automation.id}: ${errorMessage(error)}`,
    );
  } finally {
    publishAutomationChange(api, args.automation.projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

function isScriptHostOffline(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body: unknown = Reflect.get(error, "body");

  return (
    typeof body === "object" &&
    body !== null &&
    ["host_unavailable", "host_disconnected"].includes(
      String(Reflect.get(body, "code")),
    )
  );
}

export async function closeAutomationRunForSettledThread(
  api: AgentRunApi,
  db: Db,
  args:
    | { threadId: string; status: "idle" }
    | {
        threadId: string;
        status: "failed";
        error: string | null;
        transientFailure: boolean;
      },
): Promise<void> {
  const runs = listRunningAutomationRunsByThread(db, args.threadId);
  const now = Date.now();
  const changedProjects = new Set<string>();

  for (const run of runs) {
    const ownsRequest = await automationRunOwnsLatestRequest(api, run);

    const closed = closeAutomationRun(db, {
      runId: run.id,
      status: !ownsRequest
        ? "skipped"
        : args.status === "idle"
          ? "succeeded"
          : "failed",
      skipReason: ownsRequest
        ? null
        : "superseded: the original thread has a different turn request",
      error: args.status === "idle" ? null : (args.error ?? "Turn failed"),
      transientFailure: args.status === "failed" && args.transientFailure,
      threadId: args.threadId,
      now,
    });

    if (!closed) continue;
    const automation = getAutomation(db, closed.automationId);

    if (automation) changedProjects.add(automation.projectId);
  }

  for (const projectId of changedProjects) {
    publishAutomationChange(api, projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

type ReconcileOutcome =
  | { status: "succeeded"; skipReason: string }
  | { status: "failed"; error: string; transientFailure: true }
  | { status: "skipped"; skipReason: string };

export async function reconcileRunningAutomationRuns(
  api: AgentRunApi,
  db: Db,
): Promise<void> {
  const changedProjects = new Set<string>();

  for (const run of listRunningAutomationRuns(db)) {
    if (run.runMode === "workflow") continue;
    const outcome = await reconcileOutcome(api, run);

    if (outcome === null) continue;

    const closed = closeAutomationRun(db, {
      runId: run.id,
      ...outcome,
      now: Date.now(),
    });

    if (!closed) continue;
    const automation = getAutomation(db, closed.automationId);

    if (automation) changedProjects.add(automation.projectId);
    api.log.info(
      `Automation run ${run.id} settled as ${outcome.status} on startup: ${
        outcome.status === "failed" ? outcome.error : outcome.skipReason
      }`,
    );
  }

  for (const projectId of changedProjects) {
    publishAutomationChange(api, projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

async function reconcileOutcome(
  api: AgentRunApi,
  run: AutomationRunRow,
): Promise<ReconcileOutcome | null> {
  if (run.runMode === "script") {
    return {
      status: "skipped",
      skipReason:
        "interrupted: the server restarted while the script was running",
    };
  }

  if (run.threadId === null) {
    return {
      status: "skipped",
      skipReason:
        "interrupted: the server restarted before a thread was attached",
    };
  }

  let thread: SdkThread;

  try {
    thread = sdkThreadSchema.parse(
      await api.sdk.threads.get({ threadId: run.threadId }),
    );
  } catch (error) {
    if (isThreadGoneError(error)) {
      return {
        status: "skipped",
        skipReason: `interrupted: thread ${run.threadId} no longer exists`,
      };
    }

    api.log.warn(
      `Could not check thread ${run.threadId} for running automation run ${run.id}; leaving it running: ${errorMessage(error)}`,
    );

    return null;
  }

  if (thread.deletedAt !== null || thread.archivedAt !== null) {
    return {
      status: "skipped",
      skipReason: `interrupted: thread ${run.threadId} was ${
        thread.deletedAt !== null ? "deleted" : "archived"
      }`,
    };
  }

  if (!(await automationRunOwnsLatestRequest(api, run))) {
    return {
      status: "skipped",
      skipReason:
        "superseded: the original thread has a different turn request",
    };
  }

  switch (thread.status) {
    case "idle":
      return {
        status: "succeeded",
        skipReason:
          "interrupted: the server restarted before the agent run was observed to finish",
      };
    case "error":
      return {
        status: "failed",
        error: "Turn failed while the automations plugin was not running",
        transientFailure: true,
      };
    case "pending":
    case "starting":
    case "active":
    case "stopping":
      return null;
  }
}

export function disableAutomationsForDeletedThreadEvent(
  api: Pick<PluginApi, "realtime">,
  db: Db,
  threadId: string,
): void {
  const disabled = disableAutomationsForTargetThread(db, {
    threadId,
    error: `Target thread ${threadId} was deleted`,
    now: Date.now(),
  });

  for (const automation of disabled) {
    publishAutomationChange(api, automation.projectId, "automations-changed");
  }
}
