import { afterEach, expect, test } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { createImportedTextRunner } from "../src/imported/provider.js";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

type ModelResult =
  | { ok: true; attemptId: string; text: string }
  | { ok: false; attemptId: string; code: string; message: string };

function setup(result: ModelResult = { ok: true, attemptId: "attempt", text: "Model response" }) {
  const requests: { pluginId: string; method: string; input?: unknown }[] = [];

  const host = createFakePluginHost({
    pluginId: "state-machines",
    sdk: {
      plugins: {
        callRpc(request) {
          requests.push(request);

          return request.method === "workflowModelCapabilities" ? { available: true } : result;
        },
      },
    },
  });

  hosts.push(host);

  return { runner: createImportedTextRunner(host.api), requests };
}

const request = {
  requestId: "attempt",
  binding: { hostId: "host", providerId: "codex", model: "selected-model" },
  prompt: "Write a short answer.",
  assets: { skills: [], inputs: {} },
  signal: new AbortController().signal,
};

test.each([
  ["codex", "provider-codex"],
  ["claude-code", "provider-claude-code"],
])("routes %s to the explicitly selected subscription model", async (providerId, pluginId) => {
  const { runner, requests } = setup();
  const binding = { ...request.binding, providerId };
  expect(await runner.preflight?.(binding)).toEqual({ available: true });
  expect(await runner.run({ ...request, binding })).toBe("Model response");
  expect(requests).toEqual([
    {
      pluginId,
      method: "workflowModelCapabilities",
      input: { hostId: "host", model: "selected-model" },
      outputSchema: expect.anything(),
    },
    {
      pluginId,
      method: "workflowModelComplete",
      input: {
        hostId: "host",
        attemptId: "attempt",
        model: "selected-model",
        prompt: expect.any(String),
        timeoutMs: 60000,
        maxOutputBytes: 65536,
      },
      outputSchema: expect.anything(),
      signal: request.signal,
    },
  ]);
});

test.each(["apple-foundation", "unknown", "claude"])(
  "refuses %s without contacting any provider",
  async (providerId) => {
    const { runner, requests } = setup();
    const binding = { ...request.binding, providerId };
    expect(await runner.preflight?.(binding)).toMatchObject({
      available: false,
      code: "unsupported_provider",
    });
    await expect(runner.run({ ...request, binding })).rejects.toThrow(
      "connected Codex or Claude Code",
    );
    expect(requests).toEqual([]);
  },
);

test("provider failures never fall back to another provider", async () => {
  const { runner, requests } = setup({
    ok: false,
    attemptId: "attempt",
    code: "request_failed",
    message: "Subscription disconnected",
  });

  await expect(runner.run(request)).rejects.toThrow("Subscription disconnected");
  expect(requests).toHaveLength(1);
});

test("response identity mismatch cannot become a workflow output", async () => {
  const { runner } = setup({ ok: true, attemptId: "other", text: "Unexpected" });
  await expect(runner.run(request)).rejects.toThrow("identity mismatch");
});

test("cancelled calls cannot contact a provider", async () => {
  const { runner, requests } = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(runner.run({ ...request, signal: controller.signal })).rejects.toThrow();
  expect(requests).toEqual([]);
});

test("review requests preserve the supported revision outcome", async () => {
  const { runner, requests } = setup({
    ok: true,
    attemptId: "attempt",
    text: JSON.stringify({ outcome: "revise", reason: "Clarify the example." }),
  });

  const output = await runner.run({
    ...request,
    assets: {
      skills: [],
      inputs: {
        workflowPhase: "reviewer",
        candidateId: "candidate-1",
        draftDigest: "a".repeat(64),
      },
    },
  });

  expect(JSON.parse(output)).toEqual({
    outcome: "revise",
    reason: "Clarify the example.",
    candidateId: "candidate-1",
    draftDigest: "a".repeat(64),
  });
  expect(requests[0]?.input).toMatchObject({
    prompt: expect.stringContaining("revise"),
  });
});
