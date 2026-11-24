import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const NATIVE_PROVIDER_IDS = ["codex", "claude-code"] as const;

export const nativeProviderIdSchema = z.enum(NATIVE_PROVIDER_IDS);

export type NativeProviderId = z.infer<typeof nativeProviderIdSchema>;

export const HISTORY_LIMITS = {
  agentTextChars: 64 * 1024,
  commandChars: 16 * 1024,
  commandOutputChars: 16 * 1024,
  diffChars: 64 * 1024,
  toolArgumentsChars: 8 * 1024,
  toolResultChars: 16 * 1024,
  toolErrorChars: 8 * 1024,
  userTextChars: 256 * 1024,
  itemsPerTurn: 400,
  changesPerFileChange: 200,
  turnsPerChat: 5000,
  serializedChatBytes: 4 * 1024 * 1024,
} as const;

const itemIdSchema = z.string().min(1).max(200);

export const nativeHistoryItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agentMessage"),
      id: itemIdSchema,
      text: z.string().max(HISTORY_LIMITS.agentTextChars),
    })
    .strict(),
  z
    .object({
      type: z.literal("commandExecution"),
      id: itemIdSchema,
      command: z.string().max(HISTORY_LIMITS.commandChars),
      cwd: z.string().max(4096).nullable(),
      output: z.string().max(HISTORY_LIMITS.commandOutputChars),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fileChange"),
      id: itemIdSchema,
      changes: z
        .array(
          z
            .object({
              path: z.string().min(1).max(4096),
              kind: z.enum(["add", "delete", "update"]),
              diff: z.string().max(HISTORY_LIMITS.diffChars).nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(HISTORY_LIMITS.changesPerFileChange),
    })
    .strict(),
  z
    .object({
      type: z.literal("toolCall"),
      id: itemIdSchema,
      tool: z.string().min(1).max(200),
      server: z.string().max(200).nullable(),
      arguments: z.string().max(HISTORY_LIMITS.toolArgumentsChars).nullable(),
      result: z.string().max(HISTORY_LIMITS.toolResultChars).nullable(),
      error: z.string().max(HISTORY_LIMITS.toolErrorChars).nullable(),
    })
    .strict(),
]);

export type NativeHistoryItem = z.infer<typeof nativeHistoryItemSchema>;

export const nativeHistoryTurnSchema = z
  .object({
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    status: z.enum(["completed", "interrupted"]),
    userText: z.string().min(1).max(HISTORY_LIMITS.userTextChars),
    items: z.array(nativeHistoryItemSchema).max(HISTORY_LIMITS.itemsPerTurn),
  })
  .strict();

export type NativeHistoryTurn = z.infer<typeof nativeHistoryTurnSchema>;

export const nativeChatClientSchema = z.enum(["cli", "ide", "desktop"]);

export type NativeChatClient = z.infer<typeof nativeChatClientSchema>;

export const projectRootHintSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["git", "git-worktree", "folder"]),
    mainRepositoryPath: z.string().min(1).nullable(),
  })
  .strict();

export type ProjectRootHint = z.infer<typeof projectRootHintSchema>;

export const nativeChatSummarySchema = z
  .object({
    providerId: nativeProviderIdSchema,
    sourceProviderThreadId: z.string().min(1).max(256),
    sourcePath: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    realCwd: z.string().min(1).max(4096).nullable(),
    cwdExists: z.boolean(),
    cwdMatchesStore: z.boolean(),
    projectRoot: projectRootHintSchema.nullable(),
    title: z.string().min(1).max(120),
    firstPrompt: z.string().max(200),
    createdAt: z.number().int().nonnegative(),
    lastMessageAt: z.number().int().nonnegative(),
    client: nativeChatClientSchema,
    sizeBytes: z.number().int().nonnegative(),
    forkedFromProviderThreadId: z.string().min(1).max(256).nullable(),
  })
  .strict();

export type NativeChatSummary = z.infer<typeof nativeChatSummarySchema>;

export const scanDropReasonSchema = z.enum([
  "older-than-window",
  "omnyo-session",
  "scripted-session",
  "subagent-session",
  "no-user-message",
  "unreadable",
]);

export type ScanDropReason = z.infer<typeof scanDropReasonSchema>;

export const scanInputSchema = z
  .object({
    days: z.number().int().min(1).max(365),
    nowMs: z.number().int().nonnegative(),
    resolvePaths: z.array(z.string().min(1).max(4096)).max(1000),
  })
  .strict();

export type ScanInput = z.infer<typeof scanInputSchema>;

export const scanOutputSchema = z
  .object({
    roots: z
      .object({
        codex: z.string().nullable(),
        claude: z.string().nullable(),
      })
      .strict(),
    homeDir: z.string().min(1),
    chats: z.array(nativeChatSummarySchema),
    dropped: z.array(
      z
        .object({
          providerId: nativeProviderIdSchema,
          reason: scanDropReasonSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    resolvedPaths: z.array(
      z
        .object({
          path: z.string().min(1).max(4096),
          realPath: z.string().min(1).max(4096).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type ScanOutput = z.infer<typeof scanOutputSchema>;

export const readChatInputSchema = z
  .object({
    providerId: nativeProviderIdSchema,
    sourcePath: z.string().min(1).max(4096),
    sourceProviderThreadId: z.string().min(1).max(256),
  })
  .strict();

export type ReadChatInput = z.infer<typeof readChatInputSchema>;

export const readChatOutputSchema = z
  .object({
    summary: nativeChatSummarySchema,
    turns: z.array(nativeHistoryTurnSchema).max(HISTORY_LIMITS.turnsPerChat),
    totalTurns: z.number().int().nonnegative(),
    omittedTurns: z.number().int().nonnegative(),
    skippedLines: z.number().int().nonnegative(),
  })
  .strict();

export type ReadChatOutput = z.infer<typeof readChatOutputSchema>;

export const chatImporterHostContract = defineRpcContract({
  scan: { input: scanInputSchema, output: scanOutputSchema },
  readChat: { input: readChatInputSchema, output: readChatOutputSchema },
});
