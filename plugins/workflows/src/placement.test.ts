import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { resolveWorkflowPlacement } from "./placement.js";

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-target",
    projectId: "project-test",
    hostId: "host-target",
    path: "C:\\workspace",
    status: "ready",
    lifecycle: { phase: "active" },
    hostLifecycle: "active",
    ...overrides,
  };
}

describe("workflow target admission", () => {
  it("resolves an existing target without provisioning or provider calls", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "workflows",
      sdk: { environments: { get: async () => environment() as never } },
    });

    try {
      await expect(
        resolveWorkflowPlacement(api.sdk, "project-test", "env-target"),
      ).resolves.toEqual({
        environmentId: "env-target",
        hostId: "host-target",
        workspacePath: "C:\\workspace",
      });
      expect(harness.sdk.callsTo("providers.list")).toHaveLength(0);
      expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    [{ projectId: "other" }, "different project"],
    [{ id: "wrong" }, "different project"],
    [{ status: "creating" }, "not ready"],
    [{ status: "destroyed" }, "not ready"],
    [{ lifecycle: { phase: "retiring" } }, "not ready"],
    [{ lifecycle: { phase: "teardown" } }, "not ready"],
    [{ hostLifecycle: "removing" }, "not ready"],
    [{ path: null }, "no workspace"],
  ])(
    "rejects an ineligible target before provider validation: %j",
    async (overrides, reason) => {
      const { api, harness } = createFakePluginHost({
        pluginId: "workflows",
        sdk: {
          environments: { get: async () => environment(overrides) as never },
        },
      });

      try {
        await expect(
          resolveWorkflowPlacement(api.sdk, "project-test", "env-target"),
        ).rejects.toThrow(reason);
        expect(harness.sdk.callsTo("providers.list")).toHaveLength(0);
        expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
      } finally {
        await harness.dispose();
      }
    },
  );

  it("preserves a missing-target error instead of falling back", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "workflows",
      sdk: {
        environments: {
          get: async () => {
            throw new Error("Environment not found");
          },
        },
      },
    });

    try {
      await expect(
        resolveWorkflowPlacement(api.sdk, "project-test", "env-target"),
      ).rejects.toThrow("Environment not found");
      expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });
});
