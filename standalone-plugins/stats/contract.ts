import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const dimensions = [
  "machine",
  "project",
  "chat",
  "provider",
  "model",
  "effort",
  "mode",
  "account",
  "chatRole",
  "agentRole",
] as const;

export const dimensionSchema = z.enum(dimensions);

export type Dimension = z.infer<typeof dimensionSchema>;

export const filtersSchema = z
  .object({
    machine: z.string().optional(),
    project: z.string().optional(),
    chat: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    mode: z.string().optional(),
    account: z.string().optional(),
    chatRole: z.enum(["main", "subagent", "unknown"]).optional(),
    agentRole: z.enum(["main", "subagent", "unknown"]).optional(),
  })
  .strict();

export type Filters = z.infer<typeof filtersSchema>;

export const reportInputSchema = z
  .object({
    range: z.enum(["hour", "day", "week", "month", "year", "all"]).default("day"),
    groupBy: dimensionSchema.default("model"),
    filters: filtersSchema.default({}),
    offset: z.number().int().min(0).max(10000000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
    search: z.string().max(200).default(""),
  })
  .strict();

export type ReportInput = z.infer<typeof reportInputSchema>;

export const countersSchema = z.object({
  input: z.number(),
  output: z.number(),
  total: z.number(),
  cached: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  usageEvents: z.number(),
  turns: z.number(),
  failedTurns: z.number(),
  measuredTurns: z.number(),
  modelMs: z.number(),
  speedOutput: z.number(),
  agentMs: z.number(),
  unknownBaselines: z.number(),
  toolCalls: z.number(),
  nativeTokens: z.number(),
  nativeToolUses: z.number(),
  nativeMs: z.number(),
});

export type Counters = z.infer<typeof countersSchema>;

export function emptyCounters(): Counters {
  return {
    input: 0,
    output: 0,
    total: 0,
    cached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    usageEvents: 0,
    turns: 0,
    failedTurns: 0,
    measuredTurns: 0,
    modelMs: 0,
    speedOutput: 0,
    agentMs: 0,
    unknownBaselines: 0,
    toolCalls: 0,
    nativeTokens: 0,
    nativeToolUses: 0,
    nativeMs: 0,
  };
}

export const cohortSchema = z.object({
  machine: z.string(),
  project: z.string(),
  chat: z.string(),
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  mode: z.string(),
  account: z.string(),
  chatRole: z.enum(["main", "subagent", "unknown"]).default("unknown"),
  agentRole: z.enum(["main", "subagent", "unknown"]).default("unknown"),
});

export type Cohort = z.infer<typeof cohortSchema>;

export interface ChatInfo {
  id: string;
  title: string;
  machineName: string;
  projectName: string;
  deleted: boolean;
  archived: boolean;
  chatRole?: Cohort["chatRole"];
  roleChecked?: 0 | 1 | 2;
}

export interface Observation {
  at: number;
  counters: Counters;
}

export interface SpeedSample {
  id: string;
  at: number;
  output: number;
  modelMs: number;
}

export interface CommitPart {
  cohort: Cohort;
  observations: Observation[];
  samples: SpeedSample[];
}

export interface Commit {
  threadId: string;
  seq: number;
  state: string;
  parts: CommitPart[];
  ledger?: {
    scopes: { turnId: string; value: TurnScope }[];
    streams: { key: string; value: CounterUsage }[];
  };
}

export interface CounterUsage {
  input: number;
  output: number;
  total: number;
  cached: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface TurnScope {
  key: string;
  nested: boolean;
  at: number;
  session: string;
}

export interface FoldLedger {
  scope(turnId: string): TurnScope | null;
  saveScope(turnId: string, value: TurnScope): void;
  stream(key: string): CounterUsage | null;
  saveStream(key: string, value: CounterUsage): void;
}

export interface ActiveCohort {
  cohort: Cohort;
  count: number;
}

export interface Cursor {
  seq: number;
  state: string;
  complete: boolean;
}

const groupSchema = z.object({
  key: z.string(),
  label: z.string(),
  deleted: z.boolean(),
  counters: countersSchema,
  tps: z.number(),
  modelTps: z.number().nullable(),
  medianTps: z.number().nullable(),
  active: z.number(),
});

export type Group = z.infer<typeof groupSchema>;

export const facetDimensions = [
  "chatRole",
  "agentRole",
  "model",
  "provider",
  "machine",
  "effort",
] as const;

const facetSchema = z.object({
  dimension: z.enum(facetDimensions),
  groups: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      output: z.number(),
      agentMs: z.number(),
      active: z.number(),
    }),
  ),
  totalOutput: z.number(),
  totalGroups: z.number(),
});

export type Facet = z.infer<typeof facetSchema>;

const pointSchema = z.object({
  at: z.number(),
  output: z.number(),
  tps: z.number(),
  modelTps: z.number().nullable(),
  agents: z.number().nullable(),
  peak: z.number().nullable(),
  observedMs: z.number(),
});

export type Point = z.infer<typeof pointSchema>;

const speedSchema = z.object({
  model: z.string(),
  provider: z.string(),
  effort: z.string(),
  mode: z.string(),
  counters: countersSchema,
  modelTps: z.number().nullable(),
  medianTps: z.number().nullable(),
  medianSampleCount: z.number().int().nonnegative(),
});

export type SpeedGroup = z.infer<typeof speedSchema>;

export const summarySchema = z.object({
  asOf: z.number(),
  running: z.number(),
  activeChats: z.number(),
  nestedAgents: z.number(),
  mainChats: z.number().default(0),
  subagentChats: z.number().default(0),
  unknownChats: z.number().default(0),
  tps5m: z.number(),
  output5m: z.number(),
  allTime: countersSchema,
  collectionStart: z.number(),
  historyStart: z.number().optional(),
  lastIngestAt: z.number().nullable(),
  observedSeconds5m: z.number(),
  liveReady: z.boolean(),
});

export type Summary = z.infer<typeof summarySchema>;

export const healthSchema = z.object({
  databasePath: z.string(),
  databaseBytes: z.number(),
  walBytes: z.number(),
  cohorts: z.number(),
  chats: z.number(),
  minuteRows: z.number(),
  dailyRows: z.number(),
  observationRows: z.number(),
  speedRows: z.number(),
  backfillPending: z.number(),
  queueDepth: z.number(),
  indexing: z.boolean(),
  error: z.string().nullable(),
  accountState: z.string(),
  accounts: z.array(z.object({ id: z.string(), label: z.string(), provider: z.string() })),
  retention: z.string(),
  lastMaintenanceAt: z.number().nullable(),
  sourcePages: z.number(),
  sourceEvents: z.number(),
  roleReadFailures: z.number().default(0),
  lastPageMs: z.number(),
});

export type Health = z.infer<typeof healthSchema>;

export const reportSchema = z.object({
  asOf: z.number(),
  from: z.number(),
  to: z.number(),
  resolutionSeconds: z.number(),
  counters: countersSchema,
  groups: z.array(groupSchema),
  facets: z.array(facetSchema),
  groupCount: z.number(),
  nextOffset: z.number().nullable(),
  series: z.array(pointSchema),
  speeds: z.array(speedSchema),
  summary: summarySchema,
  health: healthSchema,
  medianWindowDays: z.number(),
});

export type Report = z.infer<typeof reportSchema>;

export const CHANGED = "stats-changed";

export const rpcContract = defineRpcContract({
  summary: { input: z.null(), output: summarySchema },
  report: { input: reportInputSchema, output: reportSchema },
  health: { input: z.null(), output: healthSchema },
  refresh: { input: z.null(), output: z.object({ accepted: z.boolean() }) },
});
