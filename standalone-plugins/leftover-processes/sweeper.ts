import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_GRACE_MS,
  hostContract,
  type ActionResult,
  type HistoryEntry,
  type HostSnapshot,
  type ListResult,
  type ObservedProcess,
  type ProcessIdentity,
  type ProcessStopResult,
  type ScannedHost,
  type StopOutcome,
  type StopReason,
  type SweepStatus,
  type ThreadFacts,
} from "./contract";
import { CHANGED_CHANNEL } from "./lib/names";
import { redact } from "./lib/redact";
import {
  depthOf,
  hasOpenWork,
  identityKey,
  indexByPid,
  isThreadBusy,
  stopClosure,
  threadStateOf,
  type CpuSample,
  type PolicySettings,
} from "./policy";
import { judgeWorkloads, projectList } from "./projection";
import type { Store } from "./store";

const SCAN_TIMEOUT_MS = 120_000;

const STOP_TIMEOUT_MARGIN_MS = 30_000;

const FAILURE_TEXT_LIMIT = 300;

const STOPPED_OUTCOMES: ReadonlySet<StopOutcome> = new Set(["terminated", "killed", "gone"]);

const threadNotFound = z.object({
  status: z.literal(404),
  code: z.literal("thread_not_found"),
});

type HostRef = { id: string; name: string };

type StopTarget = { process: ObservedProcess; title: string; reason: StopReason };

type StopReport = { results: ProcessStopResult[]; failure: string | null };

export type SweepRequest = { threadId?: string | undefined; now?: boolean | undefined };

export type ListRequest = {
  hostId?: string | undefined;
  threadId?: string | undefined;
  refresh?: boolean | undefined;
  includeRunningChats?: boolean | undefined;
};

function describeFailure<Failure>(error: Failure): string {
  const text = error instanceof Error ? error.message : String(error);

  return redact(text).slice(0, FAILURE_TEXT_LIMIT);
}

export function createSweeper(
  api: PluginApi,
  store: Store,
  readSettings: () => Promise<PolicySettings>,
  lifetime: AbortSignal,
) {
  const hostClient = api.hosts.experimental_client({ contract: hostContract });
  const installedAt = store.installedAt(Date.now());
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    pending += 1;

    const run = queue.then(task);

    queue = run.then(
      () => {
        pending -= 1;
      },
      () => {
        pending -= 1;
      },
    );

    return run;
  }

  function announceChange(): void {
    api.realtime.publish(CHANGED_CHANNEL, { at: Date.now() });
  }

  async function connectedHosts(): Promise<HostRef[]> {
    const hosts = await api.sdk.hosts.list({ signal: lifetime });

    return hosts.flatMap((host) =>
      host.status === "connected" ? [{ id: host.id, name: host.name }] : [],
    );
  }

  async function readThreadFacts(
    threadId: string,
    workloads: readonly ObservedProcess[],
    baseline: ReadonlyMap<string, CpuSample>,
    previousTitle: string | null,
    now: number,
  ): Promise<{ facts: ThreadFacts; failure: string | null }> {
    const busy = isThreadBusy(workloads, baseline, now);

    try {
      const thread = await api.sdk.threads.get({ threadId, signal: lifetime });
      const title = thread.title ?? thread.titleFallback ?? "Untitled chat";
      const state = threadStateOf(thread);
      const facts = { threadId, title, state, openWork: false, busy };

      if (state.kind === "running" || state.kind === "deleted") return { facts, failure: null };

      try {
        const work = await api.sdk.threads.experimental_work({ threadId, signal: lifetime });

        return { facts: { ...facts, openWork: hasOpenWork(work) }, failure: null };
      } catch (error) {
        lifetime.throwIfAborted();

        return {
          facts: { ...facts, openWork: true },
          failure: `Could not read open work for ${title}: ${describeFailure(error)}`,
        };
      }
    } catch (error) {
      lifetime.throwIfAborted();

      if (threadNotFound.safeParse(error).success)
        return {
          facts: {
            threadId,
            title: previousTitle ?? "Deleted chat",
            state: { kind: "deleted" },
            openWork: false,
            busy,
          },
          failure: null,
        };

      return {
        facts: {
          threadId,
          title: previousTitle ?? threadId,
          state: { kind: "idle", since: now },
          openWork: true,
          busy,
        },
        failure: `Could not read chat ${threadId}: ${describeFailure(error)}`,
      };
    }
  }

  async function collect(host: HostRef): Promise<HostSnapshot> {
    const failures: string[] = [];
    const previous = store.readSnapshot(host.id);

    const lastSuccessfulAt =
      previous?.lastSuccessfulAt ??
      (previous?.status === "ok" && previous.failures.length === 0 ? previous.scannedAt : null);

    const base = {
      hostId: host.id,
      hostName: host.name,
      scannedAt: Date.now(),
      lastSuccessfulAt,
      failures,
    };

    let scan;

    try {
      scan = await hostClient.call(
        "scan",
        {},
        { hostId: host.id, timeoutMs: SCAN_TIMEOUT_MS, signal: lifetime },
      );
    } catch (error) {
      lifetime.throwIfAborted();

      return { ...base, status: "failed", reason: describeFailure(error) };
    }

    if (!scan.supported) return { ...base, status: "unsupported", reason: scan.reason };

    if (scan.memoryFailure !== null) failures.push(`Memory: ${scan.memoryFailure}`);
    failures.push(...(scan.scanFailures ?? []));

    const now = Date.now();
    const baseline = store.readSamples(host.id);

    const previousTitles = new Map(
      previous?.status === "ok"
        ? previous.threads.map((thread) => [thread.threadId, thread.title])
        : [],
    );

    const workloadsByThread = new Map<string, ObservedProcess[]>();

    for (const process of scan.processes) {
      if (process.role !== "workload") continue;

      workloadsByThread.set(process.threadId, [
        ...(workloadsByThread.get(process.threadId) ?? []),
        process,
      ]);
    }

    const threads: ThreadFacts[] = [];

    for (const [threadId, workloads] of workloadsByThread) {
      const { facts, failure } = await readThreadFacts(
        threadId,
        workloads,
        baseline,
        previousTitles.get(threadId) ?? null,
        now,
      );

      threads.push(facts);

      if (failure !== null) failures.push(failure);
    }

    return {
      ...base,
      scannedAt: now,
      lastSuccessfulAt: failures.length === 0 ? now : lastSuccessfulAt,
      status: "ok",
      processes: scan.processes,
      threads,
    };
  }

  async function stopTargets(host: HostRef, targets: readonly StopTarget[]): Promise<StopReport> {
    if (targets.length === 0) return { results: [], failure: null };

    const byKey = new Map(targets.map((target) => [identityKey(target.process), target]));
    let results: ProcessStopResult[];
    let failure: string | null = null;

    try {
      const response = await hostClient.call(
        "stop",
        {
          identities: targets.map(({ process }) => ({
            pid: process.pid,
            startedAt: process.startedAt,
          })),
          graceMs: DEFAULT_GRACE_MS,
        },
        {
          hostId: host.id,
          timeoutMs: DEFAULT_GRACE_MS + STOP_TIMEOUT_MARGIN_MS + targets.length * 500,
          signal: lifetime,
        },
      );

      results = response.results;
    } catch (error) {
      lifetime.throwIfAborted();
      failure = `Stop failed: ${describeFailure(error)}`;

      results = targets.map(({ process }) => ({
        pid: process.pid,
        startedAt: process.startedAt,
        outcome: "failed",
        detail: failure,
      }));
    }

    const at = Date.now();

    const entries: HistoryEntry[] = results.flatMap((result) => {
      const target = byKey.get(identityKey(result));

      if (target === undefined) return [];

      return [
        {
          at,
          hostId: host.id,
          hostName: host.name,
          threadId: target.process.threadId,
          threadTitle: target.title,
          command: target.process.command,
          memoryBytes: target.process.memoryBytes,
          reason: target.reason,
          outcome: result.outcome,
          detail: result.detail,
        },
      ];
    });

    store.appendHistory(entries);

    for (const entry of entries)
      api.log.info(`${entry.outcome} ${entry.command} (${entry.reason}) on ${entry.hostName}`);

    return { results, failure };
  }

  function afterStops(snapshot: ScannedHost, { results, failure }: StopReport): ScannedHost {
    const stopped = new Set(
      results.flatMap((result) =>
        STOPPED_OUTCOMES.has(result.outcome) ? [identityKey(result)] : [],
      ),
    );

    return {
      ...snapshot,
      processes: snapshot.processes.filter((process) => !stopped.has(identityKey(process))),
      failures: failure === null ? snapshot.failures : [...snapshot.failures, failure],
    };
  }

  async function sweepHost(
    host: HostRef,
    threadId: string | null,
    settings: PolicySettings,
    ignoreTimers: boolean,
  ): Promise<{ failures: string[]; stopped: number }> {
    const snapshot = await collect(host);

    if (snapshot.status !== "ok") {
      store.saveSnapshot(snapshot);

      return {
        failures: snapshot.status === "failed" ? [`${host.name}: ${snapshot.reason}`] : [],
        stopped: 0,
      };
    }

    store.pruneKeeps(host.id, snapshot.processes);

    const byPid = indexByPid(snapshot.processes);

    const targets = judgeWorkloads(snapshot, store.readKeeps(host.id), {
      settings,
      installedAt,
      now: snapshot.scannedAt,
      ignoreTimers,
    })
      .flatMap(({ process, thread, disposition }): StopTarget[] =>
        disposition.kind === "stop" && (threadId === null || thread.threadId === threadId)
          ? [{ process, title: thread.title, reason: disposition.reason }]
          : [],
      )
      .sort((first, second) => depthOf(second.process, byPid) - depthOf(first.process, byPid));

    const report = await stopTargets(host, targets);
    const settled = afterStops(snapshot, report);

    store.replaceSamples(
      host.id,
      settled.processes.filter((process) => process.role === "workload"),
      settled.scannedAt,
    );

    store.saveSnapshot(settled);

    return {
      failures: settled.failures.map((text) => `${host.name}: ${text}`),
      stopped: report.results.filter((result) => STOPPED_OUTCOMES.has(result.outcome)).length,
    };
  }

  async function runSweep(threadId: string | null, ignoreTimers: boolean): Promise<SweepStatus> {
    const settings = await readSettings();
    const failures: string[] = [];
    let stopped = 0;

    try {
      const hosts = await connectedHosts();

      store.retainSnapshots(new Set(hosts.map((host) => host.id)));

      const outcomes = await Promise.all(
        hosts.map(async (host) => {
          try {
            return await sweepHost(host, threadId, settings, ignoreTimers);
          } catch (error) {
            lifetime.throwIfAborted();

            return { failures: [`${host.name}: ${describeFailure(error)}`], stopped: 0 };
          }
        }),
      );

      for (const outcome of outcomes) {
        failures.push(...outcome.failures);
        stopped += outcome.stopped;
      }
    } catch (error) {
      lifetime.throwIfAborted();
      failures.push(`Could not list machines: ${describeFailure(error)}`);
    }

    const status: SweepStatus = { at: Date.now(), stopped, failures };

    store.saveLastSweep(status);
    announceChange();

    for (const failure of failures) api.log.warn(`sweep: ${failure}`);

    return status;
  }

  async function refresh(hostId: string | null): Promise<void> {
    const hosts = await connectedHosts();
    const selected = hostId === null ? hosts : hosts.filter((host) => host.id === hostId);

    if (hostId !== null && selected.length === 0)
      throw new Error(`Machine ${hostId} is not connected.`);

    if (hostId === null) store.retainSnapshots(new Set(hosts.map((host) => host.id)));

    await Promise.all(
      selected.map(async (host) => {
        const snapshot = await collect(host);

        store.saveSnapshot(snapshot);

        if (snapshot.status === "ok") store.pruneKeeps(host.id, snapshot.processes);
      }),
    );
  }

  async function requireConnectedHost(hostId: string): Promise<HostRef> {
    const host = (await connectedHosts()).find((candidate) => candidate.id === hostId);

    if (host === undefined) throw new Error(`Machine ${hostId} is not connected.`);

    return host;
  }

  function findRequested(
    identities: readonly ProcessIdentity[],
    processes: readonly ObservedProcess[],
  ) {
    const byKey = new Map(processes.map((process) => [identityKey(process), process]));
    const allowed: ObservedProcess[] = [];
    const refused: ProcessStopResult[] = [];

    for (const identity of identities) {
      const process = byKey.get(identityKey(identity));

      if (process === undefined)
        refused.push({
          ...identity,
          outcome: "refused",
          detail: "This process changed or is no longer running.",
        });
      else if (process.role !== "workload")
        refused.push({
          ...identity,
          outcome: "refused",
          detail: "This process is part of the chat's agent.",
        });
      else allowed.push(process);
    }

    return { allowed, refused };
  }

  async function stopRequested(
    hostId: string,
    identities: readonly ProcessIdentity[],
  ): Promise<{ results: ProcessStopResult[] }> {
    const response = await exclusive(async () => {
      const host = await requireConnectedHost(hostId);
      const snapshot = await collect(host);

      if (snapshot.status !== "ok") {
        store.saveSnapshot(snapshot);

        throw new Error(`Could not scan ${host.name}: ${snapshot.reason}`);
      }

      const { allowed, refused } = findRequested(identities, snapshot.processes);
      const closure = stopClosure(allowed, snapshot.processes, store.readKeeps(host.id));
      const titles = new Map(snapshot.threads.map((thread) => [thread.threadId, thread.title]));

      const report = await stopTargets(
        host,
        closure.map((process) => ({
          process,
          title: titles.get(process.threadId) ?? process.threadId,
          reason: "manual",
        })),
      );

      store.saveSnapshot(afterStops(snapshot, report));

      return { results: [...refused, ...report.results] };
    });

    announceChange();

    return response;
  }

  function keep(hostId: string, identity: ProcessIdentity): ActionResult {
    const snapshot = store.readSnapshot(hostId);

    const process =
      snapshot?.status === "ok"
        ? snapshot.processes.find((candidate) => identityKey(candidate) === identityKey(identity))
        : undefined;

    if (process === undefined || process.role !== "workload")
      return { ok: false, detail: "That process is no longer running." };

    store.addKeep(hostId, identity, Date.now());
    announceChange();

    return { ok: true, detail: "Kept" };
  }

  function unkeep(hostId: string, identity: ProcessIdentity): ActionResult {
    store.removeKeep(hostId, identity);
    announceChange();

    return { ok: true, detail: "No longer kept" };
  }

  return {
    async list(request: ListRequest): Promise<ListResult> {
      if (request.refresh === true) {
        await exclusive(() => refresh(request.hostId ?? null));
        announceChange();
      }

      const settings = await readSettings();

      return projectList(
        store.readSnapshots(),
        (hostId) => store.readKeeps(hostId),
        store.readLastSweep(),
        { settings, installedAt, now: Date.now(), ignoreTimers: false },
        {
          hostId: request.hostId ?? null,
          threadId: request.threadId ?? null,
          includeRunningChats:
            request.includeRunningChats === true || request.threadId !== undefined,
        },
      );
    },
    stop: stopRequested,
    keep,
    unkeep,
    async sweep(request: SweepRequest): Promise<SweepStatus> {
      if (request.now === true && request.threadId === undefined)
        throw new Error("Sweeping now needs a chat. Pass a thread id.");

      return exclusive(() => runSweep(request.threadId ?? null, request.now === true));
    },
    async sweepOnSchedule(): Promise<void> {
      if (pending > 0) return;

      await exclusive(() => runSweep(null, false));
    },
    history(limit: number): HistoryEntry[] {
      return store.readHistory(limit);
    },
  };
}

export type Sweeper = ReturnType<typeof createSweeper>;
