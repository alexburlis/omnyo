import { defineRpcContract, type PluginRpcHandlers } from "@omnyo/plugin-sdk";
import {
  WORKFLOW_PACKAGE_MAX_BYTES,
  WORKFLOW_SHARE_ID,
  workflowPackageSchema,
} from "./workflow-package.js";
import { z } from "zod";
import {
  workflowSourceSelection,
  workflowSourceSnapshot,
} from "./openseo-contract.js";
import { automationRunRpcResponseSchema } from "./rpc-types.js";

export const workflowId = z.string().min(1).max(128);

export const workflowHash = z.string().regex(/^[a-f0-9]{64}$/);

export const workflowSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    text: z.string().min(1).max(WORKFLOW_PACKAGE_MAX_BYTES),
  }),
  z.strictObject({
    kind: z.literal("link"),
    shareId: z.string().regex(WORKFLOW_SHARE_ID),
  }),
  z.strictObject({
    kind: z.literal("template"),
    template: z.literal("weekly-content-feed"),
  }),
]);

export const workflowBindings = z.strictObject({
  hostId: workflowId,
  providerId: z.enum(["codex", "claude-code"]),
  model: workflowId,
  inputs: z.record(
    z.string(),
    z.union([z.string().max(32768), z.boolean(), z.int()]),
  ),
});

const review = z.strictObject({
  reviewId: workflowId,
  package: workflowPackageSchema,
  packageDigest: workflowHash,
  executionDigest: workflowHash,
  capabilities: z.array(
    z.enum(["model-text", "write-run-artifacts", "replace-script-requirement"]),
  ),
  source: z.enum(["file", "link", "template"]),
});

const copy = z.strictObject({
  importId: workflowId,
  projectId: workflowId,
  graphId: workflowId.nullable(),
  graphVersion: z.int().positive().nullable(),
  automationId: workflowId.nullable(),
  package: workflowPackageSchema,
  packageDigest: workflowHash,
  executionDigest: workflowHash,
  bindingRevision: z.int().nonnegative(),
  bindings: workflowBindings.nullable(),
  draftInputs: workflowBindings.shape.inputs.nullable().optional(),
  confirmation: workflowHash.nullable(),
  source: workflowSourceSnapshot.nullable().optional(),
  draftSource: workflowSourceSnapshot.nullable().optional(),
  scheduleEnabled: z.boolean().optional(),
});

const option = z.object({ id: workflowId, name: z.string() });

const target = { projectId: workflowId, importId: workflowId };

export const workflowRevision = z.strictObject({
  ...target,
  reviewId: workflowId,
  packageDigest: workflowHash,
  expectedPackageDigest: workflowHash,
  source: z.enum(["local", "shared"]),
});

export const workflowArtifact = z.strictObject({
  runId: workflowId,
  graphId: workflowId,
  graphVersion: z.int().positive(),
  occurrenceKey: workflowId,
  manifestDigest: workflowHash,
  files: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-zA-Z0-9_-]+[.](?:md|json)$/),
        content: z.string(),
        digest: workflowHash,
      }),
    )
    .max(35),
});

export const workflowGraphSummary = z.object({
  machineId: workflowId,
  projectId: workflowId,
  name: z.string(),
  latestVersionNumber: z.int().positive().nullable(),
  draftChangeCount: z.int().nonnegative(),
  openAttentionCount: z.int().nonnegative(),
  instances: z.array(
    z.object({
      lifecycle: z.enum([
        "running",
        "paused",
        "stopping",
        "stopped",
        "completed",
        "failed",
      ]),
      stateTitle: z.string(),
    }),
  ),
});

export const workflowRpcContract = defineRpcContract({
  workflow_graphs: {
    input: z.strictObject({ projectId: workflowId.optional() }),
    output: z.array(workflowGraphSummary),
  },
  workflow_options: {
    input: z.strictObject({ hostId: workflowId.optional() }),
    output: z.object({
      projects: z.array(option),
      hosts: z.array(option),
      modelErrors: z.array(z.string()).optional(),
      models: z.array(
        option.extend({
          providerId: workflowBindings.shape.providerId,
          model: workflowId,
        }),
      ),
    }),
  },
  workflow_inspect: { input: workflowSource, output: review },
  workflow_previous: { input: z.strictObject(target), output: review },
  workflow_install: {
    input: z.strictObject({
      projectId: workflowId,
      reviewId: workflowId,
      packageDigest: workflowHash,
      requestId: workflowId,
    }),
    output: copy,
  },
  workflow_list: {
    input: z.strictObject({ projectId: workflowId }),
    output: z.array(copy),
  },
  workflow_bind: {
    input: z.strictObject({
      ...target,
      expectedRevision: z.int().nonnegative(),
      bindings: workflowBindings.extend({
        source: workflowSourceSelection.optional(),
      }),
    }),
    output: copy,
  },
  workflow_preview: {
    input: z.strictObject(target),
    output: z.strictObject({ copy, example: z.string() }),
  },
  workflow_confirm: {
    input: z.strictObject({
      ...target,
      expectedRevision: z.int().positive(),
      executionDigest: workflowHash,
    }),
    output: copy,
  },
  workflow_enable: { input: z.strictObject(target), output: copy },
  workflow_run: {
    input: z.strictObject({ ...target, requestId: workflowId }),
    output: automationRunRpcResponseSchema,
  },
  workflow_compare: {
    input: z.strictObject({
      ...target,
      reviewId: workflowId,
      packageDigest: workflowHash,
    }),
    output: z.strictObject({
      incoming: z.array(z.string()),
      modified: z.array(z.string()),
      conflicts: z.array(z.string()),
      applyInPlace: z.boolean(),
    }),
  },
  workflow_revise: { input: workflowRevision, output: copy },
  workflow_artifacts: {
    input: z.strictObject({ ...target, runId: workflowId }),
    output: workflowArtifact,
  },
  workflow_export: {
    input: z.strictObject(target),
    output: z.strictObject({ text: z.string(), packageDigest: workflowHash }),
  },
  workflow_export_automation: {
    input: z.strictObject({
      projectId: workflowId,
      automationId: workflowId,
      sanitizedPrompt: z.string().min(1).max(32000).optional(),
    }),
    output: z.strictObject({ text: z.string(), packageDigest: workflowHash }),
  },
});

export type WorkflowHandlers = PluginRpcHandlers<typeof workflowRpcContract>;
