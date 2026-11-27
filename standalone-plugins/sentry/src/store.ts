import { randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  incidentSchema,
  batchSchema,
  batchSummarySchema,
  type ProjectBatch,
  projectPolicySchema,
  badgeSchema,
  type ProjectPolicy,
  routeSchema,
  runSchema,
  syncSchema,
  type Incident,
  type Route,
  type Run,
  type Sync,
  modelDefaultsSchema,
  type ModelDefaults,
  type ModelRole,
  type ModelSelection,
  type InboxQuery,
  inboxPageSize,
} from "../contract";
import { routeOverlaps, scanScope } from "./route-scope";
import { isActiveRun } from "./run-state";
import { WorkflowStore, workflowTableDefinitions } from "./workflow-store";
import { diagnosticsHoldSchema, type DiagnosticsHold } from "./diagnostics-release";

const payloadRow = z.object({ payload: z.string() });

function parseRun(payload: string): Run {
  const raw = z.looseObject({}).parse(JSON.parse(payload));
  const run = runSchema.parse(raw);

  // Legacy queued packages kept their handoff in the mutable status reason.
  // Preserve that surviving text (including retained handoff-file pointers)
  // before claiming the run clears its status.
  if (
    !Object.hasOwn(raw, "packageHandoff") &&
    run.packageHandoff === null &&
    run.batchId &&
    run.state === "queued" &&
    !run.threadId &&
    !run.spawnRequestedAt &&
    run.reason
  )
    return { ...run, packageHandoff: run.reason };

  return run;
}

const emptySync: Sync = {
  cursor: null,
  scanStartedAt: null,
  completedAt: null,
  retryAt: null,
  error: null,
};

const watchedRoute = "json_extract(routes.payload, '$.enabled')=1";

const countRow = z.object({ count: z.number() });

const inboxRow = payloadRow.extend({ members: z.string() });

const inboxTotal = z.object({ total: z.number().int().nonnegative() });

const memberships = z.array(z.string());

const inboxMembership = `FROM incidents
         JOIN route_incidents ON route_incidents.incident_id=incidents.id
         JOIN routes ON routes.id=route_incidents.route_id AND ${watchedRoute}`;

function inboxIncident(row: z.infer<typeof inboxRow>): Incident {
  const incident = incidentSchema.parse(JSON.parse(row.payload));

  return { ...incident, matchedRouteIds: memberships.parse(JSON.parse(row.members)) };
}

function scanBinding(route: Route) {
  const { projectId, hostId, repositoryPath, baseRef } = route;

  return JSON.stringify([scanScope(route), projectId, hostId, repositoryPath, baseRef]);
}

export class SentryStore {
  private db;
  readonly workflow: WorkflowStore;
  constructor(storage: PluginApi["storage"]) {
    this.db = storage.database();
    this.db.function("sentry_inbox_lower", { deterministic: true }, (value: string) =>
      value.toLowerCase(),
    );
    this.workflow = new WorkflowStore(this.db);
    storage.migrate(this.db, [
      "CREATE TABLE routes (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
      "CREATE TABLE incidents (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
      "CREATE TABLE runs (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, payload TEXT NOT NULL)",
      "CREATE INDEX runs_by_incident ON runs (incident_id)",
      "CREATE UNIQUE INDEX runs_by_thread ON runs (thread_id) WHERE thread_id IS NOT NULL",
      "CREATE TABLE sync_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
      "CREATE TABLE repo_claims (repository TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL)",
      "CREATE TABLE project_policies (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
      "CREATE TABLE automatic_starts (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, day TEXT NOT NULL)",
      "CREATE INDEX automatic_starts_by_day ON automatic_starts (project_id, day)",
      "CREATE TABLE route_incidents (route_id TEXT NOT NULL, incident_id TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (route_id, incident_id))",
      "CREATE TABLE project_batches (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
      "CREATE TABLE model_defaults (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
      ...workflowTableDefinitions,
      "CREATE TABLE diagnostics_holds (issue_key TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    ]);
  }

  diagnosticsHold(issueKey: string) {
    const row = this.db
      .prepare("SELECT payload FROM diagnostics_holds WHERE issue_key=?")
      .get(issueKey);

    return row ? diagnosticsHoldSchema.parse(JSON.parse(payloadRow.parse(row).payload)) : null;
  }

  saveDiagnosticsHold(hold: DiagnosticsHold) {
    const value = diagnosticsHoldSchema.parse(hold);
    this.db
      .prepare(
        "INSERT INTO diagnostics_holds VALUES (?,?) ON CONFLICT(issue_key) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.issue.key, JSON.stringify(value));
  }

  activeDiagnosticsHolds(limit = 10000) {
    return this.db
      .prepare(
        "SELECT payload FROM diagnostics_holds WHERE json_extract(payload, '$.state') IN ('pending','paused') ORDER BY json_extract(payload, '$.checkedAt'), issue_key LIMIT ?",
      )
      .all(limit)
      .map((row) => diagnosticsHoldSchema.parse(JSON.parse(payloadRow.parse(row).payload)));
  }

  modelDefaults(): ModelDefaults {
    const row = this.db.prepare("SELECT payload FROM model_defaults WHERE id='defaults'").get();

    return modelDefaultsSchema.parse(row ? JSON.parse(payloadRow.parse(row).payload) : {});
  }
  saveModelDefault(role: ModelRole, selection: ModelSelection) {
    const value = modelDefaultsSchema.parse({ ...this.modelDefaults(), [role]: selection });
    this.db
      .prepare(
        "INSERT INTO model_defaults VALUES ('defaults',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(JSON.stringify(value));

    return value;
  }

  listBatches(): ProjectBatch[] {
    return this.db
      .prepare("SELECT payload FROM project_batches ORDER BY rowid DESC")
      .all()
      .map((row) => batchSchema.parse(JSON.parse(payloadRow.parse(row).payload)));
  }
  batchSummaries() {
    return this.db
      .prepare(
        "SELECT json_remove(payload, '$.routes', '$.incidents', '$.blocked') AS payload, json_array_length(payload, '$.incidents') AS issueCount FROM project_batches ORDER BY rowid DESC LIMIT 50",
      )
      .all()
      .map((row) => {
        const value = z.object({ payload: z.string(), issueCount: z.number() }).parse(row);

        return batchSummarySchema.parse({
          ...JSON.parse(value.payload),
          issueCount: value.issueCount,
        });
      });
  }
  getBatch(id: string): ProjectBatch {
    const row = this.db.prepare("SELECT payload FROM project_batches WHERE id=?").get(id);

    if (!row) throw new Error("Project investigation not found");

    return batchSchema.parse(JSON.parse(payloadRow.parse(row).payload));
  }
  saveBatch(input: z.input<typeof batchSchema>) {
    const value = batchSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO project_batches VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.id, JSON.stringify(value));

    return value;
  }
  updateBatch(id: string, patch: Partial<ProjectBatch>) {
    return this.saveBatch({
      ...this.getBatch(id),
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });
  }
  bindBatchThread(id: string, threadId: string) {
    const batch = this.getBatch(id);

    if (batch.threadId && batch.threadId !== threadId)
      throw new Error("Project investigation already owns a thread");

    return this.updateBatch(id, { threadId });
  }
  ownedBatch(threadId: string) {
    return this.listBatches().find((batch) => batch.threadId === threadId) ?? null;
  }
  issueOwner(key: string): Run | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM runs WHERE incident_id=? OR EXISTS (SELECT 1 FROM json_each(json_extract(runs.payload, '$.relatedIncidents')) WHERE json_extract(value, '$.key')=?) ORDER BY rowid DESC LIMIT 1",
      )
      .get(key, key);

    return row ? parseRun(payloadRow.parse(row).payload) : null;
  }
  projectIssueCounts() {
    return this.db
      .prepare(
        `SELECT json_extract(routes.payload, '$.projectId') AS projectId,
                COUNT(DISTINCT route_incidents.incident_id) AS count
         FROM routes
         LEFT JOIN route_incidents ON route_incidents.route_id=routes.id AND ${watchedRoute}
         GROUP BY projectId ORDER BY MIN(routes.id)`,
      )
      .all()
      .map((row) => countRow.extend({ projectId: z.string() }).parse(row));
  }

  listRoutes(): Route[] {
    return this.db
      .prepare("SELECT payload FROM routes ORDER BY id")
      .all()
      .map((row) => routeSchema.parse(JSON.parse(payloadRow.parse(row).payload)));
  }
  getRoute(id: string): Route {
    const row = this.db.prepare("SELECT payload FROM routes WHERE id=?").get(id);

    if (!row) throw new Error("Route not found");

    return routeSchema.parse(JSON.parse(payloadRow.parse(row).payload));
  }
  saveRoute(input: Route): Route {
    const routes = this.listRoutes();
    const previous = routes.find((row) => row.id === input.id);
    const value = routeSchema.parse({ ...input, version: (previous?.version ?? 0) + 1 });

    if (value.enabled && value.watch) {
      const overlap = routes.find(
        (other) =>
          other.id !== value.id && other.enabled && other.watch && routeOverlaps(other, value),
      );

      if (overlap) throw new Error("Route overlaps an enabled route: " + overlap.id);
    }

    this.db.transaction(() => {
      if (previous && scanBinding(previous) !== scanBinding(value)) {
        this.db.prepare("DELETE FROM route_incidents WHERE route_id=?").run(value.id);
        this.db.prepare("DELETE FROM sync_state WHERE id=?").run(value.id);
      }

      this.db
        .prepare(
          "INSERT INTO routes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        )
        .run(value.id, JSON.stringify(value));
    })();

    return value;
  }
  policy(projectId: string): ProjectPolicy {
    const row = this.db.prepare("SELECT payload FROM project_policies WHERE id=?").get(projectId);

    return projectPolicySchema.parse(
      row ? JSON.parse(payloadRow.parse(row).payload) : { projectId },
    );
  }
  savePolicy(input: ProjectPolicy) {
    const value = projectPolicySchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO project_policies VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.projectId, JSON.stringify(value));

    return this.policyUsage(value.projectId);
  }
  policyUsage(projectId: string) {
    const policy = this.policy(projectId);
    const day = new Date().toISOString().slice(0, 10);

    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM automatic_starts WHERE project_id=? AND day=?")
      .get(projectId, day);

    const started = z.object({ count: z.number() }).parse(row).count;

    return { ...policy, day, started, remaining: Math.max(0, policy.dailyLimit - started) };
  }
  projectPolicies() {
    return [...new Set(this.listRoutes().map((route) => route.projectId))].map((id) =>
      this.policyUsage(id),
    );
  }
  routeLastSeen(routeId: string) {
    return this.db
      .prepare(
        "SELECT json_extract(incidents.payload, '$.lastSeen') AS seen FROM route_incidents JOIN incidents ON incidents.id=route_incidents.incident_id WHERE route_incidents.route_id=? ORDER BY seen DESC",
      )
      .all(routeId)
      .map((row) => z.object({ seen: z.string() }).parse(row).seen);
  }
  listIncidents(): Incident[] {
    return this.db
      .prepare(
        `SELECT incidents.payload, json_group_array(route_incidents.route_id) AS members
         ${inboxMembership}
         GROUP BY incidents.id
         ORDER BY json_extract(incidents.payload, '$.lastSeen') DESC, incidents.id LIMIT ?`,
      )
      .all(inboxPageSize)
      .map((row) => inboxRow.parse(row))
      .map(inboxIncident);
  }
  listInbox(query: InboxQuery) {
    const rows = this.db
      .prepare(
        `WITH matches AS (
         SELECT incidents.id, incidents.payload, json_group_array(route_incidents.route_id) AS members
         ${inboxMembership}
         WHERE (@projectId IS NULL OR json_extract(routes.payload, '$.projectId')=@projectId)
           AND (@routeId IS NULL OR routes.id=@routeId)
           AND (@severity='' OR json_extract(incidents.payload, '$.level')=@severity)
         GROUP BY incidents.id
         HAVING @search='' OR instr(sentry_inbox_lower(
           json_extract(incidents.payload, '$.shortId') || ' ' ||
           json_extract(incidents.payload, '$.exceptionType') || ' ' ||
           json_extract(incidents.payload, '$.environment') || ' ' ||
           coalesce(json_extract(incidents.payload, '$.release'), '') || ' ' ||
           group_concat(json_extract(routes.payload, '$.name'), ' ')
         ), @search)>0
       ), page AS (
         SELECT payload, members, row_number() OVER (
           ORDER BY CASE WHEN @sort='oldest' THEN json_extract(payload, '$.firstSeen') END,
                    CASE WHEN @sort='severity' THEN json_extract(payload, '$.level')='fatal' END DESC,
                    CASE WHEN @sort!='oldest' THEN json_extract(payload, '$.lastSeen') END DESC, id
         ) AS position
         FROM matches ORDER BY position LIMIT @limit OFFSET @offset
       )
       SELECT page.payload, page.members, totals.total
       FROM (SELECT count(*) AS total FROM matches) AS totals LEFT JOIN page ON true
       ORDER BY page.position`,
      )
      .all({ ...query, search: query.search.trim().toLowerCase(), limit: inboxPageSize });

    const total = inboxTotal.parse(rows[0]).total;

    return {
      incidents: query.offset < total ? z.array(inboxRow).parse(rows).map(inboxIncident) : [],
      total,
    };
  }
  badge() {
    const watched = this.listRoutes().filter((route) => route.enabled);
    const syncs = watched.map((route) => this.sync(route.id));

    const completed = syncs
      .map((state) => state.completedAt)
      .filter((value): value is string => Boolean(value))
      .sort();

    const freshness = !watched.length
      ? "unconfigured"
      : syncs.some(
            (state) =>
              state.error ||
              (state.completedAt && Date.now() - Date.parse(state.completedAt) > 900000),
          )
        ? "stale"
        : syncs.some((state) => state.cursor || !state.completedAt)
          ? "partial"
          : "live";

    const { count } = countRow.parse(
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT route_incidents.incident_id) AS count
           FROM route_incidents JOIN routes ON routes.id=route_incidents.route_id
           WHERE ${watchedRoute}`,
        )
        .get(),
    );

    return badgeSchema.parse({
      count,
      watchedRoutes: watched.length,
      freshness,
      lastSyncedAt: completed[0] ?? null,
    });
  }
  private previousIncident(key: string): Incident | null {
    const row = this.db.prepare("SELECT payload FROM incidents WHERE id=?").get(key);

    return row ? incidentSchema.parse(JSON.parse(payloadRow.parse(row).payload)) : null;
  }
  remember(incident: Incident) {
    this.db
      .prepare(
        "INSERT INTO incidents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(incident.key, JSON.stringify(incident));
  }
  sync(id: string): Sync {
    const row = this.db.prepare("SELECT payload FROM sync_state WHERE id=?").get(id);

    return row ? syncSchema.parse(JSON.parse(payloadRow.parse(row).payload)) : { ...emptySync };
  }
  saveSync(id: string, state: Sync) {
    this.db
      .prepare(
        "INSERT INTO sync_state VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(id, JSON.stringify(state));
  }
  private hasOpenBatch(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM project_batches
           WHERE json_extract(payload, '$.projectId')=?
             AND json_extract(payload, '$.state') NOT IN ('complete', 'failed', 'cancelled')
           LIMIT 1`,
        )
        .get(projectId),
    );
  }
  acceptPage(route: Route, incidents: Incident[], cursor: string | null, startedAt: string) {
    this.db.transaction(() => {
      if (this.getRoute(route.id).version !== route.version) return;
      const state = this.sync(route.id);

      const mayAutoSolve =
        route.enabled &&
        Boolean(state.completedAt) &&
        this.policy(route.projectId).autoSolve &&
        !this.hasOpenBatch(route.projectId);

      for (const incident of incidents) {
        const previous = this.previousIncident(incident.key);
        this.remember(incident);
        this.db
          .prepare(
            "INSERT INTO route_incidents VALUES (?,?,?) ON CONFLICT(route_id,incident_id) DO UPDATE SET seen_at=excluded.seen_at",
          )
          .run(route.id, incident.key, startedAt);

        const regression =
          previous !== null &&
          previous.substatus !== "regressed" &&
          incident.substatus === "regressed";

        if (mayAutoSolve && (!previous || regression)) this.enqueue(incident, route, regression);
      }

      if (!cursor)
        this.db
          .prepare("DELETE FROM route_incidents WHERE route_id=? AND seen_at<>?")
          .run(route.id, startedAt);
      this.saveSync(route.id, {
        cursor,
        scanStartedAt: cursor ? (state.scanStartedAt ?? startedAt) : null,
        completedAt: cursor ? state.completedAt : startedAt,
        retryAt: null,
        error: null,
      });
    })();
  }
  enqueue(incident: Incident, route: Route, retry = false, manual = false): Run {
    return this.db.transaction(() => {
      const existing = this.issueOwner(incident.key);

      if (existing) {
        const selectable =
          manual &&
          existing.state === "queued" &&
          !existing.threadId &&
          !existing.spawnRequestedAt &&
          !this.hasClaim(existing.id);

        if (selectable) {
          if (JSON.stringify(existing.route) === JSON.stringify(routeSchema.parse(route)))
            return this.updateRun(existing.id, { manual: true, reason: null });
          this.updateRun(existing.id, {
            state: "cancelled",
            reason: "Replaced by the owner's explicit selection of the current route",
          });
        } else if (!retry || isActiveRun(existing.state) || this.hasClaim(existing.id))
          return existing;
      }

      this.remember(incident);
      const now = new Date().toISOString();

      const run = runSchema.parse({
        id: "run_" + randomUUID().replaceAll("-", ""),
        incident,
        route,
        manual,
        state: "queued",
        threadId: null,
        environmentId: null,
        worktreePath: null,
        branch: null,
        baseSha: null,
        result: null,
        verification: null,
        publication: null,
        reason: null,
        createdAt: now,
        updatedAt: now,
        reportRequests: 0,
      });

      this.db
        .prepare("INSERT INTO runs VALUES (?,?,?,?,?)")
        .run(run.id, incident.key, run.state, null, JSON.stringify(run));

      return run;
    })();
  }
  listRuns(): Run[] {
    return this.db
      .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((row) => parseRun(payloadRow.parse(row).payload));
  }
  getRun(id: string): Run {
    const row = this.db.prepare("SELECT payload FROM runs WHERE id=?").get(id);

    if (!row) throw new Error("Run not found");

    return parseRun(payloadRow.parse(row).payload);
  }
  ownedThread(threadId: string): Run | null {
    const row = this.db.prepare("SELECT payload FROM runs WHERE thread_id=?").get(threadId);

    return row ? parseRun(payloadRow.parse(row).payload) : null;
  }
  updateRun(id: string, patch: Partial<Run>): Run {
    const previous = this.getRun(id);

    if (
      previous.packageHandoff !== null &&
      patch.packageHandoff !== undefined &&
      patch.packageHandoff !== previous.packageHandoff
    )
      throw new Error("Package handoff is immutable; retain the original repair scope");

    const value = runSchema.parse({
      ...previous,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });

    this.db
      .prepare("UPDATE runs SET state=?,thread_id=?,payload=? WHERE id=?")
      .run(value.state, value.threadId, JSON.stringify(value), id);

    return value;
  }
  bindThread(id: string, threadId: string, environmentId: string | null) {
    const run = this.getRun(id);

    if (run.threadId && run.threadId !== threadId)
      throw new Error("Run already owns another thread");

    return this.updateRun(id, { threadId, environmentId: environmentId ?? run.environmentId });
  }
  requestStart(id: string): Run {
    const run = this.getRun(id);

    if (
      !run.manual ||
      run.state !== "queued" ||
      run.threadId ||
      run.spawnRequestedAt ||
      this.hasClaim(id)
    )
      throw new Error(
        "Only an unsubmitted manual queued owner can request the next execution slot",
      );

    return this.updateRun(id, {
      manualStartRequestedAt: run.manualStartRequestedAt ?? new Date().toISOString(),
    });
  }
  claimNext(): Run | null {
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM repo_claims LIMIT 1").get()) return null;

      const queued = this.db
        .prepare(
          "SELECT payload FROM runs WHERE state='queued' AND NOT EXISTS (SELECT 1 FROM workflow_bindings WHERE workflow_bindings.run_id=runs.id) AND NOT EXISTS (SELECT 1 FROM workflow_policies WHERE workflow_policies.route_id=json_extract(runs.payload, '$.route.id') AND json_extract(workflow_policies.payload, '$.enabled')=1) ORDER BY CASE WHEN json_extract(payload, '$.manualStartRequestedAt') IS NULL THEN 1 ELSE 0 END, json_extract(payload, '$.manualStartRequestedAt'), rowid",
        )
        .all();

      for (const row of queued) {
        const run = parseRun(payloadRow.parse(row).payload);
        const live = this.getRoute(run.route.id);

        if (run.batchId && ["stopping", "cancelled"].includes(this.getBatch(run.batchId).state)) {
          this.updateRun(run.id, {
            state: "cancelled",
            reason: "Project investigation stopped before this package started",
          });
          continue;
        }

        if (live.version !== run.route.version) {
          this.updateRun(run.id, {
            reason: "Route changed; stop and retry this queued run to use current settings",
          });
          continue;
        }

        if (!run.manual) {
          const policy = this.policyUsage(run.route.projectId);

          const reason = !live.enabled
            ? "Issue watching is paused"
            : !policy.autoSolve
              ? "Auto solve is off; start this issue manually"
              : policy.remaining === 0
                ? "Daily automatic start limit reached; manual start is available"
                : null;

          if (reason) {
            this.updateRun(run.id, { reason });
            continue;
          }

          this.db
            .prepare("INSERT INTO automatic_starts VALUES (?,?,?)")
            .run(run.id, run.route.projectId, policy.day);
        }

        const repository = run.route.hostId + ":" + run.route.repositoryPath;
        this.db.prepare("INSERT INTO repo_claims VALUES (?,?)").run(repository, run.id);

        return this.updateRun(run.id, { state: "preparing", reason: null });
      }

      return null;
    })();
  }
  claimedRuns(): Run[] {
    return this.db
      .prepare(
        "SELECT runs.payload FROM runs JOIN repo_claims ON repo_claims.run_id=runs.id ORDER BY runs.rowid",
      )
      .all()
      .map((row) => parseRun(payloadRow.parse(row).payload));
  }

  reclaim(id: string): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);

      if (this.hasClaim(id)) return run;
      const holder = this.claimedRuns()[0];

      if (holder)
        throw new Error(
          "Another investigation (" +
            holder.incident.shortId +
            ") is using the execution slot. Retry after it finishes.",
        );
      this.db
        .prepare("INSERT INTO repo_claims VALUES (?,?)")
        .run(run.route.hostId + ":" + run.route.repositoryPath, run.id);

      return this.updateRun(id, {
        state: "preparing",
        reason: null,
        reportRequests: 0,
        lastTurnSeq: null,
        interruptedAt: null,
      });
    })();
  }

  replacementOwner(run: Run) {
    for (const issue of [run.incident, ...run.relatedIncidents]) {
      const owner = this.issueOwner(issue.key);

      if (owner && owner.id !== run.id) return { owner, issue };
    }

    return null;
  }

  environmentRun(key: string): Run | null {
    const row = this.db
      .prepare("SELECT payload FROM runs WHERE json_extract(payload, '$.environmentKey')=?")
      .get(key);

    return row ? parseRun(payloadRow.parse(row).payload) : null;
  }
  hasClaim(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM repo_claims WHERE run_id=?").get(id));
  }
  release(id: string) {
    this.db.transaction(() => {
      if (!this.getRun(id).spawnRequestedAt)
        this.db.prepare("DELETE FROM automatic_starts WHERE run_id=?").run(id);
      this.db.prepare("DELETE FROM repo_claims WHERE run_id=?").run(id);
    })();
  }
}
