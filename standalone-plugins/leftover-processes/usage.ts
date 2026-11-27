import type { HostUsage, ScanResult, UsageResult } from "./contract";
import type { LineageRow, UsageRow } from "./process-table";
import { emptySystemUsage } from "./system-usage";
import { safeExecutableName } from "./process-table";
import { identityKey } from "./policy";

export function summarizeUsage(
  scan: Extract<ScanResult, { supported: true }>,
  before: readonly LineageRow[],
  after: readonly UsageRow[],
  elapsedMs: number,
): Pick<HostUsage, "coverage" | "threads"> {
  const previous = new Map(before.map((row) => [identityKey(row), row.cpuSeconds]));
  const current = new Map(after.map((row) => [identityKey(row), row]));
  const threads = new Map<string, HostUsage["threads"][number]>();
  let partial = scan.memoryFailure !== null || (scan.scanFailures?.length ?? 0) > 0;

  for (const process of scan.processes) {
    const key = identityKey(process);
    const start = previous.get(key);
    const observed = current.get(key);
    const end = observed?.cpuSeconds;
    const valid = start !== undefined && end !== undefined && end >= start && elapsedMs > 0;
    const cpuPercent = valid ? ((end - start) * 100_000) / elapsedMs : null;

    const thread = threads.get(process.threadId) ?? {
      threadId: process.threadId,
      tasks: [],
      cpuPercent: 0,
      memoryBytes: 0,
    };

    thread.tasks.push({
      pid: process.pid,
      name: safeExecutableName(observed?.name ?? "process"),
      cpuPercent,
      memoryBytes: process.memoryBytes,
    });
    thread.memoryBytes += process.memoryBytes;
    thread.cpuPercent =
      thread.cpuPercent === null || cpuPercent === null ? null : thread.cpuPercent + cpuPercent;
    partial ||= !valid;
    threads.set(thread.threadId, thread);
  }

  return { coverage: partial ? "partial" : "complete", threads: [...threads.values()] };
}

type UsageSource = {
  hosts: () => Promise<readonly { id: string; name: string; status: string }[]>;
  read: (hostId: string) => Promise<HostUsage>;
};

export function createUsageReader(source: UsageSource) {
  let pending: Promise<UsageResult> | null = null;

  async function collect(): Promise<UsageResult> {
    const hosts = await source.hosts();
    const results: UsageResult["hosts"] = [];
    let next = 0;

    async function worker() {
      while (next < hosts.length) {
        const index = next++;
        const host = hosts[index];

        if (host === undefined) continue;

        let usage: HostUsage = {
          hostName: host.name,
          system: emptySystemUsage(),
          coverage: "failed",
          threads: [],
        };

        if (host.status === "connected") {
          try {
            usage = await source.read(host.id);
          } catch {
            usage = {
              hostName: host.name,
              system: emptySystemUsage(),
              coverage: "failed",
              threads: [],
            };
          }
        }

        results[index] = { hostId: host.id, ...usage };
      }
    }

    await Promise.all(Array.from({ length: Math.min(4, hosts.length) }, () => worker()));

    return { hosts: results };
  }

  return () => {
    pending ??= collect().finally(() => {
      pending = null;
    });

    return pending;
  };
}
