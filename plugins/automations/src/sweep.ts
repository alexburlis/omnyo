import type { createWorkflowDispatch } from "./workflow-dispatch.js";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { ScriptHostRouting } from "./script-host.js";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  getScheduledAutomationRetryRun,
  listDueAutomations,
  parseAutomationExecution,
  parseAutomationTrigger,
  type AutomationEnvValues,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import { computeNextScheduledTime } from "./schedule-helpers.js";
import {
  errorMessage,
  executeAgentRun,
  executeScriptRun,
  type AgentRunApi,
  type ScriptRunApi,
} from "./run.js";
import {
  createScriptWorkingDirectoryResolver,
  type ScriptWorkingDirectoryResolver,
} from "./working-directory.js";

const DUE_AUTOMATION_BATCH_SIZE = 100;

export const SWEEP_INTERVAL_MS = 10_000;

const hostListSchema = z.array(
  z.object({ status: z.enum(["connected", "disconnected"]) }).passthrough(),
);

type SweepApi = AgentRunApi &
  ScriptRunApi & {
    sdk: { hosts: { list(): Promise<unknown> } };
  };

function buildScheduleFailureHandler(
  db: Db,
  args: {
    run: AutomationRunRow;
  },
): (error: unknown) => void {
  return (error) => {
    closeAutomationRun(db, {
      runId: args.run.id,
      status: "failed",
      error: errorMessage(error),
      now: Date.now(),
    });
  };
}

async function processDueAutomation(
  api: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    env: AutomationEnvValues;
    automation: AutomationRow;
    now: number;
    agentHostsAvailable: boolean;
    resolveWorkingDirectory: ScriptWorkingDirectoryResolver;
    workflows?: ReturnType<typeof createWorkflowDispatch>;
    scriptHostRouting?: ScriptHostRouting;
  },
): Promise<void> {
  if (args.automation.nextRunAt === null) return;
  const expectedNextRunAt = args.automation.nextRunAt;
  let newNextRunAt: number | null;
  let execution;

  try {
    const trigger = parseAutomationTrigger(args.automation.triggerConfig);
    execution = parseAutomationExecution(args.automation, args.env);
    newNextRunAt =
      trigger.triggerType === "once"
        ? null
        : computeNextScheduledTime({
            cron: trigger.cron,
            now: args.now,
            timezone: trigger.timezone,
          });
  } catch (error) {
    api.log.error(
      `Skipping due automation ${args.automation.id} with invalid stored configuration: ${errorMessage(error)}`,
    );

    return;
  }

  if (execution.mode === "agent" && !args.agentHostsAvailable) {
    return;
  }

  const retryRun =
    execution.mode === "agent"
      ? getScheduledAutomationRetryRun(db, args.automation)
      : null;

  const prepared =
    execution.mode === "workflow"
      ? await args.workflows?.prepare(args.automation)
      : undefined;

  if (execution.mode === "workflow" && !prepared)
    throw new Error("Workflow dispatch is unavailable.");

  const claim = claimAutomationScheduledRun(db, {
    automationId: args.automation.id,
    expectedNextRunAt,
    newNextRunAt,
    now: args.now,
    persistClaim: prepared?.persist,
    skipReason: prepared?.skip(expectedNextRunAt, args.now),
  });

  if (!claim.advanced) return;
  publishAutomationChange(api, args.automation.projectId, [
    "automations-changed",
    "automation-runs-changed",
  ]);

  if (claim.run.status !== "running") return;

  const onFailure = buildScheduleFailureHandler(db, {
    run: claim.run,
  });

  if (execution.mode === "agent") {
    const runArgs: Parameters<typeof executeAgentRun>[2] = {
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
    };

    if (retryRun !== null) runArgs.retryRun = retryRun;
    await executeAgentRun(api, db, runArgs);
  } else if (execution.mode === "workflow") {
    void args.workflows?.reconcile(claim.run);
  } else {
    void executeScriptRun(api, db, {
      pluginDataDir: args.pluginDataDir,
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
      resolveWorkingDirectory: args.resolveWorkingDirectory,
      scriptHostRouting: args.scriptHostRouting,
    }).catch((error: unknown) => {
      api.log.error(
        `Detached script automation ${args.automation.id} failed unexpectedly: ${errorMessage(error)}`,
      );
    });
  }
}

async function hasConnectedHost(
  api: Pick<PluginApi, "log"> & {
    sdk: { hosts: { list(): Promise<unknown> } };
  },
): Promise<boolean> {
  try {
    return hostListSchema
      .parse(await api.sdk.hosts.list())
      .some((host) => host.status === "connected");
  } catch (error) {
    api.log.warn(
      `Failed to list hosts for automation sweep: ${errorMessage(error)}`,
    );

    return false;
  }
}

export async function sweepDueAutomations(
  api: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    env: AutomationEnvValues;
    serverHostId: string | null;
    scriptHostRouting?: ScriptHostRouting;
    now?: number;
    workflows?: ReturnType<typeof createWorkflowDispatch>;
  },
): Promise<void> {
  const now = args.now ?? Date.now();

  const due = listDueAutomations(db, args.env, {
    now,
    limit: DUE_AUTOMATION_BATCH_SIZE,
  });

  if (due.length === 0) return;
  const agentHostsAvailable = await hasConnectedHost(api);

  const resolveWorkingDirectory = createScriptWorkingDirectoryResolver({
    sdk: api.sdk,
    pluginDataDir: args.pluginDataDir,
    serverHostId:
      args.scriptHostRouting?.hostId(args.serverHostId) ?? args.serverHostId,
  });

  for (const automation of due) {
    try {
      await processDueAutomation(api, db, {
        pluginDataDir: args.pluginDataDir,
        env: args.env,
        automation,
        now,
        agentHostsAvailable,
        resolveWorkingDirectory,
        workflows: args.workflows,
        scriptHostRouting: args.scriptHostRouting,
      });
    } catch (error) {
      api.log.error(
        `Failed to process due automation ${automation.id}: ${errorMessage(error)}`,
      );
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const settle = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };

    const timeout = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}
