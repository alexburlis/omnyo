import { z } from "zod";

export const usageSchema = z.object({
  hosts: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string().optional(),
      coverage: z.enum(["complete", "partial", "failed", "unsupported"]),
      system: z
        .object({
          cpuPercent: z.number().finite().nonnegative().nullable(),
          gpuPercent: z.number().finite().nonnegative().nullable(),
          memoryUsedBytes: z.number().finite().nonnegative().nullable(),
          memoryTotalBytes: z.number().finite().nonnegative().nullable(),
        })
        .optional(),
      threads: z.array(
        z.object({
          threadId: z.string(),
          cpuPercent: z.number().finite().nonnegative().nullable(),
          memoryBytes: z.number().finite().nonnegative(),
          tasks: z
            .array(
              z.object({
                pid: z.number().int().positive(),
                name: z.string(),
                cpuPercent: z.number().finite().nonnegative().nullable(),
                memoryBytes: z.number().finite().nonnegative(),
              }),
            )
            .optional(),
        }),
      ),
    }),
  ),
});

export type UsageSnapshot = z.infer<typeof usageSchema>;

export type HostUsage = UsageSnapshot["hosts"][number];

export interface UsageSample {
  at: number;
  cpu: number | null;
  gpu: number | null;
  memory: number | null;
}

export function sampleUsage(host: HostUsage, at: number): UsageSample {
  const system = host.system;

  return {
    at,
    cpu: system?.cpuPercent ?? null,
    gpu: system?.gpuPercent ?? null,
    memory:
      system?.memoryUsedBytes != null && system.memoryTotalBytes
        ? (system.memoryUsedBytes / system.memoryTotalBytes) * 100
        : null,
  };
}

export function sparklineSegments(values: readonly (number | null)[]): string[] {
  const segments: string[] = [];
  let points: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === null) {
      if (points.length > 0) segments.push(points.join(" "));
      points = [];
    } else {
      const x = values.length === 1 ? 72 : 1 + (index * 71) / (values.length - 1);
      points.push(`${x},${20 - Math.min(100, value) * 0.18}`);
    }
  }

  if (points.length > 0) segments.push(points.join(" "));

  return segments;
}

export function processName(name: string): string {
  return (
    [...name]
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join("")
      .split(/[\\/]/u)
      .at(-1)
      ?.trim() || "Process"
  ).slice(0, 64);
}

type ThreadUsage = UsageSnapshot["hosts"][number]["threads"][number];

export type UsageReading =
  | { kind: "unknown" }
  | { kind: "measured"; coverage: "complete" | "partial"; value: ThreadUsage };

export function indexUsage(snapshot: UsageSnapshot): ReadonlyMap<string, UsageReading> {
  const readings = new Map<string, UsageReading>();

  for (const host of snapshot.hosts) {
    for (const thread of host.threads) {
      readings.set(
        thread.threadId,
        readings.has(thread.threadId) ||
          host.coverage === "failed" ||
          host.coverage === "unsupported"
          ? { kind: "unknown" }
          : { kind: "measured", coverage: host.coverage, value: thread },
      );
    }
  }

  return readings;
}

export function memoryLabel(bytes: number): string {
  const megabytes = bytes / 1024 ** 2;

  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}
