import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { completionSchema, rpcContract, packageInputSchema, batchFinishSchema } from "./contract";
import { coordinatorInterrupted, ProjectBatches } from "./src/batches";
import { rateLimited, SentryClient } from "./src/intake";
import { SentryRunner } from "./src/runner";
import { isActiveRun } from "./src/run-state";
import { SentryWorkflow } from "./src/workflow";
import { WorkflowWebhook } from "./src/workflow-webhook";
import { workflowWorkerResultSchema } from "./src/workflow-contract";
import { registerSentryCli } from "./src/cli";
import { DiagnosticsReleaseFlow } from "./src/diagnostics-release";

export { rpcContract } from "./contract";

export function createSentryPlugin(fetchSentry: typeof fetch = fetch) {
  return async function sentryPlugin(api: PluginApi) {
    const transport = rateLimited(fetchSentry);

    const settings = api.settings.define({
      apiOrigin: {
        type: "select",
        label: "Data region",
        description: "Where your Sentry organization stores its data.",
        options: ["https://de.sentry.io", "https://us.sentry.io"],
        experimental_optionLabels: {
          "https://de.sentry.io": "EU (de.sentry.io)",
          "https://us.sentry.io": "US (us.sentry.io)",
        },
        default: "https://de.sentry.io",
      },
      apiToken: {
        type: "string",
        secret: true,
        label: "Auth token",
        description:
          "Needs org:read, project:read and event:read. Diagnostics pauses also need event:write.",
      },
      webhookSecret: {
        type: "string",
        secret: true,
        label: "Webhook signing secret",
        description: "The client secret of the Sentry internal integration sending issue webhooks.",
      },
      resolveFixedIssues: {
        type: "boolean",
        label: "Triage issues after solving",
        description:
          "Each solver sets its issue's final Sentry state with its own Sentry tools: resolved in the next release after a merged fix, resolved when already fixed, archived until escalating when proven not actionable. Unproven issues stay open.",
        default: true,
      },
      mergeReviewedPullRequests: {
        type: "boolean",
        label: "Merge reviewed pull requests",
        description:
          "On PR routes, the solver marks its verified draft PR ready and merges it after an independent reviewer approved the commit and required CI checks passed. Off leaves the draft PR for you.",
        default: false,
      },
    });

    const runner = new SentryRunner(api, () => settings.get(), transport);
    const diagnostics = new DiagnosticsReleaseFlow(runner, () => settings.get(), transport);
    runner.registerEnvironment();
    const workflow = new SentryWorkflow(api, runner, () => settings.get(), transport);

    const scanWorkflow = async (projectIds?: string[]) => {
      const routeIds = workflow.watchedRoutes(projectIds);

      if (!routeIds.length) return;
      await runner.sync(false, routeIds);
      await workflow.reconcile();
    };

    const webhook = new WorkflowWebhook(
      api,
      async () => (await settings.get()).webhookSecret,
      scanWorkflow,
    );

    api.http.route("POST", "/webhook", (context) => webhook.receive(context.req.raw), {
      auth: "none",
    });
    const batches = new ProjectBatches(runner, () => settings.get(), transport);
    batches.registerEnvironment();

    const reconcileQueue = async () => {
      await diagnostics.reconcile();
      await workflow.reconcile();
      await runner.reconcile();
      await runner.dispatch();
      await batches.reconcile();

      return { reconciled: true as const };
    };

    settings.onChange(() => {
      for (const route of runner.store.listRoutes())
        runner.store.saveSync(route.id, {
          ...runner.store.sync(route.id),
          error: null,
          retryAt: null,
        });
      runner.changed();
    });
    api.rpc.register(
      rpcContract,
      {
        "workflow.configure": (input) => workflow.configure(input),
        "workflow.recoverSetup": ({ runId }) => workflow.recoverSetup(runId),
        "workflow.status": () => workflow.status(),
        "workflow.authorize": (input) => workflow.authorize(input),
        "workflow.start": (input) => workflow.start(input),
        "workflow.inspect": (input) => workflow.inspect(input),
        "workflow.cancel": (input) => workflow.cancel(input),
        "workflow.log": (input) => workflow.log(input),
        status: () => runner.status(),
        "inbox.list": (input) => runner.store.listInbox(input),
        badge: () => runner.store.badge(),
        "callback.status": () => batches.callbackStatus(),
        "queue.reconcile": reconcileQueue,
        "projects.policy": (input) => runner.savePolicy(input),
        targets: async () => {
          const [projects, hosts] = await Promise.all([
            api.sdk.projects.list(),
            api.sdk.hosts.list(),
          ]);

          return {
            projects: projects.map(({ id, name }) => ({ id, name })),
            hosts: hosts.map(({ id, name }) => ({ id, name })),
          };
        },
        "projects.catalog": async ({ organization }) => {
          const config = await settings.get();

          if (!config.apiToken) throw new Error("Connect Sentry in plugin settings");

          return new SentryClient(config.apiOrigin, config.apiToken, transport).projects(
            organization,
          );
        },
        "projects.repositories": async ({ projectId }) => {
          const project = (await api.sdk.projects.list()).find(
            (project) => project.id === projectId,
          );

          if (!project) throw new Error("Omnyo project not found");
          const repositories = [];

          for (const source of project.sources) {
            if (source.type !== "local_path" || !source.path || !source.hostId) continue;

            const found = await runner.host.call(
              "discoverRepositories",
              { rootPath: source.path },
              { hostId: source.hostId, timeoutMs: 60000 },
            );

            for (const repository of found)
              repositories.push({ ...repository, hostId: source.hostId });
          }

          return repositories;
        },
        "projects.add": async (input) => {
          const saved = runner.saveRoute({ ...input, enabled: false, delivery: "local" });
          const watching = await runner.enable(saved.id, true);
          runner.startSync();

          return watching;
        },
        "projects.solveAll": ({ projectId, model }) => batches.start(projectId, model),
        "models.save": ({ role, selection }) => runner.saveModelDefault(role, selection),
        "batches.stop": ({ id }) => batches.stop(id),
        "batches.resume": ({ id }) => batches.resume(id),
        doctor: ({ routeId }) => runner.doctor(routeId),
        "routes.save": (input) => runner.saveRoute(input),
        "routes.enable": ({ id, enabled }) => runner.enable(id, enabled),
        "sync.start": () => runner.startSync(),
        sync: ({ dryRun }) => runner.sync(dryRun),
        investigate: ({ routeId, issueUrl, mode, model }) =>
          runner.investigate(routeId, issueUrl, mode, model),
        "runs.show": ({ id }) => runner.store.getRun(id),
        "runs.stop": ({ id }) => runner.stop(id),
        "runs.retry": ({ id }) => runner.retry(id),
      },
      {
        experimental_discoverable: true,
        experimental_description:
          "Read status and manage explicitly configured Sentry investigations.",
      },
    );

    api.agents.registerTool({
      name: "sentry_workflow_result",
      description: "Submit this State Machines worker's finite, evidence-bound result.",
      parameters: z.object({ attemptId: z.string(), result: workflowWorkerResultSchema }).strict(),
      execute: async (input, context) =>
        JSON.stringify(await workflow.submit(context.threadId, input.attemptId, input.result)),
    });
    api.agents.registerTool({
      name: "sentry_run_context",
      description: "Read this thread's exact Sentry run, route and current verified state.",
      parameters: z.object({}).strict(),
      execute: (_input, context) => {
        const run = runner.store.ownedThread(context.threadId);

        if (!run || run.route.projectId !== context.projectId)
          throw new Error("This thread does not own a Sentry run");

        const issueKeys = new Set(
          [run.incident, ...run.relatedIncidents].map((issue) => issue.key),
        );

        const diagnosticHolds = Array.from(issueKeys).flatMap((key) => {
          const hold = runner.store.diagnosticsHold(key);

          return hold?.runId === run.id ? [hold] : [];
        });

        return JSON.stringify({ ...run, diagnosticHolds });
      },
    });
    api.agents.registerTool({
      name: "sentry_finish_run",
      description:
        "Submit evidence from this owned investigation. Runs required local checks and, only when enabled, publishes a verified draft PR.",
      parameters: completionSchema,
      execute: async (input, context) =>
        JSON.stringify(
          await runner.finish(context.threadId, context.projectId, input, context.signal),
        ),
    });
    api.agents.registerTool({
      name: "sentry_wait_for_diagnostics_release",
      description:
        "Pause notifications for an owned unresolved issue after its logging regression passes. Resume on the exact verified build's deployment.",
      parameters: z.object({ issueKey: z.string().min(1) }).strict(),
      execute: async (input, context) =>
        JSON.stringify(
          await diagnostics.begin(context.threadId, context.projectId, input.issueKey),
        ),
    });
    api.agents.registerTool({
      name: "sentry_project_context",
      description:
        "Read this coordinator's complete paginated project inventory, issue owners and actual package results.",
      parameters: z.object({ offset: z.number().int().nonnegative().default(0) }).strict(),
      execute: (input, context) =>
        JSON.stringify(batches.context(context.threadId, context.projectId, input.offset)),
    });
    api.agents.registerTool({
      name: "sentry_queue_package",
      description:
        "Queue a package in its exact isolated repository, including follow-up work after a worker callback. Route permissions are checked per mapping.",
      parameters: packageInputSchema,
      execute: (input, context) =>
        JSON.stringify(batches.queuePackage(context.threadId, context.projectId, input)),
    });
    api.agents.registerTool({
      name: "sentry_finish_project",
      description:
        "Enter native waiting for active packages or request terminal completion after verified per-issue outcomes and required approvals are settled.",
      parameters: batchFinishSchema,
      execute: async (input, context) =>
        JSON.stringify(
          await batches.finish(context.threadId, context.projectId, input, context.signal),
        ),
    });
    api.agents.configure((context) => {
      if (workflow.workerConfiguration(context))
        return {
          tools: ["sentry_workflow_result"],
          skills: [],
          instructions:
            "This is a finite State Machines worker. The launch prompt owns its stage. Submit its evidence with sentry_workflow_result and finish. Dedicated graph steps own publication, merge, delivery and Sentry state changes.",
        };
      const batch = runner.store.ownedBatch(context.thread.id);

      if (
        batch &&
        batch.projectId === context.project.id &&
        batch.hostId === context.host.id &&
        !["cancelled", "failed"].includes(batch.state)
      ) {
        const reportingOnly = batch.state === "complete";

        return {
          tools: reportingOnly
            ? ["sentry_project_context", "sentry_finish_project"]
            : ["sentry_project_context", "sentry_queue_package", "sentry_finish_project"],
          skills: ["sentry", "solve-sentry-issues"],
          instructions: reportingOnly
            ? "This Sentry batch is closed: " +
              batch.id +
              ". Preserve its results, owners and claims. Do not replay completed work. A new user request is separate. Use the supported new-task or fresh-investigation path when authorized. Carry forward applicable approvals, evidence and outstanding obligations. If fresh execution context is required, identify or create it through the supported mechanism within the user's authority. Verify new work independently of the previous batch."
            : "You coordinate Sentry project investigation " +
              batch.id +
              ". Dispatch independent packages as their scopes become clear and continue dispatching after worker callbacks. Changes go through isolated sentry_queue_package workers. Keep each blocker specific to the work it holds and name the next action and actor. Use sentry_finish_project to wait or record blockers. Request terminal completion only after issue dispositions and required approvals are verified.",
        };
      }

      const run = runner.store.ownedThread(context.thread.id);

      if (
        !run ||
        run.route.projectId !== context.project.id ||
        run.route.hostId !== context.host.id
      )
        return { tools: [], skills: [] };

      return {
        tools: ["sentry_run_context", "sentry_finish_run", "sentry_wait_for_diagnostics_release"],
        skills: ["sentry", "solve-sentry-issues"],
        instructions:
          "This thread owns Sentry run " +
          run.id +
          ". Inspect context, submit structured evidence through sentry_finish_run and verify its actual result. For eligible diagnostic work use sentry_wait_for_diagnostics_release after verification. The original issue remains unresolved. Publication goes through sentry_finish_run. Merge or change Sentry issue state only as this run authorizes. No additional provider spend, deployment or release is authorized.",
      };
    });

    api.events.on("thread.idle", ({ thread }) =>
      (workflow.ownsThread(thread.id) ? workflow.reconcile() : runner.idle(thread.id))
        .then(() => batches.idle(thread.id))
        .catch(() => api.log.warn("Sentry completion needs inspection")),
    );
    api.events.on("thread.failed", ({ thread }) => {
      if (workflow.ownsThread(thread.id)) return;
      const run = runner.store.ownedThread(thread.id);

      const batch = runner.store.ownedBatch(thread.id);

      if (batch)
        runner.store.updateBatch(batch.id, {
          reason: "Coordinator failed; resume its existing chat",
        });

      if (run) {
        runner.store.updateRun(run.id, {
          reason: "Worker failed; preserve its native retry and source",
        });
        runner.changed();
      }
    });
    api.events.on("thread.active", ({ thread }) => {
      if (workflow.ownsThread(thread.id)) return;
      const run = runner.store.ownedThread(thread.id);

      const batch = runner.store.ownedBatch(thread.id);

      if (
        run &&
        runner.store.hasClaim(run.id) &&
        !["local-ready", "pr-open", "no-fix", "needs-evidence", "cancelled"].includes(run.state)
      ) {
        runner.store.updateRun(run.id, {
          state: "investigating",
          reason: null,
          interruptedAt: null,
        });
        runner.changed();
      }

      if (batch?.reason === coordinatorInterrupted) {
        runner.store.updateBatch(batch.id, { reason: null });
        runner.changed();
      }
    });
    api.events.on("thread.archived", ({ thread }) => {
      if (workflow.ownsThread(thread.id)) return;
      const run = runner.store.ownedThread(thread.id);

      if (run && isActiveRun(run.state))
        void runner
          .stop(run.id)
          .catch(() => api.log.warn("Sentry archived worker cleanup needs inspection"));
    });
    api.background.schedule("workflow-reconcile", "* * * * *", async () => {
      await webhook.drain();
      await scanWorkflow();
    });
    api.background.schedule("sync", "*/5 * * * *", async () => {
      await reconcileQueue();
      await runner.sync(false);
    });
    api.background.service("reconcile", {
      async start(signal) {
        await reconcileQueue();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    api.onDispose(async () => {
      await diagnostics.dispose();
      await batches.dispose();
      await runner.dispose();
    });

    registerSentryCli(api, runner, workflow, reconcileQueue);
  };
}

export default createSentryPlugin();
