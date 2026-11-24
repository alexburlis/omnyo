// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadGate() {
  vi.resetModules();

  return import("./startup-settled");
}

describe("start-up settling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles once the browser is idle after the first chat rows render", async () => {
    const idle: IdleRequestCallback[] = [];

    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => idle.push(callback)),
    );

    const gate = await loadGate();
    const listener = vi.fn();

    gate.subscribeStartupSettled(listener);
    gate.markStartupChatRendered();
    gate.markStartupChatRendered();

    expect(gate.isStartupSettled()).toBe(false);
    expect(idle).toHaveLength(1);

    idle[0]?.({ didTimeout: false, timeRemaining: () => 10 });

    expect(gate.isStartupSettled()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles at the cap when no chat renders", async () => {
    const gate = await loadGate();
    const listener = vi.fn();

    gate.subscribeStartupSettled(listener);
    vi.advanceTimersByTime(gate.STARTUP_SETTLE_CAP_MS - 1);

    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(gate.isStartupSettled()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not notify a listener that unsubscribed", async () => {
    const gate = await loadGate();
    const listener = vi.fn();

    const unsubscribe = gate.subscribeStartupSettled(listener);

    unsubscribe();
    vi.advanceTimersByTime(gate.STARTUP_SETTLE_CAP_MS);

    expect(gate.isStartupSettled()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
