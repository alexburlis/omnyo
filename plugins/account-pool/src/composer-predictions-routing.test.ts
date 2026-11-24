import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { registerComposerPredictions } from "./composer-predictions.js";
import {
  NATIVE_PREDICTION_UNAVAILABLE,
  type ComposerPredictionConfiguration,
} from "./prediction-contract.js";

const configuration: ComposerPredictionConfiguration = {
  is_enabled: true,
  prompt: "Provider fixture prompt",
  prompt_version: "fixture-v1",
  prediction_reasoning_effort: "low",
};

const completion = {
  id: "event_completed",
  scope: "thread",
  threadId: "thr_codex",
  seq: 40,
  createdAt: 4,
  type: "turn/completed",
  data: {
    status: "completed",
    providerThreadId: "native_codex",
    providerCheckpointId: "turn_codex",
  },
};

const transcript = [
  {
    id: "event_request",
    scope: "thread",
    threadId: "thr_codex",
    seq: 10,
    createdAt: 1,
    type: "client/turn/requested",
    data: {
      requestId: "request_one",
      input: [{ type: "text", text: "Ship the routing repair." }],
    },
  },
  {
    id: "event_accepted",
    scope: "thread",
    threadId: "thr_codex",
    seq: 11,
    createdAt: 2,
    type: "turn/input/accepted",
    data: { clientRequestId: "request_one" },
  },
  {
    id: "event_answer",
    scope: "thread",
    threadId: "thr_codex",
    seq: 30,
    createdAt: 3,
    type: "item/completed",
    data: {
      item: {
        type: "agentMessage",
        text: "Live verification remains.",
        parentToolCallId: null,
      },
    },
  },
];

const loaded: ReturnType<typeof createFakePluginHost>[] = [];

afterEach(async () => {
  await Promise.all(loaded.splice(0).map((host) => host.harness.dispose()));
});

function setup(
  nativeFailure: string,
  backend: { backend: "codex" | "claude"; model?: string } = {
    backend: "codex",
  },
) {
  const hostCalls: {
    method: string;
    conversationContext?: string;
    force?: boolean;
    cliPath?: string;
    model?: string;
    route?: { baseUrl: string; capability: string };
  }[] = [];

  const host = createFakePluginHost({
    pluginId: "account-pool",
    appUrl: "https://omnyo.example.test",
    sdk: {
      threads: {
        get: async () => ({
          ...makeThreadResponse({
            id: "thr_codex",
            providerId: "codex",
            status: "idle",
          }),
          environment: { hostId: "host_source", path: "/work/source" },
        }),
        events: {
          list: async ({ types }: { types?: readonly string[] }) =>
            types?.includes("turn/completed")
              ? [completion]
              : transcript.filter((event) => types?.includes(event.type)),
        },
      },
      hosts: {
        get: async () =>
          makeHostResponse({ id: "host_source", status: "connected" }),
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      const call = z
        .object({
          conversationContext: z.string().optional(),
          force: z.boolean().optional(),
          cliPath: z.string().optional(),
          model: z.string().optional(),
          route: z
            .object({ baseUrl: z.string(), capability: z.string() })
            .optional(),
        })
        .parse(input);

      hostCalls.push({ method, ...call });

      if (call.conversationContext === undefined)
        throw new Error(nativeFailure);

      return {
        text: "Run the live check.",
        promptVersion: "fixture-v1",
        archiveReadiness: { ready: false, reason: "Verification remains." },
      };
    },
  });

  loaded.push(host);

  const revoke = vi.fn();

  const prepareComposerPrediction = vi.fn(
    async (
      _hostId: string,
      _nativeThreadId: string,
      _signal: AbortSignal,
      _assertSource: () => Promise<void>,
      _includedOnly: boolean,
      _force: boolean,
    ) => ({ capability: "fixture-capability", configuration, revoke }),
  );

  registerComposerPredictions(
    host.api,
    { prepareComposerPrediction },
    {
      isProviderEnabled: async () => true,
      isBypassed: async () => false,
    },
  );

  const predict = (force?: boolean, cliPath = "codex") =>
    host.harness.callRpc(
      "experimental_composer-predictions.v1.predict",
      {
        threadId: "thr_codex",
        requestId: "request_prediction",
        cliPath,
        includedOnly: false,
        ...(force === undefined ? {} : { force }),
        ...backend,
      },
      {
        experimental_caller: {
          kind: "plugin",
          pluginId: "omnyo--composer-predictions",
        },
      },
    );

  return {
    hostCalls,
    prepareComposerPrediction,
    revoke,
    predict,
  };
}

describe("Codex prediction routing", () => {
  it.each(["codex.cmd", "C:\\Program Files\\Codex\\codex.cmd"])(
    "accepts the Windows CLI shim %s",
    async (cliPath) => {
      const test = setup(NATIVE_PREDICTION_UNAVAILABLE);

      await expect(test.predict(false, cliPath)).resolves.toMatchObject({
        text: "Run the live check.",
      });
      expect(test.hostCalls.every((call) => call.cliPath === cliPath)).toBe(
        true,
      );
    },
  );

  it("predicts from the Omnyo transcript when the native Codex thread is unavailable", async () => {
    const test = setup(NATIVE_PREDICTION_UNAVAILABLE);

    await expect(test.predict()).resolves.toMatchObject({
      text: "Run the live check.",
    });
    expect(test.hostCalls).toHaveLength(2);
    expect(test.hostCalls[0]?.conversationContext).toBeUndefined();
    expect(test.hostCalls[1]?.conversationContext).toContain(
      "Ship the routing repair.",
    );
    expect(
      test.prepareComposerPrediction.mock.calls.map((call) => call[4]),
    ).toEqual([false, true]);
    expect(test.revoke).toHaveBeenCalledTimes(2);
  });

  it("forces both the native and transcript attempts when asked to", async () => {
    const test = setup(NATIVE_PREDICTION_UNAVAILABLE);

    await test.predict(true);

    expect(test.hostCalls.map((call) => call.force)).toEqual([true, true]);
    expect(
      test.prepareComposerPrediction.mock.calls.map((call) => call[5]),
    ).toEqual([true, true]);
  });

  it("leaves ordinary predictions unforced", async () => {
    const test = setup(NATIVE_PREDICTION_UNAVAILABLE);

    await test.predict();

    expect(test.hostCalls.map((call) => call.force)).toEqual([false, false]);
    expect(
      test.prepareComposerPrediction.mock.calls.map((call) => call[5]),
    ).toEqual([false, false]);
  });

  it("keeps other native failures visible without a transcript prediction", async () => {
    const test = setup(
      "Codex did not complete the prediction (status=failed, code=other).",
    );

    await expect(test.predict()).rejects.toThrow(
      "Codex did not complete the prediction",
    );
    expect(test.hostCalls).toHaveLength(1);
    expect(test.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("Claude prediction routing", () => {
  it("rejects the retired backend before running either provider", async () => {
    const test = setup(NATIVE_PREDICTION_UNAVAILABLE, {
      backend: "claude",
      model: "claude-haiku-5-5",
    });

    await expect(test.predict()).rejects.toThrow(
      "Claude predictions are unavailable. Account Pooler no longer uses Claude subscription credentials.",
    );
    expect(test.prepareComposerPrediction).not.toHaveBeenCalled();
    expect(test.hostCalls).toEqual([]);
  });
});
