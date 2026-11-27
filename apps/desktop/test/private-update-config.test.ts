import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUpdateInfo } from "electron-updater/out/providers/Provider.js";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  parsePrivateUpdateConfig,
  parsePrivateReleaseInfo,
  readPrivateUpdateConfig,
} from "../src/private-update-config.js";

const baseUrl = "https://private.fixture.invalid/releases/";

const configured = {
  schema: 1,
  enabled: true,
  channel: "latest",
  url: baseUrl,
};

const digest = Buffer.alloc(64, 1).toString("base64");

const release = {
  version: "0.46.2",
  releaseDate: "2026-10-13T00:00:00.000Z",
  files: [{ url: "Omnyo-Private-0.46.2-arm64.zip", sha512: digest, size: 128 }],
  omnyoPrivate: {
    appId: "dev.omnyo.private",
    teamId: "Z7T4C33A35",
    runtimeVersion: "0.46.2+private.2",
    protocolVersion: 234,
  },
};

const windowsRelease = {
  ...release,
  files: [{ ...release.files[0], url: "omnyo-private-0.46.2-x64.exe" }],
  omnyoPrivate: {
    ...release.omnyoPrivate,
    appId: "dev.omnyo.private",
    platform: "windows",
    teamId: "",
    runtimeSha256: "a".repeat(64),
    desktopSha256: "b".repeat(64),
    executableSha256: "c".repeat(64),
  },
};

describe("private desktop feed configuration", () => {
  it.each([
    ["macos", "latest"],
    ["windows", "latest"],
    ["macos", "nightly"],
    ["windows", "nightly"],
  ] as const)(
    "defaults only absent configuration to the private %s %s feed",
    async (platform, channel) => {
      const root = await mkdtemp(join(tmpdir(), "omnyo-private-config-test-"));

      try {
        expect(await readPrivateUpdateConfig(root, platform, channel)).toEqual({
          provider: "generic",
          channel,
          url: `https://app.omnyo.link/private-updates/${channel}/${platform}/`,
        });
        await writeFile(
          join(root, "private-updates.json"),
          JSON.stringify(configured),
        );
        expect(await readPrivateUpdateConfig(root, platform, channel)).toEqual({
          channel: "latest",
          provider: "generic",
          url: baseUrl,
        });
        await writeFile(
          join(root, "private-updates.json"),
          JSON.stringify({ schema: 1, enabled: false }),
        );
        expect(
          await readPrivateUpdateConfig(root, platform, channel),
        ).toBeNull();
        await writeFile(join(root, "private-updates.json"), "{malformed");
        await expect(readPrivateUpdateConfig(root)).rejects.toThrow(
          "Private update configuration is invalid",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { ...configured, url: "http://private.fixture.invalid/" },
    { ...configured, url: "file:///owned/fixture/" },
    {
      ...configured,
      url: "https://fixture-user:synthetic-pass@private.fixture.invalid/",
    },
    { ...configured, url: baseUrl + "?token=synthetic-only" },
    { ...configured, url: baseUrl + "#synthetic-only" },
    { ...configured, headers: { Authorization: "synthetic-only" } },
    {
      ...configured,
      url: "https://github.com/example/omnyo/releases/",
    },
    { ...configured, schema: 2 },
    { ...configured, channel: "other" },
  ])("rejects an unsafe configuration without echoing its payload", (input) => {
    expect(() => parsePrivateUpdateConfig(input)).toThrow(
      "Private update configuration is invalid",
    );

    try {
      parsePrivateUpdateConfig(input);
    } catch (error) {
      expect(String(error)).not.toContain("synthetic");
      expect(String(error)).not.toContain("fixture-user");
      expect(String(error)).not.toContain("Authorization");
    }
  });

  it("keeps explicit disabled configuration inert", () => {
    expect(parsePrivateUpdateConfig({ schema: 1, enabled: false })).toBeNull();
  });

  it("moves only the exact legacy private feed origin and preserves its channel and path", () => {
    expect(
      parsePrivateUpdateConfig({
        ...configured,
        channel: "nightly",
        url: "https://app.omnyohq.com/private-updates/nightly/macos/",
      }),
    ).toEqual({
      provider: "generic",
      channel: "nightly",
      url: "https://app.omnyo.link/private-updates/nightly/macos/",
    });

    for (const url of [
      "https://app.omnyohq.com.example/private-updates/latest/macos/",
      "https://app.omnyohq.com:8443/private-updates/latest/macos/",
      "https://private.fixture.invalid/releases/",
    ])
      expect(parsePrivateUpdateConfig({ ...configured, url })?.url).toBe(url);
  });
});

describe("private numeric release and artifact contract", () => {
  it.each(["0.46.1+private.1", "0.46.2+private.2"])(
    "accepts an existing unquoted YAML date from Electron's parser on %s",
    (currentVersion) => {
      const parsed = parseUpdateInfo(
        stringify(windowsRelease),
        "latest.yml",
        new URL("latest.yml", baseUrl),
      );

      const result = parsePrivateReleaseInfo(
        parsed,
        baseUrl,
        currentVersion,
        "dev.omnyo.private",
        "windows",
      );

      if (currentVersion === "0.46.1+private.1") {
        expect(result?.releaseDate).toBe(release.releaseDate);
      } else {
        expect(result).toBeNull();
      }
    },
  );
  it("accepts only Windows private NSIS metadata on the Windows feed", () => {
    expect(
      parsePrivateReleaseInfo(
        windowsRelease,
        baseUrl,
        "0.46.1",
        "dev.omnyo.private",
        "windows",
      )?.files[0]?.url,
    ).toMatch(/\.exe$/);
    expect(() =>
      parsePrivateReleaseInfo(windowsRelease, baseUrl, "0.46.1"),
    ).toThrow();
    expect(() =>
      parsePrivateReleaseInfo(
        release,
        baseUrl,
        "0.46.1",
        "dev.omnyo.private",
        "windows",
      ),
    ).toThrow();
  });
  it("accepts a newer numeric private release with a bounded same-feed ZIP digest", () => {
    const result = parsePrivateReleaseInfo(
      release,
      baseUrl,
      "0.46.1+private.1",
    );

    expect(result?.version).toBe("0.46.2");
    expect(result?.omnyoPrivate.runtimeVersion).toBe("0.46.2+private.2");
    expect(result?.files[0]?.sha512).toBe(digest);
  });

  it.each([
    ["1.0.0", "1.0.0+private.1", "0.46.379+private.1"],
    ["1.0.1", "1.0.1", "1.0.0+private.1"],
    ["1.0.2", "1.0.2", "1.0.1"],
  ])(
    "offers release %s with runtime %s to a desktop on %s",
    (version, runtimeVersion, currentVersion) => {
      const result = parsePrivateReleaseInfo(
        {
          ...release,
          version,
          files: [
            { ...release.files[0], url: `Omnyo-Private-${version}-arm64.zip` },
          ],
          omnyoPrivate: { ...release.omnyoPrivate, runtimeVersion },
        },
        baseUrl,
        currentVersion,
      );

      expect(result?.omnyoPrivate.runtimeVersion).toBe(runtimeVersion);
    },
  );

  it("does not offer an untagged release at the installed numeric version", () => {
    expect(
      parsePrivateReleaseInfo(
        {
          ...release,
          version: "1.0.1",
          omnyoPrivate: { ...release.omnyoPrivate, runtimeVersion: "1.0.1" },
        },
        baseUrl,
        "1.0.1",
      ),
    ).toBeNull();
  });

  it.each(["0.46.1", "0.46.0"])(
    "does not offer same/older numeric version %s",
    (version) => {
      expect(
        parsePrivateReleaseInfo(
          {
            ...release,
            version,
            omnyoPrivate: {
              ...release.omnyoPrivate,
              runtimeVersion: version + "+private.2",
            },
          },
          baseUrl,
          "0.46.1+private.1",
        ),
      ).toBeNull();
    },
  );

  it.each([
    { ...release, releaseDate: new Date("invalid") },
    { ...release, releaseDate: "not-a-date" },
    { ...release, releaseDate: 1791849600000 },
    { ...release, version: "0.46.1+private.9" },
    { ...release, version: "0.46.2-beta.1" },
    { ...release, omnyoPrivate: undefined },
    {
      ...release,
      omnyoPrivate: { ...release.omnyoPrivate, appId: "dev.omnyo.official" },
    },
    {
      ...release,
      omnyoPrivate: { ...release.omnyoPrivate, teamId: "OTHERTEAM1" },
    },
    {
      ...release,
      omnyoPrivate: {
        ...release.omnyoPrivate,
        runtimeVersion: "0.46.9+private.2",
      },
    },
    {
      ...release,
      omnyoPrivate: {
        ...release.omnyoPrivate,
        runtimeVersion: "0.46.2+build.2",
      },
    },
    {
      ...release,
      omnyoPrivate: {
        ...release.omnyoPrivate,
        runtimeVersion: "0.46.2-beta.1",
      },
    },
    {
      ...release,
      files: [
        {
          ...release.files[0],
          url: "https://external.fixture.invalid/update.zip",
        },
      ],
    },
    { ...release, files: [{ ...release.files[0], url: "../escape.zip" }] },
    {
      ...release,
      files: [{ ...release.files[0], url: "update.zip?token=synthetic-only" }],
    },
    { ...release, files: [{ ...release.files[0], sha512: "not-a-digest" }] },
    { ...release, files: [{ ...release.files[0], size: 0 }] },
    { ...release, files: [{ ...release.files[0], size: 3 * 1024 ** 3 }] },
  ])("refuses an invalid private release before a ZIP request", (input) => {
    expect(() => parsePrivateReleaseInfo(input, baseUrl, "0.46.1")).toThrow(
      "Private update release is invalid",
    );
  });
});

it("imports only the finite legacy feed identity and collapses equal dual namespaces", () => {
  const { omnyoPrivate, ...common } = release;
  const legacy = { ...common, bbPrivate: omnyoPrivate };
  const expected = parsePrivateReleaseInfo(release, baseUrl, "0.46.1");
  expect(expected?.omnyoPrivate).toEqual(omnyoPrivate);
  expect(expected).not.toHaveProperty("bbPrivate");
  expect(parsePrivateReleaseInfo(legacy, baseUrl, "0.46.1")).toEqual(expected);
  expect(
    parsePrivateReleaseInfo(
      { ...release, bbPrivate: omnyoPrivate },
      baseUrl,
      "0.46.1",
    ),
  ).toEqual(expected);
  expect(() =>
    parsePrivateReleaseInfo(
      { ...release, bbPrivate: { ...omnyoPrivate, protocolVersion: 999 } },
      baseUrl,
      "0.46.1",
    ),
  ).toThrow("Private update release is invalid");
  expect(() =>
    parsePrivateReleaseInfo({ ...release, bbPrivate: null }, baseUrl, "0.46.1"),
  ).toThrow("Private update release is invalid");
  expect(() => parsePrivateReleaseInfo(common, baseUrl, "0.46.1")).toThrow(
    "Private update release is invalid",
  );
});

it("publishes the Windows feed under the canonical omnyoPrivate key only", () => {
  const text = stringify(windowsRelease, { schema: "yaml-1.1" });

  expect(text).not.toMatch(/[&*]a\d/u);

  const parsed = z
    .object({ omnyoPrivate: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(parse(text));

  expect(parsed).not.toHaveProperty("bbPrivate");
  expect(
    parsePrivateReleaseInfo(
      parsed,
      baseUrl,
      "0.46.1",
      "dev.omnyo.private",
      "windows",
    )?.omnyoPrivate,
  ).toEqual(windowsRelease.omnyoPrivate);
});
