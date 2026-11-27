import { maxPackBytes, packSlugSchema, skillPackSchema } from "./pack.ts";
import { readSkillMetadata } from "./skill-metadata.ts";

export function skillFileSource(filename: string, text: string) {
  if (/\.omnyoskillpack$/iu.test(filename)) return { kind: "local", text } as const;

  if (!/\.md$/iu.test(filename)) throw new Error("Choose a Markdown (.md) file or a skill pack.");

  return { kind: "markdown", filename, text } as const;
}

export function markdownSkillPack({
  filename,
  text,
  license = "Unspecified",
  allowPlain = true,
}: {
  filename: string;
  text: string;
  license?: string;
  allowPlain?: boolean;
}) {
  if (!text.trim()) throw new Error("Choose a Markdown file with instructions.");

  if (new TextEncoder().encode(text).byteLength > maxPackBytes)
    throw new Error("The Markdown file exceeds 768 KiB.");

  const metadata = readSkillMetadata(text);

  if (metadata === null && (!allowPlain || /^(?:\uFEFF)?---[ \t]*\r?\n/u.test(text)))
    throw new Error("SKILL.md needs valid name and description frontmatter.");

  const stem = filename.replace(/\.md$/iu, "");
  const title = (stem.toLowerCase() === "skill" ? /^#\s+(.+)$/mu.exec(text)?.[1] : stem)?.trim();

  const name =
    metadata?.name ??
    title
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");

  const parsed = packSlugSchema.safeParse(name);

  if (!parsed.success)
    throw new Error("Use a filename or skill name with up to 64 letters, numbers, or hyphens.");

  const description = metadata?.description ?? `Imported from ${filename}.`;

  const content = metadata
    ? text
    : `---\nname: ${parsed.data}\ndescription: ${JSON.stringify(description)}\n---\n\n${text.replace(/^\uFEFF/u, "")}`;

  return skillPackSchema.parse({
    schemaVersion: 1,
    publisher: "local",
    slug: parsed.data,
    version: "1.0.0",
    title: (metadata?.name ?? title ?? parsed.data).slice(0, 120),
    description,
    license,
    skills: [{ id: parsed.data, files: [{ path: "SKILL.md", content }] }],
    prompts: [],
  });
}
