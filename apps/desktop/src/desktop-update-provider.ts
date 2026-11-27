import type { OmnyoDesktopInfo } from "@omnyo/desktop-contract";

type DesktopReleaseChannel = "latest" | "nightly" | "public-beta";

interface DesktopReleaseInfo {
  applicationName: "Omnyo" | "Omnyo Nightly";
  channel: DesktopReleaseChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  profileName: "Omnyo Private" | "Omnyo Private Nightly" | "Omnyo";
  releaseTag: "desktop-latest" | "desktop-nightly" | "desktop-public-beta";
}

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
): DesktopReleaseInfo {
  if (channel === "public-beta")
    return {
      applicationName: "Omnyo",
      profileName: "Omnyo",
      channel,
      iconFileName: "icon.png",
      releaseTag: "desktop-public-beta",
    };
  const nightly = channel === "nightly";
  const releaseTag = nightly ? "desktop-nightly" : "desktop-latest";

  return {
    applicationName: nightly ? "Omnyo Nightly" : "Omnyo",
    channel,
    iconFileName: nightly ? "icon-nightly.png" : "icon.png",
    profileName: nightly ? "Omnyo Private Nightly" : "Omnyo Private",
    releaseTag,
  };
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
