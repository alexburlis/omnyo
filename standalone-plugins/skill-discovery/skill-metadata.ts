import { parseDocument } from "yaml";
import { z } from "zod";

export const skillFrontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

export const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const metadataSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
});

export function readSkillMetadata(content: string) {
  const block = skillFrontmatter.exec(content);

  if (!block) return null;

  try {
    const document = parseDocument(block[1], { version: "1.2", uniqueKeys: true });

    if (document.errors.length > 0) return null;
    const result = metadataSchema.safeParse(document.toJS({ maxAliasCount: 20 }));

    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
