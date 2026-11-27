// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { ExperimentalComposerSelection } from "@omnyo/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedStateObserver,
  readExecutionSelection,
  readExecutionTuple,
  useQueuedComposerSelection,
} from "./composer-selection-settle";

interface State {
  version: number;
  isSettled: boolean;
}

describe("useQueuedComposerSelection", () => {
  afterEach(() => vi.useRealTimers());

  it("retains the queue across a rerender and starts the next deadline after rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let rejectFirst: (error: Error) => void = () => {};

    const firstResult = new Promise<ExperimentalComposerSelection>(
      (_, reject) => {
        rejectFirst = reject;
      },
    );

    type ApplySelection = Parameters<typeof useQueuedComposerSelection>[0];

    const firstApply = vi.fn<ApplySelection>(() => firstResult);
    const secondApply = vi.fn<ApplySelection>(async (selection) => selection);

    const { result, rerender } = renderHook(
      ({ apply }) => useQueuedComposerSelection(apply),
      {
        initialProps: { apply: firstApply },
      },
    );

    const first = result.current({ model: "first" });
    const rejection = expect(first).rejects.toThrow("selection refused");

    await Promise.resolve();
    expect(firstApply).toHaveBeenCalledWith({ model: "first" }, 16000);

    vi.setSystemTime(2000);
    rerender({ apply: secondApply });
    const second = result.current({ model: "second" });

    await Promise.resolve();
    expect(secondApply).not.toHaveBeenCalled();

    vi.setSystemTime(3000);
    rejectFirst(new Error("selection refused"));
    await rejection;
    await expect(second).resolves.toEqual({ model: "second" });
    expect(secondApply).toHaveBeenCalledWith({ model: "second" }, 18000);
  });
});

describe("createCommittedStateObserver", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves waiters as soon as a published state satisfies them", async () => {
    const observer = createCommittedStateObserver<State>();

    const settled = observer.waitUntil(
      (state) => state.version >= 2 && state.isSettled,
      Date.now() + 10_000,
    );

    observer.publish({ version: 1, isSettled: true });
    observer.publish({ version: 2, isSettled: false });
    observer.publish({ version: 2, isSettled: true });
    await expect(settled).resolves.toEqual({ version: 2, isSettled: true });
    await expect(
      observer.waitUntil((state) => state.version >= 1, Date.now() + 10_000),
    ).resolves.toEqual({ version: 2, isSettled: true });
  });

  it("resolves with the latest state once the deadline passes", async () => {
    vi.useFakeTimers();
    const observer = createCommittedStateObserver<State>();
    observer.publish({ version: 1, isSettled: false });

    const timedOut = observer.waitUntil(
      (state) => state.isSettled,
      Date.now() + 500,
    );

    observer.publish({ version: 2, isSettled: false });
    vi.advanceTimersByTime(499);
    let resolved = false;
    void timedOut.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(timedOut).resolves.toEqual({ version: 2, isSettled: false });
    observer.publish({ version: 3, isSettled: true });
    expect(resolved).toBe(true);
  });

  it("rejects a deadline that passes before any state was published", async () => {
    vi.useFakeTimers();
    const observer = createCommittedStateObserver<State>();
    const neverPublished = observer.waitUntil(() => true, Date.now() + 10);
    vi.advanceTimersByTime(10);
    await expect(neverPublished).rejects.toThrow(/not ready/);
  });
});

describe("readExecutionSelection", () => {
  it("omits empty selections and unsupported tiers", () => {
    expect(
      readExecutionSelection({
        selectedProviderId: "",
        selectedThreadModel: "",
        reasoningLevel: "medium",
        serviceTier: "fast",
        supportsServiceTier: false,
        permissionMode: "auto",
      }),
    ).toEqual({ reasoningLevel: "medium", permissionMode: "auto" });
    expect(
      readExecutionSelection({
        selectedProviderId: "codex",
        selectedThreadModel: "gpt-5",
        reasoningLevel: "high",
        serviceTier: "fast",
        supportsServiceTier: true,
        permissionMode: "full",
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "full",
    });
  });
});

describe("readExecutionTuple", () => {
  const providerIds = ["codex", "claude-code"];

  it("reads a full tuple for a listed provider and keeps an explicit tier", () => {
    expect(
      readExecutionTuple(
        {
          providerId: "claude-code",
          model: "claude-opus",
          reasoningLevel: "high",
          serviceTier: "fast",
          permissionMode: "full",
        },
        providerIds,
      ),
    ).toEqual({
      providerId: "claude-code",
      model: "claude-opus",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
    expect(
      readExecutionTuple(
        { providerId: "codex", model: "gpt-5", reasoningLevel: "low" },
        providerIds,
      ),
    ).toEqual({ providerId: "codex", model: "gpt-5", reasoningLevel: "low" });
  });

  it("leaves partial selections and unlisted providers to the step-wise path", () => {
    expect(
      readExecutionTuple({ providerId: "codex", model: "gpt-5" }, providerIds),
    ).toBeNull();
    expect(
      readExecutionTuple(
        { model: "gpt-5", reasoningLevel: "low" },
        providerIds,
      ),
    ).toBeNull();
    expect(
      readExecutionTuple(
        { providerId: "not-installed", model: "gpt-5", reasoningLevel: "low" },
        providerIds,
      ),
    ).toBeNull();
  });
});
