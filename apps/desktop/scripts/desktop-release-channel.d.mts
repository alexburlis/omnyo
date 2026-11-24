export type DesktopReleaseChannel = "latest" | "nightly" | "public-beta";

export type DesktopBuildPlatform = "macos" | "linux" | "windows";

export interface DesktopUpdateMetadataFileNames {
  linux: "latest-linux.yml" | "nightly-linux.yml";
  macos: "latest-mac.yml" | "nightly-mac.yml";
  windows: "latest.yml" | "nightly.yml";
}

export interface DesktopReleaseConfig {
  appId: "dev.omnyo.beta" | "dev.omnyo.private" | "dev.omnyo.private.nightly";
  applicationName: "Omnyo" | "Omnyo Nightly";
  profileName: "Omnyo Private" | "Omnyo Private Nightly" | "Omnyo";
  artifactName: string;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxExecutableName: "omnyo-private" | "omnyo-private-nightly";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
  releaseTag: "desktop-latest" | "desktop-nightly" | "desktop-public-beta";
  updateMetadataFileNames: DesktopUpdateMetadataFileNames;
  windowsInstallGuid: "11c43a4e-5f09-59c3-a447-6f25f5982512" | null;
  windowsInstallName: "omnyo-private" | "omnyo-private-nightly";
}

export interface DesktopNativeVersion {
  shortVersion: string;
  bundleVersion: string;
  buildNumber: string;
  buildVersion: string;
}

export function desktopNativeVersion(version: string): DesktopNativeVersion;

export function resolveDesktopReleaseChannel(
  env: NodeJS.ProcessEnv,
): DesktopReleaseChannel;

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
  buildPlatform: DesktopBuildPlatform,
): DesktopReleaseConfig;

export function desktopBuildSelection(channel: DesktopReleaseChannel): {
  privateContinuity: boolean;
  outputDirectory: string;
  excludedArtifacts: string[];
};
