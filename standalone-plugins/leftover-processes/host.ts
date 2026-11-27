import { summarizeUsage } from "./usage";
import { cpus, hostname } from "node:os";
import { readGpuPercent, systemCpuPercent, systemMemory } from "./system-usage";
import { performance } from "node:perf_hooks";
import { inspectCuaRuntime, stopCuaRuntime, reconcileCuaRuntime } from "./cua-runtime";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@omnyo/plugin-sdk";
import {
  DEFAULT_GRACE_MS,
  hostContract,
  type ProcessIdentity,
  type ProcessStopResult,
  type ScanResult,
  type HostUsage,
} from "./contract";
import {
  classifyProcesses,
  daemonDataDir,
  joinProcessRows,
  parseCommandRow,
  parseExecutableRow,
  parseLineageRow,
  parseUsageRow,
  parseTagRow,
  parseTagFailureRow,
  parseTopRow,
  READ_TAGS_PERL,
  withMemory,
  type CommandRow,
  type ExecutableRow,
  type LineageRow,
  type UsageRow,
  type ProcessTags,
} from "./process-table";

const PS = "/bin/ps";

const TOP = "/usr/bin/top";

const PERL = "/usr/bin/perl";

const COMMAND_DEADLINE_MS = 20_000;

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

const TOP_BATCH_SIZE = 64;

const POLL_INTERVAL_MS = 100;

const KILL_WAIT_MS = 2000;

const IDENTITY_ROW =
  /^\s*(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/;

type LiveIdentity = { startedAt: string; exited: boolean };

function requestSignal(context: ExperimentalHostRpcContext): AbortSignal {
  return AbortSignal.any([context.signal, context.lifecycle.signal]);
}

function columns(...names: string[]): string[] {
  return names.flatMap((name) => ["-o", `${name}=`]);
}

async function readLines(
  file: string,
  args: readonly string[],
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  signal.throwIfAborted();

  const name = basename(file);
  const deadline = AbortSignal.timeout(COMMAND_DEADLINE_MS);
  const abandon = new AbortController();
  let failure: string | null = null;

  const child = spawn(file, args, {
    env: { ...process.env, LC_ALL: "C" },
    signal: AbortSignal.any([signal, deadline, abandon.signal]),
    stdio: ["ignore", "pipe", "ignore"],
  });

  let bytes = 0;

  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;

    if (bytes <= MAX_OUTPUT_BYTES) return;

    failure = "output was too large";
    abandon.abort();
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });

  lines.on("line", onLine);
  lines.on("error", () => {
    failure = "output could not be read";
    abandon.abort();
  });

  const exit = await new Promise<number | null | "unavailable">((resolve) => {
    child.once("error", () => resolve("unavailable"));
    child.once("close", (code) => resolve(code));
  });

  lines.close();
  signal.throwIfAborted();

  if (deadline.aborted) throw new Error(`${name} timed out after ${COMMAND_DEADLINE_MS} ms`);

  if (failure !== null) throw new Error(`${name} ${failure}`);

  if (exit === "unavailable") throw new Error(`${name} could not run`);

  if (exit !== 0 && !(name === "ps" && exit === 1)) throw new Error(`${name} exited ${exit}`);
}

async function readFootprints(
  pids: readonly number[],
  signal: AbortSignal,
): Promise<{ footprints: Map<number, number>; memoryFailure: string | null }> {
  const footprints = new Map<number, number>();
  let memoryFailure: string | null = null;

  for (let start = 0; start < pids.length; start += TOP_BATCH_SIZE) {
    const pidArguments = pids
      .slice(start, start + TOP_BATCH_SIZE)
      .flatMap((pid) => ["-pid", String(pid)]);

    try {
      await readLines(TOP, ["-l", "1", "-stats", "pid,mem", ...pidArguments], signal, (line) => {
        const row = parseTopRow(line);

        if (row !== null) footprints.set(row.pid, row.bytes);
      });
    } catch (error) {
      signal.throwIfAborted();
      memoryFailure = error instanceof Error ? error.message : "top failed";
    }
  }

  return { footprints, memoryFailure };
}

async function scan(
  context: ExperimentalHostRpcContext,
  includeFootprints = true,
  signal = requestSignal(context),
): Promise<ScanResult> {
  if (process.platform !== "darwin")
    return { supported: false, reason: "Process tracking is only available on macOS." };

  const dataDir = daemonDataDir(context.experimental_paths.dataDir);

  if (dataDir === null)
    return { supported: false, reason: "Omnyo's data folder could not be found on this machine." };

  const lineage: LineageRow[] = [];
  const executables = new Map<number, ExecutableRow>();
  const commands = new Map<number, CommandRow>();

  await Promise.all([
    readLines(PS, ["-axww", ...columns("pid", "ppid", "lstart", "time")], signal, (line) => {
      const row = parseLineageRow(line);

      if (row !== null) lineage.push(row);
    }),
    readLines(PS, ["-axww", ...columns("pid", "lstart", "rss", "stat", "comm")], signal, (line) => {
      const row = parseExecutableRow(line);

      if (row !== null) executables.set(row.pid, row);
    }),
    readLines(PS, ["-axww", ...columns("pid", "lstart", "command")], signal, (line) => {
      const row = parseCommandRow(line);

      if (row !== null) commands.set(row.pid, row);
    }),
  ]);

  const tags = new Map<number, ProcessTags>();
  const unverifiedPids = new Set<number>();

  await readLines(
    PERL,
    ["-e", READ_TAGS_PERL, ...lineage.map((row) => String(row.pid))],
    signal,
    (line) => {
      const failedPid = parseTagFailureRow(line);

      if (failedPid !== null) unverifiedPids.add(failedPid);
      const row = parseTagRow(line);

      if (row !== null) tags.set(row.pid, row);
    },
  );

  const classified = classifyProcesses(joinProcessRows(lineage, tags, executables, commands), {
    dataDir,
    selfPid: process.pid,
    unverifiedPids,
  });

  const workloadPids = classified.flatMap((row) => (row.role === "workload" ? [row.pid] : []));

  const { footprints, memoryFailure } = includeFootprints
    ? await readFootprints(workloadPids, signal)
    : { footprints: new Map<number, number>(), memoryFailure: null };

  return {
    supported: true,
    processes: withMemory(classified, footprints),
    memoryFailure,
    scanFailures: [...unverifiedPids].map(
      (pid) => `Process ${pid} and its descendants are held because ownership tags conflict.`,
    ),
  };
}

async function cpuSample(signal: AbortSignal) {
  const rows: UsageRow[] = [];

  await readLines(
    PS,
    ["-axww", ...columns("pid", "ppid", "lstart", "time", "ucomm")],
    signal,
    (line) => {
      const row = parseUsageRow(line);

      if (row !== null) rows.push(row);
    },
  );

  return { rows, at: performance.now() };
}

async function collectUsage(context: ExperimentalHostRpcContext): Promise<HostUsage> {
  const signal = AbortSignal.any([context.lifecycle.signal, AbortSignal.timeout(8000)]);
  const hostName = hostname();

  const system = (async () => {
    const before = cpus();

    await delay(250, undefined, { signal });

    return { ...systemMemory(), cpuPercent: systemCpuPercent(before, cpus()) };
  })();

  const gpu = readGpuPercent(signal);

  const processes = (async () => {
    try {
      const initial = await scan(context, false, signal);

      if (!initial.supported) {
        await delay(250, undefined, { signal });

        return { coverage: "unsupported" as const, threads: [] };
      }

      const before = await cpuSample(signal);

      await delay(250, undefined, { signal });

      const after = await cpuSample(signal);

      return summarizeUsage(initial, before.rows, after.rows, after.at - before.at);
    } catch {
      return { coverage: "failed" as const, threads: [] };
    }
  })();

  const [usage, gpuPercent, systemUsage] = await Promise.all([processes, gpu, system]);

  return {
    hostName,
    system: { ...systemUsage, gpuPercent },
    ...usage,
  };
}

let pendingUsage: Promise<HostUsage> | null = null;

function usage(context: ExperimentalHostRpcContext): Promise<HostUsage> {
  pendingUsage ??= collectUsage(context).finally(() => {
    pendingUsage = null;
  });

  return pendingUsage;
}

async function readIdentities(
  pids: readonly number[],
  signal: AbortSignal,
): Promise<Map<number, LiveIdentity>> {
  const identities = new Map<number, LiveIdentity>();

  if (pids.length === 0) return identities;

  await readLines(
    PS,
    ["-ww", "-p", pids.join(","), ...columns("pid", "stat", "lstart")],
    signal,
    (line) => {
      const match = IDENTITY_ROW.exec(line);

      if (match === null) return;

      identities.set(Number(match[1]), {
        startedAt: (match[3] ?? "").replace(/\s+/g, " "),
        exited: (match[2] ?? "").includes("Z"),
      });
    },
  );

  return identities;
}

type Verdict = { kind: "verified" } | { kind: "gone" } | { kind: "refused"; detail: string };

async function verifyIdentity(identity: ProcessIdentity, signal: AbortSignal): Promise<Verdict> {
  if (identity.pid <= 1 || identity.pid === process.pid || identity.pid === process.ppid)
    return { kind: "refused", detail: "protected process" };

  const current = (await readIdentities([identity.pid], signal)).get(identity.pid);

  if (current === undefined || current.exited) return { kind: "gone" };

  return current.startedAt === identity.startedAt
    ? { kind: "verified" }
    : { kind: "refused", detail: "process identity changed" };
}

function sendSignal(pid: number, name: NodeJS.Signals): "sent" | "gone" | "failed" {
  try {
    process.kill(pid, name);

    return "sent";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH" ? "gone" : "failed";
  }
}

async function waitForExit(
  results: readonly ProcessStopResult[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProcessStopResult[]> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const live = await readIdentities(
      results.map((result) => result.pid),
      signal,
    );

    const survivors = results.filter((result) => {
      const current = live.get(result.pid);

      return current !== undefined && !current.exited && current.startedAt === result.startedAt;
    });

    if (survivors.length === 0 || Date.now() >= deadline) return survivors;

    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }
}

async function stopProcesses(
  { identities, graceMs }: { identities: readonly ProcessIdentity[]; graceMs: number },
  context: ExperimentalHostRpcContext,
): Promise<{ results: ProcessStopResult[] }> {
  const signal = requestSignal(context);

  const results: ProcessStopResult[] = identities.map((identity) => ({
    ...identity,
    outcome: "refused",
    detail: "process was not verified",
  }));

  const signalled: ProcessStopResult[] = [];

  for (const result of results) {
    const verdict = await verifyIdentity(result, signal);

    if (verdict.kind === "refused") {
      result.detail = verdict.detail;
      continue;
    }

    const sent = verdict.kind === "gone" ? "gone" : sendSignal(result.pid, "SIGTERM");

    if (sent === "sent") signalled.push(result);
    else {
      result.outcome = sent;
      result.detail = sent === "failed" ? "SIGTERM was not permitted" : null;
    }
  }

  const survivors = new Set(await waitForExit(signalled, graceMs, signal));
  const killed: ProcessStopResult[] = [];

  for (const result of signalled) {
    if (!survivors.has(result)) {
      result.outcome = "terminated";
      result.detail = null;
      continue;
    }

    const verdict = await verifyIdentity(result, signal);

    if (verdict.kind === "refused") {
      result.detail = verdict.detail;
      continue;
    }

    const sent = verdict.kind === "gone" ? "gone" : sendSignal(result.pid, "SIGKILL");

    if (sent === "sent") {
      killed.push(result);
      continue;
    }

    result.outcome = sent === "gone" ? "terminated" : "failed";
    result.detail = sent === "gone" ? null : "SIGKILL was not permitted";
  }

  const unkillable = new Set(await waitForExit(killed, KILL_WAIT_MS, signal));

  for (const result of killed) {
    result.outcome = unkillable.has(result) ? "failed" : "killed";
    result.detail = unkillable.has(result) ? "still running after SIGKILL" : null;
  }

  return { results };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    cuaInspect: ({ config }, context) => inspectCuaRuntime(config, requestSignal(context)),
    cuaStop: (input, context) => stopCuaRuntime(input, requestSignal(context)),
    cuaReconcile: ({ vm }, context) => reconcileCuaRuntime(vm, requestSignal(context)),
    usage: (_input, context) => usage(context),
    scan: (_input, context) => scan(context),
    stop: (input, context) =>
      stopProcesses(
        { identities: input.identities, graceMs: input.graceMs ?? DEFAULT_GRACE_MS },
        context,
      ),
  },
});
