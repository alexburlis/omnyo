import { MACOS_DOWNLOAD_URL } from "./site";

export type PlatformId = "mac" | "windows" | "ios" | "web" | "android";

export interface Platform {
  id: PlatformId;
  name: string;
  action: string;
  href?: string;
  soon?: boolean;
}

export const PLATFORMS: readonly Platform[] = [
  { id: "mac", name: "Mac", action: "Download", href: MACOS_DOWNLOAD_URL },
  { id: "windows", name: "Windows", action: "Download" },
  { id: "ios", name: "iOS", action: "App Store" },
  { id: "web", name: "Web", action: "Open" },
  { id: "android", name: "Android", action: "Soon", soon: true },
];

export const PLATFORM_LINE = "Mac · Windows · iOS · Web · Android soon";

export const PLATFORMS_ANCHOR = "/#download";

export interface DirectDownload {
  id: "mac" | "windows" | "ios";
  label: string;
  tabletLabel?: string;
  note: string;
}

export const DIRECT_DOWNLOADS: readonly DirectDownload[] = [
  {
    id: "mac",
    label: "Download for Mac",
    note: "Apple Silicon · macOS 13 or later",
  },
  {
    id: "windows",
    label: "Download for Windows",
    note: "64-bit Windows",
  },
  {
    id: "ios",
    label: "Get Omnyo for iPhone",
    tabletLabel: "Get Omnyo for iPad",
    note: "For iPhone and iPad",
  },
];

export const FALLBACK_DOWNLOAD = {
  label: "Get Omnyo",
  note: "Pick your platform below",
} as const;

export const platformHref = (id: PlatformId) =>
  PLATFORMS.find((platform) => platform.id === id)?.href;
