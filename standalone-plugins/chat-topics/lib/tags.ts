import { z } from "zod";
import { singleLine } from "./naming.ts";

export const NO_TAG = "none";

export const MAX_TAGS = 12;

export const tagIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,23}$/u, "Use 1–24 lowercase letters, digits or hyphens.")
  .refine((id) => id !== NO_TAG, `The id "${NO_TAG}" means no tag.`);

export const tagLabelSchema = singleLine.pipe(z.string().min(1, "Enter a label.").max(24));

export const tagIconSchema = singleLine.pipe(z.string().min(1, "Enter an icon.").max(16));

export const tagDescriptionSchema = singleLine.pipe(z.string().max(80));

export const tagSchema = z.object({
  id: tagIdSchema,
  label: tagLabelSchema,
  icon: tagIconSchema,
  description: tagDescriptionSchema,
});

export type Tag = z.output<typeof tagSchema>;

export const tagListSchema = z
  .array(tagSchema)
  .max(MAX_TAGS, `Keep at most ${MAX_TAGS} tags.`)
  .refine((tags) => new Set(tags.map((tag) => tag.id)).size === tags.length, "Tag ids repeat.");

export const tagPatchSchema = z
  .object({
    label: tagLabelSchema.optional(),
    icon: tagIconSchema.optional(),
    description: tagDescriptionSchema.optional(),
  })
  .strict();

export type TagPatch = z.output<typeof tagPatchSchema>;

export const DEFAULT_TAGS: readonly Tag[] = [
  { id: "fix", icon: "Bug", label: "Fix", description: "defects, regressions" },
  { id: "build", icon: "Code", label: "Build", description: "features, refactors" },
  { id: "ship", icon: "Sent", label: "Ship", description: "releases, deploys, store submissions" },
  {
    id: "ops",
    icon: "Settings",
    label: "Ops",
    description: "infra, accounts, email, billing, machines",
  },
  {
    id: "research",
    icon: "Search",
    label: "Research",
    description: "questions, audits, investigations",
  },
  { id: "design", icon: "Palette", label: "Design", description: "UI, copy, mockups" },
];

const ICON_NAME = /^[A-Z][A-Za-z0-9]*$/u;

export function isIconName(icon: string): boolean {
  return ICON_NAME.test(icon);
}

export const TAG_SOURCES = ["prediction", "first-turn", "user"] as const;

export type TagSource = (typeof TAG_SOURCES)[number];

const AUTHORITY: Readonly<Record<TagSource, number>> = {
  prediction: 0,
  "first-turn": 1,
  user: 2,
};

export const tagRecordSchema = z.object({
  v: z.literal(1),
  tagId: z.string().nullable(),
  source: z.enum(TAG_SOURCES),
  updatedAt: z.number(),
});

export type TagRecord = z.infer<typeof tagRecordSchema>;

export const metadataTagSchema = z
  .object({ tag: tagRecordSchema.nullable().catch(null) })
  .transform(({ tag }) => tag)
  .catch(null);

export function findTag(tags: readonly Tag[], id: string | null): Tag | null {
  return id === null ? null : (tags.find((tag) => tag.id === id) ?? null);
}

export function effectiveTagId(record: TagRecord | null, tags: readonly Tag[]): string | null {
  return findTag(tags, record?.tagId ?? null)?.id ?? null;
}

export function outranks(source: TagSource, current: TagRecord | null, tags: readonly Tag[]) {
  return (
    current === null ||
    AUTHORITY[source] >= AUTHORITY[current.source] ||
    (current.source !== "user" && effectiveTagId(current, tags) === null)
  );
}

export function accepts(
  source: TagSource,
  tagId: string | null,
  current: TagRecord | null,
  tags: readonly Tag[],
): boolean {
  if (!outranks(source, current, tags)) return false;

  return source !== "prediction" || tagId !== null || effectiveTagId(current, tags) !== null;
}

export function unknownTagMessage(id: string, tags: readonly Tag[]): string {
  return `No tag "${id}". Tags: ${tags.map((tag) => tag.id).join(", ") || "none"}.`;
}

function indexOf(tags: readonly Tag[], id: string): number {
  const index = tags.findIndex((tag) => tag.id === id);

  if (index < 0) throw new Error(unknownTagMessage(id, tags));

  return index;
}

export function addTag(tags: readonly Tag[], tag: Tag): Tag[] {
  if (tags.some((existing) => existing.id === tag.id))
    throw new Error(`The tag "${tag.id}" already exists.`);

  return tagListSchema.parse([...tags, tag]);
}

export function updateTag(tags: readonly Tag[], id: string, patch: TagPatch): Tag[] {
  const index = indexOf(tags, id);

  return tagListSchema.parse(
    tags.map((tag, at) =>
      at === index
        ? {
            id: tag.id,
            label: patch.label ?? tag.label,
            icon: patch.icon ?? tag.icon,
            description: patch.description ?? tag.description,
          }
        : tag,
    ),
  );
}

export function removeTag(tags: readonly Tag[], id: string): Tag[] {
  const index = indexOf(tags, id);

  return tags.filter((_, at) => at !== index);
}

export function moveTag(tags: readonly Tag[], id: string, to: number): Tag[] {
  const index = indexOf(tags, id);
  const next = tags.filter((_, at) => at !== index);
  const target = Math.max(0, Math.min(next.length, Math.trunc(to)));

  next.splice(target, 0, tags[index]);

  return next;
}

export function tagInstruction(tags: readonly Tag[]): string {
  if (tags.length === 0) return "";

  const choices = tags
    .map((tag) => (tag.description === "" ? tag.id : `${tag.id} (${tag.description})`))
    .join(", ");

  return ` Also pass tag, the one id that names this chat's type of work: ${choices}. Omit tag when none fits.`;
}
