import type { OmnyoDesktopInfo } from "@omnyo/desktop-contract";

export function getDesktopVersion(version: string | undefined): string {
  if (version === undefined || version.length === 0) {
    throw new Error("Desktop version must be injected at build time");
  }

  return version;
}

export function resolveDesktopPlatform(
  platform: NodeJS.Platform,
): OmnyoDesktopInfo["platform"] {
  if (platform === "darwin") {
    return "macos";
  }

  return platform === "win32" ? "windows" : "linux";
}
