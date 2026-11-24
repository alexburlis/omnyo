import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPluginRpcCallerSdk } from "./plugin-rpc-caller.js";

const callerValue = "synthetic-plugin-caller";

describe("plugin RPC request deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        timeoutMs,
      );

      return controller.signal;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function request(signal?: AbortSignal) {
    return createPluginRpcCallerSdk({
      baseUrl: "http://server",
      token: callerValue,
    }).plugins.callRpc({
      pluginId: "prediction-fixture",
      method: "predict",
      input: null,
      outputSchema: z.literal("ready"),
      signal,
    });
  }

  function respondAfter(delayMs: number | null) {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      expect(new Headers(init?.headers).get("x-omnyo-plugin-caller")).toBe(
        callerValue,
      );

      return new Promise<Response>((resolve, reject) => {
        const timer =
          delayMs === null
            ? null
            : setTimeout(
                () =>
                  resolve(
                    new Response(JSON.stringify({ ok: true, result: "ready" })),
                  ),
                delayMs,
              );

        const abort = () => {
          if (timer !== null) clearTimeout(timer);
          reject(init?.signal?.reason);
        };

        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });
  }

  it("allows a bounded RPC response beyond the ordinary SDK request deadline", async () => {
    respondAfter(90_000);

    const response = request(AbortSignal.timeout(240_000)).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );

    await vi.advanceTimersByTimeAsync(90_000);
    expect(await response).toEqual({ result: "ready" });
  });

  it("preserves the caller's earlier cancellation", async () => {
    respondAfter(null);
    const controller = new AbortController();

    const response = expect(request(controller.signal)).rejects.toThrow(
      "Caller canceled",
    );

    controller.abort(new Error("Caller canceled"));
    await response;
  });

  it("retains a finite deadline when a caller does not provide one", async () => {
    respondAfter(null);
    const response = request().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(await response).toMatchObject({
      name: "OmnyoRequestTimeoutError",
      message: "Omnyo request timed out after 300 seconds.",
    });
  });
});
