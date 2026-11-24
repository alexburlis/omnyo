import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startHostDaemonLivenessMonitor } from "../src/host-daemon-liveness.js";

const machine = vi.hoisted(() => ({ load: 0.5, cpus: 14 }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  loadavg: () => [machine.load * machine.cpus, 0, 0],
  availableParallelism: () => machine.cpus,
}));

const monitors: ReturnType<typeof startHostDaemonLivenessMonitor>[] = [];

const recover = vi.fn();

const delayed = vi.fn();

const probe = vi.fn<typeof fetch>();

function watch() {
  const monitor = startHostDaemonLivenessMonitor({
    port: 38888,
    onUnresponsive: recover,
    onOverloadedDelay: delayed,
  });

  monitors.push(monitor);

  return monitor;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  recover.mockReset();
  delayed.mockReset();
  probe.mockReset();
  machine.load = 0.5;
  vi.stubGlobal("fetch", probe);
});

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["unavailable", "error status", "wrong health body"])(
  "recovers once after sustained local failure: %s",
  async (failure) => {
    if (failure === "unavailable")
      probe.mockRejectedValue(new Error("offline"));
    else
      probe.mockImplementation(
        async () =>
          new Response(failure === "wrong health body" ? "another app" : "ok", {
            status: failure === "error status" ? 503 : 200,
          }),
      );
    watch();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(recover).toHaveBeenCalledTimes(1);
  },
);

function answerAfter(delayMs: number | null): typeof fetch {
  return (_url, options) =>
    new Promise((resolve, reject) => {
      const timer =
        delayMs === null
          ? undefined
          : setTimeout(() => resolve(new Response("ok")), delayMs);

      options?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
}

it("keeps a busy daemon alive when every health answer arrives late", async () => {
  probe.mockImplementation(answerAfter(7_000));
  watch();

  await vi.advanceTimersByTimeAsync(180_000);
  expect(recover).not.toHaveBeenCalled();
});

it("recovers a daemon whose health request never answers", async () => {
  probe.mockImplementation(answerAfter(null));
  watch();

  await vi.advanceTimersByTimeAsync(59_999);
  expect(recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(40_001);
  expect(recover).toHaveBeenCalledTimes(1);
});

it("keeps a locally healthy worker alive when coordinator status is disconnected", async () => {
  probe.mockImplementation(
    async (url) =>
      new Response(
        String(url).endsWith("/health")
          ? "ok"
          : JSON.stringify({ connected: false, hostId: "worker" }),
      ),
  );
  watch();

  await vi.advanceTimersByTimeAsync(180_000);
  expect(recover).not.toHaveBeenCalled();
});

it("starts a fresh failure window after a successful local response", async () => {
  let healthy = false;
  probe.mockImplementation(
    async () => new Response(healthy ? "ok" : "invalid"),
  );
  watch();

  await vi.advanceTimersByTimeAsync(40_000);
  healthy = true;
  await vi.advanceTimersByTimeAsync(10_000);
  healthy = false;
  await vi.advanceTimersByTimeAsync(50_000);
  expect(recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(recover).toHaveBeenCalledTimes(1);
});

it("discards a failure streak after a delayed parent timer", async () => {
  probe.mockRejectedValue(new Error("unavailable"));
  watch();
  await vi.advanceTimersByTimeAsync(40_000);

  vi.setSystemTime(Date.now() + 3_600_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(recover).toHaveBeenCalledTimes(1);
});

it("discards a probe failure whose completion spans a parent pause", async () => {
  let complete: (response: Response) => void = () => {};

  probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  probe.mockRejectedValue(new Error("unavailable"));
  watch();
  await vi.advanceTimersByTimeAsync(10_000);

  vi.setSystemTime(Date.now() + 3_600_000);
  complete(new Response("invalid"));
  await vi.advanceTimersByTimeAsync(50_000);
  expect(recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(recover).toHaveBeenCalledTimes(1);
});

it("cancels an in-flight probe and prevents recovery after intentional stop", async () => {
  let requestSignal: AbortSignal | undefined;
  probe.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        requestSignal = options?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () =>
          reject(new Error("stopped")),
        );
      }),
  );
  const monitor = watch();
  await vi.advanceTimersByTimeAsync(10_000);
  monitor.stop();

  expect(requestSignal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(recover).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for a starved daemon on an overloaded machine, then recovers after ten minutes", async () => {
  machine.load = 23;
  probe.mockImplementation(answerAfter(null));
  watch();

  await vi.advanceTimersByTimeAsync(100_000);
  expect(recover).not.toHaveBeenCalled();
  expect(delayed).toHaveBeenCalledTimes(1);
  expect(delayed.mock.calls[0]?.[1]).toBe(23);

  await vi.advanceTimersByTimeAsync(480_000);
  expect(recover).not.toHaveBeenCalled();
  expect(delayed).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(40_000);
  expect(recover).toHaveBeenCalledTimes(1);
});

it("recovers a waiting daemon as soon as the machine is no longer overloaded", async () => {
  machine.load = 23;
  probe.mockRejectedValue(new Error("unavailable"));
  watch();

  await vi.advanceTimersByTimeAsync(80_000);
  expect(delayed).toHaveBeenCalledTimes(1);
  expect(recover).not.toHaveBeenCalled();

  machine.load = 1.5;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(recover).toHaveBeenCalledTimes(1);
});
