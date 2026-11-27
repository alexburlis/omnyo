import {
  defineRpcContract,
  type PluginApi,
  type ExperimentalPluginRpcHandlersWithContext,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  admitInputSchema,
  bindingSchema,
  importInputSchema,
  importRecordSchema,
  lookupInputSchema,
  runSchema,
  reviseInputSchema,
  exportSchema,
  reconcileInputSchema,
} from "./contracts.js";
import type { ImportedWorkflowService } from "./service.js";

export const importedWorkflowRpc = defineRpcContract({
  sm_workflow_preflight: {
    input: bindingSchema,
    output: z.strictObject({
      available: z.boolean(),
      code: z.string().optional(),
      message: z.string().optional(),
    }),
  },
  sm_workflow_reconcile: { input: reconcileInputSchema, output: runSchema },
  sm_workflow_export: { input: lookupInputSchema, output: exportSchema },
  sm_workflow_revise: { input: reviseInputSchema, output: importRecordSchema },
  sm_workflow_import: { input: importInputSchema, output: importRecordSchema },
  sm_workflow_admit: { input: admitInputSchema, output: runSchema },
  sm_workflow_lookup: {
    input: lookupInputSchema,
    output: z.strictObject({ graph: importRecordSchema, run: runSchema.nullable() }).nullable(),
  },
  sm_workflow_execute: { input: lookupInputSchema, output: runSchema },
});

export function importedWorkflowHandlers(
  service: ImportedWorkflowService,
): ExperimentalPluginRpcHandlersWithContext<typeof importedWorkflowRpc> {
  function authorize(
    context: Parameters<
      ExperimentalPluginRpcHandlersWithContext<typeof importedWorkflowRpc>["sm_workflow_import"]
    >[1],
  ): void {
    if (
      context.experimental_caller.kind !== "plugin" ||
      context.experimental_caller.pluginId !== "automations"
    )
      throw new Error("Only the coordinator workflow owner can access imported execution");
  }

  return {
    sm_workflow_preflight(input, context) {
      authorize(context);

      return service.preflight(input);
    },
    sm_workflow_reconcile(input, context) {
      authorize(context);

      return service.reconcileRun(input);
    },
    sm_workflow_export(input, context) {
      authorize(context);

      return service.export(input);
    },
    sm_workflow_revise(input, context) {
      authorize(context);

      return service.revise(input);
    },
    sm_workflow_import(input, context) {
      authorize(context);

      return service.import(input);
    },
    sm_workflow_admit(input, context) {
      authorize(context);

      return service.admit(input);
    },
    sm_workflow_lookup(input, context) {
      authorize(context);

      return service.lookup(input);
    },
    sm_workflow_execute(input, context) {
      authorize(context);

      return service.execute(input, context.experimental_signal);
    },
  };
}

export function registerImportedWorkflows(api: PluginApi, service: ImportedWorkflowService): void {
  api.rpc.register(importedWorkflowRpc, importedWorkflowHandlers(service));
}
