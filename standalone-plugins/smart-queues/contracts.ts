import { z } from "zod";
import type { MessageDispatchHookContext } from "@omnyo/plugin-sdk";

export type PromptInput = MessageDispatchHookContext["input"]["blocks"][number];

export type ThreadQueuedMessage = MessageDispatchHookContext["queuedMessages"][number];

export type ThreadResponse = MessageDispatchHookContext["thread"];

const resourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread"),
    threadId: z.string(),
    projectId: z.string().optional(),
    label: z.string(),
  }),
  z.object({ kind: z.literal("project"), projectId: z.string(), label: z.string() }),
  z.object({ kind: z.literal("section"), sectionId: z.string(), label: z.string() }),
  z.object({
    kind: z.literal("path"),
    entryKind: z.enum(["directory", "file"]),
    path: z.string(),
    source: z.enum(["thread-storage", "workspace"]),
    label: z.string(),
  }),
  z.object({
    kind: z.literal("command"),
    argumentHint: z.string().nullable(),
    name: z.string(),
    origin: z.enum(["builtin", "project", "user"]),
    source: z.enum(["command", "skill"]),
    trigger: z.enum(["/", "$"]),
    label: z.string(),
  }),
  z.object({
    kind: z.literal("plugin"),
    icon: z.string().nullable().optional(),
    itemId: z.string(),
    pluginId: z.string(),
    label: z.string(),
  }),
]);

const visibility = z.literal("agent-only").optional();

export const promptSchema: z.ZodType<PromptInput> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    mentions: z.array(z.object({ start: z.number(), end: z.number(), resource: resourceSchema })),
    visibility,
  }),
  z.object({ type: z.literal("image"), url: z.string(), visibility }),
  z.object({ type: z.literal("localImage"), path: z.string(), visibility }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),
    visibility,
  }),
]);

export const actionSchema = z.enum(["steer", "new-chat", "queue", "combine"]);

export type Action = z.infer<typeof actionSchema>;

export const decisionSchema = z.object({
  action: actionSchema,
  count: z.number().int().min(1).max(64),
  reason: z.string().min(1).max(200),
});

export const routeSchema = z.object({
  threadId: z.string().min(1),
  action: actionSchema,
  count: z.number().int().min(1).max(64).default(1),
});

export const originalSchema = z.object({
  id: z.string(),
  updatedAt: z.number(),
  content: z.array(promptSchema),
  model: z.string(),
  reasoningLevel: z.enum(["high", "low", "max", "medium", "none", "ultra", "ultracode", "xhigh"]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  serviceTier: z.string(),
});

export const jobSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  providerId: z.string(),
  turnId: z.string(),
  stamp: z.string(),
  classificationKey: z.string().nullable().default(null),
  originals: z.array(originalSchema),
  action: actionSchema.nullable(),
  count: z.number(),
  reason: z.string(),
  state: z.enum([
    "classifying",
    "preparing",
    "ready",
    "running",
    "complete",
    "stale",
    "error",
    "restored",
  ]),
  routerThreadId: z.string().nullable(),
  destinationThreadId: z.string().nullable(),
  history: z.array(z.array(promptSchema)),
  destinationInput: z.array(promptSchema),
  transferred: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  error: z.string().nullable(),
});

export type Job = z.infer<typeof jobSchema>;

export type Original = z.infer<typeof originalSchema>;

export const jobViewSchema = jobSchema.pick({
  id: true,
  threadId: true,
  action: true,
  count: true,
  reason: true,
  state: true,
  routerThreadId: true,
  destinationThreadId: true,
  createdAt: true,
  updatedAt: true,
  error: true,
});

export type JobView = z.infer<typeof jobViewSchema>;

export type Settings = {
  enabled: boolean;
  debounceMs: number;
  routerProvider: string;
  routerModel: string;
};

export function textBlock(text: string): PromptInput {
  return { type: "text", text, mentions: [] };
}
