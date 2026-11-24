import type { DesktopAutoUpdateFeedConfig } from "./desktop-update-provider.js";

export const PUBLIC_BETA_UPDATE_APP_ID = "dev.omnyo.beta";

export const PUBLIC_BETA_UPDATE_URL =
  "https://github.com/alexburlis/omnyo-releases/releases/download/macos/";

export function publicBetaUpdateFeed(): DesktopAutoUpdateFeedConfig {
  return {
    provider: "generic",
    channel: "public-beta",
    url: PUBLIC_BETA_UPDATE_URL,
  };
}

export function assertPublicBetaUpdatePolicy(
  feed: DesktopAutoUpdateFeedConfig,
  appId: string | undefined,
  platform: string,
): void {
  if (feed.channel !== "public-beta" && appId !== PUBLIC_BETA_UPDATE_APP_ID)
    return;

  if (
    feed.provider !== "generic" ||
    feed.channel !== "public-beta" ||
    feed.url !== PUBLIC_BETA_UPDATE_URL ||
    appId !== PUBLIC_BETA_UPDATE_APP_ID ||
    platform !== "macos"
  )
    throw new Error(
      "Public macOS update policy differs from the pinned distribution",
    );
}
