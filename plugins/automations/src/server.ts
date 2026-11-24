import {
  createWorkflowImports,
  workflowImportMigration,
  workflowRevisionMigration,
  workflowCliBindingMigration,
  openSeoCopyRevision,
} from "./workflow-import.js";
import {
  createWorkflowDispatch,
  workflowDispatchMigration,
} from "./workflow-dispatch.js";
import {
  workflowRpcContract,
  type WorkflowHandlers,
} from "./workflow-contract.js";
import { publishAutomationChange } from "./realtime.js";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { openSeoRpcContract } from "./openseo-contract.js";
import {
  createOpenSeo,
  OPEN_SEO_KEY_SETTING,
  openSeoMigration,
} from "./openseo.js";
import {
  requireWorkflowSetupClient,
  setupRpcHandlers,
} from "./openseo-access.js";
import { createScriptHostRouting } from "./script-host.js";
import { listRunningAutomationRunsByThread, migrations } from "./data.js";
import { openAutomationEnv } from "./env-secrets.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { pluginDataDirFromDb } from "./path.js";
import { automationRpcContract, createRpcHandlers } from "./rpc.js";
import {
  closeAutomationRunForSettledThread,
  disableAutomationsForDeletedThreadEvent,
  errorMessage,
  reconcileRunningAutomationRuns,
} from "./run.js";
import { registerAutomationCli } from "./cli.js";
import { createFailureNoticeSender } from "./failure-notices.js";
import { createAutomationService } from "./service.js";
import { sleep, sweepDueAutomations, SWEEP_INTERVAL_MS } from "./sweep.js";
import { isTransientTurnFailure } from "./turn-failure.js";

export default async function plugin(api: PluginApi) {
  const settings = api.settings.define({
    scriptHostId: {
      type: "string",
      label: "Script execution host ID",
      default: "",
    },
    [OPEN_SEO_KEY_SETTING]: {
      type: "string",
      secret: true,
      label: "OpenSEO workspace API key",
      description:
        "This installation stores the key with your OpenSEO workspace permissions. Authorize a site separately for each Weekly Content Feed copy.",
    },
  });

  const scriptHostRouting = createScriptHostRouting(
    api,
    (await settings.get()).scriptHostId.trim(),
  );

  const db = api.storage.database();
  api.storage.migrate(db, [
    ...migrations,
    workflowImportMigration,
    workflowDispatchMigration,
    workflowRevisionMigration,
    workflowCliBindingMigration,
    openSeoMigration,
  ]);
  const pluginDataDir = pluginDataDirFromDb(db);
  await ingestLegacyImport({ api, db, pluginDataDir });

  const env = await openAutomationEnv({
    db,
    secrets: api.experimental_secrets,
    log: api.log,
  });

  const openSeo = createOpenSeo({
    db,
    readKey: async () => (await settings.get())[OPEN_SEO_KEY_SETTING],
    copyRevision: (target) => openSeoCopyRevision(db, target),
  });

  settings.onChange((next, previous) => {
    if (next[OPEN_SEO_KEY_SETTING] !== previous[OPEN_SEO_KEY_SETTING])
      openSeo.invalidate();
  });
  const imports = createWorkflowImports(api, db, openSeo.select);
  const workflows = createWorkflowDispatch(api, db, imports);

  const service = createAutomationService({
    api,
    db,
    env,
    pluginDataDir,
    scriptHostRouting,
    workflows,
  });

  api.rpc.register(automationRpcContract, createRpcHandlers(service));

  const {
    get: _get,
    scheduleTarget: _scheduleTarget,
    prepareAutomation: _prepareAutomation,
    ...intakeHandlers
  } = imports;

  const workflowHandlers: WorkflowHandlers = {
    ...intakeHandlers,
    workflow_artifacts: workflows.artifacts,
    async workflow_enable(input) {
      const row = await imports.prepareAutomation(
        input,
        true,
        workflows.requireCapability,
      );

      publishAutomationChange(api, row.projectId, "automations-changed");

      return imports.get(input);
    },
    async workflow_run(input) {
      const row = await imports.prepareAutomation(
        input,
        false,
        workflows.requireCapability,
      );

      return service.run({
        projectId: row.projectId,
        automationId: row.id,
        idempotencyKey: input.requestId,
      });
    },
  };

  api.rpc.register(workflowRpcContract, {
    ...workflowHandlers,
    workflow_bind(input, context) {
      if (input.bindings.source) requireWorkflowSetupClient(context);

      return workflowHandlers.workflow_bind(input);
    },
  });
  const openSeoHandlers = setupRpcHandlers(openSeo.handlers);
  api.rpc.register(openSeoRpcContract, openSeoHandlers, {
    experimental_discoverable: false,
  });
  registerAutomationCli({ api, service, workflowHandlers, openSeoHandlers });

  const transientTurnFailures = new Map<string, boolean>();

  api.events.on("turn.failed", (failure) => {
    if (listRunningAutomationRunsByThread(db, failure.threadId).length === 0) {
      return;
    }

    transientTurnFailures.set(
      failure.threadId,
      isTransientTurnFailure(failure),
    );
  });
  api.events.on("thread.idle", ({ thread }) => {
    transientTurnFailures.delete(thread.id);

    return closeAutomationRunForSettledThread(api, db, {
      threadId: thread.id,
      status: "idle",
    });
  });
  api.events.on("thread.failed", ({ thread, error }) => {
    const transientFailure = transientTurnFailures.get(thread.id) === true;
    transientTurnFailures.delete(thread.id);

    return closeAutomationRunForSettledThread(api, db, {
      threadId: thread.id,
      status: "failed",
      error,
      transientFailure,
    });
  });

  api.events.on("thread.deleted", ({ thread }) => {
    transientTurnFailures.delete(thread.id);
    disableAutomationsForDeletedThreadEvent(api, db, thread.id);
  });

  api.background.service("automation-sweep", {
    async start(signal) {
      try {
        workflows.reconcilePending();
        await reconcileRunningAutomationRuns(api, db);
      } catch (error) {
        api.log.error(
          `Automation startup reconciliation failed: ${errorMessage(error)}`,
        );
      }

      let serverHostId: string | null = null;
      const sendFailureNotices = createFailureNoticeSender(api, db);

      while (!signal.aborted) {
        try {
          serverHostId ??= (await api.sdk.system.config()).primaryHostId;
          workflows.reconcilePending();
          await sweepDueAutomations(api, db, {
            pluginDataDir,
            env,
            serverHostId,
            scriptHostRouting,
            workflows,
          });
        } catch (error) {
          api.log.error(`Automation sweep failed: ${errorMessage(error)}`);
        }

        try {
          await sendFailureNotices(Date.now(), signal);
        } catch (error) {
          if (signal.aborted) break;
          api.log.error(
            `Automation failure notices failed: ${errorMessage(error)}`,
          );
        }

        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    },
  });
}
