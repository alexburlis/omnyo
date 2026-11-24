import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  nativeChatClientSchema,
  nativeProviderIdSchema,
  projectRootHintSchema,
  scanDropReasonSchema,
} from "./host-contract.js";

export const DEFAULT_DAYS = 2;

export const MAX_DAYS = 365;

export const daysSchema = z.number().int().min(1).max(MAX_DAYS);

export const chatStatusSchema = z.enum([
  "ready",
  "already-imported",
  "omnyo-chat",
  "folder-missing",
  "not-a-project-folder",
  "cwd-mismatch",
]);

export type ChatStatus = z.infer<typeof chatStatusSchema>;

export const targetProjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      projectId: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("new"),
      name: z.string().min(1),
      path: z.string().min(1),
    })
    .strict(),
]);

export type TargetProject = z.infer<typeof targetProjectSchema>;

export const previewChatSchema = z
  .object({
    key: z.string().min(1),
    providerId: nativeProviderIdSchema,
    sourceProviderThreadId: z.string().min(1),
    sourcePath: z.string().min(1),
    title: z.string().min(1),
    firstPrompt: z.string(),
    cwd: z.string().min(1),
    realCwd: z.string().min(1).nullable(),
    projectRoot: projectRootHintSchema.nullable(),
    client: nativeChatClientSchema,
    createdAt: z.number().int().nonnegative(),
    lastMessageAt: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    status: chatStatusSchema,
    reason: z.string().nullable(),
    threadId: z.string().nullable(),
    project: targetProjectSchema.nullable(),
  })
  .strict();

export type PreviewChat = z.infer<typeof previewChatSchema>;

const providerCountSchema = z
  .object({
    found: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
  })
  .strict();

export const previewCountsSchema = z
  .object({
    found: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    alreadyImported: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    byProvider: z
      .object({
        codex: providerCountSchema,
        "claude-code": providerCountSchema,
      })
      .strict(),
  })
  .strict();

export type PreviewCounts = z.infer<typeof previewCountsSchema>;

export const previewHostSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    connected: z.boolean(),
  })
  .strict();

export type PreviewHost = z.infer<typeof previewHostSchema>;

export const hostsInputSchema = z.object({}).strict();

export type HostsInput = z.infer<typeof hostsInputSchema>;

export const hostsOutputSchema = z
  .object({
    primaryHostId: z.string().min(1).nullable(),
    hosts: z.array(previewHostSchema),
  })
  .strict();

export type HostsOutput = z.infer<typeof hostsOutputSchema>;

export const previewInputSchema = z
  .object({
    days: daysSchema.default(DEFAULT_DAYS),
    hostId: z.string().min(1).optional(),
  })
  .strict();

export type PreviewInput = z.infer<typeof previewInputSchema>;

export const plannedProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    paths: z.array(z.string().min(1)),
  })
  .strict();

export type PlannedProject = z.infer<typeof plannedProjectSchema>;

export const previewOutputSchema = z
  .object({
    hostId: z.string().min(1),
    hosts: z.array(previewHostSchema),
    days: daysSchema,
    nowMs: z.number().int().nonnegative(),
    cutoffMs: z.number().int(),
    homeDir: z.string().min(1),
    roots: z
      .object({
        codex: z.string().nullable(),
        claude: z.string().nullable(),
      })
      .strict(),
    projects: z.array(plannedProjectSchema),
    counts: previewCountsSchema,
    chats: z.array(previewChatSchema),
    dropped: z.array(
      z
        .object({
          providerId: nativeProviderIdSchema,
          reason: scanDropReasonSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    newProjects: z.array(
      z.object({ name: z.string().min(1), path: z.string().min(1) }).strict(),
    ),
  })
  .strict();

export type PreviewOutput = z.infer<typeof previewOutputSchema>;

export const importChatInputSchema = z
  .object({
    hostId: z.string().min(1),
    providerId: nativeProviderIdSchema,
    sourceProviderThreadId: z.string().min(1).max(256),
    sourcePath: z.string().min(1).max(4096),
    project: targetProjectSchema,
  })
  .strict();

export type ImportChatInput = z.infer<typeof importChatInputSchema>;

export const importChatOutputSchema = z
  .object({
    status: z.enum(["imported", "already-imported", "failed"]),
    threadId: z.string().nullable(),
    projectId: z.string().nullable(),
    createdProject: z.boolean(),
    message: z.string().nullable(),
    omittedTurns: z.number().int().nonnegative(),
    skippedLines: z.number().int().nonnegative(),
  })
  .strict();

export type ImportChatOutput = z.infer<typeof importChatOutputSchema>;

export const chatImportRpc = defineRpcContract({
  hosts: { input: hostsInputSchema, output: hostsOutputSchema },
  preview: { input: previewInputSchema, output: previewOutputSchema },
  importChat: { input: importChatInputSchema, output: importChatOutputSchema },
});

export interface ChatImporter {
  hosts(): Promise<HostsOutput>;
  preview(input: PreviewInput): Promise<PreviewOutput>;
  importChat(input: ImportChatInput): Promise<ImportChatOutput>;
}
