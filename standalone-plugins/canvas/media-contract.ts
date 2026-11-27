import { z } from "zod";

export const mediaVariantSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string(),
  mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  lossless: z.literal(true),
});

export const mediaManifestSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  animated: z.boolean(),
  originalUrl: z.string(),
  variants: z.array(mediaVariantSchema).min(1),
});

export type MediaManifest = z.infer<typeof mediaManifestSchema>;
