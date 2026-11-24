import type {
  PluginApi,
  ExperimentalPluginRpcHandlerContext,
} from "@omnyo/plugin-sdk";
import type { AccountPoolHub } from "./hub.js";
import type { RoutingStore } from "./store.js";
import {
  CLAUDE_WORKFLOW_UNAVAILABLE,
  poolWorkflowContract,
  workflowHostContract,
} from "./workflow-contract.js";
import type {
  WorkflowModelCapabilities,
  WorkflowModelResult,
} from "./workflow-contract.js";

export function registerWorkflowService(
  api: PluginApi,
  hub: Pick<
    AccountPoolHub,
    "workflowAccount" | "prepareWorkflow" | "hasWorkflowAccounts"
  >,
  routing: Pick<RoutingStore, "isProviderEnabled">,
): void {
  const host = api.hosts.experimental_client({
    contract: workflowHostContract,
  });

  const authorized = (
    context: ExperimentalPluginRpcHandlerContext,
    providerId: string,
  ) =>
    context.experimental_caller.kind === "plugin" &&
    context.experimental_caller.pluginId === `provider-${providerId}`;

  const denial = {
    code: "caller_not_allowed" as const,
    message: "Workflow inference must be requested by the selected provider.",
  };

  const validate = async (input: { hostId: string; model: string }) => {
    const machine = await api.sdk.hosts.get({ hostId: input.hostId });

    if (machine.status !== "connected" || machine.lifecycle.phase !== "active")
      throw new Error("The selected machine is unavailable.");

    if (
      api.server.experimental_appUrl === null &&
      (await api.sdk.system.config()).primaryHostId !== input.hostId
    )
      throw new Error(
        "The selected remote machine cannot reach this Account Pooler.",
      );

    const models = await api.sdk.providers.models({
      hostId: input.hostId,
      providerId: "codex",
    });

    if (
      !models.models.some(
        (model) =>
          model.model === input.model &&
          (model.routeProviderId ?? "codex") === "codex",
      )
    )
      throw new Error("The selected model is unavailable on this machine.");
  };

  const hasConfiguredPool = async () =>
    (await routing.isProviderEnabled("codex")) &&
    (await hub.hasWorkflowAccounts("codex"));

  const claudeDenial = {
    code: "allowance_unavailable" as const,
    message: CLAUDE_WORKFLOW_UNAVAILABLE,
  };

  api.rpc.register(poolWorkflowContract, {
    workflowModelCapabilities: async (
      input,
      context,
    ): Promise<WorkflowModelCapabilities> => {
      if (!authorized(context, input.providerId))
        return { available: false, ...denial };

      if (input.providerId === "claude-code")
        return { available: false, ...claudeDenial };

      try {
        await validate(input);

        if (await hasConfiguredPool()) {
          await hub.workflowAccount("codex", context.experimental_signal);

          return { available: true };
        }

        return await host.call("workflowModelCapabilities", input, {
          hostId: input.hostId,
          signal: context.experimental_signal,
          timeoutMs: 15000,
        });
      } catch (error) {
        return {
          available: false,
          code: "allowance_unavailable",
          message:
            error instanceof Error
              ? error.message
              : "Included subscription allowance is unavailable.",
        };
      }
    },
    workflowModelComplete: async (
      input,
      context,
    ): Promise<WorkflowModelResult> => {
      if (!authorized(context, input.providerId))
        return { ok: false, attemptId: input.attemptId, ...denial };

      if (input.providerId === "claude-code")
        return { ok: false, attemptId: input.attemptId, ...claudeDenial };

      const signal = AbortSignal.any([
        context.experimental_signal,
        AbortSignal.timeout(input.timeoutMs),
      ]);

      try {
        await validate(input);

        if (!(await hasConfiguredPool()))
          return await host.call(
            "workflowModelComplete",
            { ...input, route: { kind: "native" } },
            { hostId: input.hostId, signal, timeoutMs: input.timeoutMs },
          );
        const lease = await hub.prepareWorkflow(input, signal);

        try {
          const baseUrl = `${(api.server.experimental_appUrl ?? api.server.loopbackBaseUrl).replace(/\/+$/u, "")}/api/v1/plugins/account-pool/http/v1`;

          return await host.call(
            "workflowModelComplete",
            {
              ...input,
              route: { kind: "pool", baseUrl, capability: lease.capability },
            },
            { hostId: input.hostId, signal, timeoutMs: input.timeoutMs },
          );
        } finally {
          lease.revoke();
        }
      } catch {
        return {
          ok: false,
          attemptId: input.attemptId,
          code: context.experimental_signal.aborted
            ? "cancelled"
            : signal.aborted
              ? "timeout"
              : "allowance_unavailable",
          message:
            "The selected machine, model, or included subscription allowance is unavailable.",
        };
      }
    },
  });
}
