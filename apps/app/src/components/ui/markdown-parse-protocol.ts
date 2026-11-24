import type { Root } from "mdast";
import { z } from "zod";

export const markdownParseRequestSchema = z.object({
  id: z.number().int().positive(),
  source: z.string(),
  directives: z.boolean(),
});

const markdownNodeSchema = z.looseObject({
  type: z.string(),
  get children(): z.ZodOptional<z.ZodArray<typeof markdownNodeSchema>> {
    return z.array(markdownNodeSchema).optional();
  },
});

const markdownRootSchema = z.object({
  type: z.literal("root"),
  children: z.array(markdownNodeSchema),
});

const rootSchema = z.custom<Root>(
  (value) => markdownRootSchema.safeParse(value).success,
);

export const markdownParseResponseSchema = z.union([
  markdownParseRequestSchema.extend({ tree: rootSchema }),
  markdownParseRequestSchema.extend({ error: z.string() }),
]);

export type MarkdownParseRequest = z.infer<typeof markdownParseRequestSchema>;

export type MarkdownParseResponse = z.infer<typeof markdownParseResponseSchema>;
