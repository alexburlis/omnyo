import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  compareReleaseNumbers,
  parseReleaseVersion,
  RELEASE_VERSION_PATTERN,
} from "@omnyo/config/release-version";
import type { DesktopAutoUpdateFeedConfig } from "./desktop-update-provider.js";
import {
  migrateLegacyPrivateServerUrl,
  PRIVATE_APP_HOSTNAME,
} from "@omnyo/connect-client";

export const PRIVATE_GATEWAY_ORIGIN = `https://${PRIVATE_APP_HOSTNAME}`;

export const PRIVATE_UPDATE_TEAM_ID = "Z7T4C33A35";

export const PRIVATE_UPDATE_APP_ID = "dev.omnyo.private";

const numericVersion = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

const configSchema = z.discriminatedUnion("enabled", [
  z.object({ schema: z.literal(1), enabled: z.literal(false) }).strict(),
  z
    .object({
      schema: z.literal(1),
      enabled: z.literal(true),
      channel: z.enum(["latest", "nightly"]),
      url: z.string().max(2048),
    })
    .strict(),
]);

const releaseSchema = z
  .object({
    version: numericVersion,
    releaseDate: z.union([
      z.string().datetime(),
      z.date().transform((value) => value.toISOString()),
    ]),
    files: z
      .array(
        z
          .object({
            url: z.string().max(255),
            sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
            size: z
              .number()
              .int()
              .positive()
              .max(2 * 1024 ** 3),
          })
          .passthrough(),
      )
      .length(1),
    omnyoPrivate: z
      .object({
        appId: z.string(),
        teamId: z.string(),
        platform: z.enum(["macos", "windows"]).optional(),
        runtimeSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        desktopSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        executableSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        runtimeVersion: z.string().regex(RELEASE_VERSION_PATTERN),
        protocolVersion: z.number().int().positive(),
      })
      .strict(),
  })
  .passthrough();

export type PrivateReleaseInfo = z.infer<typeof releaseSchema>;

export function nativeNumericVersion(version: string): string {
  const parsed = parseReleaseVersion(version);

  if (parsed === null) throw new Error(`Invalid Omnyo version: ${version}`);

  return parsed.numeric;
}

export function isNewerNativeVersion(
  candidate: string,
  current: string,
): boolean {
  return compareReleaseNumbers(candidate, current) > 0;
}

export function parsePrivateUpdateConfig(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  value: unknown,
): DesktopAutoUpdateFeedConfig | null {
  try {
    const config = configSchema.parse(value);

    if (!config.enabled) return null;
    const url = new URL(config.url);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/") ||
      [
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
      ].includes(url.hostname)
    )
      throw new Error();

    return {
      provider: "generic",
      channel: config.channel,
      url: migrateLegacyPrivateServerUrl(url.href) ?? url.href,
    };
  } catch {
    throw new Error("Private update configuration is invalid");
  }
}

export async function readPrivateUpdateConfig(
  userDataPath: string,
  platform: "macos" | "windows" = "macos",
  channel: "latest" | "nightly" = "latest",
): Promise<DesktopAutoUpdateFeedConfig | null> {
  let text: string;

  try {
    text = await readFile(join(userDataPath, "private-updates.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {
        provider: "generic",
        channel,
        url: `${PRIVATE_GATEWAY_ORIGIN}/private-updates/${channel}/${platform}/`,
      };
    throw new Error("Private update configuration is invalid");
  }

  try {
    if (Buffer.byteLength(text) > 4096) throw new Error();

    return parsePrivateUpdateConfig(JSON.parse(text));
  } catch {
    throw new Error("Private update configuration is invalid");
  }
}

export function parsePrivateReleaseInfo(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  value: unknown,
  baseUrl: string,
  currentVersion: string,
  expectedAppId = PRIVATE_UPDATE_APP_ID,
  platform: "macos" | "windows" | "linux" = "macos",
): PrivateReleaseInfo | null {
  try {
    const {
      bbPrivate: legacyRelease,
      omnyoPrivate,
      ...common
    } = z
      .object({
        bbPrivate: releaseSchema.shape.omnyoPrivate.optional(),
        omnyoPrivate: releaseSchema.shape.omnyoPrivate.optional(),
      })
      .passthrough()
      .parse(value);

    if (
      legacyRelease !== undefined &&
      omnyoPrivate !== undefined &&
      !isDeepStrictEqual(legacyRelease, omnyoPrivate)
    )
      throw new Error("Private update identities conflict");

    const release = releaseSchema.parse({
      ...common,
      omnyoPrivate: omnyoPrivate ?? legacyRelease,
    });

    if (
      release.omnyoPrivate.appId !== expectedAppId ||
      (platform === "macos" &&
        (release.omnyoPrivate.teamId !== PRIVATE_UPDATE_TEAM_ID ||
          (release.omnyoPrivate.platform !== undefined &&
            release.omnyoPrivate.platform !== "macos"))) ||
      (platform === "windows" &&
        (release.omnyoPrivate.platform !== "windows" ||
          release.omnyoPrivate.teamId !== "" ||
          release.omnyoPrivate.runtimeSha256 === undefined ||
          release.omnyoPrivate.desktopSha256 === undefined ||
          release.omnyoPrivate.executableSha256 === undefined)) ||
      platform === "linux" ||
      nativeNumericVersion(release.omnyoPrivate.runtimeVersion) !==
        release.version
    )
      throw new Error();
    const file = release.files[0];

    if (
      !file ||
      !(
        platform === "windows"
          ? /^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/
          : /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/
      ).test(file.url)
    )
      throw new Error();
    const base = new URL(baseUrl);
    const resolved = new URL(file.url, base);

    if (
      resolved.origin !== base.origin ||
      resolved.pathname !== base.pathname + file.url
    )
      throw new Error();

    return isNewerNativeVersion(release.version, currentVersion)
      ? release
      : null;
  } catch {
    throw new Error("Private update release is invalid");
  }
}
