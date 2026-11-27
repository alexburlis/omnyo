import { statSync } from "node:fs";
import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  dimensions,
  facetDimensions,
  emptyCounters,
  type ActiveCohort,
  type ChatInfo,
  type Cohort,
  type Commit,
  type Counters,
  type CounterUsage,
  type Cursor,
  type Dimension,
  type Filters,
  type Facet,
  type Group,
  type Health,
  type Point,
  type Report,
  type ReportInput,
  type SpeedGroup,
  type Summary,
  type TurnScope,
} from "../contract.ts";

type Database = ReturnType<PluginApi["storage"]["database"]>;

type SqlParameter = string | number;

type CounterName = keyof Counters;

const cohortDimensions = dimensions.filter((dimension) => dimension !== "chatRole");

function dimensionColumn(dimension: Dimension): string {
  return dimension === "chatRole" ? "COALESCE(h.chatRole,'unknown')" : `c.${dimension}`;
}

function roleLabel(dimension: "chatRole" | "agentRole", value: string): string {
  if (dimension === "chatRole")
    return value === "main"
      ? "Main chats"
      : value === "subagent"
        ? "Subagent chats"
        : "Unknown chat role";

  return value === "main"
    ? "Main executions"
    : value === "subagent"
      ? "Subagent executions"
      : "Unknown execution role";
}

const MINUTE = 60_000;

const DAY = 86_400_000;

const RECENT_DAYS = 30;

const MAX_POINTS = 600;

const fields: readonly CounterName[] = [
  "input",
  "output",
  "total",
  "cached",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "usageEvents",
  "turns",
  "failedTurns",
  "measuredTurns",
  "modelMs",
  "speedOutput",
  "agentMs",
  "unknownBaselines",
  "toolCalls",
  "nativeTokens",
  "nativeToolUses",
  "nativeMs",
];

const counterDefinition = fields.map((field) => `${field} INTEGER NOT NULL DEFAULT 0`).join(",");

const counterColumns = fields.join(",");

const counterPlaceholders = fields.map(() => "?").join(",");

const sumCounters = fields.map((field) => `COALESCE(SUM(b.${field}),0) AS ${field}`).join(",");

const updateCounters = fields.map((field) => `${field}=${field}+excluded.${field}`).join(",");

const usageFields: readonly (keyof CounterUsage)[] = [
  "input",
  "output",
  "total",
  "cached",
  "cacheRead",
  "cacheWrite",
  "reasoning",
];

const usageColumns = usageFields.join(",");

const usageDefinition = usageFields.map((field) => `${field} INTEGER NOT NULL`).join(",");

const usagePlaceholders = usageFields.map(() => "?").join(",");

const updateUsage = usageFields.map((field) => `${field}=excluded.${field}`).join(",");

interface NumberRow {
  value: number;
}

interface KeyRow {
  key: string;
}

interface IdRow {
  id: number;
}

interface CursorRow {
  seq: number;
  state: string;
  complete: number;
}

interface ScopeRow {
  key: string;
  nested: number;
  at: number;
  session: string;
}

interface BucketRow {
  at: number;
  output: number;
  agentMs: number;
  speedOutput: number;
  modelMs: number;
}

interface CoverageRow {
  at: number;
  observedMs: number;
  peak: number;
}

interface MedianRow {
  key: string;
  median: number;
  samples: number;
}

interface GroupRow extends Counters {
  key: string;
  label: string;
  deleted: number;
}

interface SpeedRow extends Counters {
  model: string;
  provider: string;
  effort: string;
  mode: string;
}

interface ActiveRow {
  key: string;
  count: number;
}

interface QueryScope {
  where: string;
  parameters: SqlParameter[];
}

interface Window {
  from: number;
  to: number;
  table: "minute_buckets" | "daily_buckets" | "totals";
  seriesTable: "minute_buckets" | "daily_buckets";
  resolution: number;
}

export type StorageHealth = Pick<
  Health,
  | "databasePath"
  | "databaseBytes"
  | "walBytes"
  | "cohorts"
  | "chats"
  | "minuteRows"
  | "dailyRows"
  | "observationRows"
  | "speedRows"
  | "backfillPending"
  | "retention"
  | "lastMaintenanceAt"
  | "roleReadFailures"
>;

function floor(at: number, width: number): number {
  return Math.floor(at / width) * width;
}

function countersOf(row: Counters): Counters {
  const counters = emptyCounters();

  for (const field of fields) counters[field] = row[field];

  return counters;
}

function modeLabel(mode: string): string {
  if (mode === "default" || mode === "normal") return "Normal";

  if (mode === "fast") return "Fast";

  if (mode === "ultrafast") return "Ultrafast";

  return mode || "Not recorded";
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

function scope(filters: Filters): QueryScope {
  const clauses = ["c.id>0"];
  const parameters: SqlParameter[] = [];

  for (const dimension of dimensions) {
    const value = filters[dimension];

    if (value === undefined) continue;
    clauses.push(`${dimensionColumn(dimension)}=?`);
    parameters.push(value);
  }

  return { where: clauses.join(" AND "), parameters };
}

function rangeWindow(range: ReportInput["range"], asOf: number, start: number): Window {
  if (range === "all")
    return {
      from: floor(Math.min(start, asOf), DAY),
      to: asOf,
      table: "totals",
      seriesTable: "daily_buckets",
      resolution: DAY,
    };

  if (range === "year")
    return {
      from: floor(asOf - 365 * DAY, DAY),
      to: asOf,
      table: "daily_buckets",
      seriesTable: "daily_buckets",
      resolution: DAY,
    };

  if (range === "week" || range === "month")
    return {
      from: floor(asOf - (range === "week" ? 7 : 30) * DAY, DAY),
      to: asOf,
      table: "daily_buckets",
      seriesTable: "minute_buckets",
      resolution: MINUTE,
    };

  const duration =
    range === "hour" ? 60 * MINUTE : range === "day" ? DAY : range === "week" ? 7 * DAY : 30 * DAY;

  return {
    from: floor(asOf - duration, MINUTE),
    to: asOf,
    table: "minute_buckets",
    seriesTable: "minute_buckets",
    resolution: MINUTE,
  };
}

export class StatsStore {
  private readonly db: Database;
  private readonly insertCohort;
  private readonly findCohort;
  private readonly addTotals;
  private readonly addMinute;
  private readonly addDay;
  private readonly insertObservation;
  private readonly insertSpeed;
  private readonly saveCursor;
  private readonly setMeta;
  private readonly getMeta;
  private readonly selectCursor;
  private readonly addCoverage;
  private readonly saveActive;
  private readonly removeActive;
  private readonly selectStream;
  private readonly selectScope;
  private readonly saveStream;
  private readonly saveScope;

  constructor(api: PluginApi) {
    this.db = api.storage.database();
    api.storage.migrate(this.db, [
      `CREATE TABLE cohorts(id INTEGER PRIMARY KEY,machine TEXT NOT NULL,project TEXT NOT NULL,chat TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,mode TEXT NOT NULL,account TEXT NOT NULL,UNIQUE(machine,project,chat,provider,model,effort,mode,account))`,
      `INSERT INTO cohorts VALUES(0,'__global','__global','__global','__global','__global','__global','__global','__global')`,
      `CREATE TABLE chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,machineName TEXT NOT NULL,projectName TEXT NOT NULL,deleted INTEGER NOT NULL,archived INTEGER NOT NULL) WITHOUT ROWID`,
      `CREATE TABLE cursors(threadId TEXT PRIMARY KEY,seq INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT '',complete INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`,
      `CREATE INDEX cursors_pending ON cursors(complete,threadId)`,
      `CREATE TABLE totals(cohortId INTEGER PRIMARY KEY,${counterDefinition})`,
      `CREATE TABLE minute_buckets(at INTEGER NOT NULL,cohortId INTEGER NOT NULL,${counterDefinition},observedMs INTEGER NOT NULL DEFAULT 0,peak INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(at,cohortId)) WITHOUT ROWID`,
      `CREATE TABLE daily_buckets(at INTEGER NOT NULL,cohortId INTEGER NOT NULL,${counterDefinition},observedMs INTEGER NOT NULL DEFAULT 0,peak INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(at,cohortId)) WITHOUT ROWID`,
      `CREATE INDEX minute_cohort_time ON minute_buckets(cohortId,at)`,
      `CREATE INDEX daily_cohort_time ON daily_buckets(cohortId,at)`,
      `CREATE TABLE observations(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,cohortId INTEGER NOT NULL,output INTEGER NOT NULL)`,
      `CREATE INDEX observations_time ON observations(at)`,
      `CREATE TABLE speed_samples(id TEXT PRIMARY KEY,at INTEGER NOT NULL,cohortId INTEGER NOT NULL,output INTEGER NOT NULL,modelMs INTEGER NOT NULL) WITHOUT ROWID`,
      `CREATE INDEX speed_samples_time ON speed_samples(at)`,
      `CREATE TABLE coverage(start INTEGER NOT NULL,end INTEGER NOT NULL,PRIMARY KEY(start,end)) WITHOUT ROWID`,
      `CREATE INDEX coverage_end ON coverage(end)`,
      `CREATE TABLE active(cohortId INTEGER PRIMARY KEY,count INTEGER NOT NULL)`,
      `CREATE TABLE meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL) WITHOUT ROWID`,
      `CREATE TABLE stream_baselines(threadId TEXT NOT NULL,key TEXT NOT NULL,${usageDefinition},PRIMARY KEY(threadId,key)) WITHOUT ROWID`,
      `CREATE TABLE turn_scopes(threadId TEXT NOT NULL,turnId TEXT NOT NULL,key TEXT NOT NULL,nested INTEGER NOT NULL,at INTEGER NOT NULL,session TEXT NOT NULL,PRIMARY KEY(threadId,turnId)) WITHOUT ROWID`,
      // Existing cohorts combined main and nested usage. Preserve IDs and every
      // aggregate unchanged; old execution attribution is explicitly unknown.
      `CREATE TABLE cohorts_roles(id INTEGER PRIMARY KEY,machine TEXT NOT NULL,project TEXT NOT NULL,chat TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,mode TEXT NOT NULL,account TEXT NOT NULL,agentRole TEXT NOT NULL,UNIQUE(machine,project,chat,provider,model,effort,mode,account,agentRole))`,
      `INSERT INTO cohorts_roles SELECT id,machine,project,chat,provider,model,effort,mode,account,'unknown' FROM cohorts`,
      `DROP TABLE cohorts`,
      `ALTER TABLE cohorts_roles RENAME TO cohorts`,
      `ALTER TABLE chats ADD COLUMN chatRole TEXT NOT NULL DEFAULT 'unknown'`,
      `ALTER TABLE chats ADD COLUMN roleChecked INTEGER NOT NULL DEFAULT 0`,
    ]);
    this.insertCohort = this.db.prepare<SqlParameter[]>(
      "INSERT OR IGNORE INTO cohorts(machine,project,chat,provider,model,effort,mode,account,agentRole) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    this.findCohort = this.db.prepare<SqlParameter[], IdRow>(
      "SELECT id FROM cohorts WHERE machine=? AND project=? AND chat=? AND provider=? AND model=? AND effort=? AND mode=? AND account=? AND agentRole=?",
    );
    this.addTotals = this.db.prepare<SqlParameter[]>(
      `INSERT INTO totals(cohortId,${counterColumns}) VALUES(?,${counterPlaceholders}) ON CONFLICT(cohortId) DO UPDATE SET ${updateCounters}`,
    );
    this.addMinute = this.bucketStatement("minute_buckets");
    this.addDay = this.bucketStatement("daily_buckets");
    this.insertObservation = this.db.prepare<SqlParameter[]>(
      "INSERT INTO observations(at,cohortId,output) VALUES(?,?,?)",
    );
    this.insertSpeed = this.db.prepare<SqlParameter[]>(
      "INSERT OR IGNORE INTO speed_samples(id,at,cohortId,output,modelMs) VALUES(?,?,?,?,?)",
    );
    this.saveCursor = this.db.prepare<SqlParameter[]>(
      "INSERT INTO cursors(threadId,seq,state) VALUES(?,?,?) ON CONFLICT(threadId) DO UPDATE SET seq=excluded.seq,state=excluded.state",
    );
    this.selectCursor = this.db.prepare<[string], CursorRow>(
      "SELECT seq,state,complete FROM cursors WHERE threadId=?",
    );
    this.setMeta = this.db.prepare<SqlParameter[]>(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    this.getMeta = this.db.prepare<[string], NumberRow>("SELECT value FROM meta WHERE key=?");
    this.addCoverage = this.db.prepare<SqlParameter[]>(
      "INSERT OR IGNORE INTO coverage(start,end) VALUES(?,?)",
    );
    this.saveActive = this.db.prepare<SqlParameter[]>(
      "INSERT INTO active(cohortId,count) VALUES(?,?)",
    );
    this.removeActive = this.db.prepare("DELETE FROM active");
    this.selectStream = this.db.prepare<[string, string], CounterUsage>(
      `SELECT ${usageColumns} FROM stream_baselines WHERE threadId=? AND key=?`,
    );
    this.selectScope = this.db.prepare<[string, string], ScopeRow>(
      "SELECT key,nested,at,session FROM turn_scopes WHERE threadId=? AND turnId=?",
    );
    this.saveStream = this.db.prepare<SqlParameter[]>(
      `INSERT INTO stream_baselines(threadId,key,${usageColumns}) VALUES(?,?,${usagePlaceholders}) ON CONFLICT(threadId,key) DO UPDATE SET ${updateUsage}`,
    );
    this.saveScope = this.db.prepare<SqlParameter[]>(
      "INSERT INTO turn_scopes(threadId,turnId,key,nested,at,session) VALUES(?,?,?,?,?,?) ON CONFLICT(threadId,turnId) DO UPDATE SET key=excluded.key,nested=excluded.nested,at=excluded.at,session=excluded.session",
    );
    this.removeActive.run();

    if (this.meta("initializedAt") === null) this.setMeta.run("initializedAt", Date.now());
  }

  private bucketStatement(table: "minute_buckets" | "daily_buckets") {
    return this.db.prepare<SqlParameter[]>(
      `INSERT INTO ${table}(at,cohortId,${counterColumns},observedMs,peak) VALUES(?,?,${counterPlaceholders},?,?) ON CONFLICT(at,cohortId) DO UPDATE SET ${updateCounters},observedMs=observedMs+excluded.observedMs,peak=MAX(peak,excluded.peak)`,
    );
  }

  private meta(key: string): number | null {
    return this.getMeta.get(key)?.value ?? null;
  }

  private cohortId(cohort: Cohort): number {
    const values = cohortDimensions.map((dimension) => cohort[dimension]);
    this.insertCohort.run(...values);
    const row = this.findCohort.get(...values);

    if (!row) throw new Error("Stats cohort was not persisted");

    return row.id;
  }

  private recordStart(at: number): void {
    const start = this.meta("collectionStart");

    if (start === null || at < start) this.setMeta.run("collectionStart", at);
  }

  private counterValues(counters: Counters): number[] {
    return fields.map((field) => {
      const value = counters[field];

      if (!Number.isFinite(value) || value < 0)
        throw new Error("Stats counters must be finite and nonnegative");

      return value;
    });
  }

  cursor(threadId: string): Cursor {
    const row = this.selectCursor.get(threadId);

    return row
      ? { seq: row.seq, state: row.state, complete: row.complete === 1 }
      : { seq: 0, state: "", complete: false };
  }

  stream(threadId: string, key: string): CounterUsage | null {
    return this.selectStream.get(threadId, key) ?? null;
  }

  turnScope(threadId: string, turnId: string): TurnScope | null {
    const row = this.selectScope.get(threadId, turnId);

    return row
      ? { key: row.key, nested: row.nested === 1, at: row.at, session: row.session }
      : null;
  }

  commit(batch: Commit): void {
    this.db.transaction(() => {
      if (batch.seq <= this.cursor(batch.threadId).seq) return;
      const now = Date.now();

      for (const part of batch.parts) {
        const id = this.cohortId(part.cohort);

        for (const observation of part.observations) {
          if (!Number.isFinite(observation.at))
            throw new Error("Stats observation timestamp is invalid");
          const values = this.counterValues(observation.counters);
          this.addTotals.run(0, ...values);
          this.addTotals.run(id, ...values);
          this.addDay.run(floor(observation.at, DAY), id, ...values, 0, 0);

          if (observation.at >= floor(now - RECENT_DAYS * DAY, MINUTE))
            this.addMinute.run(floor(observation.at, MINUTE), id, ...values, 0, 0);

          if (observation.at >= now - DAY && observation.counters.output > 0)
            this.insertObservation.run(observation.at, id, observation.counters.output);
          this.recordStart(observation.at);
        }

        for (const sample of part.samples) {
          if (
            !Number.isFinite(sample.at) ||
            !Number.isFinite(sample.output) ||
            !Number.isFinite(sample.modelMs) ||
            sample.output < 0 ||
            sample.modelMs <= 0
          )
            throw new Error("Stats speed sample is invalid");

          if (sample.at >= now - RECENT_DAYS * DAY)
            this.insertSpeed.run(sample.id, sample.at, id, sample.output, sample.modelMs);
        }
      }

      for (const stream of batch.ledger?.streams ?? []) {
        const values = usageFields.map((field) => {
          const value = stream.value[field];

          if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("Stats ledger counters must be nonnegative safe integers");

          return value;
        });

        this.saveStream.run(batch.threadId, stream.key, ...values);
      }

      for (const scope of batch.ledger?.scopes ?? []) {
        if (!Number.isFinite(scope.value.at))
          throw new Error("Stats ledger scope timestamp is invalid");
        this.saveScope.run(
          batch.threadId,
          scope.turnId,
          scope.value.key,
          scope.value.nested ? 1 : 0,
          scope.value.at,
          scope.value.session,
        );
      }

      this.saveCursor.run(batch.threadId, batch.seq, batch.state);
      this.setMeta.run("lastIngestAt", now);
    })();
  }

  markComplete(threadId: string): void {
    this.db
      .prepare<[string]>(
        "INSERT INTO cursors(threadId,complete) VALUES(?,1) ON CONFLICT(threadId) DO UPDATE SET complete=1",
      )
      .run(threadId);
  }

  touchChat(info: ChatInfo): void {
    this.db.transaction(() => {
      this.db
        .prepare<SqlParameter[]>(
          "INSERT INTO chats(id,title,machineName,projectName,deleted,archived,chatRole,roleChecked) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,machineName=excluded.machineName,projectName=excluded.projectName,deleted=MAX(deleted,excluded.deleted),archived=excluded.archived,chatRole=CASE WHEN excluded.chatRole='unknown' THEN chats.chatRole ELSE excluded.chatRole END,roleChecked=CASE WHEN excluded.roleChecked=0 THEN chats.roleChecked ELSE excluded.roleChecked END",
        )
        .run(
          info.id,
          info.title,
          info.machineName,
          info.projectName,
          info.deleted ? 1 : 0,
          info.archived ? 1 : 0,
          info.chatRole ?? "unknown",
          info.roleChecked ?? (info.chatRole && info.chatRole !== "unknown" ? 1 : 0),
        );
      this.db.prepare<[string]>("INSERT OR IGNORE INTO cursors(threadId) VALUES(?)").run(info.id);
    })();
  }

  chatRole(threadId: string): { chatRole: Cohort["chatRole"]; roleChecked: number } {
    return (
      this.db
        .prepare<[string], { chatRole: Cohort["chatRole"]; roleChecked: number }>(
          "SELECT chatRole,roleChecked FROM chats WHERE id=?",
        )
        .get(threadId) ?? { chatRole: "unknown", roleChecked: 0 }
    );
  }

  retryRoleFailures(): void {
    this.db.prepare("UPDATE chats SET roleChecked=0 WHERE roleChecked=2").run();
  }

  markDeleted(threadId: string): void {
    this.db.transaction(() => {
      this.db.prepare<[string]>("UPDATE chats SET deleted=1 WHERE id=?").run(threadId);
      this.markComplete(threadId);
    })();
  }

  pendingThreads(): string[] {
    return this.db
      .prepare<[], KeyRow>(
        "SELECT threadId AS key FROM cursors WHERE complete=0 ORDER BY threadId LIMIT 1000",
      )
      .all()
      .map((row) => row.key);
  }

  recordConcurrency(at: number, active: ActiveCohort[], coveredFrom: number): void {
    if (!Number.isFinite(at) || !Number.isFinite(coveredFrom) || coveredFrom > at)
      throw new Error("Stats concurrency interval is invalid");
    this.db.transaction(() => {
      this.removeActive.run();
      const cohorts = new Map<number, number>();
      let count = 0;

      for (const entry of active) {
        if (!Number.isInteger(entry.count) || entry.count < 0)
          throw new Error("Stats active count is invalid");

        if (entry.count === 0) continue;
        const id = this.cohortId(entry.cohort);
        cohorts.set(id, (cohorts.get(id) ?? 0) + entry.count);
        count += entry.count;
      }

      for (const [id, cohortCount] of cohorts) this.saveActive.run(id, cohortCount);
      const start = Math.max(coveredFrom, this.meta("lastConcurrencyAt") ?? coveredFrom);

      if (at <= start) return;
      this.recordStart(start);
      this.addCoverage.run(start, at);
      const total = emptyCounters();
      total.agentMs = count * (at - start);
      this.addTotals.run(0, ...this.counterValues(total));

      for (const [id, cohortCount] of cohorts) {
        total.agentMs = cohortCount * (at - start);
        this.addTotals.run(id, ...this.counterValues(total));
      }

      for (const resolution of [MINUTE, DAY]) {
        const statement = resolution === MINUTE ? this.addMinute : this.addDay;

        for (let cursor = start; cursor < at;) {
          const bucketAt = floor(cursor, resolution);
          const end = Math.min(at, bucketAt + resolution);
          const duration = end - cursor;
          const global = emptyCounters();
          global.agentMs = duration * count;
          statement.run(bucketAt, 0, ...this.counterValues(global), duration, count);

          for (const [id, cohortCount] of cohorts) {
            const counters = emptyCounters();
            counters.agentMs = duration * cohortCount;
            statement.run(bucketAt, id, ...this.counterValues(counters), 0, 0);
          }

          cursor = end;
        }
      }

      this.setMeta.run("lastConcurrencyAt", at);
    })();
  }

  summary(
    asOf: number,
    running: number,
    activeChats: number,
    nestedAgents: number,
    liveReady: boolean,
    roles?: { main: number; subagent: number; unknown: number },
  ): Summary {
    const output5m =
      this.db
        .prepare<[number, number], NumberRow>(
          "SELECT COALESCE(SUM(output),0) AS value FROM observations WHERE at>? AND at<=?",
        )
        .get(asOf - 5 * MINUTE, asOf)?.value ?? 0;

    const covered =
      this.db
        .prepare<[number, number, number, number], NumberRow>(
          "SELECT COALESCE(SUM(MIN(end,?)-MAX(start,?)),0) AS value FROM coverage WHERE end>? AND start<?",
        )
        .get(asOf, asOf - 5 * MINUTE, asOf - 5 * MINUTE, asOf)?.value ?? 0;

    const allTime =
      this.db
        .prepare<[], Counters>(`SELECT ${counterColumns} FROM totals WHERE cohortId=0`)
        .get() ?? emptyCounters();

    return {
      asOf,
      running,
      activeChats,
      nestedAgents,
      mainChats: roles?.main ?? 0,
      subagentChats: roles?.subagent ?? 0,
      unknownChats: roles?.unknown ?? activeChats,
      tps5m: output5m / 300,
      output5m,
      allTime: countersOf(allTime),
      collectionStart: this.meta("initializedAt") ?? asOf,
      historyStart: this.meta("collectionStart") ?? this.meta("initializedAt") ?? asOf,
      lastIngestAt: this.meta("lastIngestAt"),
      observedSeconds5m: Math.min(300, covered / 1000),
      liveReady,
    };
  }

  private median(
    expression: string,
    filters: Filters,
    from: number,
    to: number,
    visibleKeys: string[],
  ): Map<string, MedianRow> {
    if (visibleKeys.length === 0) return new Map();

    const query = scope(filters);

    const rows = this.db
      .prepare<SqlParameter[], MedianRow>(
        `WITH rates AS (SELECT ${expression} AS key,1000.0*s.output/s.modelMs AS rate,ROW_NUMBER() OVER(PARTITION BY ${expression} ORDER BY 1.0*s.output/s.modelMs) AS position,COUNT(*) OVER(PARTITION BY ${expression}) AS samples FROM speed_samples s JOIN cohorts c ON c.id=s.cohortId LEFT JOIN chats h ON h.id=c.chat WHERE ${query.where} AND ${expression} IN(${visibleKeys.map(() => "?").join(",")}) AND s.at>=? AND s.at<=? AND s.modelMs>0) SELECT key,AVG(rate) AS median,MAX(samples) AS samples FROM rates WHERE position IN((samples+1)/2,(samples+2)/2) GROUP BY key`,
      )
      .all(...query.parameters, ...visibleKeys, from, to);

    return new Map(rows.map((row) => [row.key, row]));
  }

  private groupLabel(dimension: Dimension): string {
    if (dimension === "chat") return "COALESCE(MAX(NULLIF(h.title,'')),c.chat)";

    if (dimension === "machine")
      return "CASE WHEN c.machine='' THEN '' ELSE COALESCE(MAX(NULLIF(NULLIF(h.machineName,''),c.machine)),c.machine) END";

    if (dimension === "project")
      return "CASE WHEN c.project='' THEN '' ELSE COALESCE(MAX(NULLIF(NULLIF(h.projectName,''),c.project)),c.project) END";

    return dimensionColumn(dimension);
  }

  private facets(input: ReportInput, window: Window, totalOutput: number): Facet[] {
    const query = scope(input.filters);
    const timeClause = window.table === "totals" ? "" : " AND b.at>=? AND b.at<=?";
    const parameters: SqlParameter[] = [...query.parameters];

    if (window.table !== "totals") parameters.push(window.from, window.to);

    const expanded = facetDimensions
      .map((dimension) => {
        const label =
          dimension === "machine"
            ? "CASE WHEN machine='' THEN '' ELSE NULLIF(NULLIF(machineName,''),machine) END"
            : dimension;

        return `SELECT '${dimension}' AS dimension,${dimension} AS key,${label} AS label,output,agentMs,active FROM facts`;
      })
      .join(" UNION ALL ");

    interface FacetRow {
      dimension: Facet["dimension"];
      key: string;
      label: string;
      output: number;
      agentMs: number;
      active: number;
      totalGroups: number;
    }

    // Collapse time buckets to cohorts once before the six projections. Return
    // five named groups plus an explicit remainder, independent of table paging.
    const rows = this.db
      .prepare<SqlParameter[], FacetRow>(
        `WITH measures AS MATERIALIZED (
        SELECT b.cohortId,SUM(b.output) AS output,SUM(b.agentMs) AS agentMs,0 AS active
        FROM ${window.table} b JOIN cohorts c ON c.id=b.cohortId LEFT JOIN chats h ON h.id=c.chat
        WHERE ${query.where}${timeClause} GROUP BY b.cohortId
        UNION ALL
        SELECT a.cohortId,0,0,a.count FROM active a JOIN cohorts c ON c.id=a.cohortId LEFT JOIN chats h ON h.id=c.chat
        WHERE ${query.where}
      ), facts AS MATERIALIZED (
        SELECT c.model,c.provider,c.machine,c.effort,c.agentRole,COALESCE(h.chatRole,'unknown') AS chatRole,h.machineName,m.output,m.agentMs,m.active
        FROM measures m JOIN cohorts c ON c.id=m.cohortId LEFT JOIN chats h ON h.id=c.chat
      ), expanded AS (${expanded}), grouped AS (
        SELECT dimension,key,COALESCE(MAX(label),key) AS label,SUM(output) AS output,SUM(agentMs) AS agentMs,SUM(active) AS active
        FROM expanded GROUP BY dimension,key
      ), ranked AS (
        SELECT *,ROW_NUMBER() OVER(PARTITION BY dimension ORDER BY output DESC,active DESC,key) AS position,COUNT(*) OVER(PARTITION BY dimension) AS totalGroups FROM grouped
      ) SELECT dimension,key,label,output,agentMs,active,totalGroups FROM ranked WHERE position<=5
        UNION ALL SELECT dimension,'__other','Other',SUM(output),SUM(agentMs),SUM(active),MAX(totalGroups) FROM ranked WHERE position>5 GROUP BY dimension
        ORDER BY dimension,output DESC,active DESC,key`,
      )
      .all(...parameters, ...query.parameters);

    return facetDimensions.map((dimension) => {
      const matches = rows.filter((row) => row.dimension === dimension);

      return {
        dimension,
        groups: matches.map((row) => ({
          key: row.key,
          label:
            row.key === "__other"
              ? "Other"
              : dimension === "chatRole" || dimension === "agentRole"
                ? roleLabel(dimension, row.key)
                : row.label || `Unknown ${dimension}`,
          output: row.output,
          agentMs: row.agentMs,
          active: row.active,
        })),
        totalOutput,
        totalGroups: matches[0]?.totalGroups ?? 0,
      };
    });
  }

  report(input: ReportInput, summary: Summary, health: Health): Report {
    const window = rangeWindow(
      input.range,
      summary.asOf,
      summary.historyStart ?? summary.collectionStart,
    );

    const query = scope(input.filters);
    const timeClause = window.table === "totals" ? "" : " AND b.at>=? AND b.at<=?";
    const parameters: SqlParameter[] = [...query.parameters];

    if (window.table !== "totals") parameters.push(window.from, window.to);
    const key = dimensionColumn(input.groupBy);
    const label = this.groupLabel(input.groupBy);
    const search = input.search ? " WHERE key LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\'" : "";
    const searchParameters: SqlParameter[] = [];

    if (input.search) {
      const escaped = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
      searchParameters.push(escaped, escaped);
    }

    const groupedSql = `SELECT ${key} AS key,${label} AS label,MAX(COALESCE(h.deleted,0)) AS deleted,${sumCounters} FROM ${window.table} b JOIN cohorts c ON c.id=b.cohortId LEFT JOIN chats h ON h.id=c.chat WHERE ${query.where}${timeClause} GROUP BY ${key}`;

    const groupCount = input.search
      ? (this.db
          .prepare<SqlParameter[], NumberRow>(
            `SELECT COUNT(*) AS value FROM(${groupedSql})${search}`,
          )
          .get(...parameters, ...searchParameters)?.value ?? 0)
      : (this.db
          .prepare<SqlParameter[], NumberRow>(
            `SELECT COUNT(DISTINCT ${key}) AS value FROM ${window.table} b JOIN cohorts c ON c.id=b.cohortId LEFT JOIN chats h ON h.id=c.chat WHERE ${query.where}${timeClause}`,
          )
          .get(...parameters)?.value ?? 0);

    const rows = this.db
      .prepare<SqlParameter[], GroupRow>(
        `SELECT * FROM(${groupedSql})${search} ORDER BY output DESC,total DESC,key LIMIT ? OFFSET ?`,
      )
      .all(...parameters, ...searchParameters, input.limit, input.offset);

    const medians = this.median(
      key,
      input.filters,
      Math.max(window.from, window.to - RECENT_DAYS * DAY),
      window.to,
      rows.map((row) => row.key),
    );

    const active = this.db
      .prepare<SqlParameter[], ActiveRow>(
        `SELECT ${key} AS key,SUM(a.count) AS count FROM active a JOIN cohorts c ON c.id=a.cohortId LEFT JOIN chats h ON h.id=c.chat WHERE ${query.where} GROUP BY ${key}`,
      )
      .all(...query.parameters);

    const activeCounts = new Map(active.map((row) => [row.key, row.count]));
    const elapsedSeconds = Math.max(0.001, (window.to - window.from) / 1000);

    const groups: Group[] = rows.map((row) => {
      let displayLabel = row.label || `Unknown ${input.groupBy}`;

      if (input.groupBy === "mode") displayLabel = modeLabel(row.key);

      if (input.groupBy === "chatRole" || input.groupBy === "agentRole")
        displayLabel = roleLabel(input.groupBy, row.key);

      if (input.groupBy === "account")
        displayLabel =
          health.accounts.find((account) => account.id === row.key)?.label ?? displayLabel;

      return {
        key: row.key,
        label: displayLabel,
        deleted: input.groupBy === "chat" && row.deleted === 1,
        counters: countersOf(row),
        tps: row.output / elapsedSeconds,
        modelTps: row.modelMs > 0 ? (row.speedOutput * 1000) / row.modelMs : null,
        medianTps: medians.get(row.key)?.median ?? null,
        active: activeCounts.get(row.key) ?? 0,
      };
    });

    const hasFilters = dimensions.some((dimension) => input.filters[dimension] !== undefined);

    const counters =
      window.table === "totals" && !hasFilters
        ? summary.allTime
        : (this.db
            .prepare<SqlParameter[], Counters>(
              `SELECT ${sumCounters} FROM ${window.table} b JOIN cohorts c ON c.id=b.cohortId LEFT JOIN chats h ON h.id=c.chat WHERE ${query.where}${timeClause}`,
            )
            .get(...parameters) ?? emptyCounters());

    const speedRows = this.db
      .prepare<SqlParameter[], SpeedRow>(
        `SELECT c.model,c.provider,c.effort,c.mode,${sumCounters} FROM ${window.table} b JOIN cohorts c ON c.id=b.cohortId LEFT JOIN chats h ON h.id=c.chat WHERE ${query.where}${timeClause} GROUP BY c.model,c.provider,c.effort,c.mode ORDER BY measuredTurns DESC,output DESC LIMIT 100`,
      )
      .all(...parameters);

    const speedMedians = this.median(
      "json_array(c.model,c.provider,c.effort,c.mode)",
      input.filters,
      Math.max(window.from, window.to - RECENT_DAYS * DAY),
      window.to,
      speedRows.map((row) => JSON.stringify([row.model, row.provider, row.effort, row.mode])),
    );

    const speeds: SpeedGroup[] = speedRows.map((row) => {
      const median = speedMedians.get(
        JSON.stringify([row.model, row.provider, row.effort, row.mode]),
      );

      return {
        model: row.model,
        provider: row.provider,
        effort: row.effort,
        mode: row.mode,
        counters: countersOf(row),
        modelTps: row.modelMs > 0 ? (row.speedOutput * 1000) / row.modelMs : null,
        medianTps: median?.median ?? null,
        medianSampleCount: median?.samples ?? 0,
      };
    });

    const seriesTable = window.seriesTable;

    let width = Math.max(
      window.resolution,
      Math.ceil((window.to - window.from + 1) / MAX_POINTS / window.resolution) * window.resolution,
    );

    while ((floor(window.to, width) - floor(window.from, width)) / width + 1 > MAX_POINTS)
      width += window.resolution;

    const bucketRows = this.db
      .prepare<SqlParameter[], BucketRow>(
        `SELECT CAST(b.at/? AS INTEGER)*? AS at,SUM(b.output) AS output,SUM(b.agentMs) AS agentMs,SUM(b.speedOutput) AS speedOutput,SUM(b.modelMs) AS modelMs FROM ${seriesTable} b JOIN cohorts c ON c.id=b.cohortId LEFT JOIN chats h ON h.id=c.chat WHERE ${query.where} AND b.at>=? AND b.at<=? GROUP BY 1 ORDER BY 1 LIMIT ${MAX_POINTS}`,
      )
      .all(width, width, ...query.parameters, window.from, window.to);

    const coverageRows = this.db
      .prepare<[number, number, number, number], CoverageRow>(
        `SELECT CAST(at/? AS INTEGER)*? AS at,SUM(observedMs) AS observedMs,MAX(peak) AS peak FROM ${seriesTable} WHERE cohortId=0 AND at>=? AND at<=? GROUP BY 1 ORDER BY 1 LIMIT ${MAX_POINTS}`,
      )
      .all(width, width, window.from, window.to);

    const values = new Map(bucketRows.map((row) => [row.at, row]));
    const coverage = new Map(coverageRows.map((row) => [row.at, row]));
    const filtered = dimensions.some((dimension) => input.filters[dimension] !== undefined);
    const series: Point[] = [];

    for (
      let at = floor(window.from, width);
      at <= window.to && series.length < MAX_POINTS;
      at += width
    ) {
      const value = values.get(at);
      const observed = coverage.get(at);

      const seconds = Math.max(
        0.001,
        (Math.min(at + width, window.to) - Math.max(at, window.from)) / 1000,
      );

      series.push({
        at,
        output: value?.output ?? 0,
        tps: (value?.output ?? 0) / seconds,
        modelTps: value && value.modelMs > 0 ? (value.speedOutput * 1000) / value.modelMs : null,
        agents:
          observed && observed.observedMs > 0 ? (value?.agentMs ?? 0) / observed.observedMs : null,
        peak: !filtered && observed && observed.observedMs > 0 ? observed.peak : null,
        observedMs: observed?.observedMs ?? 0,
      });
    }

    return {
      asOf: summary.asOf,
      from: window.from,
      to: window.to,
      resolutionSeconds: width / 1000,
      counters: countersOf(counters),
      groups,
      facets: this.facets(input, window, counters.output),
      groupCount,
      nextOffset: input.offset + groups.length < groupCount ? input.offset + groups.length : null,
      series,
      speeds,
      summary,
      health,
      medianWindowDays: RECENT_DAYS,
    };
  }

  health(): StorageHealth {
    const count = (table: string, where = ""): number =>
      this.db.prepare<[], NumberRow>(`SELECT COUNT(*) AS value FROM ${table}${where}`).get()
        ?.value ?? 0;

    return {
      databasePath: this.db.name,
      databaseBytes: this.db.name === ":memory:" ? 0 : fileBytes(this.db.name),
      walBytes: this.db.name === ":memory:" ? 0 : fileBytes(`${this.db.name}-wal`),
      cohorts: count("cohorts", " WHERE id>0"),
      chats: count("chats"),
      minuteRows: count("minute_buckets"),
      dailyRows: count("daily_buckets"),
      observationRows: count("observations"),
      speedRows: count("speed_samples"),
      backfillPending: count("cursors", " WHERE complete=0"),
      roleReadFailures: count("chats", " WHERE roleChecked=2"),
      retention:
        "Minute history 30 days; exact usage and coverage 24 hours; speed samples 30 days; totals and daily history retained.",
      lastMaintenanceAt: this.meta("lastMaintenanceAt"),
    };
  }

  maintenance(at: number): boolean {
    let remaining = false;

    const cleanup = this.db.transaction(() => {
      for (const [table, column, cutoff] of [
        ["observations", "at", at - DAY],
        ["coverage", "end", at - DAY],
        ["speed_samples", "at", at - RECENT_DAYS * DAY],
        ["minute_buckets", "at", floor(at - RECENT_DAYS * DAY, MINUTE)],
      ] as const) {
        const selectedColumns =
          table === "coverage" ? "start,end" : table === "minute_buckets" ? "at,cohortId" : "id";

        const identity = selectedColumns.includes(",") ? `(${selectedColumns})` : selectedColumns;

        const statement = this.db.prepare<[number]>(
          `DELETE FROM ${table} WHERE ${identity} IN(SELECT ${selectedColumns} FROM ${table} WHERE ${column}<? LIMIT 1000)`,
        );

        statement.run(cutoff);

        if (
          this.db
            .prepare<[number], NumberRow>(
              `SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${column}<?) AS value`,
            )
            .get(cutoff)?.value === 1
        )
          remaining = true;
      }

      this.setMeta.run("lastMaintenanceAt", at);
    });

    cleanup();
    this.db.pragma("wal_checkpoint(PASSIVE)");

    return remaining;
  }
}
