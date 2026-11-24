import { z } from "zod";

export const WEB_ASSETS_API_PATH = "/api/v1/system/web-assets";

export const webAssetPathSchema = z
  .string()
  .regex(/^\/assets\/[^/]+\.(?:js|css)$/u);

export const webAssetSchema = z
  .object({
    path: webAssetPathSchema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const webAssetManifestSchema = z
  .object({
    generation: z.string().min(1),
    boot: z.array(webAssetPathSchema),
    assets: z.array(webAssetSchema),
  })
  .strict();

export type WebAsset = z.infer<typeof webAssetSchema>;

export type WebAssetManifest = z.infer<typeof webAssetManifestSchema>;
