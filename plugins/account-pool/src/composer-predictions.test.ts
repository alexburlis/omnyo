import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  experimental_threadIndicatorCases,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { registerComposerPredictions } from "./composer-predictions.js";
import type { AccountPoolHub } from "./hub.js";

const predict = "experimental_composer-predictions.v1.predict";

const cancel = "experimental_composer-predictions.v1.cancel";

const threadId = "thr_one";

const requestId = "request_one";

const hostId = "host_remote";

const caller = {
  experimental_caller: {
    kind: "plugin" as const,
    pluginId: "omnyo--composer-predictions",
  },
};

const outcome = {
  noSuggestionReason: null,
  text: "Run the live check.",
  promptVersion: "omnyo-codex-pool-1",
  archiveReadiness: {
    ready: false,
    reason: "Verification remains.",
    ask: null,
    recap: null,
    waitingOn: null,
  },
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dispose) => dispose()));
});

function setup(
  options: {
    providerId?: string;
    pending?: boolean;
    stall?: boolean;
    routing?: boolean;
  } = {},
) {
  const work = experimental_threadIndicatorCases.find(
    ({ state }) => state.work?.primary.label === "open",
  )?.state.work;

  if (!work) throw new Error("Work fixture missing");

  const source = {
    completion: {
      type: "turn/completed",
      seq: 9,
      data: { status: "completed" },
    },
    thread: {
      ...makeThreadResponse({
        id: threadId,
        providerId: options.providerId ?? "codex",
        work: { ...work, basis: "basis-9" },
      }),
      environment: { hostId, path: "/source" },
    },
  };

  let resolve: () => void = () => {};

  const result = new Promise<void>((accept) => {
    resolve = accept;
  });

  const host = createFakePluginHost({
    pluginId: "account-pool",
    appUrl: null,
    sdk: {
      threads: {
        get: async () =>
          options.stall ? new Promise(() => {}) : source.thread,
        events: {
          list: async ({ types }: { types?: readonly string[] }) =>
            types?.includes("turn/completed")
              ? [source.completion]
              : [
                  {
                    type: "client/turn/requested",
                    seq: 1,
                    data: {
                      requestId: "user-input",
                      input: [{ type: "text", text: "Ship the repair." }],
                    },
                  },
                  {
                    type: "turn/input/accepted",
                    seq: 2,
                    data: { clientRequestId: "user-input" },
                  },
                  {
                    type: "item/completed",
                    seq: 8,
                    data: {
                      item: {
                        type: "agentMessage",
                        text: "Verification remains.",
                      },
                    },
                  },
                ],
        },
      },
      hosts: {
        get: async () => makeHostResponse({ id: hostId, status: "connected" }),
      },
    },
  });

  const completePrediction = vi.fn<AccountPoolHub["completePrediction"]>(
    async (_input, _schema, _signal, validateSource) => {
      await validateSource();

      if (options.pending) await result;

      return JSON.stringify({
        suggestion: outcome.text,
        noSuggestionReason: null,
        archiveReadiness: outcome.archiveReadiness,
      });
    },
  );

  const isProviderEnabled = vi.fn(async () => options.routing ?? true);
  registerComposerPredictions(
    host.api,
    { completePrediction },
    { isProviderEnabled },
  );
  const { harness } = host;
  cleanups.push(() => harness.dispose());
  const input = { threadId, requestId, sourceSeq: 9, basis: "basis-9" };
  const calls = completePrediction.mock.calls;

  return {
    source,
    calls,
    resolve,
    harness,
    isProviderEnabled,
    request: (force = false) =>
      harness.callRpc(predict, { ...input, force }, caller),
    stop: () => harness.callRpc(cancel, { threadId, requestId }, caller),
  };
}

describe("Composer prediction RPC", () => {
  it.each(["codex", "claude-code", "acp"])(
    "sends one bounded %s transcript through Codex pool routing without native IDs",
    async (providerId) => {
      const test = setup({ providerId });
      await expect(test.request(true)).resolves.toMatchObject(outcome);
      expect(test.calls).toHaveLength(1);
      expect(test.calls[0]?.[0]).toMatchObject({
        hostId,
        model: "gpt-6.1-sol",
        prompt: expect.stringContaining("Ship the repair."),
      });
      expect(test.calls[0]?.[1]).toMatchObject({
        properties: { suggestion: { type: "string" } },
      });
      expect(test.isProviderEnabled).toHaveBeenCalledWith("codex");
    },
  );

  it("does not dispatch from a Claude chat when Codex pool routing is disabled", async () => {
    const test = setup({ providerId: "claude-code", routing: false });
    await expect(test.request()).rejects.toThrow("Enable Codex routing");
    expect(test.calls).toHaveLength(0);
  });

  it("rejects a different caller or stale basis before using the pool", async () => {
    const test = setup();
    const input = { threadId, requestId, sourceSeq: 9, basis: "wrong" };
    await expect(test.harness.callRpc(predict, input)).rejects.toThrow(
      "not authorized",
    );
    await expect(test.harness.callRpc(predict, input, caller)).rejects.toThrow(
      "source changed",
    );
    expect(test.calls).toHaveLength(0);
  });

  it("deduplicates one active request", async () => {
    const test = setup({ pending: true });
    const first = test.request();
    const second = test.request();
    await vi.waitFor(() => expect(test.calls).toHaveLength(1));
    test.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining(outcome),
      expect.objectContaining(outcome),
    ]);
  });

  it.each(["explicit cancellation", "thread.active"] as const)(
    "handles %s during stalled metadata",
    async (event) => {
      const test = setup({ stall: true });

      const result = expect(test.request()).rejects.toThrow(
        "Prediction canceled",
      );

      await vi.waitFor(() =>
        expect(test.harness.sdk.callsTo("threads.get")).toHaveLength(1),
      );

      if (event === "explicit cancellation") await test.stop();
      else
        await test.harness.emitThreadEvent(event, {
          thread: test.source.thread,
        });

      await result;
      expect(test.calls).toHaveLength(0);
    },
  );

  it("remembers cancellation before prediction registration", async () => {
    const test = setup();
    await test.stop();
    await expect(test.request()).rejects.toThrow("Prediction canceled");
    expect(test.calls).toHaveLength(0);
  });

  it.each(["explicit cancellation", "new source"] as const)(
    "rejects late prediction output after %s",
    async (reason) => {
      const test = setup({ pending: true });

      const result = expect(test.request()).rejects.toThrow(
        /Prediction (canceled|source changed)/u,
      );

      await vi.waitFor(() => expect(test.calls).toHaveLength(1));

      if (reason === "explicit cancellation") await test.stop();
      else test.source.completion.seq += 1;

      test.resolve();
      await result;
      expect(test.calls[0]?.[2].aborted).toBe(true);
    },
  );
});
