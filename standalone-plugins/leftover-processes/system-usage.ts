import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { z } from "zod";
import type { SystemUsage } from "./contract";

export function emptySystemUsage(): SystemUsage {
  return { cpuPercent: null, gpuPercent: null, memoryUsedBytes: null, memoryTotalBytes: null };
}

export type CpuSample = ReturnType<typeof cpus>;

export function systemCpuPercent(before: CpuSample, after: CpuSample): number | null {
  if (before.length === 0 || before.length !== after.length) return null;

  let idle = 0;
  let total = 0;

  for (let index = 0; index < before.length; index += 1) {
    const start = before[index];
    const end = after[index];

    if (start === undefined || end === undefined) return null;

    for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
      const delta = end.times[key] - start.times[key];

      if (!Number.isFinite(delta) || delta < 0) return null;

      total += delta;

      if (key === "idle") idle += delta;
    }
  }

  return total > 0 ? ((total - idle) / total) * 100 : null;
}

export function parseMacGpuPercent(output: string): number | null {
  const values = [
    ...output.matchAll(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)(?=\s*[,}])/g),
  ].map((match) => Number(match[1]));

  return values.length > 0 && values.every((value) => value >= 0 && value <= 100)
    ? Math.max(...values)
    : null;
}

const windowsGpuCounter = z.object({
  Name: z.string(),
  UtilizationPercentage: z.number().min(0).max(100),
});

const windowsGpuCounters = z.union([windowsGpuCounter, z.array(windowsGpuCounter)]);

export function parseWindowsGpuPercent(output: string): number | null {
  try {
    const parsed = windowsGpuCounters.safeParse(JSON.parse(output));

    if (!parsed.success) return null;

    const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    const engines = new Map<string, number>();

    for (const row of rows) {
      const match = /^pid_\d+_(luid_0x[\da-f]+_0x[\da-f]+_phys_\d+_eng_\d+)_engtype_.+$/i.exec(
        row.Name,
      );

      if (match?.[1] === undefined) return null;

      engines.set(match[1], (engines.get(match[1]) ?? 0) + row.UtilizationPercentage);
    }

    return engines.size > 0 ? Math.min(100, Math.max(...engines.values())) : null;
  } catch {
    return null;
  }
}

export function parseNvidiaGpuPercent(output: string): number | null {
  const values = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());

  if (!values.every((value) => /^\d+(?:\.\d+)?$/.test(value))) return null;

  const percentages = values.map(Number);

  return percentages.every((value) => value >= 0 && value <= 100) ? Math.max(...percentages) : null;
}

function nvidiaGpuPercent(
  signal: AbortSignal,
): Promise<{ available: boolean; percent: number | null }> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi.exe",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { signal, timeout: 2500, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve({
          available: error?.code !== "ENOENT",
          percent: error === null ? parseNvidiaGpuPercent(stdout) : null,
        });
      },
    );
  });
}

function counterOutput(file: string, args: string[], signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { signal, timeout: 2500, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error === null ? stdout : null);
      },
    );
  });
}

export async function readGpuPercent(signal: AbortSignal): Promise<number | null> {
  if (process.platform === "darwin") {
    const output = await counterOutput(
      "/usr/sbin/ioreg",
      ["-r", "-d", "1", "-c", "IOAccelerator", "-w", "0"],
      signal,
    );

    return output === null ? null : parseMacGpuPercent(output);
  }

  if (process.platform === "win32") {
    const nvidia = await nvidiaGpuPercent(signal);

    if (nvidia.available) return nvidia.percent;

    const output = await counterOutput(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Select-Object Name,UtilizationPercentage | ConvertTo-Json -Compress",
      ],
      signal,
    );

    return output === null ? null : parseWindowsGpuPercent(output);
  }

  return null;
}

export function systemMemory(): Pick<SystemUsage, "memoryUsedBytes" | "memoryTotalBytes"> {
  const total = totalmem();
  const free = freemem();

  return Number.isFinite(total) && Number.isFinite(free) && total > 0 && free >= 0 && free <= total
    ? { memoryUsedBytes: total - free, memoryTotalBytes: total }
    : { memoryUsedBytes: null, memoryTotalBytes: null };
}
