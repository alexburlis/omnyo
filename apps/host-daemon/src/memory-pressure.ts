import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MemoryPressureSample } from "@omnyo/host-daemon-contract";

const execFileAsync = promisify(execFile);

export function parseDarwinMemoryPressure(value: string): MemoryPressureSample {
  switch (value.trim()) {
    case "1":
      return { status: "observed", level: "normal" };
    case "2":
      return { status: "observed", level: "warning" };
    case "4":
      return { status: "observed", level: "critical" };
    default:
      return { status: "unavailable", reason: "invalid-result" };
  }
}

export async function readMemoryPressure(): Promise<MemoryPressureSample> {
  if (process.platform !== "darwin") {
    return { status: "unavailable", reason: "unsupported-platform" };
  }

  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 64 },
    );

    return parseDarwinMemoryPressure(stdout);
  } catch {
    return { status: "unavailable", reason: "read-failed" };
  }
}

export function idleProviderSessionGraceMs(
  pressure: MemoryPressureSample,
): number {
  if (pressure.status === "unavailable") return 600_000;

  switch (pressure.level) {
    case "normal":
      return 600_000;
    case "warning":
      return 120_000;
    case "critical":
      return 60_000;
  }
}

export async function readProviderProcessMemory(
  pids: readonly number[],
): Promise<Map<number, number>> {
  const selected = [...new Set(pids)];

  if (
    selected.length === 0 ||
    (process.platform !== "darwin" && process.platform !== "linux")
  )
    return new Map();

  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", selected.join(","), "-o", "pid=,rss="],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
      },
    );

    const memory = new Map<number, number>();

    for (const line of stdout.trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);

      if (match && selected.includes(Number(match[1])))
        memory.set(Number(match[1]), Number(match[2]) * 1024);
    }

    return memory;
  } catch {
    return new Map();
  }
}
