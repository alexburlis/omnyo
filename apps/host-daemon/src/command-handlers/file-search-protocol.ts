import { z } from "zod";

export const fileSearchRequestSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["files", "paths"]),
  discovery: z.literal("icons").optional(),
  root: z.string(),
  includeFiles: z.boolean(),
  includeDirectories: z.boolean(),
  includeHidden: z.boolean(),
  excludeNames: z.array(z.string()),
  respectGitIgnore: z.boolean(),
  limit: z.number().int(),
  query: z.string().optional(),
});

export type FileSearchRequest = z.infer<typeof fileSearchRequestSchema>;

export type FileSearchQuery = Omit<FileSearchRequest, "id">;

export const fileSearchResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);

export type FileSearchResponse = z.infer<typeof fileSearchResponseSchema>;
