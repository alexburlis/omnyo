import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopReleaseInfo,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "../scripts/desktop-release-channel.mjs";

const releaseIdentities = [
  {
    channel: "latest",
    applicationName: "Omnyo",
    profileName: "Omnyo Private",
    iconFileName: "icon.png",
    releaseTag: "desktop-latest",
  },
  {
    channel: "nightly",
    applicationName: "Omnyo Nightly",
    profileName: "Omnyo Private Nightly",
    iconFileName: "icon-nightly.png",
    releaseTag: "desktop-nightly",
  },
  {
    channel: "public-beta",
    applicationName: "Omnyo",
    profileName: "Omnyo",
    iconFileName: "icon.png",
    releaseTag: "desktop-public-beta",
  },
] as const;

describe("desktop release identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(releaseIdentities)(
    "preserves $channel runtime and build identity",
    (expected) => {
      expect(createDesktopReleaseInfo(expected.channel)).toEqual(expected);
      const { channel, ...identity } = expected;
      const config = createDesktopReleaseConfig(channel, "macos");
      expect(config).toMatchObject(identity);
      expect(config).not.toHaveProperty("channel");
    },
  );

  it.each([undefined, "", "latest", "nightly", "public-beta"])(
    "preserves the accepted runtime/build input %s",
    async (input) => {
      vi.stubEnv("OMNYO_DESKTOP_RELEASE_CHANNEL", input);
      vi.resetModules();
      const runtime = await import("../src/desktop-update-provider.js");
      expect(runtime.DESKTOP_RELEASE_CHANNEL).toBe(input || "latest");
      expect(resolveDesktopReleaseChannel(process.env)).toBe(input || "latest");
    },
  );

  it.each([" ", " latest ", " nightly ", " public-beta ", "invalid"])(
    "preserves distinct build/runtime parsing of %s",
    async (input) => {
      vi.stubEnv("OMNYO_DESKTOP_RELEASE_CHANNEL", input);
      vi.resetModules();
      await expect(import("../src/desktop-update-provider.js")).rejects.toThrow(
        `Built desktop release channel must be latest, nightly or public-beta, got ${input}.`,
      );

      if (input === "invalid") {
        expect(() => resolveDesktopReleaseChannel(process.env)).toThrow(
          "OMNYO_DESKTOP_RELEASE_CHANNEL must be latest, nightly or public-beta, got invalid.",
        );
      } else {
        expect(resolveDesktopReleaseChannel(process.env)).toBe(
          input.trim() || "latest",
        );
      }
    },
  );

  it.each(releaseIdentities)(
    "bundles the $channel runtime identity without runtime imports",
    async (expected) => {
      const result = await build({
        entryPoints: [resolve(__dirname, "../src/desktop-update-provider.ts")],
        bundle: true,
        write: false,
        format: "cjs",
        platform: "node",
        target: "node24",
        metafile: true,
        define: {
          "process.env.OMNYO_DESKTOP_RELEASE_CHANNEL": JSON.stringify(
            expected.channel,
          ),
        },
      });

      const source = result.outputFiles[0]?.text;
      expect(source).toBeDefined();

      for (const output of Object.values(result.metafile.outputs))
        expect(output.imports).toEqual([]);
      const module = { exports: {} };
      runInNewContext(source ?? "", { module, exports: module.exports });
      expect(module.exports).toMatchObject({ DESKTOP_RELEASE_INFO: expected });
    },
  );
});

describe("private desktop update support", () => {
  it("disables binary installation and official version checks", () => {
    expect(resolveDesktopUpdateSupport()).toEqual({
      autoUpdate: false,
      versionCheck: false,
    });
  });
  it("enables configured macOS and Windows native updates and keeps the JSON version checker disabled", () => {
    const feedConfig = {
      provider: "generic" as const,
      channel: "latest" as const,
      url: "https://fixture.invalid/",
    };

    expect(
      resolveDesktopUpdateSupport({ feedConfig, platform: "macos" }),
    ).toEqual({ autoUpdate: true, versionCheck: false });
    expect(
      resolveDesktopUpdateSupport({ feedConfig, platform: "windows" }),
    ).toEqual({ autoUpdate: true, versionCheck: false });
    expect(
      resolveDesktopUpdateSupport({ feedConfig, platform: "linux" }),
    ).toEqual({ autoUpdate: false, versionCheck: false });
    expect(
      resolveDesktopUpdateSupport({ feedConfig: null, platform: "windows" }),
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
