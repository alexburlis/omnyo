import { describe, expect, it, vi } from "vitest";
import type { WindowsHostJob } from "@omnyo/process-utils";
import {
  AGENT_MEMORY_LIMIT_ENV,
  createAgentProcessContainment,
  resolveAgentMemoryLimit,
} from "./agent-process-containment.js";

const GIB = 1024 * 1024 * 1024;

function logger() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function fakeJob(): WindowsHostJob & {
  adopted: number[];
  finish: () => void;
} {
  let finish: () => void = () => undefined;

  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const adopted: number[] = [];

  return {
    adopted,
    finish,
    closed,
    adopt: async (pid) => {
      adopted.push(pid);
    },
    close: () => finish(),
    terminate: async () => adopted.splice(0).length,
    status: async () => ({
      active: adopted.length,
      adoptedDescendants: 0,
      jobMemoryLimitBytes: 0,
      peakJobMemoryBytes: 0,
      pids: adopted,
      unadoptable: 0,
    }),
  };
}

describe("agent memory limit", () => {
  it("defaults to half of physical memory", () => {
    expect(
      resolveAgentMemoryLimit({ env: {}, totalMemoryBytes: 32 * GIB }),
    ).toEqual({ kind: "bytes", bytes: 16 * GIB, source: "default" });
  });

  it("accepts an explicit MiB limit and off", () => {
    expect(
      resolveAgentMemoryLimit({
        env: { [AGENT_MEMORY_LIMIT_ENV]: "24576" },
        totalMemoryBytes: 32 * GIB,
      }),
    ).toEqual({ kind: "bytes", bytes: 24 * GIB, source: "env" });
    expect(
      resolveAgentMemoryLimit({
        env: { [AGENT_MEMORY_LIMIT_ENV]: "OFF" },
        totalMemoryBytes: 32 * GIB,
      }),
    ).toEqual({ kind: "off" });
  });

  it("rejects malformed and tiny limits", () => {
    for (const value of ["12GB", "-1", "100"]) {
      expect(() =>
        resolveAgentMemoryLimit({
          env: { [AGENT_MEMORY_LIMIT_ENV]: value },
          totalMemoryBytes: 32 * GIB,
        }),
      ).toThrow(AGENT_MEMORY_LIMIT_ENV);
    }
  });
});

describe("agent process containment", () => {
  it("does nothing outside Windows", () => {
    expect(
      createAgentProcessContainment({ logger: logger(), platform: "darwin" }),
    ).toBeUndefined();
  });

  it("starts one host job with the limit and adopts each provider", async () => {
    const job = fakeJob();
    const startJob = vi.fn(async () => job);

    const containment = createAgentProcessContainment({
      env: {},
      logger: logger(),
      platform: "win32",
      startJob,
      totalMemoryBytes: 32 * GIB,
    });

    await containment?.contain(101);
    await containment?.contain(202);

    expect(startJob).toHaveBeenCalledTimes(1);
    expect(startJob).toHaveBeenCalledWith({ memoryLimitBytes: 16 * GIB });
    expect(job.adopted).toEqual([101, 202]);
  });

  it("ends every contained process on terminate and keeps the job usable", async () => {
    const job = fakeJob();

    const containment = createAgentProcessContainment({
      env: {},
      logger: logger(),
      platform: "win32",
      startJob: vi.fn(async () => job),
      totalMemoryBytes: 32 * GIB,
    });

    await containment?.contain(101);
    await containment?.contain(202);

    expect(await containment?.terminate()).toBe(2);
    expect(job.adopted).toEqual([]);

    await containment?.contain(303);
    expect(job.adopted).toEqual([303]);
  });

  it("reports nothing to terminate while the job is still starting", async () => {
    const containment = createAgentProcessContainment({
      env: {},
      logger: logger(),
      platform: "win32",
      startJob: () => new Promise<never>(() => undefined),
      totalMemoryBytes: 32 * GIB,
    });

    expect(await containment?.terminate()).toBe(0);
  });

  it("rejects provider starts while the limit is invalid", async () => {
    const startJob = vi.fn();

    const containment = createAgentProcessContainment({
      env: { [AGENT_MEMORY_LIMIT_ENV]: "lots" },
      logger: logger(),
      platform: "win32",
      startJob,
    });

    await expect(containment?.contain(1)).rejects.toThrow(
      AGENT_MEMORY_LIMIT_ENV,
    );
    expect(startJob).not.toHaveBeenCalled();
  });

  it("retries a failed start and replaces an exited helper", async () => {
    const replacement = fakeJob();
    const first = fakeJob();

    const startJob = vi
      .fn<() => Promise<WindowsHostJob>>()
      .mockRejectedValueOnce(new Error("powershell missing"))
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement);

    const log = logger();

    const containment = createAgentProcessContainment({
      env: {},
      logger: log,
      platform: "win32",
      startJob,
      totalMemoryBytes: 8 * GIB,
    });

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    await containment?.contain(7);
    expect(first.adopted).toEqual([7]);

    first.finish();
    await vi.waitFor(async () => {
      await containment?.contain(8);
      expect(replacement.adopted).toEqual([8]);
    });
    expect(startJob).toHaveBeenCalledTimes(3);
  });
});
