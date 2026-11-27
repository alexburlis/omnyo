import { describe, expect, it } from "vitest";
import type { ObservedProcess } from "../contract";
import { emptySystemUsage } from "../system-usage";
import { createUsageReader, summarizeUsage } from "../usage";

function processRow(
  pid: number,
  role: ObservedProcess["role"],
  threadId = "chat",
): ObservedProcess {
  return {
    pid,
    role,
    threadId,
    ppid: 1,
    startedAt: "start",
    executable: "node",
    command: "node",
    memoryBytes: 1024,
    memorySource: "rss",
    cpuSeconds: 900,
    keepRequested: false,
  };
}

function sample(pid: number, cpuSeconds: number, startedAt = "start") {
  return { pid, ppid: 1, startedAt, cpuSeconds, name: "node" };
}

const scan = (processes: ObservedProcess[], scanFailures: string[] = []) => ({
  supported: true as const,
  processes,
  memoryFailure: null,
  scanFailures,
});

describe("chat usage", () => {
  it("sums all attributed roles using fresh CPU deltas instead of lifetime averages", () => {
    const result = summarizeUsage(
      scan([
        processRow(1, "agent"),
        processRow(2, "helper"),
        processRow(3, "workload"),
        processRow(4, "workload", "other"),
      ]),
      [sample(1, 10), sample(2, 20), sample(3, 30), sample(4, 0)],
      [sample(1, 10.5), sample(2, 20.25), sample(3, 30.5), sample(4, 0)],
      500,
    );

    expect(result).toEqual({
      coverage: "complete",
      threads: [
        {
          threadId: "chat",
          cpuPercent: 250,
          memoryBytes: 3072,
          tasks: [
            { pid: 1, name: "node", cpuPercent: 100, memoryBytes: 1024 },
            { pid: 2, name: "node", cpuPercent: 50, memoryBytes: 1024 },
            { pid: 3, name: "node", cpuPercent: 100, memoryBytes: 1024 },
          ],
        },
        {
          threadId: "other",
          cpuPercent: 0,
          memoryBytes: 1024,
          tasks: [{ pid: 4, name: "node", cpuPercent: 0, memoryBytes: 1024 }],
        },
      ],
    });
  });

  it("reports unknown CPU for exited, reused, or reset identities", () => {
    for (const after of [[], [sample(1, 12, "reused")], [sample(1, 1)]]) {
      expect(summarizeUsage(scan([processRow(1, "agent")]), [sample(1, 10)], after, 250)).toEqual({
        coverage: "partial",
        threads: [
          {
            threadId: "chat",
            cpuPercent: null,
            memoryBytes: 1024,
            tasks: [
              {
                pid: 1,
                name: after.length === 0 || after[0]?.startedAt !== "start" ? "process" : "node",
                cpuPercent: null,
                memoryBytes: 1024,
              },
            ],
          },
        ],
      });
    }
  });

  it("keeps partial ownership coverage even when observed CPU is zero", () => {
    expect(summarizeUsage(scan([], ["ownership conflict"]), [], [], 250)).toEqual({
      coverage: "partial",
      threads: [],
    });
  });

  it("uses sampled kernel executable names instead of rewritten titles or commands", () => {
    const process = processRow(1, "agent");
    process.executable = "fake --token sensitive";
    process.command = "node --token sensitive";
    const result = summarizeUsage(scan([process]), [sample(1, 0)], [sample(1, 1)], 1000);
    expect(result.threads[0]?.tasks).toEqual([
      { pid: 1, name: "node", cpuPercent: 100, memoryBytes: 1024 },
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("coalesces concurrent callers and preserves unavailable known hosts", async () => {
    let calls = 0;
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const read = createUsageReader({
      hosts: async () => [
        { id: "mac", name: "mac", status: "connected" },
        { id: "windows", name: "windows", status: "connected" },
        { id: "offline", name: "offline", status: "disconnected" },
        { id: "broken", name: "broken", status: "connected" },
      ],
      read: async (hostId) => {
        calls += 1;
        await gate;

        if (hostId === "broken") throw new Error("unreachable");

        return {
          hostName: hostId,
          system: emptySystemUsage(),
          coverage: hostId === "windows" ? "unsupported" : "complete",
          threads: [],
        };
      },
    });

    const first = read();
    const second = read();
    expect(first).toBe(second);
    release();
    expect(await first).toEqual({
      hosts: [
        {
          hostId: "mac",
          hostName: "mac",
          system: emptySystemUsage(),
          coverage: "complete",
          threads: [],
        },
        {
          hostId: "windows",
          hostName: "windows",
          system: emptySystemUsage(),
          coverage: "unsupported",
          threads: [],
        },
        {
          hostId: "offline",
          hostName: "offline",
          system: emptySystemUsage(),
          coverage: "failed",
          threads: [],
        },
        {
          hostId: "broken",
          hostName: "broken",
          system: emptySystemUsage(),
          coverage: "failed",
          threads: [],
        },
      ],
    });
    expect(calls).toBe(3);
    await read();
    expect(calls).toBe(6);
  });
});
