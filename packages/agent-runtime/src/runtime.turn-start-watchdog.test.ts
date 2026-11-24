import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@omnyo/domain";
import {
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  wait,
  type LaunchBoundAgentRuntime,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";
import { CompetingTurnError } from "./runtime.js";

describe("turn-start watchdog", () => {
  let tmpDir: string;
  let runtime: LaunchBoundAgentRuntime | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnyo-runtime-watchdog-"));
  });

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitFor<T>(
    resolve: () => T | undefined,
    timeoutMs = 3_000,
  ): Promise<T> {
    const deadline = performance.now() + timeoutMs;

    for (;;) {
      const value = resolve();

      if (value !== undefined) {
        return value;
      }

      if (performance.now() > deadline) {
        throw new Error("timed out waiting");
      }

      await wait(15);
    }
  }

  it("does not retain a watchdog timer while the runtime is idle", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    runtime = createScriptedEchoRuntime({
      runtime: { workspacePath: tmpDir, onEvent: () => {} },
    });

    expect(interval).not.toHaveBeenCalled();
  });

  it("surfaces a visible error when an accepted turn never starts", async () => {
    const events: ThreadEvent[] = [];
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const setInterval = vi.spyOn(globalThis, "setInterval");
    runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        turnStartWatchdog: { thresholdMs: 120, intervalMs: 25 },
      },
      launch: { scripted: { swallowTurnStart: true } },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222222w",
      threadId: "t1",
      input: [promptTextInput({ text: "hello" })],
      options: fullRuntimeOptions,
    });

    const watchdogEvent = await waitFor(() =>
      events.find(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_timeout",
      ),
    );

    expect(watchdogEvent.threadId).toBe("t1");
    expect(events.some((event) => event.type === "turn/started")).toBe(false);
    expect(clearInterval).toHaveBeenCalledWith(
      setInterval.mock.results[0]?.value,
    );
    expect(runtime.getLiveThreadIds()).toEqual(["t1"]);

    await wait(120);
    expect(
      events.filter(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_timeout",
      ),
    ).toHaveLength(1);
  });

  it.each(["stop", "rejection", "crash", "shutdown"] as const)(
    "releases the pending watchdog after %s",
    async (ending) => {
      const exited = vi.fn();
      runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: () => {},
          onProcessExit: exited,
          turnStartWatchdog: { thresholdMs: 120, intervalMs: 25 },
        },
        launch: {
          scripted: {
            swallowTurnStart: true,
            ...(ending === "rejection"
              ? { failMethods: [{ method: "turn/start", message: "declined" }] }
              : {}),
            ...(ending === "crash" ? { exitAfter: "turn/start" } : {}),
          },
        },
      });
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

      const started = runtime.runTurn({
        clientRequestId: "creq_222222222y",
        threadId: "t1",
        input: [promptTextInput({ text: "pending" })],
        options: fullRuntimeOptions,
      });

      if (ending === "rejection") {
        await expect(started).rejects.toThrow("declined");
      } else {
        await started;

        if (ending === "crash") {
          await waitFor(() => exited.mock.calls[0]);
          expect(exited).toHaveBeenCalledWith(
            expect.objectContaining({
              threads: [expect.objectContaining({ pendingTurnStart: true })],
            }),
          );
        } else {
          expect(vi.getTimerCount()).toBe(1);

          if (ending === "stop") await runtime.stopThread({ threadId: "t1" });
          else await runtime.shutdown();
        }
      }

      expect(vi.getTimerCount()).toBe(0);
      expect(runtime.getLiveThreadIds()).toEqual([]);
    },
  );

  it("keeps overlapping starts independent and rearms after reported starts settle", async () => {
    const events: ThreadEvent[] = [];
    runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        turnStartWatchdog: { thresholdMs: 120, intervalMs: 25 },
      },
      launch: { scripted: { swallowTurnStart: true } },
    });
    const activeRuntime = runtime;

    for (const threadId of ["t1", "t2", "t3"])
      await activeRuntime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });

    const start = (threadId: string) =>
      activeRuntime.runTurn({
        clientRequestId: "creq_222222222z",
        threadId,
        input: [promptTextInput({ text: "pending" })],
        options: fullRuntimeOptions,
      });

    const reported = () =>
      events
        .filter(
          (event) =>
            event.type === "system/error" &&
            event.code === "provider_turn_start_timeout",
        )
        .map((event) => event.threadId);

    await start("t1");
    vi.advanceTimersByTime(100);
    await start("t2");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(50);
    expect(reported()).toEqual(["t1"]);
    expect(vi.getTimerCount()).toBe(1);
    await activeRuntime.stopThread({ threadId: "t2" });
    expect(vi.getTimerCount()).toBe(0);
    expect(activeRuntime.getLiveThreadIds()).toEqual(["t1"]);
    await expect(start("t1")).rejects.toThrow(/active or starting/);
    await start("t3");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(150);
    expect(reported()).toEqual(["t1", "t3"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(activeRuntime.getLiveThreadIds()).toEqual(["t1", "t3"]);
  });

  it("stays silent when the turn starts within the threshold", async () => {
    const events: ThreadEvent[] = [];
    runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        turnStartWatchdog: { thresholdMs: 150, intervalMs: 25 },
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222222x",
      threadId: "t1",
      input: [promptTextInput({ text: "hello" })],
      options: fullRuntimeOptions,
    });

    await waitFor(() => events.find((event) => event.type === "turn/started"));
    await wait(250);
    expect(
      events.some(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_timeout",
      ),
    ).toBe(false);
  });

  it("keeps a turn start the provider never answered pending instead of failing it", async () => {
    const realSetTimeout = setTimeout;
    const record = createScriptedEchoRequestRecord();
    runtime = createScriptedEchoRuntime({
      runtime: { workspacePath: tmpDir, env: record.env, onEvent: () => {} },
      launch: {
        scripted: {
          swallowTurnStart: true,
          turnStartResponseDelayMs: 600_000,
        },
      },
    });
    const liveRuntime = runtime;

    await liveRuntime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });

    vi.useFakeTimers();

    try {
      const turnStart = liveRuntime.runTurn({
        clientRequestId: "creq_222222222u",
        threadId: "t1",
        input: [promptTextInput({ text: "hello" })],
        options: fullRuntimeOptions,
      });

      for (
        let attempt = 0;
        record.last("turn/start") === undefined;
        attempt += 1
      ) {
        if (attempt >= 1_000) {
          throw new Error("The bridge never received turn/start");
        }

        await new Promise((resolve) => realSetTimeout(resolve, 10));
      }

      await vi.advanceTimersByTimeAsync(30_001);

      await expect(turnStart).resolves.toEqual({ status: "unconfirmed" });
      expect(liveRuntime.getLiveThreadIds()).toEqual(["t1"]);
      await expect(
        liveRuntime.runTurn({
          clientRequestId: "creq_222222222v",
          threadId: "t1",
          input: [promptTextInput({ text: "competing" })],
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(CompetingTurnError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a timed-out turn start once the provider answers it with an error", async () => {
    const realSetTimeout = setTimeout;
    const events: ThreadEvent[] = [];
    const record = createScriptedEchoRequestRecord();
    runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: record.env,
        onEvent: (event) => events.push(event),
      },
      launch: { scripted: { turnStartErrorAfterMs: 1_500 } },
    });
    const liveRuntime = runtime;

    await liveRuntime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });

    vi.useFakeTimers();

    try {
      const turnStart = liveRuntime.runTurn({
        clientRequestId: "creq_222222222t",
        threadId: "t1",
        input: [promptTextInput({ text: "hello" })],
        options: fullRuntimeOptions,
      });

      for (
        let attempt = 0;
        record.last("turn/start") === undefined;
        attempt += 1
      ) {
        if (attempt >= 1_000) {
          throw new Error("The bridge never received turn/start");
        }

        await new Promise((resolve) => realSetTimeout(resolve, 10));
      }

      await vi.advanceTimersByTimeAsync(30_001);
      await expect(turnStart).resolves.toEqual({ status: "unconfirmed" });
    } finally {
      vi.useRealTimers();
    }

    const failure = await waitFor(() =>
      events.find(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_failed",
      ),
    );

    expect(failure).toMatchObject({
      threadId: "t1",
      scope: { kind: "thread" },
    });
    expect(liveRuntime.getLiveThreadIds()).toEqual([]);
  });
});
