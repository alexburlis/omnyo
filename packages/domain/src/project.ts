import { z } from "zod";

export const PERSONAL_PROJECT_ID = "proj_personal";

const projectKindValues = ["standard", "personal"] as const;

const projectKindSchema = z.enum(projectKindValues);

export type ProjectKind = z.infer<typeof projectKindSchema>;

export const MAX_PROJECT_ICON_BYTES = 48 * 1024;

export const projectCustomIconSchema = z
  .string()
  .max(22 + Math.ceil(MAX_PROJECT_ICON_BYTES / 3) * 4)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u)
  .refine((value) => {
    try {
      const bytes = atob(value.slice(22));

      if (bytes.length < 45 || bytes.length > MAX_PROJECT_ICON_BYTES)
        return false;

      if (
        !bytes.startsWith("\x89PNG\r\n\x1a\n") ||
        bytes.slice(12, 16) !== "IHDR" ||
        bytes.slice(-8, -4) !== "IEND"
      )
        return false;

      const readUint32 = (offset: number) =>
        bytes.charCodeAt(offset) * 0x1000000 +
        (bytes.charCodeAt(offset + 1) << 16) +
        (bytes.charCodeAt(offset + 2) << 8) +
        bytes.charCodeAt(offset + 3);

      if (readUint32(8) !== 13) return false;
      let offset = 8;
      let hasImageData = false;

      while (offset + 12 <= bytes.length) {
        const length = readUint32(offset);
        const end = offset + 12 + length;

        if (end > bytes.length) return false;
        const type = bytes.slice(offset + 4, offset + 8);

        if (type === "IDAT" && length > 0) hasImageData = true;

        if (type === "IEND") {
          if (length !== 0 || end !== bytes.length) return false;
          offset = end;
          break;
        }

        offset = end;
      }

      return (
        hasImageData &&
        offset === bytes.length &&
        readUint32(16) > 0 &&
        readUint32(16) <= 512 &&
        readUint32(20) > 0 &&
        readUint32(20) <= 512
      );
    } catch {
      return false;
    }
  }, "Use a PNG icon up to 512 × 512 pixels and 48 KiB");

export const projectSchema = z.object({
  id: z.string(),
  kind: projectKindSchema,
  name: z.string(),
  gitRemoteUrl: z.string().nullable(),
  customIcon: projectCustomIconSchema.nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Project = z.infer<typeof projectSchema>;

const projectSourceTypeValues = ["local_path"] as const;

const projectSourceTypeSchema = z.enum(projectSourceTypeValues);

export type ProjectSourceType = z.infer<typeof projectSourceTypeSchema>;

const baseProjectSourceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  isDefault: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const localPathProjectSourceSchema = baseProjectSourceSchema.extend({
  type: z.literal("local_path"),
  hostId: z.string(),
  path: z.string(),
});

export type LocalPathProjectSource = z.infer<
  typeof localPathProjectSourceSchema
>;

export const projectSourceSchema = localPathProjectSourceSchema;

export type ProjectSource = z.infer<typeof projectSourceSchema>;

export function isLocalPathProjectSource(
  source: ProjectSource,
): source is LocalPathProjectSource {
  return source.type === "local_path";
}

export function findLocalPathProjectSourceForHost(
  sources: readonly ProjectSource[],
  hostId: string,
): LocalPathProjectSource | undefined {
  return sources.find(
    (source): source is LocalPathProjectSource =>
      source.type === "local_path" && source.hostId === hostId,
  );
}
