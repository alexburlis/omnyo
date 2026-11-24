import { describe, expect, it } from "vitest";
import {
  assertPublicBetaUpdatePolicy,
  publicBetaUpdateFeed,
} from "../src/public-beta-update.js";
import {
  parsePrivateReleaseInfo,
  parsePrivateUpdateConfig,
  PRIVATE_UPDATE_TEAM_ID,
} from "../src/private-update-config.js";

const release = () => ({
  version: "0.46.317",
  releaseDate: "2026-11-10T00:00:00.000Z",
  files: [
    {
      url: "omnyo-0.46.317-arm64.zip",
      size: 1024,
      sha512: Buffer.alloc(64).toString("base64"),
    },
  ],
  omnyoPrivate: {
    appId: "dev.omnyo.beta",
    teamId: PRIVATE_UPDATE_TEAM_ID,
    runtimeVersion: "0.46.317+private.1",
    protocolVersion: 1,
  },
});

describe("pinned public macOS update boundary", () => {
  it("pins the public macOS release location", () => {
    expect(publicBetaUpdateFeed()).toEqual({
      provider: "generic",
      channel: "public-beta",
      url: "https://github.com/alexburlis/omnyo-releases/releases/download/macos/",
    });
  });
  it("accepts only the exact public request distribution", () => {
    expect(() =>
      assertPublicBetaUpdatePolicy(
        publicBetaUpdateFeed(),
        "dev.omnyo.beta",
        "macos",
      ),
    ).not.toThrow();

    for (const url of [
      "https://github.com/other/omnyo-releases/releases/download/macos/",
      "https://github.com/alexburlis/omnyo-releases/releases/download/public-beta/",
      "https://github.com/alexburlis/omnyo-releases/releases/download/latest/",
      "https://example.invalid/",
    ])
      expect(() =>
        assertPublicBetaUpdatePolicy(
          { ...publicBetaUpdateFeed(), url },
          "dev.omnyo.beta",
          "macos",
        ),
      ).toThrow();

    for (const platform of ["windows", "linux"])
      expect(() =>
        assertPublicBetaUpdatePolicy(
          publicBetaUpdateFeed(),
          "dev.omnyo.beta",
          platform,
        ),
      ).toThrow();
    expect(() =>
      assertPublicBetaUpdatePolicy(
        publicBetaUpdateFeed(),
        "dev.omnyo.private",
        "macos",
      ),
    ).toThrow();
    expect(() =>
      assertPublicBetaUpdatePolicy(
        { ...publicBetaUpdateFeed(), channel: "latest" },
        "dev.omnyo.beta",
        "macos",
      ),
    ).toThrow();
  });
  it("keeps the existing metadata identity and exact runtime contract", () => {
    const parse = (value: ReturnType<typeof release>) =>
      parsePrivateReleaseInfo(
        value,
        publicBetaUpdateFeed().url,
        "0.46.316+private.1",
        "dev.omnyo.beta",
        "macos",
      );

    expect(parse(release())?.omnyoPrivate.runtimeVersion).toBe(
      "0.46.317+private.1",
    );

    for (const url of [
      "../escape.zip",
      "https://example.invalid/other.zip",
      "/absolute.zip",
    ]) {
      const value = release();
      value.files[0]!.url = url;
      expect(() => parse(value)).toThrow();
    }

    for (const identity of [
      { appId: "dev.omnyo.private" },
      { teamId: "wrong" },
      { runtimeVersion: "0.46.318+private.1" },
    ]) {
      const value = release();
      Object.assign(value.omnyoPrivate, identity);
      expect(() => parse(value)).toThrow();
    }
  });
  it("retains private GitHub rejection", () => {
    expect(() =>
      parsePrivateUpdateConfig({
        schema: 1,
        enabled: true,
        channel: "latest",
        url: publicBetaUpdateFeed().url,
      }),
    ).toThrow();
  });
});
