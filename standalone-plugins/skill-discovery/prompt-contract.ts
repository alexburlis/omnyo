import { defineRpcContract, type ComposerDraftReplacement } from "@omnyo/plugin-sdk";
import { z } from "zod";

const mentionSchema = z.intersection(
  z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    label: z.string(),
  }),
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("thread"),
      threadId: z.string(),
      projectId: z.string().optional(),
    }),
    z.object({ kind: z.literal("project"), projectId: z.string() }),
    z.object({ kind: z.literal("section"), sectionId: z.string() }),
    z.object({
      kind: z.literal("path"),
      path: z.string(),
      source: z.enum(["workspace", "thread-storage"]),
      entryKind: z.enum(["file", "directory"]),
    }),
    z.object({
      kind: z.literal("command"),
      trigger: z.enum(["/", "$"]),
      name: z.string(),
      source: z.enum(["skill", "command"]),
      origin: z.enum(["builtin", "project", "user"]),
      argumentHint: z.string().nullable(),
    }),
    z.object({ kind: z.literal("attachment"), path: z.string() }),
    z.object({
      kind: z.literal("plugin"),
      pluginId: z.string(),
      provider: z.string(),
      id: z.string(),
      icon: z.string().nullable().optional(),
    }),
  ]),
);

export const draftSchema = z
  .object({
    text: z.string(),
    mentions: z.array(mentionSchema).readonly(),
  })
  .strict();

function validMentionRanges(prompt: z.infer<typeof draftSchema>): boolean {
  return prompt.mentions.every(
    (mention) => mention.to > mention.from && mention.to <= prompt.text.length,
  );
}

export const attachmentSchema = z.union([
  z
    .object({
      type: z.enum(["localImage", "localFile"]),
      path: z.string(),
      name: z.string(),
      sizeBytes: z.number().nonnegative().optional(),
      mimeType: z.string().optional(),
      sourceProjectId: z.string().optional(),
      hostId: z.never().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.enum(["localImage", "localFile"]),
      path: z.string(),
      name: z.string(),
      sizeBytes: z.number().nonnegative().optional(),
      mimeType: z.string().optional(),
      sourceProjectId: z.never().optional(),
      hostId: z.string(),
    })
    .passthrough(),
]);

export const promptSchema = draftSchema
  .extend({
    attachments: z.array(attachmentSchema).readonly().optional(),
  })
  .refine(
    validMentionRanges,
    "Mention range must be within prompt text",
  ) satisfies z.ZodType<ComposerDraftReplacement>;

export const promptScopeSchema = z.enum(["thread", "project", "global"]);

export type PromptScope = z.infer<typeof promptScopeSchema>;

const snippetSchema = z
  .object({
    text: z.string(),
    highlights: z.array(z.tuple([z.number().int(), z.number().int()])),
  })
  .strict();

export type PromptSnippet = z.infer<typeof snippetSchema>;

const starredPromptSchema = z
  .object({
    kind: z.literal("starred"),
    id: z.string(),
    prompt: promptSchema,
    snippet: snippetSchema,
    createdAt: z.number(),
    lastUsedAt: z.number().nullable(),
  })
  .strict();

export type StarredPromptRow = z.infer<typeof starredPromptSchema>;

const recentPromptSchema = z
  .object({
    kind: z.literal("recent"),
    id: z.string(),
    prompt: promptSchema,
    snippet: snippetSchema,
    createdAt: z.number(),
    projectId: z.string(),
    projectName: z.string().nullable(),
    threadId: z.string(),
    starredId: z.string().nullable(),
  })
  .strict();

export type RecentPromptRow = z.infer<typeof recentPromptSchema>;

const savedPromptRowSchema = z
  .object({
    kind: z.literal("saved"),
    id: z.string(),
    title: z.string(),
    prompt: promptSchema,
    snippet: snippetSchema,
    projectId: z.string(),
    environmentId: z.string().nullable(),
    starredId: z.string().nullable(),
  })
  .strict();

export type SavedPromptRow = z.infer<typeof savedPromptRowSchema>;

const promptRowSchema = z.discriminatedUnion("kind", [
  starredPromptSchema,
  recentPromptSchema,
  savedPromptRowSchema,
]);

export const storedStarredPromptSchema = z
  .object({
    id: z.string().min(1),
    prompt: draftSchema.refine(validMentionRanges, "Mention range must be within prompt text"),
    createdAt: z.number(),
    lastUsedAt: z.number().nullable(),
  })
  .strict();

export const legacyPromptImportSchema = z
  .object({
    sourceId: z.literal("omnyo--prompt-library"),
    prompts: z.array(storedStarredPromptSchema),
  })
  .strict();

export type PromptRow = z.infer<typeof promptRowSchema>;

export const searchPromptsInputSchema = z
  .object({
    query: z.string(),
    scope: promptScopeSchema,
    projectId: z.string().min(1).nullable(),
    threadId: z.string().min(1).nullable(),
    composer: z.enum(["new-thread", "follow-up"]),
    environmentId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type SearchPromptsInput = z.infer<typeof searchPromptsInputSchema>;

export const promptLibraryRpcContract = defineRpcContract({
  promptLibraryStatus: { input: z.null(), output: z.object({ version: z.literal(1) }).strict() },
  importLegacyPrompts: {
    input: legacyPromptImportSchema,
    output: z.object({ imported: z.number().int().nonnegative() }).strict(),
  },
  listStarred: { input: z.null(), output: z.array(storedStarredPromptSchema) },
  searchLegacy: {
    input: searchPromptsInputSchema,
    output: z.object({ prompts: z.array(promptRowSchema) }).strict(),
  },
  search: {
    input: searchPromptsInputSchema,
    output: z
      .object({
        prompts: z.array(promptRowSchema),
      })
      .strict(),
  },
  star: {
    input: z
      .object({
        prompt: draftSchema.refine(validMentionRanges, "Mention range must be within prompt text"),
      })
      .strict(),
    output: z.object({ id: z.string() }).strict(),
  },
  unstar: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ unstarred: z.boolean() }).strict(),
  },
  markUsed: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.null(),
  },
});
