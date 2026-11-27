import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { registerWorkflowModelService } from "./workflow-model-service.js";
import { experimental_workflowModelV1 } from "@omnyo/plugin-sdk/workflow-model";

const { inputSchema: workflowModelInputSchema } = experimental_workflowModelV1;

const input = {
  hostId: "host-1",
  attemptId: "attempt-1",
  model: "gpt-6-luna",
  prompt: "Write a draft",
  timeoutMs: 1000,
  maxOutputBytes: 1024,
};

const principal = {
  experimental_caller: { kind: "plugin", pluginId: "state-machines" },
} as const;

describe("restricted workflow provider", () => {
  it("rejects untrusted callers before dispatch and delegates the selected model with real caller identity", async () => {
    const { api, harness } = createFakePluginHost();

    const call = vi.fn(async (request: { method: string }) =>
      request.method === "workflowModelCapabilities"
        ? { available: true }
        : { ok: true, attemptId: input.attemptId, text: "draft" },
    );

    harness.sdk.stub("plugins.callRpc", call);
    registerWorkflowModelService(api);

    for (const options of [
      {},
      { experimental_caller: { kind: "plugin", pluginId: "other" } } as const,
    ]) {
      await expect(
        harness.callRpc("workflowModelComplete", input, options),
      ).resolves.toMatchObject({ ok: false, code: "caller_not_allowed" });
      await expect(
        harness.callRpc(
          "workflowModelCapabilities",
          { hostId: input.hostId, model: input.model },
          options,
        ),
      ).resolves.toMatchObject({
        available: false,
        code: "caller_not_allowed",
      });
    }

    expect(call).not.toHaveBeenCalled();
    await expect(
      harness.callRpc(
        "workflowModelCapabilities",
        { hostId: input.hostId, model: input.model },
        principal,
      ),
    ).resolves.toEqual({ available: true });
    await expect(
      harness.callRpc("workflowModelComplete", input, principal),
    ).resolves.toEqual({ ok: true, attemptId: input.attemptId, text: "draft" });
    expect(call.mock.calls[1]?.[0]).toMatchObject({
      pluginId: "account-pool",
      input: { ...input, providerId: "codex" },
    });
  });
  it.each([
    "tools",
    "apiKey",
    "fallbackModel",
    "experimental_caller",
    "providerId",
    "headers",
  ])("rejects injected %s", async (key) => {
    const { api, harness } = createFakePluginHost();
    registerWorkflowModelService(api);
    await expect(
      harness.callRpc(
        "workflowModelComplete",
        { ...input, [key]: "attacker" },
        principal,
      ),
    ).rejects.toThrow();
  });
  it.each([
    { prompt: "é".repeat(128 * 1024) },
    { timeoutMs: 60001 },
    { maxOutputBytes: 65537 },
    { model: "https://attacker.invalid" },
  ])("rejects invalid limits", (change) => {
    expect(
      workflowModelInputSchema.safeParse({ ...input, ...change }).success,
    ).toBe(false);
  });
});
