import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@omnyo/plugin-sdk/testing";
import type { PluginAgentToolContext } from "@omnyo/plugin-sdk";
import { expect, it } from "vitest";
import { registerManagedAgent } from "./managed-agent.js";
import { defaultManagedPolicy, type ManagedState } from "./managed-contract.js";
import type { ManagedService } from "./managed-service.js";

it("advertises an object-root owner tool, forwards trusted context and reports release as a decision rather than removal", async () => {
  const host = createFakePluginHost({
    pluginId: "storage-retention",
    agentSkillIds: ["storage-retention"],
  });

  const state: ManagedState = {
    policy: defaultManagedPolicy,
    allocations: [],
    failures: [],
    preview: null,
  };

  const calls: { input: unknown; context: PluginAgentToolContext }[] = [];

  const service: ManagedService = {
    state: async () => state,
    request: async () => state,
    owner: async (input, context) => {
      calls.push({ input, context });

      return state;
    },
    lifecycle: async () => state,
    reconcile: async () => state,
  };

  try {
    registerManagedAgent(host.api, service);
    const tool = host.harness.registrations.agentTools[0]!;
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { request: expect.any(Object) },
    });
    expect(tool.inputSchema).not.toHaveProperty("anyOf");
    const controller = new AbortController();

    const input = {
      request: {
        action: "release",
        closeout: { outcome: "success", retainedOutputs: [] },
        id: "d5d7fc72-16ef-40e3-89ae-283750283837",
        revision: 4,
        snapshotDigest: "a".repeat(64),
        reason: "Intermediate work is finished.",
      },
    };

    const result = await host.harness.callAgentTool("ManagedScratch", input, {
      threadId: "thr_owner",
      projectId: "proj_test",
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toEqual({
      threadId: "thr_owner",
      projectId: "proj_test",
      signal: controller.signal,
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("Nothing was removed.");
    await expect(
      host.harness.callAgentTool("ManagedScratch", {
        request: { action: "configure", policy: {} },
      }),
    ).rejects.toThrow("invalid");
    await expect(
      host.harness.callAgentTool("ManagedScratch", {
        request: { ...input.request, ownerThreadId: "thr_other" },
      }),
    ).rejects.toThrow("invalid");

    const selected = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );

    expect(selected.tools.map((entry) => entry.name)).toEqual([
      "ManagedScratch",
    ]);
    expect(selected.skills).toEqual(["storage-retention"]);
    expect(selected.instructions?.length).toBeLessThan(700);
  } finally {
    await host.harness.dispose();
  }
});

it("surfaces a rejected usefulness decision as a tool error without a success payload", async () => {
  const host = createFakePluginHost({ pluginId: "storage-retention" });

  const state: ManagedState = {
    policy: defaultManagedPolicy,
    allocations: [],
    failures: [],
    preview: null,
  };

  const service: ManagedService = {
    state: async () => state,
    request: async () => state,
    lifecycle: async () => state,
    reconcile: async () => state,
    owner: async () => {
      throw new Error("Only the native owner can release this allocation.");
    },
  };

  try {
    registerManagedAgent(host.api, service);

    const result = await host.harness.callAgentTool("ManagedScratch", {
      request: { action: "list" },
    });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Only the native owner can release this allocation.",
        },
      ],
    });
  } finally {
    await host.harness.dispose();
  }
});
