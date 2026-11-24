import type {
  ExperimentalPluginRpcHandlerContext,
  ExperimentalPluginRpcHandlersWithContext,
} from "@omnyo/plugin-sdk";
import type { openSeoRpcContract } from "./openseo-contract.js";

export type OpenSeoHandlers = ExperimentalPluginRpcHandlersWithContext<
  typeof openSeoRpcContract
>;

export function requireWorkflowSetupClient(
  context: ExperimentalPluginRpcHandlerContext,
) {
  if (context.experimental_caller.kind !== "client")
    throw new Error("OpenSEO setup requires the workflow setup client.");
}

export function setupRpcHandlers(handlers: OpenSeoHandlers): OpenSeoHandlers {
  return {
    workflow_openseo_status(input, context) {
      requireWorkflowSetupClient(context);

      return handlers.workflow_openseo_status(input, context);
    },
    workflow_openseo_disconnect(input, context) {
      requireWorkflowSetupClient(context);

      return handlers.workflow_openseo_disconnect(input, context);
    },
    workflow_openseo_projects(input, context) {
      requireWorkflowSetupClient(context);

      return handlers.workflow_openseo_projects(input, context);
    },
    workflow_openseo_connect(input, context) {
      requireWorkflowSetupClient(context);

      return handlers.workflow_openseo_connect(input, context);
    },
    workflow_openseo_keywords(input, context) {
      requireWorkflowSetupClient(context);

      return handlers.workflow_openseo_keywords(input, context);
    },
  };
}
