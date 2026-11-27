import { inspectionSummary } from "./lib/inspection";
import type { PluginCliCommandInfo, PluginCliResult } from "@omnyo/plugin-sdk";
import type {
  HistoryEntry,
  HostGroup,
  ListResult,
  ProcessStopResult,
  StopOutcome,
  WorkloadRow,
  UsageResult,
} from "./contract";
import { formatBytes, formatDuration, formatProcessCount } from "./lib/format";
import type { Sweeper } from "./sweeper";

const HISTORY_LINES = 50;

export const CLI_COMMANDS: PluginCliCommandInfo[] = [
  {
    name: "usage",
    summary: "Current CPU and memory for each chat, including its agent and helpers",
    usage: "omnyo leftover-processes usage [--json]",
  },
  {
    name: "list",
    summary: "What each chat left running, with memory and what happens next",
    usage: "omnyo leftover-processes list [--all] [--thread <id>] [--host <id>] [--json]",
  },
  {
    name: "stop",
    summary: "Stop processes and what they started",
    usage: "omnyo leftover-processes stop <pid...> [--host <id>]",
  },
  {
    name: "keep",
    summary: "Keep a process running after its chat",
    usage: "omnyo leftover-processes keep <pid> [--host <id>]",
  },
  {
    name: "unkeep",
    summary: "Let a kept process stop with its chat",
    usage: "omnyo leftover-processes unkeep <pid> [--host <id>]",
  },
  {
    name: "sweep",
    summary: "Check every chat now and stop what is due",
    usage: "omnyo leftover-processes sweep [--thread <id>] [--now]",
  },
  {
    name: "history",
    summary: "Recent stops",
    usage: "omnyo leftover-processes history",
  },
];

const USAGE = ["Usage:", ...CLI_COMMANDS.map((command) => `  ${command.usage}`)].join("\n");

const OUTCOME_TEXT: ReadonlyMap<StopOutcome, string> = new Map([
  ["terminated", "stopped"],
  ["killed", "killed after the grace period"],
  ["gone", "already gone"],
  ["refused", "refused"],
  ["failed", "failed"],
]);

type ParsedArguments = {
  command: string | null;
  positionals: string[];
  threadId: string | undefined;
  hostId: string | undefined;
  json: boolean;
  now: boolean;
  all: boolean;
};

function failure(stderr: string): PluginCliResult {
  return { exitCode: 1, stderr };
}

type ArgumentParse = { ok: true; args: ParsedArguments } | { ok: false; error: string };

function parseArguments(argv: readonly string[]): ArgumentParse {
  const parsed: ParsedArguments = {
    command: null,
    positionals: [],
    threadId: undefined,
    hostId: undefined,
    json: false,
    now: false,
    all: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "--json") parsed.json = true;
    else if (argument === "--now") parsed.now = true;
    else if (argument === "--all") parsed.all = true;
    else if (argument === "--thread" || argument === "--host") {
      index += 1;

      const value = argv[index];

      if (value === undefined || value.startsWith("--"))
        return { ok: false, error: `${argument} needs a value.` };

      if (argument === "--thread") parsed.threadId = value;
      else parsed.hostId = value;
    } else if (argument.startsWith("--"))
      return { ok: false, error: `Unknown option ${argument}.` };
    else if (parsed.command === null) parsed.command = argument;
    else parsed.positionals.push(argument);
  }

  return { ok: true, args: parsed };
}

function parsePids(values: readonly string[]): number[] | null {
  const pids = values.map(Number);

  return pids.length > 0 && pids.every((pid) => Number.isInteger(pid) && pid > 1) ? pids : null;
}

function formatMemory(row: WorkloadRow): string {
  const bytes = formatBytes(row.memoryBytes);

  return row.memorySource === "rss" ? `${bytes} (RSS)` : bytes;
}

function formatAge(row: WorkloadRow): string {
  return row.ageSeconds === null ? "age unknown" : formatDuration(row.ageSeconds * 1000);
}

function hostHeading(host: HostGroup): string {
  const label = `${host.name} (${host.hostId})`;

  if (host.status === "unsupported") return `${label}: Not available on this machine`;

  if (host.status === "failed") return `${label}: Could not scan. ${host.detail ?? ""}`.trimEnd();

  if (host.processCount === 0) return `${label}: Nothing left running`;

  return `${label}: ${formatBytes(host.memoryBytes)} in ${formatProcessCount(host.processCount)}`;
}

function renderList(list: ListResult, now: number): string {
  const observed = inspectionSummary(list);

  const summary =
    list.coverage === "complete" && list.processCount > 0 ? `Left running: ${observed}` : observed;

  const lines = [summary];

  if (!list.autoStop) lines.push("Auto-stop is off.");

  if (list.lastSweep !== null) {
    lines.push(`Last sweep: ${formatDuration(now - list.lastSweep.at)} ago`);

    for (const text of list.lastSweep.failures) lines.push(`  Sweep problem: ${text}`);
  }

  for (const host of list.hosts) {
    lines.push("", hostHeading(host));

    if (host.lastSuccessfulAt != null)
      lines.push(
        `  Last successful inspection: ${formatDuration(now - host.lastSuccessfulAt)} ago`,
      );

    for (const text of host.failures) lines.push(`  Problem: ${text}`);

    for (const thread of host.threads) {
      lines.push(`  ${thread.title} (${thread.threadId}): ${formatBytes(thread.memoryBytes)}`);

      for (const row of thread.processes)
        lines.push(
          `    ${row.pid}  ${formatMemory(row)}  ${formatAge(row)}  ${row.nextStep}  ${row.command}`,
        );
    }
  }

  for (const resource of list.cuaResources) {
    lines.push(
      "",
      `Cua ${resource.sandbox.name}: ${resource.retentionReason}`,
      `  Owner: ${resource.ownerThreadId}; resource ${resource.id}`,
    );

    if (resource.lastHoldReason !== null) lines.push(`  ${resource.lastHoldReason}`);

    if (resource.nextStopAt !== null)
      lines.push(`  Stops after ${new Date(resource.nextStopAt).toISOString()}`);
  }

  return lines.join("\n");
}

function renderHistory(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return "No stops yet.";

  return entries
    .map((entry) => {
      const at = new Date(entry.at).toISOString().slice(0, 16).replace("T", " ");

      return `${at}  ${entry.hostName}  ${entry.threadTitle}  ${formatBytes(entry.memoryBytes)}  ${entry.reason}  ${OUTCOME_TEXT.get(entry.outcome) ?? entry.outcome}  ${entry.command}`;
    })
    .join("\n");
}

function renderStopResults(results: readonly ProcessStopResult[]): PluginCliResult {
  const stdout = results
    .map((result) => {
      const text = OUTCOME_TEXT.get(result.outcome) ?? result.outcome;

      return `${result.pid}: ${text}${result.detail === null ? "" : ` (${result.detail})`}`;
    })
    .join("\n");

  const failed = results.some(
    (result) => result.outcome === "refused" || result.outcome === "failed",
  );

  return { exitCode: failed ? 1 : 0, stdout };
}

async function findWorkloads(
  sweeper: Sweeper,
  pids: readonly number[],
  hostId: string | undefined,
): Promise<WorkloadRow[] | string> {
  const list = await sweeper.list({ hostId, refresh: true, includeRunningChats: true });
  const rows = list.hosts.flatMap((host) => host.threads.flatMap((thread) => thread.processes));
  const found: WorkloadRow[] = [];

  for (const pid of pids) {
    const matches = rows.filter((row) => row.pid === pid);

    if (matches.length > 1) return `Process ${pid} runs on several machines. Pass --host.`;

    const match = matches[0];

    if (match === undefined) return `Process ${pid} is not a process a chat left running.`;

    found.push(match);
  }

  return found;
}

async function runStop(sweeper: Sweeper, args: ParsedArguments): Promise<PluginCliResult> {
  const pids = parsePids(args.positionals);

  if (pids === null) return failure(USAGE);

  const rows = await findWorkloads(sweeper, pids, args.hostId);

  if (!Array.isArray(rows)) return failure(rows);

  const hostIds = [...new Set(rows.map((row) => row.hostId))];
  const results: ProcessStopResult[] = [];

  for (const hostId of hostIds) {
    const identities = rows.flatMap((row) =>
      row.hostId === hostId ? [{ pid: row.pid, startedAt: row.startedAt }] : [],
    );

    results.push(...(await sweeper.stop(hostId, identities)).results);
  }

  return renderStopResults(results);
}

async function runKeep(
  sweeper: Sweeper,
  args: ParsedArguments,
  keep: boolean,
): Promise<PluginCliResult> {
  const pids = parsePids(args.positionals);

  if (pids?.length !== 1) return failure(USAGE);

  const rows = await findWorkloads(sweeper, pids, args.hostId);

  if (!Array.isArray(rows)) return failure(rows);

  const [row] = rows;

  if (row === undefined) return failure(USAGE);

  const identity = { pid: row.pid, startedAt: row.startedAt };

  const result = keep ? sweeper.keep(row.hostId, identity) : sweeper.unkeep(row.hostId, identity);

  return result.ok
    ? { exitCode: 0, stdout: `${row.pid}: ${result.detail}` }
    : failure(`${row.pid}: ${result.detail}`);
}

async function runSweepCommand(sweeper: Sweeper, args: ParsedArguments): Promise<PluginCliResult> {
  const status = await sweeper.sweep({ threadId: args.threadId, now: args.now });
  const lines = [`Sweep finished. Stopped ${formatProcessCount(status.stopped)}.`];

  for (const text of status.failures) lines.push(`Problem: ${text}`);

  return { exitCode: status.failures.length === 0 ? 0 : 1, stdout: lines.join("\n") };
}

export async function runCli(
  sweeper: Sweeper & { usage: () => Promise<UsageResult> },
  argv: readonly string[],
): Promise<PluginCliResult> {
  const parsed = parseArguments(argv);

  if (!parsed.ok) return failure(`${parsed.error}\n${USAGE}`);

  const { args } = parsed;

  try {
    switch (args.command) {
      case "usage": {
        if (
          args.positionals.length > 0 ||
          args.hostId !== undefined ||
          args.threadId !== undefined ||
          args.all ||
          args.now
        )
          return failure(USAGE);

        const usage = await sweeper.usage();

        const lines = usage.hosts.flatMap((host) => [
          `${host.hostName} (${host.hostId}): ${host.coverage}`,
          `  System: ${host.system.cpuPercent === null ? "CPU unknown" : `${host.system.cpuPercent.toFixed(1)}% CPU`}, ${host.system.gpuPercent === null ? "GPU unknown" : `${host.system.gpuPercent.toFixed(1)}% GPU`}, ${host.system.memoryUsedBytes === null ? "memory unknown" : formatBytes(host.system.memoryUsedBytes)} / ${host.system.memoryTotalBytes === null ? "unknown" : formatBytes(host.system.memoryTotalBytes)}`,
          ...host.threads.flatMap((thread) => [
            `  ${thread.threadId}: ${thread.cpuPercent === null ? "CPU unknown" : `${thread.cpuPercent.toFixed(1)}% CPU`}, ${formatBytes(thread.memoryBytes)} RSS`,
            ...thread.tasks.map(
              (task) =>
                `    ${task.pid} ${task.name}: ${task.cpuPercent === null ? "CPU unknown" : `${task.cpuPercent.toFixed(1)}% CPU`}, ${formatBytes(task.memoryBytes)} RSS`,
            ),
          ]),
        ]);

        return {
          exitCode: usage.hosts.every((host) => host.coverage === "complete") ? 0 : 1,
          stdout: args.json ? JSON.stringify(usage) : lines.join("\n"),
        };
      }

      case "list": {
        const list = await sweeper.list({
          hostId: args.hostId,
          threadId: args.threadId,
          refresh: true,
          includeRunningChats: args.all,
        });

        return {
          exitCode: list.coverage === "complete" ? 0 : 1,
          stdout: args.json ? JSON.stringify(list) : renderList(list, Date.now()),
        };
      }

      case "stop":
        return await runStop(sweeper, args);

      case "keep":
        return await runKeep(sweeper, args, true);

      case "unkeep":
        return await runKeep(sweeper, args, false);

      case "sweep":
        return await runSweepCommand(sweeper, args);

      case "history":
        return { exitCode: 0, stdout: renderHistory(sweeper.history(HISTORY_LINES)) };

      case null:
      case "help":
        return { exitCode: 0, stdout: USAGE };

      default:
        return failure(USAGE);
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : "The command failed.");
  }
}
