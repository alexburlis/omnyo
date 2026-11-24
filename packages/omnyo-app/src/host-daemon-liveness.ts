import { availableParallelism, loadavg } from "node:os";
import {
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
  DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
  DEFAULT_HOST_DAEMON_LOCAL_HEALTH_VALUE,
} from "@omnyo/host-daemon-contract";

const PROBE_INTERVAL_MS = 10_000;

const PROBE_TIMEOUT_MS = 30_000;

const UNRESPONSIVE_TIMEOUT_MS = 60_000;

const OVERLOADED_LOAD_PER_CPU = 2;

const OVERLOADED_UNRESPONSIVE_LIMIT_MS = 600_000;

interface HostDaemonLivenessMonitorArgs {
  port: number;
  onUnresponsive: (unresponsiveForMs: number) => void;
  onOverloadedDelay: (unresponsiveForMs: number, loadPerCpu: number) => void;
}

function systemLoadPerCpu(): number {
  return (loadavg()[0] ?? 0) / Math.max(1, availableParallelism());
}

export function startHostDaemonLivenessMonitor(
  args: HostDaemonLivenessMonitorArgs,
) {
  const healthUrl = `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${args.port}${DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH}`;
  let lastHealthyAt = performance.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let activeRequest: AbortController | null = null;
  let overloadReported = false;

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    activeRequest?.abort();
  }

  async function check(expectedAt: number): Promise<void> {
    if (stopped) return;

    if (Date.now() - expectedAt > PROBE_INTERVAL_MS) {
      lastHealthyAt = performance.now();
    }

    const startedAt = Date.now();
    const request = new AbortController();
    activeRequest = request;
    const timeout = setTimeout(() => request.abort(), PROBE_TIMEOUT_MS);
    timeout.unref();
    let healthy = false;

    try {
      const response = await fetch(healthUrl, { signal: request.signal });
      healthy =
        response.ok &&
        (await response.text()) === DEFAULT_HOST_DAEMON_LOCAL_HEALTH_VALUE;
    } catch {
      healthy = false;
    } finally {
      clearTimeout(timeout);
      activeRequest = null;
    }

    if (stopped) return;

    if (
      healthy ||
      Date.now() - startedAt > PROBE_TIMEOUT_MS + PROBE_INTERVAL_MS
    ) {
      lastHealthyAt = performance.now();
    }

    const unresponsiveForMs = performance.now() - lastHealthyAt;

    if (unresponsiveForMs < UNRESPONSIVE_TIMEOUT_MS) {
      overloadReported = false;
      schedule();

      return;
    }

    const loadPerCpu = systemLoadPerCpu();

    if (
      loadPerCpu >= OVERLOADED_LOAD_PER_CPU &&
      unresponsiveForMs < OVERLOADED_UNRESPONSIVE_LIMIT_MS
    ) {
      if (!overloadReported) {
        overloadReported = true;
        args.onOverloadedDelay(unresponsiveForMs, loadPerCpu);
      }

      schedule();

      return;
    }

    stop();
    args.onUnresponsive(unresponsiveForMs);
  }

  function schedule(): void {
    const expectedAt = Date.now() + PROBE_INTERVAL_MS;
    timer = setTimeout(() => {
      void check(expectedAt);
    }, PROBE_INTERVAL_MS);
    timer.unref();
  }

  schedule();

  return { stop };
}
