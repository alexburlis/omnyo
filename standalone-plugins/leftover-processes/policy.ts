import type { Disposition, ObservedProcess, ProcessIdentity, ThreadState } from "./contract";
import { formatDuration } from "./lib/format";

const HOUR_MS = 3_600_000;

export const ARCHIVE_GRACE_MS = 60_000;

export const NOTICE_PERIOD_MS = 24 * HOUR_MS;

export const BUSY_CPU_FRACTION = 0.05;

export type PolicySettings = { autoStop: boolean; idleHours: number };

export type DecideInput = {
  thread: ThreadState;
  kept: boolean;
  keepRequested: boolean;
  openWork: boolean;
  threadBusy: boolean;
  now: number;
  installedAt: number;
  settings: PolicySettings;
  ignoreTimers: boolean;
};

function timerEnd(
  thread: Exclude<ThreadState, { kind: "running" }>,
  settings: PolicySettings,
): number | null {
  switch (thread.kind) {
    case "idle":
      return thread.since + settings.idleHours * HOUR_MS;

    case "archived":
      return thread.since + ARCHIVE_GRACE_MS;

    case "deleted":
      return null;
  }
}

export function decide(input: DecideInput): Disposition {
  const { thread, now, settings, ignoreTimers } = input;

  if (input.kept) return { kind: "kept", reason: "user" };

  if (input.keepRequested) return { kind: "kept", reason: "launch-env" };

  if (thread.kind === "running") return { kind: "in-use", reason: "chat-running" };

  if (input.threadBusy) return { kind: "waiting", reason: "busy", stopAt: null };

  if (input.openWork) return { kind: "waiting", reason: "open-work", stopAt: null };

  if (!settings.autoStop) return { kind: "waiting", reason: "timer", stopAt: null };

  if (ignoreTimers) return { kind: "stop", reason: thread.kind };

  const stopAt = timerEnd(thread, settings);
  const noticeEnds = input.installedAt + NOTICE_PERIOD_MS;

  if (now < noticeEnds)
    return {
      kind: "waiting",
      reason: "notice-period",
      stopAt: Math.max(noticeEnds, stopAt ?? noticeEnds),
    };

  if (stopAt !== null && now < stopAt) return { kind: "waiting", reason: "timer", stopAt };

  return { kind: "stop", reason: thread.kind };
}

const RUNNING_STATUSES = new Set(["starting", "active", "stopping", "pending"]);

export function threadStateOf(thread: {
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
  updatedAt: number;
}): ThreadState {
  if (thread.deletedAt !== null) return { kind: "deleted" };

  if (RUNNING_STATUSES.has(thread.status)) return { kind: "running" };

  if (thread.archivedAt !== null) return { kind: "archived", since: thread.archivedAt };

  return { kind: "idle", since: thread.updatedAt };
}

export type WorkEvidence = {
  activity: readonly { id: string }[];
  waits: readonly { id: string }[];
  requiredInput: readonly { id: string }[];
  postponement: { reason: string } | null;
  primary: { reason: { code: string } };
};

export function hasOpenWork(work: WorkEvidence): boolean {
  return (
    work.activity.length > 0 ||
    work.waits.length > 0 ||
    work.requiredInput.length > 0 ||
    work.postponement !== null ||
    work.primary.reason.code === "unverified-work"
  );
}

export type CpuSample = { cpuSeconds: number; sampledAt: number };

export function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startedAt}`;
}

export function isThreadBusy(
  workloads: readonly ObservedProcess[],
  baseline: ReadonlyMap<string, CpuSample>,
  now: number,
): boolean {
  return workloads.some((workload) => {
    const previous = baseline.get(identityKey(workload));

    if (previous === undefined) return true;

    const wallSeconds = (now - previous.sampledAt) / 1000;

    if (wallSeconds <= 0) return true;

    return (workload.cpuSeconds - previous.cpuSeconds) / wallSeconds > BUSY_CPU_FRACTION;
  });
}

function ancestorsOf(
  process: ObservedProcess,
  byPid: ReadonlyMap<number, ObservedProcess>,
): ObservedProcess[] {
  const ancestors: ObservedProcess[] = [];
  const visited = new Set([process.pid]);
  let parent = byPid.get(process.ppid);

  while (parent !== undefined && !visited.has(parent.pid)) {
    ancestors.push(parent);
    visited.add(parent.pid);
    parent = byPid.get(parent.ppid);
  }

  return ancestors;
}

export function indexByPid(
  processes: readonly ObservedProcess[],
): ReadonlyMap<number, ObservedProcess> {
  return new Map(processes.map((process) => [process.pid, process]));
}

export function isKeptByUser(
  process: ObservedProcess,
  byPid: ReadonlyMap<number, ObservedProcess>,
  keeps: ReadonlySet<string>,
): boolean {
  return [process, ...ancestorsOf(process, byPid)].some((candidate) =>
    keeps.has(identityKey(candidate)),
  );
}

export function stopClosure(
  requested: readonly ObservedProcess[],
  processes: readonly ObservedProcess[],
  keeps: ReadonlySet<string>,
): ObservedProcess[] {
  const byPid = indexByPid(processes);
  const roots = new Map(requested.map((process) => [process.pid, process]));
  const selected = new Map(roots);

  for (const process of processes) {
    if (process.role !== "workload" || selected.has(process.pid)) continue;

    const root = ancestorsOf(process, byPid).find((ancestor) => roots.has(ancestor.pid));

    if (root === undefined || keeps.has(identityKey(process))) continue;

    if (process.keepRequested && !root.keepRequested) continue;

    selected.set(process.pid, process);
  }

  return [...selected.values()].sort(
    (first, second) => depthOf(second, byPid) - depthOf(first, byPid),
  );
}

export function depthOf(
  process: ObservedProcess,
  byPid: ReadonlyMap<number, ObservedProcess>,
): number {
  return ancestorsOf(process, byPid).length;
}

export function nextStep(disposition: Disposition, now: number): string {
  switch (disposition.kind) {
    case "in-use":
      return "Chat is running";

    case "kept":
      return "Kept";

    case "stop":
      return "Stopping now";

    case "waiting":
      return waitingStep(disposition, now);
  }
}

function waitingStep(disposition: Extract<Disposition, { kind: "waiting" }>, now: number): string {
  if (disposition.reason === "busy") return "Busy";

  if (disposition.reason === "open-work") return "Waiting on open work";

  if (disposition.stopAt === null) return "Auto-stop is off";

  const remaining = disposition.stopAt - now;

  return remaining > 0 ? `Stops in ${formatDuration(remaining)}` : "Stops at the next sweep";
}
