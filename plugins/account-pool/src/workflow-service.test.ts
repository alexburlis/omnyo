import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { completeWorkflowCli } from "./workflow-cli.js";
import { registerWorkflowService } from "./workflow-service.js";

const input = {
  hostId: "host",
  providerId: "codex",
  model: "actual-model",
  attemptId: "attempt",
  prompt: "draft",
  timeoutMs: 1000,
  maxOutputBytes: 1000,
} as const;

const principal = {
  experimental_caller: { kind: "plugin", pluginId: "provider-codex" },
} as const;

function setup(pooled: boolean, configured = true) {
  const { api, harness } = createFakePluginHost({
    experimental_callHostRpc: () => ({ available: true }),
  });

  harness.sdk.stub("hosts.get", async () => ({
    status: "connected",
    lifecycle: { phase: "active" },
  }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host" }));
  harness.sdk.stub("providers.models", async () => ({
    models: [
      {
        id: "display-option-id",
        model: "actual-model",
        routeProviderId: "codex",
      },
    ],
  }));

  const account = vi.fn(async () => {
    throw new Error("No included allowance");
  });

  const lease = vi.fn(async () => {
    throw new Error("No included allowance");
  });

  registerWorkflowService(
    api,
    {
      workflowAccount: account,
      prepareWorkflow: lease,
      hasWorkflowAccounts: async () => configured,
    },
    { isProviderEnabled: async () => pooled },
  );

  return { harness, account, lease };
}

describe("workflow provider routing", () => {
  it("uses the underlying model field and native route when pool routing is off", async () => {
    const { harness, account } = setup(false);
    expect(
      await harness.callRpc(
        "workflowModelCapabilities",
        {
          hostId: input.hostId,
          model: input.model,
          providerId: input.providerId,
        },
        principal,
      ),
    ).toEqual({ available: true });
    expect(account).not.toHaveBeenCalled();
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);
  });
  it("uses native on a fresh installation with no configured accounts despite default-enabled pool routing", async () => {
    const { harness, account } = setup(true, false);
    expect(
      await harness.callRpc(
        "workflowModelCapabilities",
        {
          hostId: input.hostId,
          model: input.model,
          providerId: input.providerId,
        },
        principal,
      ),
    ).toEqual({ available: true });
    expect(account).not.toHaveBeenCalled();
  });
  it("does not fall back to native when an enabled pool has no allowance", async () => {
    const { harness, account } = setup(true);
    expect(
      await harness.callRpc(
        "workflowModelCapabilities",
        {
          hostId: input.hostId,
          model: input.model,
          providerId: input.providerId,
        },
        principal,
      ),
    ).toMatchObject({ available: false, code: "allowance_unavailable" });
    expect(account).toHaveBeenCalledOnce();
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });
  it("rejects Claude workflow without checking a pool account or dispatching to the host", async () => {
    const { harness, account, lease } = setup(true);

    const options = {
      experimental_caller: { kind: "plugin", pluginId: "provider-claude-code" },
    } as const;

    const claude = { ...input, providerId: "claude-code" } as const;

    const unavailable = {
      code: "allowance_unavailable",
      message:
        "Claude workflow steps cannot verify included-only usage through Claude Code.",
    };

    expect(
      await harness.callRpc(
        "workflowModelCapabilities",
        {
          hostId: claude.hostId,
          model: claude.model,
          providerId: claude.providerId,
        },
        options,
      ),
    ).toEqual({ available: false, ...unavailable });
    expect(
      await harness.callRpc("workflowModelComplete", claude, options),
    ).toEqual({ ok: false, attemptId: claude.attemptId, ...unavailable });
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
    expect(account).not.toHaveBeenCalled();
    expect(lease).not.toHaveBeenCalled();

    for (const route of [
      { kind: "native" },
      { kind: "pool", baseUrl: "http://127.0.0.1:1", capability: "fixture" },
    ] as const) {
      await expect(
        completeWorkflowCli({ ...claude, route }, new AbortController().signal),
      ).resolves.toEqual({
        ok: false,
        attemptId: claude.attemptId,
        ...unavailable,
      });
    }
  });
  it("rejects client, wrong provider and wrong routed model before dispatch", async () => {
    const { harness, account } = setup(false);
    expect(
      await harness.callRpc("workflowModelCapabilities", {
        hostId: input.hostId,
        model: input.model,
        providerId: input.providerId,
      }),
    ).toMatchObject({ available: false, code: "caller_not_allowed" });
    expect(
      await harness.callRpc(
        "workflowModelCapabilities",
        { hostId: input.hostId, model: input.model, providerId: "claude-code" },
        principal,
      ),
    ).toMatchObject({ available: false, code: "caller_not_allowed" });
    expect(
      await harness.callRpc(
        "workflowModelCapabilities",
        {
          hostId: input.hostId,
          model: "display-option-id",
          providerId: input.providerId,
        },
        principal,
      ),
    ).toMatchObject({ available: false });
    expect(account).not.toHaveBeenCalled();
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });
});
