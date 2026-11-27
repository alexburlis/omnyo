import { parseDocument } from "yaml";
import { z } from "zod";
import { skillPackSchema } from "./pack.ts";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const sourceFile = z.object({ path: z.string(), url: z.url(), sha256 }).strict();

const artifact = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("github-files"), files: z.array(sourceFile).min(1).max(256) })
    .strict(),
  z.object({ kind: z.literal("skill-md"), url: z.url(), sha256 }).strict(),
  z.object({ kind: z.literal("tar-gzip"), url: z.url(), sha256 }).strict(),
]);

export const curatedEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/u),
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    publisher: z.string().min(1).max(120),
    description: z.string().min(1).max(1024),
    sourceUrl: z.url(),
    license: z.literal("MIT"),
    useOnce: z.boolean(),
    pin: z.string().regex(/^[a-f0-9]{40}$/u),
    artifact,
    notice: z
      .object({
        path: z.literal("LICENSE.curated.txt"),
        content: z.string().min(100),
        sourceUrl: z.url(),
      })
      .strict(),
    useOnceReview: z
      .object({ skillSha256: sha256, reason: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.useOnce !== (entry.useOnceReview !== null)) {
      context.addIssue({
        code: "custom",
        message: "Use-once eligibility requires an exact reviewed digest.",
      });
    }

    const urls =
      entry.artifact.kind === "github-files"
        ? entry.artifact.files.map((file) => file.url)
        : [entry.artifact.url];

    for (const url of [...urls, entry.sourceUrl, entry.notice.sourceUrl]) {
      const parsed = new URL(url);

      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        !parsed.pathname.includes(entry.pin)
      ) {
        context.addIssue({
          code: "custom",
          message: "Every source must be an immutable HTTPS URL at the reviewed pin.",
        });
      }
    }
  });

export type CuratedEntry = z.infer<typeof curatedEntrySchema>;

export type CuratedFile = { path: string; content: string };

const curatedCatalogSchema = z
  .array(curatedEntrySchema)
  .min(1)
  .max(100)
  .superRefine((entries, context) => {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      context.addIssue({ code: "custom", message: "The curated catalog contains a duplicate ID." });
    }
  });

export const validateCuratedEntries = curatedCatalogSchema.parse;

export function validateCuratedFiles(entry: CuratedEntry, files: CuratedFile[]): CuratedFile[] {
  const pack = skillPackSchema.parse({
    schemaVersion: 1,
    publisher: "curated",
    slug: entry.name,
    version: "1.0.0",
    title: entry.name,
    description: entry.description,
    license: entry.license,
    skills: [{ id: entry.name, files }],
    prompts: [],
  });

  const skill = pack.skills[0];

  if (!skill) throw new Error("The curated skill has no files.");
  const markdown = skill.files.find((file) => file.path === "SKILL.md");

  if (!markdown) throw new Error("The curated skill has no SKILL.md.");
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---/u.exec(markdown.content);

  const invocation = z
    .object({
      "disable-model-invocation": z.boolean().optional(),
      "user-invocable": z.boolean().optional(),
    })
    .parse(parseDocument(frontmatter?.[1] ?? "").toJS({ maxAliasCount: 20 }));

  if (
    entry.useOnce &&
    (invocation["disable-model-invocation"] || invocation["user-invocable"] === false)
  ) {
    throw new Error("The reviewed skill does not permit one-time invocation.");
  }

  return [...skill.files].sort((left, right) => left.path.localeCompare(right.path, "en"));
}
