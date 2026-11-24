import { setImmediate } from "node:timers/promises";
import { vi } from "vitest";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { withTestHarness, type TestAppHarness } from "./test-app.js";

export function withChildThreadNotificationClock(
  run: (harness: TestAppHarness) => Promise<void>,
): Promise<void> {
  return withTestHarness(async (harness) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      await run(harness);
    } finally {
      vi.useRealTimers();
    }
  });
}

export async function flushChildThreadNotifications(
  harness: TestAppHarness,
): Promise<void> {
  await setImmediate();
  await vi.advanceTimersByTimeAsync(2_000);
  await runQueuedMessageDispatch(harness.deps, {
    kind: "time-reached",
    now: Date.now() + 2_000,
  });
}
