import { z } from "zod";

const isoUtcDateTimeSchema = z.iso.datetime();

const omnyoDesktopVersionFeedFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const omnyoDesktopVersionFeedPlatformSchema = z.enum([
  "macos",
  "linux",
  "windows",
]);

export type OmnyoDesktopVersionFeedPlatform = z.infer<
  typeof omnyoDesktopVersionFeedPlatformSchema
>;

export const omnyoDesktopVersionFeedSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["latest", "nightly"]),
  platform: omnyoDesktopVersionFeedPlatformSchema,
  version: z.string().min(1),
  releaseDate: isoUtcDateTimeSchema,
  releaseName: z.string().min(1),
  releaseNotes: z.string().nullable(),
  minimumSystemVersion: z.string().min(1).nullable(),
  files: z.array(omnyoDesktopVersionFeedFileSchema).min(1),
  path: z.string().min(1),
  sha512: z.string().min(1),
  stagingPercentage: z.number().min(0).max(100).nullable(),
});

export type OmnyoDesktopVersionFeed = z.infer<
  typeof omnyoDesktopVersionFeedSchema
>;

const OMNYO_DESKTOP_VERSION_FEED_FILE_NAMES = {
  linux: "desktop-version-linux.json",
  macos: "desktop-version.json",
  windows: "desktop-version-windows.json",
} as const satisfies Record<OmnyoDesktopVersionFeedPlatform, string>;

export function createOmnyoDesktopVersionFeedFileName(
  platform: OmnyoDesktopVersionFeedPlatform,
): string {
  return OMNYO_DESKTOP_VERSION_FEED_FILE_NAMES[platform];
}
