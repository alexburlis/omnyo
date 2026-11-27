import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  experimental_workflowModelV1,
  type ExperimentalWorkflowModelV1Capabilities as WorkflowModelCapabilities,
  type ExperimentalWorkflowModelV1Result as WorkflowModelResult,
} from "@omnyo/plugin-sdk/workflow-model";

const {
  contract: workflowModelContract,
  capabilitiesSchema: workflowModelCapabilitiesSchema,
  resultSchema: workflowModelResultSchema,
} = experimental_workflowModelV1;

export function registerWorkflowModelService(api: PluginApi): void {
  const denied = {
    code: "caller_not_allowed" as const,
    message: "Only State Machines can request workflow text.",
  };

  api.rpc.register(workflowModelContract, {
    workflowModelCapabilities: async (
      input,
      context,
    ): Promise<WorkflowModelCapabilities> => {
      if (
        context.experimental_caller.kind !== "plugin" ||
        context.experimental_caller.pluginId !== "state-machines"
      )
        return { available: false, ...denied };

      try {
        return workflowModelCapabilitiesSchema.parse(
          await api.sdk.plugins.callRpc({
            pluginId: "account-pool",
            method: "workflowModelCapabilities",
            input: { ...input, providerId: "codex" },
            signal: context.experimental_signal,
            outputSchema: workflowModelCapabilitiesSchema,
          }),
        );
      } catch {
        return {
          available: false,
          code: "allowance_unavailable",
          message:
            "Enable Account Pooler to run workflows through the guarded CLI executor.",
        };
      }
    },
    workflowModelComplete: async (
      input,
      context,
    ): Promise<WorkflowModelResult> => {
      if (
        context.experimental_caller.kind !== "plugin" ||
        context.experimental_caller.pluginId !== "state-machines"
      )
        return { ok: false, attemptId: input.attemptId, ...denied };

      try {
        return workflowModelResultSchema.parse(
          await api.sdk.plugins.callRpc({
            pluginId: "account-pool",
            method: "workflowModelComplete",
            input: { ...input, providerId: "codex" },
            signal: context.experimental_signal,
            outputSchema: workflowModelResultSchema,
          }),
        );
      } catch {
        return {
          ok: false,
          attemptId: input.attemptId,
          code: "request_failed",
          message:
            "Workflow text could not complete through the included subscription route.",
        };
      }
    },
  });
}
