import type { OmnyoDesktopInfo } from "@omnyo/desktop-contract";
import {
  desktopReleaseIdentity,
  type DesktopReleaseChannel,
  type DesktopReleaseIdentity,
} from "../scripts/desktop-release-channel.mjs";

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
): DesktopReleaseIdentity {
  return desktopReleaseIdentity(channel);
}

function resolveBuiltDesktopReleaseChannel(
  rawChannel: string | undefined,
): DesktopReleaseChannel {
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }

  if (
    rawChannel === "latest" ||
    rawChannel === "nightly" ||
    rawChannel === "public-beta"
  ) {
    return rawChannel;
  }

  throw new Error(
    `Built desktop release channel must be latest, nightly or public-beta, got ${String(rawChannel)}.`,
  );
}

export const DESKTOP_RELEASE_CHANNEL = resolveBuiltDesktopReleaseChannel(
  process.env.OMNYO_DESKTOP_RELEASE_CHANNEL,
);

export const DESKTOP_RELEASE_INFO = createDesktopReleaseInfo(
  DESKTOP_RELEASE_CHANNEL,
);

export interface DesktopAutoUpdateFeedConfig {
  channel: DesktopReleaseChannel;
  provider: "generic";
  url: string;
}

interface DesktopUpdateSupport {
  autoUpdate: boolean;
  versionCheck: boolean;
}

export function resolveDesktopUpdateSupport(
  args: {
    feedConfig?: DesktopAutoUpdateFeedConfig | null;
    platform?: OmnyoDesktopInfo["platform"];
  } = {},
): DesktopUpdateSupport {
  return {
    autoUpdate:
      args.feedConfig != null &&
      (args.platform === "macos" || args.platform === "windows"),
    versionCheck: false,
  };
}
