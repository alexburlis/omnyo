import { hostDaemonOnlineRpcResponseMessageSchema } from "@omnyo/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { startIdleProviderSessionReaper } from "./app.js";

describe("idle provider housekeeping", () => {
  it.each([
    ["warning", 120_000],
    ["critical", 60_000],
  ] as const)(
    "shortens safe idle grace under %s memory pressure",
    async (level, idleForMs) => {
      let tick = () => {};

      const reapIdleProviderSessions = vi.fn(async () => ({
        reapedSessions: [],
        retainedSessions: [],
      }));

      const reaper = startIdleProviderSessionReaper({
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        nowMs: () => 1_000_000,
        readMemoryPressure: async () => ({ status: "observed", level }),
        runtimeManager: {
          reapIdleProviderSessions,
          recordHousekeepingStatus: vi.fn(),
        },
        setIntervalFn(callback) {
          tick = callback;

          return { clear() {}, unref() {} };
        },
      });

      try {
        tick();
        await vi.waitFor(() =>
          expect(reapIdleProviderSessions).toHaveBeenCalledWith({
            idleForMs,
            nowMs: 1_000_000,
          }),
        );
      } finally {
        reaper.stop();
      }
    },
  );
  it("reports a failed pressure read and keeps the normal grace", async () => {
    let tick = () => {};

    const recordHousekeepingStatus = vi.fn();

    const reapIdleProviderSessions = vi.fn(async () => ({
      reapedSessions: [],
      retainedSessions: [],
    }));

    const reaper = startIdleProviderSessionReaper({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => 1_000_000,
      readMemoryPressure: async () => {
        throw new Error("pressure read failed");
      },
      runtimeManager: { reapIdleProviderSessions, recordHousekeepingStatus },
      setIntervalFn(callback) {
        tick = callback;

        return { clear() {}, unref() {} };
      },
    });

    try {
      tick();
      await vi.waitFor(() =>
        expect(recordHousekeepingStatus).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "complete",
            memoryPressure: { status: "unavailable", reason: "read-failed" },
            idleGraceMs: 600_000,
          }),
        ),
      );
      expect(reapIdleProviderSessions).toHaveBeenCalledWith({
        idleForMs: 600_000,
        nowMs: 1_000_000,
      });
    } finally {
      reaper.stop();
    }
  });

  it("reports a failed cleanup as unknown instead of an empty result", async () => {
    let tick = () => {};

    const recordHousekeepingStatus = vi.fn();

    const reaper = startIdleProviderSessionReaper({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => 1_000_000,
      readMemoryPressure: async () => ({ status: "observed", level: "normal" }),
      runtimeManager: {
        recordHousekeepingStatus,
        reapIdleProviderSessions: async () => {
          throw new Error("cleanup failed");
        },
      },
      setIntervalFn(callback) {
        tick = callback;

        return { clear() {}, unref() {} };
      },
    });

    try {
      tick();
      await vi.waitFor(() =>
        expect(recordHousekeepingStatus).toHaveBeenCalledWith({
          status: "failed",
          checkedAt: 1_000_000,
          memoryPressure: { status: "observed", level: "normal" },
          idleGraceMs: 600_000,
        }),
      );
    } finally {
      reaper.stop();
    }
  });
  it("publishes a retained bridge with a valid wire snapshot", async () => {
    let tick = () => {};

    const recordHousekeepingStatus = vi.fn();

    const reaper = startIdleProviderSessionReaper({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => 1_000_000,
      readMemoryPressure: async () => ({
        status: "observed",
        level: "warning",
      }),
      runtimeManager: {
        recordHousekeepingStatus,
        reapIdleProviderSessions: async () => ({
          reapedSessions: [],
          retainedSessions: [
            {
              environmentId: "env-1",
              threadId: "thread-retained",
              providerId: "codex",
              processId: process.pid,
              reason: "background-work",
              idleForMs: 900_000,
            },
          ],
        }),
      },
      setIntervalFn(callback) {
        tick = callback;

        return { clear() {}, unref() {} };
      },
    });

    try {
      tick();
      await vi.waitFor(
        () => expect(recordHousekeepingStatus).toHaveBeenCalledOnce(),
        { timeout: 3_000 },
      );

      const frame = hostDaemonOnlineRpcResponseMessageSchema.parse({
        type: "host-rpc.response",
        commandType: "host.housekeeping.status",
        requestId: "snapshot-request",
        ok: true,
        result: recordHousekeepingStatus.mock.calls[0]?.[0],
      });

      expect(frame).toMatchObject({
        result: {
          status: "complete",
          retainedSessions: [
            expect.objectContaining({
              threadId: "thread-retained",
              processId: process.pid,
              reason: "background-work",
            }),
          ],
        },
      });
    } finally {
      reaper.stop();
    }
  });
});
