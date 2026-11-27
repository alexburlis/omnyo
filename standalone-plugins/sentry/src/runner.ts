import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  completionSchema,
  hostContract,
  routeSchema,
  type Completion,
  type Incident,
  type Route,
  type Run,
  type ProjectPolicy,
  type ModelRole,
  type ModelSelection,
} from "../contract";
import { executionOf, workerPrompt, type SolvePolicy } from "./prompts";
import { SentryClient, SentryFailure } from "./intake";
import { SentryStore } from "./store";
import { isActiveRun } from "./run-state";
import { assertRequiredChecks } from "./repair-result-contract";
import { assertPublishable, renderPullRequest } from "./report";

export type Connection = {
  apiOrigin: string;
  apiToken?: string;
  resolveFixedIssues?: boolean;
  mergeReviewedPullRequests?: boolean;
};

const legacyModel = "gpt-6.1-sol";

function modelLabel(selection: ModelSelection) {
  return selection.model + " · " + selection.reasoningLevel;
}

const sliceSize = 80;

const maxSlices = 12;

function sliceBounds(lastSeen: string[]) {
  const size = Math.max(sliceSize, Math.ceil(lastSeen.length / maxSlices));
  const bounds: string[] = [];

  for (let index = size; index < lastSeen.length; index += size)
    if (lastSeen[index] !== bounds.at(-1)) bounds.push(lastSeen[index]!);

  return bounds;
}

export class WorkerNotStarted extends Error {}

const providerInputs = z.object({ runId: z.string(), routeVersion: z.number().int() }).strict();

const resourceSchema = z
  .object({ runId: z.string(), sourcePath: z.string(), branch: z.string(), baseSha: z.string() })
  .strict();

const noticeReceipt = z.object({
  id: z.string(),
  status: z.enum(["queued", "dispatched"]),
  duplicate: z.boolean(),
  durable: z.literal(true),
  acceptedTargetCount: z.number(),
});

const reminder =
  "Your Sentry run still has no validated completion. Preserve your current work, call sentry_run_context and sentry_finish_run with the actual evidence or exact blocker, then give a TL;DR.";

const interruptedReason = "Interrupted by a stop. Open the chat to continue it, or stop this run.";

const unavailableReason = "Worker state is unavailable; ownership and source are preserved.";

const reminderFailedReason =
  "The completion reminder could not be sent; ownership and source are preserved.";

const endedTwiceReason =
  "Ended twice without a structured report. Continue its chat to submit one, or Retry.";

const chatDeletedReason =
  "Its chat was deleted, so this run ended and released the execution slot. Its branch, worktree and evidence are preserved.";

export const deletedChat = z.object({ code: z.literal("thread_not_found") });

const machineRemovedReason =
  "Its machine was removed, so this run ended and released the execution slot. Update the route's machine before starting this issue again.";

export const missingProjectReason =
  "This route's Omnyo project no longer exists. Pause the route, choose Edit and pick a project.";

class MissingProject extends Error {}

const nothingRecorded =
  " Nothing was recorded; your evidence stays in this chat. Tell the user instead of resubmitting.";

const publishUncertainRefusal =
  "A draft PR may already exist for this run, so this report was not recorded. Resubmit the fix-ready completion to reconcile it; if this run no longer holds the execution slot, ask the user to press Retry first. Otherwise ask the user to stop this run.";

// The outcome of a chat's newest root turn. Subagent turns never describe the chat itself.
type TurnOutcome = {
  status: "completed" | "interrupted" | "unavailable";
  reason: string | null;
  seq: number | null;
};

const unavailableTurn: TurnOutcome = { status: "unavailable", reason: null, seq: null };

export class SentryRunner {
  readonly store: SentryStore;
  readonly host;
  private serial: Promise<void> = Promise.resolve();
  private launchingRunId: string | null = null;
  private syncing: {
    routeIds: ReadonlySet<string> | null;
    work: Promise<{ candidates: Incident[]; scanned: number; dryRun: boolean }>;
  } | null = null;
  private disposed = false;
  private finishControllers = new Map<string, AbortController>();
  private idleThreads = new Set<string>();

  constructor(
    readonly api: PluginApi,
    private connection: () => Promise<Connection>,
    private transport: typeof fetch = fetch,
  ) {
    this.store = new SentryStore(api.storage);
    this.host = api.hosts.experimental_client({ contract: hostContract });
  }
  changed() {
    this.api.realtime.publish("changed", { at: Date.now() });
  }
  runModel(run: Run): ModelSelection {
    return (
      run.model ??
      (run.reasoningLevel === "ultra"
        ? {
            providerId: "codex",
            model: legacyModel,
            reasoningLevel: "ultra",
            serviceTier: "default",
          }
        : this.store.modelDefaults().solver)
    );
  }
  solvePolicy(config: Connection): SolvePolicy {
    return {
      triageIssues: config.resolveFixedIssues !== false,
      mergeReviewedPullRequests: config.mergeReviewedPullRequests === true,
      reviewer: this.store.modelDefaults().reviewer,
    };
  }

  async workflowWorkspace(run: Run, threadId: string) {
    const worker = await this.api.sdk.threads.get({ threadId });

    const environment = worker.environmentId
      ? await this.api.sdk.environments.get({ environmentId: worker.environmentId })
      : null;

    const inputs = providerInputs.safeParse(environment?.environmentProviderSelection?.inputs);

    if (
      worker.originPluginId !== "sentry" ||
      !environment ||
      environment.projectId !== run.route.projectId ||
      environment.hostId !== run.route.hostId ||
      !run.worktreePath ||
      environment.path !== run.worktreePath ||
      environment.status !== "ready" ||
      environment.lifecycle.phase !== "active" ||
      environment.environmentProviderId !== "sentry-worktree" ||
      !inputs.success ||
      inputs.data.runId !== run.id ||
      inputs.data.routeVersion !== run.route.version
    )
      throw new Error("The previous Sentry worker's workspace is not ready for reuse");

    return environment.id;
  }

  private async prepareWorkflowWorker(id: string, review: boolean) {
    try {
      let run = this.store.reclaim(id);
      const selection = this.store.modelDefaults()[review ? "reviewer" : "solver"];

      if ((await this.modelAvailable(selection, run.route.hostId)) !== "ready")
        throw new Error("Configured workflow model is unavailable");

      if (run.threadId && !run.environmentId)
        run = this.store.updateRun(id, {
          environmentId: await this.workflowWorkspace(run, run.threadId),
        });

      return { run, selection };
    } catch (error) {
      throw new WorkerNotStarted(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  }

  async startWorkflowWorker(
    id: string,
    prompt: string,
    attemptId: string,
    operation: string,
    review: boolean,
    parentThreadId: string | null = null,
  ) {
    const { run, selection } = await this.prepareWorkflowWorker(id, review);

    const spawned = await this.api.sdk.threads.spawn({
      projectId: run.route.projectId,
      providerId: selection.providerId,
      ...executionOf(selection),
      permissionMode: operation === "repair" ? "auto" : "accept-edits",
      visibility: "visible",
      parentThreadId: parentThreadId ?? run.threadId ?? undefined,
      title: `${run.incident.shortId}: ${operation}`,
      prompt,
      pluginMetadata: { runId: id, workflowAttemptId: attemptId, workflowOperation: operation },
      ...(run.environmentId
        ? { environment: { type: "reuse" as const, environmentId: run.environmentId } }
        : {
            environment: {
              type: "provider" as const,
              environmentProviderId: "sentry-worktree",
              machine: { type: "existing" as const, hostId: run.route.hostId },
              inputs: { runId: id, routeVersion: run.route.version },
            },
          }),
    });

    if (!review)
      this.store.updateRun(id, {
        threadId: spawned.id,
        environmentId: spawned.environmentId ?? this.store.getRun(id).environmentId,
        state: "investigating",
      });
    this.changed();

    return spawned.id;
  }
  async modelAvailable(selection: ModelSelection, hostId: string) {
    const catalog = await this.api.sdk.providers.models({
      providerId: selection.providerId,
      hostId,
    });

    const model = catalog.models.find((value) => value.id === selection.model);

    return !model
      ? "missing"
      : !model.supportedReasoningEfforts ||
          model.supportedReasoningEfforts.some(
            (value) => value.reasoningEffort === selection.reasoningLevel,
          )
        ? "ready"
        : "reasoning";
  }
  saveModelDefault(role: ModelRole, selection: ModelSelection) {
    const result = this.store.saveModelDefault(role, selection);
    this.changed();

    return result;
  }
  async status() {
    const config = await this.connection();
    const routes = this.store.listRoutes();

    return {
      connected: Boolean(config.apiToken),
      syncing: this.syncing !== null,
      apiOrigin: config.apiOrigin,
      lastError: routes.map((route) => this.store.sync(route.id).error).find(Boolean) ?? null,
      routes,
      badge: this.store.badge(),
      projectPolicies: this.store.projectPolicies(),
      projectIssueCounts: this.store.projectIssueCounts(),
      batches: this.store.batchSummaries(),
      models: this.store.modelDefaults(),
      mergeReviewedPullRequests: config.mergeReviewedPullRequests === true,
      incidents: this.store.listIncidents(),
      runs: this.store.listRuns(),
      syncs: routes.map((route) => ({ routeId: route.id, state: this.store.sync(route.id) })),
      notificationLimit:
        "Uses Omnyo notification preferences. Pre-worker notices cover desktop/web; mobile uses visible chat completion.",
    };
  }

  async doctor(routeId: string | null) {
    const [config, projects] = await Promise.all([this.connection(), this.api.sdk.projects.list()]);

    const projectIds = new Set(projects.map((project) => project.id));

    const checks = [
      {
        name: "Sentry connection",
        ok: Boolean(config.apiToken),
        detail: config.apiToken
          ? "Existing credential configured"
          : "Connect Sentry in plugin settings",
      },
    ];

    const routes = routeId ? [this.store.getRoute(routeId)] : this.store.listRoutes();

    for (const route of routes) {
      const projectFound = projectIds.has(route.projectId);
      checks.push({
        name: route.name + " Omnyo project",
        ok: projectFound,
        detail: projectFound ? "Existing Omnyo project" : missingProjectReason,
      });

      try {
        const solver = this.store.modelDefaults().solver;

        const [host, availability] = await Promise.all([
          this.api.sdk.hosts.get({ hostId: route.hostId }),
          this.modelAvailable(solver, route.hostId),
        ]);

        const connected = host.status === "connected";

        checks.push({
          name: route.name + " host/model",
          ok: connected && availability === "ready",
          detail: !connected
            ? "The selected machine is offline"
            : availability === "missing"
              ? "This machine doesn't offer the default solver model " + solver.model + " right now"
              : availability === "reasoning"
                ? solver.model + " doesn't offer " + solver.reasoningLevel + " reasoning here"
                : "Selected machine and " + modelLabel(solver) + " are available",
        });
        await this.host.call(
          "inspectRepository",
          {
            repositoryPath: route.repositoryPath,
            baseRef: route.baseRef,
            expectedRepository: route.githubRepository,
          },
          { hostId: route.hostId, timeoutMs: 120000 },
        );
        checks.push({
          name: route.name + " repository",
          ok: true,
          detail: "Canonical root, base and expected remote verified",
        });
      } catch {
        checks.push({
          name: route.name + " target",
          ok: false,
          detail:
            "Verify the selected host, model, repository root, base ref and existing authentication",
        });
      }
    }

    return { ready: checks.every((check) => check.ok), checks };
  }

  saveRoute(input: Route) {
    const previous = this.store.listRoutes().find((route) => route.id === input.id);

    if (previous?.enabled)
      throw new Error("Pause the route before changing its target or publication scope");
    const route = this.store.saveRoute({ ...input, enabled: false });
    this.changed();

    return route;
  }

  async enable(id: string, enabled: boolean) {
    const route = this.store.getRoute(id);

    if (enabled) {
      const config = await this.connection();

      if (!config.apiToken) throw new Error("Connect Sentry in plugin settings");
    } else {
      for (const run of this.store.listRuns())
        if (run.route.id === id) this.finishControllers.get(run.id)?.abort();
    }

    const result = this.store.saveRoute({ ...route, enabled });
    this.changed();

    return result;
  }

  async savePolicy(input: ProjectPolicy) {
    const routes = this.store.listRoutes().filter((route) => route.projectId === input.projectId);

    if (!routes.length) throw new Error("Configure this project's watched repository first");

    if (input.autoSolve) {
      const watched = routes.filter((route) => route.enabled);

      if (!watched.length) throw new Error("Watch at least one route before enabling auto solve");

      for (const route of watched) {
        const report = await this.doctor(route.id);

        if (
          report.checks.some((check) => check.name === route.name + " Omnyo project" && !check.ok)
        )
          throw new Error(missingProjectReason);

        if (!report.ready)
          throw new Error(
            "Auto solve requires the selected machine, repository and model to be ready",
          );
      }
    }

    const result = this.store.savePolicy(input);
    this.changed();
    this.queueDispatch();

    return result;
  }

  async sync(dryRun: boolean, routeIds?: string[]) {
    if (this.disposed) throw new Error("Sentry is stopping");

    if (dryRun) return this.scan(true, routeIds);

    while (this.syncing) {
      const current = this.syncing;
      const covered = current.routeIds;

      if (!covered || routeIds?.every((id) => covered.has(id))) return current.work;

      await current.work.then(
        () => {},
        () => {},
      );

      if (this.disposed) throw new Error("Sentry is stopping");
    }

    const work = this.scan(false, routeIds);
    const current = { routeIds: routeIds ? new Set(routeIds) : null, work };
    this.syncing = current;
    this.changed();

    try {
      return await work;
    } catch (cause) {
      const code = cause instanceof SentryFailure ? cause.code : "intake-failed";

      for (const route of this.store.listRoutes()) {
        if (!route.enabled || (current.routeIds && !current.routeIds.has(route.id))) continue;

        this.store.saveSync(route.id, {
          ...this.store.sync(route.id),
          error: code,
          retryAt: cause instanceof SentryFailure ? cause.retryAt : Date.now() + 60000,
        });
      }

      throw cause;
    } finally {
      if (this.syncing === current) this.syncing = null;
      this.changed();
    }
  }

  startSync() {
    if (this.disposed) throw new Error("Sentry is stopping");
    void this.sync(false).catch(() =>
      this.api.log.warn("Sentry scan failed; the last known inbox and error are retained"),
    );

    return { accepted: true as const };
  }

  private queueDispatch() {
    void this.dispatch().catch(() =>
      this.api.log.warn("Sentry dispatch failed; inspect the retained queue before retrying"),
    );
  }

  private async scan(dryRun: boolean, routeIds?: string[]) {
    const routes = this.store
      .listRoutes()
      .filter(
        (route) =>
          (dryRun || route.enabled) && route.watch && (!routeIds || routeIds.includes(route.id)),
      );

    if (!routes.length) return { candidates: [], scanned: 0, dryRun };
    const config = await this.connection();

    if (!config.apiToken) throw new SentryFailure("access-denied");
    const client = new SentryClient(config.apiOrigin, config.apiToken, this.transport);
    const found = routes.map((): Incident[] => []);
    let scanned = 0;

    const scanRoute = async (route: Route, bounds: string[], candidates: Incident[]) => {
      const state = this.store.sync(route.id);

      if (state.error === "access-denied" || (state.retryAt && state.retryAt > Date.now())) return;
      const until = state.scanStartedAt ?? new Date().toISOString();

      let cursor = state.cursor;

      try {
        if (!cursor && state.completedAt && bounds.length) {
          const sliced = await this.scanSlices(client, route, bounds);
          scanned += sliced.pages;

          if (sliced.covered) {
            candidates.push(...sliced.incidents);

            if (!dryRun) this.store.acceptPage(route, sliced.incidents, null, until);

            return;
          }
        }

        for (let pageCount = 0; pageCount < 5; pageCount++) {
          const page = await client.page(
            route,
            cursor,
            null,
            !this.store.workflow.isEnabledRoute(route.id),
          );

          candidates.push(...page.incidents);
          scanned++;

          if (!dryRun) this.store.acceptPage(route, page.incidents, page.nextCursor, until);
          cursor = page.nextCursor;

          if (!cursor) break;
        }
      } catch (cause) {
        const code = cause instanceof SentryFailure ? cause.code : "intake-failed";

        if (!dryRun && this.store.getRoute(route.id).version === route.version) {
          this.store.saveSync(route.id, {
            ...this.store.sync(route.id),
            error: code,
            retryAt: cause instanceof SentryFailure ? cause.retryAt : Date.now() + 60000,
          });

          if (state.error !== code)
            await this.notify(
              "sentry-sync:" + route.id + ":" + code,
              "Sentry intake needs attention",
              route.name + ": " + code,
            );
        }
      }
    };

    const plans = routes
      .map((route, index) => ({
        route,
        index,
        bounds: sliceBounds(this.store.routeLastSeen(route.id)),
      }))
      .sort((a, b) => b.bounds.length - a.bounds.length);

    await Promise.all(plans.map((plan) => scanRoute(plan.route, plan.bounds, found[plan.index]!)));

    if (!dryRun) this.queueDispatch();
    this.changed();

    return { candidates: found.flat().slice(0, 200), scanned, dryRun };
  }

  private async scanSlices(client: SentryClient, route: Route, bounds: string[]) {
    const slices = await Promise.all(
      [null, ...bounds].map(async (before, index) => {
        const after = bounds[index];
        const incidents: Incident[] = [];
        let cursor: string | null = null;

        for (let pages = 1; pages <= 5; pages++) {
          const page = await client.page(
            route,
            cursor,
            before,
            !this.store.workflow.isEnabledRoute(route.id),
          );

          incidents.push(...page.incidents);
          cursor = page.nextCursor;

          if (
            !cursor ||
            (after && page.oldestSeen && Date.parse(page.oldestSeen) < Date.parse(after))
          )
            return { incidents, pages, covered: true };
        }

        return { incidents, pages: 5, covered: false };
      }),
    );

    const incidents = new Map<string, Incident>();

    for (const slice of slices)
      for (const incident of slice.incidents)
        if (!incidents.has(incident.key)) incidents.set(incident.key, incident);

    return {
      incidents: [...incidents.values()],
      pages: slices.reduce((total, slice) => total + slice.pages, 0),
      covered: slices.every((slice) => slice.covered),
    };
  }

  async investigate(
    routeId: string,
    issueUrl: string,
    mode: "local" | "pr",
    model: ModelSelection | null = null,
  ) {
    const route = this.store.getRoute(routeId);

    if (mode === "pr" && (!route.enabled || route.delivery !== "pr"))
      throw new Error("Enable the exact PR route before publication");
    const config = await this.connection();

    if (!config.apiToken) throw new Error("Connect Sentry in plugin settings");

    const incident = await new SentryClient(
      config.apiOrigin,
      config.apiToken,
      this.transport,
    ).issue(route, issueUrl);

    const target = routeSchema.parse({ ...route, delivery: mode });
    const queued = this.store.enqueue(incident, target, false, true);

    const run =
      model && queued.state === "queued" && !queued.threadId && !queued.spawnRequestedAt
        ? this.store.updateRun(queued.id, { model })
        : queued;

    this.changed();
    this.queueDispatch();

    return run;
  }

  async dispatch() {
    const next = this.serial.then(async () => {
      if (this.disposed) return;
      const run = this.store.claimNext();

      if (!run) return;
      this.launchingRunId = run.id;

      let submitted = false;

      try {
        this.changed();
        const selection = this.runModel(run);

        const [availability, projects, config] = await Promise.all([
          this.modelAvailable(selection, run.route.hostId),
          this.api.sdk.projects.list(),
          this.connection(),
        ]);

        if (!projects.some((project) => project.id === run.route.projectId))
          throw new MissingProject();

        if (availability !== "ready")
          throw new Error("The requested model or reasoning level is unavailable");

        if (this.disposed) return;

        const prepared = this.store.updateRun(run.id, {
          spawnRequestedAt: new Date().toISOString(),
          model: selection,
        });

        submitted = true;

        const spawned = await this.api.sdk.threads.spawn({
          projectId: run.route.projectId,
          providerId: selection.providerId,
          ...executionOf(selection),
          permissionMode: "auto",
          visibility: "visible",
          title:
            run.packageTitle ??
            run.incident.shortId + ": investigate " + run.incident.exceptionType,
          prompt: workerPrompt(prepared, this.solvePolicy(config)),
          pluginMetadata: { runId: run.id },
          environment: {
            type: "provider",
            environmentProviderId: "sentry-worktree",
            machine: { type: "existing", hostId: run.route.hostId },
            inputs: { runId: run.id, routeVersion: run.route.version },
          },
        });

        this.store.bindThread(run.id, spawned.id, spawned.environmentId);

        // Environment binding exposes completion before the spawn response returns.
        // Preserve a fast worker's verified or terminal state.
        if (this.store.getRun(run.id).state === "preparing")
          this.store.updateRun(run.id, { state: "investigating" });
      } catch (cause) {
        if (this.disposed) return;
        const current = this.store.getRun(run.id);

        if (!submitted) {
          const missing = cause instanceof MissingProject;
          this.store.updateRun(run.id, {
            state: "failed",
            reason: missing
              ? missingProjectReason + " No worker was submitted."
              : "The selected machine or model (" +
                modelLabel(this.runModel(current)) +
                ") is unavailable. No worker was submitted; choose another model or retry after doctor passes.",
          });
          this.store.release(run.id);
          await this.notify(
            "sentry-preflight:" + run.id,
            "Sentry investigation needs attention",
            run.route.name +
              (missing
                ? ": its Omnyo project no longer exists"
                : ": selected host/model is unavailable"),
          );
        } else if (current.threadId)
          this.store.updateRun(run.id, {
            reason: "Worker exists; reconcile its actual state before retrying",
          });
        else
          this.store.updateRun(run.id, {
            reason: "Dispatch outcome needs reconciliation; no replacement worker will be spawned",
          });
      } finally {
        this.launchingRunId = null;
      }

      this.changed();
    });

    this.serial = next.catch(() => {});
    await next;
  }

  private worktreeDestination(run: Run, pathKey: string, hostId: string, signal: AbortSignal) {
    const options = { hostId, signal };

    return this.store.workflow.hasRun(run.id)
      ? this.host.call(
          "workflowWorktreePath",
          { runId: run.id, repositoryPath: run.route.repositoryPath, suffix: "fix" },
          options,
        )
      : this.host.call("worktreePath", { pathKey }, options);
  }

  registerEnvironment() {
    this.api.experimental_environments.register({
      id: "sentry-worktree",
      displayName: "Sentry fix worktree",
      description: "Isolate a configured Sentry incident in its exact repository.",
      icon: "Bug",
      requires: { projectCheckout: true },
      inputs: providerInputs,
      policy: { pathKeys: "per-attempt", retireGraceMs: 300000 },
      validate: (context) => {
        const run = this.store.getRun(context.inputs.runId);

        if (
          run.route.projectId !== context.project.id ||
          run.route.hostId !== context.host.id ||
          run.route.version !== context.inputs.routeVersion
        )
          return { action: "refuse", message: "Run target does not match this environment" };

        return { action: "accept" };
      },
      create: async (context) => {
        const run = this.store.getRun(context.inputs.runId);

        if (run.route.projectId !== context.project.id || run.route.hostId !== context.host.id)
          return { status: "failed", message: "Run target changed" };
        this.store.bindThread(run.id, context.thread.id, context.thread.environmentId);

        const source = await this.host.call(
          "inspectRepository",
          {
            repositoryPath: run.route.repositoryPath,
            baseRef: run.route.baseRef,
            expectedRepository: run.route.githubRepository,
          },
          { hostId: context.host.id, signal: context.signal, timeoutMs: 120000 },
        );

        const destination = await this.worktreeDestination(
          run,
          context.pathKey,
          context.host.id,
          context.signal,
        );

        if (!(await context.experimental_claimPath(destination.path)))
          return { status: "failed", message: "Worktree path is already claimed" };
        const branch = "sentry/" + run.id;
        const baseSha = run.baseSha ?? source.baseSha;
        const restore = run.worktreePath === destination.path;
        this.store.updateRun(run.id, {
          worktreePath: destination.path,
          branch,
          baseSha,
          environmentKey: context.pathKey,
        });

        const created = await this.host.call(
          "createWorktree",
          { sourcePath: source.repositoryPath, path: destination.path, branch, baseSha, restore },
          { hostId: context.host.id, signal: context.signal, timeoutMs: 120000 },
        );

        return {
          status: "created",
          path: created.path,
          ownsPath: true,
          mergeBaseBranch: run.route.baseRef,
          resource: { runId: run.id, sourcePath: source.repositoryPath, branch, baseSha },
        };
      },
      restore: async (context) => {
        const run = this.store.getRun(context.inputs.runId);

        if (!run.baseSha || !run.branch)
          return { status: "failed", message: "Original worktree identity is missing" };

        const destination = await this.worktreeDestination(
          run,
          context.pathKey,
          context.host.id,
          context.signal,
        );

        if (!(await context.experimental_claimPath(destination.path)))
          return { status: "failed", message: "Worktree path is already claimed" };

        const created = await this.host.call(
          "createWorktree",
          {
            sourcePath: run.route.repositoryPath,
            path: destination.path,
            branch: run.branch,
            baseSha: run.baseSha,
            restore: true,
          },
          { hostId: context.host.id, signal: context.signal, timeoutMs: 120000 },
        );

        this.store.updateRun(run.id, {
          worktreePath: created.path,
          environmentKey: context.pathKey,
        });

        return {
          status: "created",
          path: created.path,
          ownsPath: true,
          mergeBaseBranch: run.route.baseRef,
          resource: {
            runId: run.id,
            sourcePath: run.route.repositoryPath,
            branch: run.branch,
            baseSha: run.baseSha,
          },
        };
      },
      remove: async (context) => {
        const parsed = resourceSchema.safeParse(context.resource);

        const run = parsed.success
          ? this.store.getRun(parsed.data.runId)
          : this.store.environmentRun(context.pathKey);

        if (!run)
          return {
            status: "failed",
            message: "Owned resource record is unavailable; preserve the path",
          };

        const workflowOwned = this.store.workflow.hasRun(run.id);
        const source = workflowOwned && parsed.success ? parsed.data : null;
        const path = workflowOwned ? (context.path ?? run.worktreePath) : run.worktreePath;
        const branch = source?.branch ?? run.branch;
        const baseSha = source?.baseSha ?? run.baseSha;
        const sourcePath = source?.sourcePath ?? run.route.repositoryPath;

        if (!path || !baseSha || !branch) return { status: "removed" };

        const currentResource =
          path === run.worktreePath && sourcePath === run.route.repositoryPath;

        const removed = await this.host.call(
          "removeWorktree",
          {
            sourcePath,
            path,
            branch,
          },
          { hostId: context.hostId ?? run.route.hostId, signal: context.signal, timeoutMs: 60000 },
        );

        if (currentResource && removed.preservedSha !== null)
          this.store.updateRun(run.id, { preservedSha: removed.preservedSha });

        return { status: "removed" };
      },
    });
  }

  async finish(threadId: string, projectId: string, proposal: Completion, signal: AbortSignal) {
    const owned = this.store.ownedThread(threadId);

    if (!owned || owned.route.projectId !== projectId)
      throw new Error("This thread does not own a Sentry run");

    if (owned.publication || owned.state === "local-ready") return owned;

    if (owned.batchId) {
      const findings = proposal.issueFindings ?? [];
      const keys = new Set(findings.map((finding) => finding.key));

      if (
        keys.size !== owned.relatedIncidents.length ||
        findings.length !== keys.size ||
        owned.relatedIncidents.some((issue) => !keys.has(issue.key))
      )
        throw new Error("Every assigned package issue requires a finding");

      if (findings.some((finding) => finding.outcome !== "blocked" && !finding.evidence.length))
        throw new Error("A fixed issue requires causal and regression/check evidence");

      if (
        findings.some((finding) => finding.outcome === "fixed") &&
        proposal.outcome !== "fix-ready"
      )
        throw new Error("Fixed package members require a verified repair");
    }

    // The bound chat may report until its owner, its project solve or a newer run revokes it.
    const revoked = this.revocation(owned);

    if (revoked) throw new Error(revoked + nothingRecorded);

    if (this.finishControllers.has(owned.id)) throw new Error("Completion is already running");

    // Recording a report has no host, Git or provider effect, so it needs no execution slot.
    // An unrecorded publish attempt may already have opened a draft PR.
    if (proposal.outcome !== "fix-ready") {
      if (owned.publishAttemptedAt) throw new Error(publishUncertainRefusal);

      const value = this.store.updateRun(owned.id, {
        result: proposal,
        state: proposal.outcome === "no-fix" ? "no-fix" : "needs-evidence",
        reason: proposal.summary.slice(0, 500),
      });

      this.changed();

      return value;
    }

    if (!this.store.hasClaim(owned.id))
      throw new Error(
        "Verification needs the execution slot. Ask the user to press Retry on this run in the Sentry panel; it resumes this chat when the slot is free. Nothing was recorded; " +
          (proposal.commit
            ? "commit " + proposal.commit.slice(0, 8) + " stays"
            : "your changes stay") +
          " in this worktree.",
      );
    const controller = new AbortController();
    this.finishControllers.set(owned.id, controller);
    const abort = AbortSignal.any([signal, controller.signal]);

    try {
      this.store.updateRun(owned.id, { result: proposal });

      if (
        proposal.classification === "Hypothesis" ||
        !proposal.reproduction ||
        !proposal.commit ||
        !owned.worktreePath ||
        !owned.baseSha ||
        !owned.branch
      )
        throw new Error("A proven repair, original proof and owned worktree identity are required");
      this.store.updateRun(owned.id, { state: "verifying", reason: null, verification: null });

      const verification = await this.host.call(
        "verify",
        {
          runId: owned.id,
          path: owned.worktreePath,
          baseSha: owned.baseSha,
          head: proposal.commit,
          changedFiles: proposal.changedFiles,
          checks: owned.route.checks,
        },
        {
          hostId: owned.route.hostId,
          signal: abort,
          timeoutMs: Math.min(
            1800000,
            owned.route.checks.reduce((total, check) => total + check.timeoutMs, 60000),
          ),
        },
      );

      const verifiedProposal = completionSchema.parse({ ...proposal, checks: verification.checks });
      this.store.updateRun(owned.id, { result: verifiedProposal });
      assertRequiredChecks(owned.route, verification);
      this.store.updateRun(owned.id, { verification });

      if (owned.route.delivery === "local")
        return this.store.updateRun(owned.id, { state: "local-ready" });
      const live = this.store.getRoute(owned.route.id);

      if (
        live.version !== owned.route.version ||
        live.githubRepository !== owned.route.githubRepository ||
        live.baseRef !== owned.route.baseRef
      )
        throw new Error("The route changed; publication needs owner review");
      assertPublishable(live, verifiedProposal, verification);
      const repository = live.githubRepository;

      if (!repository) throw new Error("No publication repository");
      this.store.updateRun(owned.id, {
        state: "publishing",
        publishAttemptedAt: new Date().toISOString(),
      });

      const publication = await this.host.call(
        "publish",
        {
          path: owned.worktreePath,
          repository,
          head: proposal.commit,
          branch: owned.branch,
          baseBranch: live.baseRef.replace(/^origin\//u, ""),
          runId: owned.id,
          title: owned.incident.shortId + ": " + proposal.summary,
          body: renderPullRequest(
            owned.incident,
            owned.id,
            verifiedProposal,
            owned.relatedIncidents,
          ),
        },
        { hostId: live.hostId, signal: abort, timeoutMs: 240000 },
      );

      return this.store.updateRun(owned.id, { state: "pr-open", publication });
    } catch {
      // A Stop during an in-flight completion stays cancelled.
      if (this.store.getRun(owned.id).state !== "cancelled")
        this.store.updateRun(owned.id, {
          state: "investigating",
          reason:
            "Completion did not pass. Inspect current checks, route authority and any existing remote branch/PR before a targeted retry.",
        });
      throw new Error("Completion did not pass; source and ownership are preserved");
    } finally {
      this.finishControllers.delete(owned.id);
      this.changed();
    }
  }

  private revocation(run: Run) {
    if (run.state === "cancelled") return "This Sentry run was stopped by its owner.";

    return this.supersession(run);
  }

  // Revocations that Retry cannot undo: a stopped project solve or a newer owning run.
  private supersession(run: Run) {
    if (run.batchId && ["stopping", "cancelled"].includes(this.store.getBatch(run.batchId).state))
      return "This package's project solve was stopped.";
    const replacement = this.store.replacementOwner(run);

    if (replacement)
      return "Run " + replacement.owner.id + " now owns " + replacement.issue.shortId + ".";

    return null;
  }

  // Reads the chat's newest root turn with single-type queries, so the per-type
  // limit cannot misorder rows. A stop recorded after that turn started counts
  // as an interruption, including one that raced a natural completion.
  async latestTurn(threadId: string): Promise<TurnOutcome> {
    try {
      let started = null;
      let beforeSeq: string | null = null;

      for (let page = 0; page < 10 && !started; page++) {
        const query: Parameters<PluginApi["sdk"]["threads"]["events"]["list"]>[0] = {
          threadId,
          types: ["turn/started"],
          order: "desc",
          limit: "100",
        };

        if (beforeSeq !== null) query.beforeSeq = beforeSeq;
        const rows = await this.api.sdk.threads.events.list(query);

        started =
          rows.find((row) => row.type === "turn/started" && !row.data.parentToolCallId) ?? null;

        const last = rows.at(-1);

        if (rows.length < 100 || !last) break;
        beforeSeq = String(last.seq);
      }

      if (!started || started.scope.kind !== "turn") return unavailableTurn;
      const turnId = started.scope.turnId;

      const completions = (
        await this.api.sdk.threads.events.list({
          threadId,
          types: ["turn/completed"],
          order: "desc",
          limit: "100",
          afterSeq: String(started.seq),
        })
      ).flatMap((row) =>
        row.type === "turn/completed" && row.scope.kind === "turn" && row.scope.turnId === turnId
          ? [row]
          : [],
      );

      const stopped = completions.some((row) => row.data.status === "interrupted");

      if (
        !completions.length ||
        (!stopped && completions.some((row) => row.data.status === "failed"))
      )
        return unavailableTurn;

      const [interruption] = await this.api.sdk.threads.events.list({
        threadId,
        types: ["system/thread/interrupted"],
        order: "desc",
        limit: "1",
        afterSeq: String(started.seq),
      });

      const seq = Math.max(...completions.map((row) => row.seq));

      if (!stopped && !interruption) return { status: "completed", reason: null, seq };

      return {
        status: "interrupted",
        reason:
          interruption?.type === "system/thread/interrupted" ? interruption.data.reason : null,
        seq,
      };
    } catch {
      return unavailableTurn;
    }
  }

  // The run as it is now, while it still holds the slot unsettled. An owner Stop
  // or a report can land while idle() awaits native state; it must not be undone.
  private unsettledClaim(id: string) {
    const run = this.store.getRun(id);

    return this.store.hasClaim(id) && isActiveRun(run.state) ? run : null;
  }

  // Whether the machine list no longer has this machine; null when the list is unreadable.
  private async machineRemoved(hostId: string) {
    try {
      return !(await this.api.sdk.hosts.list()).some((host) => host.id === hostId);
    } catch {
      return null;
    }
  }

  private async failRun(id: string, reason: string, lastTurnSeq: number | null) {
    this.store.updateRun(id, { state: "failed", reason, lastTurnSeq });
    this.store.release(id);
    await this.dispatch();
  }

  async idle(threadId: string) {
    const run = this.store.ownedThread(threadId);

    if (!run || !this.store.hasClaim(run.id) || this.idleThreads.has(threadId)) return;
    this.idleThreads.add(threadId);

    try {
      let thread;

      try {
        thread = await this.api.sdk.threads.get({ threadId });
      } catch (error) {
        if (deletedChat.safeParse(error).success)
          await this.failRun(run.id, chatDeletedReason, this.store.getRun(run.id).lastTurnSeq);
        else this.store.updateRun(run.id, { reason: unavailableReason });
        this.changed();

        return;
      }

      if (
        thread.status !== "idle" ||
        thread.queuedMessageCount !== 0 ||
        thread.activeBackgroundAgentCount !== 0
      )
        return;
      const current = this.store.getRun(run.id);

      if (!isActiveRun(current.state)) {
        if (!current.result && !["failed", "cancelled"].includes(current.state)) {
          this.store.updateRun(run.id, {
            reason:
              "The settled worker has no validated completion; preserve its execution ownership",
          });
          this.changed();

          return;
        }

        // This is an execution claim, not a lease on an idle provider runtime
        // or a request to retire its source. Completion and the native work
        // counts prove no work remains; workspace preservation is independent.
        this.store.release(run.id);
        await this.dispatch();
        this.changed();

        return;
      }

      // A machine removed after the pause emits no new event; the hold ends here.
      // An unreadable machine list keeps the pause.
      if (current.interruptedAt) {
        const removed = await this.machineRemoved(current.route.hostId);

        if (removed === null) return;
        const paused = this.unsettledClaim(run.id);

        if (!paused) return;

        if (removed) {
          await this.failRun(run.id, machineRemovedReason, paused.lastTurnSeq);
          this.changed();

          return;
        }
      }

      const turn = await this.latestTurn(threadId);
      const latest = this.unsettledClaim(run.id);

      if (!latest) return;

      if (turn.status === "unavailable") {
        if (latest.reason !== unavailableReason)
          this.store.updateRun(run.id, { reason: unavailableReason });
      } else if (turn.status === "interrupted") {
        if (turn.reason === "host-removed")
          await this.failRun(run.id, machineRemovedReason, turn.seq);
        // An unreadable read in between may have replaced the pause guidance.
        else if (!latest.interruptedAt || latest.reason !== interruptedReason)
          this.store.updateRun(run.id, {
            interruptedAt: latest.interruptedAt ?? new Date().toISOString(),
            reason: interruptedReason,
            lastTurnSeq: turn.seq,
          });
      } else if (turn.seq === latest.lastTurnSeq) return;
      else if (latest.reportRequests === 0) {
        try {
          await this.api.sdk.threads.send({
            threadId,
            mode: "auto",
            input: [{ type: "text", text: reminder, mentions: [] }],
          });
        } catch {
          // A removed machine refuses every send and Stop, so only removal ends this hold.
          // An unreadable machine list keeps the visible reason.
          const removed = await this.machineRemoved(latest.route.hostId);
          const failed = this.unsettledClaim(run.id);

          if (failed && removed) await this.failRun(run.id, machineRemovedReason, turn.seq);
          else if (failed) this.store.updateRun(run.id, { reason: reminderFailedReason });
          this.changed();

          return;
        }

        if (this.unsettledClaim(run.id))
          this.store.updateRun(run.id, {
            reportRequests: 1,
            lastTurnSeq: turn.seq,
            reason: "Requesting the missing structured completion from the existing worker",
          });
      } else await this.failRun(run.id, endedTwiceReason, turn.seq);

      this.changed();
    } finally {
      this.idleThreads.delete(threadId);
    }
  }

  async reconcile() {
    for (const run of this.store.claimedRuns()) {
      if (run.id === this.launchingRunId || this.store.workflow.hasRun(run.id)) continue;

      if (!run.threadId) {
        if (!run.spawnRequestedAt) {
          this.store.updateRun(run.id, {
            state: "queued",
            reason: "Preflight was interrupted before any worker submission",
          });
          this.store.release(run.id);
          continue;
        }

        const matches = [];

        for (let offset = 0; offset < 1000; offset += 100) {
          const threads = await this.api.sdk.threads.list({
            projectId: run.route.projectId,
            originPluginId: "sentry",
            includeHidden: true,
            limit: 100,
            offset,
          });

          for (const thread of threads) {
            if (!thread.environmentId) continue;

            const env = await this.api.sdk.environments.get({
              environmentId: thread.environmentId,
            });

            const inputs = providerInputs.safeParse(env.environmentProviderSelection?.inputs);

            if (
              env.environmentProviderId === "sentry-worktree" &&
              env.hostId === run.route.hostId &&
              inputs.success &&
              inputs.data.runId === run.id
            )
              matches.push(thread);
          }

          if (threads.length < 100) break;
        }

        if (matches.length === 1 && matches[0])
          this.store.bindThread(run.id, matches[0].id, matches[0].environmentId);
        else {
          this.store.updateRun(run.id, {
            reason: "Dispatch outcome is uncertain; preserve the claim and inspect the core launch",
          });
          continue;
        }
      }

      const current = this.store.getRun(run.id);

      if (!current.threadId) continue;

      try {
        const thread = await this.api.sdk.threads.get({ threadId: current.threadId });

        if (thread.status === "idle") await this.idle(thread.id);
        else if (thread.status === "error")
          this.store.updateRun(run.id, {
            reason: "Worker failed; existing native retry or explicit owner recovery is required",
          });
      } catch (error) {
        if (deletedChat.safeParse(error).success) {
          await this.failRun(run.id, chatDeletedReason, this.store.getRun(run.id).lastTurnSeq);
          this.changed();
        } else
          this.store.updateRun(run.id, {
            reason: unavailableReason,
          });
      }
    }
  }

  async stop(id: string) {
    let run = this.store.getRun(id);

    if (!run.threadId && this.store.hasClaim(id)) {
      await this.reconcile();
      run = this.store.getRun(id);

      if (!run.threadId)
        throw new Error(
          "The submitted worker is not yet identified; preserve ownership until reconciliation proves its state",
        );
    }

    this.finishControllers.get(id)?.abort();
    await this.host.call("stop", { runId: id }, { hostId: run.route.hostId });

    if (run.threadId)
      try {
        await this.api.sdk.threads.stop({ threadId: run.threadId });
      } catch (error) {
        if (!deletedChat.safeParse(error).success) throw error;
      }

    this.store.release(id);

    const result = this.store.updateRun(id, {
      state: "cancelled",
      reason: "Stopped by owner; source and evidence retained",
    });

    this.changed();
    this.queueDispatch();

    return result;
  }

  async retry(id: string) {
    const run = this.store.getRun(id);

    if (run.publication || run.state === "local-ready") return run;

    if (run.state === "queued" && !run.threadId && !run.spawnRequestedAt) {
      this.store.updateRun(id, { manual: true });
      this.store.requestStart(id);
      this.changed();
      await this.dispatch();

      return this.store.getRun(id);
    }

    if (run.threadId) {
      // Its chat could never report, so the slot and a continue turn would be wasted.
      const superseded = this.supersession(run);

      if (superseded) throw new Error(superseded);
      const claimed = this.store.reclaim(id);
      this.changed();

      const [thread, config] = await Promise.all([
        this.api.sdk.threads.get({ threadId: run.threadId }),
        this.connection(),
      ]);

      if (thread.status === "active") return claimed;
      await this.api.sdk.threads.send({
        threadId: thread.id,
        mode: "auto",
        input: [
          {
            type: "text",
            text:
              "Continue this existing Sentry investigation from its preserved source and evidence. Inspect any queued native retry, remote branch and PR before repeating a side effect.\n\n" +
              workerPrompt(run, this.solvePolicy(config)),
            mentions: [],
          },
        ],
      });

      return this.store.updateRun(id, { state: "investigating", reason: null });
    }

    const next = this.store.enqueue(run.incident, this.store.getRoute(run.route.id), true, true);
    this.changed();
    this.queueDispatch();

    return next;
  }

  async notify(id: string, title: string, body: string) {
    try {
      await this.api.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "notifications.send",
        input: { id, title, body },
        outputSchema: noticeReceipt,
      });
    } catch {
      this.api.log.warn(
        "Sentry status is retained; the configured desktop notification route is unavailable",
      );
    }
  }

  async dispose() {
    this.disposed = true;

    for (const controller of this.finishControllers.values()) controller.abort();
    await this.syncing?.work.catch(() => {});
    await this.serial;
  }
}
