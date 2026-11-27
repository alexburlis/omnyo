import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  experimental_workflowModelV1,
  type ExperimentalWorkflowModelV1Capabilities as WorkflowModelCapabilities,
  type ExperimentalWorkflowModelV1Result as WorkflowModelResult,
} from "@omnyo/plugin-sdk/workflow-model";

const { contract: workflowModelContract } = experimental_workflowModelV1;

export function registerWorkflowModelService(api: PluginApi): void {
  const denied = {
    code: "caller_not_allowed" as const,
    message: "Only State Machines can request workflow text.",
  };

  const unavailable = {
    code: "allowance_unavailable" as const,
    message:
      "Claude workflow steps cannot verify included-only usage through Claude Code.",
  };

  api.rpc.register(workflowModelContract, {
    workflowModelCapabilities: async (
      _input,
      context,
    ): Promise<WorkflowModelCapabilities> => {
      if (
        context.experimental_caller.kind !== "plugin" ||
        context.experimental_caller.pluginId !== "state-machines"
      )
        return { available: false, ...denied };

      return { available: false, ...unavailable };
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

      return { ok: false, attemptId: input.attemptId, ...unavailable };
    },
  });
}
