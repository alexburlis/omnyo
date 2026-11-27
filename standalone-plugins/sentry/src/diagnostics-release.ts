import { z } from "zod";
import { incidentSchema, routeSchema } from "../contract";
import { sha } from "./contract-fields";
import { SentryClient, SentryFailure } from "./intake";
import { assertRequiredChecks, diagnosticsReleaseSchema } from "./repair-result-contract";
import type { Connection, SentryRunner } from "./runner";

const leaseMinutes = 24 * 60;

const renewWithinMs = 2 * 60 * 60 * 1000;

export const diagnosticsHoldSchema = z.object({
  runId: z.string(),
  issue: incidentSchema,
  route: routeSchema,
  apiOrigin: z.string(),
  release: diagnosticsReleaseSchema,
  commit: sha,
  state: z.enum(["pending", "paused", "resumed", "interrupted"]),
  until: z.string().nullable(),
  checkedAt: z.number(),
  reason: z.string().nullable(),
});

export type DiagnosticsHold = z.infer<typeof diagnosticsHoldSchema>;

export class DiagnosticsReleaseFlow {
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly runner: SentryRunner,
    private readonly connection: () => Promise<Connection>,
    private readonly transport: typeof fetch,
  ) {}

  async begin(threadId: string, projectId: string, key: string) {
    const { store } = this.runner;
    const run = store.ownedThread(threadId);

    if (!run || run.route.projectId !== projectId || store.issueOwner(key)?.id !== run.id)
      throw new Error("This thread does not own the diagnostic issue");
    const issue = [run.incident, ...run.relatedIncidents].find((item) => item.key === key);
    const proposal = run.result;
    const finding = proposal?.issueFindings?.find((item) => item.key === key);
    const verification = run.verification;

    if (
      !issue ||
      !finding?.diagnosticsRelease ||
      finding.outcome !== "blocked" ||
      !["local-ready", "pr-open"].includes(run.state) ||
      proposal?.outcome !== "fix-ready" ||
      proposal.classification !== "Reproduced" ||
      !proposal.commit ||
      !proposal.reproduction ||
      !verification ||
      verification.head !== proposal.commit
    )
      throw new Error(
        "A verified logging regression and an exact diagnostics release are required",
      );

    assertRequiredChecks(run.route, verification);
    const regression = proposal.reproduction;

    if (
      !run.route.checks.some(
        (check) => [check.command, ...check.args].join(" ") === regression.command,
      ) ||
      !finding.evidence.some(
        (path) => regression.evidence.includes(path) && verification.changedFiles.includes(path),
      )
    )
      throw new Error(
        "An executed route check must exercise the committed logging regression for this issue",
      );

    const config = await this.connection();

    if (!config.apiToken || config.resolveFixedIssues === false)
      throw new Error("Sentry triage and write access are required");

    if (!run.route.githubRepository || run.route.environment === "*")
      throw new Error(
        "A diagnostics pause requires an exact repository and deployment environment",
      );

    const live = store.getRoute(run.route.id);

    if (!live.enabled || live.version !== run.route.version || !this.ownsIssue(run.id, issue.key))
      throw new Error(
        "The route or issue ownership changed; the diagnostics pause was not started",
      );

    const prior = store.diagnosticsHold(key);

    if (prior && (prior.state === "pending" || prior.state === "paused") && prior.runId !== run.id)
      throw new Error("A different run owns this issue's diagnostics pause");

    if (prior?.runId === run.id) {
      await this.reconcile();

      return store.diagnosticsHold(key);
    }

    store.saveDiagnosticsHold({
      runId: run.id,
      issue,
      route: run.route,
      apiOrigin: config.apiOrigin,
      release: finding.diagnosticsRelease,
      commit: proposal.commit,
      state: "pending",
      until: null,
      checkedAt: 0,
      reason: null,
    });
    await this.reconcile();

    return store.diagnosticsHold(key);
  }

  private ownsIssue(runId: string, issueKey: string) {
    const { store } = this.runner;
    const run = store.getRun(runId);

    return (
      store.issueOwner(issueKey)?.id === runId &&
      run.state !== "cancelled" &&
      (!run.batchId ||
        !["cancelled", "complete", "stopping", "failed"].includes(
          store.getBatch(run.batchId).state,
        ))
    );
  }

  async reconcile(): Promise<void> {
    if (this.disposed) return;

    if (this.running) return this.running;
    this.running = this.checkNext();

    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async checkNext() {
    const { store } = this.runner;
    const pending = store.activeDiagnosticsHolds(8);

    if (!pending.length) return;
    const config = await this.connection();

    for (const hold of pending) {
      if (this.disposed) return;
      let next: DiagnosticsHold;

      try {
        next = await this.advance(hold, config);
      } catch (error) {
        next = {
          ...hold,
          reason: error instanceof SentryFailure ? error.code : "diagnostics-check-unavailable",
        };
      }

      store.saveDiagnosticsHold({ ...next, checkedAt: Date.now() });
    }

    this.runner.changed();
  }

  private async advance(hold: DiagnosticsHold, config: Connection): Promise<DiagnosticsHold> {
    const { route, issue } = hold;
    const { store } = this.runner;

    const interrupt = (reason: string): DiagnosticsHold => ({
      ...hold,
      state: "interrupted",
      reason,
    });

    if (!config.apiToken || config.apiOrigin !== hold.apiOrigin)
      return { ...hold, reason: "Sentry access or the original region is unavailable" };
    const client = new SentryClient(hold.apiOrigin, config.apiToken, this.transport);
    const current = await client.diagnosticsIssueState(route, issue.id);

    if (
      hold.until
        ? current.status !== "ignored" || current.until !== hold.until
        : current.status !== "unresolved" || current.hasCondition
    )
      return interrupt("Issue disposition changed outside the diagnostics pause");

    const live = store.getRoute(route.id);

    const allowed =
      config.resolveFixedIssues !== false &&
      live.enabled &&
      live.version === route.version &&
      this.ownsIssue(hold.runId, issue.key);

    if (!allowed) {
      if (hold.until) await client.setDiagnosticsPause(route, issue.id, null, hold.until);

      return interrupt("The diagnostics pause's route or ownership changed");
    }

    const releaseState = await client.diagnosticReleaseState(route, hold.release, hold.commit);

    if (releaseState === "identity-unconfirmed")
      return { ...hold, reason: "The release record does not prove the exact project and commit" };

    if (releaseState === "shipped") {
      if (hold.until) await client.setDiagnosticsPause(route, issue.id, null, hold.until);

      return { ...hold, until: null, state: "resumed", reason: null };
    }

    if (hold.until && Date.parse(hold.until) - Date.now() > renewWithinMs)
      return { ...hold, reason: null };

    // Recheck local ownership after the provider read before creating or extending a pause.
    if (
      store.getRoute(route.id).version !== route.version ||
      !this.ownsIssue(hold.runId, issue.key)
    )
      return { ...hold, reason: "The diagnostics pause's route or ownership changed" };

    const until = await client.setDiagnosticsPause(route, issue.id, leaseMinutes, hold.until);

    return { ...hold, until, state: "paused", reason: null };
  }

  async dispose() {
    this.disposed = true;
    await this.running;
  }
}
