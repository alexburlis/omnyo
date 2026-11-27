import { z } from "zod";

const id = z.string().min(1).max(160);

const title = z.string().trim().min(1).max(120);

const description = z.string().trim().max(2000);

const revision = z.number().int().nonnegative();

export const workspaceSchema = z.object({
  projectId: id,
  environmentId: id.nullable(),
});

export const sourceLocatorSchema = z.object({
  name: z.string().min(1).max(160),
  provider: id.nullable(),
  scope: id,
  pluginId: id.nullable(),
  filePath: z.string().min(1).max(4096),
});

const relativePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a project-relative path without parent traversal.",
  );

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), source: sourceLocatorSchema }),
  z.object({ kind: z.literal("prompt"), promptId: id }),
  z.object({ kind: z.literal("reference"), path: relativePath }),
]);

export const collectionSchema = z.object({
  id,
  parentId: id.nullable(),
  title,
  description,
});

export const linkSchema = z.object({
  id,
  collectionId: id,
  title: title.optional(),
  role: z.literal("entry").optional(),
  target: targetSchema,
});

const promptFields = {
  title,
  body: z.string().min(1).max(65536),
  skillId: id.optional(),
};

export const promptSchema = z.object({ id, ...promptFields });

export const librarySchema = z.object({
  revision,
  collections: z.array(collectionSchema).max(500),
  links: z.array(linkSchema).max(3000),
  prompts: z.array(promptSchema).max(500),
});

export const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection.create"), parentId: id.nullable(), title, description }),
  z.object({ kind: z.literal("collection.update"), id, title, description }),
  z.object({
    kind: z.literal("collection.move"),
    id,
    parentId: id.nullable(),
    beforeId: id.optional(),
  }),
  z.object({ kind: z.literal("collection.remove"), id }),
  z.object({
    kind: z.literal("link.add"),
    collectionId: id,
    target: targetSchema,
    title: title.optional(),
    role: z.literal("entry").optional(),
  }),
  z.object({ kind: z.literal("link.update"), id, title: title.nullable() }),
  z.object({ kind: z.literal("link.move"), id, collectionId: id, beforeId: id.optional() }),
  z.object({ kind: z.literal("link.remove"), id }),
  z.object({ kind: z.literal("prompt.create"), ...promptFields }),
  z.object({ kind: z.literal("prompt.update"), id, ...promptFields }),
  z.object({ kind: z.literal("prompt.remove"), id }),
]);

export const applySchema = workspaceSchema.extend({ revision, operation: operationSchema });

export const packExportInput = workspaceSchema.extend({
  collectionId: id,
  publisher: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(40),
  license: z.string().trim().min(1).max(160),
});

export const packExportResult = z.object({ text: z.string(), digest: z.string() });

export type Workspace = z.infer<typeof workspaceSchema>;

export type SourceLocator = z.infer<typeof sourceLocatorSchema>;

export type Target = z.infer<typeof targetSchema>;

export type Collection = z.infer<typeof collectionSchema>;

export type LibraryLink = z.infer<typeof linkSchema>;

export type SavedPrompt = z.infer<typeof promptSchema>;

export type Library = z.infer<typeof librarySchema>;

export type LibraryOperation = z.infer<typeof operationSchema>;

export type LibraryApply = z.infer<typeof applySchema>;

export type PackExport = z.infer<typeof packExportInput>;
