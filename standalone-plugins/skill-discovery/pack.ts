import { z } from "zod";
import { readSkillMetadata, skillNameSchema } from "./skill-metadata.ts";

export const maxPackBytes = 768 * 1024;

const maxPackFiles = 256;

const packIdentifier = skillNameSchema;

export const packDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const packSlugSchema = packIdentifier;

const unicodeText = z.string().refine((text) => !/[\uD800-\uDFFF\0]/u.test(text));

const portableSegment = /^[a-z0-9_][a-z0-9._-]*$/iu;

const reservedSegment = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

const relativeFilePath = z
  .string()
  .max(240)
  .refine((path) => {
    const segments = path.split("/");

    return (
      segments.length <= 12 &&
      segments.every(
        (segment) =>
          segment.length <= 64 &&
          portableSegment.test(segment) &&
          !reservedSegment.test(segment) &&
          !segment.endsWith("."),
      )
    );
  }, "Expected a portable, skill-relative file path");

const fileSchema = z.object({ path: relativeFilePath, content: unicodeText }).strict();

const skillSchema = z
  .object({
    id: packIdentifier.refine((id) => !reservedSegment.test(id), "Expected a portable skill ID"),
    files: z.array(fileSchema).min(1).max(maxPackFiles),
  })
  .strict();

const layoutId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);

const shortTitle = unicodeText.pipe(z.string().min(1).max(120));

const summary = unicodeText.pipe(z.string().max(2048));

const layoutItem = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("skill"),
      skillId: packIdentifier,
      title: shortTitle.optional(),
      role: z.literal("entry").optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prompt"),
      promptIndex: z.number().int().min(0).max(79),
      title: shortTitle.optional(),
    })
    .strict(),
]);

const layoutNode = z
  .object({
    id: layoutId,
    parentId: layoutId.nullable(),
    title: shortTitle,
    description: summary,
    items: z.array(layoutItem).max(256),
  })
  .strict();

function validLayout(nodes: z.infer<typeof layoutNode>[], skills: Set<string>, prompts: number) {
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  let itemCount = 0;

  for (const node of nodes) {
    let ancestor = node.parentId;
    const chain = new Set([node.id]);

    while (ancestor !== null) {
      const next = parents.get(ancestor);

      if (next === undefined || chain.has(ancestor) || chain.size >= 20) return false;

      chain.add(ancestor);
      ancestor = next;
    }

    itemCount += node.items.length;

    if (
      node.items.some((item) =>
        item.kind === "skill" ? !skills.has(item.skillId) : item.promptIndex >= prompts,
      )
    ) {
      return false;
    }
  }

  return parents.size === nodes.length && itemCount <= 256;
}

function validateSkillPaths(files: z.infer<typeof fileSchema>[]): boolean {
  const paths = new Map<string, { path: string; isFile: boolean }>();

  for (const file of files) {
    const segments = file.path.split("/");

    for (let index = 1; index <= segments.length; index += 1) {
      const path = segments.slice(0, index).join("/");
      const key = path.toLowerCase();
      const isFile = index === segments.length;
      const existing = paths.get(key);

      if (existing && (existing.path !== path || existing.isFile || isFile)) return false;
      paths.set(key, { path, isFile });
    }
  }

  return true;
}

function validateSkillEntry(skill: z.infer<typeof skillSchema>): boolean {
  const entry = skill.files.find((file) => file.path === "SKILL.md");

  return entry !== undefined && readSkillMetadata(entry.content)?.name === skill.id;
}

export const skillPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    publisher: packIdentifier,
    slug: packSlugSchema,
    version: z
      .string()
      .max(48)
      .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/u),
    title: shortTitle,
    description: summary.pipe(z.string().min(1)),
    license: shortTitle,
    skills: z.array(skillSchema).max(40),
    prompts: z
      .array(
        z
          .object({
            title: shortTitle,
            body: unicodeText.pipe(
              z
                .string()
                .min(1)
                .max(24 * 1024),
            ),
            skillId: packIdentifier.optional(),
          })
          .strict(),
      )
      .max(80),
    layout: z.array(layoutNode).max(80).optional(),
  })
  .strict()
  .superRefine((pack, ctx) => {
    const ids = new Set(pack.skills.map((skill) => skill.id));

    if (pack.skills.length + pack.prompts.length === 0) {
      ctx.addIssue({ code: "custom", message: "Include at least one skill or prompt" });
    }

    if (ids.size !== pack.skills.length) {
      ctx.addIssue({ code: "custom", path: ["skills"], message: "Duplicate skill ID" });
    }

    if (pack.layout && !validLayout(pack.layout, ids, pack.prompts.length)) {
      ctx.addIssue({
        code: "custom",
        path: ["layout"],
        message: "Pack layout must contain an acyclic collection tree with valid item links",
      });
    }

    let fileCount = 0;

    for (const [index, skill] of pack.skills.entries()) {
      fileCount += skill.files.length;

      if (!validateSkillPaths(skill.files) || !validateSkillEntry(skill)) {
        ctx.addIssue({
          code: "custom",
          path: ["skills", index],
          message: "Files must have distinct portable paths and a matching SKILL.md",
        });
      }
    }

    if (fileCount > maxPackFiles) {
      ctx.addIssue({ code: "custom", path: ["skills"], message: "Too many files in pack" });
    }

    for (const [index, prompt] of pack.prompts.entries()) {
      if (prompt.skillId !== undefined && !ids.has(prompt.skillId)) {
        ctx.addIssue({
          code: "custom",
          path: ["prompts", index, "skillId"],
          message: "Linked skill is missing from pack",
        });
      }
    }
  });

export type SkillPack = z.infer<typeof skillPackSchema>;

export const packWorkspaceSchema = z.object({
  projectId: z.string().min(1).max(128),
  environmentId: z.string().min(1).max(128).nullable(),
});

export const packReviewInput = packWorkspaceSchema
  .extend({
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("local"),
          text: unicodeText.pipe(z.string().min(1).max(maxPackBytes)),
        })
        .strict(),
      z
        .object({
          kind: z.literal("markdown"),
          filename: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[^/\\\0]+\.md$/iu),
          text: unicodeText.pipe(z.string().min(1).max(maxPackBytes)),
        })
        .strict(),
      z
        .object({
          kind: z.literal("marketplace"),
          slug: z
            .string()
            .max(160)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          digest: packDigestSchema,
        })
        .strict(),
      z
        .object({ kind: z.literal("published"), slug: packSlugSchema, digest: packDigestSchema })
        .strict(),
    ]),
  })
  .strict();

export const packConfirmInput = z.object({ reviewId: z.uuid(), digest: packDigestSchema }).strict();

export const packReviewResult = packWorkspaceSchema.extend({
  reviewId: z.uuid(),
  digest: packDigestSchema,
  pack: skillPackSchema,
  destination: z.enum(["available", "installed", "recoverable"]),
  receipt: z.string().nullable(),
});

export const packConfirmResult = packWorkspaceSchema.extend({
  digest: packDigestSchema,
  pack: skillPackSchema,
  receipt: z.string(),
  collectionId: z.string().min(1),
});
