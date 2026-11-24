import { beforeEach, describe, expect, it, vi } from "vitest";
import { performance as nodePerformance } from "node:perf_hooks";
import {
  currentEventLoopWorkLabel,
  resetEventLoopWorkForTests,
  runEventLoopWork,
  runEventLoopWorkSync,
  takeEventLoopWorkWindowSnapshot,
} from "../../src/services/system/event-loop-work.js";

const EMPTY_WORK_SNAPSHOT = {
  inFlightWorkAtObservation: null,
  lastCompletedWork: null,
  lastCompletedWorkWallMs: null,
  longestSynchronousWork: null,
  longestSynchronousWorkWallMs: null,
  longestSynchronousWorkCpuMs: null,
};

describe("event loop work snapshots", () => {
  beforeEach(resetEventLoopWorkForTests);

  it.each([0, 650])(
    "keeps the first synchronous completion tied at %s ms and resets its window",
    (durationMs) => {
      const nowSpy = vi.spyOn(nodePerformance, "now");
      const cpuSpy = vi.spyOn(process, "threadCpuUsage");

      try {
        nowSpy
          .mockReturnValueOnce(0)
          .mockReturnValueOnce(durationMs)
          .mockReturnValueOnce(1_000)
          .mockReturnValueOnce(1_000 + durationMs);
        cpuSpy
          .mockReturnValueOnce({ user: 0, system: 0 })
          .mockReturnValueOnce({ user: 2_000, system: 0 })
          .mockReturnValueOnce({ user: 0, system: 0 })
          .mockReturnValueOnce({ user: 3_000, system: 0 });
        runEventLoopWorkSync("first", () => undefined);
        runEventLoopWorkSync("second", () => undefined);

        expect(takeEventLoopWorkWindowSnapshot()).toEqual({
          inFlightWorkAtObservation: null,
          lastCompletedWork: "second",
          lastCompletedWorkWallMs: durationMs,
          longestSynchronousWork: "first",
          longestSynchronousWorkWallMs: durationMs,
          longestSynchronousWorkCpuMs: 2,
        });
        expect(takeEventLoopWorkWindowSnapshot()).toEqual({
          ...EMPTY_WORK_SNAPSHOT,
          lastCompletedWork: "second",
          lastCompletedWorkWallMs: durationMs,
        });
      } finally {
        nowSpy.mockRestore();
        cpuSpy.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "retains failed synchronous work after longer async completion (rejects=%s)",
    async (rejects) => {
      const nowSpy = vi.spyOn(nodePerformance, "now");
      const cpuSpy = vi.spyOn(process, "threadCpuUsage");
      const failure = new Error("work failed");

      try {
        nowSpy
          .mockReturnValueOnce(0)
          .mockReturnValueOnce(7)
          .mockReturnValueOnce(10)
          .mockReturnValueOnce(1_010);
        cpuSpy
          .mockReturnValueOnce({ user: 0, system: 0 })
          .mockReturnValueOnce({ user: 2_000, system: 1_000 });
        expect(() =>
          runEventLoopWorkSync("failed sync", () => {
            throw failure;
          }),
        ).toThrow(failure);

        const completion = runEventLoopWork("async", () =>
          rejects ? Promise.reject(failure) : Promise.resolve("finished"),
        );

        if (rejects) await expect(completion).rejects.toBe(failure);
        else await expect(completion).resolves.toBe("finished");

        expect(takeEventLoopWorkWindowSnapshot()).toEqual({
          inFlightWorkAtObservation: null,
          lastCompletedWork: "async",
          lastCompletedWorkWallMs: 1_000,
          longestSynchronousWork: "failed sync",
          longestSynchronousWorkWallMs: 7,
          longestSynchronousWorkCpuMs: 3,
        });
      } finally {
        nowSpy.mockRestore();
        cpuSpy.mockRestore();
      }
    },
  );

  it("names the work running on the current call stack", async () => {
    expect(currentEventLoopWorkLabel()).toBeNull();
    expect(
      runEventLoopWorkSync("sweep:retention", () =>
        runEventLoopWorkSync("plugin:storage delete", () =>
          currentEventLoopWorkLabel(),
        ),
      ),
    ).toBe("sweep:retention > plugin:storage delete");
    await expect(
      runEventLoopWork("GET /api/v1/threads/search", async () => {
        await Promise.resolve();

        return currentEventLoopWorkLabel();
      }),
    ).resolves.toBe("GET /api/v1/threads/search");
    expect(currentEventLoopWorkLabel()).toBeNull();
  });
});
