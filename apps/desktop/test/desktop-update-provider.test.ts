import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseInfo,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";
import { createDesktopReleaseConfig } from "../scripts/desktop-release-channel.mjs";

describe("private desktop update support", () => {
  it("disables binary installation and official version checks", () => {
    expect(resolveDesktopUpdateSupport()).toEqual({
      autoUpdate: false,
      versionCheck: false,
    });
  });
  it("enables only configured macOS native updates and keeps the JSON version checker disabled", () => {
    const feedConfig = {
      provider: "generic" as const,
      channel: "latest" as const,
      url: "https://fixture.invalid/",
    };

    expect(
      resolveDesktopUpdateSupport({ feedConfig, platform: "macos" }),
    ).toEqual({ autoUpdate: true, versionCheck: false });
    expect(
      resolveDesktopUpdateSupport({ feedConfig, platform: "linux" }),
    ).toEqual({ autoUpdate: false, versionCheck: false });
  });
  it("shows Omnyo while keeping the existing Omnyo Private profile identity", () => {
    expect(createDesktopReleaseInfo("latest")).toMatchObject({
      applicationName: "Omnyo",
      profileName: "Omnyo Private",
    });
    expect(createDesktopReleaseInfo("nightly")).toMatchObject({
      applicationName: "Omnyo Nightly",
      profileName: "Omnyo Private Nightly",
    });
    expect(createDesktopReleaseConfig("latest", "macos")).toMatchObject({
      appId: "dev.omnyo.private",
      applicationName: "Omnyo",
      profileName: "Omnyo Private",
      artifactName: "omnyo-private-${version}-${arch}.${ext}",
      updateMetadataFileNames: { macos: "latest-mac.yml" },
    });
  });
});
