import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const idSchema = z.string().min(1).max(128);

export const policyHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const requirementSchema = z.strictObject({
  id: idSchema,
  text: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => /\S/.test(value)),
  kind: z.enum(["functional", "visual"]),
  required: z.boolean(),
  origin: z.enum(["caller", "project_spec"]),
});

export const requirementsSchema = z
  .array(requirementSchema)
  .min(1)
  .max(64)
  .refine(
    (items) => Buffer.byteLength(JSON.stringify(items), "utf8") <= 16384,
    "Requirement content exceeds 16 KiB",
  )
  .refine((items) => items.some((item) => item.required), "Required scope is missing")
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Requirement IDs must be unique",
  );

export type Requirement = z.infer<typeof requirementSchema>;

export const bindingSchema = z.strictObject({
  threadId: idSchema,
  projectId: idSchema,
  environmentId: idSchema,
  hostId: idSchema,
  canonicalRoot: z.string().min(1).max(4096),
  workspaceId: z.string().min(1).max(512),
  policyHash: policyHashSchema,
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
});

export type ContextBinding = z.infer<typeof bindingSchema>;

export const workspaceInspectionSchema = z.strictObject({
  canonicalRoot: z.string().min(1).max(4096),
  candidateCanonicalPath: z.string().min(1).max(4096),
  withinWorkspace: z.boolean(),
  directory: z.boolean(),
  workspaceId: z.string().min(1).max(512),
  policyHash: policyHashSchema,
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
});

export type WorkspaceInspection = z.infer<typeof workspaceInspectionSchema>;

export const workspaceBindingSchema = bindingSchema.omit({ threadId: true });

export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;

const runtimeInput = z.strictObject({ binding: bindingSchema, payload: z.json() });

const controlInput = z.union([
  runtimeInput,
  z.strictObject({ workspace: workspaceBindingSchema, payload: z.json() }),
]);

export const hostContract = defineRpcContract({
  inspectWorkspace: {
    input: z.strictObject({
      candidatePath: z.string().min(1).max(4096),
      environmentId: idSchema,
      projectId: idSchema,
      gitCheckout: z.boolean(),
    }),
    output: workspaceInspectionSchema,
  },
  retainedRead: {
    input: z.strictObject({
      binding: bindingSchema,
      candidatePath: z.string().min(1).max(4096),
      method: z.enum(["result", "artifact"]),
      payload: z.json(),
    }),
    output: z.strictObject({ missing: z.boolean(), result: z.json().optional() }),
  },
  doctor: { input: controlInput, output: z.json() },
  submit: { input: runtimeInput, output: z.json() },
  submission: { input: runtimeInput, output: z.json() },
  result: { input: runtimeInput, output: z.json() },
  events: { input: runtimeInput, output: z.json() },
  artifact: { input: runtimeInput, output: z.json() },
  cancel: { input: runtimeInput, output: z.json() },
  releaseClient: { input: runtimeInput, output: z.json() },
  setup: { input: controlInput, output: z.json() },
  status: { input: controlInput, output: z.json() },
});

export const hostSignals = {
  jobChanged: { payload: z.strictObject({ threadId: idSchema, runId: idSchema }) },
};

export type RuntimeMethod = Exclude<keyof typeof hostContract, "inspectWorkspace" | "retainedRead">;

export type JsonPayload = z.infer<ReturnType<typeof z.json>>;

export interface RunOwnership {
  runId: string;
  sessionId: string;
  binding: ContextBinding;
}

export interface SessionOwnership {
  sessionId: string;
  binding: ContextBinding;
}

export interface OwnershipStore {
  getRun(runId: string): Promise<RunOwnership | undefined>;
  getSession(sessionId: string): Promise<SessionOwnership | undefined>;
  rememberRun(record: RunOwnership): Promise<void>;
  rememberSession(record: SessionOwnership): Promise<void>;
}

const ownerThreadInput = z.strictObject({ threadId: idSchema });

const ownerRunInput = z.strictObject({ threadId: idSchema, runId: idSchema });

export const uiContract = defineRpcContract({
  listRuns: {
    input: ownerThreadInput,
    output: z
      .array(
        z.strictObject({
          runId: idSchema,
          sessionId: idSchema,
          state: z.enum(["accepted", "running", "completed", "cancelled", "interrupted"]),
          updatedAt: z.number().nonnegative(),
          summary: z.string().max(4096).optional(),
        }),
      )
      .max(100),
  },
  getRun: { input: ownerRunInput, output: z.json() },
  getDelivery: {
    input: ownerRunInput,
    output: z.strictObject({
      state: z.enum(["none", "queued", "sending", "uncertain", "delivered", "suppressed"]),
    }),
  },
  cancelRun: { input: ownerRunInput, output: z.json() },
  readArtifact: {
    input: z.strictObject({
      threadId: idSchema,
      runId: idSchema,
      evidenceId: idSchema,
      offset: z.number().int().nonnegative().default(0),
      maxBytes: z.number().int().positive().max(262144).default(262144),
    }),
    output: z.strictObject({
      evidenceId: idSchema,
      evidence: z.json(),
      offset: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      bytesBase64: z.string().max(349528),
      mimeType: z.string(),
      complete: z.boolean(),
    }),
  },
  events: {
    input: z.strictObject({
      threadId: idSchema,
      runId: idSchema,
      after: z.number().int().nonnegative().default(0),
      waitMs: z.number().int().min(0).max(10000).default(0),
    }),
    output: z.json(),
  },
});
