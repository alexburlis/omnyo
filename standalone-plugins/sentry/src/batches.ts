import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  batchSchema,
  type ProjectBatch,
  type Incident,
  type Run,
  type Route,
  packageInputSchema,
  batchFinishSchema,
  type CoordinatorCallbackStatus,
  type ModelSelection,
} from "../contract";
import { SentryRunner, deletedChat, missingProjectReason, type Connection } from "./runner";
import { coordinatorPrompt, executionOf } from "./prompts";
import { SentryClient, SentryFailure } from "./intake";
import { isActiveRun } from "./run-state";

const inputs = z.object({ batchId: z.string() }).strict();

const finished = new Set(["complete", "cancelled"]);

const completionBlocked = "Project completion is blocked";

function issueDisposition(owner: Run, issueKey: string) {
  const result = owner.result;
  const finding = result?.issueFindings?.find((item) => item.key === issueKey);

  if (!result || result.classification === "Hypothesis" || !finding?.evidence.length) return false;

  const verifiedRepair =
    (owner.state === "local-ready" || owner.state === "pr-open") &&
    result.outcome === "fix-ready" &&
    owner.verification?.head === result.commit;

  if (finding.outcome === "fixed") return verifiedRepair;

  if (finding.outcome === "blocked") return false;

  return verifiedRepair || (owner.state === "no-fix" && result.outcome === "no-fix");
}

export const coordinatorInterrupted =
  "Coordinator interrupted. Open it to continue, or use Resume.";

const coordinatorUnavailable =
  "Coordinator state is unavailable; its packages and evidence are preserved.";

const coordinatorDeleted =
  "Its coordinator chat was deleted, so this project investigation ended. Its packages, branches and evidence are preserved.";

const planReminderFailed =
  "The project-plan reminder could not be sent; the coordinator and its packages are preserved.";

export class ProjectBatches {
  private pending = new Map<string, Promise<void>>();
  private disposed = false;
  private progressing: Promise<void> | null = null;
  private idleThreads = new Set<string>();
  constructor(
    readonly runner: SentryRunner,
    private connection: () => Promise<Connection>,
    private transport: typeof fetch = fetch,
  ) {}

  private model(batch: ProjectBatch): ModelSelection {
    return (
      batch.model ?? {
        providerId: "codex",
        model: "gpt-6.1-sol",
        reasoningLevel: "ultra",
        serviceTier: "default",
      }
    );
  }
  private execution(batch: ProjectBatch) {
    return executionOf(this.model(batch));
  }
  start(projectId: string, model: ModelSelection | null = null) {
    if (this.disposed) throw new Error("Sentry is stopping");

    const previous = this.runner.store
      .listBatches()
      .find((batch) => batch.projectId === projectId && !finished.has(batch.state));

    if (previous) return previous;

    const routes = this.runner.store
      .listRoutes()
      .filter((route) => route.enabled && route.projectId === projectId);

    if (!routes.length) throw new Error("Watch a repository in this Omnyo project first");

    if (new Set(routes.map((route) => route.hostId)).size !== 1)
      throw new Error("Project-wide solving requires one execution machine");
    const now = new Date().toISOString();

    const batch = batchSchema.parse({
      id: "batch_" + randomUUID().replaceAll("-", ""),
      projectId,
      hostId: routes[0]!.hostId,
      sourceId: null,
      rootPath: null,
      routes,
      incidents: [],
      state: "preparing",
      threadId: null,
      spawnRequestedAt: null,
      summaryMarker: null,
      summarySentAt: null,
      runIds: [],
      blocked: [],
      summary: null,
      reason: null,
      reportRequests: 0,
      lastTurnSeq: null,
      model: model ?? this.runner.store.modelDefaults().coordinator,
      createdAt: now,
      updatedAt: now,
    });

    this.runner.store.saveBatch(batch);
    this.runner.changed();
    this.queue(batch.id);

    return batch;
  }
  private queue(id: string) {
    if (this.pending.has(id) || this.disposed) return;

    const work = this.prepare(id).finally(() => {
      this.pending.delete(id);
    });

    this.pending.set(id, work);
  }
  private liveRoutes(batch: ProjectBatch) {
    for (const route of batch.routes) this.requireCurrentRoute(route);
  }
  private requireCurrentRoute(route: Route) {
    const live = this.runner.store.getRoute(route.id);

    if (!live.enabled || JSON.stringify(live) !== JSON.stringify(route))
      throw new Error(
        "Repository mapping " +
          route.id +
          " changed or was disabled. Continue unaffected mappings. Verify the exact authorized target before starting any new work on this mapping.",
      );
  }
  private hasPendingRuns(runIds: readonly string[]) {
    const store = this.runner.store;

    return runIds.some((id) => {
      const run = store.getRun(id);

      if (store.hasClaim(id)) return true;

      if (run.state === "queued") return store.getRoute(run.route.id).version === run.route.version;

      return isActiveRun(run.state);
    });
  }
  private async prepare(id: string) {
    try {
      let batch = this.runner.store.getBatch(id);

      if (batch.threadId || batch.spawnRequestedAt || finished.has(batch.state)) return;
      this.liveRoutes(batch);

      const project = (await this.runner.api.sdk.projects.list()).find(
        (project) => project.id === batch.projectId,
      );

      if (!project) throw new Error(missingProjectReason);

      const source = project.sources.find(
        (source) =>
          source.type === "local_path" &&
          source.hostId === batch.hostId &&
          source.path &&
          batch.routes.every(
            (route) =>
              route.repositoryPath === source.path ||
              route.repositoryPath.startsWith(source.path + "/"),
          ),
      );

      if (!source?.path)
        throw new Error(
          "No registered project source contains all selected repositories on this machine",
        );
      const config = await this.connection();

      if (!config.apiToken) throw new Error("Connect Sentry in plugin settings");
      const client = new SentryClient(config.apiOrigin, config.apiToken, this.transport);
      const issues = new Map<string, Incident>();

      for (const route of batch.routes) {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        let complete = false;

        for (let index = 0; index < 100; index++) {
          if (
            this.disposed ||
            ["cancelled", "stopping"].includes(this.runner.store.getBatch(id).state)
          )
            return;
          const page = await client.page(route, cursor, null);

          for (const issue of page.incidents) {
            const previous = issues.get(issue.key);
            issues.set(issue.key, {
              ...issue,
              matchedRouteIds: [...new Set([...(previous?.matchedRouteIds ?? []), route.id])],
            });
          }

          if (issues.size > 10000)
            throw new Error(
              "Project inventory exceeds 10,000 issues. Narrow the watched scope before solving.",
            );
          cursor = page.nextCursor;

          if (!cursor) {
            complete = true;
            break;
          }

          if (cursors.has(cursor)) throw new Error("Sentry returned a repeated issue cursor");
          cursors.add(cursor);
        }

        if (!complete)
          throw new Error(
            "Project inventory is incomplete. Narrow the watched scope before solving.",
          );
      }

      for (const hold of this.runner.store.activeDiagnosticsHolds()) {
        const matching = batch.routes.filter(
          (route) => route.id === hold.route.id && route.version === hold.route.version,
        );

        if (matching.length && !issues.has(hold.issue.key))
          issues.set(hold.issue.key, {
            ...hold.issue,
            matchedRouteIds: matching.map((route) => route.id),
          });
      }

      if (this.disposed || ["cancelled", "stopping"].includes(this.runner.store.getBatch(id).state))
        return;
      this.liveRoutes(batch);
      batch = this.runner.store.updateBatch(id, {
        rootPath: source.path,
        sourceId: source.id,
        incidents: [...issues.values()],
      });

      if (!issues.size) {
        this.runner.store.updateBatch(id, {
          state: "complete",
          summary: "No open issues in the watched project scopes.",
        });
        this.runner.changed();

        return;
      }

      const selection = this.model(batch);

      if ((await this.runner.modelAvailable(selection, batch.hostId!)) !== "ready")
        throw new Error(
          selection.model +
            " · " +
            selection.reasoningLevel +
            " is unavailable on the selected machine. Choose another Solve all model.",
        );

      if (this.disposed || ["cancelled", "stopping"].includes(this.runner.store.getBatch(id).state))
        return;
      this.runner.store.updateBatch(id, {
        spawnRequestedAt: new Date().toISOString(),
        state: "planning",
      });

      const spawned = await this.runner.api.sdk.threads.spawn({
        projectId: batch.projectId,
        providerId: selection.providerId,
        ...this.execution(batch),
        permissionMode: "auto",
        visibility: "visible",
        title: "Solve all · " + project!.name,
        prompt: coordinatorPrompt(batch),
        pluginMetadata: { batchId: id },
        environment: {
          type: "provider",
          environmentProviderId: "sentry-project",
          machine: { type: "existing", hostId: batch.hostId! },
          inputs: { batchId: id },
        },
      });

      this.runner.store.bindBatchThread(id, spawned.id);
    } catch (cause) {
      const batch = this.runner.store.getBatch(id);

      if (batch.state === "cancelled") return;

      const message =
        cause instanceof SentryFailure
          ? "Sentry inventory failed: " + cause.code
          : cause instanceof Error
            ? cause.message
            : "Project investigation could not start";

      this.runner.store.updateBatch(id, {
        state: batch.spawnRequestedAt ? "planning" : "failed",
        reason: batch.spawnRequestedAt
          ? "Coordinator launch is uncertain; reconcile the existing launch before resuming."
          : message.slice(0, 500),
      });
    } finally {
      this.runner.changed();
    }
  }
  owned(threadId: string, projectId: string, allowComplete = false) {
    const batch = this.runner.store.ownedBatch(threadId);

    if (
      !batch ||
      batch.projectId !== projectId ||
      (finished.has(batch.state) && !(allowComplete && batch.state === "complete")) ||
      ["failed", "stopping"].includes(batch.state)
    )
      throw new Error("This thread does not own an active project investigation");

    return batch;
  }
  context(threadId: string, projectId: string, offset: number) {
    const batch = this.owned(threadId, projectId, true);

    return {
      batch: { ...batch, incidents: undefined },
      total: batch.incidents.length,
      nextOffset: offset + 100 < batch.incidents.length ? offset + 100 : null,
      issues: batch.incidents.slice(offset, offset + 100).map((issue) => ({
        issue,
        owner: this.runner.store.issueOwner(issue.key),
        diagnosticsHold: this.runner.store.diagnosticsHold(issue.key),
      })),
      packages: batch.runIds.map((id) => this.runner.store.getRun(id)),
    };
  }
  callbackStatus() {
    const coordinators: CoordinatorCallbackStatus[] = [];

    for (const batch of this.runner.store.listBatches()) {
      if (!batch.threadId || !["waiting", "summarizing"].includes(batch.state)) continue;
      const runs = batch.runIds.map((id) => this.runner.store.getRun(id));
      const queued = runs.filter((run) => run.state === "queued").length;

      const running = runs.filter((run) =>
        ["preparing", "investigating", "verifying", "publishing"].includes(run.state),
      ).length;

      const interrupted = runs.find((run) => run.interruptedAt && isActiveRun(run.state));

      const blocker = runs.find(
        (run) =>
          ["failed", "needs-evidence"].includes(run.state) ||
          (["queued", "preparing"].includes(run.state) &&
            run.reason !== null &&
            run.reason !== run.packageHandoff),
      );

      // A paused package holds the execution slot until its chat continues or it is stopped.
      const reason =
        batch.reason ??
        (interrupted
          ? interrupted.incident.shortId +
            " package interrupted. Open its chat to continue, or stop it."
          : (blocker?.reason ?? null));

      coordinators.push({
        threadId: batch.threadId,
        batchId: batch.id,
        state: reason || blocker ? "blocked" : running ? "running" : queued ? "queued" : "waiting",
        packageCount: runs.length,
        queued,
        running,
        reason,
      });

      if (coordinators.length === 100) break;
    }

    return { coordinators };
  }
  queuePackage(threadId: string, projectId: string, input: z.infer<typeof packageInputSchema>) {
    const batch = this.owned(threadId, projectId);

    if (!["planning", "summarizing"].includes(batch.state))
      throw new Error(
        "Package workers are still pending; wait for the native coordinator callback",
      );
    const route = batch.routes.find((route) => route.id === input.routeId);

    if (!route) throw new Error("Repository is outside this project inventory");
    this.requireCurrentRoute(route);
    const keys = [...new Set(input.issueKeys)];

    const issues = keys.map((key) => {
      const issue = batch.incidents.find(
        (issue) => issue.key === key && issue.matchedRouteIds.includes(route.id),
      );

      if (!issue) throw new Error("Issue is outside this exact repository mapping");
      const hold = this.runner.store.diagnosticsHold(key);

      if (hold && ["pending", "paused"].includes(hold.state))
        throw new Error("This issue already has an owned diagnostics release follow-up");

      return issue;
    });

    const owners = issues.map((issue) => this.runner.store.issueOwner(issue.key));

    if (owners.some(Boolean)) {
      const ids = [...new Set(owners.flatMap((owner) => (owner ? [owner.id] : [])))];
      const existing = ids.length === 1 ? this.runner.store.getRun(ids[0]!) : null;

      if (
        existing &&
        existing.batchId === batch.id &&
        owners.every(Boolean) &&
        existing.relatedIncidents.length === issues.length &&
        issues.every((issue) =>
          existing.relatedIncidents.some((related) => related.key === issue.key),
        )
      )
        return existing;

      if (
        owners.some(
          (owner) => owner && (isActiveRun(owner.state) || this.runner.store.hasClaim(owner.id)),
        )
      )
        throw new Error(
          "An issue already has an active solver. Reference its owner instead of duplicating it.",
        );
    }

    const run = this.runner.store.enqueue(issues[0]!, route, true, true);

    const grouped = this.runner.store.updateRun(run.id, {
      batchId: batch.id,
      relatedIncidents: issues,
      packageTitle: input.title,
      model: this.model(batch),
      packageHandoff: input.rationale,
      reason: null,
    });

    this.runner.store.updateBatch(batch.id, { runIds: [...batch.runIds, run.id] });
    this.runner.changed();
    void this.runner
      .dispatch()
      .catch(() => this.runner.api.log.warn("Grouped Sentry work remains in the durable queue"));

    return grouped;
  }
  async finish(
    threadId: string,
    projectId: string,
    input: z.infer<typeof batchFinishSchema>,
    signal?: AbortSignal,
  ) {
    const batch = this.owned(threadId, projectId, true);
    const blockedKeys = new Set(input.blocked.map((issue) => issue.issueKey));

    if (input.blocked.some((item) => !batch.incidents.some((issue) => issue.key === item.issueKey)))
      throw new Error("Blocked issue is outside this inventory");
    const owners = batch.incidents.map((issue) => this.runner.store.issueOwner(issue.key));

    if (batch.incidents.some((issue, index) => !owners[index] && !blockedKeys.has(issue.key)))
      throw new Error("Every issue needs a package, existing owner or explicit blocker");
    const runIds = [...new Set(owners.flatMap((owner) => (owner ? [owner.id] : [])))];

    if (this.hasPendingRuns(runIds)) {
      if (batch.state === "complete")
        throw new Error("Completed project reporting cannot reopen active packages");

      const result = this.runner.store.updateBatch(batch.id, {
        state: "waiting",
        runIds,
        blocked: input.blocked,
        summary: input.summary,
        summaryMarker: batch.state === "waiting" ? batch.summaryMarker : null,
        summarySentAt: batch.state === "waiting" ? batch.summarySentAt : null,
        reason: null,
      });

      this.runner.changed();

      return result;
    }

    if (batch.state === "complete")
      return this.runner.store.updateBatch(batch.id, { summary: input.summary });

    const blocked = [...input.blocked];

    for (const [index, issue] of batch.incidents.entries()) {
      const owner = owners[index];

      if (blockedKeys.has(issue.key) || (owner && issueDisposition(owner, issue.key))) continue;
      blocked.push({
        issueKey: issue.key,
        reason:
          owner?.reason ??
          "This issue still needs a verified repair or evidence-backed disposition",
      });
    }

    const refuseCompletion = (detail: string): never => {
      const reason = completionBlocked + ". " + detail;
      this.runner.store.updateBatch(batch.id, {
        state: "planning",
        runIds,
        blocked,
        summary: input.summary,
        summaryMarker: null,
        summarySentAt: null,
        reason,
      });
      this.runner.changed();
      throw new Error(reason);
    };

    if (blocked.length)
      refuseCompletion(blocked.length + " issues still need action. Inspect project context.");

    const threads = [
      ...new Set([
        threadId,
        ...owners.flatMap((owner) => (owner?.threadId ? [owner.threadId] : [])),
      ]),
    ];

    const { sdk } = this.runner.api;
    let pendingInput = false;
    let inputUnavailable = false;

    try {
      for (let offset = 0; offset < threads.length && !pendingInput; offset += 25) {
        const checks = await Promise.all(
          threads.slice(offset, offset + 25).map(async (id) => {
            const [interactions, attention] = await Promise.all([
              sdk.threads.interactions.list({ threadId: id, signal }),
              sdk.experimental_attention.history({ threadId: id, signal }),
            ]);

            return (
              interactions.some(
                ({ status, payload }) =>
                  status === "pending" && ["approval", "user_question"].includes(payload.kind),
              ) ||
              attention.questions.some(
                ({ state, question }) => state === "open" && question.mode === "required",
              )
            );
          }),
        );

        pendingInput = checks.some(Boolean);
      }
    } catch {
      inputUnavailable = true;
    }

    signal?.throwIfAborted();

    // A Stop, another finalizer or a new run can land during the native input check.
    if (
      JSON.stringify(this.owned(threadId, projectId, true)) !== JSON.stringify(batch) ||
      batch.incidents.some((issue, index) => {
        const owner = this.runner.store.issueOwner(issue.key);

        return (
          JSON.stringify(owner) !== JSON.stringify(owners[index]) ||
          (owner && this.runner.store.hasClaim(owner.id))
        );
      })
    )
      throw new Error(
        "Project investigation changed during verification. Recheck project context.",
      );

    if (inputUnavailable) refuseCompletion("Approval and required-question state is unavailable.");

    if (pendingInput) refuseCompletion("A required approval or question is still pending.");

    const result = this.runner.store.updateBatch(batch.id, {
      state: "complete",
      runIds,
      blocked,
      summary: input.summary,
      reason: null,
    });

    this.runner.changed();
    void this.runner.notify(
      "sentry-project:" + batch.id,
      "Sentry project investigation complete",
      input.summary,
    );

    return result;
  }
  private async adopt(batch: ProjectBatch) {
    const matches = [];

    for (let offset = 0; offset < 1000; offset += 100) {
      const threads = await this.runner.api.sdk.threads.list({
        projectId: batch.projectId,
        originPluginId: "sentry",
        includeHidden: true,
        limit: 100,
        offset,
      });

      for (const thread of threads) {
        if (!thread.environmentId) continue;

        const environment = await this.runner.api.sdk.environments.get({
          environmentId: thread.environmentId,
        });

        const parsed = inputs.safeParse(environment.environmentProviderSelection?.inputs);

        if (
          environment.environmentProviderId === "sentry-project" &&
          environment.hostId === batch.hostId &&
          parsed.success &&
          parsed.data.batchId === batch.id
        )
          matches.push(thread);
      }

      if (threads.length < 100) break;
    }

    if (matches.length === 1) return this.runner.store.bindBatchThread(batch.id, matches[0]!.id);
    this.runner.store.updateBatch(batch.id, {
      reason:
        "Coordinator launch is uncertain; inspect the existing native launch before resuming.",
    });

    return null;
  }
  async reconcile() {
    for (const batch of this.runner.store.listBatches())
      if (batch.state === "preparing" && !batch.spawnRequestedAt) this.queue(batch.id);
    await Promise.all(this.pending.values());

    for (const batch of this.runner.store.listBatches())
      if (batch.spawnRequestedAt && !batch.threadId && !finished.has(batch.state))
        await this.adopt(batch).catch(() =>
          this.runner.store.updateBatch(batch.id, {
            reason: "Coordinator launch is uncertain; native state is unavailable.",
          }),
        );

    // Idle events are dropped during a maintenance hold; catch up idle coordinators once.
    // One unreadable coordinator keeps its reason and is read again next time;
    // the other batches, progress and the scheduled sync continue.
    for (const batch of this.runner.store.listBatches()) {
      if (!batch.threadId || !["planning", "summarizing"].includes(batch.state)) continue;

      try {
        const thread = await this.runner.api.sdk.threads.get({ threadId: batch.threadId });

        if (this.runner.store.getBatch(batch.id).reason === coordinatorUnavailable)
          this.runner.store.updateBatch(batch.id, { reason: null });

        if (
          thread.status === "idle" &&
          thread.queuedMessageCount === 0 &&
          thread.activeBackgroundAgentCount === 0
        )
          await this.idle(batch.threadId);
      } catch (error) {
        const current = this.runner.store.getBatch(batch.id);

        if (!["planning", "summarizing"].includes(current.state)) continue;

        if (deletedChat.safeParse(error).success)
          this.runner.store.updateBatch(batch.id, { state: "failed", reason: coordinatorDeleted });
        else if (current.reason !== coordinatorUnavailable)
          this.runner.store.updateBatch(batch.id, { reason: coordinatorUnavailable });
      }
    }

    await this.progress();
  }
  async progress() {
    if (this.progressing) return this.progressing;
    const work = this.updateProgress();
    this.progressing = work;

    try {
      await work;
    } finally {
      this.progressing = null;
    }
  }
  private async updateProgress() {
    for (const batch of this.runner.store.listBatches()) {
      if (this.disposed || !batch.threadId || !["waiting", "summarizing"].includes(batch.state))
        continue;

      if (this.hasPendingRuns(batch.runIds)) continue;

      try {
        const thread = await this.runner.api.sdk.threads.get({ threadId: batch.threadId });

        if (thread.status !== "idle") continue;

        if (batch.summaryMarker) {
          const [history, queued] = await Promise.all([
            this.runner.api.sdk.threads.promptHistory({ threadId: batch.threadId, limit: "100" }),
            this.runner.api.sdk.threads.queuedMessages.list({ threadId: batch.threadId }),
          ]);

          if (JSON.stringify([history, queued]).includes(batch.summaryMarker)) {
            if (!batch.summarySentAt)
              this.runner.store.updateBatch(batch.id, {
                summarySentAt: new Date().toISOString(),
                reason: null,
              });
          } else
            this.runner.store.updateBatch(batch.id, {
              reason:
                "Summary delivery is uncertain. Open the existing chat or Resume to continue; no prompt was repeated.",
            });
          continue;
        }

        const turn = await this.runner.latestTurn(batch.threadId);
        // A project-solve Stop can land while the history is read.
        const current = this.runner.store.getBatch(batch.id);

        if (
          !["waiting", "summarizing"].includes(current.state) ||
          current.summaryMarker ||
          this.hasPendingRuns(current.runIds)
        )
          continue;

        if (turn.status === "interrupted") {
          if (current.reason !== coordinatorInterrupted)
            this.runner.store.updateBatch(batch.id, { reason: coordinatorInterrupted });
          continue;
        }

        if (turn.status === "unavailable") continue;
        const marker = "sentry-project-summary:" + batch.id + ":" + randomUUID();

        // Only a coordinator turn that completes after this prompt can settle the summary.
        this.runner.store.updateBatch(batch.id, {
          state: "summarizing",
          summaryMarker: marker,
          reason: null,
          lastTurnSeq: turn.seq,
        });
        await this.runner.api.sdk.threads.send({
          threadId: batch.threadId,
          mode: "auto",
          ...this.execution(batch),
          input: [
            {
              type: "text",
              text:
                marker +
                "\nThis round of packages stopped. Read actual per-issue results and queue the next authorized work in this batch. Continue unaffected mappings while a route or approval is blocked. Recheck watched unresolved queues and request terminal completion only after every required action is verified.",
              mentions: [],
            },
          ],
        });
        const sent = this.runner.store.getBatch(batch.id);

        if (sent.state === "summarizing" && sent.summaryMarker === marker)
          this.runner.store.updateBatch(batch.id, { summarySentAt: new Date().toISOString() });
      } catch (error) {
        if (
          deletedChat.safeParse(error).success &&
          ["waiting", "summarizing"].includes(this.runner.store.getBatch(batch.id).state)
        )
          this.runner.store.updateBatch(batch.id, { state: "failed", reason: coordinatorDeleted });
        else
          this.runner.store.updateBatch(batch.id, {
            reason:
              "Summary delivery is uncertain. Open the existing coordinator; no replacement or repeated prompt was submitted.",
          });
      }
    }

    this.runner.changed();
  }
  async idle(threadId: string) {
    const batch = this.runner.store.ownedBatch(threadId);

    // The idle event and reconcile catch-up can overlap; only one reads the turn.
    if (
      batch &&
      ["planning", "summarizing"].includes(batch.state) &&
      !this.idleThreads.has(threadId)
    ) {
      this.idleThreads.add(threadId);

      try {
        await this.coordinatorTurn(batch.id, threadId);
      } finally {
        this.idleThreads.delete(threadId);
      }
    }

    await this.progress();
    this.runner.changed();
  }
  // Acts once per completed coordinator turn. A Stop or Resume can land while the
  // history is read or the reminder is sent, so each write uses the current batch.
  private async coordinatorTurn(id: string, threadId: string) {
    const turn = await this.runner.latestTurn(threadId);
    const batch = this.runner.store.getBatch(id);

    if (!["planning", "summarizing"].includes(batch.state)) return;

    if (turn.status === "interrupted") {
      if (batch.reason !== coordinatorInterrupted)
        this.runner.store.updateBatch(id, {
          reason: coordinatorInterrupted,
          lastTurnSeq: turn.seq,
        });

      return;
    }

    if (turn.status !== "completed" || turn.seq === batch.lastTurnSeq) return;

    if (this.hasPendingRuns(batch.runIds)) {
      this.runner.store.updateBatch(id, {
        state: "waiting",
        summaryMarker: null,
        summarySentAt: null,
        lastTurnSeq: turn.seq,
      });

      return;
    }

    if (batch.reason?.startsWith(completionBlocked)) return;

    if (batch.state === "planning" && batch.reportRequests === 0) {
      try {
        await this.runner.api.sdk.threads.send({
          threadId,
          mode: "auto",
          ...this.execution(batch),
          input: [
            {
              type: "text",
              text: "Read sentry_project_context. Continue authorized repairs and preserve existing owners. Use sentry_finish_project to wait for active workers or to submit verified terminal results. Report required blockers as unfinished.",
              mentions: [],
            },
          ],
        });
      } catch {
        if (this.runner.store.getBatch(id).state === "planning")
          this.runner.store.updateBatch(id, { reason: planReminderFailed });

        return;
      }

      if (this.runner.store.getBatch(id).state === "planning")
        this.runner.store.updateBatch(id, {
          reportRequests: 1,
          lastTurnSeq: turn.seq,
          reason: "Requesting the missing project plan from its existing coordinator",
        });
    } else if (batch.state === "summarizing" && batch.summarySentAt)
      this.runner.store.updateBatch(id, {
        state: "failed",
        reason: "Coordinator stopped without a final project summary. Resume its existing chat.",
        lastTurnSeq: turn.seq,
      });
    else if (batch.state === "planning")
      this.runner.store.updateBatch(id, {
        state: "failed",
        reason: "Coordinator stopped without accounting for every issue. Resume its existing chat.",
        lastTurnSeq: turn.seq,
      });
  }
  async resume(id: string) {
    const batch = this.runner.store.getBatch(id);

    if (finished.has(batch.state)) return batch;

    if (batch.state === "stopping") return this.stop(id);

    if (!batch.threadId) {
      if (batch.spawnRequestedAt) {
        await this.adopt(batch);

        return this.runner.store.getBatch(id);
      }

      this.runner.store.updateBatch(id, { state: "preparing", reason: null });
      this.queue(id);

      return this.runner.store.getBatch(id);
    }

    const thread = await this.runner.api.sdk.threads.get({ threadId: batch.threadId });

    if (thread.status === "active") return batch;
    const turn = await this.runner.latestTurn(batch.threadId);
    // A project-solve Stop can land while the history is read.
    const current = this.runner.store.getBatch(id);

    if (current.state === "stopping" || finished.has(current.state)) return current;
    this.runner.store.updateBatch(id, {
      state: current.state === "planning" || !current.runIds.length ? "planning" : "summarizing",
      reason: null,
      reportRequests: 0,
      lastTurnSeq: turn.status === "unavailable" ? current.lastTurnSeq : turn.seq,
    });
    await this.runner.api.sdk.threads.send({
      threadId: batch.threadId,
      mode: "auto",
      ...this.execution(this.runner.store.getBatch(id)),
      input: [
        {
          type: "text",
          text: "Resume this existing project investigation from sentry_project_context. Preserve existing packages and evidence. Continue authorized repairs without duplicating workers. Request terminal completion only after every issue and required approval is settled.",
          mentions: [],
        },
      ],
    });
    this.runner.changed();

    return this.runner.store.getBatch(id);
  }
  async stop(id: string) {
    const batch = this.runner.store.getBatch(id);

    if (finished.has(batch.state)) return batch;

    if (batch.spawnRequestedAt && !batch.threadId) {
      const adopted = await this.adopt(batch);

      if (!adopted?.threadId)
        throw new Error(
          "Coordinator launch is uncertain; identify the existing launch before stopping",
        );
    }

    this.runner.store.updateBatch(id, {
      state: "stopping",
      reason: "Stopping the coordinator and its package workers",
    });
    const current = this.runner.store.getBatch(id);

    if (current.threadId)
      try {
        await this.runner.api.sdk.threads.stop({ threadId: current.threadId });
      } catch (error) {
        if (!deletedChat.safeParse(error).success) throw error;
      }

    for (const runId of this.runner.store.getBatch(id).runIds) {
      const run = this.runner.store.getRun(runId);

      if (run.batchId === id && (isActiveRun(run.state) || this.runner.store.hasClaim(runId)))
        await this.runner.stop(runId);
    }

    this.runner.store.updateBatch(id, {
      state: "cancelled",
      reason: "Stopped; existing source, branches and evidence are preserved",
    });
    this.runner.changed();

    return this.runner.store.getBatch(id);
  }
  registerEnvironment() {
    this.runner.api.experimental_environments.register({
      id: "sentry-project",
      displayName: "Sentry project coordinator",
      description: "Inspect one registered Omnyo project and delegate isolated Sentry packages.",
      icon: "Bug",
      requires: { projectCheckout: true },
      inputs,
      policy: { pathKeys: "per-attempt", retireGraceMs: 300000 },
      validate: (context) => {
        const batch = this.runner.store.getBatch(context.inputs.batchId);

        return batch.projectId === context.project.id &&
          batch.hostId === context.host.id &&
          batch.rootPath &&
          !finished.has(batch.state)
          ? { action: "accept" }
          : { action: "refuse", message: "Project investigation target does not match" };
      },
      create: async (context) => {
        const batch = this.runner.store.getBatch(context.inputs.batchId);
        const projects = await this.runner.api.sdk.projects.list();

        const source = projects
          .find((project) => project.id === batch.projectId)
          ?.sources.find(
            (source) =>
              source.id === batch.sourceId &&
              source.type === "local_path" &&
              source.hostId === batch.hostId &&
              source.path === batch.rootPath,
          );

        if (
          !source ||
          !batch.rootPath ||
          batch.projectId !== context.project.id ||
          batch.hostId !== context.host.id ||
          finished.has(batch.state)
        )
          return { status: "failed", message: "Registered project source changed" };
        this.runner.store.bindBatchThread(batch.id, context.thread.id);

        const workspace = await this.runner.host.call(
          "coordinatorWorkspace",
          { pathKey: context.pathKey, action: "ensure" },
          { hostId: context.host.id, signal: context.signal },
        );

        return {
          status: "created",
          path: workspace.path,
          ownsPath: true,
          resource: { batchId: batch.id, workspaceKey: context.pathKey },
        };
      },
      restore: async (context) => {
        const batch = this.runner.store.getBatch(context.inputs.batchId);

        if (
          !batch.rootPath ||
          batch.projectId !== context.project.id ||
          batch.hostId !== context.host.id ||
          batch.threadId !== context.thread.id
        )
          return { status: "failed", message: "Project investigation identity changed" };

        const workspace = await this.runner.host.call(
          "coordinatorWorkspace",
          { pathKey: context.pathKey, action: "ensure" },
          { hostId: context.host.id, signal: context.signal },
        );

        return {
          status: "created",
          path: workspace.path,
          ownsPath: true,
          resource: { batchId: batch.id, workspaceKey: context.pathKey },
        };
      },
      remove: async (context) => {
        // Older coordinators attached the canonical checkout without owning it.
        const resource = z
          .object({ batchId: z.string(), workspaceKey: z.string() })
          .safeParse(context.resource);

        if (resource.success) {
          const batch = this.runner.store.getBatch(resource.data.batchId);

          if (resource.data.workspaceKey !== context.pathKey || !batch.hostId)
            return { status: "failed", message: "Coordinator workspace identity changed" };
          await this.runner.host.call(
            "coordinatorWorkspace",
            { pathKey: context.pathKey, action: "remove" },
            { hostId: batch.hostId, signal: context.signal },
          );
        }

        return { status: "removed" };
      },
    });
  }
  async dispose() {
    this.disposed = true;
    await Promise.all(this.pending.values());
    await this.progressing;
  }
}
