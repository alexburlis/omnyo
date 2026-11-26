import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerCodexAiService } from "./ai-service.js";
import type { CodexAiTextResult } from "./ai/host-contract.js";

function setup(
  answer: (call: ExperimentalFakeHostRpcCall) => CodexAiTextResult,
) {
  const { api, harness } = createFakePluginHost({
    sdk: { system: { config: async () => ({ primaryHostId: "host-1" }) } },
    experimental_callHostRpc: answer,
  });

  registerCodexAiService(api);
  const [service] = harness.registrations.aiServiceRegistrations;

  if (service?.complete === undefined) {
    throw new Error("Codex did not register a text inference service");
  }

  return {
    complete: service.complete,
    calls: harness.inspection.experimental_hostRpcCalls,
  };
}

function modelOf(call: ExperimentalFakeHostRpcCall): unknown {
  return (call.input as { model?: unknown }).model;
}

describe("Codex AI service", () => {
  it("retries with GPT-5.6 Luna after a rate limit", async () => {
    const codex = setup((call) =>
      modelOf(call) === "gpt-6-luna"
        ? { ok: false, code: "rate_limited", message: "Slow down" }
        : { ok: true, text: "Fix login bug" },
    );

    const signal = new AbortController().signal;

    await expect(codex.complete("Write a title", { signal })).resolves.toBe(
      "Fix login bug",
    );
    expect(codex.calls.map(modelOf)).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
    expect(codex.calls.map((call) => call.input)).toEqual([
      { model: "gpt-6-luna", prompt: "Write a title", timeoutMs: 5_000 },
      { model: "gpt-5.6-luna", prompt: "Write a title", timeoutMs: 5_000 },
    ]);
    expect(codex.calls.every((call) => call.signal === signal)).toBe(true);
  });

  it("stops at a failure another model cannot fix", async () => {
    const codex = setup(() => ({
      ok: false,
      code: "auth_required",
      message: "Run codex login",
    }));

    await expect(
      codex.complete("Write a title", {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Run codex login");
    expect(codex.calls).toHaveLength(1);
  });

  it("does not try the next model once Omnyo has cancelled", async () => {
    const controller = new AbortController();

    const codex = setup(() => {
      controller.abort();

      return { ok: false, code: "service_unavailable", message: "Overloaded" };
    });

    await expect(
      codex.complete("Write a title", { signal: controller.signal }),
    ).rejects.toThrow("Overloaded");
    expect(codex.calls).toHaveLength(1);
  });
});

it("registers text inference without a voice upload route", () => {
  const { api, harness } = createFakePluginHost({});

  registerCodexAiService(api);

  const [service] = harness.registrations.aiServiceRegistrations;
  expect(service?.complete).toBeTypeOf("function");
  expect(service?.transcribe).toBeUndefined();
});
