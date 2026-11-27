import {
  macBundleVersion,
  parseReleaseVersion,
} from "../../../packages/config/src/release-version.mjs";

const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "OMNYO_DESKTOP_RELEASE_CHANNEL";

export function desktopNativeVersion(version) {
  const parsed = parseReleaseVersion(version);

  if (parsed === null)
    throw new Error(
      `Desktop builds require an X.Y.Z or X.Y.Z+private.N version, got ${String(version)}`,
    );

  const buildNumber = parsed.revision === null ? "0" : String(parsed.revision);

  return {
    shortVersion: parsed.numeric,
    bundleVersion: macBundleVersion(version),
    buildNumber,
    buildVersion: `${parsed.numeric}.${buildNumber}`,
  };
}

export function resolveDesktopReleaseChannel(env) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();

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
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest, nightly or public-beta, got ${rawChannel}.`,
  );
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }

  if (nodePlatform === "linux") {
    return "linux";
  }

  if (nodePlatform === "win32") {
    return "windows";
  }

  throw new Error(
    `Desktop builds support darwin, linux, and win32 only, got ${nodePlatform}.`,
  );
}

export function desktopReleaseIdentity(channel) {
  if (channel === "public-beta")
    return {
      applicationName: "Omnyo",
      profileName: "Omnyo",
      channel,
      iconFileName: "icon.png",
      releaseTag: "desktop-public-beta",
    };

  const nightly = channel === "nightly";

  return {
    applicationName: nightly ? "Omnyo Nightly" : "Omnyo",
    channel,
    iconFileName: nightly ? "icon-nightly.png" : "icon.png",
    profileName: nightly ? "Omnyo Private Nightly" : "Omnyo Private",
    releaseTag: nightly ? "desktop-nightly" : "desktop-latest",
  };
}

export function createDesktopReleaseConfig(channel, buildPlatform) {
  if (
    !["latest", "nightly", "public-beta"].includes(channel) ||
    !["macos", "windows", "linux"].includes(buildPlatform)
  )
    throw new Error("Desktop release requires its exact channel and platform");

  const { channel: _channel, ...identity } = desktopReleaseIdentity(channel);

  if (channel === "public-beta") {
    if (buildPlatform !== "macos")
      throw new Error("Public beta preparation is macOS only");

    return {
      ...createDesktopReleaseConfig("latest", "macos"),
      ...identity,
      appId: "dev.omnyo.beta",
      artifactName: "omnyo-${version}-${arch}.${ext}",
    };
  }

  if (channel === "nightly") {
    return {
      ...identity,
      appId: "dev.omnyo.private.nightly",
      artifactName: "omnyo-private-nightly-${version}-${arch}.${ext}",

      linuxExecutableName: "omnyo-private-nightly",
      macIconPath: "assets/icon-nightly.icns",
      windowsInstallGuid: null,
      windowsInstallName: "omnyo-private-nightly",
      updateMetadataFileNames: {
        linux: "nightly-linux.yml",
        macos: "nightly-mac.yml",
        windows: "nightly.yml",
      },
    };
  }

  return {
    ...identity,
    appId: "dev.omnyo.private",
    artifactName: "omnyo-private-${version}-${arch}.${ext}",
    linuxExecutableName: "omnyo-private",
    macIconPath: "assets/icon.icns",
    windowsInstallGuid: "11c43a4e-5f09-59c3-a447-6f25f5982512",
    windowsInstallName: "omnyo-private",
    updateMetadataFileNames: {
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
      windows: "latest.yml",
    },
  };
}

export function desktopBuildSelection(channel) {
  if (!["latest", "nightly", "public-beta"].includes(channel))
    throw new Error("Unknown desktop build selection");

  return {
    privateContinuity: channel !== "public-beta",
    outputDirectory: channel === "public-beta" ? "dist-public-beta" : "dist",
    excludedArtifacts:
      channel === "public-beta"
        ? [
            "desktop-profile-adoption-v1.cjs",
            "desktop-profile-adoption-v1.cjs.map",
            "desktop-profile-continuity-entry-v2.cjs",
            "desktop-profile-continuity-entry-v2.cjs.map",
            "desktop-protected-store-reader-v1",
            "desktop-protected-store-writer-v1",
            "desktop-keychain-ui-fence-v1.node",
            "desktop-protected-store-compiled-v1.json",
            "private-electron-trust-probe.cjs",
          ]
        : [],
  };
}
