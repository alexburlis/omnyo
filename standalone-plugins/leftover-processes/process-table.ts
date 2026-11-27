import { posix } from "node:path";
import type { ObservedProcess, ProcessRole } from "./contract";
import { redact } from "./lib/redact";
import { LEGACY_PROCESS_TAGS_IMPORTER_V1 } from "./legacy-process-tags-v1";

const STARTED_AT = "[A-Z][a-z]{2}\\s+[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}";

const CPU_TIME = "(?:\\d+-)?(?:\\d+:)?\\d+:\\d+(?:\\.\\d+)?";

const LINEAGE_ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${STARTED_AT})\\s+(${CPU_TIME})\\s*$`);

const USAGE_ROW = new RegExp(
  `^\\s*(\\d+)\\s+(\\d+)\\s+(${STARTED_AT})\\s+(${CPU_TIME})\\s+(\\S.*?)\\s*$`,
);

const EXECUTABLE_ROW = new RegExp(`^\\s*(\\d+)\\s+(${STARTED_AT})\\s+(\\d+)\\s+(\\S+)\\s+(.*)$`);

const COMMAND_ROW = new RegExp(`^\\s*(\\d+)\\s+(${STARTED_AT})\\s(.*)$`);

const TAG_ROW = /^(\d+)\t([^\t]*)\t([^\t]*)\t([^\t]*)$/;

const TOP_ROW = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT]?)[+-]?\s*$/;

const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const CONTROL_CHARACTERS = /\p{Cc}/gu;

const CPU_UNIT_SECONDS = [1, 60, 3600, 86_400];

const MEMORY_UNIT_BYTES = new Map([
  ["", 1],
  ["B", 1],
  ["K", 1024],
  ["M", 1024 ** 2],
  ["G", 1024 ** 3],
  ["T", 1024 ** 4],
]);

const AGENT_EXECUTABLES = new Set(["claude", "codex"]);

const SHELL_EXECUTABLES = new Set(["zsh", "bash", "sh", "dash", "fish"]);

const SHARED_DAEMON_EXECUTABLES = new Set([
  "adb",
  "dirmngr",
  "gpg-agent",
  "keyboxd",
  "op",
  "scdaemon",
]);

const BRIDGE_WORKERS = ["omnyo-provider-bridge-worker"];

const COMMAND_INPUT_LIMIT = 4096;

const COMMAND_DISPLAY_LIMIT = 160;

export const READ_TAGS_PERL = String.raw`
${LEGACY_PROCESS_TAGS_IMPORTER_V1}
my $size = 1 << 20;
my $buffer = "\0" x $size;
for my $pid (@ARGV) {
  my $mib = pack("i3", 1, 49, $pid);
  my $length = pack("Q", $size);
  next if syscall(202, $mib, 3, $buffer, $length, 0, 0) != 0;
  my %tags;
  for my $entry (split /\0+/, substr($buffer, 4, unpack("Q", $length) - 4)) {
    read_process_tag_v1(\%tags, $entry);
  }
  if (!eval { import_legacy_process_tags_v1(\%tags); 1 }) {
    print "!ownership\t$pid\n";
    next;
  }
  next unless %tags;
  print join("\t", $pid, map { $tags{$_} // "" } qw(OMNYO_THREAD_ID OMNYO_THREAD_STORAGE OMNYO_KEEP_RUNNING)), "\n";
}
`;

export type LineageRow = {
  pid: number;
  ppid: number;
  startedAt: string;
  cpuSeconds: number;
};

export type ProcessTags = {
  threadId: string | null;
  storage: string | null;
  keepRequested: boolean;
};

export type ExecutableRow = {
  pid: number;
  startedAt: string;
  rssBytes: number;
  zombie: boolean;
  comm: string;
};

export type CommandRow = { pid: number; startedAt: string; command: string };

export type ProcessRow = LineageRow &
  ProcessTags & {
    details: { rssBytes: number; comm: string; command: string } | null;
  };

export type ScanContext = {
  dataDir: string;
  selfPid: number;
  unverifiedPids?: ReadonlySet<number>;
};

export type ClassifiedProcess = Omit<ObservedProcess, "memoryBytes" | "memorySource"> & {
  rssBytes: number;
};

function normalizeStartedAt(value: string): string {
  return value.replace(/\s+/g, " ");
}

function parseCpuSeconds(value: string): number {
  return value
    .split(/[-:]/)
    .reverse()
    .reduce((total, part, index) => total + Number(part) * (CPU_UNIT_SECONDS[index] ?? 0), 0);
}

export function parseLineageRow(line: string): LineageRow | null {
  const match = LINEAGE_ROW.exec(line);

  if (match === null) return null;

  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    startedAt: normalizeStartedAt(match[3] ?? ""),
    cpuSeconds: parseCpuSeconds(match[4] ?? ""),
  };
}

export type UsageRow = LineageRow & { name: string };

export function parseUsageRow(line: string): UsageRow | null {
  const match = USAGE_ROW.exec(line);

  if (match === null) return null;

  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    startedAt: normalizeStartedAt(match[3] ?? ""),
    cpuSeconds: parseCpuSeconds(match[4] ?? ""),
    name: safeExecutableName(match[5] ?? ""),
  };
}

export function parseTagFailureRow(line: string): number | null {
  const match = /^!ownership\t(\d+)$/.exec(line);

  return match === null ? null : Number(match[1]);
}

export function parseTagRow(line: string): (ProcessTags & { pid: number }) | null {
  const match = TAG_ROW.exec(line);

  if (match === null) return null;

  return {
    pid: Number(match[1]),
    threadId: match[2] || null,
    storage: match[3] || null,
    keepRequested: match[4] === "1",
  };
}

export function parseExecutableRow(line: string): ExecutableRow | null {
  const match = EXECUTABLE_ROW.exec(line);

  if (match === null) return null;

  return {
    pid: Number(match[1]),
    startedAt: normalizeStartedAt(match[2] ?? ""),
    rssBytes: Number(match[3]) * 1024,
    zombie: (match[4] ?? "").includes("Z"),
    comm: match[5]?.trim() ?? "",
  };
}

export function parseCommandRow(line: string): CommandRow | null {
  const match = COMMAND_ROW.exec(line);

  if (match === null) return null;

  return {
    pid: Number(match[1]),
    startedAt: normalizeStartedAt(match[2] ?? ""),
    command: (match[3] ?? "").trimStart(),
  };
}

export function parseTopRow(line: string): { pid: number; bytes: number } | null {
  const match = TOP_ROW.exec(line);

  if (match === null) return null;

  return {
    pid: Number(match[1]),
    bytes: Math.round(Number(match[2]) * (MEMORY_UNIT_BYTES.get(match[3] ?? "") ?? 1)),
  };
}

export function joinProcessRows(
  lineage: readonly LineageRow[],
  tags: ReadonlyMap<number, ProcessTags>,
  executables: ReadonlyMap<number, ExecutableRow>,
  commands: ReadonlyMap<number, CommandRow>,
): ProcessRow[] {
  return lineage.map((row) => {
    const executable = executables.get(row.pid);
    const command = commands.get(row.pid);

    const joined =
      executable !== undefined &&
      command !== undefined &&
      executable.startedAt === row.startedAt &&
      command.startedAt === row.startedAt &&
      !executable.zombie;

    return {
      ...row,
      threadId: tags.get(row.pid)?.threadId ?? null,
      storage: tags.get(row.pid)?.storage ?? null,
      keepRequested: tags.get(row.pid)?.keepRequested ?? false,
      details: joined
        ? { rssBytes: executable.rssBytes, comm: executable.comm, command: command.command }
        : null,
    };
  });
}

function* lineage(
  start: ProcessRow,
  byPid: ReadonlyMap<number, ProcessRow>,
): Generator<ProcessRow> {
  const seen = new Set<number>();
  let current: ProcessRow | undefined = start;

  while (current !== undefined && !seen.has(current.pid)) {
    seen.add(current.pid);

    yield current;

    current = byPid.get(current.ppid);
  }
}

function executableNames(row: ProcessRow): string[] {
  if (row.details === null) return [];

  const argv0 = /^\S+/.exec(row.details.command)?.[0] ?? "";

  return [row.details.comm, argv0].map((path) => posix.basename(path).replace(/^-/, ""));
}

function isBridgeWorker(row: ProcessRow): boolean {
  const command = row.details?.command;

  return command !== undefined && BRIDGE_WORKERS.some((name) => command.includes(name));
}

function isAgent(row: ProcessRow, byPid: ReadonlyMap<number, ProcessRow>): boolean {
  if (!executableNames(row).some((name) => AGENT_EXECUTABLES.has(name))) return false;

  return [...lineage(row, byPid)].some((ancestor) => ancestor !== row && isBridgeWorker(ancestor));
}

function isSharedDaemon(row: ProcessRow): boolean {
  return executableNames(row).some((name) => SHARED_DAEMON_EXECUTABLES.has(name));
}

function isShell(row: ProcessRow): boolean {
  return executableNames(row).some((name) => SHELL_EXECUTABLES.has(name));
}

function roleOf(row: ProcessRow, byPid: ReadonlyMap<number, ProcessRow>): ProcessRole {
  if (isAgent(row, byPid)) return "agent";

  let child = row;

  for (const ancestor of lineage(row, byPid)) {
    if (ancestor === row) continue;

    if (isAgent(ancestor, byPid)) return isShell(child) ? "workload" : "helper";

    child = ancestor;
  }

  return "workload";
}

function countingThreadId(row: ProcessRow, storageRoot: string): string | null {
  if (row.threadId === null || row.storage === null || !THREAD_ID.test(row.threadId)) return null;

  return posix.normalize(row.storage).startsWith(storageRoot) ? row.threadId : null;
}

function ownerThreadId(
  row: ProcessRow,
  byPid: ReadonlyMap<number, ProcessRow>,
  storageRoot: string,
): string | null {
  for (const ancestor of lineage(row, byPid)) {
    const threadId = countingThreadId(ancestor, storageRoot);

    if (threadId !== null) return threadId;
  }

  return null;
}

function scriptArgument(comm: string, command: string): string {
  let rest = (
    command.startsWith(comm) ? command.slice(comm.length) : command.replace(/^\S+/, "")
  ).trimStart();

  while (rest.startsWith("-")) rest = rest.replace(/^\S+\s*/, "");

  return rest;
}

function runsFromAppVersions(row: ProcessRow, appVersionsRoot: string): boolean {
  if (row.details === null) return false;

  const { comm, command } = row.details;

  return (
    comm.startsWith(appVersionsRoot) || scriptArgument(comm, command).startsWith(appVersionsRoot)
  );
}

export function safeExecutableName(executable: string): string {
  return posix.basename(executable).replace(CONTROL_CHARACTERS, "").slice(0, 255) || "process";
}

export function displayCommand(comm: string, command: string): string {
  const name = posix.basename(comm) || "process";

  const args = (command.startsWith(comm) ? command.slice(comm.length) : command.replace(/^\S+/, ""))
    .slice(0, COMMAND_INPUT_LIMIT)
    .replace(CONTROL_CHARACTERS, " ")
    .trim();

  const visible = [name];

  for (const token of args.split(/\s+/)) {
    if (token === "") continue;

    if (ENVIRONMENT_ASSIGNMENT.test(token)) {
      visible.push(`${token.slice(0, token.indexOf("="))}=<redacted>`, "…");
      break;
    }

    visible.push(token);
  }

  const text = redact(visible.join(" "));

  return text.length > COMMAND_DISPLAY_LIMIT
    ? `${text.slice(0, COMMAND_DISPLAY_LIMIT - 1)}…`
    : text;
}

export function classifyProcesses(
  rows: readonly ProcessRow[],
  context: ScanContext,
): ClassifiedProcess[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const storageRoot = `${context.dataDir}/thread-storage/`;
  const appVersionsRoot = `${context.dataDir}/app-versions/`;
  const self = byPid.get(context.selfPid);

  const protectedPids = new Set(
    self === undefined ? [context.selfPid] : [...lineage(self, byPid)].map((row) => row.pid),
  );

  return rows.flatMap((row) => {
    if (row.details === null || protectedPids.has(row.pid)) return [];

    if ([...lineage(row, byPid)].some((ancestor) => context.unverifiedPids?.has(ancestor.pid)))
      return [];

    if (runsFromAppVersions(row, appVersionsRoot)) return [];

    if (isSharedDaemon(row)) return [];

    const threadId = ownerThreadId(row, byPid, storageRoot);

    if (threadId === null) return [];

    return [
      {
        pid: row.pid,
        startedAt: row.startedAt,
        ppid: row.ppid,
        threadId,
        role: roleOf(row, byPid),
        executable: redact(posix.basename(row.details.comm) || "process"),
        command: displayCommand(row.details.comm, row.details.command),
        cpuSeconds: row.cpuSeconds,
        keepRequested: [...lineage(row, byPid)].some((ancestor) => ancestor.keepRequested),
        rssBytes: row.details.rssBytes,
      },
    ];
  });
}

export function withMemory(
  processes: readonly ClassifiedProcess[],
  footprints: ReadonlyMap<number, number>,
): ObservedProcess[] {
  return processes.map(({ rssBytes, ...process }) => {
    const footprint = process.role === "workload" ? footprints.get(process.pid) : undefined;

    return footprint === undefined
      ? { ...process, memoryBytes: rssBytes, memorySource: "rss" }
      : { ...process, memoryBytes: footprint, memorySource: "footprint" };
  });
}

export function daemonDataDir(pluginDataDir: string): string | null {
  return /^(.+)\/plugins\/[^/]+\/host-data\/?$/.exec(pluginDataDir)?.[1] ?? null;
}
