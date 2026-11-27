import { cuaHostContract, cuaRpcContract, cuaResourceView } from "./cua-contract";
import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const processIdentity = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).max(64),
});

export type ProcessIdentity = z.infer<typeof processIdentity>;

export const processRole = z.enum(["agent", "helper", "workload"]);

export type ProcessRole = z.infer<typeof processRole>;

export const observedProcess = processIdentity.extend({
  ppid: z.number().int().nonnegative(),
  threadId: z.string().min(1),
  role: processRole,
  executable: z.string(),
  command: z.string(),
  memoryBytes: z.number().nonnegative(),
  memorySource: z.enum(["footprint", "rss"]),
  cpuSeconds: z.number().nonnegative(),
  keepRequested: z.boolean(),
});

export type ObservedProcess = z.infer<typeof observedProcess>;

export const threadState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running") }),
  z.object({ kind: z.literal("idle"), since: z.number() }),
  z.object({ kind: z.literal("archived"), since: z.number() }),
  z.object({ kind: z.literal("deleted") }),
]);

export type ThreadState = z.infer<typeof threadState>;

export const disposition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("in-use"), reason: z.literal("chat-running") }),
  z.object({ kind: z.literal("kept"), reason: z.enum(["user", "launch-env"]) }),
  z.object({
    kind: z.literal("waiting"),
    reason: z.enum(["open-work", "busy", "notice-period", "timer"]),
    stopAt: z.number().nullable(),
  }),
  z.object({ kind: z.literal("stop"), reason: z.enum(["archived", "deleted", "idle"]) }),
]);

export type Disposition = z.infer<typeof disposition>;

export const scanResult = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false), reason: z.string() }),
  z.object({
    supported: z.literal(true),
    processes: z.array(observedProcess),
    memoryFailure: z.string().nullable(),
    scanFailures: z.array(z.string()).optional(),
  }),
]);

export type ScanResult = z.infer<typeof scanResult>;

export const stopOutcome = z.enum(["terminated", "killed", "gone", "refused", "failed"]);

export type StopOutcome = z.infer<typeof stopOutcome>;

export const processStopResult = processIdentity.extend({
  outcome: stopOutcome,
  detail: z.string().nullable(),
});

export type ProcessStopResult = z.infer<typeof processStopResult>;

export const systemUsage = z.object({
  cpuPercent: z.number().min(0).max(100).nullable(),
  gpuPercent: z.number().min(0).max(100).nullable(),
  memoryUsedBytes: z.number().nonnegative().nullable(),
  memoryTotalBytes: z.number().nonnegative().nullable(),
});

export type SystemUsage = z.infer<typeof systemUsage>;

export const taskUsage = z.object({
  pid: z.number().int().positive(),
  name: z.string().min(1).max(255),
  cpuPercent: z.number().nonnegative().nullable(),
  memoryBytes: z.number().nonnegative(),
});

export const threadUsage = z.object({
  threadId: z.string(),
  tasks: z.array(taskUsage),
  cpuPercent: z.number().nonnegative().nullable(),
  memoryBytes: z.number().nonnegative(),
});

export const hostUsage = z.object({
  hostName: z.string(),
  system: systemUsage,
  coverage: z.enum(["complete", "partial", "failed", "unsupported"]),
  threads: z.array(threadUsage),
});

export type HostUsage = z.infer<typeof hostUsage>;

export const usageResult = z.object({
  hosts: z.array(hostUsage.extend({ hostId: z.string() })),
});

export type UsageResult = z.infer<typeof usageResult>;

export const DEFAULT_GRACE_MS = 10_000;

export const hostContract = {
  ...cuaHostContract,
  usage: { input: z.object({}), output: hostUsage },
  scan: {
    input: z.object({}),
    output: scanResult,
  },
  stop: {
    input: z.object({
      identities: z.array(processIdentity).max(500),
      graceMs: z.number().int().min(0).max(60_000).default(DEFAULT_GRACE_MS),
    }),
    output: z.object({ results: z.array(processStopResult) }),
  },
} as const;

export const threadFacts = z.object({
  threadId: z.string(),
  title: z.string(),
  state: threadState,
  openWork: z.boolean(),
  busy: z.boolean(),
});

export type ThreadFacts = z.infer<typeof threadFacts>;

const snapshotBase = z.object({
  hostId: z.string(),
  hostName: z.string(),
  scannedAt: z.number(),
  lastSuccessfulAt: z.number().nullable().optional(),
  failures: z.array(z.string()),
});

export const hostSnapshot = z.discriminatedUnion("status", [
  snapshotBase.extend({
    status: z.literal("ok"),
    processes: z.array(observedProcess),
    threads: z.array(threadFacts),
  }),
  snapshotBase.extend({ status: z.literal("unsupported"), reason: z.string() }),
  snapshotBase.extend({ status: z.literal("failed"), reason: z.string() }),
]);

export type HostSnapshot = z.infer<typeof hostSnapshot>;

export type ScannedHost = Extract<HostSnapshot, { status: "ok" }>;

export const stopReason = z.enum(["archived", "deleted", "idle", "manual"]);

export type StopReason = z.infer<typeof stopReason>;

export const historyEntry = z.object({
  at: z.number(),
  hostId: z.string(),
  hostName: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  command: z.string(),
  memoryBytes: z.number(),
  reason: stopReason,
  outcome: stopOutcome,
  detail: z.string().nullable(),
});

export type HistoryEntry = z.infer<typeof historyEntry>;

export const workloadRow = observedProcess.extend({
  hostId: z.string(),
  ageSeconds: z.number().nullable(),
  disposition,
  nextStep: z.string(),
  ownKeep: z.boolean(),
});

export type WorkloadRow = z.infer<typeof workloadRow>;

export const threadGroup = z.object({
  threadId: z.string(),
  title: z.string(),
  state: threadState,
  memoryBytes: z.number(),
  processes: z.array(workloadRow),
});

export type ThreadGroup = z.infer<typeof threadGroup>;

export const hostGroup = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.enum(["ok", "unsupported", "failed"]),
  detail: z.string().nullable(),
  scannedAt: z.number(),
  lastSuccessfulAt: z.number().nullable().optional(),
  memoryBytes: z.number(),
  processCount: z.number(),
  threads: z.array(threadGroup),
  failures: z.array(z.string()),
});

export type HostGroup = z.infer<typeof hostGroup>;

export const sweepStatus = z.object({
  at: z.number(),
  stopped: z.number(),
  failures: z.array(z.string()),
});

export type SweepStatus = z.infer<typeof sweepStatus>;

export const listResult = z.object({
  cuaResources: z.array(cuaResourceView),
  coverage: z.enum(["complete", "partial", "failed"]),
  hosts: z.array(hostGroup),
  memoryBytes: z.number(),
  processCount: z.number(),
  lastSweep: sweepStatus.nullable(),
  autoStop: z.boolean(),
  idleHours: z.number(),
});

export type ListResult = z.infer<typeof listResult>;

export const actionResult = z.object({ ok: z.boolean(), detail: z.string() });

export type ActionResult = z.infer<typeof actionResult>;

const hostIdInput = z.string().min(1);

const threadIdInput = z.string().min(1);

export const rpcContract = defineRpcContract({
  ...cuaRpcContract,
  usage: { input: z.object({}), output: usageResult },
  list: {
    input: z.object({
      hostId: hostIdInput.optional(),
      threadId: threadIdInput.optional(),
      refresh: z.boolean().optional(),
      includeRunningChats: z.boolean().optional(),
    }),
    output: listResult,
  },
  stop: {
    input: z.object({
      hostId: hostIdInput,
      identities: z.array(processIdentity).min(1).max(100),
    }),
    output: z.object({ results: z.array(processStopResult) }),
  },
  keep: {
    input: z.object({ hostId: hostIdInput, identity: processIdentity }),
    output: actionResult,
  },
  unkeep: {
    input: z.object({ hostId: hostIdInput, identity: processIdentity }),
    output: actionResult,
  },
  sweep: {
    input: z.object({ threadId: threadIdInput.optional(), now: z.boolean().optional() }),
    output: sweepStatus,
  },
  history: {
    input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    output: z.object({ entries: z.array(historyEntry) }),
  },
});
