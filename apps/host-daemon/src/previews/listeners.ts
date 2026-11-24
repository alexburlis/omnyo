import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { execPortableFile } from "@omnyo/process-utils";
import { z } from "zod";

const processParentSchema = z.object({
  pid: z.number().int().positive(),
  parentPid: z.number().int().nonnegative(),
});

const previewListenersSchema = z.object({
  listenerPids: z.array(z.number().int().positive()),
  processes: z.array(processParentSchema),
});

type ProcessParent = z.infer<typeof processParentSchema>;

type PreviewListeners = z.infer<typeof previewListenersSchema>;

async function inspectLinuxListeners(port: number): Promise<PreviewListeners> {
  const socketIds = new Set<string>();

  for (const filename of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const content = await readFile(filename, "utf8");

    for (const line of content.trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      const address = fields[1]?.split(":");

      if (
        fields[3] === "0A" &&
        Number.parseInt(address?.[1] ?? "", 16) === port &&
        fields[9] !== undefined
      ) {
        socketIds.add(fields[9]);
      }
    }
  }

  const processes: ProcessParent[] = [];
  const listenerPids: number[] = [];

  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;

    const pid = Number(entry);

    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");

      const parentPid = Number(
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1],
      );

      processes.push({ pid, parentPid });

      if (socketIds.size === 0) continue;

      for (const fd of await readdir(`/proc/${entry}/fd`)) {
        const target = await readlink(`/proc/${entry}/fd/${fd}`).catch(
          () => "",
        );

        const socketId = /^socket:\[(\d+)\]$/u.exec(target)?.[1];

        if (socketId !== undefined && socketIds.has(socketId)) {
          listenerPids.push(pid);
          break;
        }
      }
    } catch {
      continue;
    }
  }

  if (socketIds.size > 0 && listenerPids.length === 0) {
    throw new Error("Listener ownership is unavailable");
  }

  return { listenerPids, processes };
}

async function inspectWindowsListeners(
  port: number,
): Promise<PreviewListeners> {
  const { stdout } = await execPortableFile(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        `$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)`,
        "$processes = @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId } })",
        "@{ listenerPids = $listeners; processes = $processes } | ConvertTo-Json -Depth 3 -Compress",
      ].join("; "),
    ],
    {
      cwd: process.env.SystemRoot ?? "C:\\Windows",
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    },
  );

  const value: unknown = JSON.parse(stdout);

  return previewListenersSchema.parse(value);
}

export class PreviewInspectionError extends Error {
  constructor(
    readonly phase: "netstat" | "parents" | "parse",
    readonly elapsedMs: number,
    readonly failure:
      | "timeout"
      | "exit"
      | "spawn"
      | "parse"
      | "stopped"
      | "buffer",
    readonly exitCode: number | null = null,
  ) {
    super("Preview process inspection failed");
  }
}

async function runDarwinInspector(
  phase: "netstat" | "parents",
  executable: string,
  args: string[],
  timeout: number,
  maxBuffer: number,
): Promise<{ stdout: string; stderr: string }> {
  const startedAt = performance.now();

  try {
    return await execPortableFile(executable, args, {
      cwd: "/",
      env: {},
      timeout,
      maxBuffer,
    });
  } catch (error) {
    const timeoutFailure =
      error instanceof Error &&
      (error.message.startsWith("Command timed out after ") ||
        ("code" in error && error.code === "ETIMEDOUT"));

    const exitCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : null;

    const bufferFailure =
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

    const stoppedFailure =
      error instanceof Error &&
      (("killed" in error && error.killed === true) || exitCode === 0);

    throw new PreviewInspectionError(
      phase,
      Math.round(performance.now() - startedAt),
      timeoutFailure
        ? "timeout"
        : bufferFailure
          ? "buffer"
          : stoppedFailure
            ? "stopped"
            : exitCode !== null
              ? "exit"
              : "spawn",
      exitCode,
    );
  }
}

async function inspectDarwinListeners(port: number): Promise<PreviewListeners> {
  const [connections, parents] = await Promise.all([
    runDarwinInspector(
      "netstat",
      "/usr/sbin/netstat",
      ["-anv", "-p", "tcp"],
      1_500,
      4 * 1024 * 1024,
    ),
    runDarwinInspector(
      "parents",
      "/bin/ps",
      ["-axo", "pid=,ppid="],
      1_000,
      1024 * 1024,
    ),
  ]);

  const lines = connections.stdout.split("\n");

  const header = lines
    .find((line) => /^Proto\s/u.test(line))
    ?.replace("Local Address", "LocalAddress")
    .replace("Foreign Address", "ForeignAddress")
    .trim()
    .split(/\s+/u);

  if (header === undefined)
    throw new PreviewInspectionError("parse", 0, "parse");
  const addressIndex = header.indexOf("LocalAddress");
  const stateIndex = header.indexOf("(state)");
  const processIndex = header.indexOf("process:pid");
  const pidIndex = header.indexOf("pid");

  if (addressIndex < 0 || stateIndex < 0 || (processIndex < 0 && pidIndex < 0))
    throw new PreviewInspectionError("parse", 0, "parse");
  const listenerPids: number[] = [];

  for (const line of lines) {
    const fields = line.trim().split(/\s+/u);

    if (
      !fields[0]?.startsWith("tcp") ||
      fields[stateIndex] !== "LISTEN" ||
      !fields[addressIndex]?.endsWith(`.${port}`)
    )
      continue;

    const rawPid =
      processIndex >= 0
        ? /:(\d+)\s+[\da-f]+\s/iu.exec(
            fields.slice(processIndex).join(" "),
          )?.[1]
        : fields[pidIndex];

    const pid = Number(rawPid);

    if (!Number.isInteger(pid) || pid <= 0)
      throw new PreviewInspectionError("parse", 0, "parse");
    listenerPids.push(pid);
  }

  const processes = parents.stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);

      return match === null
        ? []
        : [{ pid: Number(match[1]), parentPid: Number(match[2]) }];
    });

  return { processes, listenerPids };
}

export async function inspectPreviewListeners(
  port: number,
): Promise<PreviewListeners> {
  if (process.platform === "linux") return inspectLinuxListeners(port);

  if (process.platform === "win32") return inspectWindowsListeners(port);

  if (process.platform === "darwin") return inspectDarwinListeners(port);

  throw new Error("Listener ownership is unavailable on this platform");
}

export function listenersBelongToPreview(
  rootPid: number,
  snapshot: PreviewListeners,
): boolean {
  const descendants = new Set([rootPid]);
  let added = true;

  while (added) {
    added = false;

    for (const processInfo of snapshot.processes) {
      if (
        descendants.has(processInfo.parentPid) &&
        !descendants.has(processInfo.pid)
      ) {
        descendants.add(processInfo.pid);
        added = true;
      }
    }
  }

  return (
    snapshot.listenerPids.length > 0 &&
    snapshot.listenerPids.every((pid) => descendants.has(pid))
  );
}
