import { inspectionStatus } from "./lib/inspection";
import type {
  Disposition,
  HostGroup,
  HostSnapshot,
  ListResult,
  ObservedProcess,
  ScannedHost,
  SweepStatus,
  ThreadFacts,
  ThreadGroup,
  WorkloadRow,
} from "./contract";
import {
  decide,
  identityKey,
  indexByPid,
  isKeptByUser,
  nextStep,
  type PolicySettings,
} from "./policy";

export type PolicyClock = {
  settings: PolicySettings;
  installedAt: number;
  now: number;
  ignoreTimers: boolean;
};

export type JudgedWorkload = {
  process: ObservedProcess;
  thread: ThreadFacts;
  disposition: Disposition;
};

export type ListFilter = {
  hostId: string | null;
  threadId: string | null;
  includeRunningChats: boolean;
};

export function judgeWorkloads(
  snapshot: ScannedHost,
  keeps: ReadonlySet<string>,
  clock: PolicyClock,
): JudgedWorkload[] {
  const byPid = indexByPid(snapshot.processes);
  const threads = new Map(snapshot.threads.map((thread) => [thread.threadId, thread]));

  return snapshot.processes.flatMap((process) => {
    const thread = threads.get(process.threadId);

    if (process.role !== "workload" || thread === undefined) return [];

    const disposition = decide({
      thread: thread.state,
      kept: isKeptByUser(process, byPid, keeps),
      keepRequested: process.keepRequested,
      openWork: thread.openWork,
      threadBusy: thread.busy,
      now: clock.now,
      installedAt: clock.installedAt,
      settings: clock.settings,
      ignoreTimers: clock.ignoreTimers,
    });

    return [{ process, thread, disposition }];
  });
}

function ageSeconds(startedAt: string, now: number): number | null {
  const started = Date.parse(startedAt);

  return Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000));
}

function sumMemory(rows: readonly { memoryBytes: number }[]): number {
  return rows.reduce((total, row) => total + row.memoryBytes, 0);
}

function projectRows(
  snapshot: ScannedHost,
  keeps: ReadonlySet<string>,
  clock: PolicyClock,
  filter: ListFilter,
): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();

  for (const judged of judgeWorkloads(snapshot, keeps, clock)) {
    if (filter.threadId !== null && judged.thread.threadId !== filter.threadId) continue;

    if (!filter.includeRunningChats && judged.disposition.kind === "in-use") continue;

    const row: WorkloadRow = {
      ...judged.process,
      hostId: snapshot.hostId,
      ageSeconds: ageSeconds(judged.process.startedAt, clock.now),
      disposition: judged.disposition,
      nextStep: nextStep(judged.disposition, clock.now),
      ownKeep: keeps.has(identityKey(judged.process)),
    };

    const group = groups.get(judged.thread.threadId) ?? {
      threadId: judged.thread.threadId,
      title: judged.thread.title,
      state: judged.thread.state,
      memoryBytes: 0,
      processes: [],
    };

    group.processes.push(row);
    group.memoryBytes += row.memoryBytes;
    groups.set(judged.thread.threadId, group);
  }

  for (const group of groups.values())
    group.processes.sort((first, second) => second.memoryBytes - first.memoryBytes);

  return [...groups.values()].sort((first, second) => second.memoryBytes - first.memoryBytes);
}

function projectHost(
  snapshot: HostSnapshot,
  keeps: ReadonlySet<string>,
  clock: PolicyClock,
  filter: ListFilter,
): HostGroup {
  const base = {
    hostId: snapshot.hostId,
    name: snapshot.hostName,
    scannedAt: snapshot.scannedAt,
    lastSuccessfulAt: snapshot.lastSuccessfulAt ?? null,
    failures: snapshot.failures,
  };

  if (snapshot.status !== "ok")
    return {
      ...base,
      status: snapshot.status,
      detail: snapshot.reason,
      memoryBytes: 0,
      processCount: 0,
      threads: [],
    };

  const threads = projectRows(snapshot, keeps, clock, filter);

  return {
    ...base,
    status: "ok",
    detail: null,
    memoryBytes: sumMemory(threads),
    processCount: threads.reduce((total, thread) => total + thread.processes.length, 0),
    threads,
  };
}

export function projectList(
  snapshots: readonly HostSnapshot[],
  keepsOf: (hostId: string) => ReadonlySet<string>,
  lastSweep: SweepStatus | null,
  clock: PolicyClock,
  filter: ListFilter,
): ListResult {
  const hosts = snapshots
    .flatMap((snapshot) => {
      if (filter.hostId !== null && snapshot.hostId !== filter.hostId) return [];

      const host = projectHost(snapshot, keepsOf(snapshot.hostId), clock, filter);

      return filter.threadId !== null && host.status === "ok" && host.threads.length === 0
        ? []
        : [host];
    })
    .sort((first, second) => first.name.localeCompare(second.name));

  return {
    hosts,
    coverage: inspectionStatus(hosts),
    cuaResources: [],
    memoryBytes: sumMemory(hosts),
    processCount: hosts.reduce((total, host) => total + host.processCount, 0),
    lastSweep,
    autoStop: clock.settings.autoStop,
    idleHours: clock.settings.idleHours,
  };
}
